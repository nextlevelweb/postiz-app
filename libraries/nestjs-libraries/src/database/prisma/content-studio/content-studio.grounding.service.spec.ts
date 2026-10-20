import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import {
  ContentStudioGroundingError,
  ContentStudioGroundingService,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import {
  ContentPackageClaimEvidenceV2,
  contentPackageClaims,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  getReviewableClaimsFromContentPackageRevision,
  parseVerifiedContentPackageRevision,
} from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { parseContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { safeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';

// The real MediaService pulls in uploads, Redis and Temporal at import time
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
// the real sanitizer needs a DOM (it has its own specs): the serializer
// marks its input so the composer values can be compared
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: (text: string) => `<p>${text}</p>`,
}));
// the only way Content Studio reaches the network; grounding never may
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  safeFetch: jest.fn(),
  createSafeFetch: jest.fn(),
}));

// P3-11: the grounding of a package draft is checked against the exact source
// versions it names, in the request organization, whenever a draft with
// claims is saved and whenever a revision is made. No database: the package
// and source repositories are in-memory fakes; the grounding service, the
// package service and the parsers are the real ones

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const SOURCE_1 = 'e1111111-1111-4111-8111-111111111111';
const SOURCE_2 = 'e2111111-1111-4111-8111-111111111111';
const FOREIGN_SOURCE = 'e9111111-1111-4111-8111-111111111111';
const versionId = (source: string, n: number) =>
  `${source.slice(0, 2)}222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const SECRET_BLOCK = 'SOURCE_BLOCK_PRIVATE_TEXT';
const CLAIM_MARKER = 'CLAIM_PRIVATE_MARKER';
const PRIVATE = /PRIVATE|example\.com/;
const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface VersionRow {
  id: string;
  organizationId: string;
  sourceId: string;
  versionNumber: number;
  schemaVersion: number;
  content: string;
  contentHash: string;
  title: string | null;
  fetchedAt: Date;
  finalUrl: string;
}

const versionRow = (
  organizationId: string,
  sourceId: string,
  n: number,
  texts: string[] = [
    `Spring sales grew by ten percent. v${n}`,
    `${SECRET_BLOCK} v${n}`,
  ]
): VersionRow => ({
  id: versionId(sourceId, n),
  organizationId,
  sourceId,
  versionNumber: n,
  title: `Report v${n}`,
  fetchedAt: new Date('2026-10-10T10:00:00.000Z'),
  finalUrl: `https://example.com/report?token=PRIVATE_URL`,
  ...storedContentStudioSourceContent(
    parseContentStudioSourceContent({
      schemaVersion: 1,
      blocks: texts.map((text, index) => ({
        id: `b${index + 1}`,
        type: 'paragraph',
        text,
        level: null,
      })),
    })
  ),
});

const sourceStore = () => {
  const rows = new Map<string, VersionRow>();
  for (const row of [
    versionRow(ORG, SOURCE_1, 1),
    versionRow(ORG, SOURCE_1, 2),
    versionRow(ORG, SOURCE_2, 1),
    versionRow(OTHER_ORG, FOREIGN_SOURCE, 1),
  ]) {
    rows.set(row.id, row);
  }
  const repository = {
    getVersionsByIdsForOrganization: jest.fn(
      async (organizationId: string, ids: string[]) =>
        ids
          .map((id) => rows.get(id))
          .filter((row) => row && row.organizationId === organizationId)
          .map((row) => {
            const { organizationId: _org, ...rest } = row as VersionRow;
            return {
              ...rest,
              source: { name: `Source ${rest.sourceId.slice(0, 2)}` },
            };
          })
    ),
    // reads and writes that grounding must never use
    getSourceForOrganization: jest.fn(),
    getVersionDetailByNumber: jest.fn(),
    getVersionByNumber: jest.fn(),
    getVersionForSource: jest.fn(),
    listSourcesForOrganization: jest.fn(),
    listVersionsForSource: jest.fn(),
    appendVersionWithCompareAndSwap: jest.fn(),
    createSource: jest.fn(),
    updateSourceName: jest.fn(),
    archiveSource: jest.fn(),
    restoreSource: jest.fn(),
  };
  return { rows, repository };
};

const evidenceFor = (
  sourceId: string,
  n: number,
  overrides: Partial<ContentPackageClaimEvidenceV2> = {},
  organizationId = ORG
): ContentPackageClaimEvidenceV2 => ({
  sourceId,
  versionId: versionId(sourceId, n),
  versionNumber: n,
  contentHash: versionRow(organizationId, sourceId, n).contentHash,
  blockId: 'b1',
  quote: 'grew by ten percent',
  ...overrides,
});

const THREAD = [
  { id: 'main', text: 'Spring sales grew.', mediaIds: [] as string[] },
  { id: 'f1', text: 'Second post.', mediaIds: [] as string[] },
];
const claimOf = (
  id: string,
  threadItemId: string,
  evidence: ContentPackageClaimEvidenceV2[],
  text = `${CLAIM_MARKER} Sales grew by ten percent.`
) => ({ id, threadItemId, text, evidence });
const v2Draft = (claims: ReturnType<typeof claimOf>[], thread = THREAD) => ({
  schemaVersion: 2,
  copy: { global: { thread } },
  grounding: { claims },
});
const v1Draft = (thread = THREAD) => ({
  schemaVersion: 1,
  copy: { global: { thread } },
});

const setup = (stored: object = v1Draft()) => {
  const sources = sourceStore();
  const grounding = new ContentStudioGroundingService(
    sources.repository as unknown as ContentStudioSourceRepository
  );
  const state = {
    draft: JSON.stringify(stored),
    draftVersion: 4,
    latestRevisionNumber: 0,
    archivedAt: null as Date | null,
    revisions: [] as Array<{
      id: string;
      revisionNumber: number;
      schemaVersion: number;
      content: string;
      contentHash: string;
    }>,
  };
  const row = () => ({
    id: PACKAGE,
    projectId: null,
    name: 'Spring',
    draft: state.draft,
    draftVersion: state.draftVersion,
    latestRevisionNumber: state.latestRevisionNumber,
    archivedAt: state.archivedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const packages = {
    getPackageForOrganization: jest.fn(async (org: string, id: string) =>
      org === ORG && id === PACKAGE ? row() : null
    ),
    getPackageWriteStateForOrganization: jest.fn(
      async (org: string, id: string) =>
        org === ORG && id === PACKAGE
          ? { draftVersion: state.draftVersion, archivedAt: state.archivedAt }
          : null
    ),
    saveDraftCompareAndSwap: jest.fn(
      async (input: {
        organizationId: string;
        packageId: string;
        baseDraftVersion: number;
        draft: string;
      }) => {
        if (
          input.organizationId !== ORG ||
          input.packageId !== PACKAGE ||
          state.archivedAt ||
          input.baseDraftVersion !== state.draftVersion
        ) {
          return { count: 0 };
        }
        state.draft = input.draft;
        state.draftVersion += 1;
        return { count: 1 };
      }
    ),
    getLatestRevisionForPackage: jest.fn(async () => {
      const latest = state.revisions[state.revisions.length - 1];
      return latest
        ? {
            ...latest,
            packageId: PACKAGE,
            origin: 'manual',
            sourceDraftVersion: 1,
            createdAt: new Date(),
            createdBy: { id: USER, name: 'U' },
          }
        : null;
    }),
    createRevisionWithCompareAndSwap: jest.fn(
      async (input: {
        expectedDraftVersion: number;
        expectedLatestRevisionNumber: number;
        schemaVersion: number;
        content: string;
        contentHash: string;
        origin: string;
      }) => {
        if (
          input.expectedDraftVersion !== state.draftVersion ||
          input.expectedLatestRevisionNumber !== state.latestRevisionNumber
        ) {
          return { created: false, reason: 'compare-and-swap-failed' };
        }
        state.latestRevisionNumber += 1;
        const revision = {
          id: `revision-${state.latestRevisionNumber}`,
          revisionNumber: state.latestRevisionNumber,
          schemaVersion: input.schemaVersion,
          content: input.content,
          contentHash: input.contentHash,
        };
        state.revisions.push(revision);
        return {
          created: true,
          revision: {
            id: revision.id,
            packageId: PACKAGE,
            revisionNumber: revision.revisionNumber,
            schemaVersion: revision.schemaVersion,
            contentHash: revision.contentHash,
            origin: input.origin,
            sourceDraftVersion: input.expectedDraftVersion,
            createdAt: new Date(),
          },
        };
      }
    ),
  };
  const media = {
    getPreviewMap: jest.fn(async () => ({})),
    resolveForHandoff: jest.fn(async () => THREAD.map(() => [])),
  };
  const service = new ContentStudioService(
    packages as unknown as ContentStudioRepository,
    media as unknown as ContentStudioMediaService,
    grounding,
    // never reached: the draft and its grounding only
    {} as ContentStudioReviewService,
    {} as ContentStudioEditorialPolicyService
  );
  const save = (draft: unknown, baseDraftVersion = state.draftVersion) =>
    service.saveDraft({
      organizationId: ORG,
      packageId: PACKAGE,
      baseDraftVersion,
      draft,
    });
  const revise = () =>
    service.createRevision({
      organizationId: ORG,
      packageId: PACKAGE,
      userId: USER,
      draftVersion: state.draftVersion,
    });
  return { sources, grounding, state, packages, service, save, revise };
};

const refusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const response = (err as HttpException).getResponse() as {
    code: string;
    msg: string;
  };
  expect(
    [String(err), JSON.stringify(response), inspect(err)].join('\n')
  ).not.toMatch(PRIVATE);
  expect(JSON.stringify(response)).not.toMatch(UUID_ANYWHERE);
  return { status: (err as HttpException).getStatus(), ...response };
};
const GROUNDING_INVALID = {
  status: 400,
  code: 'CS_DRAFT_GROUNDING_INVALID',
  msg: 'The grounding evidence of this draft does not match its sources',
};
const groundingError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioGroundingError);
  expect(inspect(err)).not.toMatch(PRIVATE);
  expect(inspect(err)).not.toMatch(UUID_ANYWHERE);
  return (err as ContentStudioGroundingError).code;
};

describe('ContentStudioGroundingService evidence (P3-11)', () => {
  it('EV1 accepts evidence that is exactly in the version of this organization it names', async () => {
    const { grounding, sources } = setup();
    const resolved = await grounding.resolveEvidence(ORG, [
      evidenceFor(SOURCE_1, 2),
      evidenceFor(SOURCE_2, 1, { blockId: 'b2', quote: null }),
    ]);
    expect(resolved.map((entry) => [entry.version.id, entry.block.id])).toEqual(
      [
        [versionId(SOURCE_1, 2), 'b1'],
        [versionId(SOURCE_2, 1), 'b2'],
      ]
    );
    expect(resolved[0].block.text).toBe('Spring sales grew by ten percent. v2');
    // its source by id and name only (P5-03B shows it in the review)
    expect(resolved.map((entry) => entry.source)).toEqual([
      { id: SOURCE_1, name: 'Source e1' },
      { id: SOURCE_2, name: 'Source e2' },
    ]);
    expect(resolved[0].version).toEqual({
      id: versionId(SOURCE_1, 2),
      sourceId: SOURCE_1,
      versionNumber: 2,
      contentHash: evidenceFor(SOURCE_1, 2).contentHash,
      title: 'Report v2',
      fetchedAt: new Date('2026-10-10T10:00:00.000Z'),
    });
    // no URL or fetch provenance in what is answered
    expect(JSON.stringify(resolved)).not.toMatch(
      /https?:|finalUrl|PRIVATE_URL/
    );
    expect(
      sources.repository.getVersionsByIdsForOrganization
    ).toHaveBeenCalledWith(ORG, [
      versionId(SOURCE_1, 2),
      versionId(SOURCE_2, 1),
    ]);
  });

  it('EV8 two versions of one source cited together each resolve to exactly themselves', async () => {
    const { grounding } = setup();
    const resolved = await grounding.resolveEvidence(ORG, [
      evidenceFor(SOURCE_1, 1),
      evidenceFor(SOURCE_1, 2),
    ]);
    expect(
      resolved.map((entry) => [entry.version.versionNumber, entry.block.text])
    ).toEqual([
      [1, 'Spring sales grew by ten percent. v1'],
      [2, 'Spring sales grew by ten percent. v2'],
    ]);
  });

  it('reads each distinct version once, in one query, however often it is cited', async () => {
    const { grounding, sources } = setup();
    await grounding.resolveEvidence(ORG, [
      evidenceFor(SOURCE_1, 1),
      evidenceFor(SOURCE_1, 1, { blockId: 'b2', quote: null }),
      evidenceFor(SOURCE_1, 1, { quote: 'Spring' }),
    ]);
    expect(
      sources.repository.getVersionsByIdsForOrganization
    ).toHaveBeenCalledTimes(1);
    expect(
      sources.repository.getVersionsByIdsForOrganization
    ).toHaveBeenCalledWith(ORG, [versionId(SOURCE_1, 1)]);
  });

  it.each([
    [
      'EV2/GSEC1 a version of another organization',
      () => evidenceFor(FOREIGN_SOURCE, 1, {}, OTHER_ORG),
    ],
    [
      'EV3 the version under another source',
      () => evidenceFor(SOURCE_1, 1, { sourceId: SOURCE_2 }),
    ],
    [
      'EV3 a version id that does not exist',
      () =>
        evidenceFor(SOURCE_1, 1, {
          versionId: 'e1222222-2222-4222-8222-000000000099',
        }),
    ],
    [
      'EV4 another version number',
      () => evidenceFor(SOURCE_1, 1, { versionNumber: 2 }),
    ],
    [
      'EV5/GSEC3 another content hash',
      () => evidenceFor(SOURCE_1, 1, { contentHash: 'f'.repeat(64) }),
    ],
    [
      'EV5 the hash of another version of the same source',
      () =>
        evidenceFor(SOURCE_1, 1, {
          contentHash: evidenceFor(SOURCE_1, 2).contentHash,
        }),
    ],
    ['EV6 an unknown block', () => evidenceFor(SOURCE_1, 1, { blockId: 'b9' })],
    [
      'EV7 a quote the block does not hold',
      () => evidenceFor(SOURCE_1, 1, { quote: 'grew by twenty percent' }),
    ],
    [
      'EV7 a quote of another block',
      () => evidenceFor(SOURCE_1, 1, { blockId: 'b2', quote: 'Spring sales' }),
    ],
    [
      'EV8 version 1 named with the number of the latest version',
      () =>
        evidenceFor(SOURCE_1, 1, {
          versionNumber: 2,
          contentHash: evidenceFor(SOURCE_1, 2).contentHash,
        }),
    ],
  ])('refuses %s as INVALID', async (_label, make) => {
    const { grounding } = setup();
    expect(await groundingError(grounding.resolveEvidence(ORG, [make()]))).toBe(
      'INVALID'
    );
  });

  it('EV2/GSEC5 a foreign version reads exactly like a missing one', async () => {
    const { grounding } = setup();
    const foreign = await grounding
      .resolveEvidence(ORG, [evidenceFor(FOREIGN_SOURCE, 1, {}, OTHER_ORG)])
      .catch((err) => err);
    const missing = await grounding
      .resolveEvidence(ORG, [
        evidenceFor(SOURCE_1, 1, {
          versionId: 'e1222222-2222-4222-8222-000000000099',
        }),
      ])
      .catch((err) => err);
    expect(foreign).toBeInstanceOf(ContentStudioGroundingError);
    expect([foreign.code, foreign.message]).toEqual([
      missing.code,
      missing.message,
    ]);
  });

  it('EV8 never looks up the latest version: version 1 stays version 1 after version 2 exists', async () => {
    const { grounding, sources } = setup();
    const [resolved] = await grounding.resolveEvidence(ORG, [
      evidenceFor(SOURCE_1, 1),
    ]);
    expect(resolved.version.versionNumber).toBe(1);
    expect(resolved.block.text).toBe('Spring sales grew by ten percent. v1');
    expect(sources.repository.getVersionDetailByNumber).not.toHaveBeenCalled();
    expect(sources.repository.getSourceForOrganization).not.toHaveBeenCalled();
  });

  it('EV9 a corrupt stored version is INTEGRITY, never repaired or quoted', async () => {
    const { grounding, sources } = setup();
    const row = sources.rows.get(versionId(SOURCE_1, 1)) as VersionRow;
    row.content = row.content.replace('ten percent', 'PRIVATE eleven');
    expect(
      await groundingError(
        grounding.resolveEvidence(ORG, [evidenceFor(SOURCE_1, 1)])
      )
    ).toBe('INTEGRITY');
  });

  it('EV4 no network, no refresh and no source write', async () => {
    const { grounding, sources } = setup();
    await grounding.resolveEvidence(ORG, [evidenceFor(SOURCE_1, 1)]);
    expect(jest.mocked(safeFetch)).not.toHaveBeenCalled();
    for (const [name, fn] of Object.entries(sources.repository)) {
      if (name !== 'getVersionsByIdsForOrganization') {
        expect([name, (fn as jest.Mock).mock.calls]).toEqual([name, []]);
      }
    }
  });

  it('a draft without claims reads nothing', async () => {
    const { grounding, sources } = setup();
    await grounding.verifyDraftGrounding(
      ORG,
      parseContentPackageDraft(v1Draft())
    );
    await grounding.verifyDraftGrounding(
      ORG,
      parseContentPackageDraft(v2Draft([]))
    );
    expect(
      sources.repository.getVersionsByIdsForOrganization
    ).not.toHaveBeenCalled();
  });
});

describe('ContentStudioService.saveDraft with grounding (P3-11)', () => {
  const grounded = (evidence = evidenceFor(SOURCE_1, 1)) =>
    v2Draft([claimOf('c_claim0001', 'main', [evidence])]);

  it('V2-4/AP1 saves a v2 draft whose evidence is exact', async () => {
    const ctx = setup();
    expect(await ctx.save(grounded())).toEqual({ draftVersion: 5 });
    const stored = JSON.parse(ctx.state.draft);
    expect(stored.schemaVersion).toBe(2);
    expect(stored.grounding.claims).toEqual(grounded().grounding.claims);
  });

  it('GSEC1/GSEC5 evidence of another organization is the fixed 400, and nothing is written', async () => {
    const ctx = setup();
    expect(
      await refusal(
        ctx.save(grounded(evidenceFor(FOREIGN_SOURCE, 1, {}, OTHER_ORG)))
      )
    ).toEqual(GROUNDING_INVALID);
    expect(ctx.packages.saveDraftCompareAndSwap).not.toHaveBeenCalled();
    expect(ctx.state.draftVersion).toBe(4);
  });

  it.each([
    ['GSEC3 a made-up hash', { contentHash: 'c'.repeat(64) }],
    ['EV3 a version of another source', { sourceId: SOURCE_2 }],
    ['EV4 another number', { versionNumber: 2 }],
    ['EV6 a fake block', { blockId: 'b99' }],
    ['EV7 an altered quote', { quote: 'grew by ninety percent' }],
  ])('%s is refused before anything is written', async (_label, patch) => {
    const ctx = setup();
    expect(
      await refusal(ctx.save(grounded(evidenceFor(SOURCE_1, 1, patch))))
    ).toEqual(GROUNDING_INVALID);
    expect(ctx.packages.saveDraftCompareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['GSEC2 an organization id', { organizationId: ORG }],
    ['GSEC4 a source URL', { url: 'https://example.com/report' }],
  ])('%s on evidence is an invalid draft', async (_label, extra) => {
    const ctx = setup();
    const draft = grounded();
    Object.assign(draft.grounding.claims[0].evidence[0], extra);
    expect((await refusal(ctx.save(draft))).code).toBe('CS_DRAFT_INVALID');
    expect(ctx.packages.saveDraftCompareAndSwap).not.toHaveBeenCalled();
  });

  it('a corrupt source version is the fixed 500', async () => {
    const ctx = setup();
    const row = ctx.sources.rows.get(versionId(SOURCE_1, 1)) as VersionRow;
    row.contentHash = 'd'.repeat(64);
    expect(
      await refusal(
        ctx.save(
          grounded(evidenceFor(SOURCE_1, 1, { contentHash: 'd'.repeat(64) }))
        )
      )
    ).toEqual({
      status: 500,
      code: 'CS_GROUNDING_SOURCE_INTEGRITY_ERROR',
      msg: 'A source version used as evidence could not be verified',
    });
  });

  it('a v1 draft and a draft without claims are saved without reading the package or any source', async () => {
    const ctx = setup();
    await ctx.save(v1Draft());
    await ctx.save(v2Draft([]));
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
    expect(
      ctx.sources.repository.getVersionsByIdsForOrganization
    ).not.toHaveBeenCalled();
    expect(JSON.parse(ctx.state.draft).schemaVersion).toBe(2);
  });

  it('checks a draft with claims against exactly the saved base: a newer draft is the usual conflict, before any source is read', async () => {
    const ctx = setup();
    expect(await refusal(ctx.save(grounded(), 3))).toMatchObject({
      status: 409,
      code: 'CS_DRAFT_VERSION_CONFLICT',
    });
    expect(
      ctx.sources.repository.getVersionsByIdsForOrganization
    ).not.toHaveBeenCalled();
    ctx.state.archivedAt = new Date();
    expect((await refusal(ctx.save(grounded()))).code).toBe(
      'CS_PACKAGE_ARCHIVED'
    );
  });

  it('a draft with claims of a missing or foreign package is a 404', async () => {
    const ctx = setup();
    const refused = await refusal(
      ctx.service.saveDraft({
        organizationId: OTHER_ORG,
        packageId: PACKAGE,
        baseDraftVersion: 4,
        draft: grounded(),
      })
    );
    expect(refused.code).toBe('CS_NOT_FOUND');
  });

  it('AP5/AP7 a claim kept after its text changed is refused as stale; dropping or replacing it saves', async () => {
    const ctx = setup(grounded());
    const edited = grounded();
    edited.copy.global.thread = [
      { ...THREAD[0], text: 'Spring sales fell.' },
      THREAD[1],
    ];
    expect(await refusal(ctx.save(edited))).toEqual({
      status: 400,
      code: 'CS_DRAFT_GROUNDING_STALE',
      msg: 'A grounded claim no longer matches the text it was made for',
    });
    expect(ctx.packages.saveDraftCompareAndSwap).not.toHaveBeenCalled();
    // the edit with the claim removed
    expect(await ctx.save({ ...edited, grounding: { claims: [] } })).toEqual({
      draftVersion: 5,
    });
    // a new claim (a new id) for the new text
    const regrounded = {
      ...edited,
      grounding: {
        claims: [
          claimOf('c_claim0002', 'main', [
            evidenceFor(SOURCE_1, 2, { quote: null }),
          ]),
        ],
      },
    };
    expect(await ctx.save(regrounded)).toEqual({ draftVersion: 6 });
  });

  it('a claim moved to another item is stale', async () => {
    const ctx = setup(grounded());
    const moved = grounded();
    moved.grounding.claims[0].threadItemId = 'f1';
    expect((await refusal(ctx.save(moved))).code).toBe(
      'CS_DRAFT_GROUNDING_STALE'
    );
  });

  it('AP6 deleting an item with claims needs its claims gone: an orphan claim is an invalid draft', async () => {
    const ctx = setup(grounded());
    const orphan = grounded();
    orphan.copy.global.thread = [THREAD[1]];
    expect((await refusal(ctx.save(orphan))).code).toBe('CS_DRAFT_INVALID');
    expect(await ctx.save({ ...orphan, grounding: { claims: [] } })).toEqual({
      draftVersion: 5,
    });
  });

  it('a claim may be reworded or get other evidence while its text stays', async () => {
    const ctx = setup(grounded());
    const next = grounded(evidenceFor(SOURCE_2, 1, { quote: 'Spring' }));
    next.grounding.claims[0].text = 'Reworded claim.';
    expect(await ctx.save(next)).toEqual({ draftVersion: 5 });
  });

  it('never echoes claim, quote or source text, a URL or an id in an error', async () => {
    const ctx = setup();
    for (const draft of [
      grounded(evidenceFor(SOURCE_1, 1, { quote: 'PRIVATE quote' })),
      grounded(evidenceFor(FOREIGN_SOURCE, 1, {}, OTHER_ORG)),
    ]) {
      await refusal(ctx.save(draft));
    }
  });
});

describe('ContentStudioService.createRevision with grounding (P3-11)', () => {
  const grounded = () =>
    v2Draft([claimOf('c_claim0001', 'main', [evidenceFor(SOURCE_1, 1)])]);

  it('IR1/IR2 a v2 revision stores the claims exactly, under schema version 2 and the hash of that content', async () => {
    const ctx = setup(grounded());
    const result = await ctx.revise();
    expect(result.created).toBe(true);
    const [revision] = ctx.state.revisions;
    expect(revision.schemaVersion).toBe(2);
    expect(revision.content).toBe(
      canonicalJson(parseContentPackageDraft(grounded()))
    );
    expect(revision.contentHash).toBe(sha256Hex(revision.content));
    expect(getReviewableClaimsFromContentPackageRevision(revision)).toEqual(
      grounded().grounding.claims
    );
  });

  it('IR2 only claims changed: a new revision with another hash', async () => {
    const ctx = setup(grounded());
    await ctx.revise();
    const reworded = grounded();
    reworded.grounding.claims[0].text = 'Reworded.';
    await ctx.save(reworded);
    const second = await ctx.revise();
    expect(second.created).toBe(true);
    expect(ctx.state.revisions[1].contentHash).not.toBe(
      ctx.state.revisions[0].contentHash
    );
  });

  it('IR3 a newer revision never changes an older one', async () => {
    const ctx = setup(grounded());
    await ctx.revise();
    const first = { ...ctx.state.revisions[0] };
    await ctx.save({ ...grounded(), grounding: { claims: [] } });
    await ctx.revise();
    expect(ctx.state.revisions[0]).toEqual(first);
    expect(
      getReviewableClaimsFromContentPackageRevision(ctx.state.revisions[0])
    ).toHaveLength(1);
    expect(
      getReviewableClaimsFromContentPackageRevision(ctx.state.revisions[1])
    ).toEqual([]);
  });

  it('M21 checks the evidence again when the revision is made: a version that changed since the save stops it', async () => {
    const ctx = setup(grounded());
    const row = ctx.sources.rows.get(versionId(SOURCE_1, 1)) as VersionRow;
    row.content = row.content.replace('ten', 'nine');
    expect((await refusal(ctx.revise())).code).toBe(
      'CS_GROUNDING_SOURCE_INTEGRITY_ERROR'
    );
    expect(
      ctx.packages.createRevisionWithCompareAndSwap
    ).not.toHaveBeenCalled();
    // evidence that no longer resolves in this organization
    ctx.sources.rows.delete(versionId(SOURCE_1, 1));
    expect(await refusal(ctx.revise())).toEqual(GROUNDING_INVALID);
    expect(
      ctx.packages.createRevisionWithCompareAndSwap
    ).not.toHaveBeenCalled();
  });

  it('V2-5/IR5 a v1 draft still makes a v1 revision with the v1 hash, and reads no source', async () => {
    const ctx = setup(v1Draft());
    await ctx.revise();
    const [revision] = ctx.state.revisions;
    expect(revision.schemaVersion).toBe(1);
    expect(revision.content).toBe(canonicalJson(v1Draft()));
    expect(revision.contentHash).toBe(sha256Hex(canonicalJson(v1Draft())));
    expect(
      ctx.sources.repository.getVersionsByIdsForOrganization
    ).not.toHaveBeenCalled();
    // and a later grounded revision sits next to it
    await ctx.save(grounded());
    await ctx.revise();
    expect(
      ctx.state.revisions.map(
        (entry) => parseVerifiedContentPackageRevision(entry).schemaVersion
      )
    ).toEqual([1, 2]);
  });

  it('a revision of a v2 draft reads as exactly that draft', async () => {
    const ctx = setup(grounded());
    await ctx.revise();
    expect(parseVerifiedContentPackageRevision(ctx.state.revisions[0])).toEqual(
      parseContentPackageDraft(grounded())
    );
  });
});

describe('handoff of a grounded revision (P3-11)', () => {
  const handoff = (content: object) => {
    const text = canonicalJson(content);
    const repository = {
      getRevisionForPackage: jest.fn(async () => ({
        id: 'revision-1',
        packageId: PACKAGE,
        revisionNumber: 1,
        schemaVersion: (content as { schemaVersion: number }).schemaVersion,
        content: text,
        contentHash: sha256Hex(text),
        origin: 'handoff',
        sourceDraftVersion: 1,
        createdAt: new Date(),
        createdBy: { id: USER, name: 'U' },
      })),
    };
    const handoffs = {
      getHandoffForOrganizationAndUser: jest.fn(async () => ({
        id: 'a'.repeat(64),
        packageId: PACKAGE,
        packageRevisionId: 'revision-1',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        // made before P5-08 recorded what authorized it
        approvalRequiredAtCreation: null,
        approvalReviewId: null,
        approvalSequence: null,
        approvalContentHash: null,
      })),
      markOpenedIfNeeded: jest.fn(async () => ({ count: 1 })),
    };
    const media = {
      resolveForHandoff: jest.fn(async () => THREAD.map(() => [])),
    };
    return new ContentStudioHandoffService(
      repository as unknown as ContentStudioRepository,
      handoffs as unknown as ContentStudioHandoffRepository,
      media as unknown as ContentStudioMediaService,
      // opening a handoff never reads the policy or the approval of now;
      // what authorized it (P5-08) is the review service's to check
      {} as ContentStudioEditorialPolicyService,
      {
        verifyHandoffApprovalAuthorization: async () => undefined,
      } as unknown as ContentStudioReviewService
    ).resolveHandoff({
      organizationId: ORG,
      userId: USER,
      handoffId: 'a'.repeat(64),
    });
  };

  it('V2-6 the composer gets exactly the same values for the same copy in v1 and v2: grounding never reaches a post', async () => {
    const v1 = await handoff(v1Draft());
    const v2 = await handoff(
      parseContentPackageDraft(
        v2Draft([claimOf('c_claim0001', 'main', [evidenceFor(SOURCE_1, 1)])])
      )
    );
    expect(v2.onlyValues).toEqual(v1.onlyValues);
    expect(JSON.stringify(v2)).not.toMatch(
      /CLAIM_PRIVATE|grounding|claims|evidence|grew by ten/
    );
  });
});

describe('P3-11 boundaries', () => {
  const read = (...parts: string[]) =>
    fs.readFileSync(path.join(__dirname, ...parts), 'utf8');
  const root = path.join(__dirname, '..', '..', '..', '..', '..', '..');
  const schema = read('..', 'schema.prisma');

  it('P311-1/P311-2/P311-3 no claim or evidence model in the database: claims live in revisions; the one claim-review model (P5-03B) holds assessments only, and the approval decisions (P5-04) no claim', () => {
    const models = schema.match(/^model \w+/gm) ?? [];
    expect(
      models.filter((model) => /Claim|Evidence|Grounding|Approval/.test(model))
    ).toEqual([
      'model ContentStudioReviewClaim',
      'model ContentStudioApproval',
    ]);
    const decision = schema.slice(
      schema.indexOf('model ContentStudioApproval {'),
      schema.indexOf('\n}', schema.indexOf('model ContentStudioApproval {'))
    );
    expect(decision).not.toMatch(/claim|evidence|quote|source|grounding|Json/i);
    const assessment = schema.slice(
      schema.indexOf('model ContentStudioReviewClaim {'),
      schema.indexOf('\n}', schema.indexOf('model ContentStudioReviewClaim {'))
    );
    expect(assessment).not.toMatch(
      /text|evidence|quote|source|threadItem|Json/i
    );
    const rest = schema.replace(assessment, '');
    expect(rest).not.toMatch(
      /^\s+(claims?|claimId|evidence\w*|grounding\w*|approvedBy\w*|approvedAt)\s+(?!\s|ContentStudioReviewClaim\[\])/m
    );
  });

  it('P311-4/P311-5 grounding gates no handoff and reaches no network, ingestion or extraction', () => {
    const text = read('content-studio.grounding.service.ts');
    expect(text).not.toMatch(
      /safeFetch|SafeFetch|fetch\(|SourceIngestion|ingestion\.|extractContentStudio|refreshSource|appendVersion|Handoff|Review/
    );
    const handoffService = read('content-studio.handoff.service.ts');
    expect(handoffService).not.toMatch(/grounding|Grounding|claims/);
  });

  it('P311-6 no NLP or AI claim extraction: claims are never derived from text', () => {
    for (const file of [
      'content-studio.grounding.service.ts',
      'content-studio.service.ts',
    ]) {
      const text = read(file);
      expect(text).not.toMatch(
        /split\(\s*\/[^/]*[.!?]|sentence|nlp|tokeni[sz]e|extractClaims|detectClaims|AIExecution|generateText/i
      );
    }
    const draft = fs.readFileSync(
      path.join(
        root,
        'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts'
      ),
      'utf8'
    );
    expect(draft).not.toMatch(/sentence|extractClaims|detectClaims/i);
  });

  it('P311-7 no AI operation as revision truth: package, grounding and revision code never read operations', () => {
    for (const text of [
      read('content-studio.grounding.service.ts'),
      read('content-studio.service.ts'),
      read('content-studio.repository.ts'),
    ]) {
      expect(text).not.toMatch(
        /aIOperation|AIOperation|aiOperation|contentStudioAIOperation/
      );
    }
  });

  it('P311-8 evidence names a version and a block, never a URL', () => {
    const draft = fs.readFileSync(
      path.join(
        root,
        'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts'
      ),
      'utf8'
    );
    const evidence = draft.slice(
      draft.indexOf('const evidenceSchema'),
      draft.indexOf('const claimSchema')
    );
    expect(evidence).not.toMatch(/url|Url|href|link/);
    expect(evidence.match(/^\s{4}(\w+):/gm)?.map((key) => key.trim())).toEqual([
      'sourceId:',
      'versionId:',
      'versionNumber:',
      'contentHash:',
      'blockId:',
      'quote:',
    ]);
  });

  it('P311-9/P311-10 v1 stays readable and nothing rewrites a stored revision', () => {
    const repository = read('content-studio.repository.ts');
    expect(repository).not.toMatch(
      /contentPackageRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    const service = read('content-studio.service.ts');
    expect(service).not.toMatch(/upgradeContentPackageDraftToV2/);
  });

  it('P311-11 the Design Document is still schema version 1', () => {
    const design = fs.readFileSync(
      path.join(
        root,
        'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      ),
      'utf8'
    );
    expect(design).toMatch(/export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;/);
    expect(design).not.toMatch(/claim|grounding|evidence/i);
  });

  it('P311-12 no new dependency', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    );
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      names.filter((name) =>
        /nlp|natural|compromise|wink|claim|fact/i.test(name)
      )
    ).toEqual([]);
  });

  it('the review reads claims only through the revision helper and evidence only through this service (P5-03B)', () => {
    const review = read('content-studio.review.service.ts');
    expect(review).toContain('getReviewableClaimsFromContentPackageRevision(');
    expect(review).toContain('_contentStudioGroundingService.resolveEvidence(');
    expect(review).not.toMatch(
      /contentPackageClaims\(|withContentPackageClaim|replaceContentPackageItemClaims|verifyDraftGrounding|getVersionsByIdsForOrganization/
    );
  });

  it('claims of a stored draft are only ever read through the parser', () => {
    expect(contentPackageClaims(parseContentPackageDraft(v1Draft()))).toEqual(
      []
    );
  });
});
