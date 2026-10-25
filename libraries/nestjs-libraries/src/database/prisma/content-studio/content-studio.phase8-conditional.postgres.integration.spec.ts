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
import type {
  SafeFetchOptions,
  SafeFetchResult,
} from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Conditional fetching (P8-G1) on a real PostgreSQL: a source's HTTP
// validators move only with the success they belong to (a feed's with its
// monotonic success write, a page's with its version or from the state its
// capture read), a 304 is a success with nothing read, and a member's refresh
// of a page still reads and appends. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. Nothing is fetched: safeFetch is an in-memory web that answers
// conditionally, like a server with validators would
interface Resource {
  body: string;
  contentType: string;
  etag?: string;
  lastModified?: string;
  // the validators a 304 answers with, exactly; else the resource's own
  notModified?: { etag?: string; lastModified?: string };
}
const web = {
  resources: new Map<string, Resource>(),
  failing: new Set<string>(),
  // a URL whose answer waits until it is released
  held: new Map<string, Promise<void>>(),
  requests: [] as Array<{ url: string; headers: Record<string, string> }>,
};
const mockSafeFetch = jest.fn(
  async (url: string, options?: SafeFetchOptions): Promise<SafeFetchResult> => {
    const { SafeFetchError } = jest.requireActual(
      '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'
    );
    const headers = { ...(options?.headers ?? {}) };
    web.requests.push({ url, headers });
    if (web.held.has(url)) {
      const gate = web.held.get(url)!;
      web.held.delete(url);
      await gate;
    }
    if (web.failing.has(url)) {
      throw new SafeFetchError('HTTP_STATUS', { statusCode: 503 });
    }
    const resource = web.resources.get(url);
    if (!resource) {
      throw new SafeFetchError('HTTP_STATUS', { statusCode: 404 });
    }
    const ifNoneMatch = headers['If-None-Match'];
    const ifModifiedSince = headers['If-Modified-Since'];
    const matched =
      ifNoneMatch !== undefined
        ? ifNoneMatch === resource.etag
        : ifModifiedSince !== undefined &&
          ifModifiedSince === resource.lastModified;
    if (matched) {
      return {
        requestedUrl: url,
        finalUrl: url,
        redirects: [],
        status: 304,
        headers: resource.notModified ?? {
          etag: resource.etag,
          lastModified: resource.lastModified,
        },
        body: new Uint8Array(0),
        bytesRead: 0,
      };
    }
    const bytes = new TextEncoder().encode(resource.body);
    return {
      requestedUrl: url,
      finalUrl: url,
      redirects: [],
      status: 200,
      headers: {
        contentType: resource.contentType,
        etag: resource.etag,
        lastModified: resource.lastModified,
      },
      body: bytes,
      bytesRead: bytes.byteLength,
    };
  }
);
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  ...jest.requireActual('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'),
  safeFetch: (...args: unknown[]) =>
    mockSafeFetch(...(args as [string, SafeFetchOptions])),
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
const ORG_A = '30020000-0000-4000-8000-00000000000a';
const ORG_B = '30020000-0000-4000-8000-00000000000b';
const USER_A = '30020000-0000-4000-8000-0000000000a1';
const USER_B = '30020000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const A = '"g1-a"';
const B = 'W/"g1-b"';
const L1 = 'Sun, 18 Oct 2026 10:00:00 GMT';
const L2 = 'Mon, 19 Oct 2026 10:00:00 GMT';
const ZEROS = {
  entriesSeen: 0,
  entriesIgnored: 0,
  entriesSkipped: 0,
  entriesAccepted: 0,
  sourcesCreated: 0,
  versionsCreated: 0,
  unchanged: 0,
  failed: 0,
  archived: 0,
  entriesLimited: 0,
};

let client: PrismaClient;
let repository: ContentStudioSourceRepository;
let discoveries: ContentStudioSourceDiscoveryRepository;
let ingestion: ContentStudioSourceIngestionService;
let service: ContentStudioSourceService;

const feedUrl = (name: string) => `https://p8g1.example/${name}.xml`;
const page = (name: string) => `https://p8g1.example/page-${name}`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8G1 page</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8G1</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;
const serveFeed = (name: string, links: string[], over: Partial<Resource>) =>
  web.resources.set(feedUrl(name), {
    body: rss(links),
    contentType: 'application/rss+xml',
    ...over,
  });
const servePage = (url: string, text: string, over: Partial<Resource>) =>
  web.resources.set(url, {
    body: html(text),
    contentType: 'text/html; charset=utf-8',
    ...over,
  });
const sent = (url: string) =>
  web.requests.filter((request) => request.url === url);

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
      name: `P8G1 ${name}`,
      canonicalUrl: feedUrl(name),
      createdById: OWNER[organizationId],
      ...over,
    },
  });
  return id;
};
const fixturePage = async (organizationId: string, url: string) => {
  const id = randomUUID();
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8G1 page',
      canonicalUrl: url,
      createdById: OWNER[organizationId],
    },
  });
  return id;
};
const row = (id: string) =>
  client.contentStudioSource.findUniqueOrThrow({ where: { id } });
const validators = async (id: string) => {
  const { httpEtag, httpLastModified } = await row(id);
  return { httpEtag, httpLastModified };
};
const versionCount = (sourceId: string) =>
  client.contentStudioSourceVersion.count({ where: { sourceId } });
const records = (sourceId: string) =>
  client.contentStudioSourceCaptureAttempt.findMany({
    where: { sourceId },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
const scheduled = (
  organizationId: string,
  sourceId: string,
  attemptId = randomUUID()
) =>
  ingestion.captureScheduledFeed({
    organizationId,
    sourceId,
    attemptId,
    attemptCount: 1,
  });
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
  return {
    status: (err as HttpException).getStatus(),
    ...((err as HttpException).getResponse() as Record<string, unknown>),
  } as Record<string, unknown>;
};
// a feed listing one page, both captured once with their validators
const capturedFeed = async (name: string) => {
  const feed = await fixtureFeed(ORG_A, name);
  serveFeed(name, [page(`${name}-1`)], { etag: A, lastModified: L1 });
  servePage(page(`${name}-1`), `One ${name}`, {
    etag: '"p1"',
    lastModified: L1,
  });
  await scheduled(ORG_A, feed);
  web.requests.length = 0;
  const pageId = (
    await client.contentStudioSource.findFirstOrThrow({
      where: { organizationId: ORG_A, canonicalUrl: page(`${name}-1`) },
    })
  ).id;
  return { feed, pageId };
};
// the feed lists one more page, so it is read, and its first page asked
const feedGrows = (name: string) => {
  serveFeed(name, [page(`${name}-1`), page(`${name}-2`)], { etag: B });
  servePage(page(`${name}-2`), `Two ${name}`, {});
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
      email: `${user}@p8g1.invalid`,
      providerName: 'LOCAL',
      timezone: 0,
      name: `P8G1 ${user}`,
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
    await client.organization.create({ data: { id, name: `P8G1 ${id}` } });
  }
  await addUser(USER_A, ORG_A);
  await addUser(USER_B, ORG_B);
});

beforeEach(async () => {
  await clean();
  web.resources.clear();
  web.failing.clear();
  web.held.clear();
  web.requests.length = 0;
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

describe('P8-G1 on PostgreSQL: the columns', () => {
  it('PGS a source starts with no validators and a record with no notModified; the columns take what a capture keeps', async () => {
    const feed = await fixtureFeed(ORG_A, 'new');
    expect(await validators(feed)).toEqual({
      httpEtag: null,
      httpLastModified: null,
    });
    const id = randomUUID();
    await client.contentStudioSourceCaptureAttempt.create({
      data: {
        id,
        organizationId: ORG_A,
        sourceId: feed,
        trigger: 'scheduled',
        status: 'running',
        startedAt: new Date(),
        attemptCount: 1,
      },
    });
    expect(
      (
        await client.contentStudioSourceCaptureAttempt.findUniqueOrThrow({
          where: { id },
        })
      ).notModified
    ).toBeNull();
    // the longest usable values, as text
    const etag = `W/"${'x'.repeat(1020)}"`;
    await client.contentStudioSource.update({
      where: { id: feed },
      data: { httpEtag: etag, httpLastModified: 'y'.repeat(256) },
    });
    expect(await validators(feed)).toEqual({
      httpEtag: etag,
      httpLastModified: 'y'.repeat(256),
    });
  });
});

describe('P8-G1 on PostgreSQL: a feed', () => {
  it('PG1/M35 the newer success keeps its validators: an older one that ends later writes none, and its record is still a success', async () => {
    const feed = await fixtureFeed(ORG_A, 'winner');
    const newer = new Date(Date.now() - MINUTE);
    const older = new Date(Date.now() - 2 * MINUTE);
    const run = async (
      capturedAt: Date,
      update: Parameters<ContentStudioSourceRepository['markFeedCaptured']>[4]
    ) => {
      const id = randomUUID();
      await client.contentStudioSourceCaptureAttempt.create({
        data: {
          id,
          organizationId: ORG_A,
          sourceId: feed,
          trigger: 'scheduled',
          status: 'running',
          startedAt: capturedAt,
          attemptCount: 1,
        },
      });
      const result = await repository.markFeedCaptured(
        ORG_A,
        feed,
        capturedAt,
        new Date(capturedAt.getTime() + HOUR),
        update,
        { id, finishedAt: new Date(), summary: ZEROS, notModified: false }
      );
      return { id, result };
    };
    expect(
      (await run(newer, { mode: 'replace', etag: B, lastModified: L2 })).result
    ).toEqual({ count: 1, ended: true });
    const late = await run(older, {
      mode: 'replace',
      etag: A,
      lastModified: L1,
    });
    expect(late.result).toEqual({ count: 0, ended: true });
    expect(await validators(feed)).toEqual({
      httpEtag: B,
      httpLastModified: L2,
    });
    expect(
      await client.contentStudioSourceCaptureAttempt.findUniqueOrThrow({
        where: { id: late.id },
      })
    ).toMatchObject({ status: 'success', notModified: false });
    // and two at once: the later read wins whatever the order they end in
    const [x, y] = [
      new Date(Date.now() - 20_000),
      new Date(Date.now() - 10_000),
    ];
    await Promise.all([
      run(y, { mode: 'replace', etag: '"y"', lastModified: null }),
      run(x, { mode: 'replace', etag: '"x"', lastModified: null }),
    ]);
    expect((await row(feed)).httpEtag).toBe('"y"');
    expect((await row(feed)).lastCapturedAt).toEqual(y);
  });

  it('PG2/PG9/F2/F8 a 304 merges (a new ETag, the date kept), schedules, ends the failures, and touches no entry, page, discovery or version', async () => {
    const { feed, pageId } = await capturedFeed('merge');
    await client.contentStudioSource.update({
      where: { id: feed },
      data: {
        consecutiveCaptureFailures: 3,
        nextCaptureAt: new Date(Date.now() - HOUR),
      },
    });
    web.resources.get(feedUrl('merge'))!.notModified = { etag: B };
    const before = {
      feed: await row(feed),
      page: await row(pageId),
      discoveries: await client.contentStudioSourceDiscovery.findMany({
        where: { organizationId: ORG_A },
      }),
      versions: await client.contentStudioSourceVersion.findMany({
        where: { organizationId: ORG_A },
      }),
      sources: await client.contentStudioSource.count({
        where: { organizationId: ORG_A },
      }),
    };
    const attemptId = randomUUID();
    expect(await scheduled(ORG_A, feed, attemptId)).toEqual({
      status: 'captured',
      capture: ZEROS,
    });
    expect(web.requests).toEqual([
      {
        url: feedUrl('merge'),
        headers: { 'If-None-Match': A, 'If-Modified-Since': L1 },
      },
    ]);
    const after = await row(feed);
    expect({
      httpEtag: after.httpEtag,
      httpLastModified: after.httpLastModified,
    }).toEqual({ httpEtag: B, httpLastModified: L1 });
    expect(after.lastCapturedAt!.getTime()).toBeGreaterThan(
      before.feed.lastCapturedAt!.getTime()
    );
    expect(after.nextCaptureAt!.getTime()).toBe(
      after.lastCapturedAt!.getTime() + HOUR
    );
    expect(after.consecutiveCaptureFailures).toBe(0);
    expect(after.latestVersionNumber).toBe(0);
    expect(await row(pageId)).toEqual(before.page);
    expect(
      await client.contentStudioSourceDiscovery.findMany({
        where: { organizationId: ORG_A },
      })
    ).toEqual(before.discoveries);
    expect(
      await client.contentStudioSourceVersion.findMany({
        where: { organizationId: ORG_A },
      })
    ).toEqual(before.versions);
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(before.sources);
    expect(
      await client.contentStudioSourceCaptureAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })
    ).toMatchObject({
      status: 'success',
      notModified: true,
      ...ZEROS,
      nextCaptureAtAfter: after.nextCaptureAt,
      consecutiveFailuresAfter: 0,
    });
  });

  it('PG3/PG8 a 200 after a conditional request replaces both validators: the one it did not send is cleared', async () => {
    const { feed } = await capturedFeed('replace');
    feedGrows('replace');
    const attemptId = randomUUID();
    await scheduled(ORG_A, feed, attemptId);
    expect(sent(feedUrl('replace'))[0].headers).toEqual({
      'If-None-Match': A,
      'If-Modified-Since': L1,
    });
    expect(await validators(feed)).toEqual({
      httpEtag: B,
      httpLastModified: null,
    });
    expect(
      await client.contentStudioSourceCaptureAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })
    ).toMatchObject({
      status: 'success',
      notModified: false,
      entriesAccepted: 2,
    });
  });

  it('PG4/F5/F6/M18/M19 a 200 that cannot be read, or whose processing fails, leaves the validators as they were', async () => {
    const { feed } = await capturedFeed('kept');
    web.resources.set(feedUrl('kept'), {
      body: '<html>no feed</html>',
      contentType: 'application/rss+xml',
      etag: B,
      lastModified: L2,
    });
    const failed = randomUUID();
    await expect(scheduled(ORG_A, feed, failed)).rejects.toMatchObject({
      response: { code: 'CS_SOURCE_FEED_INVALID' },
    });
    expect(
      await ingestion.finishScheduledFeedCapture({
        organizationId: ORG_A,
        sourceId: feed,
        attemptId: failed,
        status: 'source_failed',
        code: 'CS_SOURCE_FEED_INVALID',
      })
    ).toEqual({ status: 'finished' });
    expect(await validators(feed)).toEqual({
      httpEtag: A,
      httpLastModified: L1,
    });
    // the database fails while the pages are recorded
    feedGrows('kept');
    web.resources.get(feedUrl('kept'))!.lastModified = L2;
    jest
      .spyOn(discoveries, 'recordDiscovery')
      .mockRejectedValue(new Error('connection lost'));
    const lost = randomUUID();
    await expect(scheduled(ORG_A, feed, lost)).rejects.toThrow(
      'connection lost'
    );
    expect(await validators(feed)).toEqual({
      httpEtag: A,
      httpLastModified: L1,
    });
    const rows = await records(feed);
    expect(
      rows
        .filter((r) => r.id === failed || r.id === lost)
        .map((r) => [
          r.id === failed ? 'failed' : 'lost',
          r.status,
          r.notModified,
        ])
    ).toEqual(
      expect.arrayContaining([
        ['failed', 'source_failed', null],
        ['lost', 'running', null],
      ])
    );
  });
});

describe('P8-G1 on PostgreSQL: a page', () => {
  it('PG5/P2 a 304 adds no version, no page change and no Changed signal; only its validators move, updatedAt kept', async () => {
    const { feed, pageId } = await capturedFeed('p304');
    web.resources.get(page('p304-1'))!.notModified = { etag: '"p1b"' };
    const before = await row(pageId);
    const versionsBefore = await client.contentStudioSourceVersion.findMany({
      where: { sourceId: pageId },
    });
    const changes = await service.listPageChanges({
      organizationId: ORG_A,
      page: 1,
    } as Parameters<ContentStudioSourceService['listPageChanges']>[0]);
    feedGrows('p304');
    const result = await scheduled(ORG_A, feed);
    expect(result).toMatchObject({
      capture: { unchanged: 1, versionsCreated: 1, entriesAccepted: 2 },
    });
    expect(sent(page('p304-1'))[0].headers).toEqual({
      'If-None-Match': '"p1"',
      'If-Modified-Since': L1,
    });
    expect(await row(pageId)).toEqual({ ...before, httpEtag: '"p1b"' });
    expect(await versionCount(pageId)).toBe(1);
    // the version itself is as it was: never touched, its fetchedAt kept
    expect(
      await client.contentStudioSourceVersion.findMany({
        where: { sourceId: pageId },
      })
    ).toEqual(versionsBefore);
    expect(
      await service.listPageChanges({
        organizationId: ORG_A,
        page: 1,
      } as Parameters<ContentStudioSourceService['listPageChanges']>[0])
    ).toEqual(changes);
  });

  it('PG6/P4 a 200 with new content: the version, its page change and its validators commit together, or not at all', async () => {
    const { feed, pageId } = await capturedFeed('p200');
    servePage(page('p200-1'), 'One p200, changed', {
      etag: '"p1-v2"',
      lastModified: L2,
    });
    feedGrows('p200');
    await scheduled(ORG_A, feed);
    expect(await row(pageId)).toMatchObject({
      latestVersionNumber: 2,
      lastPageChangeVersionNumber: 2,
      lastPageChangeKind: 'content_changed',
      httpEtag: '"p1-v2"',
      httpLastModified: L2,
    });
    // a version create that fails rolls the validators back with it
    const [first] = await client.contentStudioSourceVersion.findMany({
      where: { sourceId: pageId },
      orderBy: { versionNumber: 'asc' },
    });
    await expect(
      repository.appendVersionWithCompareAndSwap({
        organizationId: ORG_A,
        sourceId: pageId,
        expectedLatestVersionNumber: 2,
        versionId: first.id,
        version: {
          ...(await client.contentStudioSourceVersion.findUniqueOrThrow({
            where: { id: first.id },
          })),
          fetchedAt: new Date(),
        } as never,
        createdById: USER_A,
        validators: { mode: 'replace', etag: '"never"', lastModified: null },
      })
    ).rejects.toThrow();
    expect(await row(pageId)).toMatchObject({
      latestVersionNumber: 2,
      httpEtag: '"p1-v2"',
    });
  });

  it('P3 a 200 with the same content: no version, the validators replaced, updatedAt kept', async () => {
    const { feed, pageId } = await capturedFeed('psame');
    servePage(page('psame-1'), 'One psame', { etag: '"p1-rotated"' });
    const before = await row(pageId);
    feedGrows('psame');
    const result = await scheduled(ORG_A, feed);
    expect(result).toMatchObject({ capture: { unchanged: 1 } });
    expect(await versionCount(pageId)).toBe(1);
    expect(await row(pageId)).toEqual({
      ...before,
      httpEtag: '"p1-rotated"',
      httpLastModified: null,
    });
  });

  it('PG7/P7/M28 an older answer that ends later never replaces newer state: the version a refresh appended meanwhile keeps its validators', async () => {
    const { feed, pageId } = await capturedFeed('race');
    feedGrows('race');
    // the feed capture's page answer is held; meanwhile a member refreshes
    // the page, which has changed, and stores version 2 with its validators
    let release!: () => void;
    web.held.set(
      page('race-1'),
      new Promise<void>((resolve) => (release = resolve))
    );
    const capture = scheduled(ORG_A, feed);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent(page('race-1'))).toHaveLength(1);
    servePage(page('race-1'), 'One race, changed', {
      etag: '"p1-v2"',
      lastModified: L2,
      // the held answer is a 304 with an older validator
      notModified: { etag: '"p1-old"' },
    });
    await refresh(ORG_A, pageId);
    expect(await row(pageId)).toMatchObject({
      latestVersionNumber: 2,
      httpEtag: '"p1-v2"',
      httpLastModified: L2,
    });
    // the held answer is that 304, to the validators of version 1 it sent:
    // it read version 1, so it writes nothing
    web.resources.get(page('race-1'))!.etag = '"p1"';
    release();
    await capture;
    expect(await row(pageId)).toMatchObject({
      latestVersionNumber: 2,
      httpEtag: '"p1-v2"',
      httpLastModified: L2,
    });
    expect(await versionCount(pageId)).toBe(2);
  });

  it('PG7 two confirmations from the same state: exactly one writes', async () => {
    const { pageId } = await capturedFeed('twice');
    const read = await row(pageId);
    const expected = {
      latestVersionNumber: read.latestVersionNumber,
      updatedAt: read.updatedAt,
      httpEtag: read.httpEtag,
      httpLastModified: read.httpLastModified,
    };
    const results = await Promise.all(
      ['"first"', '"second"'].map((etag) =>
        repository.markPageUnchanged({
          organizationId: ORG_A,
          id: pageId,
          expected,
          validators: { mode: 'merge', etag },
        })
      )
    );
    expect(results.map((r) => r.count).sort()).toEqual([0, 1]);
    const after = await row(pageId);
    expect(['"first"', '"second"']).toContain(after.httpEtag);
    expect(after.updatedAt).toEqual(read.updatedAt);
    // another organization's page is never written
    expect(
      await repository.markPageUnchanged({
        organizationId: ORG_B,
        id: pageId,
        expected: { ...expected, httpEtag: after.httpEtag },
        validators: { mode: 'merge', etag: '"other"' },
      })
    ).toEqual({ count: 0 });
  });
});

describe('P8-G1 on PostgreSQL: the record', () => {
  it('PG8/PG9 the history says whether the feed was modified; running and failed records say nothing; a corrupt one is refused', async () => {
    const { feed } = await capturedFeed('history');
    await scheduled(ORG_A, feed);
    feedGrows('history');
    await scheduled(ORG_A, feed);
    // a running one: begun, not ended
    web.held.set(feedUrl('history'), new Promise<void>(() => undefined));
    void scheduled(ORG_A, feed).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const list = await service.listFeedCaptures({
      organizationId: ORG_A,
      sourceId: feed,
      page: 1,
    });
    expect(
      list.results.map((r: Record<string, any>) => [r.status, r.notModified])
    ).toEqual([
      ['running', null],
      ['success', false],
      ['success', true],
      ['success', false],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/etag|g1-a|GMT|304/i);
    // a record that says not modified but read something is refused
    await client.contentStudioSourceCaptureAttempt.updateMany({
      where: { sourceId: feed, notModified: true },
      data: { entriesSeen: 1 },
    });
    expect(
      (
        await refusal(
          service.listFeedCaptures({
            organizationId: ORG_A,
            sourceId: feed,
            page: 1,
          })
        )
      ).status
    ).toBe(500);
  });
});

describe('P8-G1 on PostgreSQL: a member refresh', () => {
  it('PG10/MAPI3/MAPI4 of a page: never conditional, a duplicate version, the validators of its answer; a failure keeps them', async () => {
    const pageId = await fixturePage(ORG_A, page('member'));
    servePage(page('member'), 'Member page', {
      etag: '"m1"',
      lastModified: L1,
    });
    await refresh(ORG_A, pageId);
    await refresh(ORG_A, pageId);
    expect(sent(page('member')).map((r) => r.headers)).toEqual([{}, {}]);
    const versions = await client.contentStudioSourceVersion.findMany({
      where: { sourceId: pageId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].contentHash).toBe(versions[1].contentHash);
    expect(await validators(pageId)).toEqual({
      httpEtag: '"m1"',
      httpLastModified: L1,
    });
    web.resources.get(page('member'))!.etag = '"m2"';
    web.resources.get(page('member'))!.lastModified = undefined;
    await refresh(ORG_A, pageId);
    expect(await validators(pageId)).toEqual({
      httpEtag: '"m2"',
      httpLastModified: null,
    });
    web.failing.add(page('member'));
    expect((await refusal(refresh(ORG_A, pageId))).status).toBe(502);
    expect(await validators(pageId)).toEqual({
      httpEtag: '"m2"',
      httpLastModified: null,
    });
    expect(await versionCount(pageId)).toBe(3);
  });

  it('MAPI1/MAPI5 of a feed: conditional, a 304 answers notModified and starts the cooldown; a refusal fetches and changes nothing', async () => {
    const { feed } = await capturedFeed('mfeed');
    const result = await refresh(ORG_A, feed);
    expect(result.notModified).toBe(true);
    expect(result.capture).toEqual(ZEROS);
    expect(Object.keys(result.source)).not.toEqual(
      expect.arrayContaining(['httpEtag', 'httpLastModified'])
    );
    const manual = (await records(feed)).filter((r) => r.trigger === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({
      status: 'success',
      notModified: true,
      attemptCount: 1,
      requestedByUserId: USER_A,
    });
    mockLimits.manualRefreshCooldownMs = 5 * MINUTE;
    web.requests.length = 0;
    const before = await row(feed);
    expect((await refusal(refresh(ORG_A, feed))).code).toBe(
      'CS_SOURCE_REFRESH_TOO_SOON'
    );
    expect(web.requests).toEqual([]);
    expect(await row(feed)).toEqual(before);
  });

  it('MAPI2 of a feed that fails: the validators stay, the record is a failure', async () => {
    const { feed } = await capturedFeed('mfail');
    web.failing.add(feedUrl('mfail'));
    expect((await refusal(refresh(ORG_A, feed))).status).toBe(502);
    expect(await validators(feed)).toEqual({
      httpEtag: A,
      httpLastModified: L1,
    });
    const manual = (await records(feed)).find((r) => r.trigger === 'manual')!;
    expect(manual).toMatchObject({
      status: 'source_failed',
      notModified: null,
    });
  });
});
