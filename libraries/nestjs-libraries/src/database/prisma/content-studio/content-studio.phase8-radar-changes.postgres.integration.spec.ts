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
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import {
  contentStudioPostgresUrlFromEnv,
  createContentStudioPostgresClient,
} from '../../../../../../jest.content-studio.postgres.guard';

// News Radar change signals (P8-04B2) on a real PostgreSQL: whether a found
// page changed after the feed found it, from the page's P8-04B1 last page
// change and the discovery's first sighting, for every row of News Radar and
// of a feed's page list. Page changes are made by real refreshes and feed
// captures where the order of a run matters, and written as P8-04B1 stores
// them (checked by the Changes read) where a time must be exact. Opt-in:
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
const ORG_A = '30842000-0000-4000-8000-00000000000a';
const ORG_B = '30842000-0000-4000-8000-00000000000b';
const USER_A = '30842000-0000-4000-8000-0000000000a1';
const USER_B = '30842000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const V1 = 'content-studio-source-v1';
const V2 = 'content-studio-source-v2';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const INTEGRITY = {
  status: 500,
  msg: 'Stored source data could not be verified.',
  code: 'CS_SOURCE_INTEGRITY_ERROR',
};

let client: PrismaClient;
let logged: PrismaClient;
let queries: string[];
let ingestion: ContentStudioSourceIngestionService;
let service: ContentStudioSourceService;
let loggedService: ContentStudioSourceService;
let now: Date;
const ago = (ms: number) => new Date(now.getTime() - ms);
const later = (date: Date, ms: number) => new Date(date.getTime() + ms);

const feedUrl = (name: string) => `https://p8042.example/${name}.xml`;
const page = (name: string) => `https://p8042.example/page-${name}`;
const html = (text: string, title = 'P8042 page') =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8042</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;

const createSource = async (
  organizationId: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) => {
  const id = randomUUID();
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8042 page',
      canonicalUrl: page(id),
      createdById: OWNER[organizationId],
      ...over,
    },
  });
  return id;
};
const createFeed = (organizationId: string, name: string) =>
  createSource(organizationId, {
    kind: 'feed',
    name: `P8042 ${name}`,
    canonicalUrl: feedUrl(name),
  });
// a sighting as feed capture writes it
const discovery = async (
  organizationId: string,
  feedSourceId: string,
  discoveredSourceId: string,
  firstSeenAt: Date
) =>
  (
    await client.contentStudioSourceDiscovery.create({
      data: {
        organizationId,
        feedSourceId,
        discoveredSourceId,
        entryTitle: 'P8042 entry',
        firstSeenAt,
        lastSeenAt: firstSeenAt,
      },
      select: { id: true },
    })
  ).id;
// a page with captures at the given times, the last two different, and the
// last page change P8-04B1 keeps for them: the last capture, against the one
// before it
const changedPage = async (
  organizationId: string,
  fetchedAt: Date[],
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) => {
  const id = await createSource(organizationId, over);
  await client.contentStudioSourceVersion.createMany({
    data: fetchedAt.map((at, i) => ({
      id: randomUUID(),
      organizationId,
      sourceId: id,
      versionNumber: i + 1,
      extractionVersion: V2,
      requestedUrl: page(id),
      finalUrl: page(id),
      redirectCount: 0,
      fetchedAt: at,
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 100,
      title: 'P8042 page',
      sourceHash: null,
      createdById: OWNER[organizationId],
      ...storedContentStudioSourceContent({
        schemaVersion: 1,
        blocks: [
          { id: 'b1', type: 'paragraph', text: `Text ${i}`, level: null },
        ],
      }),
    })),
  });
  const n = fetchedAt.length;
  await client.contentStudioSource.update({
    where: { id },
    data: {
      latestVersionNumber: n,
      ...(n >= 2
        ? {
            lastPageChangeAt: fetchedAt[n - 1],
            lastPageChangeVersionNumber: n,
            lastPageChangeKind: 'content_changed',
            lastPageChangePreviousCaptureAt: fetchedAt[n - 2],
          }
        : {}),
    },
  });
  return id;
};
const refresh = (organizationId: string, sourceId: string) =>
  ingestion.refreshSource({
    organizationId,
    userId: OWNER[organizationId],
    sourceId,
  });
const pageId = async (organizationId: string, url: string) =>
  (
    await client.contentStudioSource.findFirstOrThrow({
      where: { organizationId, canonicalUrl: url },
      select: { id: true },
    })
  ).id;
// the next millisecond at least: what PostgreSQL keeps of a date
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const radar = (organizationId = ORG_A, on = service) =>
  on.listOrganizationDiscoveries({ organizationId, page: 1, since: 'all' });
const feedList = (sourceId: string, organizationId = ORG_A) =>
  service.listDiscoveries({ organizationId, sourceId, page: 1 });
type Signal = {
  id: string;
  changedSinceFound: boolean;
  source: {
    id: string;
    archivedAt: Date | null;
    lastPageChangeAt: Date | null;
  };
};
const signals = (result: { results: Signal[] }) =>
  Object.fromEntries(
    result.results.map((row) => [row.id, row.changedSinceFound])
  );
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
    /P20\d\d|[Cc]onstraint|[Pp]risma|\bSELECT\b|"ContentStudio|p8042\.example/
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
const services = (prisma: PrismaService) => {
  const sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaTransaction(prisma)
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  const captureAttempts = new ContentStudioSourceCaptureAttemptRepository(
    new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
  );
  return {
    ingestion: new ContentStudioSourceIngestionService(
      sources,
      discoveries,
      captureAttempts
    ),
    service: new ContentStudioSourceService(
      sources,
      discoveries,
      captureAttempts
    ),
  };
};

let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  ({ ingestion, service } = services(client as unknown as PrismaService));
  // the same database, with every statement it is sent
  const logging = new PrismaClient({
    datasources: { db: { url: contentStudioPostgresUrlFromEnv() } },
    log: [{ emit: 'event', level: 'query' }],
  });
  logging.$on('query', (event) => queries.push(event.query));
  logged = logging;
  await logged.$connect();
  loggedService = services(logged as unknown as PrismaService).service;
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P8042 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p8042.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8042 ${user}`,
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
  queries = [];
  // whole milliseconds: what PostgreSQL keeps of a JavaScript date
  now = new Date(Math.floor(Date.now() / 1000) * 1000);
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

afterAll(async () => {
  await logged?.$disconnect();
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('News Radar change signals on PostgreSQL: the rule', () => {
  it('P804B2PG1 no page change is no signal; half a page change fails the read closed', async () => {
    const feed = await createFeed(ORG_A, 'pg1');
    const once = await changedPage(ORG_A, [ago(3 * DAY)]);
    const d = await discovery(ORG_A, feed, once, ago(4 * DAY));
    const [row] = (await radar()).results;
    expect([
      row.id,
      row.changedSinceFound,
      row.source.lastPageChangeAt,
    ]).toEqual([d, false, null]);
    for (const half of [
      { lastPageChangePreviousCaptureAt: ago(DAY) },
      { lastPageChangeAt: ago(DAY) },
    ]) {
      await client.contentStudioSource.update({
        where: { id: once },
        data: {
          lastPageChangeAt: null,
          lastPageChangePreviousCaptureAt: null,
          ...half,
        },
      });
      expect(await refusal(radar())).toEqual(INTEGRITY);
      expect(await refusal(feedList(feed))).toEqual(INTEGRITY);
    }
  });

  it('P804B2PG2 a change found against a capture before the first sighting is no signal', async () => {
    const feed = await createFeed(ORG_A, 'pg2');
    const found = ago(2 * DAY);
    const id = await changedPage(ORG_A, [later(found, -1), ago(DAY)]);
    await discovery(ORG_A, feed, id, found);
    // P8-04B1 reads it as a page change
    expect(
      (
        await service.listPageChanges({
          organizationId: ORG_A,
          page: 1,
          since: 'all',
        })
      ).total
    ).toBe(1);
    const [row] = (await radar()).results;
    expect([row.changedSinceFound, row.source.lastPageChangeAt]).toEqual([
      false,
      ago(DAY),
    ]);
  });

  it('P804B2PG3 a change found against a capture at the very millisecond of the first sighting is a signal', async () => {
    const feed = await createFeed(ORG_A, 'pg3');
    const found = new Date(ago(2 * DAY).getTime() + 123);
    const id = await changedPage(ORG_A, [found, ago(DAY)]);
    await discovery(ORG_A, feed, id, found);
    const stored = await client.contentStudioSource.findUniqueOrThrow({
      where: { id },
    });
    expect(stored.lastPageChangePreviousCaptureAt!.getTime()).toBe(
      found.getTime()
    );
    expect((await radar()).results[0].changedSinceFound).toBe(true);
  });

  it('P804B2PG4 a change found against a capture after the first sighting is a signal', async () => {
    const feed = await createFeed(ORG_A, 'pg4');
    const found = ago(2 * DAY);
    const id = await changedPage(ORG_A, [later(found, 1), ago(DAY)]);
    await discovery(ORG_A, feed, id, found);
    const [row] = (await radar()).results;
    expect([row.changedSinceFound, row.source.lastPageChangeAt]).toEqual([
      true,
      ago(DAY),
    ]);
  });
});

describe('News Radar change signals on PostgreSQL: real captures', () => {
  it('P804B2PG5 one page, two feeds: changed since the first found it, not since the second, until it changes again', async () => {
    const url = page('shared');
    const [a, b] = [
      await createFeed(ORG_A, 'pg5-a'),
      await createFeed(ORG_A, 'pg5-b'),
    ];
    web.feeds.set(feedUrl('pg5-a'), rss([url]));
    web.feeds.set(feedUrl('pg5-b'), rss([url]));
    // EX1: feed A finds a new page and the same run captures it
    web.pages.set(url, html('One'));
    await refresh(ORG_A, a);
    const id = await pageId(ORG_A, url);
    await tick();
    // EX2: the page changes; A's next run captures the change
    web.pages.set(url, html('Two'));
    await refresh(ORG_A, a);
    await tick();
    // EX3/EX4: feed B first lists the page; its own run captures a change
    // against the capture A's run made
    web.pages.set(url, html('Three'));
    await refresh(ORG_A, b);
    const [fromA, fromB] = await Promise.all(
      [a, b].map((feedSourceId) =>
        client.contentStudioSourceDiscovery.findFirstOrThrow({
          where: { organizationId: ORG_A, feedSourceId },
        })
      )
    );
    const source = await client.contentStudioSource.findUniqueOrThrow({
      where: { id },
    });
    expect(source.latestVersionNumber).toBe(3);
    // the wrong rule would call it changed for B: the change is after B's
    // first sighting, the capture it was found against is not
    expect(source.lastPageChangeAt!.getTime()).toBeGreaterThanOrEqual(
      fromB.firstSeenAt.getTime()
    );
    expect(source.lastPageChangePreviousCaptureAt!.getTime()).toBeLessThan(
      fromB.firstSeenAt.getTime()
    );
    expect(signals(await radar())).toEqual({
      [fromA.id]: true,
      [fromB.id]: false,
    });
    await tick();
    // EX5: a later change is after both first sightings
    web.pages.set(url, html('Four'));
    await refresh(ORG_A, b);
    expect(signals(await radar())).toEqual({
      [fromA.id]: true,
      [fromB.id]: true,
    });
  });

  it('P804B2PG5 a title-only change after the first sighting is a signal; an extraction-only capture is none', async () => {
    const feed = await createFeed(ORG_A, 'pg5-c');
    const [title, extraction] = [page('title'), page('extraction')];
    web.feeds.set(feedUrl('pg5-c'), rss([title, extraction]));
    web.pages.set(title, html('Same', 'One'));
    web.pages.set(extraction, html('Same'));
    await refresh(ORG_A, feed);
    await tick();
    // the stored capture was made by an earlier extractor: the next one, with
    // other blocks, is another extraction, never a page change
    const extractionId = await pageId(ORG_A, extraction);
    await client.contentStudioSourceVersion.updateMany({
      where: { sourceId: extractionId },
      data: { extractionVersion: V1 },
    });
    web.pages.set(title, html('Same', 'Two'));
    web.pages.set(extraction, html('Other'));
    await refresh(ORG_A, feed);
    const rows = (await radar()).results;
    const of = (sourceId: string) =>
      rows.find((row) => row.source.id === sourceId)!.changedSinceFound;
    const titleId = await pageId(ORG_A, title);
    expect(
      (
        await client.contentStudioSource.findUniqueOrThrow({
          where: { id: titleId },
        })
      ).lastPageChangeKind
    ).toBe('title_changed');
    expect(
      await client.contentStudioSourceVersion.count({
        where: { sourceId: extractionId },
      })
    ).toBe(2);
    expect([of(titleId), of(extractionId)]).toEqual([true, false]);
  });

  it('P804B2PG6 an archived page that changed after it was found is archived and changed', async () => {
    const feed = await createFeed(ORG_A, 'pg6');
    const found = ago(3 * DAY);
    const id = await changedPage(ORG_A, [later(found, HOUR), ago(DAY)], {
      archivedAt: ago(HOUR),
    });
    await discovery(ORG_A, feed, id, found);
    const [row] = (await radar()).results;
    expect([row.source.archivedAt, row.changedSinceFound]).toEqual([
      ago(HOUR),
      true,
    ]);
    expect((await feedList(feed)).results[0].changedSinceFound).toBe(true);
  });
});

describe('News Radar change signals on PostgreSQL: scope and cost', () => {
  it('P804B2PG7 another organization’s page change never reaches the organization', async () => {
    const marker = new Date('2001-02-03T04:05:06.000Z');
    const feedB = await createFeed(ORG_B, 'pg7-b');
    const pageB = await changedPage(ORG_B, [later(marker, -DAY), marker], {
      canonicalUrl: page('pg7-same'),
    });
    const dB = await discovery(ORG_B, feedB, pageB, later(marker, -2 * DAY));
    const feedA = await createFeed(ORG_A, 'pg7-a');
    const pageA = await createSource(ORG_A, {
      canonicalUrl: page('pg7-same'),
      latestVersionNumber: 0,
    });
    const dA = await discovery(ORG_A, feedA, pageA, ago(HOUR));
    const mine = await radar(ORG_A);
    expect(signals(mine)).toEqual({ [dA]: false });
    expect(JSON.stringify(mine)).not.toContain(marker.toISOString());
    expect(signals(await radar(ORG_B))).toEqual({ [dB]: true });
    expect(await refusal(feedList(feedB, ORG_A))).toMatchObject({
      status: 404,
    });
  });

  it('P804B2PG8 the list reads the two times with the page: the same statements for 1 row and for 50, none of a version', async () => {
    const feed = await createFeed(ORG_A, 'pg8');
    const found = ago(10 * DAY);
    const one = await changedPage(ORG_A, [later(found, 1), ago(DAY)]);
    await discovery(ORG_A, feed, one, found);
    queries = [];
    const first = await radar(ORG_A, loggedService);
    const single = [...queries];
    expect(first.results.map((row) => row.changedSinceFound)).toEqual([true]);
    for (let i = 0; i < 49; i++) {
      const id = await changedPage(ORG_A, [
        later(found, i % 2 ? 1 : -1),
        ago(DAY),
      ]);
      await discovery(ORG_A, feed, id, later(found, i + 1));
    }
    queries = [];
    const full = await radar(ORG_A, loggedService);
    expect(full.results).toHaveLength(50);
    expect(new Set(full.results.map((row) => row.changedSinceFound))).toEqual(
      new Set([true, false])
    );
    // the P8-02 read, as before P8-04B2 (measured on its parent): the
    // discoveries, their feeds, their pages, and the count
    expect(queries.length).toBe(single.length);
    expect(queries.length).toBe(4);
    expect(queries.join('\n')).not.toMatch(/ContentStudioSourceVersion/);
    const pages = queries.filter((sql) =>
      /"lastPageChangePreviousCaptureAt"/.test(sql)
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/"lastPageChangeAt"/);
    expect(pages[0]).not.toMatch(
      /"lastPageChangeVersionNumber"|"lastPageChangeKind"|"content"|"contentHash"/
    );
  });

  it('P804B2PG9 a feed’s page list answers each row by the same rule as News Radar', async () => {
    const [a, b] = [
      await createFeed(ORG_A, 'pg9-a'),
      await createFeed(ORG_A, 'pg9-b'),
    ];
    const t1 = ago(10 * DAY);
    const t3 = ago(5 * DAY);
    // the last change found against a capture between the two first sightings
    const shared = await changedPage(ORG_A, [later(t1, HOUR), ago(DAY)]);
    // and one against a capture at B's very first sighting
    const equal = await changedPage(ORG_A, [t3, ago(DAY)]);
    const rows = {
      aShared: await discovery(ORG_A, a, shared, t1),
      bShared: await discovery(ORG_A, b, shared, t3),
      bEqual: await discovery(ORG_A, b, equal, t3),
    };
    const expected = {
      [rows.aShared]: true,
      [rows.bShared]: false,
      [rows.bEqual]: true,
    };
    expect(signals(await radar())).toEqual(expected);
    expect({
      ...signals(await feedList(a)),
      ...signals(await feedList(b)),
    }).toEqual(expected);
  });

  it('P804B2PG10 reading writes nothing, fetches nothing and captures nothing', async () => {
    const feed = await createFeed(ORG_A, 'pg10');
    const found = ago(3 * DAY);
    const id = await changedPage(ORG_A, [later(found, 1), ago(DAY)]);
    await discovery(ORG_A, feed, id, found);
    const snapshot = async () => ({
      sources: await client.contentStudioSource.findMany({
        where: { organizationId: ORG_A },
        orderBy: { id: 'asc' },
      }),
      versions: await client.contentStudioSourceVersion.count({
        where: { organizationId: ORG_A },
      }),
      discoveries: await client.contentStudioSourceDiscovery.findMany({
        where: { organizationId: ORG_A },
        orderBy: { id: 'asc' },
      }),
    });
    const before = await snapshot();
    queries = [];
    await radar(ORG_A, loggedService);
    await loggedService.listDiscoveries({
      organizationId: ORG_A,
      sourceId: feed,
      page: 1,
    });
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) {
      expect(sql).toMatch(/^\s*SELECT\b/i);
    }
    expect(await snapshot()).toEqual(before);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
