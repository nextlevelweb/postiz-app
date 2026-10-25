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
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// A feed's schedule (P8-C4) on a real PostgreSQL: the scan is due by the
// next capture alone; a success (scheduled or a member's) schedules the next
// one from its own time, ends the failures and never moves back; a recorded
// failure counts once and loses to a newer success; an interval change
// follows the last capture unless failures delay the feed; pause, resume,
// archive and restore keep all of it, and none of it changes the live feed
// limit (P8-C1). Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. Nothing is fetched: safeFetch is an in-memory web
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
// third one is deleted
const ORG_A = '30c40000-0000-4000-8000-00000000000a';
const ORG_B = '30c40000-0000-4000-8000-00000000000b';
const ORG_D = '30c40000-0000-4000-8000-00000000000d';
const USER_A = '30c40000-0000-4000-8000-0000000000a1';
const USER_B = '30c40000-0000-4000-8000-0000000000b1';
const USER_D = '30c40000-0000-4000-8000-0000000000d1';
const ORGS = [ORG_A, ORG_B, ORG_D];
const USERS = [USER_A, USER_B, USER_D];
const OWNER: Record<string, string> = {
  [ORG_A]: USER_A,
  [ORG_B]: USER_B,
  [ORG_D]: USER_D,
};
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let client: PrismaClient;
let repository: ContentStudioSourceRepository;
let ingestion: ContentStudioSourceIngestionService;
let service: ContentStudioSourceService;

const feedUrl = (name: string) => `https://p8c4.example/${name}.xml`;
const page = (name: string) => `https://p8c4.example/page-${name}`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8C4 page</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8C4</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
// a feed that reads: its RSS and one page
const readable = (name: string) => {
  web.feeds.set(feedUrl(name), rss([page(`${name}-1`)]));
  web.pages.set(page(`${name}-1`), html(`One ${name}`));
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
      name: `P8C4 ${name}`,
      canonicalUrl: feedUrl(name),
      createdById: OWNER[organizationId],
      ...over,
    },
  });
  return id;
};
const row = (id: string) =>
  client.contentStudioSource.findUniqueOrThrow({ where: { id } });
const schedule = async (id: string) => {
  const r = await row(id);
  return {
    lastCapturedAt: r.lastCapturedAt,
    nextCaptureAt: r.nextCaptureAt,
    consecutiveCaptureFailures: r.consecutiveCaptureFailures,
    captureIntervalMinutes: r.captureIntervalMinutes,
  };
};
// the scan's pages, walked to the end, of these organizations only: the
// database is shared with the other suites
const due = async () => {
  const ids: string[] = [];
  let afterId: string | null = null;
  do {
    const result: Awaited<
      ReturnType<ContentStudioSourceIngestionService['listFeedsDueForCapture']>
    > = await ingestion.listFeedsDueForCapture({ afterId });
    ids.push(
      ...result.feeds
        .filter((feed) => ORGS.includes(feed.organizationId))
        .map((feed) => feed.sourceId)
    );
    afterId = result.next;
  } while (afterId);
  return ids.sort();
};
const scheduled = (organizationId: string, sourceId: string) =>
  ingestion.captureScheduledFeed({ organizationId, sourceId });
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
    /P20\d\d|[Cc]onstraint|[Pp]risma|[Ss]erializ|\bSELECT\b|"ContentStudio|p8c4\.example/
  );
  return { status: (err as HttpException).getStatus(), ...body } as Record<
    string,
    unknown
  >;
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
  const prisma = client as unknown as PrismaService;
  repository = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaTransaction(prisma)
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  ingestion = new ContentStudioSourceIngestionService(repository, discoveries);
  service = new ContentStudioSourceService(repository, discoveries);
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({
      data: {
        id,
        name: `P8C4 ${id}`,
        ...(id === ORG_D ? { deletedAt: new Date() } : {}),
      },
    });
  }
  for (const user of USERS) {
    const org = ORGS[USERS.indexOf(user)];
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p8c4.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8C4 ${user}`,
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
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('P8-C4 on PostgreSQL: the scan', () => {
  it('P8C4PG1/M1-M6 lists live running feeds of live organizations whose next capture is not set or at or before the time, in id order', async () => {
    const at = new Date(Date.now() - MINUTE);
    const never = await fixtureFeed(ORG_A, 'never');
    const past = await fixtureFeed(ORG_A, 'past', {
      nextCaptureAt: new Date(at.getTime() - 1),
    });
    const exact = await fixtureFeed(ORG_B, 'exact', { nextCaptureAt: at });
    // the last capture alone decides nothing any more (M7/M8)
    const future = await fixtureFeed(ORG_A, 'future', {
      lastCapturedAt: ago(7 * 24 * HOUR),
      nextCaptureAt: new Date(at.getTime() + 1),
    });
    const paused = await fixtureFeed(ORG_A, 'paused', {
      nextCaptureAt: ago(HOUR),
      scanPausedAt: ago(HOUR),
    });
    const archived = await fixtureFeed(ORG_A, 'archived', {
      nextCaptureAt: ago(HOUR),
      archivedAt: ago(HOUR),
    });
    const deleted = await fixtureFeed(ORG_D, 'deleted', {
      nextCaptureAt: ago(HOUR),
    });
    const pageId = await fixtureFeed(ORG_A, 'page', {
      kind: 'url',
      canonicalUrl: page('page'),
      nextCaptureAt: ago(HOUR),
    });
    const rows = await repository.listFeedsDueForCapture({
      dueAt: at,
      afterId: null,
      take: 1000,
    });
    const ids = rows
      .filter((r) => ORGS.includes(r.organizationId))
      .map((r) => r.id);
    expect(ids).toEqual([never, past, exact].sort());
    for (const id of [future, paused, archived, deleted, pageId]) {
      expect(ids).not.toContain(id);
    }
    // every row in id order, ids and organizations only
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
    expect(Object.keys(rows[0]).sort()).toEqual(['id', 'organizationId']);
    // the scan itself, at its own time (now): a millisecond after the time
    // above has passed too; the paused, archived and deleted ones stay out
    expect(await due()).toEqual([never, past, exact, future].sort());
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('P8C4PG2 a feed from before P8-C4 reads null, null and 0, is due once, and is scheduled an hour after its capture', async () => {
    const id = randomUUID();
    // written without the new fields, as every row before P8-C4
    await client.contentStudioSource.create({
      data: {
        id,
        organizationId: ORG_A,
        kind: 'feed',
        name: 'P8C4 legacy',
        canonicalUrl: feedUrl('legacy'),
        createdById: USER_A,
        lastCapturedAt: ago(30 * MINUTE),
      },
    });
    expect(await schedule(id)).toEqual({
      lastCapturedAt: expect.any(Date),
      nextCaptureAt: null,
      consecutiveCaptureFailures: 0,
      captureIntervalMinutes: null,
    });
    // captured 30 minutes ago, still due once: no backfill
    expect(await due()).toEqual([id]);
    readable('legacy');
    await scheduled(ORG_A, id);
    const after = await schedule(id);
    expect(
      after.nextCaptureAt!.getTime() - after.lastCapturedAt!.getTime()
    ).toBe(HOUR);
    expect(after.consecutiveCaptureFailures).toBe(0);
    expect(await due()).toEqual([]);
  });
});

describe('P8-C4 on PostgreSQL: a successful capture', () => {
  it('P8C4PG3/M14 never moves back: an older capture that ends later changes nothing', async () => {
    const feed = await fixtureFeed(ORG_A, 'mono');
    const newer = ago(MINUTE);
    const older = ago(2 * MINUTE);
    expect(
      await repository.markFeedCaptured(
        ORG_A,
        feed,
        newer,
        new Date(newer.getTime() + HOUR)
      )
    ).toEqual({ count: 1 });
    expect(
      await repository.markFeedCaptured(
        ORG_A,
        feed,
        older,
        new Date(older.getTime() + HOUR)
      )
    ).toEqual({ count: 0 });
    // the same time again is no later read either
    expect(
      await repository.markFeedCaptured(ORG_A, feed, newer, ahead(9 * HOUR))
    ).toEqual({ count: 0 });
    expect(await schedule(feed)).toEqual({
      lastCapturedAt: newer,
      nextCaptureAt: new Date(newer.getTime() + HOUR),
      consecutiveCaptureFailures: 0,
      captureIntervalMinutes: null,
    });
  });

  it('P8C4PG3 a member refresh that read the feed first and ends last leaves the scheduled capture that ended in between', async () => {
    const feed = await fixtureFeed(ORG_A, 'overlap');
    readable('overlap');
    let release!: () => void;
    web.held.set(
      page('overlap-1'),
      new Promise<void>((resolve) => (release = resolve))
    );
    const first = refresh(ORG_A, feed);
    // the refresh read the feed and waits on its page
    while (web.held.size) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduled(ORG_A, feed);
    const between = await schedule(feed);
    release();
    const result = await first;
    expect(await schedule(feed)).toEqual(between);
    expect(result.source.lastCapturedAt).toEqual(between.lastCapturedAt);
    expect(
      between.nextCaptureAt!.getTime() - between.lastCapturedAt!.getTime()
    ).toBe(HOUR);
  });

  it('IG2/IG3/M12/M13 a member refresh schedules the feed and ends its failures, paused or not; a failed one writes nothing', async () => {
    const delayed = ahead(5 * HOUR);
    const feed = await fixtureFeed(ORG_A, 'manual', {
      captureIntervalMinutes: 720,
      consecutiveCaptureFailures: 4,
      nextCaptureAt: delayed,
      scanPausedAt: ago(HOUR),
    });
    web.failing.add(feedUrl('manual'));
    const before = await row(feed);
    expect((await refusal(refresh(ORG_A, feed))).code).toBe(
      'CS_SOURCE_FETCH_FAILED'
    );
    // M25 no failure, next or last capture, not even updatedAt
    expect(await row(feed)).toEqual(before);
    web.failing.clear();
    readable('manual');
    await refresh(ORG_A, feed);
    const after = await row(feed);
    expect(after.consecutiveCaptureFailures).toBe(0);
    expect(
      after.nextCaptureAt!.getTime() - after.lastCapturedAt!.getTime()
    ).toBe(12 * HOUR);
    expect(after.scanPausedAt).toEqual(before.scanPausedAt);
  });
});

describe('P8-C4 on PostgreSQL: a scheduled failure', () => {
  it('P8C4PG4/M22 one more, the next try an hour later, the last capture kept; recorded again it changes nothing', async () => {
    const last = ago(3 * HOUR);
    const feed = await fixtureFeed(ORG_A, 'fail', {
      lastCapturedAt: last,
      nextCaptureAt: ago(MINUTE),
      captureIntervalMinutes: 1440,
    });
    const from = Date.now();
    expect(await record(ORG_A, feed)).toEqual({ status: 'recorded' });
    const to = Date.now();
    const first = await schedule(feed);
    expect(first.consecutiveCaptureFailures).toBe(1);
    expect(first.lastCapturedAt).toEqual(last);
    // M20 an hour, never the feed's day
    expect(first.nextCaptureAt!.getTime()).toBeGreaterThanOrEqual(from + HOUR);
    expect(first.nextCaptureAt!.getTime()).toBeLessThanOrEqual(to + HOUR);
    expect(await record(ORG_A, feed)).toEqual({ status: 'unchanged' });
    expect(await schedule(feed)).toEqual(first);
    expect(await due()).toEqual([]);
  });

  it('P8C4PG5/M23 concurrent records from the same state count once', async () => {
    const feed = await fixtureFeed(ORG_A, 'race');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => record(ORG_A, feed))
    );
    expect(results.filter((r) => r.status === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'unchanged')).toHaveLength(5);
    expect((await row(feed)).consecutiveCaptureFailures).toBe(1);
  });

  it('P8C4PG6/M24 a member success after the failure and before its record wins', async () => {
    const feed = await fixtureFeed(ORG_A, 'wins', {
      consecutiveCaptureFailures: 2,
      nextCaptureAt: ago(MINUTE),
    });
    readable('wins');
    await refresh(ORG_A, feed);
    const after = await schedule(feed);
    expect(await record(ORG_A, feed)).toEqual({ status: 'unchanged' });
    expect(await schedule(feed)).toEqual(after);
    expect(after.consecutiveCaptureFailures).toBe(0);
  });

  it('B1-B7 the delay doubles with each failure in a row up to a day, and a success ends it', async () => {
    const feed = await fixtureFeed(ORG_A, 'ladder');
    const delays: number[] = [];
    for (let n = 1; n <= 7; n++) {
      await client.contentStudioSource.update({
        where: { id: feed },
        data: { nextCaptureAt: ago(1000) },
      });
      const from = Date.now();
      expect(await record(ORG_A, feed)).toEqual({ status: 'recorded' });
      const r = await row(feed);
      expect(r.consecutiveCaptureFailures).toBe(n);
      delays.push(Math.round((r.nextCaptureAt!.getTime() - from) / MINUTE));
    }
    expect(delays).toEqual([60, 120, 240, 480, 960, 1440, 1440]);
    await client.contentStudioSource.update({
      where: { id: feed },
      data: { nextCaptureAt: ago(1000) },
    });
    readable('ladder');
    await scheduled(ORG_A, feed);
    expect((await row(feed)).consecutiveCaptureFailures).toBe(0);
  });

  it('a paused feed records its failure; an archived one, one of a deleted organization or another organization does not', async () => {
    const paused = await fixtureFeed(ORG_A, 'fail-paused', {
      scanPausedAt: ago(HOUR),
    });
    expect(await record(ORG_A, paused)).toEqual({ status: 'recorded' });
    const archived = await fixtureFeed(ORG_A, 'fail-archived', {
      archivedAt: ago(HOUR),
    });
    const deleted = await fixtureFeed(ORG_D, 'fail-deleted');
    for (const [org, id] of [
      [ORG_A, archived],
      [ORG_D, deleted],
      [ORG_B, paused],
    ]) {
      expect(await record(org, id)).toEqual({ status: 'skipped' });
    }
    expect((await row(archived)).consecutiveCaptureFailures).toBe(0);
    expect((await row(deleted)).consecutiveCaptureFailures).toBe(0);
    expect((await row(paused)).consecutiveCaptureFailures).toBe(1);
  });
});

describe('P8-C4 on PostgreSQL: the interval', () => {
  it('P8C4PG7/M34 shorter: an hour after the last capture, so due at once', async () => {
    const last = ago(5 * HOUR);
    const feed = await fixtureFeed(ORG_A, 'shorter', {
      lastCapturedAt: last,
      captureIntervalMinutes: 1440,
      nextCaptureAt: new Date(last.getTime() + 24 * HOUR),
    });
    expect(await due()).toEqual([]);
    const answer = await service.setFeedInterval(ORG_A, feed, 60);
    expect(answer.captureIntervalMinutes).toBe(60);
    expect(answer.nextCaptureAt).toEqual(new Date(last.getTime() + HOUR));
    expect(await due()).toEqual([feed]);
  });

  it('P8C4PG8/M35 longer: a day after the last capture', async () => {
    const last = ago(30 * MINUTE);
    const feed = await fixtureFeed(ORG_A, 'longer', {
      lastCapturedAt: last,
      nextCaptureAt: new Date(last.getTime() + HOUR),
    });
    await service.setFeedInterval(ORG_A, feed, 1440);
    expect(await schedule(feed)).toEqual({
      lastCapturedAt: last,
      nextCaptureAt: new Date(last.getTime() + 24 * HOUR),
      consecutiveCaptureFailures: 0,
      captureIntervalMinutes: 1440,
    });
  });

  it('P8C4PG9/M36 after failures the failure delay stays; the interval changes', async () => {
    const delayed = ahead(3 * HOUR);
    const feed = await fixtureFeed(ORG_A, 'backoff', {
      lastCapturedAt: ago(20 * HOUR),
      consecutiveCaptureFailures: 3,
      nextCaptureAt: delayed,
    });
    await service.setFeedInterval(ORG_A, feed, 180);
    expect(await schedule(feed)).toMatchObject({
      nextCaptureAt: delayed,
      consecutiveCaptureFailures: 3,
      captureIntervalMinutes: 180,
    });
  });

  it('SI7/SI8/SI10 never captured stays due; paused may change; the same value writes nothing', async () => {
    const feed = await fixtureFeed(ORG_A, 'same', { scanPausedAt: ago(HOUR) });
    await service.setFeedInterval(ORG_A, feed, 360);
    const once = await row(feed);
    expect(once).toMatchObject({
      captureIntervalMinutes: 360,
      nextCaptureAt: null,
      scanPausedAt: expect.any(Date),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.setFeedInterval(ORG_A, feed, 360);
    expect(await row(feed)).toEqual(once);
  });

  it('concurrent interval changes leave one of them whole: the next capture always follows the interval kept', async () => {
    const last = ago(2 * HOUR);
    const feed = await fixtureFeed(ORG_A, 'concurrent', {
      lastCapturedAt: last,
    });
    await Promise.all(
      [180, 1440, 360, 720].map((minutes) =>
        service.setFeedInterval(ORG_A, feed, minutes)
      )
    );
    const r = await row(feed);
    expect([180, 1440, 360, 720]).toContain(r.captureIntervalMinutes);
    expect(r.nextCaptureAt!.getTime() - last.getTime()).toBe(
      r.captureIntervalMinutes! * MINUTE
    );
  });

  it('refuses another organization, a page, an archived feed and a value that is no preset, writing nothing', async () => {
    const feed = await fixtureFeed(ORG_A, 'refuse');
    const archived = await fixtureFeed(ORG_A, 'refuse-archived', {
      archivedAt: ago(HOUR),
    });
    const pageId = await fixtureFeed(ORG_A, 'refuse-page', {
      kind: 'url',
      canonicalUrl: page('refuse-page'),
    });
    const before = JSON.stringify(
      await client.contentStudioSource.findMany({
        where: { organizationId: { in: ORGS } },
        orderBy: { id: 'asc' },
      })
    );
    expect((await refusal(service.setFeedInterval(ORG_B, feed, 60))).code).toBe(
      'CS_NOT_FOUND'
    );
    expect(
      (await refusal(service.setFeedInterval(ORG_A, pageId, 60))).code
    ).toBe('CS_SOURCE_KIND_UNSUPPORTED');
    expect(
      (await refusal(service.setFeedInterval(ORG_A, archived, 60))).code
    ).toBe('CS_SOURCE_ARCHIVED');
    expect((await refusal(service.setFeedInterval(ORG_A, feed, 90))).code).toBe(
      'CS_SOURCE_INTERVAL_INVALID'
    );
    expect(
      JSON.stringify(
        await client.contentStudioSource.findMany({
          where: { organizationId: { in: ORGS } },
          orderBy: { id: 'asc' },
        })
      )
    ).toBe(before);
  });
});

describe('P8-C4 on PostgreSQL: the lifecycle and the limit', () => {
  const kept = () => ({
    lastCapturedAt: ago(2 * HOUR),
    nextCaptureAt: ahead(3 * HOUR),
    consecutiveCaptureFailures: 2,
    captureIntervalMinutes: 720,
  });

  it('P8C4PG10 pause and resume keep the interval, the next capture and the failures', async () => {
    const state = kept();
    const feed = await fixtureFeed(ORG_A, 'pause', state);
    await service.pauseFeed(ORG_A, feed);
    expect(await schedule(feed)).toEqual(state);
    await service.resumeFeed(ORG_A, feed);
    expect(await schedule(feed)).toEqual(state);
    // T6 resumed overdue: due at once, once
    await client.contentStudioSource.update({
      where: { id: feed },
      data: { scanPausedAt: ago(HOUR), nextCaptureAt: ago(HOUR) },
    });
    await service.resumeFeed(ORG_A, feed);
    expect(await due()).toEqual([feed]);
    readable('pause');
    await scheduled(ORG_A, feed);
    expect(await due()).toEqual([]);
  });

  it('P8C4PG11 archive and restore keep them too', async () => {
    const state = kept();
    const feed = await fixtureFeed(ORG_A, 'archive', state);
    await service.archiveSource(ORG_A, feed);
    expect(await schedule(feed)).toEqual(state);
    await service.restoreSource(ORG_A, feed);
    expect(await schedule(feed)).toEqual(state);
  });

  it('P8C4PG12 intervals, failures and the pause change nothing of the live feed limit', async () => {
    mockLimits.activeFeedsMax = 3;
    await fixtureFeed(ORG_A, 'cap-daily', { captureIntervalMinutes: 1440 });
    await fixtureFeed(ORG_A, 'cap-failing', {
      consecutiveCaptureFailures: 9,
      nextCaptureAt: ahead(24 * HOUR),
    });
    const paused = await fixtureFeed(ORG_A, 'cap-paused', {
      scanPausedAt: ago(HOUR),
    });
    const create = () =>
      service.createSource({
        organizationId: ORG_A,
        userId: USER_A,
        kind: 'feed',
        name: 'P8C4 cap new',
        url: feedUrl('cap-new'),
      });
    expect((await refusal(create())).code).toBe('CS_SOURCE_FEED_LIMIT');
    await service.archiveSource(ORG_A, paused);
    const created = await create();
    expect(created).toMatchObject({
      kind: 'feed',
      captureIntervalMinutes: null,
      nextCaptureAt: null,
      consecutiveCaptureFailures: 0,
    });
    // a new feed is due at the next scan; nothing is fetched by its creation
    expect(await due()).toContain(created.id);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
