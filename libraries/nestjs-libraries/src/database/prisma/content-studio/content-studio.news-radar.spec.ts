import fs from 'fs';
import path from 'path';
import { HttpException } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import {
  ContentStudioSourceService,
  isContentStudioDiscoveryChangedSinceFound,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';

// News Radar (P8-02) with the real service and repositories over an
// in-memory Prisma. The fake joins a discovery to its feed and page by id
// alone, weaker than the database's (id, organizationId) keys, so a row the
// database would never hold can be planted and the service's own checks are
// what is tested. Real ordering, keys and the planner are in the Phase 8
// PostgreSQL suite

type Row = Record<string, any>;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const FEED_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FEED_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEED_ARCHIVED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_FEED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MARKER = 'NEWS_RADAR_PRIVATE_MARKER_456';

const value = (row: Row, key: string) =>
  row[key] === undefined ? null : row[key];
const compare = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() - b.getTime()
    : a! < b!
    ? -1
    : a! > b!
    ? 1
    : 0;

const setup = () => {
  const state = { sources: [] as Row[], discoveries: [] as Row[] };
  // by id alone, see above
  const relation = (row: Row, key: string) =>
    key === 'feedSource'
      ? state.sources.find((s) => s.id === row.feedSourceId) ?? null
      : key === 'discoveredSource'
      ? state.sources.find((s) => s.id === row.discoveredSourceId) ?? null
      : undefined;
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) {
        return true;
      }
      const related = relation(row, key);
      if (related !== undefined) {
        return !!related && matches(related, condition as Row);
      }
      if (condition === null) {
        return value(row, key) === null;
      }
      if (typeof condition === 'object' && !(condition instanceof Date)) {
        const c = condition as Row;
        if ('gte' in c) {
          return value(row, key) !== null && compare(row[key], c.gte) >= 0;
        }
        if ('not' in c) {
          return value(row, key) !== c.not;
        }
        throw new Error(`unsupported condition on ${key}`);
      }
      return condition instanceof Date
        ? row[key] instanceof Date && row[key].getTime() === condition.getTime()
        : row[key] === condition;
    });
  const pick = (row: Row, select?: Row): Row =>
    select
      ? Object.fromEntries(
          Object.entries(select).map(([key, sub]) => {
            const related = relation(row, key);
            if (related !== undefined) {
              return [key, related ? pick(related, (sub as Row).select) : null];
            }
            return [key, value(row, key)];
          })
        )
      : { ...row };
  const order = (rows: Row[], orderBy: Row[]) =>
    [...rows].sort((a, b) => {
      for (const rule of orderBy) {
        const [key, how] = Object.entries(rule)[0];
        const { sort, nulls } =
          typeof how === 'object' ? (how as Row) : { sort: how, nulls: null };
        const [x, y] = [value(a, key), value(b, key)];
        const result =
          x === null || y === null
            ? x === y
              ? 0
              : (x === null ? 1 : -1) * (nulls === 'first' ? -1 : 1)
            : compare(x, y) * (sort === 'desc' ? -1 : 1);
        if (result) {
          return result;
        }
      }
      return 0;
    });
  const writes = () => ({
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });
  const source = {
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = state.sources.find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
    findMany: jest.fn(),
    count: jest.fn(),
    ...writes(),
  };
  const discovery = {
    findFirst: jest.fn(),
    findMany: jest.fn(
      async (args: {
        where: Row;
        select?: Row;
        orderBy: Row[];
        skip: number;
        take: number;
      }) =>
        order(
          state.discoveries.filter((r) => matches(r, args.where)),
          args.orderBy
        )
          .slice(args.skip, args.skip + args.take)
          .map((r) => pick(r, args.select))
    ),
    count: jest.fn(
      async (args: { where: Row }) =>
        state.discoveries.filter((r) => matches(r, args.where)).length
    ),
    ...writes(),
  };
  const version = { ...writes(), findFirst: jest.fn(), findMany: jest.fn() };
  const transaction = { $transaction: jest.fn() };
  const service = new ContentStudioSourceService(
    new ContentStudioSourceRepository(
      {
        model: { contentStudioSource: source },
      } as unknown as PrismaRepository<'contentStudioSource'>,
      {
        model: { contentStudioSourceVersion: version },
      } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
      { model: transaction } as unknown as PrismaTransaction
    ),
    new ContentStudioSourceDiscoveryRepository({
      model: { contentStudioSourceDiscovery: discovery },
    } as unknown as PrismaRepository<'contentStudioSourceDiscovery'>),
    new ContentStudioSourceCaptureAttemptRepository({
      model: { contentStudioSourceCaptureAttempt: {} },
    } as unknown as PrismaRepository<'contentStudioSourceCaptureAttempt'>)
  );
  const addSource = (row: Row) => {
    const full = {
      organizationId: ORG,
      kind: 'url',
      name: 'Source',
      canonicalUrl: `https://news.example/${row.id}`,
      latestVersionNumber: 1,
      archivedAt: null,
      createdById: 'user',
      createdAt: ago(60 * DAY),
      updatedAt: ago(60 * DAY),
      lastCapturedAt: null,
      ...row,
    };
    state.sources.push(full);
    return full;
  };
  const addFeed = (id: string, row: Row = {}) =>
    addSource({
      id,
      kind: 'feed',
      name: `Feed ${id.slice(0, 4)}`,
      canonicalUrl: `https://news.example/${id}.xml`,
      latestVersionNumber: 0,
      ...row,
    });
  let n = 0;
  // a discovered page and the sighting by one feed
  const found = (
    feedSourceId: string,
    seen: Date,
    row: Row = {},
    page: Row = {}
  ) => {
    n += 1;
    const pageId = page.id ?? `page-${String(n).padStart(3, '0')}`;
    if (!state.sources.some((s) => s.id === pageId)) {
      addSource({ id: pageId, name: `Page ${n}`, ...page });
    }
    const d = {
      id: `d-${String(n).padStart(3, '0')}`,
      organizationId: ORG,
      feedSourceId,
      discoveredSourceId: pageId,
      entryId: `entry-${n}`,
      entryTitle: `Entry ${n}`,
      publishedAt: null,
      firstSeenAt: seen,
      lastSeenAt: seen,
      ...row,
    };
    state.discoveries.push(d);
    return d;
  };
  const radar = (input: Row = {}) =>
    service.listOrganizationDiscoveries({
      organizationId: ORG,
      page: 1,
      ...input,
    });
  return {
    state,
    service,
    source,
    discovery,
    version,
    transaction,
    addFeed,
    addSource,
    found,
    radar,
  };
};

const refusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse(),
  };
};
const ids = (result: { results: Array<{ id: string }> }) =>
  result.results.map((d) => d.id);
const INTEGRITY = {
  status: 500,
  body: {
    msg: 'Stored source data could not be verified.',
    code: 'CS_SOURCE_INTEGRITY_ERROR',
  },
};

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('News Radar: order and pages', () => {
  it('Q1 lists the newest first sightings across the live feeds of the organization', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(FEED_B);
    const a = t.found(FEED_A, ago(3 * HOUR));
    const b = t.found(FEED_B, ago(1 * HOUR));
    const c = t.found(FEED_A, ago(2 * HOUR));
    expect(ids(await t.radar())).toEqual([b.id, c.id, a.id]);
  });

  it('Q2-Q4 orders one capture (one first sighting) by publishedAt desc, undated last, then id asc', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const seen = ago(HOUR);
    const undated = t.found(FEED_A, seen);
    const older = t.found(FEED_A, seen, {
      publishedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const newer = t.found(FEED_A, seen, {
      publishedAt: new Date('2026-10-20T00:00:00Z'),
    });
    const sameB = t.found(FEED_A, seen, {
      id: 'd-zzz',
      publishedAt: new Date('2026-10-10T00:00:00Z'),
    });
    const sameA = t.found(FEED_A, seen, {
      id: 'd-aaa',
      publishedAt: new Date('2026-10-10T00:00:00Z'),
    });
    // a later first sighting still wins over any date
    const later = t.found(FEED_A, ago(HOUR - 1), {
      publishedAt: new Date('2000-01-01T00:00:00Z'),
    });
    expect(ids(await t.radar())).toEqual([
      later.id,
      newer.id,
      sameA.id,
      sameB.id,
      older.id,
      undated.id,
    ]);
    expect(t.discovery.findMany.mock.calls[0][0].orderBy).toEqual([
      { firstSeenAt: 'desc' },
      { publishedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('Q5/Q6 pages 50 at a time without overlap, with an exact total and page count', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const seen = ago(HOUR);
    for (let i = 0; i < 120; i++) {
      t.found(FEED_A, seen, {
        publishedAt: i % 3 ? new Date(Date.UTC(2026, 9, 1 + (i % 7))) : null,
      });
    }
    const pages = [];
    for (const page of [1, 2, 3]) {
      const result = await t.radar({ page });
      expect(result.total).toBe(120);
      expect(result.pages).toBe(3);
      pages.push(ids(result));
    }
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(new Set(pages.flat()).size).toBe(120);
    expect((await t.radar({ page: 4 })).results).toEqual([]);
    expect(t.discovery.findMany.mock.calls[1][0]).toMatchObject({
      skip: 50,
      take: 50,
    });
  });
});

describe('News Radar: window', () => {
  const windowed = async (since?: string) => {
    const t = setup();
    t.addFeed(FEED_A);
    const rows = {
      hour: t.found(FEED_A, ago(HOUR)),
      day: t.found(FEED_A, ago(DAY)),
      dayPlus: t.found(FEED_A, ago(DAY + 1)),
      week: t.found(FEED_A, ago(7 * DAY)),
      weekPlus: t.found(FEED_A, ago(7 * DAY + 1)),
      month: t.found(FEED_A, ago(30 * DAY)),
      monthPlus: t.found(FEED_A, ago(30 * DAY + 1)),
      year: t.found(FEED_A, ago(365 * DAY)),
      // S7: first seen long ago, still listed today
      stale: t.found(FEED_A, ago(40 * DAY), { lastSeenAt: ago(60 * 1000) }),
    };
    const result = await t.radar(since ? { since } : {});
    const names = Object.entries(rows)
      .filter(([, d]) => ids(result).includes(d.id))
      .map(([name]) => name);
    return { names, t };
  };

  it('S1/S3/S6 is 7 days by default, the exact threshold included', async () => {
    const { names, t } = await windowed();
    expect(names).toEqual(['hour', 'day', 'dayPlus', 'week']);
    expect(t.discovery.findMany.mock.calls[0][0].where.firstSeenAt).toEqual({
      gte: ago(7 * DAY),
    });
    expect((await windowed('7d')).names).toEqual(names);
  });

  it('S2 24 hours', async () => {
    expect((await windowed('24h')).names).toEqual(['hour', 'day']);
  });

  it('S4 30 days', async () => {
    expect((await windowed('30d')).names).toEqual([
      'hour',
      'day',
      'dayPlus',
      'week',
      'weekPlus',
      'month',
    ]);
  });

  it('S5 all time has no bound', async () => {
    const { names, t } = await windowed('all');
    expect(names).toHaveLength(9);
    expect(t.discovery.findMany.mock.calls[0][0].where).not.toHaveProperty(
      'firstSeenAt'
    );
  });

  it('S7 the window is the first sighting: a page first seen 40 days ago and seen again today is not recent', async () => {
    for (const since of ['24h', '7d', '30d']) {
      expect((await windowed(since)).names).not.toContain('stale');
    }
    const { t } = await windowed();
    const where = JSON.stringify(t.discovery.findMany.mock.calls[0][0].where);
    expect(where).not.toMatch(/lastSeenAt|publishedAt/);
  });
});

describe('News Radar: feed filter', () => {
  it('F1 narrows to one feed of the organization, still live feeds only', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(FEED_B);
    const a = t.found(FEED_A, ago(HOUR));
    t.found(FEED_B, ago(HOUR));
    const result = await t.radar({ feedSourceId: FEED_A });
    expect(ids(result)).toEqual([a.id]);
    expect(result.results[0].feed).toEqual({ id: FEED_A, name: 'Feed aaaa' });
    expect(t.discovery.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      feedSourceId: FEED_A,
      feedSource: { archivedAt: null },
    });
  });

  it('F2/TEN another organization’s feed is not found, and nothing is listed', async () => {
    const t = setup();
    t.addFeed(OTHER_FEED, { organizationId: OTHER_ORG });
    expect(await refusal(t.radar({ feedSourceId: OTHER_FEED }))).toEqual({
      status: 404,
      body: { msg: 'Source not found.', code: 'CS_NOT_FOUND' },
    });
    expect(
      await refusal(
        t.radar({ feedSourceId: '99999999-9999-4999-8999-999999999999' })
      )
    ).toMatchObject({ status: 404 });
    expect(t.discovery.findMany).not.toHaveBeenCalled();
    expect(t.discovery.count).not.toHaveBeenCalled();
  });

  it('F3 a web page is not a feed', async () => {
    const t = setup();
    t.addSource({ id: FEED_A });
    expect(await refusal(t.radar({ feedSourceId: FEED_A }))).toEqual({
      status: 400,
      body: {
        msg: 'This source type has no discoveries.',
        code: 'CS_SOURCE_KIND_UNSUPPORTED',
      },
    });
    expect(t.discovery.findMany).not.toHaveBeenCalled();
  });

  it('F4 a source of an unknown kind is an integrity error', async () => {
    const t = setup();
    t.addSource({ id: FEED_A, kind: 'rss' });
    expect(await refusal(t.radar({ feedSourceId: FEED_A }))).toEqual(INTEGRITY);
  });
});

describe('News Radar: capture state and archive', () => {
  const states = () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(FEED_ARCHIVED, { archivedAt: ago(DAY) });
    const rows = {
      captured: t.found(FEED_A, ago(HOUR), {}, { latestVersionNumber: 1 }),
      twice: t.found(FEED_A, ago(2 * HOUR), {}, { latestVersionNumber: 2 }),
      notCaptured: t.found(
        FEED_A,
        ago(3 * HOUR),
        {},
        { latestVersionNumber: 0 }
      ),
      archivedPage: t.found(
        FEED_A,
        ago(4 * HOUR),
        {},
        { latestVersionNumber: 0, archivedAt: ago(HOUR) }
      ),
      archivedFeed: t.found(FEED_ARCHIVED, ago(5 * HOUR)),
    };
    const named = (result: { results: Array<{ id: string }> }) =>
      Object.entries(rows)
        .filter(([, d]) => ids(result).includes(d.id))
        .map(([name]) => name);
    return { t, named };
  };

  it('C1 captured is a page with at least one version', async () => {
    const { t, named } = states();
    expect(named(await t.radar({ captureState: 'captured' }))).toEqual([
      'captured',
      'twice',
    ]);
    expect(
      t.discovery.findMany.mock.calls[0][0].where.discoveredSource
    ).toEqual({ latestVersionNumber: { gte: 1 } });
  });

  it('C2 not captured is a page without a version, archived or not', async () => {
    const { t, named } = states();
    expect(named(await t.radar({ captureState: 'not-captured' }))).toEqual([
      'notCaptured',
      'archivedPage',
    ]);
    expect(
      t.discovery.findMany.mock.calls[0][0].where.discoveredSource
    ).toEqual({ latestVersionNumber: 0 });
  });

  it('C3/C4/A1/A3 without a state: every page of a live feed, an archived page too, never an archived feed', async () => {
    const { t, named } = states();
    const result = await t.radar();
    expect(named(result)).toEqual([
      'captured',
      'twice',
      'notCaptured',
      'archivedPage',
    ]);
    expect(result.total).toBe(4);
    expect(
      result.results.find((d) => d.source.archivedAt !== null)?.source
    ).toMatchObject({ latestVersionNumber: 0, archivedAt: ago(HOUR) });
    expect(t.discovery.count.mock.calls[0][0].where).toMatchObject({
      feedSource: { archivedAt: null },
    });
  });

  it('A2 asking for an archived feed of the organization finds nothing, under the same rule', async () => {
    const { t } = states();
    const result = await t.radar({ feedSourceId: FEED_ARCHIVED, since: 'all' });
    expect(result).toEqual({ pages: 0, total: 0, results: [] });
  });
});

describe('News Radar: rows', () => {
  it('D1-D3 a page two feeds found is two rows, each with its own feed and the same page source', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(FEED_B);
    const a = t.found(FEED_A, ago(2 * HOUR), {}, { id: 'shared-page' });
    const b = t.found(FEED_B, ago(HOUR), {}, { id: 'shared-page' });
    const result = await t.radar();
    expect(ids(result)).toEqual([b.id, a.id]);
    expect(result.results.map((d) => d.feed.id)).toEqual([FEED_B, FEED_A]);
    expect(new Set(result.results.map((d) => d.source.id))).toEqual(
      new Set(['shared-page'])
    );
    expect(result.total).toBe(2);
  });

  it('answers the read model field by field: no organization, feed id, entry id, creator or page text', async () => {
    const t = setup();
    t.addFeed(FEED_A, { name: `News ${MARKER}`, createdById: MARKER });
    t.found(
      FEED_A,
      ago(HOUR),
      { entryTitle: `<b>${MARKER}</b>`, entryId: MARKER },
      { content: MARKER, createdById: MARKER }
    );
    const result = await t.radar();
    const row = result.results[0];
    expect(Object.keys(result).sort()).toEqual(['pages', 'results', 'total']);
    expect(Object.keys(row).sort()).toEqual([
      'changedSinceFound',
      'entryTitle',
      'feed',
      'firstSeenAt',
      'id',
      'lastSeenAt',
      'publishedAt',
      'source',
    ]);
    expect(Object.keys(row.feed).sort()).toEqual(['id', 'name']);
    expect(Object.keys(row.source).sort()).toEqual([
      'archivedAt',
      'canonicalUrl',
      'id',
      'lastPageChangeAt',
      'latestVersionNumber',
      'name',
    ]);
    // the title is the feed's text, as data
    expect(row.entryTitle).toBe(`<b>${MARKER}</b>`);
    const json = JSON.stringify({ ...row, entryTitle: null, feed: null });
    expect(json).not.toContain(MARKER);
    expect(json).not.toMatch(
      /organizationId|feedSourceId|entryId|createdById|content/
    );
  });
});

describe('News Radar: integrity', () => {
  const planted = (
    tamper: (t: ReturnType<typeof setup>) => void
  ): Promise<unknown> => {
    const t = setup();
    t.addFeed(FEED_A);
    t.found(FEED_A, ago(HOUR), {}, { id: 'page-x' });
    t.found(FEED_A, ago(2 * HOUR));
    tamper(t);
    return t.radar();
  };

  it.each([
    [
      'I1 a feed of another organization',
      (t: ReturnType<typeof setup>) =>
        (t.state.sources.find((s) => s.id === FEED_A)!.organizationId =
          OTHER_ORG),
    ],
    [
      'I2 a page of another organization',
      (t: ReturnType<typeof setup>) =>
        (t.state.sources.find((s) => s.id === 'page-x')!.organizationId =
          OTHER_ORG),
    ],
    [
      'I3 a "feed" that is a web page',
      (t: ReturnType<typeof setup>) =>
        (t.state.sources.find((s) => s.id === FEED_A)!.kind = 'url'),
    ],
    [
      'I4 a "page" that is a feed',
      (t: ReturnType<typeof setup>) =>
        (t.state.sources.find((s) => s.id === 'page-x')!.kind = 'feed'),
    ],
    [
      'I5 a page without a URL',
      (t: ReturnType<typeof setup>) =>
        (t.state.sources.find((s) => s.id === 'page-x')!.canonicalUrl = null),
    ],
    [
      'I5 a page with an empty URL',
      (t: ReturnType<typeof setup>) =>
        (t.state.sources.find((s) => s.id === 'page-x')!.canonicalUrl = ''),
    ],
    [
      'I6 last seen before first seen',
      (t: ReturnType<typeof setup>) =>
        (t.state.discoveries[0].lastSeenAt = ago(DAY)),
    ],
    [
      'a missing page',
      (t: ReturnType<typeof setup>) =>
        t.state.sources.splice(
          t.state.sources.findIndex((s) => s.id === 'page-x'),
          1
        ),
    ],
    [
      'a first sighting that is no date',
      (t: ReturnType<typeof setup>) =>
        (t.state.discoveries[0].firstSeenAt = '2026-10-22'),
    ],
    [
      'P8-04B2 a page change without the capture before it',
      (t: ReturnType<typeof setup>) =>
        Object.assign(t.state.sources.find((s) => s.id === 'page-x')!, {
          lastPageChangeAt: ago(10 * 60_000),
          lastPageChangePreviousCaptureAt: null,
        }),
    ],
    [
      'P8-04B2 a capture before a page change without the change',
      (t: ReturnType<typeof setup>) =>
        Object.assign(t.state.sources.find((s) => s.id === 'page-x')!, {
          lastPageChangeAt: null,
          lastPageChangePreviousCaptureAt: ago(10 * 60_000),
        }),
    ],
    [
      'P8-04B2 a page change time that is no date',
      (t: ReturnType<typeof setup>) =>
        Object.assign(t.state.sources.find((s) => s.id === 'page-x')!, {
          lastPageChangeAt: '2026-10-22',
          lastPageChangePreviousCaptureAt: ago(10 * 60_000),
        }),
    ],
  ])('%s fails the whole request closed', async (_name, tamper) => {
    expect(await refusal(planted(tamper))).toEqual(INTEGRITY);
  });
});

// P8-04B2: whether a page changed after the feed found it, from the page's
// last page change (P8-04B1) and this discovery's first sighting. The capture
// a change was found against must be at or after the first sighting; the
// change time alone proves nothing
describe('News Radar: changed since found (P8-04B2)', () => {
  const T = ago(5 * DAY);
  const MINUTE = 60_000;
  const rule = (
    firstSeenAt: Date,
    lastPageChangeAt: Date | null,
    lastPageChangePreviousCaptureAt: Date | null
  ) =>
    isContentStudioDiscoveryChangedSinceFound({
      firstSeenAt,
      lastPageChangeAt,
      lastPageChangePreviousCaptureAt,
    });
  // the source's stored last page change, as P8-04B1 keeps it
  const changed = (
    at: Date,
    previousCaptureAt: Date,
    kind = 'content_changed'
  ) => ({
    latestVersionNumber: 2,
    lastPageChangeAt: at,
    lastPageChangeVersionNumber: 2,
    lastPageChangeKind: kind,
    lastPageChangePreviousCaptureAt: previousCaptureAt,
  });
  const signal = (result: {
    results: Array<{
      id: string;
      changedSinceFound: boolean;
      source: { lastPageChangeAt: Date | null };
    }>;
  }) =>
    result.results.map((d) => [
      d.id,
      d.changedSinceFound,
      d.source.lastPageChangeAt,
    ]);

  it('R1-R7 the rule: both times set and the previous capture at or after the first sighting', () => {
    // R1 no page change
    expect(rule(T, null, null)).toBe(false);
    // R2/R3 half a page change is none (the read refuses it, see integrity)
    expect(rule(T, null, new Date(T.getTime() + MINUTE))).toBe(false);
    expect(rule(T, new Date(T.getTime() + 2 * MINUTE), null)).toBe(false);
    // R4 the capture before the change is older than the first sighting
    expect(
      rule(T, new Date(T.getTime() + MINUTE), new Date(T.getTime() - 1))
    ).toBe(false);
    // R5 at the very time of the first sighting
    expect(rule(T, new Date(T.getTime() + MINUTE), new Date(T.getTime()))).toBe(
      true
    );
    // R6 after it
    expect(
      rule(T, new Date(T.getTime() + 2 * MINUTE), new Date(T.getTime() + 1))
    ).toBe(true);
    // R7 a change after the first sighting, found against a capture before
    // it: not proven to be after it
    expect(
      rule(T, new Date(T.getTime() + DAY), new Date(T.getTime() - DAY))
    ).toBe(false);
  });

  it('R1/R2 a change after the first sighting shows, one before it does not, and no change is no signal', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const after = t.found(FEED_A, T, {}, changed(ago(DAY), ago(2 * DAY)));
    const before = t.found(
      FEED_A,
      ago(4 * DAY),
      {},
      changed(ago(6 * DAY), ago(7 * DAY))
    );
    const none = t.found(FEED_A, ago(3 * DAY));
    expect(signal(await t.radar())).toEqual([
      [none.id, false, null],
      [before.id, false, ago(6 * DAY)],
      [after.id, true, ago(DAY)],
    ]);
  });

  it('R3 an extraction-only capture after the first sighting is no page change, so no signal', async () => {
    // P8-04B1 keeps the last page change across another extraction version:
    // a page changed before the first sighting, then extracted again after it
    const t = setup();
    t.addFeed(FEED_A);
    const d = t.found(FEED_A, T, {}, changed(ago(6 * DAY), ago(7 * DAY)));
    t.state.sources.find(
      (s) => s.id === d.discoveredSourceId
    )!.latestVersionNumber = 3;
    expect(signal(await t.radar())).toEqual([[d.id, false, ago(6 * DAY)]]);
  });

  it('R4 a title-only change after the first sighting shows', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const d = t.found(
      FEED_A,
      T,
      {},
      changed(ago(DAY), ago(2 * DAY), 'title_changed')
    );
    expect(signal(await t.radar())).toEqual([[d.id, true, ago(DAY)]]);
  });

  it('R5 the same page found by two feeds at different times: changed for one, not for the other', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(FEED_B);
    const page = {
      id: 'shared-page',
      ...changed(ago(2 * DAY), ago(3 * DAY)),
    };
    const a = t.found(FEED_A, ago(4 * DAY), {}, page);
    const b = t.found(FEED_B, ago(2 * DAY + HOUR), {}, page);
    expect(signal(await t.radar())).toEqual([
      [b.id, false, ago(2 * DAY)],
      [a.id, true, ago(2 * DAY)],
    ]);
    // a later change (EX5) is after both first sightings
    Object.assign(
      t.state.sources.find((s) => s.id === 'shared-page')!,
      changed(ago(HOUR), ago(DAY))
    );
    expect(signal(await t.radar())).toEqual([
      [b.id, true, ago(HOUR)],
      [a.id, true, ago(HOUR)],
    ]);
  });

  it('R6 an archived page that changed is both archived and changed', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const d = t.found(
      FEED_A,
      T,
      {},
      { archivedAt: ago(HOUR), ...changed(ago(DAY), ago(2 * DAY)) }
    );
    const [row] = (await t.radar()).results;
    expect([row.id, row.source.archivedAt, row.changedSinceFound]).toEqual([
      d.id,
      ago(HOUR),
      true,
    ]);
  });

  it('R7 the signal adds no query: one list and one count, and no page or version lookup', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    for (let i = 0; i < 50; i++) {
      t.found(FEED_A, ago(HOUR + i), {}, changed(ago(i), ago(HOUR)));
    }
    const result = await t.radar();
    expect(result.results.every((d) => d.changedSinceFound)).toBe(true);
    expect(t.discovery.findMany).toHaveBeenCalledTimes(1);
    expect(t.discovery.count).toHaveBeenCalledTimes(1);
    expect(t.source.findFirst).not.toHaveBeenCalled();
    expect(t.source.findMany).not.toHaveBeenCalled();
    expect(t.version.findFirst).not.toHaveBeenCalled();
    expect(t.version.findMany).not.toHaveBeenCalled();
    // the two times are read with the page, in the one listing
    expect(
      t.discovery.findMany.mock.calls[0][0].select.discoveredSource.select
    ).toEqual({
      id: true,
      organizationId: true,
      kind: true,
      name: true,
      canonicalUrl: true,
      latestVersionNumber: true,
      archivedAt: true,
      lastPageChangeAt: true,
      lastPageChangePreviousCaptureAt: true,
    });
  });

  it('R8 a change found by the capture of the run that first listed a known page is no signal', async () => {
    // the feed lists the page at T; the same run captures it at T + 1 minute
    // and finds a change against its capture of 10 days ago
    const t = setup();
    t.addFeed(FEED_A);
    const d = t.found(
      FEED_A,
      T,
      {},
      changed(new Date(T.getTime() + MINUTE), ago(15 * DAY))
    );
    expect(signal(await t.radar())).toEqual([
      [d.id, false, new Date(T.getTime() + MINUTE)],
    ]);
  });

  it('R9 a change against a capture at the very time of the first sighting shows', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const d = t.found(
      FEED_A,
      T,
      {},
      changed(new Date(T.getTime() + HOUR), new Date(T.getTime()))
    );
    expect(signal(await t.radar())).toEqual([
      [d.id, true, new Date(T.getTime() + HOUR)],
    ]);
  });

  it('R10 a feed page answers with the same rule, per row', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    const after = t.found(FEED_A, T, {}, changed(ago(DAY), ago(2 * DAY)));
    const sameRun = t.found(
      FEED_A,
      ago(4 * DAY),
      {},
      changed(new Date(ago(4 * DAY).getTime() + MINUTE), ago(9 * DAY))
    );
    const equal = t.found(
      FEED_A,
      ago(3 * DAY),
      {},
      changed(ago(2 * DAY), ago(3 * DAY))
    );
    const feed = await t.service.listDiscoveries({
      organizationId: ORG,
      sourceId: FEED_A,
      page: 1,
    });
    const radar = await t.radar();
    expect(signal(feed)).toEqual(signal(radar));
    expect(signal(feed)).toEqual([
      [equal.id, true, ago(2 * DAY)],
      [sameRun.id, false, new Date(ago(4 * DAY).getTime() + MINUTE)],
      [after.id, true, ago(DAY)],
    ]);
  });

  it('never shows another organization’s page change', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(OTHER_FEED, { organizationId: OTHER_ORG });
    const marker = new Date('2001-02-03T04:05:06.000Z');
    t.found(
      OTHER_FEED,
      ago(HOUR),
      { organizationId: OTHER_ORG },
      {
        id: 'other-page',
        organizationId: OTHER_ORG,
        ...changed(marker, marker),
      }
    );
    const mine = t.found(FEED_A, ago(2 * HOUR));
    const result = await t.radar({ since: 'all' });
    expect(signal(result)).toEqual([[mine.id, false, null]]);
    expect(JSON.stringify(result)).not.toContain(marker.toISOString());
  });
});

describe('News Radar: read only, bounded, organization scoped', () => {
  it('P802-1 reads with one list, one count and at most one feed lookup, and writes nothing', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    for (let i = 0; i < 60; i++) {
      t.found(FEED_A, ago(HOUR + i));
    }
    await t.radar();
    await t.radar({
      feedSourceId: FEED_A,
      captureState: 'captured',
      since: '30d',
      page: 2,
    });
    expect(t.discovery.findMany).toHaveBeenCalledTimes(2);
    expect(t.discovery.count).toHaveBeenCalledTimes(2);
    expect(t.source.findFirst).toHaveBeenCalledTimes(1);
    for (const delegate of [t.source, t.discovery, t.version]) {
      for (const name of [
        'create',
        'update',
        'updateMany',
        'upsert',
        'delete',
        'deleteMany',
      ]) {
        expect(
          (delegate as Record<string, jest.Mock>)[name]
        ).not.toHaveBeenCalled();
      }
    }
    expect(t.transaction.$transaction).not.toHaveBeenCalled();
    // TEN: the list and the count name the organization and share one filter
    for (const i of [0, 1]) {
      const list = t.discovery.findMany.mock.calls[i][0].where;
      expect(list.organizationId).toBe(ORG);
      expect(t.discovery.count.mock.calls[i][0].where).toEqual(list);
    }
  });

  it('never lists another organization’s discoveries, even of the same page address', async () => {
    const t = setup();
    t.addFeed(FEED_A);
    t.addFeed(OTHER_FEED, { organizationId: OTHER_ORG });
    t.found(
      OTHER_FEED,
      ago(HOUR),
      { organizationId: OTHER_ORG },
      {
        id: 'other-page',
        organizationId: OTHER_ORG,
        canonicalUrl: 'https://news.example/same',
      }
    );
    const mine = t.found(
      FEED_A,
      ago(2 * HOUR),
      {},
      {
        canonicalUrl: 'https://news.example/same',
      }
    );
    const result = await t.radar({ since: 'all' });
    expect(ids(result)).toEqual([mine.id]);
    expect(result.total).toBe(1);
  });

  it('P802-1 the Radar code reaches no capture, fetch, AI or package path', () => {
    const read = (file: string) =>
      fs
        .readFileSync(path.join(__dirname, file), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '');
    const service = read('content-studio.source.service.ts');
    // up to the next method of its own: the comment that once ended it is
    // stripped above, so it would have run to the end of the file
    const method = service.slice(
      service.indexOf('async listOrganizationDiscoveries('),
      service.indexOf('private toPublicDiscovery(')
    );
    expect(method.length).toBeGreaterThan(500);
    expect(method).toContain('listDiscoveriesForOrganization(');
    expect(method).not.toContain('private toPublicDiscovery(');
    expect(method).not.toMatch(
      /recordDiscovery|markFeedCaptured|appendVersion|refresh|capture\(|safeFetch|fetch\(|AIConnection|AIExecution|AIUsage|AIOperation|Package|create|update|delete|upsert/i
    );
    const repository = read('content-studio.source-discovery.repository.ts');
    const radar = repository.slice(
      repository.indexOf('listDiscoveriesForOrganization(')
    );
    expect(radar).not.toMatch(/create|update|delete|upsert|\$transaction/);
  });
});
