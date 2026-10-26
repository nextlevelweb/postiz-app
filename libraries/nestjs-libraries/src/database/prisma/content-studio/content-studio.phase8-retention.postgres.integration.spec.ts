import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioReviewRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionProtectionMap,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Source version protection (P8-R1A) on a real PostgreSQL: the protection
// map and the explanation of one version from real rows of every kind,
// read by the real repositories in organization-scoped pages: the exact set,
// another organization, corrupt references, archived and soft-deleted
// records, gaps, repeats, the picker window and the age cutoff, and 10,000
// and 100,000 versions. Evaluation only reads: every version is the same
// after it. Opt-in: runs only through jest.content-studio.integration.config.ts
// against the disposable local database. Nothing is fetched

const ORG_A = '30a1a000-0000-4000-8000-00000000000a';
const ORG_B = '30a1a000-0000-4000-8000-00000000000b';
const ORG_C = '30a1a000-0000-4000-8000-00000000000c';
const ORG_S = '30a1a000-0000-4000-8000-00000000000d';
const ORGS = [ORG_A, ORG_B, ORG_C, ORG_S];
const USER: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1a000-0000-4000-8000-0000000000${i + 1}1`])
);
const CONNECTION: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1a000-0000-4000-8000-0000000000${i + 1}2`])
);
const NOW = new Date('2026-10-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LONG_AGO = Date.UTC(2026, 0, 1);
const X2 = 'content-studio-source-v2';

let client: PrismaClient;
let sources: ContentStudioSourceRepository;
let packages: ContentStudioRepository;
let reviews: ContentStudioReviewRepository;
let operations: ContentStudioAIOperationRepository;
let retention: ContentStudioSourceRetentionService;
let sourceService: ContentStudioSourceService;

type Capture = {
  n: number;
  text?: string;
  title?: string | null;
  createdAt?: Date;
};
interface Version {
  id: string;
  sourceId: string;
  versionNumber: number;
  contentHash: string;
  fetchedAt: Date;
}

const versionRow = (
  organizationId: string,
  sourceId: string,
  capture: Capture
) => ({
  id: randomUUID(),
  organizationId,
  sourceId,
  versionNumber: capture.n,
  extractionVersion: X2,
  requestedUrl: 'https://p8r1a.example/page',
  finalUrl: 'https://p8r1a.example/page',
  redirectCount: 0,
  fetchedAt: new Date(LONG_AGO + capture.n * 60_000),
  httpStatus: 200,
  contentType: 'text/html',
  contentLength: 100,
  title: capture.title === undefined ? 'P8R1A' : capture.title,
  sourceHash: null,
  createdById: USER[organizationId],
  createdAt: capture.createdAt ?? new Date(LONG_AGO + capture.n * 60_000),
  ...storedContentStudioSourceContent({
    schemaVersion: 1,
    blocks: [
      {
        id: 'b1',
        type: 'paragraph',
        text: capture.text ?? 'A',
        level: null,
      },
    ],
  }),
});

// A page source with these captures and, when given, its last page change
// as captures store it: against the version before it that exists
const insertPage = async (
  organizationId: string,
  captures: Capture[],
  options: {
    change?: number;
    archivedAt?: Date;
    over?: Prisma.ContentStudioSourceUncheckedCreateInput | object;
  } = {}
) => {
  const id = randomUUID();
  const rows = captures.map((capture) =>
    versionRow(organizationId, id, capture)
  );
  const at = (n: number) => rows.find((row) => row.versionNumber === n)!;
  const before = options.change
    ? rows
        .filter((row) => row.versionNumber < options.change!)
        .sort((a, b) => b.versionNumber - a.versionNumber)[0]
    : null;
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8R1A page',
      canonicalUrl: `https://p8r1a.example/${id}`,
      createdById: USER[organizationId],
      latestVersionNumber: Math.max(0, ...captures.map((c) => c.n)),
      archivedAt: options.archivedAt ?? null,
      ...(options.change
        ? {
            lastPageChangeAt: at(options.change).fetchedAt,
            lastPageChangeVersionNumber: options.change,
            lastPageChangeKind: 'content_changed',
            lastPageChangePreviousCaptureAt: before!.fetchedAt,
          }
        : {}),
      ...options.over,
    },
  });
  for (let i = 0; i < rows.length; i += 5000) {
    await client.contentStudioSourceVersion.createMany({
      data: rows.slice(i, i + 5000),
    });
  }
  const versions: Version[] = rows.map((row) => ({
    id: row.id,
    sourceId: id,
    versionNumber: row.versionNumber,
    contentHash: row.contentHash,
    fetchedAt: row.fetchedAt,
  }));
  return {
    id,
    versions,
    at: (n: number) => versions.find((v) => v.versionNumber === n)!,
  };
};
const old = (count: number, text = 'A') =>
  Array.from({ length: count }, (_, i) => ({ n: i + 1, text }));

const evidence = (v: Version, blockId = 'b1') => ({
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
  blockId,
  quote: null,
});
const THREAD = { global: { thread: [{ id: 'i1', text: 'x', mediaIds: [] }] } };
const grounded = (claims: ReturnType<typeof evidence>[][]) => ({
  schemaVersion: 2,
  copy: THREAD,
  grounding: {
    claims: claims.map((list, i) => ({
      id: `c_p8r1a_claim_${i}`,
      threadItemId: 'i1',
      text: 'A claim',
      evidence: list,
    })),
  },
});
const ungrounded = { schemaVersion: 1, copy: THREAD };

const insertPackage = async (
  organizationId: string,
  draft: unknown,
  archivedAt: Date | null = null
) => {
  const id = randomUUID();
  await client.contentPackage.create({
    data: {
      id,
      organizationId,
      name: 'P8R1A package',
      draft: typeof draft === 'string' ? draft : JSON.stringify(draft),
      createdById: USER[organizationId],
      archivedAt,
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
const insertRevision = async (
  organizationId: string,
  packageId: string,
  revisionNumber: number,
  draft: unknown
) => {
  const row = revisionRow(organizationId, packageId, revisionNumber, draft);
  await client.contentPackageRevision.create({ data: row });
  return row;
};
const reviewRow = (
  organizationId: string,
  revision: { id: string; contentHash: string },
  state = 'APPROVED'
) => ({
  id: randomUUID(),
  organizationId,
  packageRevisionId: revision.id,
  targetContentHash: revision.contentHash,
  state,
  requestedById: USER[organizationId],
});
const insertReview = async (
  organizationId: string,
  revision: { id: string; contentHash: string },
  state = 'APPROVED'
) => {
  const row = reviewRow(organizationId, revision, state);
  await client.contentStudioReview.create({ data: row });
  return row.id;
};
const sourceRef = (v: Version) => ({
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
});
const operationRow = (
  organizationId: string,
  context: unknown,
  status = 'succeeded'
) => ({
  id: randomUUID(),
  organizationId,
  userId: USER[organizationId],
  connectionId: CONNECTION[organizationId],
  packageId: null,
  kind: 'generate_item',
  status,
  provider: 'openai',
  model: 'gpt-test',
  promptVersion: 'cs-item-v1',
  context: context as Prisma.InputJsonValue,
  requestHash: sha256Hex('request'),
});
const insertOperation = async (
  organizationId: string,
  context: unknown,
  status = 'succeeded'
) => {
  const row = operationRow(organizationId, context, status);
  await client.contentStudioAIOperation.create({ data: row });
  return row.id;
};

const compute = (organizationId = ORG_A, now = NOW) =>
  retention.computeProtectionMap({ organizationId, now });
const explain = (sourceVersionId: string, organizationId = ORG_A) =>
  retention.explainRetentionEligibility({
    organizationId,
    sourceVersionId,
    now: NOW,
  });
const labels = (map: ContentStudioSourceVersionProtectionMap, v: Version) =>
  (map.get(v.id) ?? []).map((p) =>
    [p.reason, p.role].filter(Boolean).join(':')
  );
const failure = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => {
      throw new Error('expected an integrity error');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
  expect((err as Error).message).not.toMatch(
    /P20\d\d|[Pp]risma|SELECT|p8r1a\.example|claim/
  );
  return (err as ContentStudioSourceRetentionIntegrityError).reference;
};

// every version of the organizations as stored, and the sources' state
const snapshot = async () => ({
  versions: await client.contentStudioSourceVersion.findMany({
    where: { organizationId: { in: ORGS } },
    orderBy: { id: 'asc' },
  }),
  sources: await client.contentStudioSource.findMany({
    where: { organizationId: { in: ORGS } },
    orderBy: { id: 'asc' },
  }),
  packages: await client.contentPackage.count({
    where: { organizationId: { in: ORGS } },
  }),
  revisions: await client.contentPackageRevision.count({
    where: { organizationId: { in: ORGS } },
  }),
  reviews: await client.contentStudioReview.count({
    where: { organizationId: { in: ORGS } },
  }),
  operations: await client.contentStudioAIOperation.count({
    where: { organizationId: { in: ORGS } },
  }),
});

const clean = async (orgs = ORGS) => {
  const where = { organizationId: { in: orgs } };
  await client.contentStudioReview.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
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
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  const transaction = new PrismaTransaction(prisma);
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  packages = new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(prisma),
    new PrismaRepository<'contentPackage'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    transaction
  );
  reviews = new ContentStudioReviewRepository(
    new PrismaRepository<'contentStudioReview'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    new PrismaRepository<'contentStudioDesignRevision'>(prisma),
    new PrismaRepository<'contentStudioReviewComment'>(prisma),
    new PrismaRepository<'contentStudioReviewRevisionRequest'>(prisma),
    new PrismaRepository<'contentStudioReviewClaim'>(prisma),
    new PrismaRepository<'contentStudioApproval'>(prisma),
    transaction
  );
  operations = new ContentStudioAIOperationRepository(
    new PrismaRepository<'contentStudioAIOperation'>(prisma),
    transaction
  );
  retention = new ContentStudioSourceRetentionService(
    sources,
    packages,
    reviews,
    operations
  );
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
      data: {
        id: org,
        name: `P8R1A ${org}`,
        // C is soft-deleted: it is evaluated like any other when asked
        deletedAt: org === ORG_C ? new Date('2026-06-01') : null,
      },
    });
    await client.user.create({
      data: {
        id: USER[org],
        email: `${USER[org]}@p8r1a.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8R1A ${org}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: USER[org], organizationId: org, role: 'USER' },
    });
    await client.contentStudioAIConnection.create({
      data: {
        id: CONNECTION[org],
        organizationId: org,
        name: 'P8R1A',
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
});

// One organization with every kind of protection: a page of 30 versions
// (v1 Z, v2..v4 A, v5..v30 B) with its change at v5, all old but v30, made
// an hour ago; a draft naming v6, a revision and its review v7, an AI
// operation v8
const everything = async () => {
  const page = await insertPage(
    ORG_A,
    Array.from({ length: 30 }, (_, i) => ({
      n: i + 1,
      text: i === 0 ? 'Z' : i < 4 ? 'A' : 'B',
      createdAt: i === 29 ? new Date(NOW.getTime() - HOUR) : undefined,
    })),
    { change: 5 }
  );
  const packageId = await insertPackage(
    ORG_A,
    grounded([[evidence(page.at(6))]])
  );
  const revision = await insertRevision(
    ORG_A,
    packageId,
    1,
    grounded([[evidence(page.at(7))]])
  );
  const reviewId = await insertReview(ORG_A, revision);
  const operationId = await insertOperation(ORG_A, {
    v: 1,
    itemId: 'i1',
    sources: [sourceRef(page.at(8))],
  });
  return { page, packageId, revision, reviewId, operationId };
};

describe('P8-R1A source version protection on PostgreSQL', () => {
  it('P8R1APG1 the exact protected set of an organization with every kind of protection; the change view uses the same baseline', async () => {
    const { page, packageId, revision, reviewId, operationId } =
      await everything();
    const map = await compute();
    const summary = Object.fromEntries(
      page.versions
        .filter((v) => map.has(v.id))
        .map((v) => [v.versionNumber, labels(map, v)])
    );
    expect(summary).toEqual({
      2: ['PAGE_CHANGE:comparison_baseline'],
      4: ['PAGE_CHANGE:predecessor'],
      5: ['PAGE_CHANGE:changed'],
      6: ['DRAFT_EVIDENCE'],
      7: ['REVISION_EVIDENCE', 'REVIEW_EVIDENCE'],
      8: ['AI_OPERATION'],
      ...Object.fromEntries(
        Array.from({ length: 19 }, (_, i) => [
          i + 11,
          ['IN_FLIGHT:picker_window'],
        ])
      ),
      30: ['LATEST:latest', 'IN_FLIGHT:picker_window', 'IN_FLIGHT:age'],
    });
    expect(map.get(page.at(7).id)!.map((p) => p.referenceId)).toEqual([
      revision.id,
      reviewId,
    ]);
    expect(map.get(page.at(6).id)![0].referenceId).toBe(packageId);
    expect(map.get(page.at(8).id)![0].referenceId).toBe(operationId);
    expect(
      page.versions.filter((v) => !map.has(v.id)).map((v) => v.versionNumber)
    ).toEqual([1, 3, 9, 10]);
    // what Changes shows v5 against is the protected baseline (PD6)
    const changes = await sourceService.getVersionChanges({
      organizationId: ORG_A,
      sourceId: page.id,
      versionId: page.at(5).id,
    });
    expect(changes.before!.id).toBe(page.at(2).id);
    // the map is the same however often it is made
    expect(JSON.stringify([...(await compute())])).toBe(
      JSON.stringify([...map])
    );
  });

  it('P8R1APG2 another organization: none of its versions or records in the map, and it has its own', async () => {
    const mine = await everything();
    const theirs = await insertPage(ORG_B, old(25));
    const theirPackage = await insertPackage(
      ORG_B,
      grounded([[evidence(theirs.at(1))]])
    );
    const theirRevision = await insertRevision(
      ORG_B,
      theirPackage,
      1,
      grounded([[evidence(theirs.at(2))]])
    );
    await insertReview(ORG_B, theirRevision);
    await insertOperation(ORG_B, { v: 1, sources: [sourceRef(theirs.at(3))] });
    const map = await compute();
    const ids = new Set(theirs.versions.map((v) => v.id));
    expect([...map.keys()].filter((id) => ids.has(id))).toEqual([]);
    expect(
      [...map.values()]
        .flat()
        .filter(
          (p) =>
            p.organizationId !== ORG_A ||
            [theirPackage, theirRevision.id as string].includes(p.referenceId)
        )
    ).toEqual([]);
    expect(map.has(mine.page.at(30).id)).toBe(true);
    const other = await compute(ORG_B);
    expect(labels(other, theirs.at(1))).toEqual(['DRAFT_EVIDENCE']);
    expect(labels(other, theirs.at(2))).toEqual([
      'REVISION_EVIDENCE',
      'REVIEW_EVIDENCE',
    ]);
    expect(labels(other, theirs.at(3))).toEqual(['AI_OPERATION']);
    expect([...other.keys()].some((id) => map.has(id))).toBe(false);
  });

  it("P8R1APG3 a draft, revision or AI operation naming another organization's version fails the whole organization", async () => {
    const theirs = await insertPage(ORG_B, old(3));
    for (const kind of ['draft', 'revision', 'operation'] as const) {
      await clean([ORG_A]);
      await everything();
      const named = evidence(theirs.at(1));
      let id: string;
      if (kind === 'draft') {
        id = await insertPackage(ORG_A, grounded([[named]]));
      } else if (kind === 'revision') {
        const packageId = await insertPackage(ORG_A, ungrounded);
        id = (await insertRevision(ORG_A, packageId, 1, grounded([[named]])))
          .id;
      } else {
        id = await insertOperation(ORG_A, {
          v: 1,
          sources: [sourceRef(theirs.at(1))],
        });
      }
      expect(await failure(compute())).toEqual({
        type: {
          draft: 'ContentPackage',
          revision: 'ContentPackageRevision',
          operation: 'ContentStudioAIOperation',
        }[kind],
        id,
      });
    }
    // B itself is fine
    expect((await compute(ORG_B)).size).toBe(3);
  });

  it('P8R1APG4 a reference to a version that is not there, or not exactly as named, fails', async () => {
    const { page } = await everything();
    for (const broken of [
      { versionId: randomUUID() },
      { versionNumber: 9 },
      { contentHash: sha256Hex('other') },
    ]) {
      const id = await insertPackage(
        ORG_A,
        grounded([[{ ...evidence(page.at(10)), ...broken }]])
      );
      expect(await failure(compute())).toEqual({
        type: 'ContentPackage',
        id,
      });
      await client.contentPackage.delete({ where: { id } });
    }
    expect((await compute()).size).toBeGreaterThan(0);
  });

  it('P8R1APG5 a current version that is not there, or a version beyond it, fails', async () => {
    const { page } = await everything();
    await client.contentStudioSource.update({
      where: { id: page.id },
      data: { latestVersionNumber: 31 },
    });
    expect(await failure(compute())).toEqual({
      type: 'ContentStudioSource',
      id: page.id,
    });
    await client.contentStudioSource.update({
      where: { id: page.id },
      data: { latestVersionNumber: 29 },
    });
    expect(await failure(compute())).toEqual({
      type: 'ContentStudioSource',
      id: page.id,
    });
    await client.contentStudioSource.update({
      where: { id: page.id },
      data: { latestVersionNumber: 30 },
    });
    expect((await compute()).has(page.at(30).id)).toBe(true);
  });

  it('P8R1APG6 a change state that its versions do not show fails: no changed version, other times, a partial state', async () => {
    const { page } = await everything();
    for (const data of [
      { lastPageChangeVersionNumber: 4 },
      { lastPageChangeAt: new Date(NOW.getTime()) },
      { lastPageChangePreviousCaptureAt: page.at(3).fetchedAt },
      { lastPageChangeKind: null },
      { lastPageChangeKind: 'title_changed' },
    ]) {
      await client.contentStudioSource.update({
        where: { id: page.id },
        data,
      });
      expect(await failure(compute())).toEqual({
        type: 'ContentStudioSource',
        id: page.id,
      });
      await client.contentStudioSource.update({
        where: { id: page.id },
        data: {
          lastPageChangeAt: page.at(5).fetchedAt,
          lastPageChangeVersionNumber: 5,
          lastPageChangeKind: 'content_changed',
          lastPageChangePreviousCaptureAt: page.at(4).fetchedAt,
        },
      });
    }
    // a changed version that is gone
    const gone = await insertPage(
      ORG_B,
      [{ n: 1 }, { n: 2, text: 'B' }, { n: 3, text: 'B' }],
      {
        change: 2,
      }
    );
    await client.contentStudioSourceVersion.delete({
      where: { id: gone.at(2).id },
    });
    expect(await failure(compute(ORG_B))).toEqual({
      type: 'ContentStudioSource',
      id: gone.id,
    });
    expect((await compute()).size).toBeGreaterThan(0);
  });

  it('P8R1APG7/P8R1APG9 an archived source, and a soft-deleted organization, keep every protection', async () => {
    const page = await insertPage(ORG_A, old(25), {
      archivedAt: new Date('2026-05-01'),
    });
    expect(labels(await compute(), page.at(25))).toEqual([
      'LATEST:latest',
      'IN_FLIGHT:picker_window',
    ]);
    const deleted = await insertPage(
      ORG_C,
      [
        ...old(4),
        { n: 5, text: 'B' },
        ...Array.from({ length: 20 }, (_, i) => ({ n: i + 6, text: 'B' })),
      ],
      { change: 5 }
    );
    const packageId = await insertPackage(
      ORG_C,
      grounded([[evidence(deleted.at(2))]])
    );
    await insertRevision(
      ORG_C,
      packageId,
      1,
      grounded([[evidence(deleted.at(3))]])
    );
    const map = await compute(ORG_C);
    expect(labels(map, deleted.at(1))).toEqual([
      'PAGE_CHANGE:comparison_baseline',
    ]);
    expect(labels(map, deleted.at(2))).toEqual(['DRAFT_EVIDENCE']);
    expect(labels(map, deleted.at(3))).toEqual(['REVISION_EVIDENCE']);
    expect(labels(map, deleted.at(4))).toEqual(['PAGE_CHANGE:predecessor']);
    expect(labels(map, deleted.at(25))).toEqual([
      'LATEST:latest',
      'IN_FLIGHT:picker_window',
    ]);
  });

  it('P8R1APG8 an archived package still protects through its draft, its revisions and their review', async () => {
    const page = await insertPage(ORG_A, old(25));
    const packageId = await insertPackage(
      ORG_A,
      grounded([[evidence(page.at(1))]]),
      new Date('2026-04-01')
    );
    const first = await insertRevision(
      ORG_A,
      packageId,
      1,
      grounded([[evidence(page.at(2))]])
    );
    await insertRevision(
      ORG_A,
      packageId,
      2,
      grounded([[evidence(page.at(3))]])
    );
    await insertReview(ORG_A, first, 'CHANGES_REQUESTED');
    const map = await compute();
    expect([1, 2, 3, 4].map((n) => labels(map, page.at(n)))).toEqual([
      ['DRAFT_EVIDENCE'],
      ['REVISION_EVIDENCE', 'REVIEW_EVIDENCE'],
      ['REVISION_EVIDENCE'],
      [],
    ]);
  });

  it('P8R1APG10 gaps: the predecessor and baseline are the versions that exist (v1 A, v3 A, v7 B), as the change view finds them', async () => {
    const page = await insertPage(
      ORG_A,
      [
        { n: 1 },
        { n: 3 },
        { n: 7, text: 'B' },
        ...Array.from({ length: 20 }, (_, i) => ({ n: 9 + i * 2, text: 'B' })),
      ],
      { change: 7 }
    );
    const map = await compute();
    expect([1, 3, 7].map((n) => labels(map, page.at(n)))).toEqual([
      ['PAGE_CHANGE:comparison_baseline'],
      ['PAGE_CHANGE:predecessor'],
      ['PAGE_CHANGE:changed'],
    ]);
    // the window is the newest 20 that exist: v9..v47, so v7 is not in it
    expect(
      page.versions
        .filter((v) =>
          (map.get(v.id) ?? []).some((p) => p.role === 'picker_window')
        )
        .map((v) => v.versionNumber)
    ).toEqual(Array.from({ length: 20 }, (_, i) => 9 + i * 2));
    const changes = await sourceService.getVersionChanges({
      organizationId: ORG_A,
      sourceId: page.id,
      versionId: page.at(7).id,
    });
    expect(changes.before!.id).toBe(page.at(1).id);
  });

  it('P8R1APG11 one version named twice by a package, by two revisions, a review and an AI operation: each record once', async () => {
    const page = await insertPage(ORG_A, old(25));
    const v = page.at(2);
    const packageId = await insertPackage(
      ORG_A,
      grounded([[evidence(v), evidence(v, 'b2')], [evidence(v)]])
    );
    const r1 = await insertRevision(
      ORG_A,
      packageId,
      1,
      grounded([[evidence(v)], [evidence(v, 'b2')]])
    );
    const r2 = await insertRevision(
      ORG_A,
      packageId,
      2,
      grounded([[evidence(v)]])
    );
    const reviewId = await insertReview(ORG_A, r1);
    const opId = await insertOperation(ORG_A, {
      v: 1,
      sources: [sourceRef(v)],
    });
    const protections = (await compute()).get(v.id)!;
    expect(protections.map((p) => `${p.reason}:${p.referenceId}`)).toEqual([
      `DRAFT_EVIDENCE:${packageId}`,
      ...[r1.id, r2.id].sort().map((id) => `REVISION_EVIDENCE:${id}`),
      `REVIEW_EVIDENCE:${reviewId}`,
      `AI_OPERATION:${opId}`,
    ]);
  });

  it('P8R1APG12 an old version nothing names, out of the window, is eligible in principle; one that is not there is not found', async () => {
    const { page } = await everything();
    expect(await explain(page.at(9).id)).toEqual({
      sourceVersionId: page.at(9).id,
      eligibleInPrinciple: true,
      protections: [],
    });
    const protectedOne = await explain(page.at(7).id);
    expect(protectedOne.eligibleInPrinciple).toBe(false);
    expect(protectedOne.protections.map((p) => p.reason)).toEqual([
      'REVISION_EVIDENCE',
      'REVIEW_EVIDENCE',
    ]);
    const theirs = await insertPage(ORG_B, old(1));
    for (const id of [randomUUID(), theirs.at(1).id]) {
      const err = await explain(id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(404);
    }
  });

  it('P8R1APG13 25 old versions: the newest 20 are in the picker window, the oldest 5 only by what else names them', async () => {
    const page = await insertPage(ORG_A, old(25));
    await insertOperation(ORG_A, { v: 1, sources: [sourceRef(page.at(2))] });
    const map = await compute();
    expect(page.versions.map((v) => labels(map, v))).toEqual([
      [],
      ['AI_OPERATION'],
      [],
      [],
      [],
      ...Array.from({ length: 19 }, () => ['IN_FLIGHT:picker_window']),
      ['LATEST:latest', 'IN_FLIGHT:picker_window'],
    ]);
  });

  it('P8R1APG14 the age cutoff: made at now - 24h exactly is protected, a millisecond earlier is not', async () => {
    const cutoff = NOW.getTime() - DAY;
    const page = await insertPage(
      ORG_A,
      Array.from({ length: 25 }, (_, i) => ({
        n: i + 1,
        createdAt:
          i === 0
            ? new Date(cutoff - 1)
            : i === 1
            ? new Date(cutoff)
            : undefined,
      }))
    );
    const map = await compute();
    expect(labels(map, page.at(1))).toEqual([]);
    expect(labels(map, page.at(2))).toEqual(['IN_FLIGHT:age']);
    // a day later, neither
    const later = await compute(ORG_A, new Date(NOW.getTime() + DAY));
    expect(labels(later, page.at(2))).toEqual([]);
  });

  it('P8R1APG18 AI operations protect whatever their status; a design operation protects nothing', async () => {
    const page = await insertPage(ORG_A, old(25));
    const [running, succeeded, failed] = [
      await insertOperation(
        ORG_A,
        { v: 1, sources: [sourceRef(page.at(1))] },
        'running'
      ),
      await insertOperation(
        ORG_A,
        { v: 1, sources: [sourceRef(page.at(2))] },
        'succeeded'
      ),
      await insertOperation(
        ORG_A,
        { v: 1, sources: [sourceRef(page.at(3))] },
        'failed'
      ),
    ];
    await insertOperation(ORG_A, {
      v: 1,
      design: {
        designId: randomUUID(),
        revisionId: randomUUID(),
        revisionNumber: 1,
        contentHash: sha256Hex('design'),
      },
    });
    const map = await compute();
    expect(
      [1, 2, 3, 4].map((n) =>
        (map.get(page.at(n).id) ?? []).map(
          (p) => `${p.reason}:${p.referenceId}`
        )
      )
    ).toEqual([
      [`AI_OPERATION:${running}`],
      [`AI_OPERATION:${succeeded}`],
      [`AI_OPERATION:${failed}`],
      [],
    ]);
  });

  it('P8R1APG17 an empty organization has an empty map', async () => {
    expect((await compute(ORG_B)).size).toBe(0);
  });
});

// Synthetic scale: `sources` pages of 40 versions (v1 A, v2 A, v3 B..v40
// B, a change at v3), every version old. Drafts name v4 of the first
// `drafts` sources, revisions v5 of the first `revisions`, reviews the first
// `reviewed` of those revisions, an operation v6 of every source and a
// second one v7 of the first `drafts`. Per source v1..v3, v21..v40 and v6
// are protected; so the exact counts are known
const scale = async (
  organizationId: string,
  n: { sources: number; drafts: number; revisions: number; reviewed: number }
) => {
  const versionRows: ReturnType<typeof versionRow>[] = [];
  const pages: { id: string; at: (n: number) => Version }[] = [];
  const sourceRows: Prisma.ContentStudioSourceCreateManyInput[] = [];
  for (let s = 0; s < n.sources; s++) {
    const id = randomUUID();
    const rows = Array.from({ length: 40 }, (_, i) =>
      versionRow(organizationId, id, { n: i + 1, text: i < 2 ? 'A' : 'B' })
    );
    versionRows.push(...rows);
    sourceRows.push({
      id,
      organizationId,
      kind: 'url',
      name: 'P8R1A scale',
      canonicalUrl: `https://p8r1a.example/${id}`,
      createdById: USER[organizationId],
      latestVersionNumber: 40,
      lastPageChangeAt: rows[2].fetchedAt,
      lastPageChangeVersionNumber: 3,
      lastPageChangeKind: 'content_changed',
      lastPageChangePreviousCaptureAt: rows[1].fetchedAt,
    });
    pages.push({
      id,
      at: (k: number) => ({
        id: rows[k - 1].id,
        sourceId: id,
        versionNumber: k,
        contentHash: rows[k - 1].contentHash,
        fetchedAt: rows[k - 1].fetchedAt,
      }),
    });
  }
  await client.contentStudioSource.createMany({ data: sourceRows });
  for (let i = 0; i < versionRows.length; i += 5000) {
    await client.contentStudioSourceVersion.createMany({
      data: versionRows.slice(i, i + 5000),
    });
  }
  const packageId = await insertPackage(organizationId, ungrounded);
  await client.contentPackage.createMany({
    data: pages.slice(0, n.drafts).map((page) => ({
      id: randomUUID(),
      organizationId,
      name: 'P8R1A scale',
      draft: JSON.stringify(grounded([[evidence(page.at(4))]])),
      createdById: USER[organizationId],
    })),
  });
  const revisions = pages
    .slice(0, n.revisions)
    .map((page, i) =>
      revisionRow(
        organizationId,
        packageId,
        i + 1,
        grounded([[evidence(page.at(5))]])
      )
    );
  await client.contentPackageRevision.createMany({ data: revisions });
  await client.contentStudioReview.createMany({
    data: revisions
      .slice(0, n.reviewed)
      .map((revision) => reviewRow(organizationId, revision)),
  });
  await client.contentStudioAIOperation.createMany({
    data: [
      ...pages.map((page) =>
        operationRow(organizationId, { v: 1, sources: [sourceRef(page.at(6))] })
      ),
      ...pages
        .slice(0, n.drafts)
        .map((page) =>
          operationRow(
            organizationId,
            { v: 1, sources: [sourceRef(page.at(7))] },
            'failed'
          )
        ),
    ],
  });
  return {
    versions: versionRows.length,
    protected: n.sources * 24 + n.drafts * 2 + n.revisions,
  };
};

// The reads the service makes, counted on the real repositories
const counted = async (organizationId: string) => {
  const spies = [
    jest.spyOn(sources, 'listSourcesForVersionProtection'),
    jest.spyOn(sources, 'listVersionsForProtection'),
    jest.spyOn(packages, 'listPackageDraftsForVersionProtection'),
    jest.spyOn(reviews, 'listPackageReviewsForVersionProtection'),
    jest.spyOn(packages, 'listPackageRevisionsForVersionProtection'),
    jest.spyOn(operations, 'listOperationContextsForVersionProtection'),
  ];
  const started = process.hrtime.bigint();
  const map = await compute(organizationId);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const reads = spies.map((spy) => spy.mock.calls.length);
  const takes = spies.flatMap((spy) =>
    spy.mock.calls.map(([input]) => (input as { take: number }).take)
  );
  spies.forEach((spy) => spy.mockRestore());
  return {
    map,
    ms,
    reads,
    takes,
    // in use while the map is held, with the test's own rows
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1e6),
  };
};

describe('P8-R1A scale on PostgreSQL', () => {
  it('P8R1APG15 10,000 versions: exact counts, bounded pages, one read per kind and page', async () => {
    const expected = await scale(ORG_S, {
      sources: 250,
      drafts: 50,
      revisions: 200,
      reviewed: 50,
    });
    const before = await snapshot();
    const run = await counted(ORG_S);
    expect(expected).toEqual({ versions: 10_000, protected: 6300 });
    expect(run.map.size).toBe(6300);
    expect(run.reads).toEqual([1, 2, 1, 1, 1, 1]);
    expect(Math.max(...run.takes)).toBe(10_000);
    const edges = [...run.map.values()].flat().length;
    // eslint-disable-next-line no-console
    console.log(
      `P8R1APG15 10k: ${run.ms.toFixed(0)} ms, reads ${run.reads.join(
        '/'
      )}, edges ${edges}, protected ${run.map.size}, eligibleInPrinciple ${
        expected.versions - run.map.size
      }, heap in use ${run.heapUsedMB} MB`
    );
    expect(await snapshot()).toEqual(before);
    await clean([ORG_S]);
  }, 300_000);

  it('P8R1APG16 100,000 versions: exact counts, the same reads by page, no row changed', async () => {
    const expected = await scale(ORG_S, {
      sources: 2500,
      drafts: 500,
      revisions: 2000,
      reviewed: 500,
    });
    const before = await snapshot();
    const run = await counted(ORG_S);
    expect(expected).toEqual({ versions: 100_000, protected: 63_000 });
    expect(run.map.size).toBe(63_000);
    // 2,500 sources; 100,000 versions in 10 full pages and an empty one;
    // 500 drafts (a full page, then none); 500 reviews; 2,000 revisions
    // and 3,000 operations in pages of 500
    expect(run.reads).toEqual([1, 11, 2, 1, 5, 7]);
    const edges = [...run.map.values()].flat().length;
    // eslint-disable-next-line no-console
    console.log(
      `P8R1APG16 100k: ${run.ms.toFixed(0)} ms, reads ${run.reads.join(
        '/'
      )}, edges ${edges}, protected ${run.map.size}, eligibleInPrinciple ${
        expected.versions - run.map.size
      }, heap in use ${run.heapUsedMB} MB`
    );
    expect(await snapshot()).toEqual(before);
    await clean([ORG_S]);
  }, 600_000);
});
