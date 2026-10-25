import { randomUUID } from 'crypto';
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
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// A feed's capture history (P8-O1) on a real PostgreSQL: one record per
// capture that reads its feed, scheduled (one for all its tries, named by its
// run id) or a member's refresh (with who asked); ended once, as a success in
// the feed's own success transaction or as a failure with the schedule that
// failure left; read newest first, a page at a time, for a feed of the
// organization only, archived or not. Nothing deletes a record. Opt-in: runs
// only through jest.content-studio.integration.config.ts against the
// disposable local database. Nothing is fetched: safeFetch is an in-memory
// web
type Web = {
  feeds: Map<string, string>;
  pages: Map<string, string>;
  failing: Set<string>;
  // a URL whose answer waits until it is released
  held: Map<string, Promise<void>>;
};
const web: Web = {
  feeds: new Map(),
  pages: new Map(),
  failing: new Set(),
  held: new Map(),
};
const mockSafeFetch = jest.fn(async (url: string): Promise<SafeFetchResult> => {
  const { SafeFetchError } = jest.requireActual(
    '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'
  );
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
  if (web.held.has(url)) {
    const gate = web.held.get(url)!;
    web.held.delete(url);
    await gate;
  }
  if (web.failing.has(url)) {
    throw new SafeFetchError('HTTP_STATUS', { statusCode: 503 });
  }
  if (web.feeds.has(url)) {
    return answer(web.feeds.get(url)!, 'application/rss+xml');
  }
  if (web.pages.has(url)) {
    return answer(web.pages.get(url)!, 'text/html; charset=utf-8');
  }
  throw new SafeFetchError('HTTP_STATUS', { statusCode: 404 });
});
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  ...jest.requireActual('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...(args as [string])),
}));
// The limits of these tests, set by each one; never a global constant
const mockLimits = {
  activeFeedsMax: 1000,
  urlSourcesMax: 1000,
  manualRefreshCooldownMs: 0,
};
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/sources/source.types',
  () => ({
    ...jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/sources/source.types'
    ),
    contentStudioSourceLimits: () => ({ ...mockLimits }),
  })
);

// Separate from the earlier fixtures: their own organizations and users; the
// third user is deleted by a test
const ORG_A = '30010000-0000-4000-8000-00000000000a';
const ORG_B = '30010000-0000-4000-8000-00000000000b';
const USER_A = '30010000-0000-4000-8000-0000000000a1';
const USER_B = '30010000-0000-4000-8000-0000000000b1';
const USER_GONE = '30010000-0000-4000-8000-0000000000c1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B, USER_GONE];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const COUNTS = [
  'entriesSeen',
  'entriesIgnored',
  'entriesSkipped',
  'entriesAccepted',
  'sourcesCreated',
  'versionsCreated',
  'unchanged',
  'failed',
  'archived',
  'entriesLimited',
] as const;

let client: PrismaClient;
let repository: ContentStudioSourceRepository;
let discoveries: ContentStudioSourceDiscoveryRepository;
let ingestion: ContentStudioSourceIngestionService;
let service: ContentStudioSourceService;

const feedUrl = (name: string) => `https://p8o1.example/${name}.xml`;
const page = (name: string) => `https://p8o1.example/page-${name}`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8O1 page</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8O1</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
// a feed that reads: its RSS and two pages
const readable = (name: string) => {
  web.feeds.set(feedUrl(name), rss([page(`${name}-1`), page(`${name}-2`)]));
  web.pages.set(page(`${name}-1`), html(`One ${name}`));
  web.pages.set(page(`${name}-2`), html(`Two ${name}`));
};

// fixture rows, written directly: never through the limited create
const fixtureFeed = async (
  organizationId: string,
  name: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) => {
  const id = randomUUID();
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'feed',
      name: `P8O1 ${name}`,
      canonicalUrl: feedUrl(name),
      createdById: OWNER[organizationId],
      ...over,
    },
  });
  return id;
};
const feedRow = (id: string) =>
  client.contentStudioSource.findUniqueOrThrow({ where: { id } });
const records = (sourceId: string) =>
  client.contentStudioSourceCaptureAttempt.findMany({
    where: { sourceId },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
const countsOf = (row: Record<string, unknown>) =>
  Object.fromEntries(COUNTS.map((key) => [key, row[key]]));
const scheduled = (
  organizationId: string,
  sourceId: string,
  attemptId: string,
  attemptCount = 1
) =>
  ingestion.captureScheduledFeed({
    organizationId,
    sourceId,
    attemptId,
    attemptCount,
  });
const refresh = (organizationId: string, sourceId: string) =>
  ingestion.refreshSource({
    organizationId,
    userId: OWNER[organizationId],
    sourceId,
  }) as Promise<Record<string, any>>;
const record = (organizationId: string, sourceId: string) =>
  ingestion.recordScheduledFeedFailure({
    organizationId,
    sourceId,
    code: 'CS_SOURCE_FETCH_FAILED',
  });
const finish = (
  organizationId: string,
  sourceId: string,
  attemptId: string,
  status = 'source_failed',
  code: string | null = 'CS_SOURCE_FETCH_FAILED'
) =>
  ingestion.finishScheduledFeedCapture({
    organizationId,
    sourceId,
    attemptId,
    status,
    code,
  });
const history = (organizationId: string, sourceId: string, page = 1) =>
  service.listFeedCaptures({ organizationId, sourceId, page });
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
    /P20\d\d|[Cc]onstraint|[Pp]risma|\bSELECT\b|"ContentStudio|p8o1\.example/
  );
  return { status: (err as HttpException).getStatus(), ...body } as Record<
    string,
    unknown
  >;
};
const prismaCode = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => {
      throw new Error('expected a database refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  return (err as Prisma.PrismaClientKnownRequestError).code;
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
const addUser = async (user: string, organizationId: string) => {
  await client.user.create({
    data: {
      id: user,
      email: `${user}@p8o1.invalid`,
      providerName: 'LOCAL',
      timezone: 0,
      name: `P8O1 ${user}`,
    },
  });
  await client.userOrganization.create({
    data: { userId: user, organizationId, role: 'USER' },
  });
};

let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  repository = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaTransaction(prisma)
  );
  discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  const captureAttempts = new ContentStudioSourceCaptureAttemptRepository(
    new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
  );
  ingestion = new ContentStudioSourceIngestionService(
    repository,
    discoveries,
    captureAttempts
  );
  service = new ContentStudioSourceService(
    repository,
    discoveries,
    captureAttempts
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P8O1 ${id}` } });
  }
  await addUser(USER_A, ORG_A);
  await addUser(USER_B, ORG_B);
});

beforeEach(async () => {
  await clean();
  web.feeds.clear();
  web.pages.clear();
  web.failing.clear();
  web.held.clear();
  mockSafeFetch.mockClear();
  Object.assign(mockLimits, {
    activeFeedsMax: 1000,
    urlSourcesMax: 1000,
    manualRefreshCooldownMs: 0,
  });
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  jest.restoreAllMocks();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('P8-O1 on PostgreSQL: the table', () => {
  it('PG1 a record belongs to a feed of its own organization, keeps the feed from being deleted, and outlives the member who asked', async () => {
    const feed = await fixtureFeed(ORG_A, 'schema');
    // never bound to a feed of another organization
    expect(
      await prismaCode(
        client.contentStudioSourceCaptureAttempt.create({
          data: {
            id: randomUUID(),
            organizationId: ORG_B,
            sourceId: feed,
            trigger: 'scheduled',
            status: 'running',
            startedAt: new Date(),
            attemptCount: 1,
          },
        })
      )
    ).toBe('P2003');
    await addUser(USER_GONE, ORG_A);
    const id = randomUUID();
    await client.contentStudioSourceCaptureAttempt.create({
      data: {
        id,
        organizationId: ORG_A,
        sourceId: feed,
        trigger: 'manual',
        status: 'running',
        requestedByUserId: USER_GONE,
        startedAt: new Date(),
        attemptCount: 1,
      },
    });
    // Restrict: a feed with records is never deleted from under them
    expect(
      await prismaCode(
        client.contentStudioSource.delete({ where: { id: feed } })
      )
    ).toBe('P2003');
    // SetNull: deleting the member keeps the record, without the member
    await client.userOrganization.deleteMany({ where: { userId: USER_GONE } });
    await client.user.delete({ where: { id: USER_GONE } });
    expect(
      await client.contentStudioSourceCaptureAttempt.findUniqueOrThrow({
        where: { id },
      })
    ).toMatchObject({ id, requestedByUserId: null, trigger: 'manual' });
  });
});

describe('P8-O1 on PostgreSQL: a record begins and ends once', () => {
  it('PG2/M1/M2/M3 every try of one scheduled run keeps one record: its start, the highest try, never lower, also when tries race', async () => {
    const feed = await fixtureFeed(ORG_A, 'tries');
    web.failing.add(feedUrl('tries'));
    const run = randomUUID();
    await expect(scheduled(ORG_A, feed, run, 1)).rejects.toBeInstanceOf(
      HttpException
    );
    const [first] = await records(feed);
    expect(first).toMatchObject({
      id: run,
      trigger: 'scheduled',
      status: 'running',
      attemptCount: 1,
      requestedByUserId: null,
      finishedAt: null,
    });
    await expect(scheduled(ORG_A, feed, run, 3)).rejects.toBeInstanceOf(
      HttpException
    );
    await expect(scheduled(ORG_A, feed, run, 2)).rejects.toBeInstanceOf(
      HttpException
    );
    expect(await records(feed)).toEqual([{ ...first, attemptCount: 3 }]);
    // five tries of another run at once: one row, the highest try
    const other = randomUUID();
    await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => scheduled(ORG_A, feed, other, n))
    );
    const rows = (await records(feed)).filter((r) => r.id === other);
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(5);
  });

  it('PG3/M7/M8 a success ends its record once; a late end or another success never changes it', async () => {
    const feed = await fixtureFeed(ORG_A, 'once');
    readable('once');
    const run = randomUUID();
    await scheduled(ORG_A, feed, run, 1);
    const [ended] = await records(feed);
    expect(ended.status).toBe('success');
    expect(await finish(ORG_A, feed, run)).toEqual({ status: 'unchanged' });
    expect(
      await finish(ORG_A, feed, run, 'infrastructure_failed', null)
    ).toEqual({ status: 'unchanged' });
    // a late try of the same run captures again; its record stays
    await scheduled(ORG_A, feed, run, 2);
    expect(await records(feed)).toEqual([ended]);
  });

  it('PG4/M27/M30 another organization never reads, ends or takes over a record', async () => {
    const feed = await fixtureFeed(ORG_A, 'tenant');
    web.failing.add(feedUrl('tenant'));
    const run = randomUUID();
    await expect(scheduled(ORG_A, feed, run)).rejects.toBeInstanceOf(
      HttpException
    );
    const before = await records(feed);
    expect(await finish(ORG_B, feed, run)).toEqual({ status: 'unchanged' });
    expect((await refusal(history(ORG_B, feed))).status).toBe(404);
    // a feed of the other organization under the same run id: no fetch
    const theirs = await fixtureFeed(ORG_B, 'tenant-b');
    readable('tenant-b');
    mockSafeFetch.mockClear();
    expect((await refusal(scheduled(ORG_B, theirs, run))).code).toBe(
      'CS_SOURCE_INTEGRITY_ERROR'
    );
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await records(feed)).toEqual(before);
    expect(await records(theirs)).toEqual([]);
  });
});

describe('P8-O1 on PostgreSQL: what a record keeps', () => {
  it('PG5/M11 a scheduled success keeps its counts, its try and the schedule it set, in the success transaction', async () => {
    const feed = await fixtureFeed(ORG_A, 'success', {
      captureIntervalMinutes: 180,
      consecutiveCaptureFailures: 2,
    });
    readable('success');
    const run = randomUUID();
    const result = await scheduled(ORG_A, feed, run, 2);
    const [row] = await records(feed);
    const source = await feedRow(feed);
    expect(row).toMatchObject({
      id: run,
      organizationId: ORG_A,
      sourceId: feed,
      trigger: 'scheduled',
      status: 'success',
      requestedByUserId: null,
      attemptCount: 2,
      errorCode: null,
      nextCaptureAtAfter: source.nextCaptureAt,
      consecutiveFailuresAfter: 0,
    });
    expect(countsOf(row)).toEqual(
      (result as { capture: Record<string, number> }).capture
    );
    expect(row.entriesAccepted).toBe(2);
    expect(row.versionsCreated).toBe(2);
    expect(
      row.nextCaptureAtAfter!.getTime() - source.lastCapturedAt!.getTime()
    ).toBe(3 * HOUR);
    expect(row.finishedAt!.getTime()).toBeGreaterThanOrEqual(
      row.startedAt.getTime()
    );
    const [read] = (await history(ORG_A, feed)).results;
    expect(read.durationMs).toBe(
      row.finishedAt!.getTime() - row.startedAt.getTime()
    );
  });

  it('PG6/MAPI1/M4/M23 a member refresh is a manual record with who asked and one try, read back at once', async () => {
    const feed = await fixtureFeed(ORG_A, 'manual');
    readable('manual');
    await refresh(ORG_A, feed);
    const [row] = await records(feed);
    expect(row).toMatchObject({
      trigger: 'manual',
      status: 'success',
      requestedByUserId: USER_A,
      attemptCount: 1,
      consecutiveFailuresAfter: 0,
    });
    const read = await history(ORG_A, feed);
    expect(read.total).toBe(1);
    expect(read.results[0]).toMatchObject({
      id: row.id,
      trigger: 'manual',
      status: 'success',
    });
    expect(read.results[0]).not.toHaveProperty('requestedByUserId');
  });

  it('PG7/MAPI2/M12/M22 a member refresh that fails is recorded with its code; the feed is not touched at all', async () => {
    const later = ahead(2 * HOUR);
    const feed = await fixtureFeed(ORG_A, 'manual-fail', {
      consecutiveCaptureFailures: 1,
      nextCaptureAt: later,
    });
    web.failing.add(feedUrl('manual-fail'));
    const before = await feedRow(feed);
    expect((await refusal(refresh(ORG_A, feed))).code).toBe(
      'CS_SOURCE_FETCH_FAILED'
    );
    expect(await feedRow(feed)).toEqual(before);
    const [row] = await records(feed);
    expect(row).toMatchObject({
      trigger: 'manual',
      status: 'source_failed',
      errorCode: 'CS_SOURCE_FETCH_FAILED',
      attemptCount: 1,
      nextCaptureAtAfter: later,
      consecutiveFailuresAfter: 1,
    });
    expect(Object.values(countsOf(row))).toEqual(COUNTS.map(() => null));
    expect((await history(ORG_A, feed)).results[0]).toMatchObject({
      status: 'source_failed',
      errorCode: 'CS_SOURCE_FETCH_FAILED',
      summary: null,
    });
  });

  it('PG8/M14/M17 a scheduled run that failed for the feed: its failure counted once, then its record ends with the schedule that left', async () => {
    const feed = await fixtureFeed(ORG_A, 'failed', {
      nextCaptureAt: ago(MINUTE),
    });
    web.failing.add(feedUrl('failed'));
    const run = randomUUID();
    for (const n of [1, 2, 3]) {
      await expect(scheduled(ORG_A, feed, run, n)).rejects.toBeInstanceOf(
        HttpException
      );
    }
    expect(await record(ORG_A, feed)).toEqual({ status: 'recorded' });
    expect(await finish(ORG_A, feed, run)).toEqual({ status: 'finished' });
    const source = await feedRow(feed);
    const [row] = await records(feed);
    expect(row).toMatchObject({
      status: 'source_failed',
      errorCode: 'CS_SOURCE_FETCH_FAILED',
      attemptCount: 3,
      nextCaptureAtAfter: source.nextCaptureAt,
      consecutiveFailuresAfter: 1,
    });
    expect(source.consecutiveCaptureFailures).toBe(1);
    // the end again changes neither the record nor the feed
    expect(await finish(ORG_A, feed, run)).toEqual({ status: 'unchanged' });
    expect(await records(feed)).toEqual([row]);
    expect(await feedRow(feed)).toEqual(source);
  });

  it('PG9/M24 a member success between the failure and its record wins the feed; the failed run still ends as failed, with the schedule of the success', async () => {
    const feed = await fixtureFeed(ORG_A, 'loses', {
      nextCaptureAt: ago(MINUTE),
    });
    web.failing.add(feedUrl('loses'));
    const run = randomUUID();
    await expect(scheduled(ORG_A, feed, run, 3)).rejects.toBeInstanceOf(
      HttpException
    );
    web.failing.clear();
    readable('loses');
    await refresh(ORG_A, feed);
    const won = await feedRow(feed);
    expect(await record(ORG_A, feed)).toEqual({ status: 'unchanged' });
    expect(await finish(ORG_A, feed, run)).toEqual({ status: 'finished' });
    const rows = await records(feed);
    expect(rows.map((r) => [r.trigger, r.status])).toEqual([
      ['scheduled', 'source_failed'],
      ['manual', 'success'],
    ]);
    expect(rows[0]).toMatchObject({
      consecutiveFailuresAfter: 0,
      nextCaptureAtAfter: won.nextCaptureAt,
    });
    expect(await feedRow(feed)).toEqual(won);
  });

  it('PG10 a member refresh that read first and ends last: both successes are kept, the feed keeps the later schedule, both records show it', async () => {
    const feed = await fixtureFeed(ORG_A, 'overlap');
    readable('overlap');
    let release!: () => void;
    web.held.set(
      page('overlap-1'),
      new Promise<void>((resolve) => (release = resolve))
    );
    const first = refresh(ORG_A, feed);
    while (web.held.size) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduled(ORG_A, feed, randomUUID());
    const between = await feedRow(feed);
    release();
    await first;
    expect(await feedRow(feed)).toEqual(between);
    const rows = await records(feed);
    expect(rows.map((r) => [r.trigger, r.status])).toEqual([
      ['manual', 'success'],
      ['scheduled', 'success'],
    ]);
    for (const row of rows) {
      expect(row.nextCaptureAtAfter).toEqual(between.nextCaptureAt);
      expect(row.consecutiveFailuresAfter).toBe(0);
    }
  });

  it('PG16/M13/M18 a failure of the system is ended without a code and changes nothing of the feed', async () => {
    const due = ago(MINUTE);
    const feed = await fixtureFeed(ORG_A, 'system', { nextCaptureAt: due });
    readable('system');
    jest
      .spyOn(discoveries, 'recordDiscovery')
      .mockRejectedValue(new Error('connection reset'));
    const run = randomUUID();
    await expect(scheduled(ORG_A, feed, run, 3)).rejects.toThrow(
      'connection reset'
    );
    const before = await feedRow(feed);
    expect(
      await finish(ORG_A, feed, run, 'infrastructure_failed', null)
    ).toEqual({ status: 'finished' });
    expect(await feedRow(feed)).toEqual(before);
    expect(before).toMatchObject({
      nextCaptureAt: due,
      consecutiveCaptureFailures: 0,
    });
    // a member refresh that fails the same way
    await expect(refresh(ORG_A, feed)).rejects.toThrow('connection reset');
    expect(
      (await records(feed)).map((r) => [r.trigger, r.status, r.errorCode])
    ).toEqual([
      ['scheduled', 'infrastructure_failed', null],
      ['manual', 'infrastructure_failed', null],
    ]);
    expect(await feedRow(feed)).toEqual(before);
  });
});

describe('P8-O1 on PostgreSQL: what has no record', () => {
  it('MAPI3/MAPI4/M24/M25 a refresh refused too soon, archived or missing, and a scheduled skip, have none', async () => {
    mockLimits.manualRefreshCooldownMs = 5 * MINUTE;
    const recent = await fixtureFeed(ORG_A, 'soon', {
      lastCapturedAt: ago(MINUTE),
    });
    const archived = await fixtureFeed(ORG_A, 'archived', {
      archivedAt: ago(HOUR),
    });
    const paused = await fixtureFeed(ORG_A, 'paused', {
      scanPausedAt: ago(HOUR),
    });
    expect((await refusal(refresh(ORG_A, recent))).code).toBe(
      'CS_SOURCE_REFRESH_TOO_SOON'
    );
    expect((await refusal(refresh(ORG_A, archived))).code).toBe(
      'CS_SOURCE_ARCHIVED'
    );
    expect((await refusal(refresh(ORG_B, recent))).code).toBe('CS_NOT_FOUND');
    for (const feed of [paused, archived]) {
      expect(await scheduled(ORG_A, feed, randomUUID())).toEqual({
        status: 'skipped',
      });
    }
    expect(
      await client.contentStudioSourceCaptureAttempt.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(0);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('PG14/M26 a paused feed refreshed by a member is recorded; pause, resume, an interval, archive and restore add and change none', async () => {
    const feed = await fixtureFeed(ORG_A, 'life', { scanPausedAt: ago(HOUR) });
    readable('life');
    await refresh(ORG_A, feed);
    expect((await feedRow(feed)).scanPausedAt).not.toBeNull();
    const rows = await records(feed);
    expect(rows.map((r) => [r.trigger, r.status])).toEqual([
      ['manual', 'success'],
    ]);
    await service.resumeFeed(ORG_A, feed);
    await service.setFeedInterval(ORG_A, feed, 720);
    await service.pauseFeed(ORG_A, feed);
    await service.archiveSource(ORG_A, feed);
    expect(await records(feed)).toEqual(rows);
    // PG11/M39 an archived feed keeps its history, read as before
    expect((await history(ORG_A, feed)).results.map((r) => r.id)).toEqual([
      rows[0].id,
    ]);
    await service.restoreSource(ORG_A, feed);
    expect(await records(feed)).toEqual(rows);
  });
});

describe('P8-O1 on PostgreSQL: the read', () => {
  const fixtureRecords = async (feed: string, n: number, at: Date) => {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: randomUUID(),
      organizationId: ORG_A,
      sourceId: feed,
      trigger: i % 3 ? 'scheduled' : 'manual',
      status: 'success',
      // two records share each start: the id orders them
      startedAt: new Date(at.getTime() + Math.floor(i / 2) * 1000),
      finishedAt: new Date(at.getTime() + Math.floor(i / 2) * 1000 + 500),
      attemptCount: 1,
      entriesSeen: 1,
      entriesIgnored: 0,
      entriesSkipped: 0,
      entriesAccepted: 1,
      sourcesCreated: 0,
      versionsCreated: 0,
      unchanged: 1,
      failed: 0,
      archived: 0,
      entriesLimited: 0,
      nextCaptureAtAfter: ahead(HOUR),
      consecutiveFailuresAfter: 0,
    }));
    await client.contentStudioSourceCaptureAttempt.createMany({ data: rows });
    return rows;
  };

  it('PG12/M28/M29 newest first, ties by id, 20 a page, every record exactly once', async () => {
    const feed = await fixtureFeed(ORG_A, 'pages');
    const other = await fixtureFeed(ORG_A, 'pages-other');
    const rows = await fixtureRecords(feed, 105, ago(10 * HOUR));
    await fixtureRecords(other, 3, ago(HOUR));
    const expected = [...rows]
      .sort(
        (a, b) =>
          b.startedAt.getTime() - a.startedAt.getTime() ||
          (a.id < b.id ? 1 : -1)
      )
      .map((r) => r.id);
    const seen: string[] = [];
    for (let n = 1; n <= 6; n++) {
      const read = await history(ORG_A, feed, n);
      expect(read.total).toBe(105);
      expect(read.pages).toBe(6);
      expect(read.results.length).toBe(n < 6 ? 20 : 5);
      seen.push(...read.results.map((r) => r.id));
    }
    expect(seen).toEqual(expected);
    expect((await history(ORG_A, feed, 7)).results).toEqual([]);
  });

  it('PG13 a stored record that is not what a capture writes fails closed', async () => {
    const feed = await fixtureFeed(ORG_A, 'corrupt');
    const [row] = await fixtureRecords(feed, 1, ago(HOUR));
    await client.contentStudioSourceCaptureAttempt.update({
      where: { id: row.id },
      data: { status: 'done' },
    });
    expect(await refusal(history(ORG_A, feed))).toEqual({
      status: 500,
      msg: 'Stored source data could not be verified.',
      code: 'CS_SOURCE_INTEGRITY_ERROR',
    });
    await client.contentStudioSourceCaptureAttempt.update({
      where: { id: row.id },
      data: { status: 'success', unchanged: 5 },
    });
    expect((await refusal(history(ORG_A, feed))).code).toBe(
      'CS_SOURCE_INTEGRITY_ERROR'
    );
  });

  it('MAPI5 a page source has no history; a feed of another organization is missing', async () => {
    const pageSource = randomUUID();
    await client.contentStudioSource.create({
      data: {
        id: pageSource,
        organizationId: ORG_A,
        kind: 'url',
        name: 'P8O1 page',
        canonicalUrl: page('alone'),
        createdById: USER_A,
      },
    });
    expect((await refusal(history(ORG_A, pageSource))).status).toBe(400);
    const feed = await fixtureFeed(ORG_A, 'mine');
    await fixtureRecords(feed, 2, ago(HOUR));
    expect(await refusal(history(ORG_B, feed))).toEqual({
      status: 404,
      msg: 'Source not found.',
      code: 'CS_NOT_FOUND',
    });
  });
});
