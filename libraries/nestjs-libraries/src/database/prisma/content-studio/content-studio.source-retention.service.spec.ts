import { HttpException } from '@nestjs/common';
import { ContentStudioSourceRetentionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionProtectionMap,
  ContentStudioSourceVersionQuarantineError,
  ContentStudioSourceVersionRetentionExecutionError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// Source version protection (P8-R1A), as the service reads it: every kind
// of stored record of one organization, in bounded pages, parsed with the
// parsers that wrote it, checked and handed to source.retention.ts. No
// database: the snapshot reads of the retention repository are in-memory
// fakes that read like Prisma (organization, id order, after an id, a page
// size; versions by a batch of sources) and count their reads. The
// PostgreSQL suite runs the same against real rows

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'b0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const X2 = 'content-studio-source-v2';
const uuid = (group: number, n: number) =>
  `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${n
    .toString(16)
    .padStart(12, '0')}`;

type Row = { id: string; organizationId: string } & Record<string, unknown>;
interface World {
  sources: Row[];
  versions: Row[];
  packages: Row[];
  revisions: Row[];
  reviews: Row[];
  operations: Row[];
}
const world = (): World => ({
  sources: [],
  versions: [],
  packages: [],
  revisions: [],
  reviews: [],
  operations: [],
});

interface Version {
  id: string;
  organizationId: string;
  sourceId: string;
  versionNumber: number;
  contentHash: string;
}

// a page source with one version per text, oldest first, made long ago
let sourceCount = 0;
const addPage = (
  w: World,
  texts: string[],
  organizationId = ORG,
  over: Record<string, unknown> = {}
) => {
  sourceCount += 1;
  const sourceId = uuid(0x5000, sourceCount);
  const versions = texts.map((text, i) => {
    const row = {
      id: uuid(0x7000 + sourceCount, i + 1),
      organizationId,
      sourceId,
      versionNumber: i + 1,
      contentHash: sha256Hex(text),
      title: 'T',
      extractionVersion: X2,
      fetchedAt: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 60_000),
      createdAt: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 60_000),
      // never read by protection: a fake that leaked it would show
      content: 'SOURCE_PRIVATE_BLOCKS',
    };
    w.versions.push(row);
    return row;
  });
  w.sources.push({
    id: sourceId,
    organizationId,
    kind: 'url',
    latestVersionNumber: texts.length,
    lastPageChangeAt: null,
    lastPageChangeVersionNumber: null,
    lastPageChangeKind: null,
    lastPageChangePreviousCaptureAt: null,
    archivedAt: null,
    ...over,
  });
  return versions;
};

const evidence = (v: Version, blockId = 'b1') => ({
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
  blockId,
  quote: null,
});
const THREAD = { global: { thread: [{ id: 'i1', text: 'x', mediaIds: [] }] } };
// a v2 draft: one claim per list of evidence
const grounded = (claims: ReturnType<typeof evidence>[][]) => ({
  schemaVersion: 2,
  copy: THREAD,
  grounding: {
    claims: claims.map((list, i) => ({
      id: `c_claim${i}_secret`,
      threadItemId: 'i1',
      text: 'CLAIM_PRIVATE_TEXT',
      evidence: list,
    })),
  },
});
const ungrounded = { schemaVersion: 1, copy: THREAD };

const addPackage = (
  w: World,
  id: string,
  draft: unknown,
  organizationId = ORG,
  archivedAt: Date | null = null
) =>
  w.packages.push({
    id,
    organizationId,
    draft: typeof draft === 'string' ? draft : JSON.stringify(draft),
    archivedAt,
  });
// a revision exactly as revisions are stored: canonical, hashed
const addRevision = (
  w: World,
  id: string,
  packageId: string,
  draft: unknown,
  organizationId = ORG
) => {
  const content = canonicalJson(parseContentPackageDraft(draft));
  w.revisions.push({
    id,
    organizationId,
    packageId,
    schemaVersion: (draft as { schemaVersion: number }).schemaVersion,
    content,
    contentHash: sha256Hex(content),
  });
};
const addReview = (
  w: World,
  id: string,
  packageRevisionId: string | null,
  organizationId = ORG,
  state = 'APPROVED'
) =>
  w.reviews.push({
    id,
    organizationId,
    packageRevisionId,
    designRevisionId: packageRevisionId ? null : uuid(0xdddd, 1),
    state,
  });
const sourceRef = (v: Version) => ({
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
});
const addOperation = (
  w: World,
  id: string,
  context: unknown,
  status = 'succeeded',
  organizationId = ORG
) => w.operations.push({ id, organizationId, status, context });

const SELECTS = {
  sources: [
    'id',
    'organizationId',
    'kind',
    'latestVersionNumber',
    'lastPageChangeAt',
    'lastPageChangeVersionNumber',
    'lastPageChangeKind',
    'lastPageChangePreviousCaptureAt',
  ],
  versions: [
    'id',
    'organizationId',
    'sourceId',
    'versionNumber',
    'contentHash',
    'title',
    'extractionVersion',
    'fetchedAt',
    'createdAt',
  ],
  packages: ['id', 'organizationId', 'draft'],
  revisions: [
    'id',
    'organizationId',
    'packageId',
    'schemaVersion',
    'content',
    'contentHash',
  ],
  reviews: ['id', 'organizationId', 'packageRevisionId'],
  operations: ['id', 'organizationId', 'context'],
} as const;

// One fake read: this organization's rows (or, for a test, anything a broken
// query would return), in id order, after an id, at most a page; versions
// by a batch of sources, by source and number
type FakeOptions = {
  leak?: keyof World;
  reads?: string[];
  // what the count says, whatever the rows are
  count?: number;
  // the snapshot itself fails
  fail?: Error;
  // versions gone before they are measured
  missing?: string[];
  // organizations with a version held for a retention plan (P8-R1Q)
  pending?: string[];
  // the held versions of the organization, with their plan (P8-R1C)
  held?: Array<{ sourceVersionId: string; planHash: string }>;
};
const fakeRetentionRepository = (w: World, options: FakeOptions = {}) => {
  const reads = options.reads ?? [];
  const ours = (kind: keyof World, organizationId: string) => (row: Row) =>
    options.leak === kind || row.organizationId === organizationId;
  const pick = (kind: keyof World) => (row: Row) =>
    Object.fromEntries(SELECTS[kind].map((key) => [key, row[key]]));
  const read =
    (kind: keyof World, filter: (row: Row) => boolean = () => true) =>
    async (input: {
      organizationId: string;
      afterId: string | null;
      take: number;
    }) => {
      reads.push(kind);
      expect(Number.isInteger(input.take) && input.take > 0).toBe(true);
      return w[kind]
        .filter(
          (row) =>
            ours(kind, input.organizationId)(row) &&
            filter(row) &&
            (!input.afterId || row.id > input.afterId)
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, input.take)
        .map(pick(kind));
    };
  return {
    readSnapshot: async (work: (snapshot: unknown) => Promise<unknown>) => {
      reads.push('snapshot');
      if (options.fail) {
        throw options.fail;
      }
      const result = await work({
        findPending: async (organizationId: string) => {
          reads.push('pending');
          return (options.pending ?? []).includes(organizationId)
            ? { id: 'pending' }
            : null;
        },
        listPending: async () => {
          reads.push('held');
          return options.held ?? [];
        },
        countVersions: async (organizationId: string) => {
          reads.push('count');
          return (
            options.count ??
            w.versions.filter(ours('versions', organizationId)).length
          );
        },
        listSources: read('sources'),
        listPackageDrafts: read('packages'),
        listPackageReviews: read(
          'reviews',
          (row) => row.packageRevisionId !== null
        ),
        listPackageRevisions: read('revisions'),
        listOperationContexts: read('operations'),
        listVersionsOfSources: async (input: {
          organizationId: string;
          sourceIds: string[];
        }) => {
          reads.push('versions');
          expect(input.sourceIds.length).toBeGreaterThan(0);
          expect(input.sourceIds.length).toBeLessThanOrEqual(200);
          return w.versions
            .filter(
              (row) =>
                ours('versions', input.organizationId)(row) &&
                input.sourceIds.includes(row.sourceId as string)
            )
            .sort((a, b) =>
              a.sourceId !== b.sourceId
                ? (a.sourceId as string) < (b.sourceId as string)
                  ? -1
                  : 1
                : (a.versionNumber as number) - (b.versionNumber as number)
            )
            .map(pick('versions'));
        },
        findVersionOfOtherOrganizationSource: async (
          organizationId: string
        ) => {
          reads.push('orphan');
          const found = w.versions
            .filter(
              (row) =>
                row.organizationId === organizationId &&
                w.sources.find((source) => source.id === row.sourceId)
                  ?.organizationId !== organizationId
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
          return found ? { id: found.id } : null;
        },
      });
      reads.push('commit');
      return result;
    },
    listVersionContents: async (input: {
      organizationId: string;
      ids: string[];
    }) => {
      reads.push('contents');
      expect(input.ids.length).toBeGreaterThan(0);
      expect(input.ids.length).toBeLessThanOrEqual(500);
      return w.versions
        .filter(
          (row) =>
            row.organizationId === input.organizationId &&
            input.ids.includes(row.id) &&
            !(options.missing ?? []).includes(row.id)
        )
        .map((row) => ({ id: row.id, content: row.content as string }));
    },
  };
};

const service = (w: World, options: FakeOptions = {}) =>
  new ContentStudioSourceRetentionService(
    fakeRetentionRepository(
      w,
      options
    ) as unknown as ContentStudioSourceRetentionRepository
  );

const compute = (w: World, options?: Parameters<typeof service>[1]) =>
  service(w, options).computeProtectionMap({ organizationId: ORG, now: NOW });
const reasons = (map: ContentStudioSourceVersionProtectionMap, v: Version) =>
  (map.get(v.id) ?? [])
    .filter((p) => p.reason !== 'IN_FLIGHT' && p.reason !== 'LATEST')
    .map((p) => `${p.reason}:${p.referenceId}`);
const failure = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => {
      throw new Error('expected an integrity error');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
  // never the draft, a claim, a quote, blocks or the context
  expect(
    JSON.stringify({ ...(err as object), message: (err as Error).message })
  ).not.toMatch(/PRIVATE|secret|schemaVersion|grounding/);
  return (err as ContentStudioSourceRetentionIntegrityError).reference;
};

const PACKAGE = uuid(0x9001, 1);
const PACKAGE_2 = uuid(0x9001, 2);
const REVISION = uuid(0x9002, 1);
const REVISION_2 = uuid(0x9002, 2);
const REVIEW = uuid(0x9003, 1);
const OPERATION = uuid(0x9004, 1);

describe('P8-R1A draft evidence', () => {
  it('D1 a v1 draft names no version', async () => {
    const w = world();
    const [v1] = addPage(w, Array(25).fill('A'));
    addPackage(w, PACKAGE, ungrounded);
    expect(reasons(await compute(w), v1)).toEqual([]);
  });

  it('D2/D3 every version a v2 draft names, once per package however often it is named', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addPackage(
      w,
      PACKAGE,
      grounded([
        [evidence(versions[0]), evidence(versions[0], 'b2')],
        [evidence(versions[0]), evidence(versions[1])],
      ])
    );
    const map = await compute(w);
    expect(reasons(map, versions[0])).toEqual([`DRAFT_EVIDENCE:${PACKAGE}`]);
    expect(reasons(map, versions[1])).toEqual([`DRAFT_EVIDENCE:${PACKAGE}`]);
    expect(reasons(map, versions[2])).toEqual([]);
  });

  it('D4 a draft naming a version that is not there fails the organization', async () => {
    const w = world();
    const versions = addPage(w, ['A', 'A']);
    addPackage(
      w,
      PACKAGE,
      grounded([[{ ...evidence(versions[0]), versionId: uuid(0x7999, 1) }]])
    );
    expect(await failure(compute(w))).toEqual({
      type: 'ContentPackage',
      id: PACKAGE,
    });
  });

  it('D5/D6/D7 another source, number or hash than the version has fails', async () => {
    for (const broken of [
      { sourceId: uuid(0x5999, 1) },
      { versionNumber: 2 },
      { contentHash: sha256Hex('B') },
    ]) {
      const w = world();
      const versions = addPage(w, ['A', 'A']);
      addPackage(
        w,
        PACKAGE,
        grounded([[{ ...evidence(versions[0]), ...broken }]])
      );
      expect(await failure(compute(w))).toEqual({
        type: 'ContentPackage',
        id: PACKAGE,
      });
    }
  });

  it('D8 an archived package still protects its draft evidence', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addPackage(
      w,
      PACKAGE,
      grounded([[evidence(versions[0])]]),
      ORG,
      new Date('2026-03-01')
    );
    expect(reasons(await compute(w), versions[0])).toEqual([
      `DRAFT_EVIDENCE:${PACKAGE}`,
    ]);
  });

  it('D9 a draft that does not parse fails, and nothing of it is in the error', async () => {
    for (const draft of [
      'not json SOURCE_PRIVATE',
      '{"schemaVersion":2,"grounding":"secret"}',
      JSON.stringify({ ...ungrounded, extra: 'PRIVATE' }),
    ]) {
      const w = world();
      addPage(w, ['A']);
      addPackage(w, PACKAGE, draft);
      expect(await failure(compute(w))).toEqual({
        type: 'ContentPackage',
        id: PACKAGE,
      });
    }
  });
});

describe('P8-R1A revision evidence', () => {
  it('R1/R2/R4/R5 every revision of every package, archived too: each names its own versions', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addPackage(w, PACKAGE, ungrounded, ORG, new Date('2026-03-01'));
    addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[0])]]));
    addRevision(
      w,
      REVISION_2,
      PACKAGE,
      grounded([[evidence(versions[0]), evidence(versions[1])]])
    );
    const map = await compute(w);
    expect(reasons(map, versions[0])).toEqual([
      `REVISION_EVIDENCE:${REVISION}`,
      `REVISION_EVIDENCE:${REVISION_2}`,
    ]);
    expect(reasons(map, versions[1])).toEqual([
      `REVISION_EVIDENCE:${REVISION_2}`,
    ]);
  });

  it('R3 a version named by several claims of one revision is one protection', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(
      w,
      REVISION,
      PACKAGE,
      grounded([
        [evidence(versions[0])],
        [evidence(versions[0], 'b2')],
        [evidence(versions[0], 'b3')],
      ])
    );
    expect(
      (await compute(w))
        .get(versions[0].id)!
        .filter((p) => p.reason === 'REVISION_EVIDENCE')
    ).toHaveLength(1);
  });

  it('R6 a revision that is not exactly what was stored fails', async () => {
    for (const corrupt of [
      (row: Row) => ({ ...row, content: `${row.content} ` }),
      (row: Row) => ({ ...row, contentHash: sha256Hex('other') }),
      (row: Row) => ({ ...row, schemaVersion: 1 }),
      (row: Row) => ({ ...row, content: 'PRIVATE' }),
    ]) {
      const w = world();
      const versions = addPage(w, ['A']);
      addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[0])]]));
      w.revisions[0] = corrupt(w.revisions[0]);
      expect(await failure(compute(w))).toEqual({
        type: 'ContentPackageRevision',
        id: REVISION,
      });
    }
  });

  it('R7 a revision naming a version that is not exactly there fails', async () => {
    const w = world();
    const versions = addPage(w, ['A', 'A']);
    addRevision(
      w,
      REVISION,
      PACKAGE,
      grounded([[{ ...evidence(versions[0]), versionNumber: 2 }]])
    );
    expect(await failure(compute(w))).toEqual({
      type: 'ContentPackageRevision',
      id: REVISION,
    });
  });
});

describe('P8-R1A review evidence', () => {
  it('RV1/RV2/RV4 a review of a revision protects its versions too, beside the revision, whatever its state', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[0])]]));
    addRevision(w, REVISION_2, PACKAGE, grounded([[evidence(versions[1])]]));
    addReview(w, REVIEW, REVISION, ORG, 'APPROVED');
    addReview(w, uuid(0x9003, 2), REVISION_2, ORG, 'CHANGES_REQUESTED');
    const map = await compute(w);
    expect(reasons(map, versions[0])).toEqual([
      `REVISION_EVIDENCE:${REVISION}`,
      `REVIEW_EVIDENCE:${REVIEW}`,
    ]);
    expect(reasons(map, versions[1])).toEqual([
      `REVISION_EVIDENCE:${REVISION_2}`,
      `REVIEW_EVIDENCE:${uuid(0x9003, 2)}`,
    ]);
  });

  it('RV3 a review of an ungrounded revision, or of a design, protects nothing', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(w, REVISION, PACKAGE, ungrounded);
    addReview(w, REVIEW, REVISION);
    addReview(w, uuid(0x9003, 2), null);
    const map = await compute(w);
    expect(versions.map((v) => reasons(map, v)).flat()).toEqual([]);
  });

  it("RV5 a review whose revision is not this organization's fails; reviews are read for this organization only", async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(
      w,
      REVISION,
      PACKAGE,
      grounded([[evidence(versions[0])]]),
      OTHER_ORG
    );
    addReview(w, REVIEW, REVISION);
    expect(await failure(compute(w))).toEqual({
      type: 'ContentStudioReview',
      id: REVIEW,
    });
    // another organization's review is never read
    const other = world();
    const mine = addPage(other, Array(25).fill('A'));
    addRevision(other, REVISION, PACKAGE, grounded([[evidence(mine[0])]]));
    addReview(other, REVIEW, REVISION, OTHER_ORG);
    expect(reasons(await compute(other), mine[0])).toEqual([
      `REVISION_EVIDENCE:${REVISION}`,
    ]);
  });

  it('RV6 each revision is parsed once, however many reviews: its evidence is reused', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[0])]]));
    addReview(w, REVIEW, REVISION);
    const parse = jest.spyOn(JSON, 'parse');
    await compute(w);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('P8-R1A AI operations', () => {
  const context = (...versions: Version[]) => ({
    v: 1,
    itemId: 'i1',
    sources: versions.map(sourceRef),
  });

  it('A1/A2/A3 the sources of every operation, succeeded, failed or running', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    const second = addPage(w, Array(25).fill('A'));
    addOperation(w, uuid(0x9004, 1), context(versions[0]), 'succeeded');
    addOperation(w, uuid(0x9004, 2), context(versions[1]), 'failed');
    // one version of each of two sources, as a prompt holds them
    addOperation(
      w,
      uuid(0x9004, 3),
      context(versions[2], second[0]),
      'running'
    );
    const map = await compute(w);
    expect(
      [...versions.slice(0, 3), second[0]].map((v) => reasons(map, v))
    ).toEqual([
      [`AI_OPERATION:${uuid(0x9004, 1)}`],
      [`AI_OPERATION:${uuid(0x9004, 2)}`],
      [`AI_OPERATION:${uuid(0x9004, 3)}`],
      [`AI_OPERATION:${uuid(0x9004, 3)}`],
    ]);
    expect(reasons(map, versions[3])).toEqual([]);
  });

  it('A4 an operation without sources (a design operation) protects nothing', async () => {
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addOperation(w, OPERATION, {
      v: 1,
      design: {
        designId: uuid(0xd001, 1),
        revisionId: uuid(0xd002, 1),
        revisionNumber: 1,
        contentHash: sha256Hex('design'),
      },
    });
    addOperation(w, uuid(0x9004, 2), { v: 1, itemId: 'i1' });
    const map = await compute(w);
    expect(versions.map((v) => reasons(map, v)).flat()).toEqual([]);
  });

  it('A5/A6/A7 a source that is not exactly a version of this organization fails', async () => {
    for (const broken of ['missing', 'hash', 'other']) {
      const w = world();
      const versions = addPage(w, ['A', 'A']);
      const foreign = addPage(w, ['A'], OTHER_ORG)[0];
      const named =
        broken === 'missing'
          ? { ...sourceRef(versions[0]), versionId: uuid(0x7999, 1) }
          : broken === 'hash'
          ? { ...sourceRef(versions[0]), contentHash: sha256Hex('B') }
          : sourceRef(foreign);
      addOperation(w, OPERATION, { v: 1, sources: [named] });
      expect(await failure(compute(w))).toEqual({
        type: 'ContentStudioAIOperation',
        id: OPERATION,
      });
    }
  });

  it('A8 a context that is not a v1 context fails', async () => {
    for (const bad of [
      null,
      'PRIVATE',
      { v: 2, sources: [] },
      { v: 1, sources: [], prompt: 'PRIVATE' },
    ]) {
      const w = world();
      addPage(w, ['A']);
      addOperation(w, OPERATION, bad);
      expect(await failure(compute(w))).toEqual({
        type: 'ContentStudioAIOperation',
        id: OPERATION,
      });
    }
  });
});

describe('P8-R1A the organization', () => {
  it('ORG a row of another organization a read returns fails, whichever read it is', async () => {
    for (const kind of [
      'sources',
      'versions',
      'packages',
      'revisions',
      'reviews',
      'operations',
    ] as const) {
      const w = world();
      const mine = addPage(w, Array(3).fill('A'));
      const theirs = addPage(w, Array(3).fill('A'), OTHER_ORG);
      // P8-R1B: versions are read by source, so a broken version read
      // shows as another organization's version of one of ours
      w.versions.push({
        ...w.versions.find((row) => row.id === theirs[0].id)!,
        id: uuid(0x7998, 1),
        sourceId: mine[0].sourceId,
        versionNumber: 99,
      });
      addPackage(w, PACKAGE_2, grounded([[evidence(theirs[0])]]), OTHER_ORG);
      addRevision(
        w,
        REVISION_2,
        PACKAGE_2,
        grounded([[evidence(theirs[0])]]),
        OTHER_ORG
      );
      addReview(w, REVIEW, REVISION_2, OTHER_ORG);
      addOperation(
        w,
        OPERATION,
        { v: 1, sources: [sourceRef(theirs[0])] },
        'succeeded',
        OTHER_ORG
      );
      expect((await compute(w)).has(theirs[0].id)).toBe(false);
      expect((await compute(w)).has(mine[2].id)).toBe(true);
      await expect(compute(w, { leak: kind })).rejects.toBeInstanceOf(
        ContentStudioSourceRetentionIntegrityError
      );
    }
  });

  it('EMPTY an organization with nothing has an empty map', async () => {
    const reads: string[] = [];
    expect((await compute(world(), { reads })).size).toBe(0);
    // P8-R1B: one snapshot, the version count first; no source, so no
    // batch of versions
    expect(reads).toEqual([
      'snapshot',
      'count',
      'sources',
      'packages',
      'reviews',
      'revisions',
      'operations',
      'commit',
    ]);
  });

  it('ORPHAN P8-R1B a version of the organization whose source is not its own fails the organization', async () => {
    const w = world();
    addPage(w, Array(3).fill('A'));
    const theirs = addPage(w, Array(3).fill('A'), OTHER_ORG);
    w.versions.push({
      ...w.versions.find((row) => row.id === theirs[0].id)!,
      id: uuid(0x7998, 2),
      organizationId: ORG,
      versionNumber: 99,
    });
    expect(await failure(compute(w))).toEqual({
      type: 'ContentStudioSourceVersion',
      id: uuid(0x7998, 2),
    });
  });

  it("REFSOURCE P8-R1B a reference naming a source that is not the organization's fails before any version is read", async () => {
    const w = world();
    const versions = addPage(w, Array(3).fill('A'));
    addPackage(
      w,
      PACKAGE,
      grounded([[{ ...evidence(versions[0]), sourceId: uuid(0x5999, 9) }]])
    );
    const reads: string[] = [];
    expect(await failure(compute(w, { reads }))).toEqual({
      type: 'ContentPackage',
      id: PACKAGE,
    });
    expect(reads).not.toContain('versions');
  });

  it('QUERIES one read per kind of record and page, never per version, source or review', async () => {
    const small: string[] = [];
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[0])]]));
    addReview(w, REVIEW, REVISION);
    await compute(w, { reads: small });
    // P8-R1B: in one snapshot, the count, then one read per kind and one
    // batch of versions
    expect(small).toHaveLength(9);

    // 25,000 versions of 1,250 sources, 600 reviews, 1,200 revisions and AI
    // operations: pages of 10,000 rows and 500 documents
    const large: string[] = [];
    const big = world();
    const all: Version[] = [];
    for (let s = 0; s < 1250; s++) {
      all.push(...addPage(big, Array(20).fill('A')));
    }
    for (let r = 0; r < 1200; r++) {
      addRevision(
        big,
        uuid(0xa000, r + 1),
        PACKAGE,
        grounded([[evidence(all[r])]])
      );
      addOperation(big, uuid(0xb000, r + 1), {
        v: 1,
        sources: [sourceRef(all[r])],
      });
      if (r < 600) {
        addReview(big, uuid(0xc000, r + 1), uuid(0xa000, r + 1));
      }
    }
    const map = await compute(big, { reads: large });
    const count = (kind: string) => large.filter((k) => k === kind).length;
    // P8-R1B: versions by batches of 200 sources (1,250 sources: 7 batches)
    expect({
      count: count('count'),
      sources: count('sources'),
      versions: count('versions'),
      packages: count('packages'),
      reviews: count('reviews'),
      revisions: count('revisions'),
      operations: count('operations'),
    }).toEqual({
      count: 1,
      sources: 1,
      versions: 7,
      packages: 1,
      reviews: 1,
      revisions: 3,
      operations: 3,
    });
    expect(map.size).toBe(25_000);
  });
});

describe('P8-R1A explainRetentionEligibility', () => {
  const fixture = () => {
    const w = world();
    // v1..v25 of one page, all old: v5 the latest's window starts at v6
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[1])]]));
    addReview(w, REVIEW, REVISION);
    return { w, versions };
  };
  const explain = (w: World, sourceVersionId: string, organizationId = ORG) =>
    service(w).explainRetentionEligibility({
      organizationId,
      sourceVersionId,
      now: NOW,
    });

  it('E1 a protected version: not eligible, with its exact protections', async () => {
    const { w, versions } = fixture();
    expect(await explain(w, versions[1].id)).toEqual({
      sourceVersionId: versions[1].id,
      eligibleInPrinciple: false,
      protections: [
        {
          organizationId: ORG,
          sourceVersionId: versions[1].id,
          reason: 'REVISION_EVIDENCE',
          referenceType: 'ContentPackageRevision',
          referenceId: REVISION,
        },
        {
          organizationId: ORG,
          sourceVersionId: versions[1].id,
          reason: 'REVIEW_EVIDENCE',
          referenceType: 'ContentStudioReview',
          referenceId: REVIEW,
        },
      ],
    });
  });

  it('E2 an old version nothing names, out of the window: eligible in principle, no protections', async () => {
    const { w, versions } = fixture();
    expect(await explain(w, versions[2].id)).toEqual({
      sourceVersionId: versions[2].id,
      eligibleInPrinciple: true,
      protections: [],
    });
    // the 21st newest (v5) is out of the window, the 20th newest (v6) in it
    expect((await explain(w, versions[4].id)).eligibleInPrinciple).toBe(true);
    expect((await explain(w, versions[5].id)).protections).toEqual([
      expect.objectContaining({ reason: 'IN_FLIGHT', role: 'picker_window' }),
    ]);
  });

  it('E3/E4 a version that is not there, or of another organization, is not found: never eligible', async () => {
    const { w } = fixture();
    const foreign = addPage(w, Array(25).fill('A'), OTHER_ORG)[0];
    for (const id of [uuid(0x7999, 1), foreign.id, 'not-a-uuid', '']) {
      const err = await explain(w, id).then(
        () => {
          throw new Error('expected not found');
        },
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(404);
      expect((err as HttpException).getResponse()).toEqual({
        msg: 'Source version not found.',
        code: 'CS_NOT_FOUND',
      });
    }
    // the other organization finds its own version
    expect((await explain(w, foreign.id, OTHER_ORG)).sourceVersionId).toBe(
      foreign.id
    );
  });

  it('E5 corrupt data anywhere in the organization fails the explanation of any version', async () => {
    const { w, versions } = fixture();
    addOperation(w, OPERATION, {
      v: 1,
      sources: [{ ...sourceRef(versions[20]), versionNumber: 3 }],
    });
    expect(await failure(explain(w, versions[2].id))).toEqual({
      type: 'ContentStudioAIOperation',
      id: OPERATION,
    });
  });

  it("E6 the time is the caller's: a version made an hour before it is protected for its age", async () => {
    const { w, versions } = fixture();
    w.versions[2].createdAt = new Date(NOW.getTime() - HOUR);
    expect((await explain(w, versions[2].id)).protections).toEqual([
      expect.objectContaining({ reason: 'IN_FLIGHT', role: 'age' }),
    ]);
  });
});

// The P8-R1B dry run's hash of the DR1 fixture, from f7eec46f
const R1B_FIXTURE_HASH =
  '69b221328b23ce9e6b29fee2ca28661dccff7539ed9836d7d49e6984b161d6c6';

describe('P8-R1B the retention dry run', () => {
  const POLICY = {
    mode: 'compact_repeats',
    olderThan: new Date(NOW.getTime() - 7 * 24 * HOUR),
  };
  const dryRun = (w: World, options?: FakeOptions, policy: unknown = POLICY) =>
    service(w, options).computeRetentionDryRun({
      organizationId: ORG,
      now: NOW,
      policy: policy as typeof POLICY,
    });
  const code = async (call: Promise<unknown>) => {
    const err = await call.then(
      () => {
        throw new Error('expected a dry-run error');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ContentStudioSourceRetentionDryRunError);
    return (err as ContentStudioSourceRetentionDryRunError).code;
  };
  // 30 captures of one page (A1..A24, B25..B30), its change at v25: v1 is
  // the change's baseline, v24 its predecessor, v4 a draft's evidence and
  // v11..v30 the picker window; v2, v3 and v5..v10 are the candidates
  const fixture = () => {
    const w = world();
    const versions = addPage(w, [
      ...Array(24).fill('A'),
      ...Array(6).fill('B'),
    ]);
    w.sources[0].lastPageChangeAt = versions[24].fetchedAt;
    w.sources[0].lastPageChangeVersionNumber = 25;
    w.sources[0].lastPageChangeKind = 'content_changed';
    w.sources[0].lastPageChangePreviousCaptureAt = versions[23].fetchedAt;
    // a draft naming v4; blocks of several bytes per character
    addPackage(w, PACKAGE, grounded([[evidence(versions[3])]]));
    for (const row of w.versions) {
      row.content = `blöcks ${row.versionNumber} — €`;
    }
    return { w, versions };
  };

  it('DR1 the report: candidates in order, measured in bytes after the snapshot, and the same hash every time', async () => {
    const { w, versions } = fixture();
    const reads: string[] = [];
    const report = await dryRun(w, { reads });
    expect(report.candidates.map((c) => c.versionNumber)).toEqual([
      2, 3, 5, 6, 7, 8, 9, 10,
    ]);
    expect(report.candidates[0]).toEqual({
      id: versions[1].id,
      sourceId: versions[1].sourceId,
      versionNumber: 2,
      contentHash: versions[1].contentHash,
      createdAt: '2026-01-01T00:02:00.000Z',
      fetchedAt: '2026-01-01T00:02:00.000Z',
      candidateReason: 'REPEAT_RUN_INTERIOR',
      logicalContentBytes: Buffer.byteLength('blöcks 2 — €', 'utf8'),
    });
    expect(Buffer.byteLength('blöcks 2 — €', 'utf8')).toBeGreaterThan(
      'blöcks 2 — €'.length
    );
    expect(report.candidateSummary).toEqual(
      expect.objectContaining({
        totalVersions: 30,
        protectedVersions: 22,
        technicallyUnprotectedVersions: 8,
        policyRetainedVersions: 0,
        candidateVersions: 8,
      })
    );
    expect(report.protectionSummary.edgesByReason.DRAFT_EVIDENCE).toBe(1);
    // one snapshot: the count, the sources, the records, one batch of
    // versions; then the candidates' blocks
    expect(reads).toEqual([
      'snapshot',
      // P8-R1Q: whether a version is held, first
      'pending',
      'count',
      'sources',
      'packages',
      'reviews',
      'revisions',
      'operations',
      'versions',
      'commit',
      'contents',
    ]);
    expect((await dryRun(w)).dryRunHash).toBe(report.dryRunHash);
    // never the blocks themselves
    expect(JSON.stringify(report)).not.toMatch(/blöcks|PRIVATE|secret/);
  });

  it('DR2 the scale guard counts in the snapshot first: 1,000,000 goes on, 1,000,001 reads nothing else', async () => {
    const { w } = fixture();
    const reads: string[] = [];
    expect(await code(dryRun(w, { reads, count: 1_000_001 }))).toBe(
      'RETENTION_DRY_RUN_SCALE_LIMIT'
    );
    expect(reads).toEqual(['snapshot', 'pending', 'count']);
    // at the limit the guard lets it through: these rows are then not
    // the 1,000,000 counted, which fails the organization
    const atLimit: string[] = [];
    await expect(
      dryRun(w, { reads: atLimit, count: 1_000_000 })
    ).rejects.toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
    expect(atLimit).toContain('versions');
    // protection itself has no such limit (P8-R1A as it was)
    await expect(
      service(w, { count: 1_000_001 }).computeProtectionMap({
        organizationId: ORG,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
  });

  it('DR3 a policy that is not enabled or not valid is refused before anything is read', async () => {
    const { w } = fixture();
    const reads: string[] = [];
    expect(
      await code(
        dryRun(w, { reads }, { mode: 'all_unprotected', olderThan: NOW })
      )
    ).toBe('RETENTION_POLICY_NOT_ENABLED');
    expect(
      await code(
        dryRun(w, { reads }, { mode: 'compact_repeats', olderThan: NOW })
      )
    ).toBe('RETENTION_POLICY_INVALID');
    expect(reads).toEqual([]);
  });

  it('DR4 a failed snapshot, or a candidate gone before it is measured, fails the run: no report', async () => {
    const { w, versions } = fixture();
    const failed = new ContentStudioSourceRetentionDryRunError(
      'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
    );
    const reads: string[] = [];
    expect(await code(dryRun(w, { fail: failed, reads }))).toBe(
      'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
    );
    expect(reads).toEqual(['snapshot']);
    expect(await code(dryRun(w, { missing: [versions[4].id] }))).toBe(
      'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
    );
  });

  it('DR5 integrity anywhere fails the whole run; a stale source only blocks itself', async () => {
    const { w, versions } = fixture();
    addOperation(w, OPERATION, {
      v: 1,
      sources: [{ ...sourceRef(versions[2]), versionNumber: 9 }],
    });
    await expect(dryRun(w)).rejects.toBeInstanceOf(
      ContentStudioSourceRetentionIntegrityError
    );
    const stale = fixture();
    // the change stored is an older one than the versions show
    // (A1..A28 B29 C30: v29 against v28, while v30 is the last change)
    const other = addPage(stale.w, [...Array(28).fill('A'), 'B', 'C']);
    const row = stale.w.sources[1];
    row.lastPageChangeAt = other[28].fetchedAt;
    row.lastPageChangeVersionNumber = 29;
    row.lastPageChangeKind = 'content_changed';
    row.lastPageChangePreviousCaptureAt = other[27].fetchedAt;
    const report = await dryRun(stale.w);
    expect(report.blockedSources).toEqual([
      {
        sourceId: other[0].sourceId,
        blocker: 'PAGE_CHANGE_STATE_STALE',
        // v2..v10: v1 its run's first, v11..v30 the picker window
        suppressedCandidates: 9,
      },
    ]);
    expect(report.candidateSummary.candidateVersions).toBe(8);
    expect(report.candidateSummary.blockedCandidateVersions).toBe(9);
  });

  it('Q31 P8-R1Q no held version: the report and hash are exactly those of P8-R1B', async () => {
    // the same ids whatever ran before
    sourceCount = 1000;
    const { w } = fixture();
    const report = await dryRun(w, { pending: [OTHER_ORG] });
    // computed by the P8-R1B dry run (f7eec46f) for this fixture, at NOW
    expect(report.dryRunHash).toBe(R1B_FIXTURE_HASH);
    expect(report.dryRunFormatVersion).toBe(1);
    expect(report.policyVersion).toBe(1);
    expect(report.protectionVersion).toBe(1);
  });

  it("Q32/Q33 P8-R1Q a held version of the organization refuses the run in its snapshot, before anything else is read; another organization's does not", async () => {
    const { w } = fixture();
    const reads: string[] = [];
    expect(await code(dryRun(w, { reads, pending: [ORG] }))).toBe(
      'RETENTION_DRY_RUN_QUARANTINE_ACTIVE'
    );
    expect(reads).toEqual(['snapshot', 'pending']);
    // the scale guard comes after it
    const both: string[] = [];
    expect(
      await code(dryRun(w, { reads: both, pending: [ORG], count: 2_000_000 }))
    ).toBe('RETENTION_DRY_RUN_QUARANTINE_ACTIVE');
    // protection (P8-R1A) reads no held version and is never refused for one
    const protectionReads: string[] = [];
    await service(w, {
      reads: protectionReads,
      pending: [ORG],
    }).computeProtectionMap({ organizationId: ORG, now: NOW });
    expect(protectionReads).not.toContain('pending');
    expect(
      (await dryRun(w, { pending: [OTHER_ORG] })).candidateSummary
        .candidateVersions
    ).toBe(8);
  });

  it('DR6 reads by batch and page, never per version or candidate', async () => {
    const w = world();
    // 450 sources of 30 captures (A1..A29, B30), the change at v30
    for (let s = 0; s < 450; s++) {
      const versions = addPage(w, [...Array(29).fill('A'), 'B']);
      Object.assign(w.sources[s], {
        lastPageChangeAt: versions[29].fetchedAt,
        lastPageChangeVersionNumber: 30,
        lastPageChangeKind: 'content_changed',
        lastPageChangePreviousCaptureAt: versions[28].fetchedAt,
      });
    }
    const reads: string[] = [];
    const report = await dryRun(w, { reads });
    // v2..v10 of each: v1 its run's first and the change's baseline,
    // v11..v30 the picker window
    expect(report.candidateSummary.candidateVersions).toBe(450 * 9);
    const count = (kind: string) => reads.filter((k) => k === kind).length;
    expect({
      count: count('count'),
      sources: count('sources'),
      versions: count('versions'),
      contents: count('contents'),
    }).toEqual({
      count: 1,
      sources: 1,
      // 450 sources in batches of 200
      versions: 3,
      // 4,050 candidates in pages of 500
      contents: 9,
    });
  });
});

describe('P8-R1Q the retention quarantine, as the service checks it', () => {
  const PLAN = 'c'.repeat(64);
  const V1 = uuid(0x9000, 1);
  const V2 = uuid(0x9000, 2);
  const setup = () => {
    const repository = {
      quarantineVersions: jest.fn(async () => ({
        created: 1,
        alreadyPending: 0,
      })),
      releaseQuarantine: jest.fn(async () => ({ count: 2 })),
      listPendingForPlan: jest.fn(async () => []),
    };
    return {
      repository,
      service: new ContentStudioSourceRetentionService(
        repository as unknown as ContentStudioSourceRetentionRepository
      ),
    };
  };
  const invalid = async (call: () => Promise<unknown>) => {
    const err = await call().then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toEqual(
      new ContentStudioSourceVersionQuarantineError(
        'RETENTION_QUARANTINE_INVALID'
      )
    );
  };

  it('Q7/Q8 holds distinct versions for the plan, in the order given, at now', async () => {
    const { repository, service } = setup();
    await service.quarantineSourceVersions({
      organizationId: ORG,
      sourceVersionIds: [V2, V1, V2],
      planHash: PLAN,
      now: NOW,
    });
    expect(repository.quarantineVersions).toHaveBeenCalledWith({
      organizationId: ORG,
      planHash: PLAN,
      sourceVersionIds: [V2, V1],
      now: NOW,
    });
  });

  it('Q14 a plan hash that is not a lowercase sha256, an organization or version that is not an id, no version, more than 500 or no valid now: refused before anything is read', async () => {
    const { repository, service } = setup();
    const call = (over: Record<string, unknown>) => () =>
      service.quarantineSourceVersions({
        organizationId: ORG,
        sourceVersionIds: [V1],
        planHash: PLAN,
        now: NOW,
        ...over,
      } as never);
    for (const over of [
      { planHash: 'C'.repeat(64) },
      { planHash: 'c'.repeat(63) },
      { planHash: 'c'.repeat(65) },
      { planHash: `${'c'.repeat(63)}g` },
      { planHash: undefined },
      { organizationId: 'org' },
      { organizationId: ORG.toUpperCase() },
      { sourceVersionIds: [] },
      { sourceVersionIds: ['v1'] },
      { sourceVersionIds: [V1, 7] },
      { sourceVersionIds: 'x' },
      {
        sourceVersionIds: Array.from({ length: 501 }, (_, i) =>
          uuid(0x9100, i + 1)
        ),
      },
      { now: new Date(Number.NaN) },
      { now: '2026-10-26T12:00:00.000Z' },
    ]) {
      await invalid(call(over));
    }
    // 500 is the most one call holds
    await call({
      sourceVersionIds: Array.from({ length: 500 }, (_, i) =>
        uuid(0x9100, i + 1)
      ),
    })();
    expect(repository.quarantineVersions).toHaveBeenCalledTimes(1);
  });

  it('Q15/Q16/Q116 releases these versions, or all of the plan, of the organization; checked like holding', async () => {
    const { repository, service } = setup();
    await expect(
      service.releaseSourceVersionQuarantine({
        organizationId: ORG,
        planHash: PLAN,
        sourceVersionIds: [V1, V1],
      })
    ).resolves.toEqual({ released: 2 });
    expect(repository.releaseQuarantine).toHaveBeenLastCalledWith({
      organizationId: ORG,
      planHash: PLAN,
      sourceVersionIds: [V1],
    });
    await service.releaseSourceVersionQuarantine({
      organizationId: ORG,
      planHash: PLAN,
    });
    expect(repository.releaseQuarantine).toHaveBeenLastCalledWith({
      organizationId: ORG,
      planHash: PLAN,
    });
    for (const over of [
      { planHash: 'x' },
      { organizationId: 'org' },
      { sourceVersionIds: [] },
      { sourceVersionIds: ['v1'] },
    ]) {
      await invalid(() =>
        service.releaseSourceVersionQuarantine({
          organizationId: ORG,
          planHash: PLAN,
          ...over,
        } as never)
      );
    }
    expect(repository.releaseQuarantine).toHaveBeenCalledTimes(2);
  });

  it("Q119 lists a plan's held versions of the organization, checked like holding", async () => {
    const { repository, service } = setup();
    await service.listSourceVersionQuarantine({
      organizationId: ORG,
      planHash: PLAN,
    });
    expect(repository.listPendingForPlan).toHaveBeenCalledWith({
      organizationId: ORG,
      planHash: PLAN,
    });
    await invalid(async () =>
      service.listSourceVersionQuarantine({
        organizationId: ORG,
        planHash: PLAN.toUpperCase(),
      })
    );
  });
});

describe('P8-R1C the replay and the recheck of a plan', () => {
  const POLICY = {
    mode: 'compact_repeats',
    olderThan: new Date(NOW.getTime() - 7 * 24 * HOUR),
  };
  const PLAN_HASH = 'c'.repeat(64);
  // 30 captures (A1..A24, B25..B30), the change at v25: v2..v10 are the
  // candidates
  const fixture = () => {
    const w = world();
    const versions = addPage(w, [
      ...Array(24).fill('A'),
      ...Array(6).fill('B'),
    ]);
    w.sources[0].lastPageChangeAt = versions[24].fetchedAt;
    w.sources[0].lastPageChangeVersionNumber = 25;
    w.sources[0].lastPageChangeKind = 'content_changed';
    w.sources[0].lastPageChangePreviousCaptureAt = versions[23].fetchedAt;
    const candidates = versions.slice(1, 10).map((v) => ({
      id: v.id,
      sourceId: v.sourceId,
      versionNumber: v.versionNumber,
      contentHash: v.contentHash,
    }));
    return { w, versions, candidates };
  };
  const held = (candidates: Array<{ id: string }>, planHash = PLAN_HASH) =>
    candidates.map((c) => ({ sourceVersionId: c.id, planHash }));
  const recheck = (
    w: World,
    candidates: ReturnType<typeof fixture>['candidates'],
    options: FakeOptions
  ) =>
    service(w, options).recheckRetentionPlan({
      organizationId: ORG,
      planHash: PLAN_HASH,
      planEvaluationNow: NOW,
      now: new Date(NOW.getTime() + 2 * 60 * 1000),
      policy: POLICY,
      candidates,
    });
  const failed = async (call: Promise<unknown>) => {
    const err = await call.then(
      () => {
        throw new Error('expected a recheck failure');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(
      ContentStudioSourceVersionRetentionExecutionError
    );
    const { code, detail } =
      err as ContentStudioSourceVersionRetentionExecutionError;
    expect(code).toBe('RETENTION_EXECUTION_RECHECK_FAILED');
    return detail;
  };

  it('RP1 the plan made again: the hash of the dry run, from the same snapshot, without measuring anything; refused while anything is held', async () => {
    const { w } = fixture();
    const report = await service(w).computeRetentionDryRun({
      organizationId: ORG,
      now: NOW,
      policy: POLICY,
    });
    const reads: string[] = [];
    const replayed = await service(w, { reads }).evaluateRetentionPlan({
      organizationId: ORG,
      now: NOW,
      policy: POLICY,
    });
    expect(replayed.dryRunHash).toBe(report.dryRunHash);
    expect(replayed.candidates.map((c) => c.id)).toEqual(
      report.candidates.map((c) => c.id)
    );
    expect(reads).not.toContain('contents');
    expect(reads.slice(0, 3)).toEqual(['snapshot', 'pending', 'count']);
    await expect(
      service(w, { pending: [ORG] }).evaluateRetentionPlan({
        organizationId: ORG,
        now: NOW,
        policy: POLICY,
      })
    ).rejects.toThrow('RETENTION_DRY_RUN_QUARANTINE_ACTIVE');
    // a later time is another plan
    expect(
      (
        await service(w).evaluateRetentionPlan({
          organizationId: ORG,
          now: new Date(NOW.getTime() + 1000),
          policy: POLICY,
        })
      ).dryRunHash
    ).not.toBe(report.dryRunHash);
  });

  it('RC1 every candidate still one, held for the plan exactly: what each source keeps, its runs', async () => {
    const { w, versions, candidates } = fixture();
    const reads: string[] = [];
    const kept = await recheck(w, candidates, {
      reads,
      held: held(candidates),
    });
    expect([...kept.keys()]).toEqual([versions[0].sourceId]);
    const keptIds = versions
      .filter((v) => !candidates.some((c) => c.id === v.id))
      .map((v) => v.id);
    expect(kept.get(versions[0].sourceId)).toEqual({
      versionIds: [...keptIds].sort(),
      runs: [
        [versions[0].id, versions[23].id],
        [versions[24].id, versions[29].id],
      ],
    });
    // the held rows first, in the snapshot, then the organization whole
    expect(reads.slice(0, 3)).toEqual(['snapshot', 'held', 'count']);
    expect(reads).not.toContain('pending');
    expect(reads).not.toContain('contents');
  });

  it("RC2 held rows that are not exactly the plan's fail before anything else is read", async () => {
    const { w, candidates } = fixture();
    for (const rows of [
      held(candidates.slice(1)),
      [...held(candidates), { sourceVersionId: 'other', planHash: PLAN_HASH }],
      held(candidates, 'd'.repeat(64)),
      [],
    ]) {
      const reads: string[] = [];
      expect(await failed(recheck(w, candidates, { reads, held: rows }))).toBe(
        'PENDING_MISMATCH'
      );
      expect(reads).toEqual(['snapshot', 'held']);
    }
  });

  it('RC3 a candidate gone or not as the plan named it fails the whole plan', async () => {
    const { w, candidates } = fixture();
    const variants = [
      { ...candidates[2], contentHash: sha256Hex('other') },
      { ...candidates[2], versionNumber: 99 },
      { ...candidates[2], sourceId: uuid(0x5000, 999) },
      { ...candidates[2], id: uuid(0x7999, 1) },
    ];
    for (const variant of variants) {
      const changed = candidates.map((c, i) => (i === 2 ? variant : c));
      expect(await failed(recheck(w, changed, { held: held(changed) }))).toBe(
        'CANDIDATE_CHANGED'
      );
    }
  });

  it('RC4 a candidate protected since (a draft names it), a run end, or a source that is held back: the whole plan', async () => {
    const protectedSince = fixture();
    addPackage(
      protectedSince.w,
      PACKAGE,
      grounded([[evidence(protectedSince.versions[4])]])
    );
    expect(
      await failed(
        recheck(protectedSince.w, protectedSince.candidates, {
          held: held(protectedSince.candidates),
        })
      )
    ).toBe('CANDIDATE_NOT_ELIGIBLE');
    // the first of the run is never a candidate
    const boundary = fixture();
    const withEnd = [
      ...boundary.candidates,
      {
        id: boundary.versions[0].id,
        sourceId: boundary.versions[0].sourceId,
        versionNumber: 1,
        contentHash: boundary.versions[0].contentHash,
      },
    ];
    expect(
      await failed(recheck(boundary.w, withEnd, { held: held(withEnd) }))
    ).toBe('CANDIDATE_NOT_ELIGIBLE');
    // the stored change is not the one the versions show: blocked
    const stale = fixture();
    stale.w.sources[0].lastPageChangeAt = null;
    stale.w.sources[0].lastPageChangeVersionNumber = null;
    stale.w.sources[0].lastPageChangeKind = null;
    stale.w.sources[0].lastPageChangePreviousCaptureAt = null;
    expect(
      await failed(
        recheck(stale.w, stale.candidates, { held: held(stale.candidates) })
      )
    ).toBe('CANDIDATE_NOT_ELIGIBLE');
  });

  it('RC5 a capture since, after the plan: the plan still holds; a new candidate is never added to it', async () => {
    const { w, versions, candidates } = fixture();
    // three repeats of B: v30 becomes an interior, and v11 leaves the window
    for (let n = 31; n <= 33; n++) {
      w.versions.push({
        ...versions[29],
        id: uuid(0x7fff, n),
        versionNumber: n,
      });
    }
    w.sources[0].latestVersionNumber = 33;
    const kept = await recheck(w, candidates, { held: held(candidates) });
    expect(kept.get(versions[0].sourceId)!.versionIds).toContain(
      versions[10].id
    );
  });

  it('RC6 anything that does not resolve anywhere in the organization fails it', async () => {
    const { w, candidates } = fixture();
    addPackage(
      w,
      PACKAGE,
      grounded([
        [
          {
            ...evidence(w.versions[3] as unknown as Version),
            versionNumber: 77,
          },
        ],
      ])
    );
    await expect(
      recheck(w, candidates, { held: held(candidates) })
    ).rejects.toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
  });
});
