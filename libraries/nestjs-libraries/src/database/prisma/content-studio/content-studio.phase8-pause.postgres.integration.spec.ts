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
import { CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Feed pause (P8-C3) on a real PostgreSQL: pause and resume write the pause
// time only, once; archive and restore keep it; the scan leaves a paused feed
// out and a scheduled capture skips it; a member may still refresh it; it
// counts against the live feed limit (P8-C1) and stays in News Radar.
// Opt-in: runs only through jest.content-studio.integration.config.ts
// against the disposable local database. Nothing is fetched: safeFetch is an
// in-memory web
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
const ORG_A = '30c30000-0000-4000-8000-00000000000a';
const ORG_B = '30c30000-0000-4000-8000-00000000000b';
const USER_A = '30c30000-0000-4000-8000-0000000000a1';
const USER_B = '30c30000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const ARCHIVED = {
  status: 409,
  msg: 'This source is archived.',
  code: 'CS_SOURCE_ARCHIVED',
};
const NOT_FOUND = {
  status: 404,
  msg: 'Source not found.',
  code: 'CS_NOT_FOUND',
};
const KIND = {
  status: 400,
  msg: 'This source type has no scheduled captures.',
  code: 'CS_SOURCE_KIND_UNSUPPORTED',
};
const FEED_LIMIT = {
  status: 409,
  msg: 'The organization has too many active feeds.',
  code: 'CS_SOURCE_FEED_LIMIT',
};
const TOO_SOON = {
  status: 429,
  msg: 'This source was captured a moment ago. Try again in a few minutes.',
  code: 'CS_SOURCE_REFRESH_TOO_SOON',
};

let client: PrismaClient;
let ingestion: ContentStudioSourceIngestionService;
let service: ContentStudioSourceService;

const feedUrl = (name: string) => `https://p8c3.example/${name}.xml`;
const page = (name: string) => `https://p8c3.example/page-${name}`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8C3 page</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8C3</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;
// an hour ago: a time that has passed
const old = () => new Date(Date.now() - 60 * 60 * 1000);

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
      name: `P8C3 ${name}`,
      canonicalUrl: feedUrl(name),
      createdById: OWNER[organizationId],
      ...over,
    },
  });
  return id;
};
const fixturePage = (organizationId: string, name: string) =>
  fixtureFeed(organizationId, name, {
    kind: 'url',
    canonicalUrl: page(name),
  });
const row = (id: string) =>
  client.contentStudioSource.findUniqueOrThrow({ where: { id } });
// everything of the organizations but the feed's pause time and updatedAt
const history = async () =>
  JSON.stringify({
    sources: (
      await client.contentStudioSource.findMany({
        where: { organizationId: { in: ORGS } },
        orderBy: { id: 'asc' },
      })
    ).map(({ scanPausedAt: _p, updatedAt: _u, ...rest }) => rest),
    versions: await client.contentStudioSourceVersion.findMany({
      where: { organizationId: { in: ORGS } },
      orderBy: { id: 'asc' },
    }),
    discoveries: await client.contentStudioSourceDiscovery.findMany({
      where: { organizationId: { in: ORGS } },
      orderBy: { id: 'asc' },
    }),
  });
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
const refresh = (organizationId: string, sourceId: string) =>
  ingestion.refreshSource({
    organizationId,
    userId: OWNER[organizationId],
    sourceId,
  }) as Promise<Record<string, any>>;
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
    /P20\d\d|[Cc]onstraint|[Pp]risma|[Ss]erializ|\bSELECT\b|"ContentStudio|p8c3\.example/
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
  const prisma = client as unknown as PrismaService;
  const sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaTransaction(prisma)
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  ingestion = new ContentStudioSourceIngestionService(sources, discoveries);
  service = new ContentStudioSourceService(sources, discoveries);
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P8C3 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p8c3.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8C3 ${user}`,
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

describe('P8-C3 on PostgreSQL: pause and resume', () => {
  it('P8C3PG1/P8C3PG2 pause sets the time once: again, it stays; nothing else of the feed, its pages or history changes', async () => {
    const feed = await fixtureFeed(ORG_A, 'basic', { lastCapturedAt: old() });
    const pageId = await fixturePage(ORG_A, 'basic');
    await client.contentStudioSourceDiscovery.create({
      data: {
        organizationId: ORG_A,
        feedSourceId: feed,
        discoveredSourceId: pageId,
        entryTitle: 'Story',
        firstSeenAt: old(),
        lastSeenAt: old(),
      },
    });
    const before = await history();
    const answer = await service.pauseFeed(ORG_A, feed);
    const pausedAt = (await row(feed)).scanPausedAt;
    expect(pausedAt).toBeInstanceOf(Date);
    expect(answer.scanPausedAt).toEqual(pausedAt);
    expect(answer.archivedAt).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await service.pauseFeed(ORG_A, feed);
    expect(again.scanPausedAt).toEqual(pausedAt);
    expect((await row(feed)).scanPausedAt).toEqual(pausedAt);
    expect(await history()).toBe(before);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('P8C3PG3/P8C3PG4 resume clears it; again, it stays clear; the history is as it was', async () => {
    const feed = await fixtureFeed(ORG_A, 'resume', {
      scanPausedAt: old(),
      lastCapturedAt: old(),
    });
    const before = await history();
    expect((await service.resumeFeed(ORG_A, feed)).scanPausedAt).toBeNull();
    expect((await row(feed)).scanPausedAt).toBeNull();
    const updatedAt = (await row(feed)).updatedAt;
    expect((await service.resumeFeed(ORG_A, feed)).scanPausedAt).toBeNull();
    // an idempotent resume writes nothing
    expect((await row(feed)).updatedAt).toEqual(updatedAt);
    expect(await history()).toBe(before);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('EP1/EP3 another organization reads the feed as missing; a page has no schedule; neither writes', async () => {
    const feed = await fixtureFeed(ORG_A, 'tenancy');
    const pageId = await fixturePage(ORG_A, 'tenancy');
    for (const action of ['pauseFeed', 'resumeFeed'] as const) {
      expect(await refusal(service[action](ORG_B, feed))).toEqual(NOT_FOUND);
      expect(await refusal(service[action](ORG_A, pageId))).toEqual(KIND);
    }
    expect((await row(feed)).scanPausedAt).toBeNull();
    expect((await row(pageId)).scanPausedAt).toBeNull();
  });

  it('pause and resume at the same time: one pause time, and the last one wins; never another field', async () => {
    const feed = await fixtureFeed(ORG_A, 'concurrent', {
      lastCapturedAt: old(),
    });
    const before = await history();
    const paused = await Promise.all(
      Array.from({ length: 8 }, () => service.pauseFeed(ORG_A, feed))
    );
    const pausedAt = (await row(feed)).scanPausedAt;
    expect(pausedAt).toBeInstanceOf(Date);
    for (const answer of paused) {
      expect(answer.scanPausedAt).toEqual(pausedAt);
    }
    await Promise.all(
      Array.from({ length: 8 }, () => service.resumeFeed(ORG_A, feed))
    );
    expect((await row(feed)).scanPausedAt).toBeNull();
    // pause racing resume: whichever commits last, a valid state
    await Promise.allSettled([
      service.pauseFeed(ORG_A, feed),
      service.resumeFeed(ORG_A, feed),
      service.pauseFeed(ORG_A, feed),
      service.resumeFeed(ORG_A, feed),
    ]);
    const after = await row(feed);
    expect(
      after.scanPausedAt === null || after.scanPausedAt instanceof Date
    ).toBe(true);
    expect(after.archivedAt).toBeNull();
    expect(await history()).toBe(before);
  });
});

describe('P8-C3 on PostgreSQL: archive and restore', () => {
  it('P8C3PG5/M6 a paused feed archived and restored comes back paused, with its first pause time', async () => {
    const feed = await fixtureFeed(ORG_A, 'archive', { lastCapturedAt: old() });
    await service.pauseFeed(ORG_A, feed);
    const pausedAt = (await row(feed)).scanPausedAt;
    const archived = await service.archiveSource(ORG_A, feed);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived.scanPausedAt).toEqual(pausedAt);
    expect(await due()).toEqual([]);
    const restored = await service.restoreSource(ORG_A, feed);
    expect(restored.archivedAt).toBeNull();
    expect(restored.scanPausedAt).toEqual(pausedAt);
    // restored paused: still not scheduled
    expect(await due()).toEqual([]);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('P8C3PG6/EP2/M5 an archived feed, paused or not, cannot be paused or resumed: archived, unchanged', async () => {
    const running = await fixtureFeed(ORG_A, 'arch-running', {
      archivedAt: new Date(),
    });
    const paused = await fixtureFeed(ORG_A, 'arch-paused', {
      archivedAt: new Date(),
      scanPausedAt: old(),
    });
    const before = JSON.stringify([await row(running), await row(paused)]);
    for (const id of [running, paused]) {
      for (const action of ['pauseFeed', 'resumeFeed'] as const) {
        expect(await refusal(service[action](ORG_A, id))).toEqual(ARCHIVED);
      }
    }
    expect(JSON.stringify([await row(running), await row(paused)])).toBe(
      before
    );
  });

  it('pause racing archive: archive goes first or the pause is kept with it; the scan never lists the feed', async () => {
    for (let i = 0; i < 5; i++) {
      const feed = await fixtureFeed(ORG_A, `race-${i}`, {
        lastCapturedAt: old(),
      });
      await Promise.allSettled([
        service.pauseFeed(ORG_A, feed),
        service.archiveSource(ORG_A, feed),
      ]);
      const after = await row(feed);
      expect(after.archivedAt).toBeInstanceOf(Date);
      expect(
        after.scanPausedAt === null || after.scanPausedAt instanceof Date
      ).toBe(true);
    }
    expect(await due()).toEqual([]);
  });
});

describe('P8-C3 on PostgreSQL: the live feed limit (P8-C1)', () => {
  it('AC1/M7 a paused feed holds its place: a new feed at the limit is refused', async () => {
    mockLimits.activeFeedsMax = 2;
    await fixtureFeed(ORG_A, 'cap-live');
    await fixtureFeed(ORG_A, 'cap-paused', { scanPausedAt: new Date() });
    expect(
      await refusal(
        service.createSource({
          organizationId: ORG_A,
          userId: USER_A,
          kind: 'feed',
          name: 'P8C3 third',
          url: feedUrl('cap-third'),
        })
      )
    ).toEqual(FEED_LIMIT);
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A, kind: 'feed' },
      })
    ).toBe(2);
  });

  it('AC2/M8 archiving the paused feed frees its place', async () => {
    mockLimits.activeFeedsMax = 2;
    await fixtureFeed(ORG_A, 'free-live');
    const paused = await fixtureFeed(ORG_A, 'free-paused', {
      scanPausedAt: new Date(),
    });
    await service.archiveSource(ORG_A, paused);
    await expect(
      service.createSource({
        organizationId: ORG_A,
        userId: USER_A,
        kind: 'feed',
        name: 'P8C3 new',
        url: feedUrl('free-new'),
      })
    ).resolves.toMatchObject({ kind: 'feed', scanPausedAt: null });
  });

  it('AC3/AC4 restoring paused archived feeds takes the serializable limit: one place, one restored and paused; the other stays archived and paused', async () => {
    mockLimits.activeFeedsMax = 2;
    await fixtureFeed(ORG_A, 'restore-live');
    const pausedAt = old();
    const archivedAt = new Date();
    const feeds = await Promise.all(
      [1, 2, 3].map((n) =>
        fixtureFeed(ORG_A, `restore-${n}`, {
          archivedAt,
          scanPausedAt: pausedAt,
        })
      )
    );
    const results = await Promise.allSettled(
      feeds.map((id) => service.restoreSource(ORG_A, id))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(await refusal(Promise.reject(result.reason))).toEqual(
          expect.objectContaining({ status: 409 })
        );
      }
    }
    const rows = await Promise.all(feeds.map(row));
    expect(rows.filter((r) => r.archivedAt === null)).toHaveLength(1);
    // every one keeps its pause, restored or not
    for (const r of rows) {
      expect(r.scanPausedAt).toEqual(pausedAt);
    }
    for (const r of rows.filter((r) => r.archivedAt !== null)) {
      expect(r.archivedAt).toEqual(archivedAt);
    }
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A, kind: 'feed', archivedAt: null },
      })
    ).toBe(2);
  });
});

describe('P8-C3 on PostgreSQL: the scan and the scheduled capture', () => {
  it('P8C3PG7/P8C3PG8/P8C3PG9 the scan lists a due running feed, never a paused one, and a resumed one by its next capture time', async () => {
    const running = await fixtureFeed(ORG_A, 'due-running', {
      lastCapturedAt: old(),
    });
    const never = await fixtureFeed(ORG_B, 'due-never');
    const paused = await fixtureFeed(ORG_A, 'due-paused', {
      lastCapturedAt: old(),
      scanPausedAt: new Date(),
    });
    const pausedNever = await fixtureFeed(ORG_B, 'due-paused-never', {
      scanPausedAt: new Date(),
    });
    // P8-C4: its next capture not due yet
    const pausedRecent = await fixtureFeed(ORG_A, 'due-paused-recent', {
      lastCapturedAt: new Date(Date.now() - 60_000),
      nextCaptureAt: new Date(Date.now() + 60 * 60 * 1000),
      scanPausedAt: new Date(),
    });
    expect(await due()).toEqual([running, never].sort());
    await service.resumeFeed(ORG_A, paused);
    await service.resumeFeed(ORG_B, pausedNever);
    await service.resumeFeed(ORG_A, pausedRecent);
    // due again by its next capture time (P8-C4), kept through the pause
    expect(await due()).toEqual([running, never, paused, pausedNever].sort());
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('MR5/M10-M13 a feed paused after the scan listed it is skipped by its capture: nothing fetched or written, lastCapturedAt kept', async () => {
    const last = old();
    const feed = await fixtureFeed(ORG_A, 'queued', { lastCapturedAt: last });
    web.feeds.set(feedUrl('queued'), rss([page('queued-1')]));
    web.pages.set(page('queued-1'), html('One'));
    expect(await due()).toEqual([feed]);
    await service.pauseFeed(ORG_A, feed);
    const before = await history();
    const updatedAt = (await row(feed)).updatedAt;
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_A,
        sourceId: feed,
      })
    ).toEqual({ status: 'skipped' });
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await history()).toBe(before);
    const after = await row(feed);
    expect(after.lastCapturedAt).toEqual(last);
    expect(after.updatedAt).toEqual(updatedAt);
    expect(after.scanPausedAt).toBeInstanceOf(Date);
    // resumed: the same capture runs
    await service.resumeFeed(ORG_A, feed);
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_A,
        sourceId: feed,
      })
    ).toEqual({
      status: 'captured',
      capture: expect.objectContaining({
        sourcesCreated: 1,
        versionsCreated: 1,
      }),
    });
    expect((await row(feed)).lastCapturedAt!.getTime()).toBeGreaterThan(
      last.getTime()
    );
  });
});

describe('P8-C3 on PostgreSQL: a member refresh of a paused feed', () => {
  it('MR1/MR3/M16/M17 is a capture: pages, discoveries and versions as ever, lastCapturedAt set, and the feed stays paused', async () => {
    const pausedAt = old();
    const feed = await fixtureFeed(ORG_A, 'refresh', {
      scanPausedAt: pausedAt,
    });
    web.feeds.set(
      feedUrl('refresh'),
      rss([page('refresh-1'), page('refresh-2')])
    );
    web.pages.set(page('refresh-1'), html('One'));
    web.pages.set(page('refresh-2'), html('Two'));
    const result = await refresh(ORG_A, feed);
    expect(result.capture).toMatchObject({
      sourcesCreated: 2,
      versionsCreated: 2,
      entriesAccepted: 2,
    });
    expect(result.source.scanPausedAt).toEqual(pausedAt);
    const after = await row(feed);
    expect(after.scanPausedAt).toEqual(pausedAt);
    expect(after.lastCapturedAt).toBeInstanceOf(Date);
    expect(
      await client.contentStudioSourceDiscovery.count({
        where: { feedSourceId: feed },
      })
    ).toBe(2);
    // P8C3-7: News Radar shows what the paused feed found
    const radar = await service.listOrganizationDiscoveries({
      organizationId: ORG_A,
      page: 1,
    });
    expect(radar.total).toBe(2);
    expect(radar.results.map((r) => r.feed.id)).toEqual([feed, feed]);
    const feedRadar = await service.listOrganizationDiscoveries({
      organizationId: ORG_A,
      page: 1,
      feedSourceId: feed,
    });
    expect(feedRadar.total).toBe(2);
    expect(
      (
        await service.listDiscoveries({
          organizationId: ORG_A,
          sourceId: feed,
          page: 1,
        })
      ).results
    ).toHaveLength(2);
    // and the feed stays in the active Source list, not the archived one
    expect(
      (
        await service.listSources({
          organizationId: ORG_A,
          archived: false,
          kind: 'feed',
          page: 1,
        })
      ).results.map((s) => s.id)
    ).toEqual([feed]);
    expect(
      (
        await service.listSources({
          organizationId: ORG_A,
          archived: true,
          kind: 'feed',
          page: 1,
        })
      ).results
    ).toEqual([]);
    // the schedule still leaves it out, even once it is due
    await client.contentStudioSource.update({
      where: { id: feed },
      data: { nextCaptureAt: old() },
    });
    expect(await due()).toEqual([]);
  });

  it('MR2/M18 keeps the refresh cooldown', async () => {
    mockLimits.manualRefreshCooldownMs =
      CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS;
    const feed = await fixtureFeed(ORG_A, 'cooldown', {
      scanPausedAt: old(),
      lastCapturedAt: new Date(Date.now() - 60_000),
    });
    expect(await refusal(refresh(ORG_A, feed))).toEqual(TOO_SOON);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('MR4/M19 an archived paused feed cannot be refreshed', async () => {
    const feed = await fixtureFeed(ORG_A, 'refresh-archived', {
      scanPausedAt: old(),
      archivedAt: new Date(),
    });
    expect(await refusal(refresh(ORG_A, feed))).toEqual(ARCHIVED);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
