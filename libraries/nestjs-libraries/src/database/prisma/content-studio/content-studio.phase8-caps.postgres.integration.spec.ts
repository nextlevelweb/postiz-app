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
import { CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import {
  contentStudioPostgresUrlFromEnv,
  createContentStudioPostgresClient,
} from '../../../../../../jest.content-studio.postgres.guard';

// Organization safety caps (P8-C1) on a real PostgreSQL: the live feed limit
// and the page source limit hold under concurrent writers (serializable
// transactions, retried), feed captures at the page limit keep existing
// pages and only count new ones, and a member refresh waits for its cooldown.
// The limits are lowered for these tests through the one resolver; nothing
// else is configured. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. Nothing is fetched: safeFetch is an in-memory web
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

// Separate from the earlier fixtures: their own organizations and users
const ORG_A = '30c10000-0000-4000-8000-00000000000a';
const ORG_B = '30c10000-0000-4000-8000-00000000000b';
const USER_A = '30c10000-0000-4000-8000-0000000000a1';
const USER_B = '30c10000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const COOLDOWN = CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS;
const FEED_LIMIT = {
  status: 409,
  msg: 'The organization has too many active feeds.',
  code: 'CS_SOURCE_FEED_LIMIT',
};
const SOURCE_LIMIT = {
  status: 409,
  msg: 'The organization has too many sources.',
  code: 'CS_SOURCE_LIMIT',
};
const TOO_SOON = {
  status: 429,
  msg: 'This source was captured a moment ago. Try again in a few minutes.',
  code: 'CS_SOURCE_REFRESH_TOO_SOON',
};

let client: PrismaClient;
let logged: PrismaClient;
let queries: string[];
let ingestion: ContentStudioSourceIngestionService;
let service: ContentStudioSourceService;
let loggedIngestion: ContentStudioSourceIngestionService;
// serializable attempts made and lost, through the repository
let attempts: { made: number; lost: number };
// when set, a limited create waits after its count until this many have
// counted: concurrent transactions then always overlap
let countBarrier: { size: number; waiting: Array<() => void> } | null;

const feedUrl = (name: string) => `https://p8c1.example/${name}.xml`;
const page = (name: string) => `https://p8c1.example/page-${name}`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8C1 page</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8C1</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;

// fixture rows, written directly: never through the limited create
const fixtureSource = async (
  organizationId: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) => {
  const id = randomUUID();
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8C1 page',
      canonicalUrl: page(id),
      createdById: OWNER[organizationId],
      ...over,
    },
  });
  return id;
};
const fixtureFeed = (
  organizationId: string,
  name: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) =>
  fixtureSource(organizationId, {
    kind: 'feed',
    name: `P8C1 ${name}`,
    canonicalUrl: feedUrl(name),
    ...over,
  });
const create = (organizationId: string, kind: string, url: string) =>
  service.createSource({
    organizationId,
    userId: OWNER[organizationId],
    kind,
    name: 'P8C1 source',
    url,
  });
const refresh = (organizationId: string, sourceId: string) =>
  ingestion.refreshSource({
    organizationId,
    userId: OWNER[organizationId],
    sourceId,
  }) as Promise<Record<string, any>>;
const activeFeeds = (organizationId: string) =>
  client.contentStudioSource.count({
    where: { organizationId, kind: 'feed', archivedAt: null },
  });
const pages = (organizationId: string) =>
  client.contentStudioSource.count({ where: { organizationId, kind: 'url' } });
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
    /P20\d\d|[Cc]onstraint|[Pp]risma|[Ss]erializ|\bSELECT\b|"ContentStudio|p8c1\.example|\d{2,}/
  );
  return { status: (err as HttpException).getStatus(), ...body };
};
const settled = async (calls: Promise<unknown>[]) => {
  const results = await Promise.allSettled(calls);
  return {
    created: results.filter((r) => r.status === 'fulfilled').length,
    refused: await Promise.all(
      results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => refusal(Promise.reject(r.reason)))
    ),
  };
};

// B1 (P8-04B1) and the version history, for every page of the fixtures: the
// four fields all set or all empty, a page change between version 2 and the
// latest, the version it names there with its time, a previous capture
// before it, no feed with one, and versions 1..latest without a gap
const invariants = async () => {
  const sources = await client.contentStudioSource.findMany({
    where: { organizationId: { in: ORGS } },
    include: { versions: { select: { versionNumber: true, fetchedAt: true } } },
  });
  const broken: string[] = [];
  for (const s of sources) {
    const fields = [
      s.lastPageChangeAt,
      s.lastPageChangeVersionNumber,
      s.lastPageChangeKind,
      s.lastPageChangePreviousCaptureAt,
    ];
    const set = fields.filter((f) => f !== null).length;
    const numbers = s.versions
      .map((v) => v.versionNumber)
      .sort((a, b) => a - b);
    if (set !== 0 && set !== 4) broken.push(`I1 ${s.id}`);
    if (s.kind === 'feed' && (set || numbers.length)) broken.push(`I4 ${s.id}`);
    if (numbers.join() !== numbers.map((_, i) => i + 1).join()) {
      broken.push(`gap ${s.id}`);
    }
    if (numbers.length !== s.latestVersionNumber) broken.push(`latest ${s.id}`);
    if (set === 4) {
      if (!['content_changed', 'title_changed'].includes(s.lastPageChangeKind!))
        broken.push(`I2 ${s.id}`);
      const n = s.lastPageChangeVersionNumber!;
      if (n < 2 || n > s.latestVersionNumber) broken.push(`I3 ${s.id}`);
      const at = s.versions.find((v) => v.versionNumber === n);
      if (!at || at.fetchedAt.getTime() !== s.lastPageChangeAt!.getTime())
        broken.push(`I5 ${s.id}`);
      if (s.lastPageChangePreviousCaptureAt! > s.lastPageChangeAt!)
        broken.push(`I7 ${s.id}`);
    }
  }
  const discoveries = await client.contentStudioSourceDiscovery.findMany({
    where: { organizationId: { in: ORGS } },
    select: { feedSourceId: true, discoveredSourceId: true },
  });
  const ids = new Set(sources.map((s) => s.id));
  for (const d of discoveries) {
    if (!ids.has(d.feedSourceId) || !ids.has(d.discoveredSourceId)) {
      broken.push('discovery');
    }
  }
  return broken;
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
  // the real transaction, counted
  const transaction = new PrismaTransaction(prisma);
  const run = transaction.model.$transaction.bind(transaction.model);
  transaction.model = {
    $transaction: (async (...args: unknown[]) => {
      const serializable = !!(args[1] as { isolationLevel?: string })
        ?.isolationLevel;
      attempts.made += serializable ? 1 : 0;
      const [work, options] = args as [
        (tx: Prisma.TransactionClient) => Promise<unknown>,
        unknown
      ];
      const gated = async (tx: Prisma.TransactionClient) =>
        work(
          new Proxy(tx, {
            get: (target, key) =>
              key === 'contentStudioSource'
                ? new Proxy(target.contentStudioSource, {
                    get: (delegate, name) =>
                      name === 'count'
                        ? async (
                            query: Prisma.ContentStudioSourceCountArgs
                          ) => {
                            const n = await delegate.count(query);
                            const barrier = countBarrier;
                            if (barrier) {
                              await new Promise<void>((resolve) => {
                                barrier.waiting.push(resolve);
                                if (barrier.waiting.length >= barrier.size) {
                                  countBarrier = null;
                                  barrier.waiting.forEach((go) => go());
                                }
                              });
                            }
                            return n;
                          }
                        : Reflect.get(delegate, name),
                  })
                : Reflect.get(target, key),
          })
        );
      try {
        return await (run as (...a: unknown[]) => Promise<unknown>)(
          serializable ? gated : work,
          options
        );
      } catch (err) {
        if (
          serializable &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2034'
        ) {
          attempts.lost += 1;
        }
        throw err;
      }
    }) as PrismaService['$transaction'],
  };
  const sources = new ContentStudioSourceRepository(
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
  loggedIngestion = services(logged as unknown as PrismaService).ingestion;
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P8C1 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p8c1.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8C1 ${user}`,
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
  Object.assign(mockLimits, {
    activeFeedsMax: 1000,
    urlSourcesMax: 1000,
    manualRefreshCooldownMs: 0,
  });
  attempts = { made: 0, lost: 0 };
  countBarrier = null;
  queries = [];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  expect(await invariants()).toEqual([]);
});

afterAll(async () => {
  await logged?.$disconnect();
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('P8-C1 on PostgreSQL: the live feed limit under concurrent writers', () => {
  it('P8C1PG1/P8C1PG8 at one place left, concurrent feed creates make exactly one; the others are the limit, retried from a fresh count', async () => {
    mockLimits.activeFeedsMax = 4;
    await fixtureFeed(ORG_A, 'live-1');
    await fixtureFeed(ORG_A, 'live-2');
    await fixtureFeed(ORG_A, 'live-3');
    // archived feeds hold no place
    await fixtureFeed(ORG_A, 'archived', { archivedAt: new Date() });
    const result = await settled(
      Array.from({ length: 8 }, (_, i) =>
        create(ORG_A, 'feed', feedUrl(`new-${i}`))
      )
    );
    expect(result.created).toBe(1);
    expect(result.refused).toEqual(Array(7).fill(FEED_LIMIT));
    expect(await activeFeeds(ORG_A)).toBe(4);
    // every attempt PostgreSQL aborted ran again
    expect(attempts.made).toBe(8 + attempts.lost);
  });

  it('P8C1PG8 two creates that both counted before either wrote: PostgreSQL aborts one, which runs again from a fresh count and finds the limit', async () => {
    mockLimits.activeFeedsMax = 2;
    await fixtureFeed(ORG_A, 'live-1');
    countBarrier = { size: 2, waiting: [] };
    const result = await settled([
      create(ORG_A, 'feed', feedUrl('new-1')),
      create(ORG_A, 'feed', feedUrl('new-2')),
    ]);
    expect(result.created).toBe(1);
    expect(result.refused).toEqual([FEED_LIMIT]);
    expect(attempts).toEqual({ made: 3, lost: 1 });
    expect(await activeFeeds(ORG_A)).toBe(2);
  });

  it('P8C1PG8 with room for both, the aborted one is created on its next attempt', async () => {
    mockLimits.urlSourcesMax = 10;
    countBarrier = { size: 2, waiting: [] };
    const result = await settled([
      create(ORG_A, 'url', page('new-1')),
      create(ORG_A, 'url', page('new-2')),
    ]);
    expect(result.created).toBe(2);
    expect(attempts).toEqual({ made: 3, lost: 1 });
    expect(await pages(ORG_A)).toBe(2);
  });

  it('P8C1PG2 at one place left, concurrent restores restore exactly one; the others stay archived', async () => {
    mockLimits.activeFeedsMax = 3;
    await fixtureFeed(ORG_A, 'live-1');
    await fixtureFeed(ORG_A, 'live-2');
    const archived = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        fixtureFeed(ORG_A, `archived-${n}`, { archivedAt: new Date() })
      )
    );
    const result = await settled(
      archived.map((id) => service.restoreSource(ORG_A, id))
    );
    expect(result.created).toBe(1);
    expect(result.refused).toEqual(Array(4).fill(FEED_LIMIT));
    expect(await activeFeeds(ORG_A)).toBe(3);
    expect(
      await client.contentStudioSource.count({
        where: { id: { in: archived }, archivedAt: { not: null } },
      })
    ).toBe(4);
  });

  it('FC3/FC4/FC5 archiving frees a place, restoring takes it; a restore at the limit leaves the feed archived', async () => {
    mockLimits.activeFeedsMax = 1;
    const first = (await create(ORG_A, 'feed', feedUrl('one'))).id;
    expect(await refusal(create(ORG_A, 'feed', feedUrl('two')))).toEqual(
      FEED_LIMIT
    );
    await service.archiveSource(ORG_A, first);
    const second = (await create(ORG_A, 'feed', feedUrl('two'))).id;
    expect(await refusal(service.restoreSource(ORG_A, first))).toEqual(
      FEED_LIMIT
    );
    expect(
      (
        await client.contentStudioSource.findUniqueOrThrow({
          where: { id: first },
        })
      ).archivedAt
    ).not.toBeNull();
    // restoring a live feed takes no second place
    await expect(service.restoreSource(ORG_A, second)).resolves.toMatchObject({
      id: second,
      archivedAt: null,
    });
    await service.archiveSource(ORG_A, second);
    await expect(service.restoreSource(ORG_A, first)).resolves.toMatchObject({
      archivedAt: null,
    });
    // a duplicate address is CS_SOURCE_ALREADY_EXISTS, also at the limit
    expect(await refusal(create(ORG_A, 'feed', feedUrl('two')))).toMatchObject({
      status: 409,
      code: 'CS_SOURCE_ALREADY_EXISTS',
    });
  });
});

describe('P8-C1 on PostgreSQL: the page source limit', () => {
  it('P8C1PG3 at one place left, concurrent page creates make exactly one; archived pages hold their place', async () => {
    mockLimits.urlSourcesMax = 4;
    await fixtureSource(ORG_A);
    await fixtureSource(ORG_A);
    await fixtureSource(ORG_A, { archivedAt: new Date() });
    const result = await settled(
      Array.from({ length: 8 }, (_, i) =>
        create(ORG_A, 'url', page(`new-${i}`))
      )
    );
    expect(result.created).toBe(1);
    expect(result.refused).toEqual(Array(7).fill(SOURCE_LIMIT));
    expect(await pages(ORG_A)).toBe(4);
    // a restored page adds none: no limit to restore it
    const archived = await client.contentStudioSource.findFirstOrThrow({
      where: { organizationId: ORG_A, archivedAt: { not: null } },
    });
    await expect(
      service.restoreSource(ORG_A, archived.id)
    ).resolves.toMatchObject({ archivedAt: null });
  });

  it('P8C1PG4 two feeds finding the same new page at once make one source, counted once, with a discovery each', async () => {
    await fixtureSource(ORG_A);
    // room for exactly one more page
    mockLimits.urlSourcesMax = 2;
    const a = await fixtureFeed(ORG_A, 'a');
    const b = await fixtureFeed(ORG_A, 'b');
    web.feeds.set(feedUrl('a'), rss([page('shared')]));
    web.feeds.set(feedUrl('b'), rss([page('shared')]));
    web.pages.set(page('shared'), html('Shared'));
    const [ra, rb] = await Promise.all([refresh(ORG_A, a), refresh(ORG_A, b)]);
    expect(ra.capture.entriesLimited + rb.capture.entriesLimited).toBe(0);
    expect(ra.capture.sourcesCreated + rb.capture.sourcesCreated).toBe(1);
    expect(await pages(ORG_A)).toBe(2);
    const shared = await client.contentStudioSource.findFirstOrThrow({
      where: { organizationId: ORG_A, canonicalUrl: page('shared') },
    });
    expect(
      (
        await client.contentStudioSourceDiscovery.findMany({
          where: { discoveredSourceId: shared.id },
          select: { feedSourceId: true },
        })
      )
        .map((d) => d.feedSourceId)
        .sort()
    ).toEqual([a, b].sort());
  });

  it('P8C1PG5/P8C1PG6 at the limit a feed records and captures an existing page, counts the new ones, and is marked captured', async () => {
    const existing = await fixtureSource(ORG_A, {
      canonicalUrl: page('known'),
    });
    mockLimits.urlSourcesMax = 1;
    const feed = await fixtureFeed(ORG_A, 'news');
    web.feeds.set(
      feedUrl('news'),
      rss([page('new-1'), page('known'), page('new-2')])
    );
    for (const name of ['new-1', 'known', 'new-2']) {
      web.pages.set(page(name), html(name));
    }
    const result = await refresh(ORG_A, feed);
    expect(result.capture).toEqual({
      entriesSeen: 3,
      entriesIgnored: 0,
      entriesSkipped: 0,
      entriesAccepted: 1,
      sourcesCreated: 0,
      versionsCreated: 1,
      unchanged: 0,
      failed: 0,
      archived: 0,
      entriesLimited: 2,
    });
    expect(
      await client.contentStudioSource.findMany({
        where: { organizationId: ORG_A, kind: 'url' },
        select: { id: true, latestVersionNumber: true },
      })
    ).toEqual([{ id: existing, latestVersionNumber: 1 }]);
    expect(
      await client.contentStudioSourceDiscovery.findMany({
        where: { organizationId: ORG_A },
        select: { feedSourceId: true, discoveredSourceId: true },
      })
    ).toEqual([{ feedSourceId: feed, discoveredSourceId: existing }]);
    expect(mockSafeFetch.mock.calls.map(([url]) => url).sort()).toEqual(
      [feedUrl('news'), page('known')].sort()
    );
    expect(
      (
        await client.contentStudioSource.findUniqueOrThrow({
          where: { id: feed },
        })
      ).lastCapturedAt
    ).toBeInstanceOf(Date);
  });

  it('P8C1PG7 one organization at its limits leaves another one free', async () => {
    mockLimits.activeFeedsMax = 1;
    mockLimits.urlSourcesMax = 1;
    await fixtureFeed(ORG_A, 'a');
    await fixtureSource(ORG_A);
    expect(await refusal(create(ORG_A, 'feed', feedUrl('a2')))).toEqual(
      FEED_LIMIT
    );
    expect(await refusal(create(ORG_A, 'url', page('a2')))).toEqual(
      SOURCE_LIMIT
    );
    // the same addresses in the other organization
    await expect(create(ORG_B, 'feed', feedUrl('a2'))).resolves.toMatchObject({
      kind: 'feed',
    });
    const feedB = (
      await client.contentStudioSource.findFirstOrThrow({
        where: { organizationId: ORG_B, kind: 'feed' },
      })
    ).id;
    web.feeds.set(feedUrl('a2'), rss([page('a2')]));
    web.pages.set(page('a2'), html('B'));
    expect((await refresh(ORG_B, feedB)).capture).toMatchObject({
      sourcesCreated: 1,
      entriesLimited: 0,
    });
    expect(await pages(ORG_A)).toBe(1);
    expect(await pages(ORG_B)).toBe(1);
  });
});

describe('P8-C1 on PostgreSQL: a 25-entry feed', () => {
  const links = Array.from({ length: 25 }, (_, i) => page(`entry-${i}`));
  const feedWith25 = async () => {
    const feed = await fixtureFeed(ORG_A, 'big');
    web.feeds.set(feedUrl('big'), rss(links));
    for (const link of links) {
      web.pages.set(link, html(link));
    }
    return feed;
  };
  const capture = (feed: string) =>
    loggedIngestion.refreshSource({
      organizationId: ORG_A,
      userId: USER_A,
      sourceId: feed,
    }) as Promise<Record<string, any>>;

  it('P8C1PG-M1 at the ceiling: no page fetched, no source or discovery, 25 limited, in a bounded number of statements', async () => {
    await fixtureSource(ORG_A);
    mockLimits.urlSourcesMax = 1;
    const feed = await feedWith25();
    queries = [];
    const result = await capture(feed);
    expect(result.capture).toMatchObject({
      entriesAccepted: 0,
      sourcesCreated: 0,
      failed: 0,
      entriesLimited: 25,
    });
    expect(mockSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      feedUrl('big'),
    ]);
    expect(await pages(ORG_A)).toBe(1);
    expect(
      await client.contentStudioSourceDiscovery.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(0);
    // a lookup per entry, then one transaction for the new pages (begin,
    // isolation, their URLs, the count, commit); and the feed's read, its
    // update (in a transaction of its own) and its read again. P8-O1 adds
    // three per capture, none per entry: the capture's record, and in the
    // update's transaction the feed's schedule and the record's end
    expect(queries.filter((q) => /^BEGIN/.test(q))).toHaveLength(2);
    expect(queries.filter((q) => /SERIALIZABLE/.test(q))).toHaveLength(1);
    expect(queries.filter((q) => /COUNT\(/i.test(q))).toHaveLength(1);
    expect(queries.filter((q) => /^INSERT/.test(q))).toEqual([
      expect.stringMatching(
        /^INSERT INTO "public"\."ContentStudioSourceCaptureAttempt"/
      ),
    ]);
    expect(queries.length).toBe(25 + 5 + 5 + 3);
  });

  it('P8C1PG-M2 with room: 25 sources and discoveries, each create one serializable transaction, all within their attempts', async () => {
    const feed = await feedWith25();
    queries = [];
    const result = await capture(feed);
    expect(result.capture).toMatchObject({
      entriesAccepted: 25,
      sourcesCreated: 25,
      versionsCreated: 25,
      failed: 0,
      entriesLimited: 0,
    });
    expect(await pages(ORG_A)).toBe(25);
    expect(
      await client.contentStudioSourceDiscovery.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(25);
    // one transaction creates the feed's new pages
    expect(attempts).toEqual({ made: 1, lost: 0 });
    expect(queries.filter((q) => /SERIALIZABLE/.test(q))).toHaveLength(1);
    expect(queries.filter((q) => /COUNT\(/i.test(q))).toHaveLength(1);
    // the limited create of the 25 is one transaction: begin, isolation,
    // their URLs, the count, the 25 inserts, commit. The plain create of
    // before (P8-04B2) was the insert alone, measured the same way below: the
    // limit adds five statements per feed capture with new pages, none per
    // page (280 before, 285 now). P8-O1 adds three per capture, one of them
    // an insert, none per page (288)
    expect(queries.filter((q) => /^INSERT/.test(q))).toHaveLength(25 * 3 + 1);
    expect(queries.length).toBe(288);
    queries = [];
    await logged.contentStudioSource.create({
      data: {
        id: randomUUID(),
        organizationId: ORG_A,
        kind: 'url',
        name: 'P8C1 before',
        canonicalUrl: page('before'),
        latestVersionNumber: 0,
        createdById: USER_A,
      },
      select: { id: true, kind: true, name: true, canonicalUrl: true },
    });
    expect(queries).toEqual([expect.stringMatching(/^INSERT/)]);
  });

  it('P8C1PG-M3 three feeds of one organization creating 25 new pages each at once: every page within the limit, losses retried', async () => {
    mockLimits.urlSourcesMax = 60;
    const feeds = await Promise.all(
      ['x', 'y', 'z'].map(async (name) => {
        const feed = await fixtureFeed(ORG_A, name);
        const own = links.map((link) => `${link}-${name}`);
        web.feeds.set(feedUrl(name), rss(own));
        for (const link of own) {
          web.pages.set(link, html(link));
        }
        return feed;
      })
    );
    const results = await Promise.all(
      feeds.map((feed) => refresh(ORG_A, feed))
    );
    const sum = (key: string) =>
      results.reduce((n, r) => n + r.capture[key], 0);
    // never past the limit
    expect(await pages(ORG_A)).toBe(sum('sourcesCreated'));
    expect(sum('sourcesCreated')).toBeLessThanOrEqual(60);
    expect(sum('sourcesCreated') + sum('entriesLimited') + sum('failed')).toBe(
      75
    );
    // the first 60 in all, each feed's new pages in one transaction: three
    // at once abort each other at most twice, within the attempts
    expect(sum('sourcesCreated')).toBe(60);
    expect(sum('entriesLimited')).toBe(15);
    expect(sum('failed')).toBe(0);
    expect(attempts.made).toBe(3 + attempts.lost);
    expect(attempts.lost).toBeLessThanOrEqual(3);
  });
});

describe('P8-C1 on PostgreSQL: the member refresh cooldown', () => {
  beforeEach(() => {
    mockLimits.manualRefreshCooldownMs = COOLDOWN;
  });
  const setFetchedAt = (sourceId: string, fetchedAt: Date) =>
    client.contentStudioSourceVersion.updateMany({
      where: { sourceId },
      data: { fetchedAt },
    });

  it('P8C1PG9 a page refreshed again within the cooldown is refused before the fetch and the append', async () => {
    const id = await fixtureSource(ORG_A, { canonicalUrl: page('p') });
    web.pages.set(page('p'), html('One'));
    // never captured: at once
    await expect(refresh(ORG_A, id)).resolves.toMatchObject({
      version: { versionNumber: 1 },
    });
    mockSafeFetch.mockClear();
    expect(await refusal(refresh(ORG_A, id))).toEqual(TOO_SOON);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(
      await client.contentStudioSourceVersion.count({ where: { sourceId: id } })
    ).toBe(1);
  });

  it('P8C1PG10 the cooldown after the current version, or more, is late enough; a moment less is not', async () => {
    const id = await fixtureSource(ORG_A, { canonicalUrl: page('p') });
    web.pages.set(page('p'), html('One'));
    await refresh(ORG_A, id);
    await setFetchedAt(id, new Date(Date.now() - COOLDOWN + 60_000));
    expect(await refusal(refresh(ORG_A, id))).toEqual(TOO_SOON);
    await setFetchedAt(id, new Date(Date.now() - COOLDOWN));
    await expect(refresh(ORG_A, id)).resolves.toMatchObject({
      version: { versionNumber: 2 },
    });
  });

  it('P8C1PG11 a feed read within the cooldown is refused before its fetch; after it, read', async () => {
    const feed = await fixtureFeed(ORG_A, 'news');
    web.feeds.set(feedUrl('news'), rss([page('one')]));
    web.pages.set(page('one'), html('One'));
    await refresh(ORG_A, feed);
    mockSafeFetch.mockClear();
    expect(await refusal(refresh(ORG_A, feed))).toEqual(TOO_SOON);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    await client.contentStudioSource.update({
      where: { id: feed },
      data: { lastCapturedAt: new Date(Date.now() - COOLDOWN) },
    });
    await expect(refresh(ORG_A, feed)).resolves.toMatchObject({
      capture: { entriesSeen: 1 },
    });
  });

  it('P8C1PG12 the schedule never waits for it, and still stores only what changed', async () => {
    const feed = await fixtureFeed(ORG_A, 'news');
    web.feeds.set(feedUrl('news'), rss([page('one')]));
    web.pages.set(page('one'), html('One'));
    await refresh(ORG_A, feed);
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_A,
        sourceId: feed,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).toMatchObject({
      status: 'captured',
      capture: { unchanged: 1, versionsCreated: 0 },
    });
    web.pages.set(page('one'), html('One, changed'));
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_A,
        sourceId: feed,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).toMatchObject({ capture: { versionsCreated: 1 } });
    // and a page a feed captured a moment ago waits for a member refresh
    const one = await client.contentStudioSource.findFirstOrThrow({
      where: { organizationId: ORG_A, canonicalUrl: page('one') },
    });
    expect(await refusal(refresh(ORG_A, one.id))).toEqual(TOO_SOON);
  });

  it('two due refreshes at once still store one capture: the compare-and-swap decides', async () => {
    const id = await fixtureSource(ORG_A, { canonicalUrl: page('p') });
    web.pages.set(page('p'), html('One'));
    const results = await Promise.allSettled([
      refresh(ORG_A, id),
      refresh(ORG_A, id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await client.contentStudioSourceVersion.count({ where: { sourceId: id } })
    ).toBe(1);
  });
});

describe('P8-C1 on PostgreSQL: what stays', () => {
  it('the page-change backfill finds every capture made under the limits as it is', async () => {
    mockLimits.urlSourcesMax = 3;
    const feed = await fixtureFeed(ORG_A, 'news');
    web.feeds.set(feedUrl('news'), rss([1, 2, 3, 4].map((n) => page(`${n}`))));
    for (const n of [1, 2, 3, 4]) {
      web.pages.set(page(`${n}`), html(`v1 ${n}`));
    }
    await refresh(ORG_A, feed);
    for (const n of [1, 2, 3, 4]) {
      web.pages.set(page(`${n}`), html(`v2 ${n}`));
    }
    await ingestion.captureScheduledFeed({
      organizationId: ORG_A,
      sourceId: feed,
      attemptId: randomUUID(),
      attemptCount: 1,
    });
    const ids = new Set(
      (
        await client.contentStudioSource.findMany({
          where: { organizationId: ORG_A, kind: 'url' },
          select: { id: true },
        })
      ).map((s) => s.id)
    );
    expect(ids.size).toBe(3);
    let afterId: string | null = null;
    let updated = 0;
    const failed: string[] = [];
    do {
      const result = await service.backfillPageChanges({ afterId });
      afterId = result.next;
      updated += result.updated;
      failed.push(...result.failed.filter((id) => ids.has(id)));
    } while (afterId);
    expect({ updated, failed }).toEqual({ updated: 0, failed: [] });
  });
});
