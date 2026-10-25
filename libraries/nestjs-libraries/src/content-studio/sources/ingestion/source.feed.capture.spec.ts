import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  safeFetch,
  SafeFetchError,
  SafeFetchErrorCategory,
  SafeFetchResult,
} from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import {
  captureFailureDelayMinutes,
  ContentStudioSourceIngestionService,
  FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES,
  FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES,
  FEED_FETCH_ALLOWED_CONTENT_TYPES,
  FEED_FETCH_MAX_BYTES,
  FEED_FETCH_TIMEOUT_MS,
  FEED_SCAN_PAGE_SIZE,
  SOURCE_FETCH_ALLOWED_CONTENT_TYPES,
  SOURCE_FETCH_MAX_BYTES,
  SOURCE_FETCH_TIMEOUT_MS,
} from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { SOURCE_FEED_MAX_ENTRIES } from '@gitroom/nestjs-libraries/content-studio/sources/source.feed';
import {
  CONTENT_STUDIO_FEED_INTERVAL_DEFAULT_MINUTES,
  CONTENT_STUDIO_FEED_INTERVALS,
  CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS,
  contentStudioFeedIntervals,
  effectiveFeedIntervalMinutes,
  nextCaptureAfterSuccess,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

// Feed capture (P8-01) with no database and no network: the repositories are
// the real ones over in-memory Prisma delegates that keep the unique keys of
// the schema, and safeFetch is a mock (the SSRF tests hand the real one
// addresses it refuses before any connection)
const SAFE_FETCH = '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  ...jest.requireActual('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'),
  safeFetch: jest.fn(),
}));
const fetchMock = jest.mocked(safeFetch);
// The organization limits (P8-C1), set by each test: by default far from
// every limit and with no refresh cooldown, so captures may follow each other
// at once; the limit tests set them
const NO_LIMITS = {
  activeFeedsMax: 1000,
  urlSourcesMax: 1000,
  manualRefreshCooldownMs: 0,
};
const mockLimits = { ...NO_LIMITS };
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/sources/source.types',
  () => ({
    ...jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/sources/source.types'
    ),
    contentStudioSourceLimits: jest.fn(() => ({ ...mockLimits })),
  })
);
const realSafeFetch = (
  jest.requireActual(SAFE_FETCH) as { safeFetch: typeof safeFetch }
).safeFetch;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const FEED = '33333333-3333-4333-8333-333333333333';
const FEED_B = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const CREATOR = '66666666-6666-4666-8666-666666666666';
const FEED_URL = 'https://news.example/rss.xml';
const FEED_B_URL = 'https://other.example/atom.xml';
const MARKER = 'FEED_CAPTURE_PRIVATE_MARKER_789';
const page = (n: number | string) => `https://news.example/story-${n}`;

const bytes = (text: string) => new TextEncoder().encode(text);
const rss = (links: Array<string | null>, extra = '') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i} ${extra}</title>${
          link === null ? '' : `<link>${link}</link>`
        }<guid>g-${i}</guid><pubDate>Tue, 20 Oct 2026 0${
          i % 10
        }:00:00 GMT</pubDate></item>`
    )
    .join('')}</channel></rss>`;
const html = (text: string, title = 'Article') =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><p>${text}</p></main></body></html>`;

const answer = (
  url: string,
  body: string,
  contentType: string,
  over: Partial<SafeFetchResult> = {}
): SafeFetchResult => ({
  requestedUrl: url,
  finalUrl: url,
  redirects: [],
  status: 200,
  headers: { contentType },
  body: bytes(body),
  bytesRead: bytes(body).byteLength,
  ...over,
});

// The web: a feed body per feed URL, a page body per page URL; anything else
// is a failed fetch. Changing a page between captures is changing `pages`
const web = () => {
  const feeds = new Map<string, string>();
  const pages = new Map<string, string>();
  const failing = new Set<string>();
  fetchMock.mockImplementation(async (url: string) => {
    if (failing.has(url)) {
      throw new SafeFetchError('HTTP_STATUS', { statusCode: 503 });
    }
    if (feeds.has(url)) {
      return answer(url, feeds.get(url)!, 'application/rss+xml');
    }
    if (pages.has(url)) {
      return answer(url, pages.get(url)!, 'text/html; charset=utf-8');
    }
    throw new SafeFetchError('HTTP_STATUS', { statusCode: 404 });
  });
  return { feeds, pages, failing };
};

// --- an in-memory Prisma with the unique keys of the schema ---
type Row = Record<string, any>;
const P2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
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
  const state = {
    sources: [] as Row[],
    versions: [] as Row[],
    discoveries: [] as Row[],
    attempts: [] as Row[],
    deletedOrgs: new Set<string>(),
  };
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 20, 10, 0, tick++));
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) {
        return true;
      }
      if (key === 'OR') {
        return (condition as Row[]).some((sub) => matches(row, sub));
      }
      if (key === 'organization') {
        return !state.deletedOrgs.has(row.organizationId);
      }
      if (condition === null) {
        return value(row, key) === null;
      }
      if (typeof condition === 'object' && !(condition instanceof Date)) {
        const c = condition as Row;
        if ('not' in c) {
          return value(row, key) !== c.not;
        }
        if ('lt' in c) {
          return value(row, key) !== null && compare(row[key], c.lt) < 0;
        }
        if ('lte' in c) {
          return value(row, key) !== null && compare(row[key], c.lte) <= 0;
        }
        if ('gt' in c) {
          return value(row, key) !== null && compare(row[key], c.gt) > 0;
        }
        if ('in' in c) {
          return (c.in as unknown[]).includes(row[key]);
        }
      }
      return condition instanceof Date
        ? row[key] instanceof Date && row[key].getTime() === condition.getTime()
        : row[key] === condition;
    });
  const tables = {
    sources: state.sources,
    versions: state.versions,
    discoveries: state.discoveries,
    attempts: state.attempts,
  };
  type Table = keyof typeof tables;
  const unique: Record<Table, (a: Row, b: Row) => boolean> = {
    sources: (a, b) =>
      a.id === b.id ||
      (a.organizationId === b.organizationId &&
        a.canonicalUrl === b.canonicalUrl),
    versions: (a, b) =>
      a.id === b.id ||
      (a.sourceId === b.sourceId && a.versionNumber === b.versionNumber),
    discoveries: (a, b) =>
      a.organizationId === b.organizationId &&
      a.feedSourceId === b.feedSourceId &&
      a.discoveredSourceId === b.discoveredSourceId,
    attempts: (a, b) => a.id === b.id,
  };
  const pick = (table: Table, row: Row, select?: Row): Row => {
    if (!select) {
      return { ...row };
    }
    return Object.fromEntries(
      Object.entries(select).map(([key, sub]) => {
        if (table === 'discoveries' && key === 'discoveredSource') {
          const target = state.sources.find(
            (s) =>
              s.id === row.discoveredSourceId &&
              s.organizationId === row.organizationId
          );
          return [
            key,
            target ? pick('sources', target, (sub as Row).select) : null,
          ];
        }
        return [key, value(row, key)];
      })
    );
  };
  const order = (rows: Row[], orderBy: unknown) => {
    const rules = (
      Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
    ) as Row[];
    return [...rows].sort((a, b) => {
      for (const rule of rules) {
        const [key, how] = Object.entries(rule)[0];
        // { sort, nulls }: a missing value goes first or last, either way
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
  };
  const hooks: Partial<Record<Table, { beforeCreate?: (data: Row) => void }>> =
    {};
  const delegate = (table: Table) => ({
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = tables[table].find((r) => matches(r, args.where));
      return row ? pick(table, row, args.select) : null;
    }),
    findMany: jest.fn(
      async (args: {
        where: Row;
        select?: Row;
        orderBy?: unknown;
        skip?: number;
        take?: number;
      }) =>
        order(
          tables[table].filter((r) => matches(r, args.where)),
          args.orderBy
        )
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? Infinity))
          .map((r) => pick(table, r, args.select))
    ),
    count: jest.fn(
      async (args: { where: Row }) =>
        tables[table].filter((r) => matches(r, args.where)).length
    ),
    create: jest.fn(async (args: { data: Row; select?: Row }) => {
      hooks[table]?.beforeCreate?.(args.data);
      const at = now();
      const row: Row = {
        ...(table === 'discoveries'
          ? { id: `d-${tick}-${Math.random()}` }
          : {}),
        ...(table === 'sources' || table === 'versions'
          ? { createdAt: at }
          : {}),
        ...(table === 'sources'
          ? {
              updatedAt: at,
              archivedAt: null,
              lastCapturedAt: null,
              scanPausedAt: null,
              captureIntervalMinutes: null,
              nextCaptureAt: null,
              consecutiveCaptureFailures: 0,
            }
          : {}),
        ...args.data,
      };
      if (tables[table].some((r) => unique[table](r, row))) {
        throw P2002();
      }
      tables[table].push(row);
      return pick(table, row, args.select);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const rows = tables[table].filter((r) => matches(r, args.where));
      for (const row of rows) {
        for (const [key, data] of Object.entries(args.data)) {
          row[key] =
            data && typeof data === 'object' && 'increment' in (data as Row)
              ? row[key] + (data as Row).increment
              : data;
        }
        if (table === 'sources') {
          row.updatedAt = now();
        }
      }
      return { count: rows.length };
    }),
    update: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });
  const source = delegate('sources');
  const version = delegate('versions');
  const discovery = delegate('discoveries');
  const attempt = delegate('attempts');
  const tx = {
    contentStudioSource: source,
    contentStudioSourceVersion: version,
    contentStudioSourceCaptureAttempt: attempt,
  };
  const transaction = jest.fn(
    async (fn: (client: typeof tx) => unknown, options?: unknown) => fn(tx)
  );
  const repository = new ContentStudioSourceRepository(
    {
      model: { contentStudioSource: source },
    } as unknown as PrismaRepository<'contentStudioSource'>,
    {
      model: { contentStudioSourceVersion: version },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    {
      model: {
        $transaction: transaction,
      },
    } as unknown as PrismaTransaction
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository({
    model: { contentStudioSourceDiscovery: discovery },
  } as unknown as PrismaRepository<'contentStudioSourceDiscovery'>);
  const captureAttempts = new ContentStudioSourceCaptureAttemptRepository({
    model: { contentStudioSourceCaptureAttempt: attempt },
  } as unknown as PrismaRepository<'contentStudioSourceCaptureAttempt'>);
  const ingestion = new ContentStudioSourceIngestionService(
    repository,
    discoveries,
    captureAttempts
  );
  const service = new ContentStudioSourceService(
    repository,
    discoveries,
    captureAttempts
  );
  const addSource = (row: Row): Row => {
    const at = now();
    const full: Row = {
      kind: 'url',
      name: 'Source',
      latestVersionNumber: 0,
      archivedAt: null,
      createdById: CREATOR,
      createdAt: at,
      updatedAt: at,
      lastCapturedAt: null,
      scanPausedAt: null,
      captureIntervalMinutes: null,
      nextCaptureAt: null,
      consecutiveCaptureFailures: 0,
      ...row,
    };
    state.sources.push(full);
    return full;
  };
  const addFeed = (row: Row = {}) =>
    addSource({
      id: FEED,
      organizationId: ORG,
      kind: 'feed',
      name: 'News feed',
      canonicalUrl: FEED_URL,
      ...row,
    });
  return {
    state,
    hooks,
    transaction,
    repository,
    discoveries,
    ingestion,
    service,
    addSource,
    addFeed,
    source,
    version,
    discovery,
    attempt,
  };
};
type Setup = ReturnType<typeof setup>;

const capture = (
  t: Setup,
  over: { organizationId?: string; sourceId?: string; userId?: string } = {}
) =>
  t.ingestion.refreshSource({
    organizationId: ORG,
    userId: USER,
    sourceId: FEED,
    ...over,
  }) as unknown as Promise<{
    source: Record<string, unknown>;
    capture: Record<string, number>;
  }>;

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

const pagesOf = (t: Setup, organizationId = ORG) =>
  t.state.sources.filter(
    (s) => s.organizationId === organizationId && s.kind === 'url'
  );
const versionsOf = (t: Setup, sourceId: string) =>
  t.state.versions.filter((v) => v.sourceId === sourceId);
const sourceByUrl = (t: Setup, url: string, organizationId = ORG) =>
  t.state.sources.find(
    (s) => s.canonicalUrl === url && s.organizationId === organizationId
  )!;

beforeEach(() => {
  fetchMock.mockReset();
  Object.assign(mockLimits, NO_LIMITS);
});

// The schedule's own rules (P8-C4), without a feed
describe('feed schedule rules (P8-C4)', () => {
  it('U6 the presets, the default and the presets an organization may choose', () => {
    expect(CONTENT_STUDIO_FEED_INTERVALS).toEqual([60, 180, 360, 720, 1440]);
    expect(CONTENT_STUDIO_FEED_INTERVAL_DEFAULT_MINUTES).toBe(60);
    expect(contentStudioFeedIntervals(ORG)).toEqual([60, 180, 360, 720, 1440]);
  });

  it('U1-U4 the minutes of a feed: the default for null, a preset itself, nothing for anything else', () => {
    expect(effectiveFeedIntervalMinutes(null)).toBe(60);
    for (const minutes of [60, 180, 360, 720, 1440]) {
      expect(effectiveFeedIntervalMinutes(minutes)).toBe(minutes);
    }
    for (const stored of [0, -60, 59, 61, 90, 60.5, 2880, NaN]) {
      expect(effectiveFeedIntervalMinutes(stored)).toBeUndefined();
    }
  });

  it('U5 the next capture after a success: its own time plus the interval', () => {
    const at = new Date('2026-10-24T10:40:00.000Z');
    expect(nextCaptureAfterSuccess(at, 60)).toEqual(
      new Date('2026-10-24T11:40:00.000Z')
    );
    expect(nextCaptureAfterSuccess(at, 1440)).toEqual(
      new Date('2026-10-25T10:40:00.000Z')
    );
    // never the argument itself
    expect(at).toEqual(new Date('2026-10-24T10:40:00.000Z'));
  });

  it('B1-B7 the failure delay: an hour, doubled each time, a day at most', () => {
    expect(FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES).toBe(60);
    expect(FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES).toBe(1440);
    expect(
      [1, 2, 3, 4, 5, 6, 7, 8, 50, 2000].map(captureFailureDelayMinutes)
    ).toEqual([60, 120, 240, 480, 960, 1440, 1440, 1440, 1440, 1440]);
  });

  it('B8 no delay without a failure', () => {
    for (const failures of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => captureFailureDelayMinutes(failures)).toThrow(RangeError);
    }
  });
});

describe('feed capture: a manual capture', () => {
  it('FC1/DS1/DS2/DS3 RSS: each linked page becomes an ordinary url source with its first version and a discovery; the feed gets none', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2)]));
    w.pages.set(page(1), html('One'));
    w.pages.set(page(2), html('Two'));

    const result = await capture(t);
    expect(result.capture).toEqual({
      entriesSeen: 2,
      entriesIgnored: 0,
      entriesSkipped: 0,
      entriesAccepted: 2,
      sourcesCreated: 2,
      versionsCreated: 2,
      unchanged: 0,
      failed: 0,
      archived: 0,
      entriesLimited: 0,
    });
    // the feed: no version, its capture time recorded
    expect(versionsOf(t, FEED)).toEqual([]);
    expect(t.state.sources.find((s) => s.id === FEED)).toMatchObject({
      latestVersionNumber: 0,
      lastCapturedAt: expect.any(Date),
    });
    expect(result.source).toMatchObject({
      id: FEED,
      kind: 'feed',
      latestVersionNumber: 0,
      lastCapturedAt: expect.any(Date),
    });
    // the pages: ordinary url sources of the organization, by canonical URL,
    // named after their entry, created by the member who captured
    expect(
      pagesOf(t).map((s) => [
        s.kind,
        s.canonicalUrl,
        s.name,
        s.createdById,
        s.latestVersionNumber,
      ])
    ).toEqual([
      ['url', page(1), 'Story 0', USER, 1],
      ['url', page(2), 'Story 1', USER, 1],
    ]);
    for (const s of pagesOf(t)) {
      const [v] = versionsOf(t, s.id);
      expect(v).toMatchObject({
        organizationId: ORG,
        versionNumber: 1,
        requestedUrl: s.canonicalUrl,
        extractionVersion: 'content-studio-source-v2',
        createdById: USER,
      });
    }
    // the discoveries: this feed, these pages, first and last seen at once
    expect(t.state.discoveries).toHaveLength(2);
    for (const [i, d] of t.state.discoveries.entries()) {
      expect(d).toMatchObject({
        organizationId: ORG,
        feedSourceId: FEED,
        discoveredSourceId: sourceByUrl(t, page(i + 1)).id,
        entryId: `g-${i}`,
        entryTitle: `Story ${i}`,
        publishedAt: new Date(`2026-10-20T0${i}:00:00.000Z`),
      });
      expect(d.firstSeenAt).toEqual(d.lastSeenAt);
      expect(d.firstSeenAt).toEqual(t.state.sources[0].lastCapturedAt);
    }
  });

  it('FC2 Atom feeds are read the same way', async () => {
    const t = setup();
    t.addFeed({ canonicalUrl: FEED_B_URL });
    fetchMock.mockImplementation(async (url: string) =>
      url === FEED_B_URL
        ? answer(
            url,
            `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="${page(
              'atom'
            )}"/><id>urn:a</id><updated>2026-10-01T00:00:00Z</updated></entry></feed>`,
            'application/atom+xml'
          )
        : answer(url, html('Atom page'), 'text/html')
    );
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesAccepted: 1,
      sourcesCreated: 1,
      versionsCreated: 1,
    });
    expect(t.state.discoveries[0]).toMatchObject({
      entryId: 'urn:a',
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('FC3 fetches the stored feed URL and every page only through safeFetch, each with its fixed policy', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    await capture(t);
    expect(fetchMock.mock.calls).toEqual([
      [
        FEED_URL,
        {
          method: 'GET',
          allowedContentTypes: FEED_FETCH_ALLOWED_CONTENT_TYPES,
          maxBytes: FEED_FETCH_MAX_BYTES,
          timeoutMs: FEED_FETCH_TIMEOUT_MS,
        },
      ],
      [
        page(1),
        {
          method: 'GET',
          allowedContentTypes: SOURCE_FETCH_ALLOWED_CONTENT_TYPES,
          maxBytes: SOURCE_FETCH_MAX_BYTES,
          timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
        },
      ],
    ]);
    expect(FEED_FETCH_ALLOWED_CONTENT_TYPES.sort()).toEqual([
      'application/atom+xml',
      'application/rdf+xml',
      'application/rss+xml',
      'application/xml',
      'text/xml',
    ]);
    // bounded, below SafeFetch's own ceiling
    expect(FEED_FETCH_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(FEED_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it('FC5 a feed that is not XML or not a feed fails as a whole: 422, nothing stored, not marked captured', async () => {
    const t = setup();
    t.addFeed();
    for (const body of [
      `<rss version="2.0"><channel><item>${MARKER}</rss>`,
      `<html><body>${MARKER}</body></html>`,
      `<!DOCTYPE rss [<!ENTITY x "${MARKER}">]><rss version="2.0"><channel/></rss>`,
    ]) {
      fetchMock.mockResolvedValueOnce(answer(FEED_URL, body, 'text/xml'));
      const result = await refusal(capture(t));
      expect(result).toEqual({
        status: 422,
        body: {
          msg: 'The feed could not be read.',
          code: 'CS_SOURCE_FEED_INVALID',
        },
      });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
    expect(t.state.sources).toHaveLength(1);
    expect(t.state.versions).toEqual([]);
    expect(t.state.discoveries).toEqual([]);
    expect(t.state.sources[0].lastCapturedAt).toBeNull();
  });

  it('FC6 an unsupported type or charset is a 415, before anything is read', async () => {
    const t = setup();
    t.addFeed();
    fetchMock.mockRejectedValueOnce(
      new SafeFetchError('UNSUPPORTED_CONTENT_TYPE')
    );
    expect((await refusal(capture(t))).status).toBe(415);
    fetchMock.mockResolvedValueOnce(
      answer(FEED_URL, rss([page(1)]), 'text/xml; charset=utf-16')
    );
    expect((await refusal(capture(t))).body).toEqual({
      msg: 'The source content type is not supported.',
      code: 'CS_SOURCE_CONTENT_TYPE_UNSUPPORTED',
    });
    // a type SafeFetch let through that the feed reader does not read
    fetchMock.mockResolvedValueOnce(
      answer(FEED_URL, rss([page(1)]), 'text/html')
    );
    expect((await refusal(capture(t))).status).toBe(415);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(t.state.sources).toHaveLength(1);
  });

  it.each<[string, SafeFetchErrorCategory, number, string]>([
    [
      'FC8 a redirect to a private address',
      'BLOCKED_DESTINATION',
      400,
      'CS_SOURCE_FETCH_BLOCKED',
    ],
    [
      'FC8 an invalid redirect',
      'REDIRECT_INVALID',
      400,
      'CS_SOURCE_FETCH_BLOCKED',
    ],
    [
      'a downgrade to http',
      'DOWNGRADE_BLOCKED',
      400,
      'CS_SOURCE_FETCH_BLOCKED',
    ],
    ['FC9 an oversized feed', 'TOO_LARGE', 413, 'CS_SOURCE_FETCH_TOO_LARGE'],
    ['a slow feed', 'TIMEOUT', 504, 'CS_SOURCE_FETCH_TIMEOUT'],
    ['an unreachable feed', 'NETWORK', 502, 'CS_SOURCE_FETCH_FAILED'],
  ])(
    '%s fails the capture with a fixed answer and stores nothing',
    async (_name, category, status, code) => {
      const t = setup();
      t.addFeed();
      fetchMock.mockRejectedValueOnce(
        new SafeFetchError(category, { hostname: MARKER })
      );
      const result = await refusal(capture(t));
      expect(result.status).toBe(status);
      expect((result.body as { code: string }).code).toBe(code);
      expect(JSON.stringify(result)).not.toContain(MARKER);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(t.state.sources).toHaveLength(1);
      expect(t.state.discoveries).toEqual([]);
    }
  );

  it.each([
    ['FC7 loopback', 'https://127.0.0.1/rss'],
    ['FC7 the metadata service', 'https://169.254.169.254/feed'],
    ['FC7 a private network', 'https://10.0.0.1/feed.xml'],
    ['FC7 localhost', 'https://localhost/atom'],
    ['FC7 IPv6 loopback', 'https://[::1]/rss'],
    ['an http feed: https only', 'http://example.com/rss'],
  ])(
    '%s is refused by the real SafeFetch before any connection',
    async (_name, url) => {
      const t = setup();
      t.addFeed({ canonicalUrl: url });
      fetchMock.mockImplementation(realSafeFetch);
      expect(await refusal(capture(t))).toEqual({
        status: 400,
        body: {
          msg: 'The source URL cannot be fetched.',
          code: 'CS_SOURCE_FETCH_BLOCKED',
        },
      });
      expect(t.state.sources).toHaveLength(1);
      expect(t.state.discoveries).toEqual([]);
    }
  );

  it('a page link to a private address is a counted page failure: the real SafeFetch refuses it, the feed capture stands', async () => {
    const t = setup();
    t.addFeed();
    const feed = rss([
      page(1),
      'https://127.0.0.1/admin',
      'https://169.254.169.254/x',
    ]);
    fetchMock.mockImplementation(async (url: string, options) =>
      url === FEED_URL
        ? answer(url, feed, 'application/rss+xml')
        : url === page(1)
        ? answer(url, html('One'), 'text/html')
        : realSafeFetch(url, options)
    );
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesAccepted: 3,
      sourcesCreated: 3,
      versionsCreated: 1,
      failed: 2,
    });
    expect(versionsOf(t, sourceByUrl(t, 'https://127.0.0.1/admin').id)).toEqual(
      []
    );
  });

  it('a feed answer that does not start at the stored URL is a failed fetch: nothing is read', async () => {
    const t = setup();
    t.addFeed();
    fetchMock.mockResolvedValueOnce(
      answer(FEED_URL, rss([page(1)]), 'application/rss+xml', {
        redirects: [{ url: 'https://elsewhere.example/', status: 302 }],
      })
    );
    expect((await refusal(capture(t))).body).toEqual({
      msg: 'The source could not be fetched.',
      code: 'CS_SOURCE_FETCH_FAILED',
    });
    expect(t.state.sources).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a redirected page keeps its source: the version records the final URL', async () => {
    const t = setup();
    t.addFeed();
    fetchMock.mockImplementation(async (url: string) =>
      url === FEED_URL
        ? answer(url, rss([page('old')]), 'application/rss+xml')
        : answer(url, html('Moved'), 'text/html', {
            finalUrl: page('new'),
            redirects: [{ url, status: 301 }],
          })
    );
    await capture(t);
    expect(pagesOf(t).map((s) => s.canonicalUrl)).toEqual([page('old')]);
    expect(t.state.versions[0]).toMatchObject({
      requestedUrl: page('old'),
      finalUrl: page('new'),
      redirectCount: 1,
    });
    expect(t.state.discoveries[0].discoveredSourceId).toBe(
      sourceByUrl(t, page('old')).id
    );
  });
});

describe('feed capture: dedup and repeated captures', () => {
  it('DS4/DS5/DS6/DS7/DS9/M10 a repeated capture of unchanged pages adds no source, discovery or version; lastSeenAt moves, firstSeenAt stays', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2)]));
    w.pages.set(page(1), html('One'));
    w.pages.set(page(2), html('Two'));
    await capture(t);
    const first = t.state.discoveries.map((d) => ({ ...d }));

    const again = await capture(t);
    expect(again.capture).toMatchObject({
      entriesAccepted: 2,
      sourcesCreated: 0,
      versionsCreated: 0,
      unchanged: 2,
      failed: 0,
    });
    expect(pagesOf(t)).toHaveLength(2);
    expect(t.state.versions).toHaveLength(2);
    expect(t.state.discoveries).toHaveLength(2);
    for (const [i, d] of t.state.discoveries.entries()) {
      expect(d.firstSeenAt).toEqual(first[i].firstSeenAt);
      expect(d.lastSeenAt.getTime()).toBeGreaterThan(
        first[i].lastSeenAt.getTime()
      );
    }

    // one page changes: exactly one next version, of that page
    w.pages.set(page(2), html('Two, updated'));
    const changed = await capture(t);
    expect(changed.capture).toMatchObject({
      versionsCreated: 1,
      unchanged: 1,
    });
    expect(
      versionsOf(t, sourceByUrl(t, page(2)).id).map((v) => v.versionNumber)
    ).toEqual([1, 2]);
    expect(versionsOf(t, sourceByUrl(t, page(1)).id)).toHaveLength(1);
    // a title change alone is a change
    w.pages.set(page(1), html('One', 'Retitled'));
    expect((await capture(t)).capture.versionsCreated).toBe(1);
  });

  it('P804A-8/M31 a page captured by another extraction version is captured again; the same capture with other bytes or redirects is not', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    await capture(t);
    const id = sourceByUrl(t, page(1)).id;
    // other bytes with the same blocks and title: the same capture
    w.pages.set(page(1), html('One') + '<!-- build 42 -->');
    expect((await capture(t)).capture).toMatchObject({
      versionsCreated: 0,
      unchanged: 1,
    });
    // the stored version was made by an earlier extractor
    versionsOf(t, id)[0].extractionVersion = 'content-studio-source-v1';
    expect((await capture(t)).capture).toMatchObject({
      versionsCreated: 1,
      unchanged: 0,
    });
    expect(versionsOf(t, id).map((v) => v.extractionVersion)).toEqual([
      'content-studio-source-v1',
      'content-studio-source-v2',
    ]);
    // the same capture again: nothing new
    expect((await capture(t)).capture.versionsCreated).toBe(0);
  });

  it("P804B1 W11/W12 a feed capture keeps a page's last page change, skips a repeat without one, and never gives the feed one", async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    await capture(t);
    const id = sourceByUrl(t, page(1)).id;
    const state = () => {
      const row = t.state.sources.find((s) => s.id === id)!;
      return [
        row.lastPageChangeAt ?? null,
        row.lastPageChangeVersionNumber ?? null,
        row.lastPageChangeKind ?? null,
        row.lastPageChangePreviousCaptureAt ?? null,
      ];
    };
    // a first capture is no change
    expect(state()).toEqual([null, null, null, null]);
    // W12 the same capture: no version, nothing written
    expect((await capture(t)).capture.unchanged).toBe(1);
    expect(state()).toEqual([null, null, null, null]);
    // a title change is a page change
    w.pages.set(page(1), html('One', 'Retitled'));
    await capture(t);
    const [v1, v2] = versionsOf(t, id);
    expect(state()).toEqual([v2.fetchedAt, 2, 'title_changed', v1.fetchedAt]);
    // another extraction version: a version, never a page change
    versionsOf(t, id)[1].extractionVersion = 'content-studio-source-v1';
    expect((await capture(t)).capture.versionsCreated).toBe(1);
    expect(state()).toEqual([v2.fetchedAt, 2, 'title_changed', v1.fetchedAt]);
    // the blocks change: the page change moves on
    w.pages.set(page(1), html('Two', 'Retitled'));
    await capture(t);
    const [, , v3, v4] = versionsOf(t, id);
    expect(state()).toEqual([v4.fetchedAt, 4, 'content_changed', v3.fetchedAt]);
    // W11 the feed itself never has one
    const feed = t.state.sources.find((s) => s.id === FEED)!;
    expect(
      Object.keys(feed).filter((key) => /lastPageChange/.test(key))
    ).toEqual([]);
  });

  it('DS8 the same page in two feeds is one source with one discovery per feed', async () => {
    const t = setup();
    t.addFeed();
    t.addFeed({ id: FEED_B, canonicalUrl: FEED_B_URL, name: 'Other feed' });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2)]));
    w.feeds.set(FEED_B_URL, rss([page(2), page(3)]));
    for (const n of [1, 2, 3]) {
      w.pages.set(page(n), html(`Page ${n}`));
    }
    await capture(t);
    const b = await capture(t, { sourceId: FEED_B });
    expect(b.capture).toMatchObject({
      sourcesCreated: 1,
      unchanged: 1,
      versionsCreated: 1,
    });
    expect(
      pagesOf(t)
        .map((s) => s.canonicalUrl)
        .sort()
    ).toEqual([page(1), page(2), page(3)].sort());
    const shared = sourceByUrl(t, page(2)).id;
    expect(
      t.state.discoveries
        .filter((d) => d.discoveredSourceId === shared)
        .map((d) => d.feedSourceId)
        .sort()
    ).toEqual([FEED, FEED_B].sort());
    expect(versionsOf(t, shared)).toHaveLength(1);
  });

  it('M7 a page the organization already tracks is that source: never a second one, its name kept', async () => {
    const t = setup();
    t.addFeed();
    const existing = t.addSource({
      id: '77777777-7777-4777-8777-777777777777',
      organizationId: ORG,
      canonicalUrl: page(1),
      name: 'Curated name',
    });
    const w = web();
    w.feeds.set(FEED_URL, rss([`${page(1)}#comments`]));
    w.pages.set(page(1), html('One'));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      sourcesCreated: 0,
      versionsCreated: 1,
    });
    expect(pagesOf(t)).toEqual([
      expect.objectContaining({ id: existing.id, name: 'Curated name' }),
    ]);
    expect(t.state.discoveries[0].discoveredSourceId).toBe(existing.id);
  });

  it('M15/53 a page source created at the same moment by another capture is used, never duplicated', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    // another capture creates the source between this one's lookup and create
    let raced = false;
    t.hooks.sources = {
      beforeCreate: (data) => {
        if (!raced && data.canonicalUrl === page(1)) {
          raced = true;
          t.addSource({
            id: '88888888-8888-4888-8888-888888888888',
            organizationId: ORG,
            canonicalUrl: page(1),
            name: 'Raced',
          });
        }
      },
    };
    const result = await capture(t);
    expect(raced).toBe(true);
    expect(pagesOf(t)).toHaveLength(1);
    expect(result.capture).toMatchObject({
      sourcesCreated: 0,
      versionsCreated: 1,
    });
    expect(t.state.discoveries[0].discoveredSourceId).toBe(
      '88888888-8888-4888-8888-888888888888'
    );
  });

  it('M16/54 a discovery created at the same moment by another capture becomes a sighting', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    let raced = false;
    t.hooks.discoveries = {
      beforeCreate: (data) => {
        if (!raced) {
          raced = true;
          t.state.discoveries.push({
            ...data,
            id: 'raced',
            firstSeenAt: new Date('2026-01-01T00:00:00Z'),
            lastSeenAt: new Date('2026-01-01T00:00:00Z'),
          });
        }
      },
    };
    await capture(t);
    expect(t.state.discoveries).toHaveLength(1);
    expect(t.state.discoveries[0]).toMatchObject({
      id: 'raced',
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt,
    });
  });

  it('lastSeenAt never moves back: an older sighting after a newer one changes nothing', async () => {
    const t = setup();
    t.addFeed();
    const pageRow = t.addSource({
      id: '99999999-9999-4999-8999-999999999999',
      organizationId: ORG,
      canonicalUrl: page(1),
    });
    const at = (iso: string) => new Date(iso);
    const record = (seenAt: Date, entryTitle: string) =>
      t.discoveries.recordDiscovery({
        organizationId: ORG,
        feedSourceId: FEED,
        discoveredSourceId: pageRow.id,
        entryId: null,
        entryTitle,
        publishedAt: null,
        seenAt,
      });
    expect(await record(at('2026-10-20T10:00:00Z'), 'First')).toBe('created');
    expect(await record(at('2026-10-20T12:00:00Z'), 'Newer')).toBe('seen');
    expect(await record(at('2026-10-20T11:00:00Z'), 'Older')).toBe('seen');
    expect(t.state.discoveries).toEqual([
      expect.objectContaining({
        firstSeenAt: at('2026-10-20T10:00:00Z'),
        lastSeenAt: at('2026-10-20T12:00:00Z'),
        entryTitle: 'Newer',
      }),
    ]);
  });

  it('M11 versions are written by the compare-and-swap only: a page changed meanwhile by another capture is that capture', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    await capture(t);
    w.pages.set(page(1), html('Changed'));
    // another capture appends version 2 while this one fetches
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options) => {
      const result = await original(url, options);
      if (url === page(1)) {
        const row = sourceByUrl(t, page(1));
        row.latestVersionNumber = 2;
        t.state.versions.push({
          ...t.state.versions[0],
          id: 'other',
          versionNumber: 2,
        });
      }
      return result;
    });
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      versionsCreated: 0,
      unchanged: 1,
      failed: 0,
    });
    expect(
      versionsOf(t, sourceByUrl(t, page(1)).id).map((v) => v.versionNumber)
    ).toEqual([1, 2]);
  });
});

describe('feed capture: entries and partial failures', () => {
  it('EN3/EN4/EN6/M5/M6 skips entries without an https page link, guid-only ones too: nothing made for them', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(
      FEED_URL,
      `<rss version="2.0"><channel><item><title>No link</title><guid isPermaLink="true">${page(
        'guid'
      )}</guid></item><item><link>javascript:alert(1)</link></item><item><link>/relative</link></item><item><link>${page(
        1
      )}</link></item></channel></rss>`
    );
    w.pages.set(page(1), html('One'));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesSeen: 4,
      entriesSkipped: 3,
      entriesAccepted: 1,
    });
    expect(pagesOf(t).map((s) => s.canonicalUrl)).toEqual([page(1)]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      FEED_URL,
      page(1),
    ]);
  });

  it('an entry naming the address of a feed source is no page: skipped, nothing recorded', async () => {
    const t = setup();
    t.addFeed();
    t.addFeed({
      id: FEED_B,
      canonicalUrl: page('feed'),
      name: 'Feed at a page address',
    });
    const w = web();
    w.feeds.set(FEED_URL, rss([page('feed'), FEED_URL]));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesSkipped: 2,
      entriesAccepted: 0,
    });
    expect(t.state.discoveries).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AF1/AF2/AF3/AF4 a page that cannot be captured is counted; the others are kept; a later capture succeeds', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2), page(3)]));
    w.pages.set(page(1), html('One'));
    w.pages.set(page(3), html('Three'));
    w.failing.add(page(2));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesAccepted: 3,
      sourcesCreated: 3,
      versionsCreated: 2,
      failed: 1,
    });
    const failed = sourceByUrl(t, page(2));
    // the source and its discovery are kept, without a version
    expect(failed.latestVersionNumber).toBe(0);
    expect(versionsOf(t, failed.id)).toEqual([]);
    expect(t.state.discoveries).toHaveLength(3);
    expect(
      t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt
    ).not.toBeNull();

    w.failing.delete(page(2));
    w.pages.set(page(2), html('Two'));
    const retry = await capture(t);
    expect(retry.capture).toMatchObject({
      versionsCreated: 1,
      unchanged: 2,
      failed: 0,
      sourcesCreated: 0,
    });
    expect(versionsOf(t, failed.id)).toHaveLength(1);
  });

  it('a page that is not text or HTML fails alone', async () => {
    const t = setup();
    t.addFeed();
    fetchMock.mockImplementation(async (url: string) =>
      url === FEED_URL
        ? answer(url, rss([page(1), page(2)]), 'application/rss+xml')
        : url === page(1)
        ? answer(url, '%PDF', 'application/pdf')
        : answer(url, html('Two'), 'text/html')
    );
    expect((await capture(t)).capture).toMatchObject({
      versionsCreated: 1,
      failed: 1,
    });
  });

  it('an archived page source is recorded as seen and never captured', async () => {
    const t = setup();
    t.addFeed();
    t.addSource({
      id: '77777777-7777-4777-8777-777777777777',
      organizationId: ORG,
      canonicalUrl: page(1),
      archivedAt: new Date(),
    });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesAccepted: 1,
      archived: 1,
      versionsCreated: 0,
    });
    expect(t.state.discoveries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a database failure is no page failure: the capture fails and is not marked done', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    t.discovery.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(capture(t)).rejects.toThrow('db down');
    expect(
      t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt
    ).toBeNull();
  });

  it('FL1/FL2/FL3 captures the first entries of the feed in its order only: the rest makes nothing', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    const links = Array.from({ length: SOURCE_FEED_MAX_ENTRIES + 5 }, (_, i) =>
      page(i)
    );
    w.feeds.set(FEED_URL, rss(links));
    for (const link of links) {
      w.pages.set(link, html(link));
    }
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesSeen: SOURCE_FEED_MAX_ENTRIES + 5,
      entriesIgnored: 5,
      entriesAccepted: SOURCE_FEED_MAX_ENTRIES,
    });
    expect(
      pagesOf(t)
        .map((s) => s.canonicalUrl)
        .sort()
    ).toEqual(links.slice(0, SOURCE_FEED_MAX_ENTRIES).sort());
    expect(fetchMock).toHaveBeenCalledTimes(SOURCE_FEED_MAX_ENTRIES + 1);
    for (const link of links.slice(SOURCE_FEED_MAX_ENTRIES)) {
      expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(link);
    }
  });

  it('117 captures at most five pages at a time', async () => {
    const t = setup();
    t.addFeed();
    const links = Array.from({ length: 12 }, (_, i) => page(i));
    let running = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FEED_URL) {
        return answer(url, rss(links), 'application/rss+xml');
      }
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return answer(url, html(url), 'text/html');
    });
    expect((await capture(t)).capture.versionsCreated).toBe(12);
    expect(peak).toBe(5);
  });
});

describe('feed capture: organization limits (P8-C1)', () => {
  afterEach(() => jest.restoreAllMocks());
  const PAGE_ID = '77777777-7777-4777-8777-777777777777';
  const OTHER_PAGE_ID = '88888888-8888-4888-8888-888888888888';
  const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => url);

  it('SC5-SC11/M8-M13 at the page limit an existing page is recorded and captured; a new one is only counted, and the next entries go on', async () => {
    const t = setup();
    t.addFeed();
    t.addSource({ id: PAGE_ID, organizationId: ORG, canonicalUrl: page(2) });
    mockLimits.urlSourcesMax = 1;
    const w = web();
    // new, existing, new, the address of another feed
    w.feeds.set(FEED_URL, rss([page(1), page(2), page(3), FEED_B_URL]));
    t.addSource({
      id: FEED_B,
      organizationId: ORG,
      kind: 'feed',
      canonicalUrl: FEED_B_URL,
    });
    for (const n of [1, 2, 3]) {
      w.pages.set(page(n), html(`Page ${n}`));
    }
    const result = await capture(t);
    expect(result.capture).toEqual({
      entriesSeen: 4,
      entriesIgnored: 0,
      // a feed address is no page, whatever the limits
      entriesSkipped: 1,
      entriesAccepted: 1,
      sourcesCreated: 0,
      versionsCreated: 1,
      unchanged: 0,
      // a limit is never a failure
      failed: 0,
      archived: 0,
      entriesLimited: 2,
    });
    // no source and no discovery for the new pages, and no fetch of them
    expect(pagesOf(t).map((s) => s.id)).toEqual([PAGE_ID]);
    expect(t.state.discoveries.map((d) => d.discoveredSourceId)).toEqual([
      PAGE_ID,
    ]);
    expect(fetchedUrls().sort()).toEqual([FEED_URL, page(2)].sort());
    expect(versionsOf(t, PAGE_ID)).toHaveLength(1);
    // the feed was captured: the limited pages are not retried at once
    expect(
      t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt
    ).toBeInstanceOf(Date);
    expect(result.source.lastCapturedAt).toBeInstanceOf(Date);
  });

  it("a feed's new pages are created together, in one serializable transaction: the first ones in the feed take the room left", async () => {
    const t = setup();
    t.addFeed();
    t.addSource({ id: PAGE_ID, organizationId: ORG, canonicalUrl: page(9) });
    mockLimits.urlSourcesMax = 3;
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(9), page(2), page(3)]));
    for (const n of [1, 2, 3, 9]) {
      w.pages.set(page(n), html(`Page ${n}`));
    }
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      sourcesCreated: 2,
      entriesLimited: 1,
    });
    expect(
      pagesOf(t)
        .map((s) => s.canonicalUrl)
        .sort()
    ).toEqual([page(1), page(2), page(9)].sort());
    const serializable = t.transaction.mock.calls.filter(([, options]) =>
      Boolean(options)
    );
    expect(serializable).toHaveLength(1);
    // again: page 3 is the only new one, still past the limit
    t.transaction.mockClear();
    expect((await capture(t)).capture.entriesLimited).toBe(1);
    expect(
      t.transaction.mock.calls.filter(([, options]) => Boolean(options))
    ).toHaveLength(1);
    // known pages only: no limited create at all
    w.feeds.set(FEED_URL, rss([page(1), page(9), page(2)]));
    t.transaction.mockClear();
    expect((await capture(t)).capture.entriesLimited).toBe(0);
    expect(
      t.transaction.mock.calls.filter(([, options]) => Boolean(options))
    ).toHaveLength(0);
  });

  it('SC12 a feed of new pages only, all past the limit, is still a capture', async () => {
    const t = setup();
    t.addFeed();
    mockLimits.urlSourcesMax = 0;
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2), page(3)]));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesAccepted: 0,
      sourcesCreated: 0,
      failed: 0,
      entriesLimited: 3,
    });
    expect(pagesOf(t)).toEqual([]);
    expect(t.state.discoveries).toEqual([]);
    expect(fetchedUrls()).toEqual([FEED_URL]);
    expect(
      t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt
    ).toBeInstanceOf(Date);
  });

  it('SC6/SC13 the limit counts the pages of the feed organization only, archived ones included', async () => {
    const t = setup();
    t.addFeed();
    t.addFeed({ id: FEED_B, organizationId: OTHER_ORG });
    t.addSource({
      id: PAGE_ID,
      organizationId: ORG,
      canonicalUrl: page('archived'),
      archivedAt: new Date(),
    });
    mockLimits.urlSourcesMax = 1;
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    // the archived page takes the one place
    expect((await capture(t)).capture.entriesLimited).toBe(1);
    // another organization at none of its own creates the page
    expect(
      (await capture(t, { organizationId: OTHER_ORG, sourceId: FEED_B }))
        .capture
    ).toMatchObject({ entriesLimited: 0, sourcesCreated: 1 });
    expect(pagesOf(t, OTHER_ORG).map((s) => s.canonicalUrl)).toEqual([page(1)]);
  });

  it('a page found inside the limited create, created meanwhile by another capture, is used at the limit: never limited', async () => {
    const t = setup();
    t.addFeed();
    t.addSource({ id: PAGE_ID, organizationId: ORG, canonicalUrl: page(1) });
    mockLimits.urlSourcesMax = 1;
    // the lookup before the create missed it
    jest
      .spyOn(t.repository, 'getSourceByCanonicalUrlForOrganization')
      .mockResolvedValueOnce(null);
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    expect((await capture(t)).capture).toMatchObject({
      entriesAccepted: 1,
      sourcesCreated: 0,
      versionsCreated: 1,
      entriesLimited: 0,
    });
    expect(t.state.discoveries[0].discoveredSourceId).toBe(PAGE_ID);
  });

  it('M17 a page whose create lost to another capture (unique key) is that capture, never limited', async () => {
    const t = setup();
    t.addFeed();
    mockLimits.urlSourcesMax = 1;
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    t.hooks.sources = {
      beforeCreate: (data) => {
        if (data.canonicalUrl === page(1)) {
          t.hooks.sources = {};
          t.addSource({
            id: OTHER_PAGE_ID,
            organizationId: ORG,
            canonicalUrl: page(1),
          });
        }
      },
    };
    expect((await capture(t)).capture).toMatchObject({
      entriesAccepted: 1,
      entriesLimited: 0,
      failed: 0,
    });
    expect(t.state.discoveries[0].discoveredSourceId).toBe(OTHER_PAGE_ID);
  });

  it('a page whose create lost every serializable attempt is a counted failure left for the next capture; the feed goes on', async () => {
    const t = setup();
    t.addFeed();
    t.addSource({ id: PAGE_ID, organizationId: ORG, canonicalUrl: page(2) });
    // every serializable transaction (a limited create) loses; the append
    // of a version is no such transaction
    const run = t.transaction.getMockImplementation()!;
    t.transaction.mockImplementation(async (fn, options) => {
      if (options) {
        throw new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: 'test',
        });
      }
      return run(fn);
    });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2)]));
    w.pages.set(page(1), html('One'));
    w.pages.set(page(2), html('Two'));
    const result = await capture(t);
    expect(result.capture).toMatchObject({
      entriesAccepted: 2,
      sourcesCreated: 0,
      versionsCreated: 1,
      failed: 1,
      entriesLimited: 0,
    });
    // page 1 has no source, so nothing was recorded or fetched for it; page
    // 2 was recorded and captured
    expect(pagesOf(t).map((s) => s.id)).toEqual([PAGE_ID]);
    expect(t.state.discoveries.map((d) => d.discoveredSourceId)).toEqual([
      PAGE_ID,
    ]);
    expect(fetchedUrls()).not.toContain(page(1));
    expect(
      t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt
    ).toBeInstanceOf(Date);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/P2034|conflict|Prisma/);
  });

  describe('a manual feed capture after the last one (refresh cooldown)', () => {
    const TOO_SOON = {
      msg: 'This source was captured a moment ago. Try again in a few minutes.',
      code: 'CS_SOURCE_REFRESH_TOO_SOON',
    };
    const captured = async () => {
      const t = setup();
      t.addFeed();
      const w = web();
      w.feeds.set(FEED_URL, rss([page(1)]));
      w.pages.set(page(1), html('One'));
      await capture(t);
      mockLimits.manualRefreshCooldownMs =
        CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS;
      fetchMock.mockClear();
      const last = (
        t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt as Date
      ).getTime();
      const at = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(ms);
      return { t, w, last, at };
    };

    it('RC6 a feed never read is captured at once', async () => {
      const t = setup();
      t.addFeed();
      mockLimits.manualRefreshCooldownMs =
        CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS;
      const w = web();
      w.feeds.set(FEED_URL, rss([]));
      await expect(capture(t)).resolves.toMatchObject({
        capture: { entriesSeen: 0 },
      });
    });

    it('RC8/RC9/M20 sooner than the cooldown after its last read is a 429 before the feed is fetched', async () => {
      const { t, last, at } = await captured();
      for (const elapsed of [
        0,
        CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS - 1,
      ]) {
        at(last + elapsed);
        expect(await refusal(capture(t))).toEqual({
          status: 429,
          body: TOO_SOON,
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        (
          t.state.sources.find((s) => s.id === FEED)!.lastCapturedAt as Date
        ).getTime()
      ).toBe(last);
    });

    it('RC7 exactly the cooldown after its last read, or later, captures it', async () => {
      const { t, last, at } = await captured();
      at(last + CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS);
      await expect(capture(t)).resolves.toMatchObject({
        capture: { entriesSeen: 1 },
      });
      expect(fetchMock.mock.calls[0][0]).toBe(FEED_URL);
    });

    it('RC11 an archived feed is still CS_SOURCE_ARCHIVED within the cooldown', async () => {
      const { t, last, at } = await captured();
      at(last + 1);
      t.state.sources.find((s) => s.id === FEED)!.archivedAt = new Date(last);
      expect(await refusal(capture(t))).toMatchObject({
        status: 409,
        body: { code: 'CS_SOURCE_ARCHIVED' },
      });
    });

    it('RC10/M24 the schedule never waits for it: a scheduled capture right after a manual one reads the feed and its pages', async () => {
      const { t, w, last, at } = await captured();
      at(last + 1);
      w.pages.set(page(1), html('One, changed'));
      await expect(
        t.ingestion.captureScheduledFeed({
          organizationId: ORG,
          sourceId: FEED,
          attemptId: randomUUID(),
          attemptCount: 1,
        })
      ).resolves.toMatchObject({
        status: 'captured',
        capture: { versionsCreated: 1 },
      });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        FEED_URL,
        page(1),
      ]);
      // and a feed capture of a page refreshed by hand a moment ago reads it
      const pageId = sourceByUrl(t, page(1)).id as string;
      w.pages.set(page(1), html('One, changed again'));
      fetchMock.mockClear();
      await expect(
        t.ingestion.captureScheduledFeed({
          organizationId: ORG,
          sourceId: FEED,
          attemptId: randomUUID(),
          attemptCount: 1,
        })
      ).resolves.toMatchObject({ capture: { versionsCreated: 1 } });
      expect(versionsOf(t, pageId)).toHaveLength(3);
    });
  });
});

describe('feed capture: kinds, lifecycle and tenancy', () => {
  it('SK1 a url source still refreshes as a page: one version, no feed reading', async () => {
    const t = setup();
    t.addSource({ id: FEED, organizationId: ORG, canonicalUrl: page(1) });
    fetchMock.mockResolvedValueOnce(answer(page(1), html('One'), 'text/html'));
    const result = (await t.ingestion.refreshSource({
      organizationId: ORG,
      userId: USER,
      sourceId: FEED,
    })) as { version: { versionNumber: number } };
    expect(result.version.versionNumber).toBe(1);
    expect(t.state.discoveries).toEqual([]);
    // a page refresh always appends, as before: equal content is a capture too
    fetchMock.mockResolvedValueOnce(answer(page(1), html('One'), 'text/html'));
    await t.ingestion.refreshSource({
      organizationId: ORG,
      userId: USER,
      sourceId: FEED,
    });
    expect(t.state.versions).toHaveLength(2);
  });

  it('SK3 a source of an unknown kind is never captured', async () => {
    const t = setup();
    t.addFeed({ kind: 'Feed' });
    expect((await refusal(capture(t))).body).toEqual({
      msg: 'This source type cannot be refreshed.',
      code: 'CS_SOURCE_KIND_UNSUPPORTED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('39 an archived feed is not captured, and archiving one leaves its pages alone', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    await capture(t);
    await t.service.archiveSource(ORG, FEED);
    expect((await refusal(capture(t))).status).toBe(409);
    expect(pagesOf(t)[0].archivedAt).toBeNull();
    expect(t.state.discoveries).toHaveLength(1);
    // restoring has no side effect: nothing is fetched
    fetchMock.mockClear();
    await t.service.restoreSource(ORG, FEED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TEN1/TEN3/TEN6/M12 another organization cannot capture the feed; pages dedup within an organization only', async () => {
    const t = setup();
    t.addFeed();
    // the same page in the other organization: never reused here
    t.addSource({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: OTHER_ORG,
      canonicalUrl: page(1),
      name: 'Theirs',
    });
    expect(
      (await refusal(capture(t, { organizationId: OTHER_ORG }))).status
    ).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    const result = await capture(t);
    expect(result.capture.sourcesCreated).toBe(1);
    const mine = sourceByUrl(t, page(1), ORG);
    expect(mine.organizationId).toBe(ORG);
    expect(mine.id).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(versionsOf(t, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toEqual([]);
    for (const d of t.state.discoveries) {
      expect(d.organizationId).toBe(ORG);
    }
    for (const v of t.state.versions) {
      expect(v.organizationId).toBe(ORG);
    }
  });

  it('answers 404 for a malformed id before any lookup', async () => {
    const t = setup();
    for (const id of ['x', `${FEED}x`, MARKER]) {
      expect((await refusal(capture(t, { sourceId: id }))).status).toBe(404);
    }
    expect(t.source.findFirst).not.toHaveBeenCalled();
  });
});

describe('feed capture: the schedule', () => {
  it("TM2/TM5 a scheduled capture takes ids only, reads the stored feed and runs the same capture in its creator's name", async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    const result = await t.ingestion.captureScheduledFeed({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: randomUUID(),
      attemptCount: 1,
    });
    expect(result).toEqual({
      status: 'captured',
      capture: expect.objectContaining({
        sourcesCreated: 1,
        versionsCreated: 1,
      }),
    });
    expect(fetchMock.mock.calls[0][0]).toBe(FEED_URL);
    expect(pagesOf(t)[0].createdById).toBe(CREATOR);
    expect(t.state.versions[0].createdById).toBe(CREATOR);
  });

  it('TM3/TM4/M14 skips, without fetching, a feed that is gone, archived, of another organization or not a feed', async () => {
    const t = setup();
    t.addFeed({ archivedAt: new Date() });
    t.addSource({ id: FEED_B, organizationId: ORG, canonicalUrl: page(1) });
    for (const input of [
      { organizationId: ORG, sourceId: FEED },
      { organizationId: ORG, sourceId: FEED_B },
      { organizationId: OTHER_ORG, sourceId: FEED },
      { organizationId: ORG, sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { organizationId: ORG, sourceId: 'not-an-id' },
    ]) {
      expect(
        await t.ingestion.captureScheduledFeed({
          ...input,
          attemptId: randomUUID(),
          attemptCount: 1,
        })
      ).toEqual({
        status: 'skipped',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refused scheduled capture is an error for the workflow, never a partial success', async () => {
    const t = setup();
    t.addFeed();
    fetchMock.mockResolvedValueOnce(answer(FEED_URL, '<nope', 'text/xml'));
    await expect(
      t.ingestion.captureScheduledFeed({
        organizationId: ORG,
        sourceId: FEED,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('P8C4-3 lists live feeds of live organizations whose next capture is due (or not set), in id pages', async () => {
    const t = setup();
    // P8-C4: the last capture alone decides nothing
    const recent = new Date(Date.now() - 60_000);
    const soon = new Date(Date.now() + 60_000);
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000001',
      lastCapturedAt: recent,
    });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000002',
      canonicalUrl: 'https://a.example/1',
      lastCapturedAt: recent,
      nextCaptureAt: recent,
    });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000003',
      canonicalUrl: 'https://a.example/2',
      lastCapturedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      nextCaptureAt: soon,
    });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000004',
      canonicalUrl: 'https://a.example/3',
      archivedAt: new Date(),
    });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000005',
      canonicalUrl: 'https://a.example/4',
      organizationId: OTHER_ORG,
    });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000006',
      canonicalUrl: 'https://a.example/5',
      organizationId: 'deleted-org',
    });
    t.state.deletedOrgs.add('deleted-org');
    t.addSource({
      id: '10000000-0000-4000-8000-000000000007',
      organizationId: ORG,
      canonicalUrl: 'https://a.example/page',
    });
    expect(await t.ingestion.listFeedsDueForCapture({ afterId: null })).toEqual(
      {
        feeds: [
          {
            organizationId: ORG,
            sourceId: '10000000-0000-4000-8000-000000000001',
          },
          {
            organizationId: ORG,
            sourceId: '10000000-0000-4000-8000-000000000002',
          },
          {
            organizationId: OTHER_ORG,
            sourceId: '10000000-0000-4000-8000-000000000005',
          },
        ],
        next: null,
      }
    );
    expect(
      (
        await t.ingestion.listFeedsDueForCapture({
          afterId: '10000000-0000-4000-8000-000000000002',
        })
      ).feeds.map((feed) => feed.sourceId)
    ).toEqual(['10000000-0000-4000-8000-000000000005']);
    // a malformed cursor starts from the beginning
    expect(
      (await t.ingestion.listFeedsDueForCapture({ afterId: MARKER })).feeds
    ).toHaveLength(3);
  });

  it('hands the next page cursor only when a page is full', async () => {
    const t = setup();
    for (let i = 0; i < FEED_SCAN_PAGE_SIZE + 1; i++) {
      const id = `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      t.addFeed({ id, canonicalUrl: `https://f.example/${i}` });
    }
    const first = await t.ingestion.listFeedsDueForCapture({ afterId: null });
    expect(first.feeds).toHaveLength(FEED_SCAN_PAGE_SIZE);
    expect(first.next).toBe(first.feeds[FEED_SCAN_PAGE_SIZE - 1].sourceId);
    const second = await t.ingestion.listFeedsDueForCapture({
      afterId: first.next,
    });
    expect(second).toEqual({ feeds: [expect.any(Object)], next: null });
  });
});

describe('feed capture: a paused feed (P8-C3)', () => {
  const PAUSED_AT = new Date('2026-10-20T08:00:00.000Z');
  // a time that has passed: due by it (P8-C4)
  const OLD = () => new Date(Date.now() - 60 * 60 * 1000);
  const due = async (t: Setup) =>
    (await t.ingestion.listFeedsDueForCapture({ afterId: null })).feeds.map(
      (feed) => feed.sourceId
    );
  const feedRow = (t: Setup) => t.state.sources.find((s) => s.id === FEED)!;

  it('P8C3PG8/M9 the scan never lists a paused feed; P8C3PG9 resumed, it is due by its next capture time again', async () => {
    const t = setup();
    t.addFeed({ nextCaptureAt: OLD(), scanPausedAt: PAUSED_AT });
    t.addFeed({
      id: FEED_B,
      canonicalUrl: FEED_B_URL,
      nextCaptureAt: OLD(),
    });
    expect(await due(t)).toEqual([FEED_B]);
    await t.service.resumeFeed(ORG, FEED);
    expect(await due(t)).toEqual([FEED, FEED_B]);
    // its next capture not yet due: not listed until that time (P8-C4)
    await t.service.pauseFeed(ORG, FEED);
    feedRow(t).nextCaptureAt = new Date(Date.now() + 60_000);
    await t.service.resumeFeed(ORG, FEED);
    expect(await due(t)).toEqual([FEED_B]);
  });

  it('MR5/M10-M13 a scheduled capture of a feed paused while it waited is skipped: nothing fetched, written or marked', async () => {
    const t = setup();
    const last = OLD();
    t.addFeed({ lastCapturedAt: last });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    // listed while it ran, paused before its capture started
    expect(await due(t)).toEqual([FEED]);
    await t.service.pauseFeed(ORG, FEED);
    const before = JSON.stringify(t.state);
    t.source.updateMany.mockClear();
    expect(
      await t.ingestion.captureScheduledFeed({
        organizationId: ORG,
        sourceId: FEED,
        attemptId: randomUUID(),
        attemptCount: 1,
      })
    ).toEqual({ status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.source.updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(t.state)).toBe(before);
    expect(feedRow(t).lastCapturedAt).toBe(last);
    // the same read as before: one query for the feed
    expect(t.source.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: FEED,
        organizationId: ORG,
        organization: { deletedAt: null },
      },
      select: expect.objectContaining({ scanPausedAt: true, archivedAt: true }),
    });
  });

  it('MR1/MR3/M16/M17 a member may refresh a paused feed: it is captured and marked, and stays paused', async () => {
    const t = setup();
    t.addFeed({ scanPausedAt: PAUSED_AT });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    const result = await capture(t);
    expect(result.capture.sourcesCreated).toBe(1);
    expect(result.source.scanPausedAt).toEqual(PAUSED_AT);
    expect(result.source.lastCapturedAt).toEqual(expect.any(Date));
    expect(feedRow(t).scanPausedAt).toEqual(PAUSED_AT);
    expect(feedRow(t).lastCapturedAt).toEqual(expect.any(Date));
    expect(t.state.discoveries).toHaveLength(1);
    expect(versionsOf(t, pagesOf(t)[0].id)).toHaveLength(1);
    // and the schedule still leaves it out, due or not
    feedRow(t).nextCaptureAt = OLD();
    expect(await due(t)).toEqual([]);
  });

  it('MR2/M18 a paused feed keeps the refresh cooldown', async () => {
    mockLimits.manualRefreshCooldownMs =
      CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS;
    const t = setup();
    t.addFeed({
      scanPausedAt: PAUSED_AT,
      lastCapturedAt: new Date(Date.now() - 60_000),
    });
    expect(await refusal(capture(t))).toEqual({
      status: 429,
      body: {
        msg: 'This source was captured a moment ago. Try again in a few minutes.',
        code: 'CS_SOURCE_REFRESH_TOO_SOON',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MR4/M19 an archived feed, paused or not, still cannot be refreshed', async () => {
    const t = setup();
    t.addFeed({ archivedAt: new Date(), scanPausedAt: PAUSED_AT });
    expect(await refusal(capture(t))).toEqual({
      status: 409,
      body: { msg: 'This source is archived.', code: 'CS_SOURCE_ARCHIVED' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('P8C3PG1-PG4 pause sets the time once and resume clears it; nothing else of the feed, its pages or history changes', async () => {
    const t = setup();
    t.addFeed({ lastCapturedAt: OLD() });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    await t.ingestion.captureScheduledFeed({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: randomUUID(),
      attemptCount: 1,
    });
    fetchMock.mockClear();
    t.source.updateMany.mockClear();
    const others = () =>
      JSON.stringify({
        pages: pagesOf(t),
        versions: t.state.versions,
        discoveries: t.state.discoveries,
      });
    const { scanPausedAt: _paused, updatedAt: _u, ...feed } = feedRow(t);
    const history = others();
    const paused = await t.service.pauseFeed(ORG, FEED);
    const pausedAt = feedRow(t).scanPausedAt;
    expect(pausedAt).toEqual(expect.any(Date));
    expect(paused.scanPausedAt).toEqual(pausedAt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // again: the first pause time stays
    await t.service.pauseFeed(ORG, FEED);
    expect(feedRow(t).scanPausedAt).toBe(pausedAt);
    // the first pause only
    expect(t.source.updateMany).toHaveBeenCalledTimes(1);
    const resumed = await t.service.resumeFeed(ORG, FEED);
    expect(resumed.scanPausedAt).toBeNull();
    await t.service.resumeFeed(ORG, FEED);
    expect(feedRow(t).scanPausedAt).toBeNull();
    expect(t.source.updateMany).toHaveBeenCalledTimes(2);
    const { scanPausedAt: _after, updatedAt: _u2, ...feedAfter } = feedRow(t);
    expect(feedAfter).toEqual(feed);
    expect(others()).toBe(history);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M6/M8 archiving a paused feed keeps its pause; restoring it brings it back paused, never scheduled', async () => {
    const t = setup();
    t.addFeed({ lastCapturedAt: OLD(), scanPausedAt: PAUSED_AT });
    await t.service.archiveSource(ORG, FEED);
    expect(feedRow(t).archivedAt).toEqual(expect.any(Date));
    expect(feedRow(t).scanPausedAt).toBe(PAUSED_AT);
    const restored = await t.service.restoreSource(ORG, FEED);
    expect(restored.archivedAt).toBeNull();
    expect(restored.scanPausedAt).toEqual(PAUSED_AT);
    expect(await due(t)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC1/AC2/M7 a paused feed counts against the live feed limit; archiving it frees its place', async () => {
    mockLimits.activeFeedsMax = 1;
    const t = setup();
    t.addFeed({ scanPausedAt: PAUSED_AT });
    const create = () =>
      t.service.createSource({
        organizationId: ORG,
        userId: USER,
        kind: 'feed',
        name: 'Second',
        url: FEED_B_URL,
      });
    expect((await refusal(create())).body).toEqual({
      msg: 'The organization has too many active feeds.',
      code: 'CS_SOURCE_FEED_LIMIT',
    });
    await t.service.archiveSource(ORG, FEED);
    await expect(create()).resolves.toMatchObject({ kind: 'feed' });
    // AC4 the paused archived feed cannot come back at the limit, and stays
    // archived and paused
    expect((await refusal(t.service.restoreSource(ORG, FEED))).status).toBe(
      409
    );
    expect(feedRow(t).archivedAt).toEqual(expect.any(Date));
    expect(feedRow(t).scanPausedAt).toBe(PAUSED_AT);
  });

  it('a capture already running when its feed is paused may finish once; the feed stays paused and is not listed again', async () => {
    const t = setup();
    t.addFeed({ lastCapturedAt: OLD() });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    let pauseDone: Promise<unknown> = Promise.resolve();
    const fetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, options) => {
      if (url === FEED_URL) {
        // the feed was read before the pause; its pages come after it
        pauseDone = t.service.pauseFeed(ORG, FEED);
        await pauseDone;
      }
      return fetch(url, options);
    });
    const result = await t.ingestion.captureScheduledFeed({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: randomUUID(),
      attemptCount: 1,
    });
    await pauseDone;
    expect(result).toEqual({
      status: 'captured',
      capture: expect.objectContaining({ sourcesCreated: 1 }),
    });
    expect(feedRow(t).scanPausedAt).toEqual(expect.any(Date));
    expect(feedRow(t).lastCapturedAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000
    );
    feedRow(t).nextCaptureAt = OLD();
    expect(await due(t)).toEqual([]);
  });
});

// The schedule of a feed (P8-C4): its next automatic capture follows from
// its last successful one, a scheduled failure delays it, and nothing a
// member does by hand makes that worse
describe('feed capture: the schedule of a feed (P8-C4)', () => {
  const HOUR = 60 * 60 * 1000;
  const feedRow = (t: Setup) => t.state.sources.find((s) => s.id === FEED)!;
  const due = async (t: Setup) =>
    (await t.ingestion.listFeedsDueForCapture({ afterId: null })).feeds.map(
      (feed) => feed.sourceId
    );
  const scheduled = (t: Setup) =>
    t.ingestion.captureScheduledFeed({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: randomUUID(),
      attemptCount: 1,
    });
  const record = (t: Setup, over: Record<string, string> = {}) =>
    t.ingestion.recordScheduledFeedFailure({
      organizationId: ORG,
      sourceId: FEED,
      code: 'CS_SOURCE_FETCH_FAILED',
      ...over,
    });
  const readable = () => {
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1)]));
    w.pages.set(page(1), html('One'));
    return w;
  };
  // a time between `from` and now plus `minutes`, both read around the call
  const around = (date: Date, from: number, to: number, minutes: number) => {
    expect(date.getTime()).toBeGreaterThanOrEqual(from + minutes * 60_000);
    expect(date.getTime()).toBeLessThanOrEqual(to + minutes * 60_000);
  };
  const schedule = (row: Record<string, any>) => ({
    lastCapturedAt: row.lastCapturedAt,
    nextCaptureAt: row.nextCaptureAt,
    consecutiveCaptureFailures: row.consecutiveCaptureFailures,
    captureIntervalMinutes: row.captureIntervalMinutes,
  });

  it('IG1/U1/U5/P8C4PG2/M9/M10/M11 a scheduled success: the next capture an hour after this capture, no failure left, not due again', async () => {
    const t = setup();
    t.addFeed({
      consecutiveCaptureFailures: 3,
      nextCaptureAt: new Date(Date.now() - HOUR),
    });
    readable();
    expect(await due(t)).toEqual([FEED]);
    await scheduled(t);
    const row = feedRow(t);
    expect(row.lastCapturedAt).toEqual(expect.any(Date));
    // the same time: the capture's own, never the time of the write
    expect(row.nextCaptureAt.getTime() - row.lastCapturedAt.getTime()).toBe(
      HOUR
    );
    expect(row.consecutiveCaptureFailures).toBe(0);
    expect(await due(t)).toEqual([]);
  });

  it.each([
    [60, 1],
    [180, 3],
    [360, 6],
    [720, 12],
    [1440, 24],
  ])(
    'U2/U3 a feed set to %i minutes is next captured %i hours after its capture',
    async (minutes, hours) => {
      const t = setup();
      t.addFeed({ captureIntervalMinutes: minutes });
      readable();
      await scheduled(t);
      const row = feedRow(t);
      expect(row.nextCaptureAt.getTime() - row.lastCapturedAt.getTime()).toBe(
        hours * HOUR
      );
      expect(row.captureIntervalMinutes).toBe(minutes);
    }
  );

  it('U4 a stored interval that is no preset fails closed: an integrity error, nothing fetched or written', async () => {
    const t = setup();
    t.addFeed({ captureIntervalMinutes: 90 });
    t.source.updateMany.mockClear();
    expect(await refusal(scheduled(t))).toEqual({
      status: 500,
      body: {
        msg: 'Stored source data could not be verified.',
        code: 'CS_SOURCE_INTEGRITY_ERROR',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.source.updateMany).not.toHaveBeenCalled();
  });

  it('IG2/M12 a member refresh schedules the same way and ends the failures', async () => {
    const t = setup();
    const later = new Date(Date.now() + 10 * HOUR);
    t.addFeed({
      captureIntervalMinutes: 360,
      consecutiveCaptureFailures: 2,
      nextCaptureAt: later,
    });
    readable();
    const result = await capture(t);
    const row = feedRow(t);
    expect(row.nextCaptureAt.getTime() - row.lastCapturedAt.getTime()).toBe(
      6 * HOUR
    );
    expect(row.consecutiveCaptureFailures).toBe(0);
    expect(result.source).toMatchObject({
      captureIntervalMinutes: 360,
      nextCaptureAt: row.nextCaptureAt,
      consecutiveCaptureFailures: 0,
    });
  });

  it('IG3/M13 a member refresh of a paused feed schedules it too; it stays paused and out of the scan', async () => {
    const t = setup();
    const pausedAt = new Date(Date.now() - 2 * HOUR);
    t.addFeed({
      scanPausedAt: pausedAt,
      consecutiveCaptureFailures: 1,
      nextCaptureAt: new Date(Date.now() - HOUR),
    });
    readable();
    await capture(t);
    const row = feedRow(t);
    expect(row.scanPausedAt).toBe(pausedAt);
    expect(row.nextCaptureAt.getTime() - row.lastCapturedAt.getTime()).toBe(
      HOUR
    );
    expect(row.consecutiveCaptureFailures).toBe(0);
    expect(await due(t)).toEqual([]);
    // resumed, it waits for that time: no capture right after the refresh
    await t.service.resumeFeed(ORG, FEED);
    expect(await due(t)).toEqual([]);
  });

  it('IG4/M25 a member refresh that fails writes nothing: no failure, no next or last capture', async () => {
    const t = setup();
    const last = new Date(Date.now() - 3 * HOUR);
    const later = new Date(Date.now() + HOUR);
    t.addFeed({
      lastCapturedAt: last,
      consecutiveCaptureFailures: 1,
      nextCaptureAt: later,
    });
    web().failing.add(FEED_URL);
    t.source.updateMany.mockClear();
    expect((await refusal(capture(t))).body).toEqual({
      msg: 'The source could not be fetched.',
      code: 'CS_SOURCE_FETCH_FAILED',
    });
    expect(t.source.updateMany).not.toHaveBeenCalled();
    expect(schedule(feedRow(t))).toEqual({
      lastCapturedAt: last,
      nextCaptureAt: later,
      consecutiveCaptureFailures: 1,
      captureIntervalMinutes: null,
    });
  });

  it('IG5/M26 a skipped scheduled capture writes nothing', async () => {
    const t = setup();
    const before = new Date(Date.now() - HOUR);
    t.addFeed({ archivedAt: new Date(), nextCaptureAt: before });
    t.source.updateMany.mockClear();
    expect(await scheduled(t)).toEqual({ status: 'skipped' });
    expect(t.source.updateMany).not.toHaveBeenCalled();
    expect(schedule(feedRow(t))).toEqual({
      lastCapturedAt: null,
      nextCaptureAt: before,
      consecutiveCaptureFailures: 0,
      captureIntervalMinutes: null,
    });
  });

  it('IG6/IG7/M15/M16 pages that failed or were past the page limit still make a success for the schedule', async () => {
    mockLimits.urlSourcesMax = 2;
    const t = setup();
    t.addFeed({ consecutiveCaptureFailures: 4 });
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2), page(3)]));
    w.pages.set(page(1), html('One'));
    w.failing.add(page(2));
    await scheduled(t);
    const row = feedRow(t);
    expect(row.consecutiveCaptureFailures).toBe(0);
    expect(row.nextCaptureAt.getTime() - row.lastCapturedAt.getTime()).toBe(
      HOUR
    );
    expect(
      (await t.ingestion.captureScheduledFeed({
        organizationId: ORG,
        sourceId: FEED,
        attemptId: randomUUID(),
        attemptCount: 1,
      })) as { capture: Record<string, number> }
    ).toMatchObject({ capture: { failed: 1, entriesLimited: 1 } });
  });

  it('IG8/P8C4PG3/M14 a capture that read the feed before another one, and ends after it, changes nothing', async () => {
    const t = setup();
    t.addFeed();
    readable();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const fetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, options) => {
      if (url === page(1) && !held) {
        // the member's refresh read the feed first, then waits on its page
        held = true;
        await gate;
      }
      return fetch(url, options);
    });
    const refresh = capture(t);
    while (!held) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduled(t);
    const after = schedule(feedRow(t));
    release();
    const result = await refresh;
    expect(schedule(feedRow(t))).toEqual(after);
    expect(result.source.lastCapturedAt).toEqual(after.lastCapturedAt);
    expect(after.nextCaptureAt.getTime() - after.lastCapturedAt.getTime()).toBe(
      HOUR
    );
  });

  it('B1/P8C4PG4/M22 a recorded failure: one more, the next try an hour later, the last capture kept; recorded again it changes nothing', async () => {
    const t = setup();
    const last = new Date(Date.now() - 2 * HOUR);
    t.addFeed({
      lastCapturedAt: last,
      nextCaptureAt: new Date(Date.now() - HOUR),
      captureIntervalMinutes: 1440,
    });
    const from = Date.now();
    expect(await record(t)).toEqual({ status: 'recorded' });
    const to = Date.now();
    const row = feedRow(t);
    expect(row.consecutiveCaptureFailures).toBe(1);
    // M20 an hour, not the feed's day
    around(row.nextCaptureAt, from, to, 60);
    expect(row.lastCapturedAt).toBe(last);
    const next = row.nextCaptureAt;
    // the same write again (a retried activity): its next try is ahead now
    expect(await record(t)).toEqual({ status: 'unchanged' });
    expect(feedRow(t).consecutiveCaptureFailures).toBe(1);
    expect(feedRow(t).nextCaptureAt).toBe(next);
    expect(await due(t)).toEqual([]);
  });

  it('B1-B7/M17-M19 each failure in a row doubles the delay, up to a day', async () => {
    const t = setup();
    t.addFeed();
    const delays = [];
    for (let n = 1; n <= 8; n++) {
      // the next try is due: its capture ran and failed again
      feedRow(t).nextCaptureAt = new Date(Date.now() - 1000);
      const from = Date.now();
      expect(await record(t)).toEqual({ status: 'recorded' });
      const to = Date.now();
      const row = feedRow(t);
      expect(row.consecutiveCaptureFailures).toBe(n);
      const minutes = Math.round((row.nextCaptureAt.getTime() - from) / 60_000);
      around(row.nextCaptureAt, from, to, minutes);
      delays.push(minutes);
    }
    expect(delays).toEqual([60, 120, 240, 480, 960, 1440, 1440, 1440]);
    // a success ends it
    readable();
    feedRow(t).nextCaptureAt = new Date(Date.now() - 1000);
    await scheduled(t);
    expect(feedRow(t).consecutiveCaptureFailures).toBe(0);
  });

  it('P8C4PG5/M23 two records from the same state count once', async () => {
    const t = setup();
    t.addFeed();
    const results = await Promise.all([record(t), record(t), record(t)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'recorded',
      'unchanged',
      'unchanged',
    ]);
    expect(feedRow(t).consecutiveCaptureFailures).toBe(1);
  });

  it('P8C4PG6/M24 a member success between a failure and its record wins: the record changes nothing', async () => {
    const t = setup();
    t.addFeed({ nextCaptureAt: new Date(Date.now() - HOUR) });
    readable();
    await capture(t);
    const after = schedule(feedRow(t));
    expect(await record(t)).toEqual({ status: 'unchanged' });
    expect(schedule(feedRow(t))).toEqual(after);
    expect(after.consecutiveCaptureFailures).toBe(0);
  });

  it('a paused feed records its failure; a feed gone, archived, of another organization or no feed is skipped', async () => {
    const t = setup();
    t.addFeed({ scanPausedAt: new Date() });
    expect(await record(t)).toEqual({ status: 'recorded' });
    expect(feedRow(t).consecutiveCaptureFailures).toBe(1);
    const u = setup();
    u.addFeed({ archivedAt: new Date() });
    u.addSource({ id: FEED_B, organizationId: ORG, canonicalUrl: page(1) });
    u.source.updateMany.mockClear();
    for (const input of [
      { organizationId: ORG, sourceId: FEED },
      { organizationId: ORG, sourceId: FEED_B },
      { organizationId: OTHER_ORG, sourceId: FEED },
      { organizationId: ORG, sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { organizationId: ORG, sourceId: 'not-an-id' },
    ]) {
      expect(
        await u.ingestion.recordScheduledFeedFailure({
          ...input,
          code: 'CS_SOURCE_FEED_INVALID',
        })
      ).toEqual({ status: 'skipped' });
    }
    expect(u.source.updateMany).not.toHaveBeenCalled();
  });

  describe('the interval of a feed', () => {
    const set = (t: Setup, minutes: unknown, id = FEED, org = ORG) =>
      t.service.setFeedInterval(org, id, minutes);

    it('SI5/P8C4PG7/M34 shorter: an hour after the last capture, due at once when that has passed', async () => {
      const t = setup();
      const last = new Date(Date.now() - 5 * HOUR);
      t.addFeed({
        lastCapturedAt: last,
        captureIntervalMinutes: 1440,
        nextCaptureAt: new Date(last.getTime() + 24 * HOUR),
      });
      expect(await due(t)).toEqual([]);
      const result = await set(t, 60);
      expect(feedRow(t).nextCaptureAt).toEqual(new Date(last.getTime() + HOUR));
      expect(result).toMatchObject({
        captureIntervalMinutes: 60,
        nextCaptureAt: new Date(last.getTime() + HOUR),
      });
      expect(await due(t)).toEqual([FEED]);
    });

    it('SI6/P8C4PG8/M35 longer: a day after the last capture', async () => {
      const t = setup();
      const last = new Date(Date.now() - HOUR / 2);
      t.addFeed({
        lastCapturedAt: last,
        nextCaptureAt: new Date(last.getTime() + HOUR),
      });
      await set(t, 1440);
      expect(feedRow(t).nextCaptureAt).toEqual(
        new Date(last.getTime() + 24 * HOUR)
      );
      expect(feedRow(t).captureIntervalMinutes).toBe(1440);
    });

    it('SI7 never captured: still due now', async () => {
      const t = setup();
      t.addFeed();
      await set(t, 720);
      expect(schedule(feedRow(t))).toEqual({
        lastCapturedAt: null,
        nextCaptureAt: null,
        consecutiveCaptureFailures: 0,
        captureIntervalMinutes: 720,
      });
      expect(await due(t)).toEqual([FEED]);
    });

    it('SI8/M33 a paused feed may change its interval; it stays paused', async () => {
      const t = setup();
      const pausedAt = new Date();
      const last = new Date(Date.now() - HOUR);
      t.addFeed({ scanPausedAt: pausedAt, lastCapturedAt: last });
      await set(t, 180);
      expect(feedRow(t)).toMatchObject({
        scanPausedAt: pausedAt,
        captureIntervalMinutes: 180,
        nextCaptureAt: new Date(last.getTime() + 3 * HOUR),
      });
    });

    it('SI9/P8C4PG9/M36 after failures the failure delay stays; the next success uses the new interval', async () => {
      const t = setup();
      const later = new Date(Date.now() + 4 * HOUR);
      t.addFeed({
        lastCapturedAt: new Date(Date.now() - 10 * HOUR),
        consecutiveCaptureFailures: 3,
        nextCaptureAt: later,
      });
      await set(t, 60);
      expect(feedRow(t)).toMatchObject({
        captureIntervalMinutes: 60,
        consecutiveCaptureFailures: 3,
        nextCaptureAt: later,
      });
      readable();
      feedRow(t).nextCaptureAt = new Date(Date.now() - 1000);
      await scheduled(t);
      const row = feedRow(t);
      expect(row.nextCaptureAt.getTime() - row.lastCapturedAt.getTime()).toBe(
        HOUR
      );
    });

    it('SI10/M37 the same value again writes nothing; null and an explicit hour stay apart', async () => {
      const t = setup();
      t.addFeed({ captureIntervalMinutes: 60 });
      const { updatedAt } = feedRow(t);
      t.source.updateMany.mockClear();
      await expect(set(t, 60)).resolves.toMatchObject({
        captureIntervalMinutes: 60,
      });
      expect(t.source.updateMany).not.toHaveBeenCalled();
      expect(feedRow(t).updatedAt).toBe(updatedAt);
      // M38 null is the default, never "no schedule"
      await expect(set(t, null)).resolves.toMatchObject({
        captureIntervalMinutes: null,
        nextCaptureAt: null,
      });
      expect(t.source.updateMany).toHaveBeenCalledTimes(1);
      expect(await due(t)).toEqual([FEED]);
    });

    it('SI11 a capture that ended between the read and the write: decided again from what it left', async () => {
      const t = setup();
      t.addFeed({ lastCapturedAt: new Date(Date.now() - 5 * HOUR) });
      const fresh = new Date(Date.now() - 60_000);
      const write = t.source.updateMany.getMockImplementation()!;
      t.source.updateMany.mockImplementationOnce(async (args) => {
        feedRow(t).lastCapturedAt = fresh;
        return write(args);
      });
      await set(t, 180);
      expect(t.source.updateMany).toHaveBeenCalledTimes(2);
      expect(feedRow(t).nextCaptureAt).toEqual(
        new Date(fresh.getTime() + 3 * HOUR)
      );
    });

    it('SI12 captures ending between every read and write: a conflict after three attempts, nothing changed', async () => {
      const t = setup();
      t.addFeed({ lastCapturedAt: new Date(Date.now() - 5 * HOUR) });
      const write = t.source.updateMany.getMockImplementation()!;
      t.source.updateMany.mockImplementation(async (args) => {
        feedRow(t).lastCapturedAt = new Date(
          feedRow(t).lastCapturedAt.getTime() + 1
        );
        return write(args);
      });
      expect(await refusal(set(t, 180))).toEqual({
        status: 409,
        body: {
          msg: 'The sources changed meanwhile. Try again.',
          code: 'CS_SOURCE_CONFLICT',
        },
      });
      expect(t.source.updateMany).toHaveBeenCalledTimes(3);
      expect(feedRow(t).captureIntervalMinutes).toBeNull();
    });

    it('SI1-SI4/M30-M32 another organization, a page, an archived feed, then a value that is no preset, in that order', async () => {
      const t = setup();
      t.addFeed({ archivedAt: new Date() });
      t.addSource({ id: FEED_B, organizationId: ORG, canonicalUrl: page(1) });
      t.source.updateMany.mockClear();
      expect((await refusal(set(t, 90, FEED, OTHER_ORG))).status).toBe(404);
      expect((await refusal(set(t, 90, 'not-an-id'))).status).toBe(404);
      expect(await refusal(set(t, 90, FEED_B))).toEqual({
        status: 400,
        body: {
          msg: 'This source type has no scheduled captures.',
          code: 'CS_SOURCE_KIND_UNSUPPORTED',
        },
      });
      expect(await refusal(set(t, 90))).toEqual({
        status: 409,
        body: { msg: 'This source is archived.', code: 'CS_SOURCE_ARCHIVED' },
      });
      const u = setup();
      u.addFeed();
      for (const value of [90, 0, -60, 60.5, '60', 1e9, undefined, {}]) {
        expect(await refusal(set(u, value))).toEqual({
          status: 400,
          body: {
            msg: 'This capture interval is not available.',
            code: 'CS_SOURCE_INTERVAL_INVALID',
          },
        });
      }
      expect(t.source.updateMany).not.toHaveBeenCalled();
      expect(u.source.updateMany).not.toHaveBeenCalled();
    });
  });

  it('P8C4PG10/P8C4PG11 pause, resume, archive and restore keep the interval, the next capture and the failures', async () => {
    const t = setup();
    const kept = {
      lastCapturedAt: new Date(Date.now() - 2 * HOUR),
      nextCaptureAt: new Date(Date.now() + 3 * HOUR),
      consecutiveCaptureFailures: 2,
      captureIntervalMinutes: 720,
    };
    t.addFeed({ ...kept });
    await t.service.pauseFeed(ORG, FEED);
    expect(schedule(feedRow(t))).toEqual(kept);
    await t.service.resumeFeed(ORG, FEED);
    expect(schedule(feedRow(t))).toEqual(kept);
    await t.service.archiveSource(ORG, FEED);
    expect(schedule(feedRow(t))).toEqual(kept);
    await t.service.restoreSource(ORG, FEED);
    expect(schedule(feedRow(t))).toEqual(kept);
    expect(await due(t)).toEqual([]);
  });
});

// Capture history (P8-O1): one record per capture that reads its feed,
// scheduled (one for all its tries) or a member's refresh, ended once
describe('feed capture: its record (P8-O1)', () => {
  const HOUR = 60 * 60 * 1000;
  const RUN = '77777777-7777-4777-8777-777777777777';
  const feedRow = (t: Setup) => t.state.sources.find((s) => s.id === FEED)!;
  const records = (t: Setup) => t.state.attempts;
  const scheduled = (t: Setup, attemptCount = 1, attemptId = RUN) =>
    t.ingestion.captureScheduledFeed({
      organizationId: ORG,
      sourceId: FEED,
      attemptId,
      attemptCount,
    });
  const finish = (t: Setup, over: Record<string, unknown> = {}) =>
    t.ingestion.finishScheduledFeedCapture({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: RUN,
      status: 'source_failed',
      code: 'CS_SOURCE_FETCH_FAILED',
      ...over,
    } as Parameters<Setup['ingestion']['finishScheduledFeedCapture']>[0]);
  const readable = () => {
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2)]));
    w.pages.set(page(1), html('One'));
    w.pages.set(page(2), html('Two'));
    return w;
  };
  // a record's counts, null when not written
  const countsOf = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(NO_COUNTS).map((key) => [key, row[key] ?? null])
    );
  const NO_COUNTS = {
    entriesSeen: null,
    entriesIgnored: null,
    entriesSkipped: null,
    entriesAccepted: null,
    sourcesCreated: null,
    versionsCreated: null,
    unchanged: null,
    failed: null,
    archived: null,
    entriesLimited: null,
  };

  it('O1U1/M4/M11/M23 a member refresh is one manual record: who asked, one try, its counts and the schedule it left', async () => {
    const t = setup();
    t.addFeed({ consecutiveCaptureFailures: 2 });
    readable();
    const before = Date.now();
    const { capture: summary } = await capture(t);
    expect(records(t)).toHaveLength(1);
    const [row] = records(t);
    expect(row).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      organizationId: ORG,
      sourceId: FEED,
      trigger: 'manual',
      status: 'success',
      requestedByUserId: USER,
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
      attemptCount: 1,
      ...summary,
      nextCaptureAtAfter: feedRow(t).nextCaptureAt,
      consecutiveFailuresAfter: 0,
    });
    expect(summary.entriesAccepted).toBe(2);
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.finishedAt.getTime()).toBeGreaterThanOrEqual(
      row.startedAt.getTime()
    );
    expect(row.nextCaptureAtAfter.getTime()).toBe(
      feedRow(t).lastCapturedAt.getTime() + HOUR
    );
    // never an error, a message, a URL or a title
    expect(Object.keys(row)).not.toEqual(
      expect.arrayContaining(['errorMessage', 'message', 'stack', 'url'])
    );
    expect(JSON.stringify(row)).not.toContain('news.example');
  });

  it('O1U2/M12/M22 a member refresh that fails is recorded with its code; the schedule is left as it was', async () => {
    const t = setup();
    const later = new Date(Date.now() + HOUR);
    t.addFeed({ consecutiveCaptureFailures: 1, nextCaptureAt: later });
    web().failing.add(FEED_URL);
    expect((await refusal(capture(t))).body).toEqual({
      msg: 'The source could not be fetched.',
      code: 'CS_SOURCE_FETCH_FAILED',
    });
    expect(feedRow(t).consecutiveCaptureFailures).toBe(1);
    expect(feedRow(t).nextCaptureAt).toEqual(later);
    expect(records(t)).toEqual([
      {
        id: expect.any(String),
        organizationId: ORG,
        sourceId: FEED,
        trigger: 'manual',
        status: 'source_failed',
        requestedByUserId: USER,
        startedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        attemptCount: 1,
        errorCode: 'CS_SOURCE_FETCH_FAILED',
        nextCaptureAtAfter: later,
        consecutiveFailuresAfter: 1,
      },
    ]);
  });

  it('O1U3/M13 a member refresh that fails in the system is infrastructure_failed, without a code, and the error is the answer', async () => {
    const t = setup();
    t.addFeed();
    readable();
    t.hooks.discoveries = {
      beforeCreate: () => {
        throw new Error('database down');
      },
    };
    await expect(capture(t)).rejects.toThrow('database down');
    expect(records(t)).toEqual([
      expect.objectContaining({
        trigger: 'manual',
        status: 'infrastructure_failed',
        errorCode: null,
        consecutiveFailuresAfter: 0,
        nextCaptureAtAfter: null,
      }),
    ]);
    expect(countsOf(records(t)[0])).toEqual(NO_COUNTS);
  });

  it('O1U4/M24/M25 a refresh refused before it reads the feed has no record: too soon, archived, missing, another organization', async () => {
    mockLimits.manualRefreshCooldownMs = 5 * 60 * 1000;
    const t = setup();
    t.addFeed({ lastCapturedAt: new Date() });
    readable();
    expect((await refusal(capture(t))).status).toBe(429);
    feedRow(t).archivedAt = new Date();
    feedRow(t).lastCapturedAt = null;
    expect((await refusal(capture(t))).status).toBe(409);
    feedRow(t).archivedAt = null;
    expect(
      (await refusal(capture(t, { organizationId: OTHER_ORG }))).status
    ).toBe(404);
    expect((await refusal(capture(t, { sourceId: 'not-an-id' }))).status).toBe(
      404
    );
    expect(records(t)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('O1U5/M26 a paused feed refreshed by a member is recorded as usual; the pause stays', async () => {
    const t = setup();
    const paused = new Date(Date.now() - HOUR);
    t.addFeed({ scanPausedAt: paused });
    readable();
    await capture(t);
    expect(records(t)).toEqual([
      expect.objectContaining({ trigger: 'manual', status: 'success' }),
    ]);
    expect(feedRow(t).scanPausedAt).toEqual(paused);
  });

  it('O1U6/M5 a scheduled capture is recorded under its run id, without a member, with this try', async () => {
    const t = setup();
    t.addFeed();
    readable();
    await scheduled(t, 2);
    expect(records(t)).toEqual([
      expect.objectContaining({
        id: RUN,
        trigger: 'scheduled',
        status: 'success',
        requestedByUserId: null,
        attemptCount: 2,
        entriesAccepted: 2,
        consecutiveFailuresAfter: 0,
      }),
    ]);
  });

  it('O1U7/M1/M2/M3 every try of one scheduled capture keeps one record: its start, and the highest try, never lower', async () => {
    const t = setup();
    t.addFeed();
    const w = readable();
    w.failing.add(FEED_URL);
    await expect(scheduled(t, 1)).rejects.toBeInstanceOf(HttpException);
    const [first] = records(t);
    const startedAt = first.startedAt;
    expect(first).toMatchObject({ status: 'running', attemptCount: 1 });
    await expect(scheduled(t, 3)).rejects.toBeInstanceOf(HttpException);
    // a try that started reading again after its row was written
    await expect(scheduled(t, 2)).rejects.toBeInstanceOf(HttpException);
    expect(records(t)).toHaveLength(1);
    expect(records(t)[0]).toMatchObject({
      status: 'running',
      attemptCount: 3,
      startedAt,
    });
    expect(records(t)[0].finishedAt ?? null).toBeNull();
    w.failing.delete(FEED_URL);
    await scheduled(t, 3);
    expect(records(t)).toHaveLength(1);
    expect(records(t)[0]).toMatchObject({
      status: 'success',
      attemptCount: 3,
      startedAt,
    });
  });

  it('O1U8/M8 a record that has ended is never written again: a late try captures, and its record stays', async () => {
    const t = setup();
    t.addFeed();
    readable();
    await scheduled(t, 1);
    const ended = { ...records(t)[0] };
    await scheduled(t, 2);
    expect(records(t)).toEqual([ended]);
    expect(
      await finish(t, { status: 'infrastructure_failed', code: null })
    ).toEqual({ status: 'unchanged' });
    expect(await finish(t)).toEqual({ status: 'unchanged' });
    expect(records(t)).toEqual([ended]);
  });

  it('O1U9 a skipped scheduled capture has no record: paused, archived, gone, another kind, another organization', async () => {
    const t = setup();
    t.addFeed({ scanPausedAt: new Date() });
    expect(await scheduled(t)).toEqual({ status: 'skipped' });
    feedRow(t).scanPausedAt = null;
    feedRow(t).archivedAt = new Date();
    expect(await scheduled(t)).toEqual({ status: 'skipped' });
    t.addSource({ id: FEED_B, organizationId: ORG, canonicalUrl: page(9) });
    expect(
      await t.ingestion.captureScheduledFeed({
        organizationId: ORG,
        sourceId: FEED_B,
        attemptId: RUN,
        attemptCount: 1,
      })
    ).toEqual({ status: 'skipped' });
    expect(
      await t.ingestion.captureScheduledFeed({
        organizationId: OTHER_ORG,
        sourceId: FEED,
        attemptId: RUN,
        attemptCount: 1,
      })
    ).toEqual({ status: 'skipped' });
    expect(records(t)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('O1U10/M14/M17 the end of a failed scheduled capture: after its failure record, with the code and the schedule that left, once', async () => {
    const t = setup();
    t.addFeed();
    web().failing.add(FEED_URL);
    await expect(scheduled(t, 3)).rejects.toBeInstanceOf(HttpException);
    const before = Date.now();
    await t.ingestion.recordScheduledFeedFailure({
      organizationId: ORG,
      sourceId: FEED,
      code: 'CS_SOURCE_FETCH_FAILED',
    });
    expect(await finish(t)).toEqual({ status: 'finished' });
    const [row] = records(t);
    expect(row).toMatchObject({
      status: 'source_failed',
      errorCode: 'CS_SOURCE_FETCH_FAILED',
      attemptCount: 3,
      consecutiveFailuresAfter: 1,
      nextCaptureAtAfter: feedRow(t).nextCaptureAt,
    });
    expect(countsOf(row)).toEqual(NO_COUNTS);
    expect(row.nextCaptureAtAfter.getTime()).toBeGreaterThanOrEqual(
      before + HOUR
    );
    expect(row.finishedAt.getTime()).toBeGreaterThanOrEqual(
      row.startedAt.getTime()
    );
    // again, or as a failure of the system: never changed
    expect(await finish(t)).toEqual({ status: 'unchanged' });
    expect(
      await finish(t, { status: 'infrastructure_failed', code: null })
    ).toEqual({ status: 'unchanged' });
    expect(records(t)[0]).toEqual(row);
  });

  it('O1U11/M18 a failure of the system is ended without a code and leaves the schedule alone', async () => {
    const t = setup();
    const due = new Date(Date.now() - HOUR);
    t.addFeed({ nextCaptureAt: due });
    t.hooks.discoveries = {
      beforeCreate: () => {
        throw new Error('database down');
      },
    };
    readable();
    await expect(scheduled(t, 3)).rejects.toThrow('database down');
    expect(
      await finish(t, { status: 'infrastructure_failed', code: null })
    ).toEqual({ status: 'finished' });
    expect(records(t)[0]).toMatchObject({
      status: 'infrastructure_failed',
      errorCode: null,
      nextCaptureAtAfter: due,
      consecutiveFailuresAfter: 0,
    });
    expect(feedRow(t)).toMatchObject({
      nextCaptureAt: due,
      consecutiveCaptureFailures: 0,
    });
  });

  it.each([
    ['a code that is no CS_ code', { code: 'Error' }],
    ['a code with text', { code: 'CS_SOURCE_FETCH_FAILED https://x.test' }],
    ['no code for a failure of the feed', { code: null }],
    [
      'a code for a failure of the system',
      { status: 'infrastructure_failed', code: 'CS_SOURCE_FETCH_FAILED' },
    ],
    ['another outcome', { status: 'success', code: null }],
    ['running again', { status: 'running', code: null }],
    ['an attempt id that is no uuid', { attemptId: 'run' }],
    ['a source id that is no uuid', { sourceId: 'x' }],
  ])(
    'O1U12 the end is skipped, with nothing written, for %s',
    async (_, over) => {
      const t = setup();
      t.addFeed();
      web().failing.add(FEED_URL);
      await expect(scheduled(t)).rejects.toBeInstanceOf(HttpException);
      t.attempt.updateMany.mockClear();
      expect(await finish(t, over)).toEqual({ status: 'skipped' });
      expect(t.attempt.updateMany).not.toHaveBeenCalled();
      expect(records(t)[0].status).toBe('running');
    }
  );

  it('O1U13 another organization or feed never ends a record; a record never begun is no error', async () => {
    const t = setup();
    t.addFeed();
    t.addFeed({
      id: FEED_B,
      organizationId: OTHER_ORG,
      canonicalUrl: FEED_B_URL,
    });
    web().failing.add(FEED_URL);
    await expect(scheduled(t)).rejects.toBeInstanceOf(HttpException);
    expect(await finish(t, { organizationId: OTHER_ORG })).toEqual({
      status: 'unchanged',
    });
    expect(
      await finish(t, { organizationId: OTHER_ORG, sourceId: FEED_B })
    ).toEqual({ status: 'unchanged' });
    expect(records(t)[0].status).toBe('running');
    expect(
      await finish(t, { attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    ).toEqual({ status: 'unchanged' });
  });

  it('O1U14 a record id of another organization, feed or trigger is never taken over: an integrity error before any fetch', async () => {
    const t = setup();
    t.addFeed();
    readable();
    t.state.attempts.push({
      id: RUN,
      organizationId: OTHER_ORG,
      sourceId: FEED,
      trigger: 'scheduled',
      status: 'running',
      startedAt: new Date(),
      attemptCount: 1,
    });
    expect((await refusal(scheduled(t))).body).toEqual({
      msg: 'Stored source data could not be verified.',
      code: 'CS_SOURCE_INTEGRITY_ERROR',
    });
    t.state.attempts[0].organizationId = ORG;
    t.state.attempts[0].trigger = 'manual';
    expect((await refusal(scheduled(t))).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.state.attempts).toHaveLength(1);
  });

  it('O1U15 a capture that ends after a later one leaves the later schedule, and is still a success', async () => {
    const t = setup();
    t.addFeed();
    readable();
    await scheduled(t, 1, RUN);
    const later = feedRow(t).nextCaptureAt;
    // a capture that read the feed first and ends last
    const older = new Date(feedRow(t).lastCapturedAt.getTime() - 1000);
    t.state.attempts.push({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      organizationId: ORG,
      sourceId: FEED,
      trigger: 'manual',
      status: 'running',
      startedAt: older,
      attemptCount: 1,
    });
    expect(
      await t.repository.markFeedCaptured(
        ORG,
        FEED,
        older,
        new Date(older.getTime() + HOUR),
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          finishedAt: new Date(),
          summary: {
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
          },
        }
      )
    ).toEqual({ count: 0, ended: true });
    expect(feedRow(t).nextCaptureAt).toEqual(later);
    expect(records(t).map((r) => [r.status, r.nextCaptureAtAfter])).toEqual([
      ['success', later],
      ['success', later],
    ]);
  });
});

// Capture history, read (P8-O1)
describe('feed capture history: the read (P8-O1)', () => {
  const STALE = 60 * 60 * 1000;
  const T = new Date('2026-10-20T10:00:00.000Z');
  const ended = (n: number, over: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    organizationId: ORG,
    sourceId: FEED,
    trigger: 'scheduled',
    status: 'success',
    requestedByUserId: null,
    startedAt: new Date(T.getTime() + n * 1000),
    finishedAt: new Date(T.getTime() + n * 1000 + 2400),
    attemptCount: 1,
    errorCode: null,
    entriesSeen: 4,
    entriesIgnored: 0,
    entriesSkipped: 1,
    entriesAccepted: 3,
    sourcesCreated: 1,
    versionsCreated: 1,
    unchanged: 1,
    failed: 1,
    archived: 0,
    entriesLimited: 0,
    nextCaptureAtAfter: new Date(T.getTime() + 3_600_000),
    consecutiveFailuresAfter: 0,
    ...over,
  });
  const read = (t: Setup, page = 1, organizationId = ORG, sourceId = FEED) =>
    t.service.listFeedCaptures({ organizationId, sourceId, page });

  it('O1R1/M28/M29 newest first, 20 a page, with the total, never more', async () => {
    const t = setup();
    t.addFeed();
    for (let n = 0; n < 45; n++) {
      t.state.attempts.push(ended(n));
    }
    const first = await read(t);
    expect(first.total).toBe(45);
    expect(first.pages).toBe(3);
    expect(first.results).toHaveLength(20);
    expect(first.results[0].id).toBe(ended(44).id);
    const all = [
      ...first.results,
      ...(await read(t, 2)).results,
      ...(await read(t, 3)).results,
    ].map((r) => r.id);
    expect(new Set(all).size).toBe(45);
    expect(all).toEqual(Array.from({ length: 45 }, (_, i) => ended(44 - i).id));
    expect(t.attempt.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, sourceId: FEED },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: expect.any(Object),
      skip: 0,
      take: 20,
    });
    // M27 the organization's own records only, at every read
    for (const [args] of [
      ...t.attempt.findMany.mock.calls,
      ...t.attempt.count.mock.calls,
    ]) {
      expect(args.where).toEqual({ organizationId: ORG, sourceId: FEED });
    }
  });

  it('O1R2/M30 another organization reads its feed as missing, and its records never show', async () => {
    const t = setup();
    t.addFeed();
    t.state.attempts.push(ended(1));
    t.state.attempts.push(
      ended(2, { organizationId: OTHER_ORG, id: 'x-other' })
    );
    expect((await refusal(read(t, 1, OTHER_ORG))).status).toBe(404);
    expect((await read(t)).results.map((r) => r.id)).toEqual([ended(1).id]);
  });

  it('O1R3/M32/M33/M34 a record leaves as these fields only: no organization, feed, member, message or stack', async () => {
    const t = setup();
    t.addFeed();
    t.state.attempts.push(
      ended(1, {
        requestedByUserId: USER,
        trigger: 'manual',
        message: 'raw https://x.test',
        stack: 'Error',
      })
    );
    const [row] = (await read(t)).results;
    expect(row).toEqual({
      id: ended(1).id,
      trigger: 'manual',
      status: 'success',
      startedAt: ended(1).startedAt,
      finishedAt: ended(1).finishedAt,
      durationMs: 2400,
      attemptCount: 1,
      errorCode: null,
      summary: {
        entriesSeen: 4,
        entriesIgnored: 0,
        entriesSkipped: 1,
        entriesAccepted: 3,
        sourcesCreated: 1,
        versionsCreated: 1,
        unchanged: 1,
        failed: 1,
        archived: 0,
        entriesLimited: 0,
      },
      nextCaptureAtAfter: ended(1).nextCaptureAtAfter,
      consecutiveFailuresAfter: 0,
    });
  });

  it('O1R4/M39 an archived or paused feed keeps its history; a page has none (400), a missing feed 404', async () => {
    const t = setup();
    t.addFeed({ archivedAt: new Date(), scanPausedAt: new Date() });
    t.state.attempts.push(ended(1));
    expect((await read(t)).results).toHaveLength(1);
    t.addSource({ id: FEED_B, organizationId: ORG, canonicalUrl: page(1) });
    expect(await refusal(read(t, 1, ORG, FEED_B))).toEqual({
      status: 400,
      body: {
        msg: 'This source type has no capture history.',
        code: 'CS_SOURCE_KIND_UNSUPPORTED',
      },
    });
    expect(
      (await refusal(read(t, 1, ORG, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')))
        .status
    ).toBe(404);
    expect((await refusal(read(t, 1, ORG, 'not-an-id'))).status).toBe(404);
  });

  it('O1R5 a record still running is in progress, and interrupted once past the hour; the row is never changed for it', async () => {
    const t = setup();
    t.addFeed();
    const running = {
      status: 'running',
      finishedAt: null,
      ...Object.fromEntries(
        [
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
          'nextCaptureAtAfter',
          'consecutiveFailuresAfter',
        ].map((key) => [key, null])
      ),
    };
    t.state.attempts.push(
      ended(1, { ...running, startedAt: new Date(Date.now() - STALE + 60_000) })
    );
    t.state.attempts.push(
      ended(2, {
        ...running,
        startedAt: new Date(Date.now() - STALE - 60_000),
      })
    );
    const { results } = await read(t);
    expect(results.map((r) => [r.status, r.durationMs, r.summary])).toEqual([
      ['running', null, null],
      ['interrupted', null, null],
    ]);
    expect(t.state.attempts.map((r) => r.status)).toEqual([
      'running',
      'running',
    ]);
  });

  it('O1R6 a failure carries its code and no counts; a failure of the system neither', async () => {
    const t = setup();
    t.addFeed();
    const failed = Object.fromEntries(
      [
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
      ].map((key) => [key, null])
    );
    t.state.attempts.push(
      ended(1, {
        ...failed,
        status: 'source_failed',
        errorCode: 'CS_SOURCE_FEED_INVALID',
        attemptCount: 3,
        consecutiveFailuresAfter: 2,
      }),
      ended(2, { ...failed, status: 'infrastructure_failed' })
    );
    const { results } = await read(t);
    expect(
      results.map((r) => [r.status, r.errorCode, r.summary, r.attemptCount])
    ).toEqual([
      ['infrastructure_failed', null, null, 1],
      ['source_failed', 'CS_SOURCE_FEED_INVALID', null, 3],
    ]);
  });

  it.each([
    ['an unknown status', { status: 'done' }],
    ['an unknown trigger', { trigger: 'webhook' }],
    ['a member refresh of two tries', { trigger: 'manual', attemptCount: 2 }],
    ['no try', { attemptCount: 0 }],
    ['an end before its start', { finishedAt: new Date(T.getTime() - 1) }],
    ['an ended record without its end', { finishedAt: null }],
    ['a success without a count', { failed: null }],
    ['a negative count', { unchanged: -1 }],
    ['counts that do not add up', { entriesAccepted: 9 }],
    ['a success with a code', { errorCode: 'CS_SOURCE_FETCH_FAILED' }],
    ['no schedule after the end', { consecutiveFailuresAfter: null }],
    [
      'a failure of the feed without a code',
      { status: 'source_failed', errorCode: null },
    ],
    [
      'a failure of the feed with a text code',
      { status: 'source_failed', errorCode: 'connection refused' },
    ],
    [
      'a failure with counts',
      { status: 'infrastructure_failed', errorCode: null },
    ],
    [
      'a running record that ended',
      { status: 'running', consecutiveFailuresAfter: null },
    ],
  ])('O1R7 a stored record with %s fails closed', async (_, over) => {
    const t = setup();
    t.addFeed();
    t.state.attempts.push(ended(1, over));
    expect(await refusal(read(t))).toEqual({
      status: 500,
      body: {
        msg: 'Stored source data could not be verified.',
        code: 'CS_SOURCE_INTEGRITY_ERROR',
      },
    });
  });
});

describe('feed discoveries: the read', () => {
  const capturedFeed = async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    w.feeds.set(FEED_URL, rss([page(1), page(2)], `<b>${MARKER}</b>`));
    w.pages.set(page(1), html(`One ${MARKER}`));
    w.pages.set(page(2), html('Two'));
    await capture(t);
    return t;
  };

  it('UI5 lists the pages of a feed, newest first sighting first, as source summaries without their text', async () => {
    const t = await capturedFeed();
    const second = t.state.discoveries.find(
      (d) => d.discoveredSourceId === sourceByUrl(t, page(2)).id
    )!;
    second.firstSeenAt = new Date('2099-01-01T00:00:00Z');
    second.lastSeenAt = new Date('2099-01-01T00:00:00Z');
    const result = await t.service.listDiscoveries({
      organizationId: ORG,
      sourceId: FEED,
      page: 1,
    });
    expect(result.pages).toBe(1);
    expect(result.total).toBe(2);
    expect(result.results.map((d) => d.source.canonicalUrl)).toEqual([
      page(2),
      page(1),
    ]);
    expect(Object.keys(result.results[0]).sort()).toEqual([
      'changedSinceFound',
      'entryTitle',
      'firstSeenAt',
      'id',
      'lastSeenAt',
      'publishedAt',
      'source',
    ]);
    expect(Object.keys(result.results[0].source).sort()).toEqual([
      'archivedAt',
      'canonicalUrl',
      'id',
      'lastPageChangeAt',
      'latestVersionNumber',
      'name',
    ]);
    // the entry's title is the feed's text; the page's text never leaves here
    expect(JSON.stringify(result)).not.toContain(`One ${MARKER}`);
    expect(JSON.stringify(result)).not.toMatch(
      /organizationId|feedSourceId|createdById|content/
    );
  });

  it('P8-02 one capture is one first sighting: its pages are ordered by their feed date, undated last, then id', async () => {
    const t = setup();
    t.addFeed();
    const w = web();
    // the feed dates its entries 00:00, 01:00, 02:00 and 03:00 in feed order
    w.feeds.set(FEED_URL, rss([page(1), page(2), page(3), page(4)]));
    for (const n of [1, 2, 3, 4]) {
      w.pages.set(page(n), html(`Page ${n}`));
    }
    await capture(t);
    expect(new Set(t.state.discoveries.map((d) => +d.firstSeenAt)).size).toBe(
      1
    );
    // the feed dropped the date of page 3 at a later sighting
    t.state.discoveries.find(
      (d) => d.discoveredSourceId === sourceByUrl(t, page(3)).id
    )!.publishedAt = null;
    const urls = async () =>
      (
        await t.service.listDiscoveries({
          organizationId: ORG,
          sourceId: FEED,
          page: 1,
        })
      ).results.map((d) => d.source.canonicalUrl);
    expect(await urls()).toEqual([page(4), page(2), page(1), page(3)]);
    // the same date: id decides, ascending
    for (const d of t.state.discoveries) {
      d.publishedAt = new Date('2026-10-20T00:00:00Z');
    }
    const byId = [...t.state.discoveries]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(
        (d) =>
          t.state.sources.find((s) => s.id === d.discoveredSourceId)!
            .canonicalUrl
      );
    expect(await urls()).toEqual(byId);
    expect(t.discovery.findMany.mock.calls.at(-1)![0].orderBy).toEqual([
      { firstSeenAt: 'desc' },
      { publishedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('TEN2/M13 another organization reads the feed as missing; SK4 a page has no discoveries', async () => {
    const t = await capturedFeed();
    expect(
      (
        await refusal(
          t.service.listDiscoveries({
            organizationId: OTHER_ORG,
            sourceId: FEED,
            page: 1,
          })
        )
      ).status
    ).toBe(404);
    const pageId = sourceByUrl(t, page(1)).id;
    expect(
      await refusal(
        t.service.listDiscoveries({
          organizationId: ORG,
          sourceId: pageId,
          page: 1,
        })
      )
    ).toEqual({
      status: 400,
      body: {
        msg: 'This source type has no discoveries.',
        code: 'CS_SOURCE_KIND_UNSUPPORTED',
      },
    });
    // every discovery query names the organization
    for (const call of [
      ...t.discovery.findMany.mock.calls,
      ...t.discovery.count.mock.calls,
    ]) {
      expect((call[0] as { where: Row }).where.organizationId).toBe(ORG);
    }
    // the repository itself never answers with another organization's rows
    expect(
      await t.discoveries.listDiscoveriesForFeed({
        organizationId: OTHER_ORG,
        feedSourceId: FEED,
        skip: 0,
        take: 50,
      })
    ).toEqual([]);
    expect(
      await t.discoveries.listDiscoveriesForFeed({
        organizationId: ORG,
        feedSourceId: FEED,
        skip: 0,
        take: 50,
      })
    ).toHaveLength(2);
  });

  it("P8-02 a row of another feed in a feed's list is an integrity error", async () => {
    const t = await capturedFeed();
    const list = t.discovery.findMany.getMockImplementation()!;
    t.discovery.findMany.mockImplementationOnce(async (args) =>
      (await list(args)).map((row: Row) => ({ ...row, feedSourceId: FEED_B }))
    );
    expect(
      await refusal(
        t.service.listDiscoveries({
          organizationId: ORG,
          sourceId: FEED,
          page: 1,
        })
      )
    ).toEqual({
      status: 500,
      body: {
        msg: 'Stored source data could not be verified.',
        code: 'CS_SOURCE_INTEGRITY_ERROR',
      },
    });
  });

  it('93/TEN4/TEN5/M20 a row that is not what a capture writes is an integrity error, never shown or repaired', async () => {
    const tampers: Array<[string, (t: Setup) => void]> = [
      ['the page is a feed', (t) => (sourceByUrl(t, page(1)).kind = 'feed')],
      [
        'the page has no URL',
        (t) => (sourceByUrl(t, page(1)).canonicalUrl = null),
      ],
      [
        'the page is of another organization',
        (t) => (sourceByUrl(t, page(1)).organizationId = OTHER_ORG),
      ],
      [
        'last seen before first seen',
        (t) =>
          (t.state.discoveries[0].lastSeenAt = new Date(
            '2000-01-01T00:00:00Z'
          )),
      ],
    ];
    for (const [name, tamper] of tampers) {
      const t = await capturedFeed();
      tamper(t);
      expect([
        name,
        await refusal(
          t.service.listDiscoveries({
            organizationId: ORG,
            sourceId: FEED,
            page: 1,
          })
        ),
      ]).toEqual([
        name,
        {
          status: 500,
          body: {
            msg: 'Stored source data could not be verified.',
            code: 'CS_SOURCE_INTEGRITY_ERROR',
          },
        },
      ]);
    }
    const t = await capturedFeed();
    t.state.sources.find((s) => s.id === FEED)!.kind = 'rss';
    expect(
      (
        await refusal(
          t.service.listDiscoveries({
            organizationId: ORG,
            sourceId: FEED,
            page: 1,
          })
        )
      ).status
    ).toBe(500);
  });

  it('a feed that was never captured has no discoveries; pages are 50 long', async () => {
    const t = setup();
    t.addFeed();
    expect(
      await t.service.listDiscoveries({
        organizationId: ORG,
        sourceId: FEED,
        page: 1,
      })
    ).toEqual({ pages: 0, total: 0, results: [] });
    await t.service.listDiscoveries({
      organizationId: ORG,
      sourceId: FEED,
      page: 3,
    });
    expect(t.discovery.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 100, take: 50 })
    );
  });
});

describe('feed capture boundaries', () => {
  const read = (file: string) =>
    fs
      .readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const ingestion = read('source.ingestion.service.ts');

  it('P801-1/P801-2/M1/M2 every fetch is a safeFetch call: no parseURL, rss-parser, raw fetch or AutoPost', () => {
    expect(ingestion).not.toMatch(
      /rss-parser|parseURL|\bfetch\(|axios|undici|autopost|AutopostService|createSafeFetch/i
    );
    expect(ingestion.match(/\bsafeFetch\(/g)).toHaveLength(2);
  });

  it('P801-3/P801-5/P801-6/P801-7 makes ordinary url sources; no AI, scoring, topic or competitor', () => {
    expect(ingestion).toMatch(/kind: 'url',/);
    expect(ingestion).not.toMatch(
      /AIConnection|AIExecution|AIOperation|AIUsage|openai|anthropic|embedding|score|sentiment|topic|cluster|competitor|summari[sz]/i
    );
  });
});
