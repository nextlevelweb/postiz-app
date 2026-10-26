import { HttpException } from '@nestjs/common';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioReviewRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionProtectionMap,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// Source version protection (P8-R1A), as the service reads it: every kind
// of stored record of one organization, in bounded pages, parsed with the
// parsers that wrote it, checked and handed to source.retention.ts. No
// database: the four repositories are in-memory fakes that read like
// Prisma (organization, id order, after an id, a page size) and count their
// reads. The PostgreSQL suite runs the same against real rows

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
// query would return), in id order, after an id, at most a page
const service = (
  w: World,
  options: { leak?: keyof World; reads?: string[] } = {}
) => {
  const reads = options.reads ?? [];
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
            (options.leak === kind ||
              row.organizationId === input.organizationId) &&
            filter(row) &&
            (!input.afterId || row.id > input.afterId)
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, input.take)
        .map((row) =>
          Object.fromEntries(SELECTS[kind].map((key) => [key, row[key]]))
        );
    };
  return new ContentStudioSourceRetentionService(
    {
      listSourcesForVersionProtection: read('sources'),
      listVersionsForProtection: read('versions'),
    } as unknown as ContentStudioSourceRepository,
    {
      listPackageDraftsForVersionProtection: read('packages'),
      listPackageRevisionsForVersionProtection: read('revisions'),
    } as unknown as ContentStudioRepository,
    {
      listPackageReviewsForVersionProtection: read(
        'reviews',
        (row) => row.packageRevisionId !== null
      ),
    } as unknown as ContentStudioReviewRepository,
    {
      listOperationContextsForVersionProtection: read('operations'),
    } as unknown as ContentStudioAIOperationRepository
  );
};

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
    expect(reads).toEqual([
      'sources',
      'versions',
      'packages',
      'reviews',
      'revisions',
      'operations',
    ]);
  });

  it('QUERIES one read per kind of record and page, never per version, source or review', async () => {
    const small: string[] = [];
    const w = world();
    const versions = addPage(w, Array(25).fill('A'));
    addRevision(w, REVISION, PACKAGE, grounded([[evidence(versions[0])]]));
    addReview(w, REVIEW, REVISION);
    await compute(w, { reads: small });
    expect(small).toHaveLength(6);

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
    expect({
      sources: count('sources'),
      versions: count('versions'),
      packages: count('packages'),
      reviews: count('reviews'),
      revisions: count('revisions'),
      operations: count('operations'),
    }).toEqual({
      sources: 1,
      versions: 3,
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
