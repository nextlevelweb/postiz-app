import { createHash, randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
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
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// What changed in a source version (P8-04A) on a real PostgreSQL: versions
// made by real refreshes and feed captures, the two Prisma lookups that skip
// repeats (a missing title compared as a value), the organization and source
// scope, the stored-version check and read-only. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. The services and repositories run unchanged; Prisma is used
// directly only for fixtures and for rows that bypass the application on
// purpose. Nothing is fetched: safeFetch is an in-memory web
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
// P8-C1: refreshes here follow each other at once; the member refresh
// cooldown has its own suite (phase8-caps)
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/sources/source.types',
  () => {
    const actual = jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/sources/source.types'
    );
    return {
      ...actual,
      contentStudioSourceLimits: (organizationId: string) => ({
        ...actual.contentStudioSourceLimits(organizationId),
        manualRefreshCooldownMs: 0,
      }),
    };
  }
);

// Separate from the earlier fixtures: their own organizations and users
const ORG_A = '30840000-0000-4000-8000-00000000000a';
const ORG_B = '30840000-0000-4000-8000-00000000000b';
const USER_A = '30840000-0000-4000-8000-0000000000a1';
const USER_B = '30840000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const V1 = 'content-studio-source-v1';
const V2 = 'content-studio-source-v2';
const MARKER = 'P804A_PG_SECRET_MARKER';
const FEED_URL = 'https://p804.example/feed.xml';

let client: PrismaClient;
let prisma: PrismaService;
let sources: ContentStudioSourceRepository;
let ingestion: ContentStudioSourceIngestionService;
let sourceService: ContentStudioSourceService;

const page = (n: number | string) => `https://p804.example/page-${n}`;
const html = (text: string, title = 'P804 page') =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><p>${text}</p></main></body></html>`;
const sha256 = (text: string) =>
  createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P804</title>${links
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
        name: 'P804 page',
        canonicalUrl: url,
        createdById: OWNER[organizationId],
        ...over,
      },
      select: { id: true },
    })
  ).id;
// a real refresh: always a new version
const refresh = (organizationId: string, sourceId: string) =>
  ingestion.refreshSource({
    organizationId,
    userId: OWNER[organizationId],
    sourceId,
  });
const versionsOf = (sourceId: string) =>
  client.contentStudioSourceVersion.findMany({
    where: { sourceId },
    orderBy: { versionNumber: 'asc' },
  });
const changes = (sourceId: string, versionId: string, organizationId = ORG_A) =>
  sourceService.getVersionChanges({ organizationId, sourceId, versionId });

// a version written straight to the table, as a capture stores one: the
// rows a test needs that no capture of this extractor would make
const insertVersions = async (
  sourceId: string,
  rows: Array<{
    versionNumber: number;
    text: string;
    title?: string | null;
    extractionVersion?: string;
    sourceHash?: string | null;
    organizationId?: string;
  }>
) => {
  await client.contentStudioSourceVersion.createMany({
    data: rows.map((row) => ({
      id: randomUUID(),
      organizationId: row.organizationId ?? ORG_A,
      sourceId,
      versionNumber: row.versionNumber,
      extractionVersion: row.extractionVersion ?? V2,
      requestedUrl: 'https://p804.example/bulk',
      finalUrl: 'https://p804.example/bulk',
      redirectCount: 0,
      fetchedAt: new Date(Date.UTC(2026, 9, 1) + row.versionNumber * 60_000),
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 100,
      title: row.title === undefined ? 'Bulk' : row.title,
      sourceHash: row.sourceHash === undefined ? null : row.sourceHash,
      createdById: OWNER[row.organizationId ?? ORG_A],
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
    new RegExp(
      `P20\\d\\d|[Cc]onstraint|[Pp]risma|\\bSELECT\\b|"ContentStudio|p804\\.example|${MARKER}`
    )
  );
  return { status: (err as HttpException).getStatus(), ...body };
};

const clean = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceCaptureAttempt.deleteMany({ where });
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
  const captureAttempts = new ContentStudioSourceCaptureAttemptRepository(
    new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
  );
  ingestion = new ContentStudioSourceIngestionService(
    sources,
    discoveries,
    captureAttempts
  );
  sourceService = new ContentStudioSourceService(
    sources,
    discoveries,
    captureAttempts
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P804 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p804.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P804 ${user}`,
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

describe('Source changes on PostgreSQL', () => {
  it('P804APG1 v1 A, two manual repeats, v4 B: the repeats stay, v3 repeats v1, v4 is compared with v1', async () => {
    const id = await createSource(ORG_A, page(1));
    web.pages.set(page(1), html('Version A'));
    for (let i = 0; i < 3; i++) {
      await refresh(ORG_A, id);
    }
    web.pages.set(page(1), html('Version B'));
    await refresh(ORG_A, id);
    const rows = await versionsOf(id);
    // a refresh still always appends: four immutable versions, three alike
    expect(rows.map((row) => row.versionNumber)).toEqual([1, 2, 3, 4]);
    expect(new Set(rows.slice(0, 3).map((row) => row.contentHash)).size).toBe(
      1
    );

    const v3 = await changes(id, rows[2].id);
    expect(v3).toMatchObject({
      before: null,
      repeatOf: { id: rows[0].id, versionNumber: 1 },
      change: 'no_earlier_change',
      blocks: [],
    });
    const v4 = await changes(id, rows[3].id);
    expect(v4).toMatchObject({
      before: { id: rows[0].id, versionNumber: 1 },
      after: { id: rows[3].id, versionNumber: 4 },
      repeatOf: null,
      change: 'content_changed',
      titleChanged: false,
      counts: { added: 1, removed: 1, unchanged: 0 },
      blocks: [
        { change: 'removed', type: 'paragraph', text: 'Version A' },
        { change: 'added', type: 'paragraph', text: 'Version B' },
      ],
    });
    // the same bytes fetched every time, so the same body hash
    expect(rows[0].sourceHash).toBe(sha256(html('Version A')));
  });

  it('P804APG2 feed captures use the same rule: the same capture adds nothing; a title, text or extraction change adds a version', async () => {
    await client.contentStudioSource.create({
      data: {
        organizationId: ORG_A,
        kind: 'feed',
        name: 'P804 feed',
        canonicalUrl: FEED_URL,
        createdById: USER_A,
      },
    });
    const feed = await client.contentStudioSource.findFirstOrThrow({
      where: { organizationId: ORG_A, kind: 'feed' },
    });
    web.feeds.set(FEED_URL, rss([page(2)]));
    web.pages.set(page(2), html('Text one'));
    const captureFeed = async () =>
      (
        (await refresh(ORG_A, feed.id)) as unknown as {
          capture: { versionsCreated: number; unchanged: number };
        }
      ).capture;
    expect(await captureFeed()).toMatchObject({ versionsCreated: 1 });
    const pageId = (
      await client.contentStudioSource.findFirstOrThrow({
        where: { organizationId: ORG_A, canonicalUrl: page(2) },
      })
    ).id;
    // other bytes, the same blocks and title: no version
    web.pages.set(page(2), `${html('Text one')}<!-- build 2 -->`);
    expect(await captureFeed()).toMatchObject({
      versionsCreated: 0,
      unchanged: 1,
    });
    // a title change
    web.pages.set(page(2), html('Text one', 'Retitled'));
    expect(await captureFeed()).toMatchObject({ versionsCreated: 1 });
    // a text change
    web.pages.set(page(2), html('Text two', 'Retitled'));
    expect(await captureFeed()).toMatchObject({ versionsCreated: 1 });
    const captured = await versionsOf(pageId);
    expect((await changes(pageId, captured[1].id)).change).toBe(
      'title_changed'
    );
    expect(await changes(pageId, captured[2].id)).toMatchObject({
      change: 'content_changed',
      titleChanged: false,
      before: { versionNumber: 2 },
    });
    // the stored version made by an earlier extractor (bypassing the app)
    const latest = (await versionsOf(pageId)).pop()!;
    await client.contentStudioSourceVersion.update({
      where: { id: latest.id },
      data: { extractionVersion: V1 },
    });
    expect(await captureFeed()).toMatchObject({ versionsCreated: 1 });
    expect(await captureFeed()).toMatchObject({
      versionsCreated: 0,
      unchanged: 1,
    });
    const rows = await versionsOf(pageId);
    expect(rows.map((row) => row.versionNumber)).toEqual([1, 2, 3, 4]);
    // and the extractor change reads back as one, never as a page change
    expect(await changes(pageId, rows[3].id)).toMatchObject({
      change: 'extraction_changed',
      before: { versionNumber: 3, extractionVersion: V1 },
      // the same page bytes both times
      sameFetchedBytes: true,
      counts: { added: 0, removed: 0, unchanged: 1 },
    });
  });

  it('P804APG3 an extractor v1 capture followed by a v2 one is extraction_changed, never content_changed', async () => {
    const id = await createSource(ORG_A, page(3));
    const bytes = html('Body text');
    await insertVersions(id, [
      {
        versionNumber: 1,
        text: 'Menu Body text',
        extractionVersion: V1,
        title: 'P804 page',
        sourceHash: sha256(bytes),
      },
    ]);
    web.pages.set(page(3), bytes);
    await refresh(ORG_A, id);
    const rows = await versionsOf(id);
    expect(rows.map((row) => row.extractionVersion)).toEqual([V1, V2]);
    expect(await changes(id, rows[1].id)).toMatchObject({
      before: { versionNumber: 1, extractionVersion: V1 },
      after: { versionNumber: 2, extractionVersion: V2 },
      change: 'extraction_changed',
      sameFetchedBytes: true,
      titleChanged: false,
      blocks: [
        { change: 'removed', text: 'Menu Body text' },
        { change: 'added', text: 'Body text' },
      ],
    });
  });

  it('P804APG4/13 a title-only change, with a missing title compared as a value', async () => {
    const id = await createSource(ORG_A, page(4));
    await insertVersions(id, [
      { versionNumber: 1, text: 'Same', title: null },
      { versionNumber: 2, text: 'Same', title: null },
      { versionNumber: 3, text: 'Same', title: 'Titled' },
      { versionNumber: 4, text: 'Same', title: null },
      { versionNumber: 5, text: 'Same', title: 'Titled' },
      { versionNumber: 6, text: 'Same', title: 'Titled' },
    ]);
    const rows = await versionsOf(id);
    // null after null: the same capture
    expect(await changes(id, rows[1].id)).toMatchObject({
      before: null,
      repeatOf: { versionNumber: 1 },
      change: 'no_earlier_change',
    });
    // text after null
    expect(await changes(id, rows[2].id)).toMatchObject({
      before: { versionNumber: 1, title: null },
      change: 'title_changed',
      titleChanged: true,
      blocks: [{ change: 'unchanged', count: 1 }],
    });
    // null after text: the titled v3 is not skipped as if it were null
    expect(await changes(id, rows[3].id)).toMatchObject({
      before: { versionNumber: 3, title: 'Titled' },
      repeatOf: null,
      change: 'title_changed',
    });
    // a repeat of a titled capture after a null one
    expect(await changes(id, rows[5].id)).toMatchObject({
      before: { versionNumber: 4, title: null },
      repeatOf: { versionNumber: 5 },
      change: 'title_changed',
    });
  });

  it('P804APG5 an archived page source can still be compared', async () => {
    const id = await createSource(ORG_A, page(5));
    await insertVersions(id, [
      { versionNumber: 1, text: 'Before archive' },
      { versionNumber: 2, text: 'Last capture' },
    ]);
    await client.contentStudioSource.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    const rows = await versionsOf(id);
    expect((await changes(id, rows[1].id)).change).toBe('content_changed');
  });

  it('P804APG6 another organization: the same 404 as a missing source, and its versions are never a baseline', async () => {
    // the same URL in both organizations, each with its own history
    const mine = await createSource(ORG_A, page(6));
    const theirs = await createSource(ORG_B, page(6));
    await insertVersions(theirs, [
      { versionNumber: 1, text: MARKER, organizationId: ORG_B },
      { versionNumber: 2, text: `${MARKER} 2`, organizationId: ORG_B },
    ]);
    await insertVersions(mine, [{ versionNumber: 1, text: 'Mine' }]);
    const theirRows = await versionsOf(theirs);
    const mineRows = await versionsOf(mine);
    const missing = await refusal(changes(randomUUID(), theirRows[1].id));
    expect(missing).toEqual({
      status: 404,
      msg: 'Source not found.',
      code: 'CS_NOT_FOUND',
    });
    expect(await refusal(changes(theirs, theirRows[1].id))).toEqual(missing);
    // their version under my source id
    expect(await refusal(changes(mine, theirRows[1].id))).toEqual(missing);
    // my first capture has no earlier change, whatever they captured
    expect(await changes(mine, mineRows[0].id)).toMatchObject({
      before: null,
      repeatOf: null,
      change: 'no_earlier_change',
    });
    // and their organization sees its own change
    expect((await changes(theirs, theirRows[1].id, ORG_B)).change).toBe(
      'content_changed'
    );
  });

  it('P804APG7 a version of another source of the organization is a 404', async () => {
    const a = await createSource(ORG_A, page('7a'));
    const b = await createSource(ORG_A, page('7b'));
    await insertVersions(a, [{ versionNumber: 1, text: 'A' }]);
    await insertVersions(b, [
      { versionNumber: 1, text: 'B1' },
      { versionNumber: 2, text: 'B2' },
    ]);
    const bRows = await versionsOf(b);
    expect(await refusal(changes(a, bRows[1].id))).toEqual({
      status: 404,
      msg: 'Source not found.',
      code: 'CS_NOT_FOUND',
    });
    // b's first version is no baseline of a's
    const aRows = await versionsOf(a);
    expect((await changes(a, aRows[0].id)).before).toBeNull();
  });

  it('P804APG8 a tampered stored version, compared or as the baseline, is an integrity error that quotes nothing', async () => {
    const id = await createSource(ORG_A, page(8));
    await insertVersions(id, [
      { versionNumber: 1, text: `${MARKER} first` },
      { versionNumber: 2, text: `${MARKER} second` },
    ]);
    const rows = await versionsOf(id);
    const integrity = {
      status: 500,
      msg: 'Stored source data could not be verified.',
      code: 'CS_SOURCE_INTEGRITY_ERROR',
    };
    await client.contentStudioSourceVersion.update({
      where: { id: rows[1].id },
      data: { contentHash: '0'.repeat(64) },
    });
    expect(await refusal(changes(id, rows[1].id))).toEqual(integrity);
    await client.contentStudioSourceVersion.update({
      where: { id: rows[1].id },
      data: { contentHash: rows[1].contentHash },
    });
    await client.contentStudioSourceVersion.update({
      where: { id: rows[0].id },
      data: { content: rows[0].content.replace('first', 'forged') },
    });
    expect(await refusal(changes(id, rows[1].id))).toEqual(integrity);
  });

  it('P804APG9 a feed tampered to hold a version is refused before any version is read', async () => {
    const id = await createSource(ORG_A, FEED_URL, { kind: 'feed' });
    await insertVersions(id, [
      { versionNumber: 1, text: MARKER },
      { versionNumber: 2, text: `${MARKER} 2` },
    ]);
    const rows = await versionsOf(id);
    const spy = jest.spyOn(sources, 'getVersionForSource');
    try {
      expect(await refusal(changes(id, rows[1].id))).toEqual({
        status: 400,
        msg: 'This source type has no versions.',
        code: 'CS_SOURCE_KIND_UNSUPPORTED',
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('P804APG10 comparing only reads', async () => {
    const id = await createSource(ORG_A, page(10));
    await insertVersions(id, [
      { versionNumber: 1, text: 'A' },
      { versionNumber: 2, text: 'A' },
      { versionNumber: 3, text: 'B' },
    ]);
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          client.contentStudioSource.findMany({
            where: { organizationId: { in: ORGS } },
            orderBy: { id: 'asc' },
          }),
          client.contentStudioSourceVersion.findMany({
            where: { organizationId: { in: ORGS } },
            orderBy: { id: 'asc' },
          }),
          client.contentStudioSourceDiscovery.findMany({
            where: { organizationId: { in: ORGS } },
            orderBy: { id: 'asc' },
          }),
        ])
      );
    const before = await snapshot();
    for (const row of await versionsOf(id)) {
      await changes(id, row.id);
    }
    expect(await snapshot()).toBe(before);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('P804APG11 500 versions, 400 of them repeats: both lookups stay index walks', async () => {
    const id = await createSource(ORG_A, page(11));
    // 100 different captures, each followed by four repeats
    await insertVersions(
      id,
      Array.from({ length: 500 }, (_, i) => ({
        versionNumber: i + 1,
        text: `Capture ${Math.floor(i / 5)}`,
      }))
    );
    const last = await client.contentStudioSourceVersion.findFirstOrThrow({
      where: { sourceId: id, versionNumber: 500 },
    });
    const started = Date.now();
    const result = await changes(id, last.id);
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({
      // the first of the run before: v491; v500 repeats v496
      before: { versionNumber: 491 },
      repeatOf: { versionNumber: 496 },
      change: 'content_changed',
      counts: { added: 1, removed: 1, unchanged: 0 },
    });
    // the oldest run: no earlier change, a repeat of v1
    const fifth = await client.contentStudioSourceVersion.findFirstOrThrow({
      where: { sourceId: id, versionNumber: 5 },
    });
    expect(await changes(id, fifth.id)).toMatchObject({
      before: null,
      repeatOf: { versionNumber: 1 },
    });
    // the timing is printed for the report, never asserted
    process.stdout.write(`P804APG11 compare v500 of 500: ${elapsed} ms\n`);
  });
});
