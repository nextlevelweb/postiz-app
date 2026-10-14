import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { parseContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import { storedContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';

// No database: the repository is mocked; the policy parser, canonical JSON
// and hashing run for real
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});
const uuid = jest.mocked(randomUUID);

const MARKER = 'EDITORIAL_POLICY_SECRET_MARKER_123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const REVISION = '66666666-6666-4666-8666-666666666666';
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const T0 = new Date('2026-10-14T10:00:00.000Z');

const content = (notes = `Add the risk notice. ${MARKER}`) => ({
  schemaVersion: 1,
  principles: ['Be useful.'],
  prohibitedTopics: ['Politics'],
  claimRules: [`Every number needs a source. ${MARKER}`],
  ctaRules: ['One call to action.'],
  formatConventions: ['Sentence case headings.'],
  complianceNotes: notes,
});
const normalized = (input: unknown = content()) =>
  parseContentStudioEditorialPolicyContent(input);
const storedOf = (input: unknown = content()) =>
  storedContentStudioEditorialPolicyContent(normalized(input));

const policyRow = (overrides: Record<string, unknown> = {}) => ({
  id: POLICY,
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

// policy: what getPolicyForOrganization answers for ORG (null: none yet)
const setup = (policy: ReturnType<typeof policyRow> | null = policyRow()) => {
  const repository = {
    getPolicyForOrganization: jest.fn(
      async (organizationId: string): Promise<unknown> =>
        organizationId === ORG ? policy : null
    ),
    createPolicyWithFirstRevision: jest.fn(
      async (input: { policyId: string; revisionId: string }) => ({
        policy: policyRow({ id: input.policyId, latestRevisionNumber: 1 }),
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
    listRevisionsForPolicy: jest.fn(async () => [summaryOf(revisionRow())]),
    countRevisionsForPolicy: jest.fn(async () => 21),
    getRevisionForPolicy: jest.fn(
      async (organizationId: string, policyId: string, id: string) =>
        organizationId === ORG && policyId === POLICY && id === REVISION
          ? revisionRow()
          : null
    ),
    getRevisionByNumber: jest.fn(async (): Promise<unknown> => revisionRow()),
  };
  const service = new ContentStudioEditorialPolicyService(
    repository as unknown as ContentStudioEditorialPolicyRepository
  );
  return { repository, service };
};
type Repository = ReturnType<typeof setup>['repository'];

const writes = (repository: Repository) =>
  [
    repository.createPolicyWithFirstRevision,
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
    /[0-9a-f]{64}|zod|Prisma|P200|organizationId|policyId|33333333/
  );
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse() as Record<string, unknown>,
  };
};

const NOT_FOUND = {
  msg: 'Editorial policy revision not found.',
  code: 'CS_NOT_FOUND',
};
const INVALID = {
  msg: 'The editorial policy is invalid.',
  code: 'CS_PROFILE_INVALID',
};
const TOO_LARGE = {
  msg: 'The editorial policy is too large.',
  code: 'CS_PROFILE_TOO_LARGE',
};
const INTEGRITY = {
  msg: 'Stored editorial policy data could not be verified.',
  code: 'CS_PROFILE_INTEGRITY_ERROR',
};
const conflict = (currentRevisionNumber: number) => ({
  msg: 'The editorial policy changed. Reload it and try again.',
  code: 'CS_PROFILE_REVISION_CONFLICT',
  currentRevisionNumber,
});
const uniqueError = () =>
  new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on organizationId ${MARKER}`,
    { code: 'P2002', clientVersion: '6.5.0' }
  );

const save = (
  service: ContentStudioEditorialPolicyService,
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

describe('ContentStudioEditorialPolicyService: current policy', () => {
  it('ES1/ES2 answers revision 0 and no current revision before the first save, creating nothing', async () => {
    const { repository, service } = setup(null);
    expect(await service.getPolicy(ORG)).toEqual({
      latestRevisionNumber: 0,
      currentRevision: null,
    });
    expect(writes(repository)).toEqual([]);
    expect(repository.getRevisionByNumber).not.toHaveBeenCalled();
  });

  it('ES3/ES4/ES6/ES7 answers the verified current revision of the organization only', async () => {
    const { repository, service } = setup();
    const policy = await service.getPolicy(ORG);
    expect(repository.getPolicyForOrganization).toHaveBeenCalledWith(ORG);
    expect(repository.getRevisionByNumber).toHaveBeenCalledWith(ORG, POLICY, 2);
    expect(policy).toEqual({
      latestRevisionNumber: 2,
      currentRevision: { ...summaryOf(revisionRow()), content: normalized() },
    });
    // no policy, organization or creator id
    expect(JSON.stringify(policy)).not.toMatch(/33333333|11111111|55555555/);
    expect(await service.getPolicy(OTHER_ORG)).toEqual({
      latestRevisionNumber: 0,
      currentRevision: null,
    });
    expect(writes(repository)).toEqual([]);
  });

  it.each([
    ['a changed hash', { contentHash: 'f'.repeat(64) }],
    ['a broken text', { content: `{"complianceNotes":"${MARKER}"` }],
    ['another schema version', { schemaVersion: 2 }],
  ])('ES5 answers a fixed 500 for %s', async (_name, change) => {
    const { repository, service } = setup();
    repository.getRevisionByNumber.mockResolvedValueOnce(revisionRow(change));
    expect(await httpError(service.getPolicy(ORG))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });

  it('ES5 answers a fixed 500 when the current revision is missing', async () => {
    const { repository, service } = setup();
    repository.getRevisionByNumber.mockResolvedValueOnce(null);
    expect(await httpError(service.getPolicy(ORG))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });
});

describe('ContentStudioEditorialPolicyService: first save', () => {
  it('ES9/ES10/ES14/ES15/ES17 creates the policy with revision 1 for the request organization and user', async () => {
    const { repository, service } = setup(null);
    const result = await save(service, {
      baseRevisionNumber: 0,
      content: {
        ...content(),
        principles: [' Be useful.\r\n'],
        complianceNotes: `  Add the risk notice. ${MARKER}\r\n`,
      },
    });
    expect(repository.createPolicyWithFirstRevision).toHaveBeenCalledWith({
      policyId: NEW_ID,
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

  it('creates revision 1 even for the empty policy', async () => {
    const { repository, service } = setup(null);
    const empty = {
      schemaVersion: 1,
      principles: [],
      prohibitedTopics: [],
      claimRules: [],
      ctaRules: [],
      formatConventions: [],
      complianceNotes: '',
    };
    expect(
      (await save(service, { baseRevisionNumber: 0, content: empty })).created
    ).toBe(true);
    expect(repository.createPolicyWithFirstRevision).toHaveBeenCalledTimes(1);
  });

  it('ES11 answers a conflict at 0 for a later base while there is no policy', async () => {
    const { repository, service } = setup(null);
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'not-found',
    });
    expect(await httpError(save(service, { baseRevisionNumber: 1 }))).toEqual({
      status: 409,
      body: conflict(0),
    });
    expect(repository.createPolicyWithFirstRevision).not.toHaveBeenCalled();
  });

  it('answers a conflict for a first save once the policy exists', async () => {
    const { repository, service } = setup(
      policyRow({ latestRevisionNumber: 3 })
    );
    expect(await httpError(save(service, { baseRevisionNumber: 0 }))).toEqual({
      status: 409,
      body: conflict(3),
    });
    expect(writes(repository)).toEqual([]);
  });

  it('ES12/ES13 refuses invalid or oversized policies without repeating them', async () => {
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
          content: { ...content(), claimRules: [MARKER, MARKER] },
        })
      )
    ).toEqual({ status: 400, body: INVALID });
    const big = {
      ...content(),
      principles: Array.from({ length: 20 }, (_, i) =>
        `${i} ${MARKER}`.padEnd(500, '\u20ac')
      ),
      complianceNotes: '\u20ac'.repeat(4000),
    };
    expect(
      await httpError(save(service, { baseRevisionNumber: 0, content: big }))
    ).toEqual({ status: 400, body: TOO_LARGE });
    expect(writes(repository)).toEqual([]);
  });

  it('ES16 takes nothing from the caller but the base and the content', async () => {
    const { repository, service } = setup(null);
    await save(service, {
      baseRevisionNumber: 0,
      ...({
        policyId: 'their-policy',
        createdById: 'someone',
        revisionNumber: 9,
        contentHash: 'f'.repeat(64),
        schemaVersion: 2,
      } as object),
    });
    const [[input]] = repository.createPolicyWithFirstRevision.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(Object.keys(input).sort()).toEqual([
      'createdById',
      'organizationId',
      'policyId',
      'revision',
      'revisionId',
    ]);
    expect(input).toMatchObject({
      organizationId: ORG,
      createdById: USER,
      policyId: NEW_ID,
      revision: storedOf(),
    });
  });

  it('ES18/ES19 maps a lost first-save race to a conflict at the winning revision', async () => {
    const { repository, service } = setup(null);
    // both read "no policy"; the other save committed first
    repository.getPolicyForOrganization
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policyRow({ latestRevisionNumber: 1 }));
    repository.createPolicyWithFirstRevision.mockRejectedValueOnce(
      uniqueError()
    );
    expect(await httpError(save(service, { baseRevisionNumber: 0 }))).toEqual({
      status: 409,
      body: conflict(1),
    });
    expect(repository.getPolicyForOrganization).toHaveBeenCalledTimes(2);
  });

  it('answers a fixed 500 when a unique-key failure leaves no policy, and lets other errors through', async () => {
    const { repository, service } = setup(null);
    repository.createPolicyWithFirstRevision.mockRejectedValueOnce(
      uniqueError()
    );
    expect(await httpError(save(service, { baseRevisionNumber: 0 }))).toEqual({
      status: 500,
      body: {
        msg: 'The editorial policy could not be saved.',
        code: 'CS_PROFILE_SAVE_FAILED',
      },
    });
    const other = new Error('database down');
    repository.createPolicyWithFirstRevision.mockRejectedValueOnce(other);
    await expect(save(service, { baseRevisionNumber: 0 })).rejects.toBe(other);
  });

  it('first-save concurrency: one of two base-0 saves creates, the other conflicts at 1', async () => {
    // the unique organizationId is the only lock: no in-memory one
    let policy: ReturnType<typeof policyRow> | null = null;
    const { repository, service } = setup(null);
    repository.getPolicyForOrganization.mockImplementation(async () => policy);
    let created = 0;
    repository.createPolicyWithFirstRevision.mockImplementation(
      async (input: { policyId: string; revisionId: string }) => {
        // both callers read "no policy" before either writes
        await new Promise((resolve) => setImmediate(resolve));
        if (created++ > 0) {
          throw uniqueError();
        }
        policy = policyRow({ id: input.policyId, latestRevisionNumber: 1 });
        return {
          policy,
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

describe('ContentStudioEditorialPolicyService: later saves', () => {
  it('ES20/ES25/ES26 saves changed content as the next revision, by the request user, hashed by the server', async () => {
    const { repository, service } = setup();
    const result = await save(service, {
      content: { ...content(), ctaRules: [' Ask once. '] },
      ...({ contentHash: 'f'.repeat(64), createdById: 'x' } as object),
    });
    const expected = normalized({ ...content(), ctaRules: ['Ask once.'] });
    expect(repository.createRevisionWithCompareAndSwap).toHaveBeenCalledWith({
      organizationId: ORG,
      expectedLatestRevisionNumber: 2,
      revisionId: NEW_ID,
      revision: storedContentStudioEditorialPolicyContent(expected),
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
    expect(repository.createPolicyWithFirstRevision).not.toHaveBeenCalled();
  });

  it('ES21/ES27 answers the verified current revision for unchanged content', async () => {
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

  it('ES28 answers an integrity error, not created: false, when the matching current revision is corrupted', async () => {
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
      'ES22/ES23 a stale base',
      { status: 'conflict', currentRevisionNumber: 5 },
      conflict(5),
    ],
    ['a policy that is gone', { status: 'not-found' }, conflict(0)],
  ])('maps %s to a conflict', async (_name, state, body) => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce(state);
    expect(await httpError(save(service))).toEqual({ status: 409, body });
  });

  it('ES24 tells a lost compare-and-swap from the current revision number', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValue({
      status: 'changed',
    });
    repository.getPolicyForOrganization.mockResolvedValueOnce(
      policyRow({ latestRevisionNumber: 4 })
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
    repository.getPolicyForOrganization.mockResolvedValueOnce(
      policyRow({ latestRevisionNumber: 3 })
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

describe('ContentStudioEditorialPolicyService: history', () => {
  it('ES30 answers an empty history before the first save', async () => {
    const { repository, service } = setup(null);
    expect(
      await service.listRevisions({ organizationId: ORG, page: 1 })
    ).toEqual({ pages: 0, results: [] });
    expect(repository.listRevisionsForPolicy).not.toHaveBeenCalled();
    expect(writes(repository)).toEqual([]);
  });

  it('ES31/ES37/ES38 lists summaries of the organization policy by page', async () => {
    const { repository, service } = setup();
    const list = await service.listRevisions({ organizationId: ORG, page: 2 });
    expect(list).toEqual({ pages: 2, results: [summaryOf(revisionRow())] });
    expect(repository.listRevisionsForPolicy).toHaveBeenCalledWith({
      organizationId: ORG,
      policyId: POLICY,
      skip: 20,
      take: 20,
    });
    expect(repository.countRevisionsForPolicy).toHaveBeenCalledWith(
      ORG,
      POLICY
    );
    expect(Object.keys(list.results[0]).sort()).toEqual([
      'contentHash',
      'createdAt',
      'id',
      'revisionNumber',
      'schemaVersion',
    ]);
  });

  it('ES32/ES35/ES38 shows a verified revision of the organization policy', async () => {
    const { repository, service } = setup();
    const revision = await service.getRevision({
      organizationId: ORG,
      revisionId: REVISION,
    });
    expect(revision).toEqual({
      ...summaryOf(revisionRow()),
      content: normalized(),
    });
    expect(repository.getRevisionForPolicy).toHaveBeenCalledWith(
      ORG,
      POLICY,
      REVISION
    );
  });

  it('ES33 answers 404 for a malformed revision id without a query', async () => {
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
    expect(repository.getPolicyForOrganization).not.toHaveBeenCalled();
    expect(repository.getRevisionForPolicy).not.toHaveBeenCalled();
  });

  it('ES34 answers 404 for a revision of another organization, another one, or before the first save', async () => {
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
    expect(repository.getRevisionForPolicy).toHaveBeenCalledTimes(1);

    const none = setup(null);
    expect(
      await httpError(
        none.service.getRevision({ organizationId: ORG, revisionId: REVISION })
      )
    ).toEqual({ status: 404, body: NOT_FOUND });
  });

  it('ES36 answers a fixed 500 for a corrupted revision without quoting it', async () => {
    const { repository, service } = setup();
    repository.getRevisionForPolicy.mockResolvedValueOnce(
      revisionRow({ content: `{"complianceNotes":"${MARKER}"}` })
    );
    expect(
      await httpError(
        service.getRevision({ organizationId: ORG, revisionId: REVISION })
      )
    ).toEqual({ status: 500, body: INTEGRITY });
  });
});

describe('ContentStudioEditorialPolicyService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.editorial-policy.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('ES8/ES29 has no role, billing, AI, provider, fetching or checker dependency', () => {
    expect(text).not.toMatch(
      /Role\.|assertManager|CheckPolicies|Sections\.|subscription|stripe|credit|AIExecution|ai\.execution|ai\.provider|AIProviderResolver|AIConnection|generateText|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|score|compliant/i
    );
  });

  it('logs nothing and never serializes the policy for a message', () => {
    expect(text).not.toMatch(/console\.|Logger|JSON\.stringify|\.message\b/);
  });

  it('never writes a revision itself', () => {
    expect(text).not.toMatch(
      /contentStudioEditorialPolicyRevision|\.update\(|\.delete\(|\.upsert\(/
    );
  });
});
