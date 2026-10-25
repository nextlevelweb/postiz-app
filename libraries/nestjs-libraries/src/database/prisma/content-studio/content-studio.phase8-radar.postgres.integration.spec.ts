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
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// News Radar (P8-02) on a real PostgreSQL: the organization-wide read model
// over discoveries, their feeds and their pages, with its order, filters,
// tenancy and fail-closed reading. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. The service and repositories run unchanged; Prisma is used
// directly only for fixtures and for writes that bypass the application on
// purpose. The Radar itself never writes

// Separate from the earlier fixtures: their own organizations and users
const ORG_A = '30820000-0000-4000-8000-00000000000a';
const ORG_B = '30820000-0000-4000-8000-00000000000b';
const USER_A = '30820000-0000-4000-8000-0000000000a1';
const USER_B = '30820000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let client: PrismaClient;
let service: ContentStudioSourceService;
let now: Date;
const ago = (ms: number) => new Date(now.getTime() - ms);

let n = 0;
const source = async (
  organizationId: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) => {
  n += 1;
  return (
    await client.contentStudioSource.create({
      data: {
        organizationId,
        kind: 'url',
        name: `Radar page ${n}`,
        canonicalUrl: `https://radar.example/page-${n}`,
        latestVersionNumber: 1,
        createdById: OWNER[organizationId],
        ...over,
      },
      select: { id: true },
    })
  ).id;
};
const feed = (
  organizationId: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) =>
  source(organizationId, {
    kind: 'feed',
    name: `Radar feed ${n + 1}`,
    canonicalUrl: `https://radar.example/feed-${n + 1}.xml`,
    latestVersionNumber: 0,
    ...over,
  });
// a sighting as feed capture writes it
const discovery = async (
  organizationId: string,
  feedSourceId: string,
  discoveredSourceId: string,
  firstSeenAt: Date,
  over: Partial<Prisma.ContentStudioSourceDiscoveryUncheckedCreateInput> = {}
) =>
  (
    await client.contentStudioSourceDiscovery.create({
      data: {
        organizationId,
        feedSourceId,
        discoveredSourceId,
        entryTitle: `Entry for ${discoveredSourceId.slice(0, 8)}`,
        publishedAt: null,
        firstSeenAt,
        lastSeenAt: firstSeenAt,
        ...over,
      },
      select: { id: true },
    })
  ).id;
const radar = (
  input: Partial<
    Parameters<ContentStudioSourceService['listOrganizationDiscoveries']>[0]
  > = {}
) =>
  service.listOrganizationDiscoveries({
    organizationId: ORG_A,
    page: 1,
    ...input,
  });
const ids = (result: { results: Array<{ id: string }> }) =>
  result.results.map((row) => row.id);

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
    /P20\d\d|constraint|_fkey|prisma|SELECT|"ContentStudio|radar\.example/i
  );
  return { status: (err as HttpException).getStatus(), ...body };
};

const cleanRadar = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceCaptureAttempt.deleteMany({ where });
  await client.contentStudioSourceDiscovery.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await cleanRadar();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: USERS } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  service = new ContentStudioSourceService(
    new ContentStudioSourceRepository(
      new PrismaRepository<'contentStudioSource'>(prisma),
      new PrismaRepository<'contentStudioSourceVersion'>(prisma),
      new PrismaTransaction(prisma)
    ),
    new ContentStudioSourceDiscoveryRepository(
      new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
    ),
    new ContentStudioSourceCaptureAttemptRepository(
      new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
    )
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P802 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p802.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P802 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanRadar();
  // whole milliseconds: what PostgreSQL keeps of a JavaScript date
  now = new Date(Math.floor(Date.now() / 1000) * 1000);
});

afterAll(async () => {
  await cleanFixtures();
  await client.$disconnect();
});

describe('News Radar on PostgreSQL: order and pages', () => {
  it('P802PG1 three feeds: the newest first sightings across them, one row per discovery', async () => {
    const [a, b, c] = [await feed(ORG_A), await feed(ORG_A), await feed(ORG_A)];
    const rows = [];
    for (const [f, hours] of [
      [a, 5],
      [b, 1],
      [c, 3],
      [a, 2],
      [b, 4],
      [c, 0.5],
    ] as Array<[string, number]>) {
      rows.push({
        // the oldest first sightings were seen again a minute ago and carry
        // the newest dates: neither moves them up
        id: await discovery(ORG_A, f, await source(ORG_A), ago(hours * HOUR), {
          lastSeenAt: ago(60 * 1000 * (10 - hours)),
          publishedAt: ago(DAY / hours),
        }),
        hours,
        feed: f,
      });
    }
    const result = await radar();
    expect(ids(result)).toEqual(
      [...rows].sort((x, y) => x.hours - y.hours).map((r) => r.id)
    );
    expect(result.total).toBe(6);
    expect(result.pages).toBe(1);
    expect(result.results.map((r) => r.feed.id)).toEqual(
      [...rows].sort((x, y) => x.hours - y.hours).map((r) => r.feed)
    );
  });

  it('P802PG2 sixty pages of one capture: publishedAt desc, undated last, id asc; pages never overlap', async () => {
    const f = await feed(ORG_A);
    const seen = ago(HOUR);
    const created: Array<{ id: string; publishedAt: Date | null }> = [];
    for (let i = 0; i < 60; i++) {
      // a third undated; the rest on 7 dates, so dates repeat
      const publishedAt =
        i % 3 === 0 ? null : new Date(Date.UTC(2026, 9, 1 + (i % 7), 6));
      created.push({
        id: await discovery(ORG_A, f, await source(ORG_A), seen, {
          publishedAt,
        }),
        publishedAt,
      });
    }
    const expected = [...created]
      .sort((x, y) => {
        if (x.publishedAt === null || y.publishedAt === null) {
          if (x.publishedAt === y.publishedAt) {
            return x.id < y.id ? -1 : 1;
          }
          return x.publishedAt === null ? 1 : -1;
        }
        const byDate = y.publishedAt.getTime() - x.publishedAt.getTime();
        return byDate || (x.id < y.id ? -1 : 1);
      })
      .map((row) => row.id);
    const first = await radar();
    const second = await radar({ page: 2 });
    expect([first.total, first.pages, second.pages]).toEqual([60, 2, 2]);
    expect(ids(first)).toHaveLength(50);
    expect(ids(second)).toHaveLength(10);
    expect([...ids(first), ...ids(second)]).toEqual(expected);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(60);
    // the same pages again: the order is a function of the rows only
    expect(ids(await radar({ page: 2 }))).toEqual(ids(second));
  });

  it('P802PG2 the window is the first sighting: firstSeenAt >= now - window, never lastSeenAt', async () => {
    const f = await feed(ORG_A);
    const inside = await discovery(ORG_A, f, await source(ORG_A), ago(6 * DAY));
    // first seen 8 days ago, listed again a minute ago
    await discovery(ORG_A, f, await source(ORG_A), ago(8 * DAY), {
      lastSeenAt: ago(60 * 1000),
    });
    const month = await discovery(ORG_A, f, await source(ORG_A), ago(29 * DAY));
    expect(ids(await radar())).toEqual([inside]);
    expect(ids(await radar({ since: '24h' }))).toEqual([]);
    expect(ids(await radar({ since: '30d' }))).toHaveLength(3);
    expect(ids(await radar({ since: '30d' }))).toContain(month);
    expect((await radar({ since: 'all' })).total).toBe(3);
  });
});

describe('News Radar on PostgreSQL: filters', () => {
  it('P802PG3 one feed of the organization; another organization’s feed is not found; a page is no feed', async () => {
    const [a, b] = [await feed(ORG_A), await feed(ORG_A)];
    const fromA = await discovery(ORG_A, a, await source(ORG_A), ago(HOUR));
    await discovery(ORG_A, b, await source(ORG_A), ago(HOUR));
    expect(ids(await radar({ feedSourceId: a }))).toEqual([fromA]);
    expect((await radar({ feedSourceId: a })).total).toBe(1);
    const foreign = await feed(ORG_B);
    await discovery(ORG_B, foreign, await source(ORG_B), ago(HOUR));
    expect(await refusal(radar({ feedSourceId: foreign }))).toEqual({
      status: 404,
      msg: 'Source not found.',
      code: 'CS_NOT_FOUND',
    });
    expect(
      await refusal(radar({ feedSourceId: await source(ORG_A) }))
    ).toMatchObject({ status: 400, code: 'CS_SOURCE_KIND_UNSUPPORTED' });
  });

  it('P802PG4 a page two feeds found is two rows with their own feed and one page source', async () => {
    const [a, b] = [await feed(ORG_A), await feed(ORG_A)];
    const shared = await source(ORG_A);
    const viaA = await discovery(ORG_A, a, shared, ago(2 * HOUR));
    const viaB = await discovery(ORG_A, b, shared, ago(HOUR));
    const result = await radar();
    expect(ids(result)).toEqual([viaB, viaA]);
    expect(result.results.map((r) => r.feed.id)).toEqual([b, a]);
    expect(result.results.map((r) => r.source.id)).toEqual([shared, shared]);
    expect(ids(await radar({ feedSourceId: a }))).toEqual([viaA]);
  });

  it('P802PG5 the same page address in two organizations stays in each organization', async () => {
    const url = 'https://radar.example/shared-story';
    const mineFeed = await feed(ORG_A);
    const mine = await discovery(
      ORG_A,
      mineFeed,
      await source(ORG_A, { canonicalUrl: url }),
      ago(2 * HOUR)
    );
    const theirFeed = await feed(ORG_B);
    const theirs = await discovery(
      ORG_B,
      theirFeed,
      await source(ORG_B, { canonicalUrl: url }),
      ago(HOUR)
    );
    expect(ids(await radar({ since: 'all' }))).toEqual([mine]);
    expect(
      ids(
        await service.listOrganizationDiscoveries({
          organizationId: ORG_B,
          page: 1,
          since: 'all',
        })
      )
    ).toEqual([theirs]);
    expect((await radar({ since: 'all' })).total).toBe(1);
  });

  it('P802PG6 captured is a page with a version; not captured is a page without one', async () => {
    const f = await feed(ORG_A);
    const captured = await discovery(
      ORG_A,
      f,
      await source(ORG_A, { latestVersionNumber: 1 }),
      ago(HOUR)
    );
    const twice = await discovery(
      ORG_A,
      f,
      await source(ORG_A, { latestVersionNumber: 4 }),
      ago(2 * HOUR)
    );
    const none = await discovery(
      ORG_A,
      f,
      await source(ORG_A, { latestVersionNumber: 0 }),
      ago(3 * HOUR)
    );
    expect(ids(await radar({ captureState: 'captured' }))).toEqual([
      captured,
      twice,
    ]);
    expect(ids(await radar({ captureState: 'not-captured' }))).toEqual([none]);
    expect((await radar({ captureState: 'not-captured' })).total).toBe(1);
    expect(ids(await radar())).toEqual([captured, twice, none]);
  });

  it('P802PG7 an archived feed is never in the Radar; an archived page is, marked archived', async () => {
    const live = await feed(ORG_A);
    const archived = await feed(ORG_A, { archivedAt: ago(DAY) });
    const archivedPage = await source(ORG_A, {
      archivedAt: ago(HOUR),
      latestVersionNumber: 0,
    });
    const kept = await discovery(ORG_A, live, archivedPage, ago(HOUR));
    await discovery(ORG_A, archived, await source(ORG_A), ago(30 * 60 * 1000));
    const result = await radar();
    expect(ids(result)).toEqual([kept]);
    expect(result.total).toBe(1);
    expect(result.results[0].source.archivedAt).toEqual(ago(HOUR));
    expect(ids(await radar({ captureState: 'not-captured' }))).toEqual([kept]);
    // named on purpose: the same rule, an empty Radar
    expect(await radar({ feedSourceId: archived, since: 'all' })).toEqual({
      pages: 0,
      total: 0,
      results: [],
    });
  });
});

describe('News Radar on PostgreSQL: fail closed', () => {
  it('P802PG8 the database refuses a cross-organization discovery; a row that is not what a capture writes fails the request', async () => {
    const f = await feed(ORG_A);
    const page = await source(ORG_A);
    const row = await discovery(ORG_A, f, page, ago(HOUR));
    // the composite keys keep a discovery's feed and page in its organization
    expect(
      await prismaCode(
        discovery(ORG_A, await feed(ORG_B), await source(ORG_A), ago(HOUR))
      )
    ).toBe('P2003');
    expect(
      await prismaCode(discovery(ORG_A, f, await source(ORG_B), ago(HOUR)))
    ).toBe('P2003');
    expect(ids(await radar())).toEqual([row]);

    const integrity = {
      status: 500,
      msg: 'Stored source data could not be verified.',
      code: 'CS_SOURCE_INTEGRITY_ERROR',
    };
    const tampers: Array<
      [string, () => Promise<unknown>, () => Promise<unknown>]
    > = [
      [
        'the feed is a web page',
        () =>
          client.contentStudioSource.update({
            where: { id: f },
            data: { kind: 'url' },
          }),
        () =>
          client.contentStudioSource.update({
            where: { id: f },
            data: { kind: 'feed' },
          }),
      ],
      [
        'the page is a feed',
        () =>
          client.contentStudioSource.update({
            where: { id: page },
            data: { kind: 'feed' },
          }),
        () =>
          client.contentStudioSource.update({
            where: { id: page },
            data: { kind: 'url' },
          }),
      ],
      [
        'the page has no URL',
        () =>
          client.contentStudioSource.update({
            where: { id: page },
            data: { canonicalUrl: null },
          }),
        () =>
          client.contentStudioSource.update({
            where: { id: page },
            data: { canonicalUrl: 'https://radar.example/restored' },
          }),
      ],
      [
        'last seen before first seen',
        () =>
          client.contentStudioSourceDiscovery.update({
            where: { id: row },
            data: { lastSeenAt: ago(DAY) },
          }),
        () =>
          client.contentStudioSourceDiscovery.update({
            where: { id: row },
            data: { lastSeenAt: ago(HOUR) },
          }),
      ],
    ];
    for (const [name, tamper, repair] of tampers) {
      await tamper();
      expect([name, await refusal(radar())]).toEqual([name, integrity]);
      await repair();
      expect([name, ids(await radar())]).toEqual([name, [row]]);
    }
  });

  it('reading the Radar writes nothing', async () => {
    const f = await feed(ORG_A);
    for (let i = 0; i < 5; i++) {
      await discovery(ORG_A, f, await source(ORG_A), ago(i * HOUR + 1));
    }
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          client.contentStudioSource.findMany({
            where: { organizationId: ORG_A },
            orderBy: { id: 'asc' },
          }),
          client.contentStudioSourceDiscovery.findMany({
            where: { organizationId: ORG_A },
            orderBy: { id: 'asc' },
          }),
          client.contentStudioSourceVersion.count(),
        ])
      );
    const before = await snapshot();
    await radar();
    await radar({ feedSourceId: f, since: 'all', captureState: 'captured' });
    expect(await snapshot()).toBe(before);
  });
});
