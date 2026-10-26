import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  ContentStudioSourceRetentionRepository,
  ContentStudioSourceRetentionSnapshotReads,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository';
import {
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionRetentionDryRun,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// The retention dry run (P8-R1B) on a real PostgreSQL: the exact report and
// hash of an organization with every kind of protection and runs of
// repeated captures, one RepeatableRead snapshot that a capture or draft
// committed meanwhile does not reach (and ReadCommitted would), the run
// reading nothing but reading, the real backfill and change view unchanged
// after the candidates are removed (by this test, in this database only), a
// stale source blocked, another organization apart, corrupt data failing
// the run, a timed-out snapshot, the measured bytes, and 10,000 and 100,000
// versions. Opt-in: runs only through jest.content-studio.integration.config.ts
// against the disposable local database. Nothing is fetched

const ORG_A = '30a1b000-0000-4000-8000-00000000000a';
const ORG_B = '30a1b000-0000-4000-8000-00000000000b';
const ORG_S = '30a1b000-0000-4000-8000-00000000000c';
const ORGS = [ORG_A, ORG_B, ORG_S];
const USER: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1b000-0000-4000-8000-0000000000${i + 1}1`])
);
const CONNECTION: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1b000-0000-4000-8000-0000000000${i + 1}2`])
);
const NOW = new Date('2026-10-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LONG_AGO = Date.UTC(2026, 0, 1);
const X1 = 'content-studio-source-v1';
const X2 = 'content-studio-source-v2';
const POLICY = {
  mode: 'compact_repeats',
  olderThan: new Date(NOW.getTime() - 7 * DAY),
};

let client: PrismaClient;
let other: PrismaClient;
let transaction: PrismaTransaction;
let retentionRepository: ContentStudioSourceRetentionRepository;
let retention: ContentStudioSourceRetentionService;
let sourceService: ContentStudioSourceService;

// A capture by letter: A, then one thing different each; N without a title,
// F all three different
const IDENTITY: Record<
  string,
  { text: string; title: string | null; extractionVersion: string }
> = {
  A: { text: 'Alpha — €', title: 'P8R1B', extractionVersion: X2 },
  B: { text: 'Béta', title: 'P8R1B', extractionVersion: X2 },
  C: { text: 'Alpha — €', title: 'Other', extractionVersion: X2 },
  D: { text: 'Alpha — €', title: 'P8R1B', extractionVersion: X1 },
  N: { text: 'Alpha — €', title: null, extractionVersion: X2 },
  F: { text: 'Béta', title: 'Other', extractionVersion: X1 },
};

const versionRow = (
  organizationId: string,
  sourceId: string,
  n: number,
  letter: string,
  createdAt?: Date
) => {
  const identity = IDENTITY[letter];
  return {
    id: randomUUID(),
    organizationId,
    sourceId,
    versionNumber: n,
    extractionVersion: identity.extractionVersion,
    requestedUrl: 'https://p8r1b.example/page',
    finalUrl: 'https://p8r1b.example/page',
    redirectCount: 0,
    fetchedAt: new Date(LONG_AGO + n * 60_000),
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 100,
    title: identity.title,
    sourceHash: null,
    createdById: USER[organizationId],
    createdAt: createdAt ?? new Date(LONG_AGO + n * 60_000),
    ...storedContentStudioSourceContent({
      schemaVersion: 1,
      blocks: [
        {
          id: 'b1',
          type: 'paragraph',
          text: `${identity.text} ${n % 3}`.repeat(1 + (n % 4)),
          level: null,
        },
      ],
    }),
  };
};
type Row = ReturnType<typeof versionRow>;

// The blocks of a capture only depend on its letter: a repeat is the same
// capture
const sameBlocks = (rows: Row[], letters: string) => {
  const first = new Map<string, Row>();
  rows.forEach((row, i) => {
    const seen = first.get(letters[i]);
    if (seen) {
      row.content = seen.content;
      row.contentHash = seen.contentHash;
    } else {
      first.set(letters[i], row);
    }
  });
  return rows;
};

// A page with these captures at these numbers (1, 2, 3... unless given),
// its last page change left to the real backfill
const insertPage = async (
  organizationId: string,
  letters: string,
  options: {
    numbers?: number[];
    createdAt?: (n: number) => Date | undefined;
    archivedAt?: Date;
  } = {}
) => {
  const id = randomUUID();
  const numbers =
    options.numbers ?? Array.from({ length: letters.length }, (_, i) => i + 1);
  const rows = sameBlocks(
    [...letters].map((letter, i) =>
      versionRow(
        organizationId,
        id,
        numbers[i],
        letter,
        options.createdAt?.(numbers[i])
      )
    ),
    letters
  );
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8R1B page',
      canonicalUrl: `https://p8r1b.example/${id}`,
      createdById: USER[organizationId],
      latestVersionNumber: numbers[numbers.length - 1] ?? 0,
      archivedAt: options.archivedAt ?? null,
    },
  });
  for (let i = 0; i < rows.length; i += 5000) {
    await client.contentStudioSourceVersion.createMany({
      data: rows.slice(i, i + 5000),
    });
  }
  return {
    id,
    rows,
    n: (k: number) => rows.find((row) => row.versionNumber === k)!,
  };
};

// The real page-change backfill over every source
const backfill = async () => {
  const total = { updated: 0, unchanged: 0, failed: 0 };
  let afterId: string | null = null;
  do {
    const page: Awaited<
      ReturnType<ContentStudioSourceService['backfillPageChanges']>
    > = await sourceService.backfillPageChanges({ afterId });
    total.updated += page.updated;
    total.unchanged += page.unchanged;
    total.failed += page.failed.length;
    afterId = page.next;
  } while (afterId);
  return total;
};

const evidence = (v: Row) => ({
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
  blockId: 'b1',
  quote: null,
});
const THREAD = { global: { thread: [{ id: 'i1', text: 'x', mediaIds: [] }] } };
const grounded = (list: ReturnType<typeof evidence>[]) => ({
  schemaVersion: 2,
  copy: THREAD,
  grounding: {
    claims: [
      {
        id: 'c_p8r1b_claim',
        threadItemId: 'i1',
        text: 'A claim',
        evidence: list,
      },
    ],
  },
});

const insertPackage = async (
  organizationId: string,
  draft: unknown,
  db: PrismaClient = client
) => {
  const id = randomUUID();
  await db.contentPackage.create({
    data: {
      id,
      organizationId,
      name: 'P8R1B package',
      draft: typeof draft === 'string' ? draft : JSON.stringify(draft),
      createdById: USER[organizationId],
    },
  });
  return id;
};
const revisionRow = (
  organizationId: string,
  packageId: string,
  revisionNumber: number,
  draft: unknown
) => {
  const content = canonicalJson(parseContentPackageDraft(draft));
  return {
    id: randomUUID(),
    organizationId,
    packageId,
    revisionNumber,
    schemaVersion: (draft as { schemaVersion: number }).schemaVersion,
    content,
    contentHash: sha256Hex(content),
    origin: 'manual',
    sourceDraftVersion: 1,
    createdById: USER[organizationId],
  };
};
const reviewRow = (
  organizationId: string,
  revision: { id: string; contentHash: string }
) => ({
  id: randomUUID(),
  organizationId,
  packageRevisionId: revision.id,
  targetContentHash: revision.contentHash,
  state: 'APPROVED',
  requestedById: USER[organizationId],
});
const operationRow = (organizationId: string, versions: Row[]) => ({
  id: randomUUID(),
  organizationId,
  userId: USER[organizationId],
  connectionId: CONNECTION[organizationId],
  packageId: null,
  kind: 'generate_item',
  status: 'succeeded',
  provider: 'openai',
  model: 'gpt-test',
  promptVersion: 'cs-item-v1',
  context: {
    v: 1,
    itemId: 'i1',
    sources: versions.map((v) => ({
      sourceId: v.sourceId,
      versionId: v.id,
      versionNumber: v.versionNumber,
      contentHash: v.contentHash,
    })),
  } as Prisma.InputJsonValue,
  requestHash: sha256Hex('request'),
});

const dryRun = (organizationId = ORG_A, now = NOW) =>
  retention.computeRetentionDryRun({ organizationId, now, policy: POLICY });

// The dry run with its reads counted, and a hook after one of them
const counted = async (
  organizationId: string,
  after?: { read: string; run: () => Promise<void> }
) => {
  const calls: string[] = [];
  const original = retentionRepository.readSnapshot.bind(retentionRepository);
  const snapshot = jest
    .spyOn(retentionRepository, 'readSnapshot')
    .mockImplementation((work) =>
      original((reads) =>
        work(
          Object.fromEntries(
            Object.entries(reads).map(([name, read]) => [
              name,
              async (input: unknown) => {
                calls.push(name);
                const result = await (
                  read as (input: unknown) => Promise<unknown>
                )(input);
                if (after && after.read === name) {
                  const hook = after.run;
                  after = undefined;
                  await hook();
                }
                return result;
              },
            ])
          ) as unknown as ContentStudioSourceRetentionSnapshotReads
        )
      )
    );
  const contents = jest.spyOn(retentionRepository, 'listVersionContents');
  const started = process.hrtime.bigint();
  const report = await dryRun(organizationId);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const count = (name: string) => calls.filter((call) => call === name).length;
  const reads = {
    count: count('countVersions'),
    sources: count('listSources'),
    drafts: count('listPackageDrafts'),
    reviews: count('listPackageReviews'),
    revisions: count('listPackageRevisions'),
    operations: count('listOperationContexts'),
    versions: count('listVersionsOfSources'),
    contents: contents.mock.calls.length,
  };
  snapshot.mockRestore();
  contents.mockRestore();
  return {
    report,
    ms,
    calls,
    reads,
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1e6),
  };
};

// every row the dry run could touch, exactly as stored
const snapshot = async () => {
  const where = { organizationId: { in: ORGS } };
  const orderBy = { id: 'asc' as const };
  return {
    versions: await client.contentStudioSourceVersion.findMany({
      where,
      orderBy,
    }),
    sources: await client.contentStudioSource.findMany({ where, orderBy }),
    packages: await client.contentPackage.findMany({ where, orderBy }),
    revisions: await client.contentPackageRevision.findMany({ where, orderBy }),
    reviews: await client.contentStudioReview.findMany({ where, orderBy }),
    operations: await client.contentStudioAIOperation.findMany({
      where,
      orderBy,
    }),
  };
};

const clean = async (orgs = ORGS) => {
  const where = { organizationId: { in: orgs } };
  await client.contentStudioReview.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
  // test data only, in the disposable database
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await clean();
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioAIConnection.deleteMany({ where });
  await client.userOrganization.deleteMany({ where });
  await client.user.deleteMany({ where: { id: { in: Object.values(USER) } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  other = createContentStudioPostgresClient();
  await client.$connect();
  await other.$connect();
  const prisma = client as unknown as PrismaService;
  transaction = new PrismaTransaction(prisma);
  const sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  retentionRepository = new ContentStudioSourceRetentionRepository(
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  retention = new ContentStudioSourceRetentionService(retentionRepository);
  sourceService = new ContentStudioSourceService(
    sources,
    new ContentStudioSourceDiscoveryRepository(
      new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
    ),
    new ContentStudioSourceCaptureAttemptRepository(
      new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
    )
  );
  await cleanFixtures();
  for (const org of ORGS) {
    await client.organization.create({
      data: { id: org, name: `P8R1B ${org}` },
    });
    await client.user.create({
      data: {
        id: USER[org],
        email: `${USER[org]}@p8r1b.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8R1B ${org}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: USER[org], organizationId: org, role: 'USER' },
    });
    await client.contentStudioAIConnection.create({
      data: {
        id: CONNECTION[org],
        organizationId: org,
        name: 'P8R1B',
        provider: 'openai',
        credentialUpdatedAt: new Date(),
        createdById: USER[org],
      },
    });
  }
});

beforeEach(async () => {
  await clean();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
  await other?.$disconnect();
});

// One organization with every kind of protection and runs of repeats:
// page P: v1..v12 A, v13..v40 B (its change at v13 against v12, shown
// against v1); a draft names v5, a revision v6 and its review, an AI
// operation v7; v15 was made three days ago. Page Q (archived, gaps): 25
// captures A and one B at 1, 5, 7, 11, 13...; page R: one capture
const everything = async () => {
  const p = await insertPage(ORG_A, `${'A'.repeat(12)}${'B'.repeat(28)}`, {
    createdAt: (n) =>
      n === 15 ? new Date(NOW.getTime() - 3 * DAY) : undefined,
  });
  const q = await insertPage(ORG_A, `${'A'.repeat(25)}B`, {
    numbers: Array.from({ length: 26 }, (_, i) => i * 3 + 1 + (i % 2)),
    archivedAt: new Date('2026-06-01'),
  });
  const r = await insertPage(ORG_A, 'A');
  // the backfill reads every organization: only ours is counted here
  expect((await backfill()).failed).toBe(0);
  expect(
    (
      await client.contentStudioSource.findMany({
        where: { id: { in: [p.id, q.id, r.id] } },
        select: { id: true, lastPageChangeVersionNumber: true },
      })
    )
      .map((row) => [
        row.id === p.id ? 'P' : row.id === q.id ? 'Q' : 'R',
        row.lastPageChangeVersionNumber,
      ])
      .sort()
  ).toEqual([
    ['P', 13],
    ['Q', 77],
    ['R', null],
  ]);
  const packageId = await insertPackage(ORG_A, grounded([evidence(p.n(5))]));
  const revision = revisionRow(
    ORG_A,
    packageId,
    1,
    grounded([evidence(p.n(6))])
  );
  await client.contentPackageRevision.create({ data: revision });
  await client.contentStudioReview.create({ data: reviewRow(ORG_A, revision) });
  await client.contentStudioAIOperation.create({
    data: operationRow(ORG_A, [p.n(7)]),
  });
  return { p, q, r };
};

// The hash of a dry run, recomputed here from its pinned payload
const expectedHash = (
  report: ContentStudioSourceVersionRetentionDryRun,
  candidates: Row[]
) =>
  sha256Hex(
    canonicalJson({
      format: 'content-studio.source-version-retention-dry-run',
      dryRunFormatVersion: 1,
      protectionVersion: 1,
      policyVersion: 1,
      organizationId: report.organizationId,
      evaluationNow: NOW.toISOString(),
      validUntil: new Date(NOW.getTime() + HOUR).toISOString(),
      policy: {
        mode: 'compact_repeats',
        olderThan: POLICY.olderThan.toISOString(),
      },
      candidates: candidates
        .slice()
        .sort((a, b) =>
          a.sourceId !== b.sourceId
            ? a.sourceId < b.sourceId
              ? -1
              : 1
            : a.versionNumber - b.versionNumber
        )
        .map((c) => [c.sourceId, c.versionNumber, c.id, c.contentHash]),
      blockedSources: report.blockedSources.map((b) => [
        b.sourceId,
        b.blocker,
        b.suppressedCandidates,
      ]),
    })
  );

describe('P8-R1B retention dry run on PostgreSQL', () => {
  it('PGD1/PGD9 the exact report and hash: protections kept, run ends kept, the recent one kept, the interiors measured', async () => {
    const { p, q } = await everything();
    const run = await counted(ORG_A);
    const report = run.report;
    // P: A run v1..v12 (v1 the baseline, v12 the predecessor, v5..v7
    // named); B run v13..v40 (v13 the change, v21..v40 the picker window,
    // v15 too recent). Q: its 2nd to 6th captures (its first the baseline,
    // the newest 20 the window). R: its one capture
    const candidates = [
      ...[2, 3, 4, 8, 9, 10, 11, 14, 16, 17, 18, 19, 20].map((n) => p.n(n)),
      ...q.rows.slice(1, 6),
    ];
    expect(
      report.candidates.map((c) => [
        c.sourceId === p.id ? 'P' : c.sourceId === q.id ? 'Q' : '?',
        c.versionNumber,
      ])
    ).toEqual(
      candidates
        .slice()
        .sort((a, b) =>
          a.sourceId !== b.sourceId
            ? a.sourceId < b.sourceId
              ? -1
              : 1
            : a.versionNumber - b.versionNumber
        )
        .map((c) => [c.sourceId === p.id ? 'P' : 'Q', c.versionNumber])
    );
    expect(report.candidateSummary).toEqual({
      totalVersions: 67,
      // P: v1, v5, v6, v7, v12, v13, v21..v40; Q: its first and newest 20;
      // R: its one
      protectedVersions: 26 + 21 + 1,
      technicallyUnprotectedVersions: 19,
      policyRetainedVersions: 1,
      policyRetainedByRule: { RUN_BOUNDARY: 0, TOO_RECENT: 1 },
      candidateVersions: 18,
      blockedCandidateVersions: 0,
      blockedSources: 0,
      logicalContentBytes: candidates.reduce(
        (sum, c) => sum + Buffer.byteLength(c.content, 'utf8'),
        0
      ),
      oldestCandidateCreatedAt: '2026-01-01T00:02:00.000Z',
      newestCandidateCreatedAt: '2026-01-01T00:20:00.000Z',
    });
    // PGD9: each candidate's bytes are its stored blocks' UTF-8 length
    for (const candidate of report.candidates) {
      const row = candidates.find((c) => c.id === candidate.id)!;
      expect(candidate.logicalContentBytes).toBe(
        Buffer.byteLength(row.content, 'utf8')
      );
      expect(candidate.logicalContentBytes).toBeGreaterThan(row.content.length);
    }
    expect(report.protectionSummary.edgesByReason).toEqual(
      expect.objectContaining({
        DRAFT_EVIDENCE: 1,
        REVISION_EVIDENCE: 1,
        REVIEW_EVIDENCE: 1,
        AI_OPERATION: 1,
        PAGE_CHANGE: 6,
        LATEST: 3,
      })
    );
    expect(report.snapshot).toEqual({
      isolation: 'repeatable_read',
      sourceCount: 3,
      versionCount: 67,
    });
    expect(report.dryRunHash).toBe(expectedHash(report, candidates));
    expect((await dryRun()).dryRunHash).toBe(report.dryRunHash);
    // one snapshot: the count, one page of each kind, one batch; then one
    // page of blocks
    expect(run.reads).toEqual({
      count: 1,
      sources: 1,
      drafts: 1,
      reviews: 1,
      revisions: 1,
      operations: 1,
      versions: 1,
      contents: 1,
    });
    expect(run.calls).toEqual([
      'countVersions',
      'listSources',
      'listPackageDrafts',
      'listPackageReviews',
      'listPackageRevisions',
      'listOperationContexts',
      'listVersionsOfSources',
    ]);
    // no content, title or URL in the report
    expect(canonicalJson(report)).not.toMatch(
      /Alpha|Beta|P8R1B|p8r1b\.example/
    );
  });

  it('PGD2 one RepeatableRead snapshot: a capture and a draft committed meanwhile are not in it; the next run sees them', async () => {
    const { p } = await everything();
    const before = await dryRun();
    const capture = versionRow(ORG_A, p.id, 41, 'C');
    let committed = false;
    const run = await counted(ORG_A, {
      read: 'listSources',
      run: async () => {
        // another connection, committed before the versions are read
        await other.$transaction([
          other.contentStudioSourceVersion.create({ data: capture }),
          other.contentStudioSource.update({
            where: { id: p.id },
            data: {
              latestVersionNumber: 41,
              lastPageChangeAt: capture.fetchedAt,
              lastPageChangeVersionNumber: 41,
              lastPageChangeKind: 'content_changed',
              lastPageChangePreviousCaptureAt: p.n(40).fetchedAt,
            },
          }),
        ]);
        await insertPackage(ORG_A, grounded([evidence(p.n(2))]), other);
        committed = true;
      },
    });
    expect(committed).toBe(true);
    expect(
      await client.contentStudioSourceVersion.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(68);
    // the run read the organization as it was when it began
    expect(run.report.snapshot.versionCount).toBe(67);
    expect(run.report.dryRunHash).toBe(before.dryRunHash);
    expect(canonicalJson(run.report)).toBe(canonicalJson(before));
    // a fresh run sees both: v2 is a draft's evidence now; v41 moved the
    // picker window, so v21 is an interior nothing protects
    const after = await dryRun();
    expect(after.snapshot.versionCount).toBe(68);
    const numbers = (r: ContentStudioSourceVersionRetentionDryRun) =>
      r.candidates
        .filter((c) => c.sourceId === p.id)
        .map((c) => c.versionNumber);
    expect(numbers(before)).toContain(2);
    expect(numbers(after)).not.toContain(2);
    expect(numbers(after)).toContain(21);
    expect(after.dryRunHash).not.toBe(before.dryRunHash);
  });

  it('PGD2-RC ReadCommitted would see a row committed meanwhile; RepeatableRead does not', async () => {
    const { p } = await everything();
    const read = async (isolationLevel: Prisma.TransactionIsolationLevel) =>
      client.$transaction(
        async (tx) => {
          const first = await tx.contentStudioSourceVersion.count({
            where: { organizationId: ORG_A },
          });
          await other.contentStudioSourceVersion.create({
            data: versionRow(
              ORG_A,
              p.id,
              100 +
                (await other.contentStudioSourceVersion.count({
                  where: { sourceId: p.id },
                })),
              'B'
            ),
          });
          const second = await tx.contentStudioSourceVersion.count({
            where: { organizationId: ORG_A },
          });
          return second - first;
        },
        { isolationLevel }
      );
    expect(await read(Prisma.TransactionIsolationLevel.ReadCommitted)).toBe(1);
    expect(await read(Prisma.TransactionIsolationLevel.RepeatableRead)).toBe(0);
  });

  it('PGD3 the run only reads: every row of every organization is exactly as it was', async () => {
    await everything();
    await insertPage(ORG_B, 'AAAAB');
    const before = await snapshot();
    await dryRun(ORG_A);
    await dryRun(ORG_B);
    await retention.computeProtectionMap({ organizationId: ORG_A, now: NOW });
    expect(await snapshot()).toEqual(before);
  });

  it('PGD4 removing the candidates (here, in this test database only) leaves the real backfill and every change view exactly as they were', async () => {
    // 80 pages of random captures with gaps, and the named ones
    let seed = 1026;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pages = [];
    for (let s = 0; s < 80; s++) {
      let letters = 'ABCDNF'[Math.floor(rnd() * 6)];
      const length = 22 + Math.floor(rnd() * 30);
      while (letters.length < length) {
        letters +=
          rnd() < 0.75
            ? letters[letters.length - 1]
            : 'ABCDNF'[Math.floor(rnd() * 6)];
      }
      let n = 0;
      pages.push(
        await insertPage(ORG_A, letters, {
          numbers: [...letters].map(() => (n += 1 + Math.floor(rnd() * 3))),
        })
      );
    }
    for (const letters of [
      `AAB${'B'.repeat(25)}`,
      `ABA${'A'.repeat(25)}`,
      `AADAA${'A'.repeat(25)}`,
      `AACCC${'C'.repeat(25)}`,
      `AAABBBA${'A'.repeat(25)}`,
    ]) {
      pages.push(await insertPage(ORG_A, letters));
    }
    expect((await backfill()).failed).toBe(0);
    const report = await dryRun();
    expect(report.blockedSources).toEqual([]);
    expect(report.candidates.length).toBeGreaterThan(300);
    const removed = new Set(report.candidates.map((c) => c.id));
    const changes = async (rows: Row[]) =>
      Promise.all(
        rows.map(async (row) =>
          JSON.stringify(
            await sourceService.getVersionChanges({
              organizationId: ORG_A,
              sourceId: row.sourceId,
              versionId: row.id,
            })
          )
        )
      );
    const state = () =>
      client.contentStudioSource.findMany({
        where: { organizationId: ORG_A },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          latestVersionNumber: true,
          lastPageChangeAt: true,
          lastPageChangeVersionNumber: true,
          lastPageChangeKind: true,
          lastPageChangePreviousCaptureAt: true,
        },
      });
    const retained = pages.flatMap((page) =>
      page.rows.filter((row) => !removed.has(row.id))
    );
    const viewsBefore = await changes(retained);
    const stateBefore = await state();
    const protectedBefore = await retention.computeProtectionMap({
      organizationId: ORG_A,
      now: NOW,
    });

    // what an execution would do, done by the test to prove the policy
    const { count } = await client.contentStudioSourceVersion.deleteMany({
      where: { organizationId: ORG_A, id: { in: [...removed] } },
    });
    expect(count).toBe(removed.size);

    // the real backfill finds every source right as it is
    // (every other organization's sources were already right)
    const again = await backfill();
    expect([again.updated, again.failed]).toEqual([0, 0]);
    expect(again.unchanged).toBeGreaterThanOrEqual(pages.length);
    expect(await state()).toEqual(stateBefore);
    // every retained version's change view, blocks and all, byte for byte
    expect(await changes(retained)).toEqual(viewsBefore);
    // and every protection is still there, of the same versions
    const protectedAfter = await retention.computeProtectionMap({
      organizationId: ORG_A,
      now: NOW,
    });
    const roles = (map: typeof protectedAfter) =>
      JSON.stringify(
        [...map]
          .map(([id, list]) => [
            id,
            list
              .filter((e) => e.reason !== 'IN_FLIGHT')
              .map((e) => `${e.reason}:${e.role ?? ''}`),
          ])
          .filter(([, list]) => list.length)
      );
    expect(roles(protectedAfter)).toBe(roles(protectedBefore));
    // and nothing is left to select
    expect((await dryRun()).candidates).toEqual([]);
  }, 120_000);

  it('PGD5 a source whose stored change is older than its versions show is blocked, written nothing; the others go on', async () => {
    const { p } = await everything();
    // a capture appended without its page change (as a broken writer
    // would): v41 C, the stored change still v13
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, p.id, 41, 'C'),
    });
    await client.contentStudioSource.update({
      where: { id: p.id },
      data: { latestVersionNumber: 41 },
    });
    const before = await snapshot();
    const report = await dryRun();
    expect(report.blockedSources).toEqual([
      {
        sourceId: p.id,
        blocker: 'PAGE_CHANGE_STATE_STALE',
        // v2..v4, v8..v11 and v14, v16..v21 (v21 left the picker window)
        suppressedCandidates: 14,
      },
    ]);
    expect(report.candidates.every((c) => c.sourceId !== p.id)).toBe(true);
    // Q's five go on
    expect(report.candidateSummary.candidateVersions).toBe(5);
    expect(report.candidateSummary.blockedCandidateVersions).toBe(14);
    expect(await snapshot()).toEqual(before);
    // the existing repair puts it right, and it is no longer blocked
    expect((await backfill()).updated).toBe(1);
    expect((await dryRun()).blockedSources).toEqual([]);
  });

  it('PGD6 another organization: nothing of it in the report, and its own report is its own', async () => {
    const { p } = await everything();
    const theirs = await insertPage(ORG_B, `${'A'.repeat(30)}B`);
    await backfill();
    await insertPackage(ORG_B, grounded([evidence(theirs.n(3))]));
    const mine = await dryRun(ORG_A);
    const text = canonicalJson(mine);
    for (const row of theirs.rows) {
      expect(text).not.toContain(row.id);
    }
    expect(text).not.toContain(theirs.id);
    expect(text).not.toContain(ORG_B);
    const report = await dryRun(ORG_B);
    expect(report.organizationId).toBe(ORG_B);
    // v1 the baseline, v3 a draft's, v12..v31 the picker window
    expect(report.candidates.map((c) => c.versionNumber)).toEqual([
      2, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(canonicalJson(report)).not.toContain(p.id);
    // an organization with nothing: a report with nothing, and its hash
    const empty = await dryRun(ORG_S);
    expect(empty.candidateSummary.totalVersions).toBe(0);
    expect(empty.dryRunHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PGD7 a reference that is not exactly a version fails the whole run: no report', async () => {
    const { p } = await everything();
    const packageId = await insertPackage(
      ORG_A,
      grounded([{ ...evidence(p.n(3)), contentHash: sha256Hex('other') }])
    );
    const err = await dryRun().then(
      () => {
        throw new Error('expected an integrity error');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
    expect(
      (err as ContentStudioSourceRetentionIntegrityError).reference
    ).toEqual({ type: 'ContentPackage', id: packageId });
    expect((err as Error).message).not.toMatch(
      /P20\d\d|[Pp]risma|SELECT|claim/
    );
    // another organization's version named by ours fails too
    const theirs = await insertPage(ORG_B, 'AAA');
    await client.contentPackage.deleteMany({ where: { id: packageId } });
    await client.contentStudioAIOperation.create({
      data: operationRow(ORG_A, [theirs.n(2)]),
    });
    await expect(dryRun()).rejects.toBeInstanceOf(
      ContentStudioSourceRetentionIntegrityError
    );
  });

  it('PGD8 a snapshot that runs out of time is RETENTION_DRY_RUN_SNAPSHOT_FAILED, with the options it was asked with', async () => {
    await everything();
    const options: unknown[] = [];
    const slow = new ContentStudioSourceRetentionService(
      new ContentStudioSourceRetentionRepository(
        new PrismaRepository<'contentStudioSourceVersion'>(
          client as unknown as PrismaService
        ),
        {
          model: {
            // the real transaction, shortened, and a callback that waits
            $transaction: (
              work: (tx: Prisma.TransactionClient) => Promise<unknown>,
              given: { timeout: number }
            ) => {
              options.push(given);
              return client.$transaction(
                async (tx) => {
                  await new Promise((resolve) => setTimeout(resolve, 400));
                  return work(tx);
                },
                { ...given, timeout: 100 }
              );
            },
          },
        } as unknown as PrismaTransaction
      )
    );
    const err = await slow
      .computeRetentionDryRun({
        organizationId: ORG_A,
        now: NOW,
        policy: POLICY,
      })
      .then(
        () => {
          throw new Error('expected a snapshot failure');
        },
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ContentStudioSourceRetentionDryRunError);
    expect((err as ContentStudioSourceRetentionDryRunError).code).toBe(
      'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
    );
    expect(options).toEqual([
      { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 120_000 },
    ]);
  });
});

// Synthetic scale: `sources` pages of 40 captures (v1..v10 A, v11..v40 B,
// the change at v11), every version old; a draft names v4 of the first
// `drafts`, an AI operation v6 of every page. Per page: v1, v10, v11 the
// change's, v21..v40 the window, v6 (and v4) named: 24 (25) protected, and
// v2..v9 but those and v12..v20 candidates, 16 (15)
const scale = async (
  organizationId: string,
  n: { sources: number; drafts: number }
) => {
  const rows: Row[] = [];
  const pages: { id: string; at: (k: number) => Row }[] = [];
  const sourceRows: Prisma.ContentStudioSourceCreateManyInput[] = [];
  for (let s = 0; s < n.sources; s++) {
    const id = randomUUID();
    const letters = `${'A'.repeat(10)}${'B'.repeat(30)}`;
    const page = sameBlocks(
      [...letters].map((letter, i) =>
        versionRow(organizationId, id, i + 1, letter)
      ),
      letters
    );
    rows.push(...page);
    sourceRows.push({
      id,
      organizationId,
      kind: 'url',
      name: 'P8R1B scale',
      canonicalUrl: `https://p8r1b.example/${id}`,
      createdById: USER[organizationId],
      latestVersionNumber: 40,
      lastPageChangeAt: page[10].fetchedAt,
      lastPageChangeVersionNumber: 11,
      lastPageChangeKind: 'content_changed',
      lastPageChangePreviousCaptureAt: page[9].fetchedAt,
    });
    pages.push({ id, at: (k: number) => page[k - 1] });
  }
  await client.contentStudioSource.createMany({ data: sourceRows });
  for (let i = 0; i < rows.length; i += 5000) {
    await client.contentStudioSourceVersion.createMany({
      data: rows.slice(i, i + 5000),
    });
  }
  await client.contentPackage.createMany({
    data: pages.slice(0, n.drafts).map((page) => ({
      id: randomUUID(),
      organizationId,
      name: 'P8R1B scale',
      draft: JSON.stringify(grounded([evidence(page.at(4))])),
      createdById: USER[organizationId],
    })),
  });
  await client.contentStudioAIOperation.createMany({
    data: pages.map((page) => operationRow(organizationId, [page.at(6)])),
  });
  return {
    versions: rows.length,
    candidates: n.sources * 16 - n.drafts,
  };
};

describe('P8-R1B scale on PostgreSQL', () => {
  it('PGD-S1 10,000 versions: exact counts, reads by batch and page, no row changed', async () => {
    const expected = await scale(ORG_S, { sources: 250, drafts: 50 });
    const before = await snapshot();
    const run = await counted(ORG_S);
    expect(expected).toEqual({ versions: 10_000, candidates: 3950 });
    expect(run.report.candidateSummary.totalVersions).toBe(10_000);
    expect(run.report.candidateSummary.candidateVersions).toBe(3950);
    expect(run.report.candidateSummary.protectedVersions).toBe(250 * 24 + 50);
    expect(run.reads).toEqual({
      count: 1,
      sources: 1,
      drafts: 1,
      reviews: 1,
      revisions: 1,
      operations: 1,
      versions: 2,
      contents: 8,
    });
    // eslint-disable-next-line no-console
    console.log(
      `PGD-S1 10k: ${run.ms.toFixed(0)} ms, candidates ${
        run.report.candidateSummary.candidateVersions
      }, protected ${run.report.candidateSummary.protectedVersions}, bytes ${
        run.report.candidateSummary.logicalContentBytes
      }, version batches ${run.reads.versions}, content pages ${
        run.reads.contents
      }, heap in use ${run.heapUsedMB} MB`
    );
    expect(await snapshot()).toEqual(before);
    await clean([ORG_S]);
  }, 300_000);

  it('PGD-S2 100,000 versions: the same, in 13 batches of sources', async () => {
    const expected = await scale(ORG_S, { sources: 2500, drafts: 500 });
    const run = await counted(ORG_S);
    expect(expected).toEqual({ versions: 100_000, candidates: 39_500 });
    expect(run.report.candidateSummary.candidateVersions).toBe(39_500);
    expect(run.report.candidateSummary.protectedVersions).toBe(2500 * 24 + 500);
    expect(run.reads).toEqual({
      count: 1,
      sources: 1,
      // 500 drafts: a full page, then an empty one
      drafts: 2,
      reviews: 1,
      revisions: 1,
      // 2,500 AI operations: 5 full pages, then an empty one
      operations: 6,
      versions: 13,
      // 39,500 candidates measured in pages of 500
      contents: 79,
    });
    expect(run.report.dryRunHash).toBe((await dryRun(ORG_S)).dryRunHash);
    // eslint-disable-next-line no-console
    console.log(
      `PGD-S2 100k: ${run.ms.toFixed(0)} ms, candidates ${
        run.report.candidateSummary.candidateVersions
      }, protected ${run.report.candidateSummary.protectedVersions}, bytes ${
        run.report.candidateSummary.logicalContentBytes
      }, version batches ${run.reads.versions}, content pages ${
        run.reads.contents
      }, heap in use ${run.heapUsedMB} MB`
    );
    await clean([ORG_S]);
  }, 600_000);
});
