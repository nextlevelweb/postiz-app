import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioAudienceProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.service';
import { parseContentStudioAudienceProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';
import { storedContentStudioAudienceProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';

// No database: the repository is mocked; the audience content parser, canonical
// JSON and hashing run for real
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});
const uuid = jest.mocked(randomUUID);

const MARKER = 'AUDIENCE_PROFILE_SECRET_MARKER_123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const OTHER_PROFILE = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const REVISION = '66666666-6666-4666-8666-666666666666';
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const T0 = new Date('2026-10-14T10:00:00.000Z');

const content = (description = `Owners of Dutch SMEs. ${MARKER}`) => ({
  schemaVersion: 1,
  description,
  role: 'Owner',
  knowledgeLevel: 'intermediate',
  goals: ['Save time'],
  painPoints: ['No time for marketing'],
  objections: [`Too expensive. ${MARKER}`],
  preferredTone: null,
  locale: 'nl-NL',
});
const normalized = (input = content()) =>
  parseContentStudioAudienceProfileContent(input);
const storedOf = (input = content()) =>
  storedContentStudioAudienceProfileContent(normalized(input));

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: PROFILE,
  name: 'SME owners',
  latestRevisionNumber: 2,
  archivedAt: null as Date | null,
  createdAt: T0,
  updatedAt: T0,
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

const setup = () => {
  const repository = {
    listProfilesForOrganization: jest.fn(async () => [
      { ...profileRow(), organizationId: ORG, createdById: USER },
    ]),
    countProfilesForOrganization: jest.fn(async () => 41),
    getProfileForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === PROFILE ? profileRow() : null
    ),
    createProfileWithFirstRevision: jest.fn(
      async (input: {
        profileId: string;
        revisionId: string;
        name: string;
      }) => ({
        profile: profileRow({
          id: input.profileId,
          name: input.name,
          latestRevisionNumber: 1,
        }),
        revision: summaryOf(
          revisionRow({ id: input.revisionId, revisionNumber: 1 })
        ),
      })
    ),
    updateProfileName: jest.fn(async () => ({ count: 1 })),
    archiveProfile: jest.fn(async () => ({ count: 1 })),
    restoreProfile: jest.fn(async () => ({ count: 1 })),
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
    listRevisionsForProfile: jest.fn(async () => [summaryOf(revisionRow())]),
    countRevisionsForProfile: jest.fn(async () => 2),
    getRevisionForProfile: jest.fn(
      async (organizationId: string, profileId: string, id: string) =>
        organizationId === ORG && profileId === PROFILE && id === REVISION
          ? revisionRow()
          : null
    ),
    getRevisionByNumber: jest.fn(async () => revisionRow()),
  };
  const service = new ContentStudioAudienceProfileService(
    repository as unknown as ContentStudioAudienceProfileRepository
  );
  return { repository, service };
};
type Repository = ReturnType<typeof setup>['repository'];

const writes = (repository: Repository) =>
  [
    repository.createProfileWithFirstRevision,
    repository.updateProfileName,
    repository.archiveProfile,
    repository.restoreProfile,
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
  expect(text).not.toMatch(/sb1|[0-9a-f]{64}|zod|Prisma|P200/);
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse() as Record<string, unknown>,
  };
};

const NOT_FOUND = { msg: 'Audience profile not found.', code: 'CS_NOT_FOUND' };
const ARCHIVED = {
  msg: 'This audience profile is archived.',
  code: 'CS_PROFILE_ARCHIVED',
};
const INVALID = {
  msg: 'The audience profile is invalid.',
  code: 'CS_PROFILE_INVALID',
};
const INTEGRITY = {
  msg: 'Stored audience profile data could not be verified.',
  code: 'CS_PROFILE_INTEGRITY_ERROR',
};
const conflict = (currentRevisionNumber: number) => ({
  msg: 'The audience profile changed. Reload it and try again.',
  code: 'CS_PROFILE_REVISION_CONFLICT',
  currentRevisionNumber,
});

beforeEach(() => {
  let next = 0;
  uuid.mockImplementation(
    () => [NEW_ID, REVISION][next++ % 2] as ReturnType<typeof randomUUID>
  );
});

describe('ContentStudioAudienceProfileService: create', () => {
  it('AS1-AS3/AS8/AS9/AS11/AS12 creates a profile and revision 1 for the request organization and user', async () => {
    const { repository, service } = setup();
    const result = await service.createProfile({
      organizationId: ORG,
      userId: USER,
      name: '  SME owners  ',
      content: {
        ...content(),
        description: ` Owners of Dutch SMEs. ${MARKER}\r\n`,
      },
    });

    expect(repository.createProfileWithFirstRevision).toHaveBeenCalledWith({
      profileId: NEW_ID,
      revisionId: REVISION,
      organizationId: ORG,
      name: 'SME owners',
      createdById: USER,
      revision: storedOf(),
    });
    expect(result).toEqual({
      id: NEW_ID,
      name: 'SME owners',
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
      currentRevision: {
        id: REVISION,
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: storedOf().contentHash,
        createdAt: T0,
        content: normalized(),
      },
    });
  });

  it.each([
    ['AS4 a blank name', '   '],
    ['AS5 a name over 100 characters', 'n'.repeat(101)],
    ['a name with NUL', 'a\u0000b'],
    ['a name with a lone surrogate', 'a\ud800'],
    ['no name', undefined],
  ])('refuses %s with a fixed 400', async (_name, name) => {
    const { repository, service } = setup();
    const err = await httpError(
      service.createProfile({
        organizationId: ORG,
        userId: USER,
        name,
        content: content(),
      })
    );
    expect(err.status).toBe(400);
    expect(err.body.code).toBe('CS_INVALID_REQUEST');
    expect(writes(repository)).toEqual([]);
  });

  it('AS6/AS7 refuses invalid or oversized audience content without repeating it', async () => {
    const { repository, service } = setup();
    const invalid = await httpError(
      service.createProfile({
        organizationId: ORG,
        userId: USER,
        name: 'SME owners',
        content: { ...content(), extra: MARKER },
      })
    );
    expect(invalid).toEqual({ status: 400, body: INVALID });

    const big = {
      ...content(),
      // 3 bytes per character: within every character limit, over 16 KiB
      description: `${MARKER}${String.fromCharCode(0x20ac).repeat(1900)}`,
      goals: Array.from({ length: 10 }, (_, i) =>
        `${i}`.padEnd(300, String.fromCharCode(0x20ac))
      ),
      painPoints: Array.from({ length: 10 }, (_, i) =>
        `${i}`.padEnd(300, String.fromCharCode(0x20ac))
      ),
    };
    const tooLarge = await httpError(
      service.createProfile({
        organizationId: ORG,
        userId: USER,
        name: 'SME owners',
        content: big,
      })
    );
    expect(tooLarge).toEqual({
      status: 400,
      body: {
        msg: 'The audience profile is too large.',
        code: 'CS_PROFILE_TOO_LARGE',
      },
    });
    expect(writes(repository)).toEqual([]);
  });

  it('AS10 ignores anything but name and content', async () => {
    const { repository, service } = setup();
    await service.createProfile({
      organizationId: ORG,
      userId: USER,
      name: 'SME owners',
      content: content(),
      ...({
        organizationId2: OTHER_ORG,
        createdById: 'someone',
        latestRevisionNumber: 9,
        contentHash: 'f'.repeat(64),
      } as object),
    });
    const [[input]] = repository.createProfileWithFirstRevision.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(Object.keys(input).sort()).toEqual(
      ['createdById', 'name', 'organizationId', 'profileId', 'revision']
        .concat('revisionId')
        .sort()
    );
    expect(input).toMatchObject({ organizationId: ORG, createdById: USER });
  });
});

describe('ContentStudioAudienceProfileService: read', () => {
  it('AS14-AS16/AS22/AS23 lists summaries of a page, never content or internal ids', async () => {
    const { repository, service } = setup();
    for (const archived of [false, true]) {
      const list = await service.listProfiles({
        organizationId: ORG,
        archived,
        page: 3,
      });
      expect(list).toEqual({
        pages: 3,
        results: [
          {
            id: PROFILE,
            name: 'SME owners',
            latestRevisionNumber: 2,
            archivedAt: null,
            createdAt: T0,
            updatedAt: T0,
          },
        ],
      });
    }
    expect(repository.listProfilesForOrganization.mock.calls).toEqual([
      [{ organizationId: ORG, archived: false, skip: 40, take: 20 }],
      [{ organizationId: ORG, archived: true, skip: 40, take: 20 }],
    ]);
    expect(repository.countProfilesForOrganization.mock.calls).toEqual([
      [{ organizationId: ORG, archived: false }],
      [{ organizationId: ORG, archived: true }],
    ]);
  });

  it('AS17/AS20 shows the profile with its verified current revision', async () => {
    const { repository, service } = setup();
    const detail = await service.getProfile(ORG, PROFILE);
    expect(repository.getRevisionByNumber).toHaveBeenCalledWith(
      ORG,
      PROFILE,
      2
    );
    expect(detail).toEqual({
      id: PROFILE,
      name: 'SME owners',
      latestRevisionNumber: 2,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
      currentRevision: {
        ...summaryOf(revisionRow()),
        content: normalized(),
      },
    });
  });

  it('AS18 keeps an archived profile readable', async () => {
    const { repository, service } = setup();
    repository.getProfileForOrganization.mockResolvedValueOnce(
      profileRow({ archivedAt: T0 })
    );
    expect((await service.getProfile(ORG, PROFILE)).archivedAt).toBe(T0);
  });

  it('AS19 answers 404 for a missing, foreign or malformed profile', async () => {
    const { repository, service } = setup();
    for (const [org, id] of [
      [OTHER_ORG, PROFILE],
      [ORG, OTHER_PROFILE],
      [ORG, 'not-a-uuid'],
      [ORG, 'AAAAAAAA-3333-4333-8333-333333333333'],
    ]) {
      expect(await httpError(service.getProfile(org, id))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(repository.getProfileForOrganization).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AS21 a changed hash', { contentHash: 'f'.repeat(64) }],
    ['AS21 a broken text', { content: `{"description":"${MARKER}"` }],
    ['AS21 another schema version', { schemaVersion: 2 }],
  ])('answers a fixed 500 for %s', async (_name, change) => {
    const { repository, service } = setup();
    repository.getRevisionByNumber.mockResolvedValueOnce(revisionRow(change));
    expect(await httpError(service.getProfile(ORG, PROFILE))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });

  it('answers a fixed 500 when the current revision is missing', async () => {
    const { repository, service } = setup();
    repository.getRevisionByNumber.mockResolvedValueOnce(
      null as unknown as ReturnType<typeof revisionRow>
    );
    expect((await httpError(service.getProfile(ORG, PROFILE))).body).toEqual(
      INTEGRITY
    );
  });
});

describe('ContentStudioAudienceProfileService: rename, archive, restore', () => {
  it('AS24/AS25/AS34 renames a live profile for any member, without a revision', async () => {
    const { repository, service } = setup();
    repository.getProfileForOrganization.mockResolvedValueOnce(
      profileRow({ name: 'New name' })
    );
    const result = await service.renameProfile(ORG, PROFILE, '  New name ');
    expect(repository.updateProfileName).toHaveBeenCalledWith(
      ORG,
      PROFILE,
      'New name'
    );
    expect(result.name).toBe('New name');
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('AS26/AS27 refuses an archived profile and answers 404 when it is gone', async () => {
    const { repository, service } = setup();
    repository.updateProfileName.mockResolvedValue({ count: 0 });
    repository.getProfileForOrganization.mockResolvedValueOnce(
      profileRow({ archivedAt: T0 })
    );
    expect(await httpError(service.renameProfile(ORG, PROFILE, 'X'))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
    expect(
      await httpError(service.renameProfile(OTHER_ORG, PROFILE, 'X'))
    ).toEqual({ status: 404, body: NOT_FOUND });
    expect(
      (await httpError(service.renameProfile(ORG, PROFILE, ' '))).status
    ).toBe(400);
  });

  it('AS28-AS33 archives and restores for any member, idempotently, keeping the revision number', async () => {
    const { repository, service } = setup();
    repository.archiveProfile.mockResolvedValueOnce({ count: 0 });
    repository.getProfileForOrganization.mockResolvedValueOnce(
      profileRow({ archivedAt: T0 })
    );
    const archived = await service.archiveProfile(ORG, PROFILE);
    expect(archived).toMatchObject({ archivedAt: T0, latestRevisionNumber: 2 });
    expect(repository.archiveProfile).toHaveBeenCalledWith(
      ORG,
      PROFILE,
      expect.any(Date)
    );

    repository.restoreProfile.mockResolvedValueOnce({ count: 0 });
    const restored = await service.restoreProfile(ORG, PROFILE);
    expect(restored).toMatchObject({
      archivedAt: null,
      latestRevisionNumber: 2,
    });
    expect(repository.restoreProfile).toHaveBeenCalledWith(ORG, PROFILE);
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
    expect(await httpError(service.archiveProfile(OTHER_ORG, PROFILE))).toEqual(
      { status: 404, body: NOT_FOUND }
    );
  });
});

describe('ContentStudioAudienceProfileService: revisions', () => {
  const save = (
    service: ContentStudioAudienceProfileService,
    overrides: Record<string, unknown> = {}
  ) =>
    service.createRevision({
      organizationId: ORG,
      profileId: PROFILE,
      userId: USER,
      baseRevisionNumber: 2,
      content: content(),
      ...overrides,
    });

  it('AS35/AS40/AS43/AS44/AS45 saves new content as the next revision, by the request user', async () => {
    const { repository, service } = setup();
    const result = await save(service, {
      content: { ...content(), goals: [' Win back time. '] },
      ...({
        revisionNumber: 9,
        contentHash: 'f'.repeat(64),
        createdById: 'x',
      } as object),
    });
    const expected = normalized({ ...content(), goals: ['Win back time.'] });
    expect(repository.createRevisionWithCompareAndSwap).toHaveBeenCalledWith({
      organizationId: ORG,
      profileId: PROFILE,
      expectedLatestRevisionNumber: 2,
      revisionId: NEW_ID,
      revision: storedContentStudioAudienceProfileContent(expected),
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
    });
  });

  it('AS36 answers the verified current revision for unchanged content', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'unchanged',
      revision: revisionRow(),
    });
    expect(await save(service)).toEqual({
      created: false,
      revision: { ...summaryOf(revisionRow()), content: normalized() },
    });
  });

  it.each([
    [
      'AS37 a stale base',
      { status: 'conflict', currentRevisionNumber: 5 },
      409,
      conflict(5),
    ],
    ['AS38 an archived profile', { status: 'archived' }, 409, ARCHIVED],
    [
      'AS39 a missing or foreign profile',
      { status: 'not-found' },
      404,
      NOT_FOUND,
    ],
  ])('maps %s', async (_name, state, status, body) => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValueOnce(state);
    expect(await httpError(save(service))).toEqual({ status, body });
  });

  it('AS47 tells a lost compare-and-swap apart from the current state', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockResolvedValue({
      status: 'changed',
    });
    repository.getProfileForOrganization
      .mockResolvedValueOnce(profileRow({ latestRevisionNumber: 4 }))
      .mockResolvedValueOnce(profileRow({ archivedAt: T0 }))
      .mockResolvedValueOnce(null);
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: conflict(4),
    });
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
    expect(await httpError(save(service))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
  });

  it('AS46 maps a unique-key race to a conflict and lets other errors through unchanged', async () => {
    const { repository, service } = setup();
    repository.createRevisionWithCompareAndSwap.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(`Unique ${MARKER}`, {
        code: 'P2002',
        clientVersion: '6.5.0',
      })
    );
    repository.getProfileForOrganization.mockResolvedValueOnce(
      profileRow({ latestRevisionNumber: 3 })
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
    ['AS41 base 0', 0],
    ['AS41 a negative base', -1],
    ['a fractional base', 1.5],
    ['AS42 a base past int4', 2 ** 31],
    ['a string base', '2'],
  ])(
    'refuses %s with a 400 and no write',
    async (_name, baseRevisionNumber) => {
      const { repository, service } = setup();
      const err = await httpError(save(service, { baseRevisionNumber }));
      expect(err.status).toBe(400);
      expect(err.body.code).toBe('CS_INVALID_REQUEST');
      expect(writes(repository)).toEqual([]);
    }
  );

  it('refuses invalid content and a malformed profile id before any write', async () => {
    const { repository, service } = setup();
    expect(
      (
        await httpError(
          save(service, { content: { ...content(), goals: ['a', 'a'] } })
        )
      ).body
    ).toEqual(INVALID);
    expect(
      (await httpError(save(service, { profileId: 'not-a-uuid' }))).body
    ).toEqual(NOT_FOUND);
    expect(writes(repository)).toEqual([]);
  });

  it('AS48/AS49 lists the history newest first, archived or not', async () => {
    const { repository, service } = setup();
    repository.getProfileForOrganization.mockResolvedValueOnce(
      profileRow({ archivedAt: T0 })
    );
    expect(
      await service.listRevisions({
        organizationId: ORG,
        profileId: PROFILE,
        page: 2,
      })
    ).toEqual({ pages: 1, results: [summaryOf(revisionRow())] });
    expect(repository.listRevisionsForProfile).toHaveBeenCalledWith({
      organizationId: ORG,
      profileId: PROFILE,
      skip: 20,
      take: 20,
    });
    expect(
      await httpError(
        service.listRevisions({
          organizationId: OTHER_ORG,
          profileId: PROFILE,
          page: 1,
        })
      )
    ).toEqual({ status: 404, body: NOT_FOUND });
  });

  it('AS50/AS53/AS55 shows a verified revision of the profile as structured content', async () => {
    const { service } = setup();
    expect(
      await service.getRevision({
        organizationId: ORG,
        profileId: PROFILE,
        revisionId: REVISION,
      })
    ).toEqual({ ...summaryOf(revisionRow()), content: normalized() });
  });

  it('AS51/AS52 answers 404 for a revision of another profile or organization', async () => {
    const { repository, service } = setup();
    for (const [organizationId, profileId, revisionId] of [
      [ORG, OTHER_PROFILE, REVISION],
      [OTHER_ORG, PROFILE, REVISION],
      [ORG, PROFILE, NEW_ID],
      [ORG, PROFILE, 'not-a-uuid'],
    ]) {
      expect(
        await httpError(
          service.getRevision({ organizationId, profileId, revisionId })
        )
      ).toEqual({ status: 404, body: NOT_FOUND });
    }
    expect(repository.getRevisionForProfile).toHaveBeenCalledTimes(3);
  });

  it('AS54 answers a fixed 500 for a corrupted revision without quoting it', async () => {
    const { repository, service } = setup();
    repository.getRevisionForProfile.mockResolvedValueOnce(
      revisionRow({ content: `{"description":"${MARKER}"}` })
    );
    expect(
      await httpError(
        service.getRevision({
          organizationId: ORG,
          profileId: PROFILE,
          revisionId: REVISION,
        })
      )
    ).toEqual({ status: 500, body: INTEGRITY });
  });
});

describe('ContentStudioAudienceProfileService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.audience-profile.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('AS2/AS13 has no role, billing, AI or provider dependency', () => {
    expect(text).not.toMatch(
      /Role\.|assertManager|CheckPolicies|Sections\.|subscription|stripe|credit|AIExecution|ai\.execution|ai\.provider|AIProviderResolver|generateText|from 'openai'|@anthropic-ai|@ai-sdk/i
    );
  });

  it('logs nothing and never serializes audience content for a message', () => {
    expect(text).not.toMatch(/console\.|Logger|JSON\.stringify|\.message\b/);
  });
});
