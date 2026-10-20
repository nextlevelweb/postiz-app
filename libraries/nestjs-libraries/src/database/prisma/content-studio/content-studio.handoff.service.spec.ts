import { HttpException, Logger } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';
import {
  CONTENT_STUDIO_HANDOFF_TTL_MS,
  ContentStudioHandoffService,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import {
  ContentStudioMediaService,
  ContentStudioMediaUnavailableError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import {
  ContentPackageDraft,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { contentStudioTextToComposerHtml } from '@gitroom/nestjs-libraries/content-studio/handoff.html';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';

// The real MediaService pulls in uploads, Redis and Temporal at import time,
// and the real sanitizer needs a DOM; both are covered by their own specs.
// Here the serializer marks its output so the tests can see it was used
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: jest.fn(),
}));
const serialize = jest.mocked(contentStudioTextToComposerHtml);

const ORG = 'org-a';
const USER = 'user-1';
const PACKAGE_ID = 'package-1';
const REVISION_ID = 'revision-1';
const HANDOFF_ID = '0123456789abcdef'.repeat(4);
const NOW = new Date('2026-10-12T10:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);

const draftOf = (...items: { text: string; mediaIds?: string[] }[]) =>
  parseContentPackageDraft({
    schemaVersion: 1,
    copy: {
      global: {
        thread: items.map((item, i) => ({
          id: `item-${i}`,
          text: item.text,
          mediaIds: item.mediaIds ?? [],
        })),
      },
    },
  });
const DRAFT_A = draftOf(
  { text: 'Launch day', mediaIds: ['m2', 'm1'] },
  { text: 'Follow-up one' },
  { text: 'Follow-up two', mediaIds: ['m3'] }
);
const DRAFT_B = draftOf({ text: 'Rewritten draft' });

const revisionRow = (
  draft: ContentPackageDraft = DRAFT_A,
  overrides: Partial<{
    content: string;
    contentHash: string;
    schemaVersion: number;
  }> = {}
) => {
  const content = canonicalJson(draft);
  return {
    id: REVISION_ID,
    packageId: PACKAGE_ID,
    revisionNumber: 3,
    schemaVersion: 1,
    content,
    contentHash: sha256Hex(content),
    origin: 'manual',
    sourceDraftVersion: 7,
    createdAt: NOW,
    createdBy: { id: USER, name: 'Ada' },
    ...overrides,
  };
};
const handoffRow = (
  overrides: Partial<{
    expiresAt: Date;
    openedAt: Date | null;
    revokedAt: Date | null;
    approvalRequiredAtCreation: boolean | null;
    approvalReviewId: string | null;
    approvalSequence: number | null;
    approvalContentHash: string | null;
  }> = {}
) => ({
  id: HANDOFF_ID,
  packageId: PACKAGE_ID,
  packageRevisionId: REVISION_ID,
  expiresAt: LATER,
  openedAt: null as Date | null,
  revokedAt: null as Date | null,
  createdAt: NOW,
  // a handoff made before P5-08 recorded what authorized it
  approvalRequiredAtCreation: null as boolean | null,
  approvalReviewId: null as string | null,
  approvalSequence: null as number | null,
  approvalContentHash: null as string | null,
  ...overrides,
});
// every Media ready, with the path from its (database) row
const readyMedia = async (_org: string, draft: ContentPackageDraft) =>
  draft.copy.global.thread.map((item) =>
    item.mediaIds.map((id) => ({ id, path: `/db/${id}.png` }))
  );

const setup = () => {
  const repository = {
    getRevisionForPackage: jest.fn().mockResolvedValue(null),
    getPackageForOrganization: jest.fn(),
    getPackageWriteStateForOrganization: jest.fn(),
    getLatestRevisionForPackage: jest.fn(),
  };
  const handoffs = {
    createHandoff: jest.fn(async (input: { id: string; expiresAt: Date }) => ({
      id: input.id,
      expiresAt: input.expiresAt,
    })),
    createHandoffWhileApproved: jest.fn(
      async (input: { id: string; expiresAt: Date }) => ({
        id: input.id,
        expiresAt: input.expiresAt,
      })
    ),
    getHandoffForOrganizationAndUser: jest.fn().mockResolvedValue(null),
    markOpenedIfNeeded: jest.fn().mockResolvedValue({ count: 1 }),
    revokeHandoff: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const media = {
    resolveForHandoff: jest.fn(readyMedia),
    getPreviewMap: jest.fn(),
  };
  // P5-07: no organization requires approval unless a test says so; the
  // approval itself is the review service's (its own suite runs it for
  // real, with the handoff)
  const policy = {
    isApprovalRequiredForHandoff: jest.fn().mockResolvedValue(false),
  };
  const reviews = {
    requireApprovedRevision: jest.fn(),
    // P5-08: the stored history still has what a handoff says authorized it
    verifyHandoffApprovalAuthorization: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ContentStudioHandoffService(
    repository as unknown as ContentStudioRepository,
    handoffs as unknown as ContentStudioHandoffRepository,
    media as unknown as ContentStudioMediaService,
    policy as unknown as ContentStudioEditorialPolicyService,
    reviews as unknown as ContentStudioReviewService
  );
  return { repository, handoffs, media, policy, reviews, service };
};

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(HttpException);
  expect((error as object).constructor).toBe(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
};

const NOT_FOUND = {
  status: 404,
  body: { msg: 'Content Studio item not found', code: 'CS_NOT_FOUND' },
};
const GONE = {
  status: 410,
  body: {
    msg: 'This Content Studio handoff is no longer available',
    code: 'CS_HANDOFF_GONE',
  },
};
const STORED_REVISION_INVALID = {
  status: 500,
  body: {
    msg: 'Stored Content Studio revision is invalid',
    code: 'CS_STORED_REVISION_INVALID',
  },
};
const mediaUnavailable = (items: object[]) => ({
  status: 400,
  body: {
    msg: 'Content Studio media is unavailable',
    code: 'CS_MEDIA_UNAVAILABLE',
    items,
  },
});
// nothing identifying may appear in an error body
const SECRETS = [
  HANDOFF_ID,
  PACKAGE_ID,
  REVISION_ID,
  ORG,
  USER,
  'm1',
  'm2',
  '/db/',
  'Launch day',
  'Follow-up',
  sha256Hex(canonicalJson(DRAFT_A)),
];
const expectRedacted = (body: unknown) => {
  const text = JSON.stringify(body);
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
};

const ONLY_VALUES_A = [
  {
    content: 'SERIALIZED:Launch day',
    image: [
      { id: 'm2', path: '/db/m2.png' },
      { id: 'm1', path: '/db/m1.png' },
    ],
  },
  { content: 'SERIALIZED:Follow-up one' },
  {
    content: 'SERIALIZED:Follow-up two',
    image: [{ id: 'm3', path: '/db/m3.png' }],
  },
];

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  serialize.mockImplementation((text: string) => `SERIALIZED:${text}`);
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('ContentStudioHandoffService.createHandoff', () => {
  const create = (service: ContentStudioHandoffService) =>
    service.createHandoff({
      organizationId: ORG,
      userId: USER,
      packageId: PACKAGE_ID,
      revisionId: REVISION_ID,
    });

  it('HC1 HC12 HC13 stores a 24-hour handoff of a verified revision for the request user', async () => {
    const { repository, handoffs, media, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(
      revisionRow(draftOf({ text: 'No media' }))
    );

    const result = await create(service);
    expect(repository.getRevisionForPackage).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID,
      REVISION_ID
    );
    expect(media.resolveForHandoff).toHaveBeenCalledWith(
      ORG,
      draftOf({ text: 'No media' })
    );
    const input = handoffs.createHandoff.mock.calls[0][0];
    expect(input).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      organizationId: ORG,
      userId: USER,
      packageId: PACKAGE_ID,
      packageRevisionId: REVISION_ID,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    });
    expect(CONTENT_STUDIO_HANDOFF_TTL_MS).toBe(86_400_000);
    expect(result).toEqual({ id: input.id, expiresAt: input.expiresAt });
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'id']);
  });

  it('HC2 gives every handoff a different id', async () => {
    const { repository, handoffs, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());

    for (let i = 0; i < 10; i++) {
      await create(service);
    }
    const ids = handoffs.createHandoff.mock.calls.map(([input]) => input.id);
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('HC3 answers 404 for a missing, foreign or other-package revision', async () => {
    const { handoffs, media, service } = setup();

    expect(await rejection(create(service))).toEqual(NOT_FOUND);
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
    expect(handoffs.createHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ['HC4 broken JSON', { content: '{"copy":' }],
    [
      'HC5 a draft the schema rejects',
      {
        content: '{"schemaVersion":2}',
        contentHash: sha256Hex('{"schemaVersion":2}'),
      },
    ],
    [
      'HC6 non-canonical text',
      {
        content: JSON.stringify(DRAFT_A),
        contentHash: sha256Hex(JSON.stringify(DRAFT_A)),
      },
    ],
    ['HC7 a hash mismatch', { contentHash: sha256Hex('other') }],
    ['HC8 a schema version mismatch', { schemaVersion: 2 }],
  ])('%s answers 500 and stores nothing', async (_name, overrides) => {
    const { repository, handoffs, media, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(
      revisionRow(DRAFT_A, overrides)
    );

    const result = await rejection(create(service));
    expect(result).toEqual(STORED_REVISION_INVALID);
    expectRedacted(result);
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
    expect(handoffs.createHandoff).not.toHaveBeenCalled();
  });

  it('HC9 HC14 answers 400 with positions only and stores nothing when Media are not ready', async () => {
    const { repository, handoffs, media, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    media.resolveForHandoff.mockRejectedValue(
      new ContentStudioMediaUnavailableError([
        { itemIndex: 0, mediaIndex: 1, reason: 'processing' },
        { itemIndex: 2, mediaIndex: 0, reason: 'unavailable' },
      ])
    );

    const result = await rejection(create(service));
    expect(result).toEqual(
      mediaUnavailable([
        { itemIndex: 0, mediaIndex: 1, reason: 'processing' },
        { itemIndex: 2, mediaIndex: 0, reason: 'unavailable' },
      ])
    );
    expectRedacted(result);
    expect(handoffs.createHandoff).not.toHaveBeenCalled();
  });

  it('HC10 lets a Media lookup failure through', async () => {
    const { repository, handoffs, media, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    const error = new Error('Connection refused');
    media.resolveForHandoff.mockRejectedValue(error);

    await expect(create(service)).rejects.toBe(error);
    expect(handoffs.createHandoff).not.toHaveBeenCalled();
  });

  it('HO8 without the policy requirement no approval is asked for, and the handoff is the plain one', async () => {
    const { repository, handoffs, policy, reviews, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    reviews.requireApprovedRevision.mockRejectedValue(
      new Error('must not be asked')
    );
    await create(service);
    expect(policy.isApprovalRequiredForHandoff.mock.calls).toEqual([[ORG]]);
    expect(reviews.requireApprovedRevision).not.toHaveBeenCalled();
    expect(handoffs.createHandoff).toHaveBeenCalledTimes(1);
    expect(handoffs.createHandoffWhileApproved).not.toHaveBeenCalled();
  });

  it('TT1/M4 with the requirement: the exact package revision is required approved, then handed off holding its review', async () => {
    const { repository, handoffs, policy, reviews, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    policy.isApprovalRequiredForHandoff.mockResolvedValue(true);
    reviews.requireApprovedRevision.mockResolvedValue({
      approved: true,
      state: 'APPROVED',
      reviewId: 'review-1',
      approvalVersion: 3,
    });
    const result = await create(service);
    expect(reviews.requireApprovedRevision.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: REVISION_ID,
        },
      ],
    ]);
    expect(handoffs.createHandoff).not.toHaveBeenCalled();
    const input = handoffs.createHandoffWhileApproved.mock.calls[0][0];
    expect(input).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      organizationId: ORG,
      userId: USER,
      packageId: PACKAGE_ID,
      packageRevisionId: REVISION_ID,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      reviewId: 'review-1',
      approvalVersion: 3,
    });
    // the same answer as without the requirement
    expect(result).toEqual({ id: input.id, expiresAt: input.expiresAt });
  });

  it('AT1/M8/M10 a revision that is not approved fails the handoff with that error before anything is written', async () => {
    const { repository, handoffs, media, policy, reviews, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    policy.isApprovalRequiredForHandoff.mockResolvedValue(true);
    const required = new HttpException(
      { msg: 'This revision is not approved.', code: 'CS_APPROVAL_REQUIRED' },
      409
    );
    reviews.requireApprovedRevision.mockRejectedValue(required);
    await expect(create(service)).rejects.toBe(required);
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
    expect(handoffs.createHandoff).not.toHaveBeenCalled();
    expect(handoffs.createHandoffWhileApproved).not.toHaveBeenCalled();
  });

  it('a revision that is not found is 404 before the policy or an approval is read', async () => {
    const { policy, reviews, service } = setup();
    expect(await rejection(create(service))).toEqual(NOT_FOUND);
    expect(policy.isApprovalRequiredForHandoff).not.toHaveBeenCalled();
    expect(reviews.requireApprovedRevision).not.toHaveBeenCalled();
  });

  it('HC11 never reads the package, so an archived package can hand off a revision', async () => {
    const { repository, handoffs, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionRow());

    await create(service);
    expect(handoffs.createHandoff).toHaveBeenCalledTimes(1);
    expect(repository.getPackageForOrganization).not.toHaveBeenCalled();
    expect(
      repository.getPackageWriteStateForOrganization
    ).not.toHaveBeenCalled();
  });
});

describe('ContentStudioHandoffService.resolveHandoff', () => {
  const resolve = (
    service: ContentStudioHandoffService,
    overrides: Partial<{
      organizationId: string;
      userId: string;
      handoffId: string;
    }> = {}
  ) =>
    service.resolveHandoff({
      organizationId: ORG,
      userId: USER,
      handoffId: HANDOFF_ID,
      ...overrides,
    });
  const live = () => {
    const s = setup();
    s.handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(handoffRow());
    s.repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    return s;
  };

  it.each([
    ['uppercase hex', HANDOFF_ID.toUpperCase()],
    ['63 characters', HANDOFF_ID.slice(1)],
    ['65 characters', `${HANDOFF_ID}0`],
    ['non-hex characters', 'g'.repeat(64)],
    ['a uuid', '3b241101-e2bb-4255-8caf-4136c566a962'],
    ['a path', `../${HANDOFF_ID.slice(3)}`],
    ['an empty string', ''],
  ])('HS1 answers 404 for %s without any query', async (_name, handoffId) => {
    const { handoffs, repository, service } = setup();

    expect(await rejection(resolve(service, { handoffId }))).toEqual(NOT_FOUND);
    expect(handoffs.getHandoffForOrganizationAndUser).not.toHaveBeenCalled();
    expect(repository.getRevisionForPackage).not.toHaveBeenCalled();
  });

  it('HS2 HS3 HS4 answers the same 404 for a missing, foreign or other-user handoff', async () => {
    const { handoffs, service } = setup();

    for (const scope of [
      {},
      { organizationId: 'org-b' },
      { userId: 'user-2' },
    ]) {
      expect(await rejection(resolve(service, scope))).toEqual(NOT_FOUND);
    }
    expect(handoffs.getHandoffForOrganizationAndUser.mock.calls).toEqual([
      [{ organizationId: ORG, userId: USER, id: HANDOFF_ID }],
      [{ organizationId: 'org-b', userId: USER, id: HANDOFF_ID }],
      [{ organizationId: ORG, userId: 'user-2', id: HANDOFF_ID }],
    ]);
  });

  it.each([
    ['HS5 expiring now', { expiresAt: NOW }],
    [
      'HS6 expired a millisecond ago',
      { expiresAt: new Date(NOW.getTime() - 1) },
    ],
    ['HS8 revoked', { revokedAt: new Date(NOW.getTime() - 1000) }],
    ['HS8 revoked but not expired', { revokedAt: NOW, expiresAt: LATER }],
  ])('%s answers 410 without reading the revision', async (_name, row) => {
    const { handoffs, repository, media, service } = setup();
    handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(
      handoffRow(row)
    );

    const result = await rejection(resolve(service));
    expect(result).toEqual(GONE);
    // HS9
    expectRedacted(result);
    expect(repository.getRevisionForPackage).not.toHaveBeenCalled();
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
    expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
  });

  it('HS7 opens a handoff that expires a millisecond from now', async () => {
    const { handoffs, service } = live();
    handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(
      handoffRow({ expiresAt: new Date(NOW.getTime() + 1) })
    );

    await expect(resolve(service)).resolves.toMatchObject({ id: HANDOFF_ID });
  });

  it('HS10 answers 500 when the handoff points at no revision', async () => {
    const { handoffs, repository, service } = live();
    repository.getRevisionForPackage.mockResolvedValue(null);

    const result = await rejection(resolve(service));
    expect(result).toEqual({
      status: 500,
      body: {
        msg: 'Stored Content Studio handoff is invalid',
        code: 'CS_STORED_HANDOFF_INVALID',
      },
    });
    expectRedacted(result);
    expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
  });

  it('HS11 answers 500 for a corrupt revision', async () => {
    const { handoffs, repository, media, service } = live();
    repository.getRevisionForPackage.mockResolvedValue(
      revisionRow(DRAFT_A, { contentHash: sha256Hex('other') })
    );

    expect(await rejection(resolve(service))).toEqual(STORED_REVISION_INVALID);
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
    expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
  });

  it('HS12 answers 400 for Media that are no longer ready and records no open', async () => {
    const { handoffs, media, service } = live();
    media.resolveForHandoff.mockRejectedValue(
      new ContentStudioMediaUnavailableError([
        { itemIndex: 0, mediaIndex: 0, reason: 'failed' },
      ])
    );

    const result = await rejection(resolve(service));
    expect(result).toEqual(
      mediaUnavailable([{ itemIndex: 0, mediaIndex: 0, reason: 'failed' }])
    );
    expectRedacted(result);
    expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
  });

  it('HS13 HS14 HS15 HS16 HS17 HS26 returns the revision as composer values', async () => {
    const { handoffs, repository, media, service } = live();

    const result = await resolve(service);
    expect(result).toStrictEqual({
      id: HANDOFF_ID,
      packageId: PACKAGE_ID,
      revisionId: REVISION_ID,
      revisionNumber: 3,
      expiresAt: LATER,
      approvalAuthorization: { status: 'LEGACY_UNKNOWN' },
      onlyValues: ONLY_VALUES_A,
    });
    expect(repository.getRevisionForPackage).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID,
      REVISION_ID
    );
    expect(media.resolveForHandoff).toHaveBeenCalledWith(ORG, DRAFT_A);
    expect(serialize.mock.calls).toEqual([
      ['Launch day'],
      ['Follow-up one'],
      ['Follow-up two'],
    ]);
    // no image key at all for an item without Media, and no ids
    expect(result.onlyValues[1]).not.toHaveProperty('image');
    for (const value of result.onlyValues) {
      expect(value).not.toHaveProperty('id');
    }
    for (const key of [
      'organizationId',
      'userId',
      'openedAt',
      'revokedAt',
      'contentHash',
      'content',
    ]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(handoffs.markOpenedIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('uses the serializer output as the content', async () => {
    const { service } = live();
    serialize.mockImplementation(
      (text: string) => `<p>${text.replace(/</g, '&lt;')}</p>`
    );

    const result = await resolve(service);
    expect(result.onlyValues.map((value) => value.content)).toEqual([
      '<p>Launch day</p>',
      '<p>Follow-up one</p>',
      '<p>Follow-up two</p>',
    ]);
  });

  it('HS18 records the first open with the same time it checked expiry against', async () => {
    const { handoffs, service } = live();

    await resolve(service);
    expect(handoffs.markOpenedIfNeeded).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      id: HANDOFF_ID,
      openedAt: NOW,
    });
  });

  it('HS19 HS20 opens again with the same values when it was opened before', async () => {
    const { handoffs, service } = live();
    const first = await resolve(service);
    // opened before (or by a simultaneous request): nothing left to stamp
    handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(
      handoffRow({ openedAt: NOW })
    );
    handoffs.markOpenedIfNeeded.mockResolvedValue({ count: 0 });

    const second = await resolve(service);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('HS21 lets a failure to record the open through', async () => {
    const { handoffs, service } = live();
    const error = new Error('Connection refused');
    handoffs.markOpenedIfNeeded.mockRejectedValue(error);

    await expect(resolve(service)).rejects.toBe(error);
  });

  it('records no open when the serializer fails', async () => {
    const { handoffs, service } = live();
    serialize.mockImplementation(() => {
      throw new Error('sanitizer failed');
    });

    await expect(resolve(service)).rejects.toThrow('sanitizer failed');
    expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
  });

  it('HS22 HS23 HS25 serves the frozen revision, whatever the package is now', async () => {
    const { repository, service } = live();
    // the package now has draft B and is archived: neither is ever read
    repository.getPackageForOrganization.mockResolvedValue({
      draft: canonicalJson(DRAFT_B),
      archivedAt: NOW,
    });
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 99,
      archivedAt: NOW,
    });

    const result = await resolve(service);
    expect(result.onlyValues).toEqual(ONLY_VALUES_A);
    expect(repository.getPackageForOrganization).not.toHaveBeenCalled();
    expect(
      repository.getPackageWriteStateForOrganization
    ).not.toHaveBeenCalled();
    expect(repository.getLatestRevisionForPackage).not.toHaveBeenCalled();
  });

  it('HS24 refuses while a Media is processing and opens once it is ready again', async () => {
    const { handoffs, media, service } = live();
    media.resolveForHandoff.mockRejectedValueOnce(
      new ContentStudioMediaUnavailableError([
        { itemIndex: 2, mediaIndex: 0, reason: 'processing' },
      ])
    );

    expect((await rejection(resolve(service))).status).toBe(400);
    await expect(resolve(service)).resolves.toMatchObject({
      onlyValues: ONLY_VALUES_A,
    });
    expect(handoffs.revokeHandoff).not.toHaveBeenCalled();
    expect(handoffs.markOpenedIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('lets a Media lookup failure through', async () => {
    const { media, service } = live();
    const error = new Error('Connection refused');
    media.resolveForHandoff.mockRejectedValue(error);

    await expect(resolve(service)).rejects.toBe(error);
  });

  it('opens a handoff only for its own organization and user', async () => {
    // the repository finds handoff H only for org-a and user-1
    const { handoffs, service } = live();
    handoffs.getHandoffForOrganizationAndUser.mockImplementation(
      async (input: { organizationId: string; userId: string }) =>
        input.organizationId === ORG && input.userId === USER
          ? handoffRow({ revokedAt: NOW })
          : null
    );

    // the owner learns it is gone; nobody else learns it exists
    expect(await rejection(resolve(service))).toEqual(GONE);
    expect(await rejection(resolve(service, { userId: 'user-2' }))).toEqual(
      NOT_FOUND
    );
    expect(
      await rejection(resolve(service, { organizationId: 'org-b' }))
    ).toEqual(NOT_FOUND);
  });
});

describe('ContentStudioHandoffService.revokeHandoff', () => {
  const revoke = (
    service: ContentStudioHandoffService,
    overrides: Partial<{
      organizationId: string;
      userId: string;
      handoffId: string;
    }> = {}
  ) =>
    service.revokeHandoff({
      organizationId: ORG,
      userId: USER,
      handoffId: HANDOFF_ID,
      ...overrides,
    });

  it('HV1 HV8 revokes a live handoff now and returns only id and time', async () => {
    const { handoffs, service } = setup();

    const result = await revoke(service);
    expect(result).toStrictEqual({ id: HANDOFF_ID, revokedAt: NOW });
    expect(handoffs.revokeHandoff).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      id: HANDOFF_ID,
      revokedAt: NOW,
    });
    expect(handoffs.getHandoffForOrganizationAndUser).not.toHaveBeenCalled();
  });

  it('HV2 returns the first revocation time for a revoked handoff', async () => {
    const { handoffs, service } = setup();
    const first = new Date(NOW.getTime() - 5000);
    handoffs.revokeHandoff.mockResolvedValue({ count: 0 });
    handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(
      handoffRow({ revokedAt: first })
    );

    await expect(revoke(service)).resolves.toStrictEqual({
      id: HANDOFF_ID,
      revokedAt: first,
    });
    expect(handoffs.revokeHandoff).toHaveBeenCalledTimes(1);
  });

  it('HV3 HV4 HV5 HV9 answers the same 404 for a missing, foreign or other-user handoff', async () => {
    const { handoffs, service } = setup();
    handoffs.revokeHandoff.mockResolvedValue({ count: 0 });

    for (const scope of [
      {},
      { organizationId: 'org-b' },
      { userId: 'user-2' },
    ]) {
      const result = await rejection(revoke(service, scope));
      expect(result).toEqual(NOT_FOUND);
      expectRedacted(result);
    }
    for (const [input] of [
      ...handoffs.revokeHandoff.mock.calls,
      ...handoffs.getHandoffForOrganizationAndUser.mock.calls,
    ]) {
      expect(Object.keys(input)).toEqual(
        expect.arrayContaining(['organizationId', 'userId', 'id'])
      );
    }
  });

  it.each([
    ['uppercase hex', HANDOFF_ID.toUpperCase()],
    ['a uuid', '3b241101-e2bb-4255-8caf-4136c566a962'],
  ])('HV6 answers 404 for %s without any query', async (_name, handoffId) => {
    const { handoffs, service } = setup();

    expect(await rejection(revoke(service, { handoffId }))).toEqual(NOT_FOUND);
    expect(handoffs.revokeHandoff).not.toHaveBeenCalled();
    expect(handoffs.getHandoffForOrganizationAndUser).not.toHaveBeenCalled();
  });

  it('HV7 revokes an expired handoff', async () => {
    const { handoffs, service } = setup();
    handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(
      handoffRow({ expiresAt: new Date(NOW.getTime() - 1) })
    );

    await expect(revoke(service)).resolves.toStrictEqual({
      id: HANDOFF_ID,
      revokedAt: NOW,
    });
  });

  it('tries once more if the handoff was found unrevoked after a missed update', async () => {
    const { handoffs, service } = setup();
    handoffs.revokeHandoff
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(handoffRow());

    await expect(revoke(service)).resolves.toStrictEqual({
      id: HANDOFF_ID,
      revokedAt: NOW,
    });
    expect(handoffs.revokeHandoff).toHaveBeenCalledTimes(2);
  });

  it('never changes a revision, a package or Media', async () => {
    const { repository, media, service } = setup();
    await revoke(service);

    for (const fn of [...Object.values(repository), ...Object.values(media)]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

// P5-08: every handoff keeps what authorized it when it was created, and
// opening one says so. A record of the past, never the approval of now
describe('ContentStudioHandoffService: what authorized a handoff (P5-08)', () => {
  const REVIEW_ID = '3b241101-e2bb-4255-8caf-4136c566a962';
  const HASH = 'c'.repeat(64);
  const APPROVED_ROW = {
    approvalRequiredAtCreation: true,
    approvalReviewId: REVIEW_ID,
    approvalSequence: 3,
    approvalContentHash: HASH,
  };
  const opened = (row: Parameters<typeof handoffRow>[0]) => {
    const s = setup();
    s.handoffs.getHandoffForOrganizationAndUser.mockResolvedValue(
      handoffRow(row)
    );
    s.repository.getRevisionForPackage.mockResolvedValue(revisionRow());
    return s;
  };
  const open = (service: ContentStudioHandoffService) =>
    service.resolveHandoff({
      organizationId: ORG,
      userId: USER,
      handoffId: HANDOFF_ID,
    });

  it('HAS8/M21 a handoff made before it was recorded is LEGACY_UNKNOWN: nothing is guessed, nothing else is read', async () => {
    const { service, policy, reviews } = opened({});
    expect((await open(service)).approvalAuthorization).toStrictEqual({
      status: 'LEGACY_UNKNOWN',
    });
    // never reconstructed from a policy or an approval
    expect(policy.isApprovalRequiredForHandoff).not.toHaveBeenCalled();
    expect(reviews.requireApprovedRevision).not.toHaveBeenCalled();
    expect(reviews.verifyHandoffApprovalAuthorization.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          packageRevisionId: REVISION_ID,
          authorization: { status: 'LEGACY_UNKNOWN' },
        },
      ],
    ]);
  });

  it('HAS1 a handoff the policy did not require approval for says so, and reads no approval', async () => {
    const { service, reviews } = opened({ approvalRequiredAtCreation: false });
    expect((await open(service)).approvalAuthorization).toStrictEqual({
      status: 'NOT_REQUIRED',
    });
    expect(
      reviews.verifyHandoffApprovalAuthorization.mock.calls[0][0].authorization
    ).toStrictEqual({ status: 'NOT_REQUIRED' });
  });

  it('HAS2-HAS4/HAS10 an approved handoff says which review, decision and hash authorized it, checked against the stored history only', async () => {
    const { service, policy, reviews, handoffs } = opened(APPROVED_ROW);
    expect((await open(service)).approvalAuthorization).toStrictEqual({
      status: 'APPROVED',
      reviewId: REVIEW_ID,
      approvalSequence: 3,
      targetContentHash: HASH,
    });
    expect(reviews.verifyHandoffApprovalAuthorization.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          packageRevisionId: REVISION_ID,
          authorization: {
            status: 'APPROVED',
            reviewId: REVIEW_ID,
            approvalSequence: 3,
            targetContentHash: HASH,
          },
        },
      ],
    ]);
    // HAS10/HAS6: whether it is approved now is never asked
    expect(reviews.requireApprovedRevision).not.toHaveBeenCalled();
    expect(policy.isApprovalRequiredForHandoff).not.toHaveBeenCalled();
    expect(handoffs.markOpenedIfNeeded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['M22 no review', { ...APPROVED_ROW, approvalReviewId: null }],
    ['M22 no sequence', { ...APPROVED_ROW, approvalSequence: null }],
    ['M22 no hash', { ...APPROVED_ROW, approvalContentHash: null }],
    ['sequence 0', { ...APPROVED_ROW, approvalSequence: 0 }],
    ['a fractional sequence', { ...APPROVED_ROW, approvalSequence: 1.5 }],
    ['a malformed hash', { ...APPROVED_ROW, approvalContentHash: 'abc' }],
    ['a malformed review id', { ...APPROVED_ROW, approvalReviewId: 'r-1' }],
    [
      'not required, with a review',
      { approvalRequiredAtCreation: false, approvalReviewId: REVIEW_ID },
    ],
    ['legacy, with a sequence', { approvalSequence: 1 }],
    ['legacy, with a hash', { approvalContentHash: HASH }],
  ])(
    'HAS9 a partial or malformed record (%s) is a stored handoff that is not intact: 500, nothing opened',
    async (_name, row) => {
      const { service, reviews, handoffs, media } = opened(row);
      const result = await rejection(open(service));
      expect(result).toEqual({
        status: 500,
        body: {
          msg: 'Stored Content Studio handoff is invalid',
          code: 'CS_STORED_HANDOFF_INVALID',
        },
      });
      expectRedacted(result);
      expect(JSON.stringify(result)).not.toContain(HASH);
      expect(reviews.verifyHandoffApprovalAuthorization).not.toHaveBeenCalled();
      expect(media.resolveForHandoff).not.toHaveBeenCalled();
      expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
    }
  );

  it('HAS9 an approved record the stored history no longer has is an integrity error, and nothing is opened', async () => {
    const { service, reviews, handoffs } = opened(APPROVED_ROW);
    const integrity = new HttpException(
      {
        msg: 'Stored approval data is not intact.',
        code: 'CS_APPROVAL_INTEGRITY_ERROR',
      },
      500
    );
    reviews.verifyHandoffApprovalAuthorization.mockRejectedValue(integrity);
    await expect(open(service)).rejects.toBe(integrity);
    expect(handoffs.markOpenedIfNeeded).not.toHaveBeenCalled();
  });

  it('a gone handoff is 410 before anything about its authorization is read', async () => {
    const { service, reviews } = opened({
      ...APPROVED_ROW,
      revokedAt: new Date(NOW.getTime() - 1),
    });
    expect((await rejection(open(service))).status).toBe(410);
    expect(reviews.verifyHandoffApprovalAuthorization).not.toHaveBeenCalled();
  });

  it('HAS6/HAS7 revoking reads no approval and writes nothing of the authorization', async () => {
    const { service, reviews, handoffs } = opened(APPROVED_ROW);
    await service.revokeHandoff({
      organizationId: ORG,
      userId: USER,
      handoffId: HANDOFF_ID,
    });
    expect(reviews.verifyHandoffApprovalAuthorization).not.toHaveBeenCalled();
    expect(reviews.requireApprovedRevision).not.toHaveBeenCalled();
    expect(handoffs.revokeHandoff.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          userId: USER,
          id: HANDOFF_ID,
          revokedAt: NOW,
        },
      ],
    ]);
  });
});
