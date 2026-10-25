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
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';

// Organization page changes (P8-04B1) with the real service and repository
// over an in-memory Prisma that implements exactly the filters, orders and
// writes the backfill and the Changes read use, with SQL's null rules (a
// null is never greater, equal or in anything). Anything else throws, so a
// query written another way fails here. Real Prisma and PostgreSQL are in
// the P8-04B1 PostgreSQL suite

type Row = Record<string, any>;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const V2 = 'content-studio-source-v2';
const V1 = 'content-studio-source-v1';
const NOW = new Date('2026-10-22T12:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UPDATED = new Date('2026-09-01T00:00:00.000Z');

const sourceId = (n: number) =>
  `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;
const versionId = (source: string, n: number) =>
  `${source.slice(0, 8)}-${String(n).padStart(4, '0')}-4000-8000-000000000000`;
const hash = (letter: string) => letter.repeat(64);

const equal = (value: unknown, condition: unknown) =>
  value instanceof Date && condition instanceof Date
    ? value.getTime() === condition.getTime()
    : value !== null && value === condition;

const compare = (row: Row, key: string, condition: unknown): boolean => {
  const value = row[key] ?? null;
  if (condition === null) {
    return value === null;
  }
  if (typeof condition !== 'object' || condition instanceof Date) {
    return equal(value, condition);
  }
  const parts = condition as Row;
  for (const operator of Object.keys(parts)) {
    if (!['not', 'gt', 'gte', 'lt'].includes(operator)) {
      throw new Error(`unsupported operator ${operator} on ${key}`);
    }
  }
  if ('not' in parts) {
    if (parts.not !== null) {
      throw new Error(`unsupported not on ${key}`);
    }
    if (value === null) {
      return false;
    }
  }
  if ('gt' in parts && !(value !== null && value > parts.gt)) {
    return false;
  }
  if ('gte' in parts && !(value !== null && value >= parts.gte)) {
    return false;
  }
  if ('lt' in parts && !(value !== null && value < parts.lt)) {
    return false;
  }
  return true;
};

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) {
      return true;
    }
    if (key === 'OR') {
      return (condition as Row[]).some((part) => matches(row, part));
    }
    if (key === 'NOT' || key === 'AND') {
      throw new Error(`unsupported ${key}`);
    }
    return compare(row, key, condition);
  });

const pick = (row: Row, select: Row) =>
  Object.fromEntries(
    Object.keys(select).map((key) => {
      if (select[key] !== true) {
        throw new Error(`unsupported select of ${key}`);
      }
      return [key, row[key] ?? null];
    })
  );

const order = (rows: Row[], orderBy: Row | Row[] | undefined) => {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [])
    .flatMap((part) => Object.entries(part))
    .map(([key, direction]) => {
      if (direction !== 'asc' && direction !== 'desc') {
        throw new Error(`unsupported order of ${key}`);
      }
      return [key, direction] as const;
    });
  return [...rows].sort((a, b) => {
    for (const [key, direction] of keys) {
      const x = a[key] instanceof Date ? a[key].getTime() : a[key];
      const y = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (x !== y) {
        return (x < y ? -1 : 1) * (direction === 'asc' ? 1 : -1);
      }
    }
    return 0;
  });
};

const setup = () => {
  const sources: Row[] = [];
  const versions: Row[] = [];
  const addSource = (n: number, extra: Partial<Row> = {}) => {
    const row: Row = {
      id: sourceId(n),
      organizationId: ORG,
      kind: 'url',
      name: `Page ${n}`,
      canonicalUrl: `https://example.com/page-${n}`,
      latestVersionNumber: 0,
      archivedAt: null,
      createdById: USER,
      createdAt: UPDATED,
      updatedAt: UPDATED,
      lastCapturedAt: null,
      lastPageChangeAt: null,
      lastPageChangeVersionNumber: null,
      lastPageChangeKind: null,
      lastPageChangePreviousCaptureAt: null,
      ...extra,
    };
    sources.push(row);
    return row;
  };
  // one capture: what decides its transition, and when it was fetched
  const addVersion = (
    source: Row,
    n: number,
    contentHash: string,
    extra: Partial<Row> = {}
  ) => {
    const row: Row = {
      id: versionId(source.id, n),
      organizationId: source.organizationId,
      sourceId: source.id,
      versionNumber: n,
      contentHash,
      title: 'Title',
      extractionVersion: V2,
      fetchedAt: new Date(NOW - 40 * DAY + n * HOUR),
      sourceHash: hash('f'),
      content: '{"schemaVersion":1,"blocks":[]}',
      ...extra,
    };
    versions.push(row);
    if (n > source.latestVersionNumber) {
      source.latestVersionNumber = n;
    }
    return row;
  };
  const sourceDelegate = {
    findFirst: jest.fn(async (args: { where: Row; select: Row }) => {
      const row = sources.find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
    findMany: jest.fn(
      async (args: {
        where: Row;
        orderBy: Row | Row[];
        select: Row;
        skip?: number;
        take: number;
      }) =>
        order(
          sources.filter((r) => matches(r, args.where)),
          args.orderBy
        )
          .slice(args.skip ?? 0, (args.skip ?? 0) + args.take)
          .map((r) => pick(r, args.select))
    ),
    count: jest.fn(
      async (args: { where: Row }) =>
        sources.filter((r) => matches(r, args.where)).length
    ),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const rows = sources.filter((r) => matches(r, args.where));
      for (const row of rows) {
        // like Prisma: updatedAt moves unless it is written
        Object.assign(row, { updatedAt: new Date(NOW) }, args.data);
      }
      return { count: rows.length };
    }),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const versionDelegate = {
    findMany: jest.fn(
      async (args: { where: Row; orderBy?: Row; select: Row; take?: number }) =>
        order(
          versions.filter((r) => matches(r, args.where)),
          args.orderBy
        )
          .slice(0, args.take ?? Infinity)
          .map((r) => pick(r, args.select))
    ),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const transaction = { $transaction: jest.fn() };
  const repository = new ContentStudioSourceRepository(
    {
      model: { contentStudioSource: sourceDelegate },
    } as unknown as PrismaRepository<'contentStudioSource'>,
    {
      model: { contentStudioSourceVersion: versionDelegate },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository({
    model: { contentStudioSourceDiscovery: {} },
  } as unknown as PrismaRepository<'contentStudioSourceDiscovery'>);
  const captureAttempts = new ContentStudioSourceCaptureAttemptRepository({
    model: { contentStudioSourceCaptureAttempt: {} },
  } as unknown as PrismaRepository<'contentStudioSourceCaptureAttempt'>);
  const service = new ContentStudioSourceService(
    repository,
    discoveries,
    captureAttempts
  );
  // every page, as the command runs it
  const backfill = async () => {
    const total = { updated: 0, unchanged: 0, failed: [] as string[] };
    let afterId: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof service.backfillPageChanges>> =
        await service.backfillPageChanges({ afterId });
      total.updated += page.updated;
      total.unchanged += page.unchanged;
      total.failed.push(...page.failed);
      afterId = page.next;
      pages += 1;
    } while (afterId);
    return { ...total, pages };
  };
  const stored = (row: Row) => [
    row.lastPageChangeAt,
    row.lastPageChangeVersionNumber,
    row.lastPageChangeKind,
    row.lastPageChangePreviousCaptureAt,
  ];
  return {
    sources,
    versions,
    addSource,
    addVersion,
    sourceDelegate,
    versionDelegate,
    transaction,
    service,
    backfill,
    stored,
  };
};

const NONE = [null, null, null, null];

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    return {
      status: (err as HttpException).getStatus(),
      body: (err as HttpException).getResponse(),
    };
  }
  throw new Error('expected a refusal');
};
const INTEGRITY = {
  status: 500,
  body: {
    msg: 'Stored source data could not be verified.',
    code: 'CS_SOURCE_INTEGRITY_ERROR',
  },
};

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('page-change backfill', () => {
  it('B1/B2 a first capture alone, or followed by repeats, has no page change', async () => {
    const t = setup();
    const only = t.addSource(1);
    t.addVersion(only, 1, hash('a'));
    const repeats = t.addSource(2);
    for (const n of [1, 2, 3]) {
      t.addVersion(repeats, n, hash('a'));
    }
    const empty = t.addSource(3);
    expect(await t.backfill()).toMatchObject({
      updated: 0,
      unchanged: 3,
      failed: [],
    });
    for (const row of [only, repeats, empty]) {
      expect(t.stored(row)).toEqual(NONE);
    }
    expect(t.sourceDelegate.updateMany).not.toHaveBeenCalled();
  });

  it('B3/B4 a title or a blocks change is the page change, after the version just before it', async () => {
    const t = setup();
    const title = t.addSource(1);
    const [, , v3] = [
      t.addVersion(title, 1, hash('a')),
      t.addVersion(title, 2, hash('a')),
      t.addVersion(title, 3, hash('a'), { title: 'Other' }),
    ];
    const content = t.addSource(2);
    const c1 = t.addVersion(content, 1, hash('a'));
    const c2 = t.addVersion(content, 2, hash('b'), { title: 'Other' });
    expect(await t.backfill()).toMatchObject({ updated: 2, failed: [] });
    expect(t.stored(title)).toEqual([
      v3.fetchedAt,
      3,
      'title_changed',
      // the repeat just before it, not the first of its run
      t.versions[1].fetchedAt,
    ]);
    expect(t.stored(content)).toEqual([
      c2.fetchedAt,
      2,
      'content_changed',
      c1.fetchedAt,
    ]);
  });

  it('B5/B7 another extraction version is never a page change, whatever else differs', async () => {
    const t = setup();
    const row = t.addSource(1);
    t.addVersion(row, 1, hash('a'), { extractionVersion: V1 });
    t.addVersion(row, 2, hash('b'), { title: 'New title' });
    t.addVersion(row, 3, hash('b'), { title: 'New title' });
    expect(await t.backfill()).toMatchObject({ updated: 0, unchanged: 1 });
    expect(t.stored(row)).toEqual(NONE);
  });

  it('B6 content, extraction, title: the title version, after the extraction one', async () => {
    const t = setup();
    const row = t.addSource(1);
    t.addVersion(row, 1, hash('a'), { extractionVersion: V1 });
    t.addVersion(row, 2, hash('b'), { extractionVersion: V1 });
    const extraction = t.addVersion(row, 3, hash('c'));
    const title = t.addVersion(row, 4, hash('c'), { title: 'Retitled' });
    await t.backfill();
    expect(t.stored(row)).toEqual([
      title.fetchedAt,
      4,
      'title_changed',
      extraction.fetchedAt,
    ]);
  });

  it('B8 a gap in the numbers compares with the version before it that exists', async () => {
    const t = setup();
    const row = t.addSource(1);
    const v1 = t.addVersion(row, 1, hash('a'));
    const v4 = t.addVersion(row, 4, hash('b'));
    t.addVersion(row, 7, hash('b'));
    expect(row.latestVersionNumber).toBe(7);
    await t.backfill();
    expect(t.stored(row)).toEqual([
      v4.fetchedAt,
      4,
      'content_changed',
      v1.fetchedAt,
    ]);
  });

  it('B9 a second run writes nothing', async () => {
    const t = setup();
    for (let n = 1; n <= 5; n++) {
      const row = t.addSource(n);
      t.addVersion(row, 1, hash('a'));
      t.addVersion(row, 2, n % 2 ? hash('b') : hash('a'));
    }
    expect(await t.backfill()).toMatchObject({ updated: 3, unchanged: 2 });
    t.sourceDelegate.updateMany.mockClear();
    expect(await t.backfill()).toMatchObject({
      updated: 0,
      unchanged: 5,
      failed: [],
    });
    expect(t.sourceDelegate.updateMany).not.toHaveBeenCalled();
  });

  it('B10 a source a capture changed meanwhile is read again and written for its new version', async () => {
    const t = setup();
    const row = t.addSource(1);
    t.addVersion(row, 1, hash('a'));
    t.addVersion(row, 2, hash('b'));
    // the capture lands between the read of the versions and the write
    const read = t.versionDelegate.findMany.getMockImplementation()!;
    let raced = false;
    t.versionDelegate.findMany.mockImplementation(async (args) => {
      const result = await read(args);
      if (!raced) {
        raced = true;
        t.addVersion(row, 3, hash('c'));
        row.updatedAt = new Date(NOW - HOUR);
      }
      return result;
    });
    expect(await t.backfill()).toMatchObject({ updated: 1, failed: [] });
    expect(t.stored(row)).toEqual([
      t.versions[2].fetchedAt,
      3,
      'content_changed',
      t.versions[1].fetchedAt,
    ]);
    // three tries at most: one that keeps losing fails, and nothing is written
    const lost = t.addSource(2);
    t.addVersion(lost, 1, hash('a'));
    t.addVersion(lost, 2, hash('b'));
    t.sourceDelegate.updateMany.mockClear();
    t.sourceDelegate.updateMany.mockResolvedValue({ count: 0 });
    const page = await t.service.backfillPageChanges({ afterId: row.id });
    expect(page.failed).toEqual([lost.id]);
    expect(t.sourceDelegate.updateMany).toHaveBeenCalledTimes(3);
    expect(t.stored(lost)).toEqual(NONE);
  });

  it('B11 the backfill keeps updatedAt exactly, and writes only the four fields', async () => {
    const t = setup();
    const row = t.addSource(1, {
      updatedAt: new Date('2026-03-04T05:06:07.089Z'),
    });
    t.addVersion(row, 1, hash('a'));
    t.addVersion(row, 2, hash('b'));
    await t.backfill();
    expect(row.updatedAt).toEqual(new Date('2026-03-04T05:06:07.089Z'));
    expect(t.sourceDelegate.updateMany).toHaveBeenCalledTimes(1);
    expect(t.sourceDelegate.updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: row.id,
        organizationId: ORG,
        kind: 'url',
        latestVersionNumber: 2,
        updatedAt: new Date('2026-03-04T05:06:07.089Z'),
      },
      data: {
        lastPageChangeAt: t.versions[1].fetchedAt,
        lastPageChangeVersionNumber: 2,
        lastPageChangeKind: 'content_changed',
        lastPageChangePreviousCaptureAt: t.versions[0].fetchedAt,
        updatedAt: new Date('2026-03-04T05:06:07.089Z'),
      },
    });
  });

  it('B12 wrong or half-written fields are repaired, to none when there is no page change', async () => {
    const t = setup();
    const stale = t.addSource(1, {
      lastPageChangeAt: new Date(NOW),
      lastPageChangeVersionNumber: 2,
      lastPageChangeKind: 'content_changed',
      lastPageChangePreviousCaptureAt: new Date(NOW - DAY),
    });
    t.addVersion(stale, 1, hash('a'));
    t.addVersion(stale, 2, hash('a'));
    const half = t.addSource(2, { lastPageChangeKind: 'title_changed' });
    t.addVersion(half, 1, hash('a'));
    const wrongKind = t.addSource(3);
    const w1 = t.addVersion(wrongKind, 1, hash('a'));
    const w2 = t.addVersion(wrongKind, 2, hash('b'));
    Object.assign(wrongKind, {
      lastPageChangeAt: w2.fetchedAt,
      lastPageChangeVersionNumber: 2,
      lastPageChangeKind: 'extraction_changed',
      lastPageChangePreviousCaptureAt: w1.fetchedAt,
    });
    expect(await t.backfill()).toMatchObject({ updated: 3, failed: [] });
    expect(t.stored(stale)).toEqual(NONE);
    expect(t.stored(half)).toEqual(NONE);
    expect(t.stored(wrongKind)).toEqual([
      w2.fetchedAt,
      2,
      'content_changed',
      w1.fetchedAt,
    ]);
  });

  it('B13 a source whose versions do not end at its current version is reported and never written', async () => {
    const t = setup();
    const row = t.addSource(1);
    t.addVersion(row, 1, hash('a'));
    t.addVersion(row, 2, hash('b'));
    row.latestVersionNumber = 3;
    const fine = t.addSource(2);
    t.addVersion(fine, 1, hash('a'));
    t.addVersion(fine, 2, hash('b'));
    expect(await t.backfill()).toMatchObject({
      updated: 1,
      failed: [row.id],
    });
    expect(t.stored(row)).toEqual(NONE);
    expect(t.stored(fine)[1]).toBe(2);
  });

  it('B14 archived sources and every organization are backfilled; feeds are never read', async () => {
    const t = setup();
    const archived = t.addSource(1, { archivedAt: new Date(NOW - DAY) });
    t.addVersion(archived, 1, hash('a'));
    t.addVersion(archived, 2, hash('b'));
    const other = t.addSource(2, { organizationId: OTHER_ORG });
    t.addVersion(other, 1, hash('a'));
    t.addVersion(other, 2, hash('a'), { title: 'Other' });
    const feed = t.addSource(3, { kind: 'feed' });
    expect(await t.backfill()).toMatchObject({ updated: 2, unchanged: 0 });
    expect(t.stored(archived)[2]).toBe('content_changed');
    expect(t.stored(other)[2]).toBe('title_changed');
    expect(t.stored(feed)).toEqual(NONE);
    for (const call of t.sourceDelegate.findMany.mock.calls) {
      expect(call[0].where.kind).toBe('url');
    }
  });

  it('B15 reads the versions in pages of 1000, oldest first, without content or the fetched-bytes hash', async () => {
    const t = setup();
    const row = t.addSource(1);
    for (let n = 1; n <= 2500; n++) {
      // one change at 2400, in the third page; repeats after it
      t.addVersion(row, n, n >= 2400 ? hash('b') : hash('a'));
    }
    await t.backfill();
    expect(t.stored(row)[1]).toBe(2400);
    expect(t.versionDelegate.findMany).toHaveBeenCalledTimes(3);
    expect(
      t.versionDelegate.findMany.mock.calls.map((call) => [
        call[0].where.versionNumber,
        call[0].take,
      ])
    ).toEqual([
      [{ gt: 0 }, 1000],
      [{ gt: 1000 }, 1000],
      [{ gt: 2000 }, 1000],
    ]);
    for (const call of t.versionDelegate.findMany.mock.calls) {
      expect(call[0].select).toEqual({
        versionNumber: true,
        contentHash: true,
        title: true,
        extractionVersion: true,
        fetchedAt: true,
      });
      expect(call[0].orderBy).toEqual({ versionNumber: 'asc' });
      expect(call[0].where).toMatchObject({
        organizationId: ORG,
        sourceId: row.id,
      });
    }
  });

  it('pages the sources by id, 100 at a time, and ignores a malformed cursor', async () => {
    const t = setup();
    for (let n = 1; n <= 205; n++) {
      t.addSource(n);
    }
    expect(await t.backfill()).toMatchObject({ unchanged: 205, pages: 3 });
    expect(
      t.sourceDelegate.findMany.mock.calls.map((call) => [
        call[0].where.id ?? null,
        call[0].take,
        call[0].orderBy,
      ])
    ).toEqual([
      [null, 100, { id: 'asc' }],
      [{ gt: sourceId(100) }, 100, { id: 'asc' }],
      [{ gt: sourceId(200) }, 100, { id: 'asc' }],
    ]);
    t.sourceDelegate.findMany.mockClear();
    const page = await t.service.backfillPageChanges({
      afterId: "x' OR 1=1 --",
    });
    expect(t.sourceDelegate.findMany.mock.calls[0][0].where.id).toBeUndefined();
    expect(page.next).toBe(sourceId(100));
  });
});

describe('organization page changes', () => {
  // a source whose last page change is `ago` before now, as the backfill or
  // a capture leaves it
  const changed = (
    t: ReturnType<typeof setup>,
    n: number,
    ago: number,
    extra: Partial<Row> = {}
  ) => {
    const row = t.addSource(n, extra);
    const v1 = t.addVersion(row, 1, hash('a'), {
      fetchedAt: new Date(NOW - ago - HOUR),
    });
    const v2 = t.addVersion(row, 2, hash('b'), {
      fetchedAt: new Date(NOW - ago),
    });
    Object.assign(row, {
      lastPageChangeAt: v2.fetchedAt,
      lastPageChangeVersionNumber: 2,
      lastPageChangeKind: 'content_changed',
      lastPageChangePreviousCaptureAt: v1.fetchedAt,
    });
    return row;
  };
  const list = (
    t: ReturnType<typeof setup>,
    input: { page?: number; since?: '24h' | '7d' | '30d' | 'all' } = {}
  ) => t.service.listPageChanges({ organizationId: ORG, page: 1, ...input });

  it('C1/C2/C18 newest change first, ties by source id, with the version to open and nothing else', async () => {
    const t = setup();
    changed(t, 3, 2 * HOUR);
    changed(t, 2, 2 * HOUR);
    changed(t, 1, HOUR, { name: '<b>Pricing</b>' });
    const result = await list(t);
    expect(result.results.map((r) => r.source.id)).toEqual([
      sourceId(1),
      sourceId(2),
      sourceId(3),
    ]);
    expect(result).toMatchObject({ pages: 1, total: 3 });
    expect(result.results[0]).toEqual({
      source: {
        id: sourceId(1),
        name: '<b>Pricing</b>',
        canonicalUrl: 'https://example.com/page-1',
        archivedAt: null,
      },
      change: 'content_changed',
      changedAt: new Date(NOW - HOUR),
      previousCaptureAt: new Date(NOW - 2 * HOUR),
      version: { id: versionId(sourceId(1), 2), versionNumber: 2 },
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(
      /organizationId|createdById|contentHash|sourceHash|extractionVersion|content-studio-source|latestVersionNumber|"content"|blocks|ffff/
    );
    expect(t.sourceDelegate.findMany.mock.calls[0][0].orderBy).toEqual([
      { lastPageChangeAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('C3-C6 seven days by default; 24 hours, 30 days and all time by the last page change', async () => {
    const t = setup();
    changed(t, 1, 2 * HOUR);
    changed(t, 2, 3 * DAY);
    changed(t, 3, 10 * DAY);
    changed(t, 4, 100 * DAY);
    const ids = async (since?: '24h' | '7d' | '30d' | 'all') =>
      (await list(t, since ? { since } : {})).results.map((r) =>
        Number(r.source.id.slice(0, 8))
      );
    expect(await ids()).toEqual([1, 2]);
    expect(await ids('24h')).toEqual([1]);
    expect(await ids('7d')).toEqual([1, 2]);
    expect(await ids('30d')).toEqual([1, 2, 3]);
    expect(await ids('all')).toEqual([1, 2, 3, 4]);
    expect(t.sourceDelegate.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      kind: 'url',
      lastPageChangeAt: { gte: new Date(NOW - 7 * DAY) },
    });
    expect(t.sourceDelegate.findMany.mock.calls[4][0].where).toEqual({
      organizationId: ORG,
      kind: 'url',
      lastPageChangeAt: { not: null },
    });
  });

  it('C7/C8 a title change says so; a source without a page change is not listed', async () => {
    const t = setup();
    const title = changed(t, 1, HOUR);
    title.lastPageChangeKind = 'title_changed';
    const none = t.addSource(2);
    t.addVersion(none, 1, hash('a'));
    t.addVersion(none, 2, hash('a'));
    t.addVersion(none, 3, hash('a'), { extractionVersion: V1 });
    const result = await list(t, { since: 'all' });
    expect(result.results.map((r) => [r.source.id, r.change])).toEqual([
      [sourceId(1), 'title_changed'],
    ]);
  });

  it("C9 another organization's changes are neither listed nor counted, and its versions never read", async () => {
    const t = setup();
    changed(t, 1, HOUR);
    changed(t, 2, HOUR, { organizationId: OTHER_ORG });
    const result = await list(t);
    expect(result.total).toBe(1);
    expect(result.results.map((r) => r.source.id)).toEqual([sourceId(1)]);
    expect(t.sourceDelegate.count.mock.calls[0][0].where.organizationId).toBe(
      ORG
    );
    expect(t.versionDelegate.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      OR: [{ sourceId: sourceId(1), versionNumber: 2 }],
    });
  });

  it('C10 pages of 50', async () => {
    const t = setup();
    for (let n = 1; n <= 120; n++) {
      changed(t, n, n * 60_000);
    }
    const first = await list(t);
    expect(first).toMatchObject({ pages: 3, total: 120 });
    expect(first.results).toHaveLength(50);
    const third = await list(t, { page: 3 });
    expect(third.results.map((r) => Number(r.source.id.slice(0, 8)))).toEqual(
      Array.from({ length: 20 }, (_, i) => 101 + i)
    );
    expect(t.sourceDelegate.findMany.mock.calls[1][0]).toMatchObject({
      skip: 100,
      take: 50,
    });
  });

  it('C11/C12 an archived page is listed; a feed never is', async () => {
    const t = setup();
    changed(t, 1, HOUR, { archivedAt: new Date(NOW - 30 * 60_000) });
    changed(t, 2, HOUR, { kind: 'feed' });
    const result = await list(t);
    expect(
      result.results.map((r) => [r.source.id, r.source.archivedAt])
    ).toEqual([[sourceId(1), new Date(NOW - 30 * 60_000)]]);
    expect(result.total).toBe(1);
  });

  it('C13-C16 stored fields that are not what a capture writes fail the request', async () => {
    const cases: Array<
      [string, (row: Row, t: ReturnType<typeof setup>) => void]
    > = [
      [
        'I1 a missing version number',
        (row) => (row.lastPageChangeVersionNumber = null),
      ],
      ['I1 a missing kind', (row) => (row.lastPageChangeKind = null)],
      [
        'I1 a missing previous capture',
        (row) => (row.lastPageChangePreviousCaptureAt = null),
      ],
      [
        'I2 extraction_changed',
        (row) => (row.lastPageChangeKind = 'extraction_changed'),
      ],
      ['I2 an unknown kind', (row) => (row.lastPageChangeKind = 'changed')],
      ['I3 version 1', (row) => (row.lastPageChangeVersionNumber = 1)],
      [
        'I3 a version after the latest',
        (row) => (row.lastPageChangeVersionNumber = 3),
      ],
      // the bounds are checked by themselves, even when the version exists
      // at the stored time
      [
        'I3 version 1 at its own time',
        (row, t) => {
          const v1 = t.versions.find(
            (v) => v.sourceId === row.id && v.versionNumber === 1
          )!;
          row.lastPageChangeVersionNumber = 1;
          row.lastPageChangeAt = v1.fetchedAt;
        },
      ],
      [
        'I3 a version after the current one, at its own time',
        (row) => (row.latestVersionNumber = 1),
      ],
      [
        'I3 not a whole number',
        (row) => (row.lastPageChangeVersionNumber = 1.5),
      ],
      [
        'I5 the version is missing',
        (row, t) =>
          t.versions.splice(
            t.versions.findIndex(
              (v) => v.sourceId === row.id && v.versionNumber === 2
            ),
            1
          ),
      ],
      [
        'I5 another fetch time',
        (row, t) =>
          (t.versions.find(
            (v) => v.sourceId === row.id && v.versionNumber === 2
          )!.fetchedAt = new Date(NOW)),
      ],
      [
        'I5 a version of another organization',
        (row, t) =>
          (t.versions.find(
            (v) => v.sourceId === row.id && v.versionNumber === 2
          )!.organizationId = OTHER_ORG),
      ],
    ];
    for (const [name, corrupt] of cases) {
      const t = setup();
      changed(t, 1, HOUR);
      const row = changed(t, 2, 2 * HOUR);
      corrupt(row, t);
      expect([name, await refusal(list(t))]).toEqual([name, INTEGRITY]);
    }
  });

  it('C16 one version per row: a second match is an integrity failure, not a choice', async () => {
    const t = setup();
    const row = changed(t, 1, HOUR);
    t.versions.push({ ...t.versions[1], id: versionId(row.id, 9) });
    expect(await refusal(list(t))).toEqual(INTEGRITY);
  });

  it('C17 three queries for a page of changes, two for an empty one; read only', async () => {
    const t = setup();
    for (let n = 1; n <= 50; n++) {
      changed(t, n, n * 60_000);
    }
    await list(t);
    expect(t.sourceDelegate.findMany).toHaveBeenCalledTimes(1);
    expect(t.sourceDelegate.count).toHaveBeenCalledTimes(1);
    expect(t.versionDelegate.findMany).toHaveBeenCalledTimes(1);
    expect(t.versionDelegate.findMany.mock.calls[0][0].where.OR).toHaveLength(
      50
    );
    expect(t.versionDelegate.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      sourceId: true,
      versionNumber: true,
      fetchedAt: true,
    });
    for (const fn of [
      t.sourceDelegate.updateMany,
      t.sourceDelegate.create,
      t.versionDelegate.create,
      t.versionDelegate.findFirst,
      t.transaction.$transaction,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    const empty = setup();
    expect(await list(empty)).toEqual({ pages: 0, total: 0, results: [] });
    expect(empty.versionDelegate.findMany).not.toHaveBeenCalled();
  });
});

describe('page-change boundary', () => {
  const service = fs.readFileSync(
    path.join(__dirname, 'content-studio.source.service.ts'),
    'utf8'
  );

  it('the backfill and the Changes read classify with the one shared rule', () => {
    expect(service).toMatch(
      /import \{\s*classifyContentStudioSourceCaptureTransition,\s*compareContentStudioSourceVersions,\s*ContentStudioComparedSourceVersion,\s*isContentStudioSourcePageChange,\s*\} from '@gitroom\/nestjs-libraries\/content-studio\/sources\/source\.change';/
    );
    expect(service).not.toMatch(/extractionVersion !==|contentHash !==/);
  });
});

// The operator command (apps/commands): every page until the last, a summary,
// a failing exit code when a source failed. Run by hand only
describe('the page-change backfill command', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    ContentStudioPageChangesBackfill,
  } = require('../../../../../../apps/commands/src/tasks/content.studio.page.changes');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    COMMAND_HANDLER_METADATA,
  } = require('nestjs-command/dist/command.decorator');
  const pages = (
    results: Array<{
      next: string | null;
      updated: number;
      unchanged: number;
      failed: string[];
    }>
  ) => {
    const backfillPageChanges = jest.fn();
    for (const result of results) {
      backfillPageChanges.mockResolvedValueOnce(result);
    }
    return {
      service: { backfillPageChanges },
      command: new ContentStudioPageChangesBackfill({ backfillPageChanges }),
    };
  };
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitCode;
  });

  it('CMD1 is the content-studio:backfill-page-changes command, with an --after option only', () => {
    const metadata = Reflect.getMetadata(
      COMMAND_HANDLER_METADATA,
      ContentStudioPageChangesBackfill.prototype.backfill
    );
    expect(metadata.option.command).toBe(
      'content-studio:backfill-page-changes'
    );
    expect(
      Object.values(metadata.params)
        .flat()
        .map((param: any) => param.option.name)
    ).toEqual(['after']);
    // CMD5 nothing runs it on its own: no lifecycle hook, timer or schedule
    expect(
      Object.getOwnPropertyNames(
        ContentStudioPageChangesBackfill.prototype
      ).sort()
    ).toEqual(['backfill', 'constructor']);
  });

  it('CMD2/CMD3 reads every page until the last, then prints the totals', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { service, command } = pages([
      { next: sourceId(100), updated: 3, unchanged: 97, failed: [] },
      { next: sourceId(200), updated: 1, unchanged: 99, failed: [] },
      { next: null, updated: 0, unchanged: 5, failed: [] },
    ]);
    await expect(command.backfill()).resolves.toBe(true);
    expect(service.backfillPageChanges.mock.calls).toEqual([
      [{ afterId: null }],
      [{ afterId: sourceId(100) }],
      [{ afterId: sourceId(200) }],
    ]);
    expect(log.mock.calls[log.mock.calls.length - 1]).toEqual([
      'Page changes backfill complete: 4 updated, 201 unchanged, 0 failed.',
    ]);
    expect(log.mock.calls[0][0]).toContain(sourceId(100));
    expect(process.exitCode).toBe(exitCode);
  });

  it('CMD4 a source that failed is printed by id and makes the exit code 1; the run goes on', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { service, command } = pages([
      { next: sourceId(100), updated: 0, unchanged: 99, failed: [sourceId(7)] },
      { next: null, updated: 1, unchanged: 0, failed: [] },
    ]);
    await command.backfill();
    expect(service.backfillPageChanges).toHaveBeenCalledTimes(2);
    expect(error.mock.calls).toEqual([
      ['Source could not be backfilled:', sourceId(7)],
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('continues after the source id it is given', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { service, command } = pages([
      { next: null, updated: 0, unchanged: 1, failed: [] },
    ]);
    await command.backfill(sourceId(300));
    expect(service.backfillPageChanges).toHaveBeenCalledWith({
      afterId: sourceId(300),
    });
  });
});
