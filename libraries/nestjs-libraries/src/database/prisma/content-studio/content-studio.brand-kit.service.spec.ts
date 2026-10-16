import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioBrandKitService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.service';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';

// Mirrors the editorial policy service spec. No database: the repository is
// mocked; the Brand Kit parser, canonical JSON and hashing run for real
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});
const uuid = jest.mocked(randomUUID);

const MARKER = 'BRAND_KIT_PRIVATE_MARKER_123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const BRAND_KIT = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const REVISION = '66666666-6666-4666-8666-666666666666';
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const T0 = new Date('2026-10-14T10:00:00.000Z');

const content = (description = `Calm and clear. ${MARKER}`) => ({
  schemaVersion: 1,
  identity: {
    brandName: 'Northwind',
    tagline: 'Tools that last',
    description,
  },
  colors: [
    { id: 'primary', name: 'Blue', value: '#0057ff', role: 'primary' },
    { id: 'ink', name: 'Ink', value: '#111111', role: 'text' },
  ],
  typography: [
    {
      id: 'heading',
      name: 'Heading',
      family: 'Inter',
      weight: 700,
      style: 'normal',
      role: 'heading',
    },
  ],
  visualDirection: {
    keywords: ['calm'],
    dos: [`Use whitespace. ${MARKER}`],
    donts: ['No gradients'],
  },
});
const normalized = (input: unknown = content()) =>
  parseContentStudioBrandKitContent(input);
const storedOf = (input: unknown = content()) =>
  storedContentStudioBrandKitContent(normalized(input));

const kitRow = (overrides: Record<string, unknown> = {}) => ({
  id: BRAND_KIT,
  latestRevisionNumber: 2,
  ...overrides,
});
const revisionRow = (overrides: Record<string, unknown> = {}) => ({
  id: REVISION,
  revisionNumber: 2,
  createdAt: T0,
  ...storedOf(),
  ...overrides,
});
const summaryOf = (row: ReturnType<typeof revisionRow>) => ({
  id: row.id,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  createdAt: row.createdAt,
});

// brandKit: what getBrandKitForOrganization answers for ORG (null: none yet)
const setup = (brandKit: ReturnType<typeof kitRow> | null = kitRow()) => {
  const repository = {
    getBrandKitForOrganization: jest.fn(
      async (organizationId: string): Promise<unknown> =>
        organizationId === ORG ? brandKit : null
    ),
    createBrandKitWithFirstRevision: jest.fn(
      async (input: { brandKitId: string; revisionId: string }) => ({
        brandKit: kitRow({ id: input.brandKitId, latestRevisionNumber: 1 }),
        revision: summaryOf(
          revisionRow({ id: input.revisionId, revisionNumber: 1 })
        ),
      })
    ),
    createRevisionWithCompareAndSwap: jest.fn(
      async (input: {
        expectedLatestRevisionNumber: number;
        revisionId: string;
      }): Promise<unknown> => ({
        status: 'created',
        revision: summaryOf(
          revisionRow({
            id: input.revisionId,
            revisionNumber: input.expectedLatestRevisionNumber + 1,
          })
        ),
      })
    ),
    listRevisionsForBrandKit: jest.fn(async () => [summaryOf(revisionRow())]),
    countRevisionsForBrandKit: jest.fn(async () => 21),
    getRevisionForBrandKit: jest.fn(
      async (organizationId: string, brandKitId: string, id: string) =>
        organizationId === ORG && brandKitId === BRAND_KIT && id === REVISION
          ? revisionRow()
          : null
    ),
    getRevisionByNumber: jest.fn(async (): Promise<unknown> => revisionRow()),
  };
  const service = new ContentStudioBrandKitService(
    repository as unknown as ContentStudioBrandKitRepository
  );
  return { repository, service };
};
type Repository = ReturnType<typeof setup>['repository'];

const writes = (repository: Repository) =>
  [
    repository.createBrandKitWithFirstRevision,
    repository.createRevisionWithCompareAndSwap,
  ].flatMap((fn) => (fn as jest.Mock).mock.calls);

const httpError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const text = [
    String(err),
    JSON.stringify((err as HttpException).getResponse()),
    inspect(err, { depth: 6 }),
  ].join('\n');
  expect(text).not.toContain(MARKER);
  expect(text).not.toMatch(
    /[0-9a-f]{64}|zod|Prisma|P200|organizationId|brandKitId|33333333/
  );
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse() as Record<string, unknown>,
  };
};

const NOT_FOUND = {
  msg: 'Brand Kit revision not found.',
  code: 'CS_NOT_FOUND',
};
const INVALID = {
  msg: 'The Brand Kit is invalid.',
  code: 'CS_BRAND_KIT_INVALID',
};
const TOO_LARGE = {
  msg: 'The Brand Kit is too large.',
  code: 'CS_BRAND_KIT_TOO_LARGE',
};
const INTEGRITY = {
  msg: 'Stored Brand Kit data could not be read safely.',
  code: 'CS_BRAND_KIT_INTEGRITY_ERROR',
};
const conflict = (currentRevisionNumber: number) => ({
  msg: 'The Brand Kit changed. Reload it and try again.',
  code: 'CS_BRAND_KIT_REVISION_CONFLICT',
  currentRevisionNumber,
});
const uniqueError = () =>
  new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on organizationId ${MARKER}`,
    { code: 'P2002', clientVersion: '6.5.0' }
  );

const save = (
  service: ContentStudioBrandKitService,
  overrides: Record<string, unknown> = {}
) =>
  service.createRevision({
    organizationId: ORG,
    userId: USER,
    baseRevisionNumber: 2,
    content: content(),
    ...overrides,
  });

beforeEach(() => {
  let next = 0;
  uuid.mockImplementation(
    () => [NEW_ID, REVISION][next++ % 2] as ReturnType<typeof randomUUID>
  );
});

describe('ContentStudioBrandKitService: current brandKit', () => {
  it('BKS1 answers revision 0 and no current revision before the first save, creating nothing', async () => {
    const { repository, service } = setup(null);
    expect(await service.getBrandKit(ORG)).toEqual({
      latestRevisionNumber: 0,
      currentRevision: null,
    });
    expect(writes(repository)).toEqual([]);
    expect(repository.getRevisionByNumber).not.toHaveBeenCalled();
  });

  it('BKS2 answers the verified current revision of the organization only', async () => {
    const { repository, service } = setup();
    const brandKit = await service.getBrandKit(ORG);
    expect(repository.getBrandKitForOrganization).toHaveBeenCalledWith(ORG);
    expect(repository.getRevisionByNumber).toHaveBeenCalledWith(
      ORG,
      BRAND_KIT,
      2
    );
    expect(brandKit).toEqual({
      latestRevisionNumber: 2,
      currentRevision: { ...summaryOf(revisionRow()), content: normalized() },
    });
    // no brandKit, organization or creator id
    expect(JSON.stringify(brandKit)).not.toMatch(/33333333|11111111|55555555/);
    expect(await service.getBrandKit(OTHER_ORG)).toEqual({
      latestRevisionNumber: 0,
      currentRevision: null,
    });
    expect(writes(repository)).toEqual([]);
  });

  it.each([
    ['a changed hash', { contentHash: 'f'.repeat(64) }],
    ['a broken text', { content: `{"complianceNotes":"${MARKER}"` }],
    ['another schema version', { schemaVersion: 2 }],
  ])('BKS4 answers a fixed 500 for %s', async (_name, change) => {
    const { repository, service } = setup();
    repository.getRevisionByNumber.mockResolvedValueOnce(revisionRow(change));
    expect(await httpError(service.getBrandKit(ORG))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });

  it('BKS3 answers a fixed 500 when the current revision is missing', async () => {
    const { repository, service } = setup();
    repository.getRevisionByNumber.mockResolvedValueOnce(null);
    expect(await httpError(service.getBrandKit(ORG))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });
});

describe('ContentStudioBrandKitService: first save', () => {
  it('BKS5 creates the kit with revision 1 for the request organization and user, normalized', async () => {
    const { repository, service } = setup(null);
    const result = await save(service, {
      baseRevisionNumber: 0,
      content: {
        ...content(),
        identity: {
          ...content().identity,
          description: `  Calm and clear. ${MARKER}\r\n`,
        },
        colors: [
          { id: 'primary', name: ' Blue ', value: '#0057FF', role: 'primary' },
          content().colors[1],
        ],
      },
    });
    expect(repository.createBrandKitWithFirstRevision).toHaveBeenCalledWith({
      brandKitId: NEW_ID,
      revisionId: REVISION,
      organizationId: ORG,
      createdById: USER,
      revision: storedOf(),
    });
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
    expect(result).toEqual({
      created: true,
      revision: {
        id: REVISION,
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: storedOf().contentHash,
        createdAt: T0,
        content: normalized(),
      },
      latestRevisionNumber: 1,
    });
  });

  it('creates revision 1 even for the empty kit', async () => {
    const { repository, service } = setup(null);
    const empty = {
      schemaVersion: 1,
      identity: { brandName: '', tagline: '', description: '' },
      colors: [],
      typography: [],
      visualDirection: { keywords: [], dos: [], donts: [] },
    };
    expect(
      (await save(service, { baseRevisionNumber: 0, content: empty })).created
    ).toBe(true);
    expect(repository.createBrandKitWithFirstRevision).toHaveBeenCalledTimes(1);
  });

  it('BKS6 answers a conflict at 0 for a later base while there is no kit', async () => {
    const { repository, service } = setup(null);
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'not-found',
    });
    expect(await httpError(save(service, { baseRevisionNumber: 1 }))).toEqual({
      status: 409,
      body: conflict(0),
    });
    expect(repository.createBrandKitWithFirstRevision).not.toHaveBeenCalled();
  });

  it('BKS6 answers a conflict for a first save once the kit exists', async () => {
    const { repository, service } = setup(kitRow({ latestRevisionNumber: 3 }));
    expect(await httpError(save(service, { baseRevisionNumber: 0 }))).toEqual({
      status: 409,
      body: conflict(3),
    });
    expect(writes(repository)).toEqual([]);
  });

  it('BKS13/BKS14/BKS19 refuses invalid or oversized kits without repeating them', async () => {
    const { repository, service } = setup(null);
    expect(
      await httpError(
        save(service, {
          baseRevisionNumber: 0,
          content: { ...content(), brandVoice: MARKER },
        })
      )
    ).toEqual({ status: 400, body: INVALID });
    expect(
      await httpError(
        save(service, {
          baseRevisionNumber: 0,
          content: {
            ...content(),
            visualDirection: { keywords: [], dos: [MARKER, MARKER], donts: [] },
          },
        })
      )
    ).toEqual({ status: 400, body: INVALID });
    const big = {
      ...content(),
      visualDirection: {
        keywords: [],
        dos: Array.from({ length: 20 }, (_, i) =>
          `${i} ${MARKER}`.padEnd(300, '\u20ac')
        ),
        donts: Array.from({ length: 20 }, (_, i) =>
          `${i} ${MARKER}`.padEnd(300, '\u20ac')
        ),
      },
    };
    expect(
      await httpError(save(service, { baseRevisionNumber: 0, content: big }))
    ).toEqual({ status: 400, body: TOO_LARGE });
    expect(writes(repository)).toEqual([]);
  });

  it('takes nothing from the caller but the base and the content', async () => {
    const { repository, service } = setup(null);
    await save(service, {
      baseRevisionNumber: 0,
      ...({
        brandKitId: 'their-brandKit',
        createdById: 'someone',
        revisionNumber: 9,
        contentHash: 'f'.repeat(64),
        schemaVersion: 2,
      } as object),
    });
    const [[input]] = repository.createBrandKitWithFirstRevision.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(Object.keys(input).sort()).toEqual([
      'brandKitId',
      'createdById',
      'organizationId',
      'revision',
      'revisionId',
    ]);
    expect(input).toMatchObject({
      organizationId: ORG,
      createdById: USER,
      brandKitId: NEW_ID,
      revision: storedOf(),
    });
  });

  it('BKS7 maps a lost first-save race to a conflict at the winning revision', async () => {
    const { repository, service } = setup(null);
    // both read "no brandKit"; the other save committed first
    repository.getBrandKitForOrganization
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(kitRow({ latestRevisionNumber: 1 }));
    repository.createBrandKitWithFirstRevision.mockRejectedValueOnce(
      uniqueError()
    );
    expect(await httpError(save(service, { baseRevisionNumber: 0 }))).toEqual({
      status: 409,
      body: conflict(1),
    });
    expect(repository.getBrandKitForOrganization).toHaveBeenCalledTimes(2);
  });

  it('BKS8 answers a fixed 500 when a unique-key failure leaves no kit, and lets other errors through', async () => {
    const { repository, service } = setup(null);
    repository.createBrandKitWithFirstRevision.mockRejectedValueOnce(
      uniqueError()
    );
    expect(await httpError(save(service, { baseRevisionNumber: 0 }))).toEqual({
      status: 500,
      body: {
        msg: 'The Brand Kit could not be saved.',
        code: 'CS_BRAND_KIT_SAVE_FAILED',
      },
    });
    const other = new Error('database down');
    repository.createBrandKitWithFirstRevision.mockRejectedValueOnce(other);
    await expect(save(service, { baseRevisionNumber: 0 })).rejects.toBe(other);
  });

  it('first-save concurrency: one of two base-0 saves creates, the other conflicts at 1', async () => {
    // the unique organizationId is the only lock: no in-memory one
    let brandKit: ReturnType<typeof kitRow> | null = null;
    const { repository, service } = setup(null);
    repository.getBrandKitForOrganization.mockImplementation(
      async () => brandKit
    );
    let created = 0;
    repository.createBrandKitWithFirstRevision.mockImplementation(
      async (input: { brandKitId: string; revisionId: string }) => {
        // both callers read "no brandKit" before either writes
        await new Promise((resolve) => setImmediate(resolve));
        if (created++ > 0) {
          throw uniqueError();
        }
        brandKit = kitRow({ id: input.brandKitId, latestRevisionNumber: 1 });
        return {
          brandKit,
          revision: summaryOf(
            revisionRow({ id: input.revisionId, revisionNumber: 1 })
          ),
        };
      }
    );
    const results = await Promise.allSettled([
      save(service, { baseRevisionNumber: 0 }),
      save(service, { baseRevisionNumber: 0, content: content('Other') }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const lost = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(await httpError(Promise.reject(lost.reason))).toEqual({
      status: 409,
      body: conflict(1),
    });
  });
});

describe('ContentStudioBrandKitService: later saves', () => {
  it('BKS9 saves changed content as the next revision, by the request user, hashed by the server', async () => {
    const { repository, service } = setup();
    const result = await save(service, {
      content: {
        ...content(),
        visualDirection: { keywords: [' bold '], dos: [], donts: [] },
      },
      ...({ contentHash: 'f'.repeat(64), createdById: 'x' } as object),
    });
    const expected = normalized({
      ...content(),
      visualDirection: { keywords: ['bold'], dos: [], donts: [] },
    });
    expect(repository.createRevisionWithCompareAndSwap).toHaveBeenCalledWith({
      organizationId: ORG,
      expectedLatestRevisionNumber: 2,
      revisionId: NEW_ID,
      revision: storedContentStudioBrandKitContent(expected),
      createdById: USER,
    });
    expect(result).toEqual({
      created: true,
      revision: {
        id: NEW_ID,
        revisionNumber: 3,
        schemaVersion: 1,
        contentHash: storedOf().contentHash,
        createdAt: T0,
        content: expected,
      },
      latestRevisionNumber: 3,
    });
    expect(repository.createBrandKitWithFirstRevision).not.toHaveBeenCalled();
  });

  it('BKS11 answers the verified current revision for unchanged content', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'unchanged',
      revision: revisionRow(),
    });
    expect(await save(service)).toEqual({
      created: false,
      revision: { ...summaryOf(revisionRow()), content: normalized() },
      latestRevisionNumber: 2,
    });
  });

  it('answers an integrity error, not created: false, when the matching current revision is corrupted', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'unchanged',
      revision: revisionRow({ content: `{"complianceNotes":"${MARKER}"}` }),
    });
    expect(await httpError(save(service))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });

  it.each([
    [
      'BKS10/BKS12 a stale base',
      { status: 'conflict', currentRevisionNumber: 5 },
      conflict(5),
    ],
    ['a brandKit that is gone', { status: 'not-found' }, conflict(0)],
  ])('maps %s to a conflict', async (_name, state, body) => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce(state);
    expect(await httpError(save(service))).toEqual({ status: 409, body });
  });

  it('tells a lost compare-and-swap from the current revision number', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValue({
      status: 'changed',
    });
    repository.getBrandKitForOrganization.mockResolvedValueOnce(
      kitRow({ latestRevisionNumber: 4 })
    );
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: conflict(4),
    });
  });

  it('maps a revision-number unique-key race to a conflict and lets other errors through', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockRejectedValueOnce(
      uniqueError()
    );
    repository.getBrandKitForOrganization.mockResolvedValueOnce(
      kitRow({ latestRevisionNumber: 3 })
    );
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: conflict(3),
    });
    const other = new Error('database down');
    repository.createRevisionWithCompareAndSwap.mockRejectedValueOnce(other);
    await expect(save(service)).rejects.toBe(other);
  });

  it.each([
    ['a negative base', -1],
    ['a fractional base', 1.5],
    ['a base past int4', 2 ** 31],
    ['a string base', '2'],
    ['no base', undefined],
  ])(
    'refuses %s with a 400 and no write',
    async (_name, baseRevisionNumber) => {
      const { repository, service } = setup();
      expect(
        await httpError(save(service, { baseRevisionNumber }))
      ).toMatchObject({ status: 400, body: { code: 'CS_INVALID_REQUEST' } });
      expect(writes(repository)).toEqual([]);
    }
  );
});

describe('ContentStudioBrandKitService: history', () => {
  it('BKS15 answers an empty history before the first save', async () => {
    const { repository, service } = setup(null);
    expect(
      await service.listRevisions({ organizationId: ORG, page: 1 })
    ).toEqual({ pages: 0, results: [] });
    expect(repository.listRevisionsForBrandKit).not.toHaveBeenCalled();
    expect(writes(repository)).toEqual([]);
  });

  it('BKS15 lists summaries of the organization kit by page', async () => {
    const { repository, service } = setup();
    const list = await service.listRevisions({ organizationId: ORG, page: 2 });
    expect(list).toEqual({ pages: 2, results: [summaryOf(revisionRow())] });
    expect(repository.listRevisionsForBrandKit).toHaveBeenCalledWith({
      organizationId: ORG,
      brandKitId: BRAND_KIT,
      skip: 20,
      take: 20,
    });
    expect(repository.countRevisionsForBrandKit).toHaveBeenCalledWith(
      ORG,
      BRAND_KIT
    );
    expect(Object.keys(list.results[0]).sort()).toEqual([
      'contentHash',
      'createdAt',
      'id',
      'revisionNumber',
      'schemaVersion',
    ]);
  });

  it('BKS16 shows a verified revision of the organization kit', async () => {
    const { repository, service } = setup();
    const revision = await service.getRevision({
      organizationId: ORG,
      revisionId: REVISION,
    });
    expect(revision).toEqual({
      ...summaryOf(revisionRow()),
      content: normalized(),
    });
    expect(repository.getRevisionForBrandKit).toHaveBeenCalledWith(
      ORG,
      BRAND_KIT,
      REVISION
    );
  });

  it('BKS17 answers 404 for a malformed revision id without a query', async () => {
    const { repository, service } = setup();
    for (const revisionId of [
      'not-a-uuid',
      'AAAAAAAA-6666-4666-8666-666666666666',
      `${REVISION} `,
      '',
    ]) {
      expect(
        await httpError(
          service.getRevision({ organizationId: ORG, revisionId })
        )
      ).toEqual({ status: 404, body: NOT_FOUND });
    }
    expect(repository.getBrandKitForOrganization).not.toHaveBeenCalled();
    expect(repository.getRevisionForBrandKit).not.toHaveBeenCalled();
  });

  it('BKS18 answers 404 for a revision of another organization, another one, or before the first save', async () => {
    const { repository, service } = setup();
    expect(
      await httpError(
        service.getRevision({ organizationId: OTHER_ORG, revisionId: REVISION })
      )
    ).toEqual({ status: 404, body: NOT_FOUND });
    expect(
      await httpError(
        service.getRevision({ organizationId: ORG, revisionId: NEW_ID })
      )
    ).toEqual({ status: 404, body: NOT_FOUND });
    expect(repository.getRevisionForBrandKit).toHaveBeenCalledTimes(1);

    const none = setup(null);
    expect(
      await httpError(
        none.service.getRevision({ organizationId: ORG, revisionId: REVISION })
      )
    ).toEqual({ status: 404, body: NOT_FOUND });
  });

  it('answers a fixed 500 for a corrupted revision without quoting it', async () => {
    const { repository, service } = setup();
    repository.getRevisionForBrandKit.mockResolvedValueOnce(
      revisionRow({ content: `{"complianceNotes":"${MARKER}"}` })
    );
    expect(
      await httpError(
        service.getRevision({ organizationId: ORG, revisionId: REVISION })
      )
    ).toEqual({ status: 500, body: INTEGRITY });
  });
});

describe('ContentStudioBrandKitService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.brand-kit.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('BKS20 has no role, billing, AI, provider, fetching, Media or renderer dependency', () => {
    expect(text).not.toMatch(
      /Role\.|assertManager|CheckPolicies|Sections\.|subscription|stripe|credit|billing|AIExecution|ai\.execution|ai\.provider|AIProviderResolver|AIConnection|AIWriting|generateText|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|score|Media|sharp|fontkit|fabric|canvas|organization\.name|contentStudioOrganization/i
    );
  });

  it('logs nothing and never serializes the kit for a message', () => {
    expect(text).not.toMatch(/console\.|Logger|JSON\.stringify|\.message\b/);
  });

  it('never writes a revision itself', () => {
    expect(text).not.toMatch(
      /contentStudioBrandKitRevision|\.update\(|\.delete\(|\.upsert\(/
    );
  });
});
