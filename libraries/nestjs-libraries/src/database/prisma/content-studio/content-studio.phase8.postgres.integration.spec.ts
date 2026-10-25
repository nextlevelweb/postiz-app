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

// Phase 8 on a real PostgreSQL (P8-01): feed capture, discovered page
// sources and their versions, under concurrency. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. The repositories and services run unchanged; Prisma is used
// directly only for fixtures, final state and writes that bypass the
// application on purpose.
//
// Nothing is fetched: safeFetch is an in-memory web (a feed body per feed
// URL, an HTML body per page URL). Races are ordered with promise barriers
// placed in the fake web and in a test subclass of the repository, and are
// judged by their final state, never by timing
type Web = {
  feeds: Map<string, string>;
  pages: Map<string, string>;
  // runs before a page answers (a barrier, say)
  beforePage?: (url: string) => Promise<void>;
};
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
    await web.beforePage?.(url);
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
const ORG_A = '30800000-0000-4000-8000-00000000000a';
const ORG_B = '30800000-0000-4000-8000-00000000000b';
const USER_A = '30800000-0000-4000-8000-0000000000a1';
const USER_A2 = '30800000-0000-4000-8000-0000000000a2';
const USER_B = '30800000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_A2, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };

let client: PrismaClient;
let prisma: PrismaService;
let transaction: PrismaTransaction;
let sources: ContentStudioSourceRepository;
let discoveries: ContentStudioSourceDiscoveryRepository;
let captureAttempts: ContentStudioSourceCaptureAttemptRepository;
let ingestion: ContentStudioSourceIngestionService;
let sourceService: ContentStudioSourceService;

const page = (n: number | string) => `https://p8.example/story-${n}`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8 page</title></head><body><main><p>${text}</p></main></body></html>`;

// --- barriers: no sleeps. A latch opens once `parties` callers arrived; the
// timer only turns a deadlock into a failure, it never orders anything ---
const latch = (parties: number) => {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      open();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      opened,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('barrier not reached: deadlock')),
          4000
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
};

// The repository, with a barrier right after the canonical URL lookup of a
// page: two captures both see "no source" before either creates one
class LookupBarrierRepository extends ContentStudioSourceRepository {
  constructor(private _afterLookup: (url: string) => Promise<void>) {
    super(
      new PrismaRepository<'contentStudioSource'>(prisma),
      new PrismaRepository<'contentStudioSourceVersion'>(prisma),
      transaction
    );
  }
  // a Prisma promise in the base class: the barrier result is cast back
  getSourceByCanonicalUrlForOrganization(
    organizationId: string,
    canonicalUrl: string
  ): ReturnType<
    ContentStudioSourceRepository['getSourceByCanonicalUrlForOrganization']
  > {
    return (async () => {
      const row = await super.getSourceByCanonicalUrlForOrganization(
        organizationId,
        canonicalUrl
      );
      if (canonicalUrl.startsWith('https://p8.example/story-')) {
        await this._afterLookup(canonicalUrl);
      }
      return row;
    })() as unknown as ReturnType<
      ContentStudioSourceRepository['getSourceByCanonicalUrlForOrganization']
    >;
  }
}
// One latch per page URL, shared by the repositories that use it. A latch
// stays open, so a lookup again after a lost create passes at once
const perPage = (parties: number) => {
  const latches = new Map<string, () => Promise<void>>();
  return (url: string) => {
    if (!latches.has(url)) {
      latches.set(url, latch(parties));
    }
    return latches.get(url)!();
  };
};
const ingestionWith = (repository: ContentStudioSourceRepository) =>
  new ContentStudioSourceIngestionService(
    repository,
    discoveries,
    captureAttempts
  );

const createFeed = async (
  organizationId: string,
  url: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) =>
  (
    await client.contentStudioSource.create({
      data: {
        organizationId,
        kind: 'feed',
        name: 'P8 feed',
        canonicalUrl: url,
        latestVersionNumber: 0,
        createdById: OWNER[organizationId],
        ...over,
      },
      select: { id: true },
    })
  ).id;

const manual = (
  organizationId: string,
  sourceId: string,
  service = ingestion,
  userId = OWNER[organizationId]
) =>
  service.refreshSource({
    organizationId,
    userId,
    sourceId,
  }) as unknown as Promise<{
    source: { id: string; lastCapturedAt: Date | null };
    capture: Record<string, number>;
  }>;

const pageSources = (organizationId = ORG_A) =>
  client.contentStudioSource.findMany({
    where: { organizationId, kind: 'url' },
    orderBy: { canonicalUrl: 'asc' },
  });
const versionsOf = (sourceId: string) =>
  client.contentStudioSourceVersion.findMany({
    where: { sourceId },
    orderBy: { versionNumber: 'asc' },
  });
const discoveryRows = (organizationId = ORG_A) =>
  client.contentStudioSourceDiscovery.findMany({
    where: { organizationId },
    orderBy: [{ feedSourceId: 'asc' }, { discoveredSourceId: 'asc' }],
  });

const prismaCode = async (write: Promise<unknown>) => {
  try {
    await write;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return err.code;
    }
    throw err;
  }
  throw new Error('the write was expected to fail');
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
    /P20\d\d|constraint|_fkey|prisma|SELECT|"ContentStudio|p8\.example/i
  );
  return { status: (err as HttpException).getStatus(), ...body };
};

const cleanPhase8 = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceCaptureAttempt.deleteMany({ where });
  await client.contentStudioSourceDiscovery.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await cleanPhase8();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: USERS } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  prisma = client as unknown as PrismaService;
  transaction = new PrismaTransaction(prisma);
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  captureAttempts = new ContentStudioSourceCaptureAttemptRepository(
    new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
  );
  ingestion = ingestionWith(sources);
  sourceService = new ContentStudioSourceService(
    sources,
    discoveries,
    captureAttempts
  );

  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P308 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_A2, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p308.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P308 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanPhase8();
  web.feeds.clear();
  web.pages.clear();
  web.beforePage = undefined;
  mockSafeFetch.mockClear();
});

afterAll(async () => {
  await cleanFixtures();
  await client.$disconnect();
});

describe('Phase 8 on PostgreSQL: concurrency', () => {
  it('P8PG1/CC1/CC2/CC3/M15 two captures of the same feed at once: one page source, one discovery and one version per page', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-1.xml');
    web.feeds.set('https://p8.example/feed-1.xml', rss([page(1), page(2)]));
    web.pages.set(page(1), html('One'));
    web.pages.set(page(2), html('Two'));
    // both captures pass the lookup of each page before either creates it
    const barrier = perPage(2);
    const a = ingestionWith(new LookupBarrierRepository(barrier));
    const b = ingestionWith(new LookupBarrierRepository(barrier));
    const [first, second] = await Promise.all([
      manual(ORG_A, feed, a),
      manual(ORG_A, feed, b, USER_A2),
    ]);
    const pages = await pageSources();
    expect(pages.map((s) => s.canonicalUrl)).toEqual([page(1), page(2)]);
    expect(await discoveryRows()).toHaveLength(2);
    for (const s of pages) {
      expect((await versionsOf(s.id)).map((v) => v.versionNumber)).toEqual([1]);
    }
    // between them: each page created once and captured once
    expect(first.capture.sourcesCreated + second.capture.sourcesCreated).toBe(
      2
    );
    expect(first.capture.versionsCreated + second.capture.versionsCreated).toBe(
      2
    );
    expect(first.capture.failed + second.capture.failed).toBe(0);
  });

  it('P8PG2/CC5/DS8 two feeds listing the same new page at once: one page source, one discovery per feed, one version', async () => {
    const feedA = await createFeed(ORG_A, 'https://p8.example/feed-a.xml');
    const feedB = await createFeed(ORG_A, 'https://p8.example/feed-b.xml');
    web.feeds.set('https://p8.example/feed-a.xml', rss([page('shared')]));
    web.feeds.set('https://p8.example/feed-b.xml', rss([page('shared')]));
    web.pages.set(page('shared'), html('Shared'));
    const barrier = perPage(2);
    await Promise.all([
      manual(ORG_A, feedA, ingestionWith(new LookupBarrierRepository(barrier))),
      manual(ORG_A, feedB, ingestionWith(new LookupBarrierRepository(barrier))),
    ]);
    const [shared] = await pageSources();
    expect(await pageSources()).toHaveLength(1);
    expect(
      (await discoveryRows())
        .map((d) => [d.feedSourceId, d.discoveredSourceId])
        .sort()
    ).toEqual([feedA, feedB].sort().map((feed) => [feed, shared.id]));
    expect(await versionsOf(shared.id)).toHaveLength(1);
  });

  it('P8PG4 a changed page captured by two captures at once gets exactly one next version', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-4.xml');
    web.feeds.set('https://p8.example/feed-4.xml', rss([page(4)]));
    web.pages.set(page(4), html('Before'));
    await manual(ORG_A, feed);
    web.pages.set(page(4), html('After'));
    // both fetch the changed page from version 1 before either appends
    const barrier = latch(2);
    web.beforePage = () => barrier();
    const results = await Promise.all([
      manual(ORG_A, feed),
      manual(ORG_A, feed, ingestion, USER_A2),
    ]);
    const [s] = await pageSources();
    expect((await versionsOf(s.id)).map((v) => v.versionNumber)).toEqual([
      1, 2,
    ]);
    expect(results.map((r) => r.capture.versionsCreated).sort()).toEqual([
      0, 1,
    ]);
    expect(results.map((r) => r.capture.unchanged).sort()).toEqual([0, 1]);
    expect(
      (
        await client.contentStudioSource.findUniqueOrThrow({
          where: { id: s.id },
        })
      ).latestVersionNumber
    ).toBe(2);
  });

  it('CC4 a manual and a scheduled capture at once converge', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-cc4.xml');
    web.feeds.set('https://p8.example/feed-cc4.xml', rss([page('cc4')]));
    web.pages.set(page('cc4'), html('Both'));
    const barrier = latch(2);
    web.beforePage = () => barrier();
    const [byHand, scheduled] = await Promise.all([
      manual(ORG_A, feed, ingestion, USER_A2),
      ingestion.captureScheduledFeed({
        organizationId: ORG_A,
        sourceId: feed,
        attemptId: randomUUID(),
        attemptCount: 1,
      }),
    ]);
    expect(scheduled.status).toBe('captured');
    const [s] = await pageSources();
    expect(await pageSources()).toHaveLength(1);
    expect(await versionsOf(s.id)).toHaveLength(1);
    expect(await discoveryRows()).toHaveLength(1);
    expect(byHand.capture.failed).toBe(0);
  });
});

describe('Phase 8 on PostgreSQL: repeated captures and the schedule', () => {
  it('P8PG3/DS4-DS7 an unchanged repeat keeps firstSeenAt, moves lastSeenAt and adds no version', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-3.xml');
    web.feeds.set('https://p8.example/feed-3.xml', rss([page(3)]));
    web.pages.set(page(3), html('Same'));
    const first = await manual(ORG_A, feed);
    const [before] = await discoveryRows();
    expect(before.firstSeenAt).toEqual(before.lastSeenAt);
    expect(before.firstSeenAt).toEqual(first.source.lastCapturedAt);

    const second = await manual(ORG_A, feed);
    const [after] = await discoveryRows();
    expect(second.capture).toMatchObject({
      versionsCreated: 0,
      unchanged: 1,
      sourcesCreated: 0,
    });
    expect(after.id).toBe(before.id);
    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(
      before.lastSeenAt.getTime()
    );
    const [s] = await pageSources();
    expect(await versionsOf(s.id)).toHaveLength(1);
    // the feed itself never has a version
    expect(await versionsOf(feed)).toEqual([]);
    // an older sighting written after a newer one never moves lastSeenAt back
    await discoveries.recordDiscovery({
      organizationId: ORG_A,
      feedSourceId: feed,
      discoveredSourceId: s.id,
      entryId: null,
      entryTitle: 'stale',
      publishedAt: null,
      seenAt: new Date(before.lastSeenAt.getTime() - 60_000),
    });
    expect((await discoveryRows())[0]).toMatchObject({
      lastSeenAt: after.lastSeenAt,
      entryTitle: 'Story 0',
    });
  });

  it('P8PG6/TM3/M14 an archived feed is never scheduled or captured; restoring it makes it due again without a capture', async () => {
    // created by another member: scheduled captures are in that member's name
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-6.xml', {
      archivedAt: new Date(),
      createdById: USER_A2,
    });
    web.feeds.set('https://p8.example/feed-6.xml', rss([page(6)]));
    web.pages.set(page(6), html('Six'));
    const due = async () =>
      (await ingestion.listFeedsDueForCapture({ afterId: null })).feeds.filter(
        (f) => ORGS.includes(f.organizationId)
      );
    expect(await due()).toEqual([]);
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_A,
        sourceId: feed,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).toEqual({ status: 'skipped' });
    expect((await refusal(manual(ORG_A, feed))).status).toBe(409);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    await sourceService.restoreSource(ORG_A, feed);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await due()).toEqual([{ organizationId: ORG_A, sourceId: feed }]);
    // once captured, not due again within the interval
    await ingestion.captureScheduledFeed({
      organizationId: ORG_A,
      sourceId: feed,
      attemptId: randomUUID(),
      attemptCount: 1,
    });
    expect(await due()).toEqual([]);
    // the schedule writes in the feed creator's name
    const [s] = await pageSources();
    expect(s.createdById).toBe(USER_A2);
    expect((await versionsOf(s.id))[0].createdById).toBe(USER_A2);
  });

  it('P8C2PG1 a feed whose organization is deleted after the scan listed it is skipped when its capture starts (P8-C2: captures wait in a queue)', async () => {
    const feed = await createFeed(ORG_B, 'https://p8.example/feed-del.xml');
    web.feeds.set('https://p8.example/feed-del.xml', rss([page('del')]));
    web.pages.set(page('del'), html('Deleted'));
    const listed = (
      await ingestion.listFeedsDueForCapture({ afterId: null })
    ).feeds.filter((f) => f.sourceId === feed);
    expect(listed).toEqual([{ organizationId: ORG_B, sourceId: feed }]);
    await client.organization.update({
      where: { id: ORG_B },
      data: { deletedAt: new Date() },
    });
    try {
      expect(
        await ingestion.captureScheduledFeed({
          organizationId: ORG_B,
          sourceId: feed,
          attemptId: randomUUID(),
          attemptCount: 1,
        })
      ).toEqual({ status: 'skipped' });
      expect(mockSafeFetch).not.toHaveBeenCalled();
      expect(await pageSources(ORG_B)).toEqual([]);
      const row = await client.contentStudioSource.findUniqueOrThrow({
        where: { id: feed },
      });
      expect(row.lastCapturedAt).toBeNull();
    } finally {
      await client.organization.update({
        where: { id: ORG_B },
        data: { deletedAt: null },
      });
    }
    // live again, the same feed is captured
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_B,
        sourceId: feed,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).toMatchObject({ status: 'captured' });
  });

  it('a page source archived meanwhile is recorded and not captured', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-ar.xml');
    web.feeds.set('https://p8.example/feed-ar.xml', rss([page('ar')]));
    web.pages.set(page('ar'), html('A'));
    await manual(ORG_A, feed);
    const [s] = await pageSources();
    await sourceService.archiveSource(ORG_A, s.id);
    web.pages.set(page('ar'), html('B'));
    const again = await manual(ORG_A, feed);
    expect(again.capture).toMatchObject({ archived: 1, versionsCreated: 0 });
    expect(await versionsOf(s.id)).toHaveLength(1);
  });
});

describe('Phase 8 on PostgreSQL: tenancy and integrity', () => {
  it('P8PG5/TEN4/TEN5/77 the composite keys refuse a discovery across organizations', async () => {
    const feedA = await createFeed(ORG_A, 'https://p8.example/feed-5a.xml');
    const feedB = await createFeed(ORG_B, 'https://p8.example/feed-5b.xml');
    const pageA = await client.contentStudioSource.create({
      data: {
        organizationId: ORG_A,
        kind: 'url',
        name: 'A',
        canonicalUrl: page('5a'),
        createdById: USER_A,
      },
    });
    const pageB = await client.contentStudioSource.create({
      data: {
        organizationId: ORG_B,
        kind: 'url',
        name: 'B',
        canonicalUrl: page('5b'),
        createdById: USER_B,
      },
    });
    const row = (
      over: Partial<Prisma.ContentStudioSourceDiscoveryUncheckedCreateInput>
    ) => ({
      organizationId: ORG_A,
      feedSourceId: feedA,
      discoveredSourceId: pageA.id,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      ...over,
    });
    // a foreign page, a foreign feed, a row of another organization
    expect(
      await prismaCode(
        client.contentStudioSourceDiscovery.create({
          data: row({ discoveredSourceId: pageB.id }),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSourceDiscovery.create({
          data: row({ feedSourceId: feedB }),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSourceDiscovery.create({
          data: row({ organizationId: ORG_B }),
        })
      )
    ).toBe('P2003');
    // the same feed and page twice is one row
    await client.contentStudioSourceDiscovery.create({ data: row({}) });
    expect(
      await prismaCode(
        client.contentStudioSourceDiscovery.create({ data: row({}) })
      )
    ).toBe('P2002');
    // 78 a source with discoveries cannot be deleted: Restrict
    expect(
      await prismaCode(
        client.contentStudioSource.delete({ where: { id: pageA.id } })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSource.delete({ where: { id: feedA } })
      )
    ).toBe('P2003');
  });

  it('TEN1/TEN2/TEN3/TEN6/M12/M13 another organization can neither capture nor read the feed; pages never dedup across organizations', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-t.xml');
    await client.contentStudioSource.create({
      data: {
        organizationId: ORG_B,
        kind: 'url',
        name: 'Theirs',
        canonicalUrl: page('t'),
        createdById: USER_B,
      },
    });
    web.feeds.set('https://p8.example/feed-t.xml', rss([page('t')]));
    web.pages.set(page('t'), html('Ours'));
    expect((await refusal(manual(ORG_B, feed))).status).toBe(404);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(
      await ingestion.captureScheduledFeed({
        organizationId: ORG_B,
        sourceId: feed,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).toEqual({ status: 'skipped' });
    await manual(ORG_A, feed);
    const mine = await pageSources(ORG_A);
    const theirs = await pageSources(ORG_B);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0].id).not.toBe(theirs[0].id);
    expect(await versionsOf(theirs[0].id)).toEqual([]);
    expect(
      (
        await refusal(
          sourceService.listDiscoveries({
            organizationId: ORG_B,
            sourceId: feed,
            page: 1,
          })
        )
      ).status
    ).toBe(404);
    const listed = await sourceService.listDiscoveries({
      organizationId: ORG_A,
      sourceId: feed,
      page: 1,
    });
    expect(listed.results.map((d) => d.source.id)).toEqual([mine[0].id]);
  });

  it('P8PG7/93 a discovery row that is not what a capture writes fails the read closed', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-7.xml');
    const otherFeed = await createFeed(ORG_A, 'https://p8.example/feed-7b.xml');
    // the database allows a feed as the discovered source; the service does not
    await client.contentStudioSourceDiscovery.create({
      data: {
        organizationId: ORG_A,
        feedSourceId: feed,
        discoveredSourceId: otherFeed,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    expect(
      await refusal(
        sourceService.listDiscoveries({
          organizationId: ORG_A,
          sourceId: feed,
          page: 1,
        })
      )
    ).toEqual({
      status: 500,
      msg: 'Stored source data could not be verified.',
      code: 'CS_SOURCE_INTEGRITY_ERROR',
    });
    // a page source used as a feed has no discoveries to read
    const pageRow = await client.contentStudioSource.create({
      data: {
        organizationId: ORG_A,
        kind: 'url',
        name: 'P',
        canonicalUrl: page(7),
        createdById: USER_A,
      },
    });
    expect(
      (
        await refusal(
          sourceService.listDiscoveries({
            organizationId: ORG_A,
            sourceId: pageRow.id,
            page: 1,
          })
        )
      ).status
    ).toBe(400);
    // a tampered kind on the feed is no feed
    await client.contentStudioSource.update({
      where: { id: otherFeed },
      data: { kind: 'rss' },
    });
    expect(
      (
        await refusal(
          sourceService.listDiscoveries({
            organizationId: ORG_A,
            sourceId: otherFeed,
            page: 1,
          })
        )
      ).status
    ).toBe(500);
    expect((await refusal(manual(ORG_A, otherFeed))).status).toBe(400);
  });

  it('P801-3 the pages are ordinary sources: grounding-ready url sources with verified versions; the feed is not', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-g.xml');
    web.feeds.set('https://p8.example/feed-g.xml', rss([page('g')]));
    web.pages.set(page('g'), html('Ground me'));
    await manual(ORG_A, feed);
    const [s] = await pageSources();
    const detail = await sourceService.getSource(ORG_A, s.id);
    expect(detail).toMatchObject({
      kind: 'url',
      latestVersionNumber: 1,
      lastCapturedAt: null,
    });
    const version = await sourceService.getVersion({
      organizationId: ORG_A,
      sourceId: s.id,
      versionId: detail.currentVersion!.id,
    });
    expect(version.content.blocks.map((b) => b.text)).toEqual(['Ground me']);
    expect(await sourceService.getSource(ORG_A, feed)).toMatchObject({
      kind: 'feed',
      latestVersionNumber: 0,
      currentVersion: null,
      lastCapturedAt: expect.any(Date),
    });
  });

  it('feed capture writes no AI operation, usage, review or approval row', async () => {
    const feed = await createFeed(ORG_A, 'https://p8.example/feed-n.xml');
    web.feeds.set('https://p8.example/feed-n.xml', rss([page('n')]));
    web.pages.set(page('n'), html('N'));
    await manual(ORG_A, feed);
    const where = { organizationId: { in: ORGS } };
    expect(await client.contentStudioAIOperation.count({ where })).toBe(0);
    expect(await client.contentStudioAIUsage.count({ where })).toBe(0);
    expect(await client.contentStudioReview.count({ where })).toBe(0);
    expect(await client.contentStudioApproval.count({ where })).toBe(0);
    expect(randomUUID()).toBeTruthy();
  });
});
