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
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import {
  ContentStudioSourceIngestionService,
  FEED_CAPTURE_INTERVAL_MS,
  FEED_FETCH_ALLOWED_CONTENT_TYPES,
  FEED_FETCH_MAX_BYTES,
  FEED_FETCH_TIMEOUT_MS,
  FEED_SCAN_PAGE_SIZE,
  SOURCE_FETCH_ALLOWED_CONTENT_TYPES,
  SOURCE_FETCH_MAX_BYTES,
  SOURCE_FETCH_TIMEOUT_MS,
} from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { SOURCE_FEED_MAX_ENTRIES } from '@gitroom/nestjs-libraries/content-studio/sources/source.feed';

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
        ...(table !== 'discoveries' ? { createdAt: at } : {}),
        ...(table === 'sources'
          ? { updatedAt: at, archivedAt: null, lastCapturedAt: null }
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
  const tx = {
    contentStudioSource: source,
    contentStudioSourceVersion: version,
  };
  const repository = new ContentStudioSourceRepository(
    {
      model: { contentStudioSource: source },
    } as unknown as PrismaRepository<'contentStudioSource'>,
    {
      model: { contentStudioSourceVersion: version },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    {
      model: {
        $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) =>
          fn(tx)
        ),
      },
    } as unknown as PrismaTransaction
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository({
    model: { contentStudioSourceDiscovery: discovery },
  } as unknown as PrismaRepository<'contentStudioSourceDiscovery'>);
  const ingestion = new ContentStudioSourceIngestionService(
    repository,
    discoveries
  );
  const service = new ContentStudioSourceService(repository, discoveries);
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
    repository,
    discoveries,
    ingestion,
    service,
    addSource,
    addFeed,
    source,
    version,
    discovery,
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
      expect(await t.ingestion.captureScheduledFeed(input)).toEqual({
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
      t.ingestion.captureScheduledFeed({ organizationId: ORG, sourceId: FEED })
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('lists live feeds of live organizations not captured within the interval, in id pages', async () => {
    const t = setup();
    const recent = new Date(Date.now() - 60_000);
    const old = new Date(Date.now() - FEED_CAPTURE_INTERVAL_MS - 60_000);
    t.addFeed({ id: '10000000-0000-4000-8000-000000000001' });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000002',
      canonicalUrl: 'https://a.example/1',
      lastCapturedAt: old,
    });
    t.addFeed({
      id: '10000000-0000-4000-8000-000000000003',
      canonicalUrl: 'https://a.example/2',
      lastCapturedAt: recent,
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
