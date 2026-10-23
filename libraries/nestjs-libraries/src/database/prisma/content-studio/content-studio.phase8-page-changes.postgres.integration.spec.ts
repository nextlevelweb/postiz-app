import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import {
  parseContentStudioSourceVersionInput,
  storedContentStudioSourceContent,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Organization page changes (P8-04B1) on a real PostgreSQL: the four derived
// fields kept by real refreshes and feed captures in the one compare-and-swap
// update, rolled back with a failed version, rebuilt by the backfill from the
// versions (gaps, extractor v1, archived, idempotent, updatedAt kept), and
// read organization-wide by the Changes list, checked row by row. Opt-in:
// runs only through jest.content-studio.integration.config.ts against the
// disposable local database. Nothing is fetched: safeFetch is an in-memory
// web
type Web = { feeds: Map<string, string>; pages: Map<string, string> };
const web: Web = { feeds: new Map(), pages: new Map() };
const mockSafeFetch = jest.fn(async (url: string): Promise<SafeFetchResult> => {
  const answer = (body: string, contentType: string): SafeFetchResult => {
    const bytes = new TextEncoder().encode(body);
    return {
      requestedUrl: url,
      finalUrl: url,
      redirects: [],
      status: 200,
      headers: { contentType },
      body: bytes,
      bytesRead: bytes.byteLength,
    };
  };
  if (web.feeds.has(url)) {
    return answer(web.feeds.get(url)!, 'application/rss+xml');
  }
  if (web.pages.has(url)) {
    return answer(web.pages.get(url)!, 'text/html; charset=utf-8');
  }
  const { SafeFetchError } = jest.requireActual(
    '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'
  );
  throw new SafeFetchError('HTTP_STATUS', { statusCode: 404 });
});
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  ...jest.requireActual('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...(args as [string])),
}));

// Separate from the earlier fixtures: their own organizations and users
const ORG_A = '30841000-0000-4000-8000-00000000000a';
const ORG_B = '30841000-0000-4000-8000-00000000000b';
const USER_A = '30841000-0000-4000-8000-0000000000a1';
const USER_B = '30841000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const V1 = 'content-studio-source-v1';
const V2 = 'content-studio-source-v2';
const FEED_URL = 'https://p8041.example/feed.xml';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const INTEGRITY = {
  status: 500,
  msg: 'Stored source data could not be verified.',
  code: 'CS_SOURCE_INTEGRITY_ERROR',
};

let client: PrismaClient;
let prisma: PrismaService;
let sources: ContentStudioSourceRepository;
let ingestion: ContentStudioSourceIngestionService;
let sourceService: ContentStudioSourceService;

const page = (n: number | string) => `https://p8041.example/page-${n}`;
const html = (text: string, title = 'P8041 page') =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8041</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;

const createSource = async (
  organizationId: string,
  url: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) =>
  (
    await client.contentStudioSource.create({
      data: {
        organizationId,
        kind: 'url',
        name: 'P8041 page',
        canonicalUrl: url,
        createdById: OWNER[organizationId],
        ...over,
      },
      select: { id: true },
    })
  ).id;
const refresh = (organizationId: string, sourceId: string) =>
  ingestion.refreshSource({
    organizationId,
    userId: OWNER[organizationId],
    sourceId,
  });
const refreshWith = (sourceId: string, text: string, title?: string) => {
  web.pages.set(page(sourceId), html(text, title));
  return refresh(ORG_A, sourceId);
};
const versionsOf = (sourceId: string) =>
  client.contentStudioSourceVersion.findMany({
    where: { sourceId },
    orderBy: { versionNumber: 'asc' },
  });
const sourceRow = (id: string) =>
  client.contentStudioSource.findUniqueOrThrow({ where: { id } });
const stored = async (id: string) => {
  const row = await sourceRow(id);
  return [
    row.lastPageChangeAt,
    row.lastPageChangeVersionNumber,
    row.lastPageChangeKind,
    row.lastPageChangePreviousCaptureAt,
  ];
};
const NONE = [null, null, null, null];
// a page source whose URL ends in its own id
const pageSource = (organizationId = ORG_A) => {
  const id = randomUUID();
  return createSource(organizationId, page(id), { id });
};

// versions written straight to the table, as captures store them: history
// no capture of this extractor would make
const insertVersions = async (
  sourceId: string,
  rows: Array<{
    versionNumber: number;
    text: string;
    title?: string | null;
    extractionVersion?: string;
    fetchedAt?: Date;
  }>,
  organizationId = ORG_A
) => {
  await client.contentStudioSourceVersion.createMany({
    data: rows.map((row) => ({
      id: randomUUID(),
      organizationId,
      sourceId,
      versionNumber: row.versionNumber,
      extractionVersion: row.extractionVersion ?? V2,
      requestedUrl: 'https://p8041.example/bulk',
      finalUrl: 'https://p8041.example/bulk',
      redirectCount: 0,
      fetchedAt:
        row.fetchedAt ??
        new Date(Date.UTC(2026, 9, 1) + row.versionNumber * 60_000),
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 100,
      title: row.title === undefined ? 'Bulk' : row.title,
      sourceHash: null,
      createdById: OWNER[organizationId],
      ...storedContentStudioSourceContent({
        schemaVersion: 1,
        blocks: [{ id: 'b1', type: 'paragraph', text: row.text, level: null }],
      }),
    })),
  });
  await client.contentStudioSource.update({
    where: { id: sourceId },
    data: {
      latestVersionNumber: Math.max(...rows.map((row) => row.versionNumber)),
    },
  });
};

// every page of the backfill, as the command runs it
const backfill = async () => {
  const total = { updated: 0, unchanged: 0, failed: [] as string[] };
  let afterId: string | null = null;
  do {
    const result: Awaited<
      ReturnType<ContentStudioSourceService['backfillPageChanges']>
    > = await sourceService.backfillPageChanges({ afterId });
    total.updated += result.updated;
    total.unchanged += result.unchanged;
    total.failed.push(...result.failed);
    afterId = result.next;
  } while (afterId);
  return total;
};
// the backfill reads every organization: only the failures of these
// organizations' sources are this suite's
const ownFailures = async (failed: string[]) => {
  const own = await client.contentStudioSource.findMany({
    where: { organizationId: { in: ORGS }, id: { in: failed } },
    select: { id: true },
  });
  return own.map((row) => row.id);
};

const refusal = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const body = (err as HttpException).getResponse() as Record<string, unknown>;
  expect(JSON.stringify(body)).not.toMatch(
    /P20\d\d|[Cc]onstraint|[Pp]risma|\bSELECT\b|"ContentStudio|p8041\.example/
  );
  return { status: (err as HttpException).getStatus(), ...body };
};

const clean = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceDiscovery.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await clean();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: USERS } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  prisma = client as unknown as PrismaService;
  const transaction = new PrismaTransaction(prisma);
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  ingestion = new ContentStudioSourceIngestionService(sources, discoveries);
  sourceService = new ContentStudioSourceService(sources, discoveries);
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P8041 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p8041.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8041 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await clean();
  web.feeds.clear();
  web.pages.clear();
  mockSafeFetch.mockClear();
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

describe('Page changes kept by captures on PostgreSQL', () => {
  it('P804B1PG1 a first capture leaves all four fields empty', async () => {
    const id = await pageSource();
    await refreshWith(id, 'A');
    expect(await stored(id)).toEqual(NONE);
    expect((await sourceRow(id)).latestVersionNumber).toBe(1);
  });

  it('P804B1PG2 A, a repeat, another extraction, B: the page change is B, after the extraction version', async () => {
    const id = await pageSource();
    await refreshWith(id, 'A');
    await refreshWith(id, 'A');
    expect(await stored(id)).toEqual(NONE);
    // the stored capture was made by an earlier extractor
    const [, v2] = await versionsOf(id);
    await client.contentStudioSourceVersion.update({
      where: { id: v2.id },
      data: { extractionVersion: V1 },
    });
    await refreshWith(id, 'A');
    expect(await stored(id)).toEqual(NONE);
    await refreshWith(id, 'B');
    const rows = await versionsOf(id);
    expect(rows.map((row) => row.versionNumber)).toEqual([1, 2, 3, 4]);
    expect(await stored(id)).toEqual([
      rows[3].fetchedAt,
      4,
      'content_changed',
      rows[2].fetchedAt,
    ]);
  });

  it('P804B1PG3/P804B1PG4 a title change counts; content and title together are a content change', async () => {
    const id = await pageSource();
    await refreshWith(id, 'A', 'One');
    await refreshWith(id, 'A', 'Two');
    let rows = await versionsOf(id);
    expect(await stored(id)).toEqual([
      rows[1].fetchedAt,
      2,
      'title_changed',
      rows[0].fetchedAt,
    ]);
    await refreshWith(id, 'B', 'Three');
    rows = await versionsOf(id);
    expect(await stored(id)).toEqual([
      rows[2].fetchedAt,
      3,
      'content_changed',
      rows[1].fetchedAt,
    ]);
  });

  it('P804B1PG5 a later repeat or extraction version keeps the page change', async () => {
    const id = await pageSource();
    await refreshWith(id, 'A');
    await refreshWith(id, 'B');
    const kept = await stored(id);
    await refreshWith(id, 'B');
    expect(await stored(id)).toEqual(kept);
    const rows = await versionsOf(id);
    await client.contentStudioSourceVersion.update({
      where: { id: rows[2].id },
      data: { extractionVersion: V1 },
    });
    await refreshWith(id, 'C');
    expect((await versionsOf(id)).length).toBe(4);
    expect(await stored(id)).toEqual(kept);
  });

  it('P804B1PG6 the loser of a race and a failed version create write nothing: the transaction rolls the fields back', async () => {
    const id = await pageSource();
    await refreshWith(id, 'A');
    const [v1] = await versionsOf(id);
    const version = (text: string) =>
      parseContentStudioSourceVersionInput({
        requestedUrl: page(id),
        finalUrl: page(id),
        redirectCount: 0,
        fetchedAt: new Date(),
        httpStatus: 200,
        contentType: 'text/html',
        contentLength: 10,
        title: 'P8041 page',
        sourceHash: 'a'.repeat(64),
        extractionVersion: V2,
        content: {
          schemaVersion: 1,
          blocks: [{ id: 'b1', type: 'paragraph', text, level: null }],
        },
      });
    const append = (
      text: string,
      kind: 'content_changed' | 'title_changed'
    ) => {
      const data = version(text);
      return sources.appendVersionWithCompareAndSwap({
        organizationId: ORG_A,
        sourceId: id,
        expectedLatestVersionNumber: 1,
        versionId: randomUUID(),
        version: data,
        createdById: USER_A,
        pageChange: {
          at: data.fetchedAt,
          versionNumber: 2,
          kind,
          previousCaptureAt: v1.fetchedAt,
        },
      });
    };
    // two appends from version 1 at once: one wins, the other writes nothing
    const results = await Promise.all([
      append('B', 'content_changed'),
      append('C', 'title_changed'),
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 'created')).toHaveLength(1);
    // lost before the update (conflict) or at it (changed, count 0)
    expect(['changed', 'conflict']).toContain(
      statuses.find((s) => s !== 'created')
    );
    const rows = await versionsOf(id);
    expect(rows).toHaveLength(2);
    const winner = results.findIndex((r) => r.status === 'created');
    expect(await stored(id)).toEqual([
      rows[1].fetchedAt,
      2,
      winner === 0 ? 'content_changed' : 'title_changed',
      v1.fetchedAt,
    ]);
    // a stale expected version: refused before any update
    const before = await sourceRow(id);
    expect((await append('D', 'content_changed')).status).toBe('conflict');
    expect(await sourceRow(id)).toEqual(before);
    // a version create that fails rolls back the number and the fields
    const data = version('E');
    await expect(
      sources.appendVersionWithCompareAndSwap({
        organizationId: ORG_A,
        sourceId: id,
        expectedLatestVersionNumber: 2,
        // the id of a version that exists: the create fails at its key
        versionId: rows[0].id,
        version: data,
        createdById: USER_A,
        pageChange: {
          at: data.fetchedAt,
          versionNumber: 3,
          kind: 'content_changed',
          previousCaptureAt: rows[1].fetchedAt,
        },
      })
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(await sourceRow(id)).toEqual(before);
    expect(await versionsOf(id)).toHaveLength(2);
  });

  it('P804B1PG7 feed captures: the same capture writes nothing; title and blocks are page changes; another extraction is not; the feed never has one', async () => {
    const feed = await client.contentStudioSource.create({
      data: {
        organizationId: ORG_A,
        kind: 'feed',
        name: 'P8041 feed',
        canonicalUrl: FEED_URL,
        createdById: USER_A,
      },
    });
    web.feeds.set(FEED_URL, rss([page('feed-1')]));
    web.pages.set(page('feed-1'), html('Text one'));
    const capture = async () =>
      (
        (await refresh(ORG_A, feed.id)) as unknown as {
          capture: { versionsCreated: number; unchanged: number };
        }
      ).capture;
    await capture();
    const id = (
      await client.contentStudioSource.findFirstOrThrow({
        where: { organizationId: ORG_A, canonicalUrl: page('feed-1') },
      })
    ).id;
    expect(await stored(id)).toEqual(NONE);
    const before = await sourceRow(id);
    web.pages.set(page('feed-1'), `${html('Text one')}<!-- build 2 -->`);
    expect(await capture()).toMatchObject({ versionsCreated: 0, unchanged: 1 });
    expect(await sourceRow(id)).toEqual(before);
    web.pages.set(page('feed-1'), html('Text one', 'Retitled'));
    await capture();
    let rows = await versionsOf(id);
    expect(await stored(id)).toEqual([
      rows[1].fetchedAt,
      2,
      'title_changed',
      rows[0].fetchedAt,
    ]);
    await client.contentStudioSourceVersion.update({
      where: { id: rows[1].id },
      data: { extractionVersion: V1 },
    });
    expect(await capture()).toMatchObject({ versionsCreated: 1 });
    expect((await stored(id))[1]).toBe(2);
    web.pages.set(page('feed-1'), html('Text two', 'Retitled'));
    await capture();
    rows = await versionsOf(id);
    expect(await stored(id)).toEqual([
      rows[3].fetchedAt,
      4,
      'content_changed',
      rows[2].fetchedAt,
    ]);
    expect(await stored(feed.id)).toEqual(NONE);
  });
});

describe('The page-change backfill on PostgreSQL', () => {
  it('P804B1PG8 history: a first capture, repeats, extractor v1 to v2, a content and a title change: the exact latest', async () => {
    const id = await pageSource();
    await insertVersions(id, [
      { versionNumber: 1, text: 'A', extractionVersion: V1 },
      { versionNumber: 2, text: 'A', extractionVersion: V1 },
      // v1 -> v1, other blocks: a page change of the same extractor
      { versionNumber: 3, text: 'B', extractionVersion: V1 },
      // to v2, other blocks and title: never a page change
      { versionNumber: 4, text: 'B2', title: 'New', extractionVersion: V2 },
      { versionNumber: 5, text: 'B2', title: 'New' },
      { versionNumber: 6, text: 'C', title: 'New' },
      { versionNumber: 7, text: 'C', title: 'Newer' },
      { versionNumber: 8, text: 'C', title: 'Newer' },
    ]);
    const onlyExtraction = await pageSource();
    await insertVersions(onlyExtraction, [
      { versionNumber: 1, text: 'A', extractionVersion: V1 },
      { versionNumber: 2, text: 'Z', title: 'Other', extractionVersion: V2 },
    ]);
    const first = await pageSource();
    await insertVersions(first, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 2, text: 'A' },
    ]);
    const result = await backfill();
    expect(await ownFailures(result.failed)).toEqual([]);
    const rows = await versionsOf(id);
    expect(await stored(id)).toEqual([
      rows[6].fetchedAt,
      7,
      'title_changed',
      rows[5].fetchedAt,
    ]);
    expect(await stored(onlyExtraction)).toEqual(NONE);
    expect(await stored(first)).toEqual(NONE);
    // the read checks what the backfill wrote, version and time included
    const list = await sourceService.listPageChanges({
      organizationId: ORG_A,
      page: 1,
      since: 'all',
    });
    expect(list.results.map((r) => [r.source.id, r.version.id])).toEqual([
      [id, rows[6].id],
    ]);
  });

  it('P804B1PG9/P804B1PG10/P804B1PG12 a second run writes nothing; updatedAt is kept; archived sources are backfilled', async () => {
    const active = await pageSource();
    await insertVersions(active, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 2, text: 'B' },
    ]);
    const archived = await pageSource();
    await insertVersions(archived, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 2, text: 'A', title: 'Other' },
    ]);
    await client.contentStudioSource.update({
      where: { id: archived },
      data: { archivedAt: new Date('2026-10-02T00:00:00.000Z') },
    });
    const updatedAt = new Map(
      await Promise.all(
        [active, archived].map(
          async (id) => [id, (await sourceRow(id)).updatedAt] as const
        )
      )
    );
    const first = await backfill();
    expect(await ownFailures(first.failed)).toEqual([]);
    expect(first.updated).toBeGreaterThanOrEqual(2);
    expect((await stored(active))[2]).toBe('content_changed');
    expect((await stored(archived))[2]).toBe('title_changed');
    for (const id of [active, archived]) {
      expect((await sourceRow(id)).updatedAt).toEqual(updatedAt.get(id));
    }
    const snapshot = JSON.stringify(
      await client.contentStudioSource.findMany({ orderBy: { id: 'asc' } })
    );
    const second = await backfill();
    expect(second.updated).toBe(0);
    expect(await ownFailures(second.failed)).toEqual([]);
    expect(
      JSON.stringify(
        await client.contentStudioSource.findMany({ orderBy: { id: 'asc' } })
      )
    ).toBe(snapshot);
  });

  it('P804B1PG11 version gaps: each version is compared with the one before it that exists', async () => {
    const id = await pageSource();
    await insertVersions(id, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 4, text: 'B' },
      { versionNumber: 7, text: 'B' },
    ]);
    await backfill();
    const rows = await versionsOf(id);
    expect(await stored(id)).toEqual([
      rows[1].fetchedAt,
      4,
      'content_changed',
      rows[0].fetchedAt,
    ]);
  });

  it('repairs stale fields to none, and reports a source whose versions do not end at its current version', async () => {
    const stale = await pageSource();
    await insertVersions(stale, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 2, text: 'A' },
    ]);
    await client.contentStudioSource.update({
      where: { id: stale },
      data: {
        lastPageChangeAt: new Date(),
        lastPageChangeVersionNumber: 2,
        lastPageChangeKind: 'content_changed',
        lastPageChangePreviousCaptureAt: new Date(),
      },
    });
    const broken = await pageSource();
    await insertVersions(broken, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 2, text: 'B' },
    ]);
    await client.contentStudioSource.update({
      where: { id: broken },
      data: { latestVersionNumber: 5 },
    });
    const result = await backfill();
    expect(await ownFailures(result.failed)).toEqual([broken]);
    expect(await stored(stale)).toEqual(NONE);
    expect(await stored(broken)).toEqual(NONE);
  });
});

describe('Organization Changes on PostgreSQL', () => {
  // a source whose last page change is `ago` before now: two versions, the
  // fields written by the backfill (run once a test has its sources)
  const changed = async (
    organizationId: string,
    ago: number,
    over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
  ) => {
    const id = await createSource(organizationId, page(randomUUID()), over);
    const at = new Date(Date.now() - ago);
    await insertVersions(
      id,
      [
        {
          versionNumber: 1,
          text: 'A',
          fetchedAt: new Date(at.getTime() - HOUR),
        },
        { versionNumber: 2, text: 'B', fetchedAt: at },
      ],
      organizationId
    );
    return id;
  };

  it("P804B1PG13 two organizations: neither lists nor counts the other's changes", async () => {
    const a = await changed(ORG_A, HOUR);
    const b = await changed(ORG_B, HOUR);
    await backfill();
    const listA = await sourceService.listPageChanges({
      organizationId: ORG_A,
      page: 1,
    });
    const listB = await sourceService.listPageChanges({
      organizationId: ORG_B,
      page: 1,
    });
    expect(listA).toMatchObject({ total: 1, pages: 1 });
    expect(listA.results.map((r) => r.source.id)).toEqual([a]);
    expect(listB.results.map((r) => r.source.id)).toEqual([b]);
    expect(JSON.stringify(listA)).not.toContain(b);
    expect(JSON.stringify(listA)).not.toMatch(
      /organizationId|contentHash|sourceHash|extractionVersion|createdById|"content"/
    );
  });

  it('P804B1PG14 newest first in pages of 50, ties by source id, by window; archived listed, feeds never', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 55; n++) {
      ids.push(await changed(ORG_A, (n + 1) * 60_000));
    }
    // two at the same time: by id
    const tieAt = 30 * 60_000 + 30_000;
    const ties = [await changed(ORG_A, tieAt), await changed(ORG_A, tieAt)];
    const old = await changed(ORG_A, 10 * DAY, {
      archivedAt: new Date(),
    });
    await client.contentStudioSource.create({
      data: {
        organizationId: ORG_A,
        kind: 'feed',
        name: 'P8041 feed',
        canonicalUrl: FEED_URL,
        createdById: USER_A,
      },
    });
    await backfill();
    const first = await sourceService.listPageChanges({
      organizationId: ORG_A,
      page: 1,
    });
    expect(first).toMatchObject({ total: 57, pages: 2 });
    expect(first.results).toHaveLength(50);
    const second = await sourceService.listPageChanges({
      organizationId: ORG_A,
      page: 2,
    });
    const all = [...first.results, ...second.results];
    expect(all).toHaveLength(57);
    expect(new Set(all.map((r) => r.source.id)).size).toBe(57);
    const times = all.map((r) => new Date(r.changedAt).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const tied = all
      .filter((r) => ties.includes(r.source.id))
      .map((r) => r.source.id);
    expect(tied).toEqual([...ties].sort());
    expect(all.map((r) => r.source.id)).not.toContain(old);
    const allTime = await sourceService.listPageChanges({
      organizationId: ORG_A,
      page: 1,
      since: 'all',
    });
    expect(allTime.total).toBe(58);
    const archivedRow = [
      ...allTime.results,
      ...(
        await sourceService.listPageChanges({
          organizationId: ORG_A,
          page: 2,
          since: 'all',
        })
      ).results,
    ].find((r) => r.source.id === old)!;
    expect(archivedRow.source.archivedAt).not.toBeNull();
    expect(
      (
        await sourceService.listPageChanges({
          organizationId: ORG_A,
          page: 1,
          since: '24h',
        })
      ).total
    ).toBe(57);
    expect(ids).toHaveLength(55);
  });

  it('P804B1PG15 derived fields that do not match the versions fail the request closed', async () => {
    const id = await changed(ORG_A, HOUR);
    await backfill();
    const corruptions: Array<[string, Prisma.ContentStudioSourceUpdateInput]> =
      [
        ['another version number', { lastPageChangeVersionNumber: 1 }],
        [
          'a time of no version',
          { lastPageChangeAt: new Date(Date.now() - 60_000) },
        ],
        ['half written', { lastPageChangeKind: null }],
        [
          'extraction is no page change',
          { lastPageChangeKind: 'extraction_changed' },
        ],
      ];
    const good = await sourceRow(id);
    for (const [name, data] of corruptions) {
      await client.contentStudioSource.update({ where: { id }, data });
      expect([
        name,
        await refusal(
          sourceService.listPageChanges({
            organizationId: ORG_A,
            page: 1,
            since: 'all',
          })
        ),
      ]).toEqual([name, INTEGRITY]);
      await client.contentStudioSource.update({
        where: { id },
        data: {
          lastPageChangeAt: good.lastPageChangeAt,
          lastPageChangeVersionNumber: good.lastPageChangeVersionNumber,
          lastPageChangeKind: good.lastPageChangeKind,
          lastPageChangePreviousCaptureAt: good.lastPageChangePreviousCaptureAt,
        },
      });
    }
    // the version it names is gone (as retention one day might)
    const [, v2] = await versionsOf(id);
    await client.contentStudioSourceVersion.delete({ where: { id: v2.id } });
    expect(
      await refusal(
        sourceService.listPageChanges({ organizationId: ORG_A, page: 1 })
      )
    ).toEqual(INTEGRITY);
  });

  it('P804B1PG16 the Changes read writes nothing and fetches nothing', async () => {
    await changed(ORG_A, HOUR);
    await changed(ORG_A, 2 * HOUR, { archivedAt: new Date() });
    await backfill();
    const snapshot = async () =>
      JSON.stringify([
        await client.contentStudioSource.findMany({
          where: { organizationId: { in: ORGS } },
          orderBy: { id: 'asc' },
        }),
        await client.contentStudioSourceVersion.findMany({
          where: { organizationId: { in: ORGS } },
          orderBy: { id: 'asc' },
        }),
      ]);
    const before = await snapshot();
    for (const since of ['24h', '7d', '30d', 'all'] as const) {
      await sourceService.listPageChanges({
        organizationId: ORG_A,
        page: 1,
        since,
      });
    }
    expect(await snapshot()).toBe(before);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
