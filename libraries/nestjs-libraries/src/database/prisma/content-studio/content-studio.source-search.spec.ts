import { HttpException } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { CONTENT_STUDIO_SOURCE_SEARCH_MAX } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

// Source search (P8-03) with the real service and repository over an
// in-memory Prisma that implements exactly the filters the list uses:
// organizationId, archivedAt, kind and an OR of case-insensitive contains.
// Real Prisma and PostgreSQL semantics (wildcards, the planner) are in the
// Phase 8 handoff PostgreSQL suite

type Row = Record<string, any>;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const BASE = new Date('2026-10-22T12:00:00.000Z').getTime();
const MINUTE = 60 * 1000;

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const setup = () => {
  const rows: Row[] = [];
  const add = (
    n: number,
    name: string,
    extra: Partial<Row> = {},
    minutesAgo = n
  ) =>
    rows.push({
      id: id(n),
      organizationId: ORG,
      kind: 'url',
      name,
      canonicalUrl: `https://${name
        .toLowerCase()
        .replace(/\W+/g, '-')}.example.com/p/${n}`,
      latestVersionNumber: 1,
      archivedAt: null,
      createdAt: new Date(BASE - 1000 * MINUTE),
      updatedAt: new Date(BASE - minutesAgo * MINUTE),
      lastCapturedAt: null,
      ...extra,
    });
  const text = (row: Row, key: string, condition: Row) => {
    if (Object.keys(condition).sort().join() !== 'contains,mode') {
      throw new Error(`unsupported text condition on ${key}`);
    }
    if (condition.mode !== 'insensitive') {
      return (
        typeof row[key] === 'string' && row[key].includes(condition.contains)
      );
    }
    return (
      typeof row[key] === 'string' &&
      row[key].toLowerCase().includes(String(condition.contains).toLowerCase())
    );
  };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, condition]) => {
      // like Prisma, a field left undefined filters nothing
      if (condition === undefined) {
        return true;
      }
      if (key === 'OR') {
        return (condition as Row[]).some((part) => matches(row, part));
      }
      if (condition === null) {
        return row[key] === null;
      }
      if (typeof condition === 'object') {
        if ('not' in condition && condition.not === null) {
          return row[key] !== null;
        }
        return text(row, key, condition);
      }
      return row[key] === condition;
    });
  const ordered = (where: Row) =>
    rows
      .filter((row) => matches(row, where))
      .sort(
        (a, b) =>
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
  const source = {
    findMany: jest.fn(
      async (args: { where: Row; skip: number; take: number; select: Row }) =>
        ordered(args.where)
          .slice(args.skip, args.skip + args.take)
          .map((row) =>
            Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]))
          )
    ),
    count: jest.fn(async (args: { where: Row }) => ordered(args.where).length),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const version = { findMany: jest.fn(), findFirst: jest.fn() };
  const discovery = { findMany: jest.fn(), count: jest.fn() };
  const transaction = { $transaction: jest.fn() };
  const repository = new ContentStudioSourceRepository(
    {
      model: { contentStudioSource: source },
    } as unknown as PrismaRepository<'contentStudioSource'>,
    {
      model: { contentStudioSourceVersion: version },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository({
    model: { contentStudioSourceDiscovery: discovery },
  } as unknown as PrismaRepository<'contentStudioSourceDiscovery'>);
  const service = new ContentStudioSourceService(repository, discoveries);
  return { rows, add, source, version, discovery, transaction, service };
};
type Context = ReturnType<typeof setup>;

// 60 sources: 44 recent feed pages ahead of the curated ones
const library = (ctx: Context) => {
  for (let n = 1; n <= 44; n++) {
    ctx.add(n, `Found page ${n}`);
  }
  ctx.add(45, 'Curated Quarterly Brief', {
    canonicalUrl: 'https://research.acme.test/briefs/q3-outlook',
  });
  for (let n = 46; n <= 58; n++) {
    ctx.add(n, `Older page ${n}`);
  }
  ctx.add(59, 'Quarterly feed', {
    kind: 'feed',
    canonicalUrl: 'https://research.acme.test/feed.xml',
    latestVersionNumber: 0,
  });
  ctx.add(60, 'Archived Quarterly notes', {
    archivedAt: new Date(BASE - 10 * MINUTE),
  });
  // another organization: the same name and address
  ctx.add(61, 'Curated Quarterly Brief', {
    organizationId: OTHER_ORG,
    canonicalUrl: 'https://research.acme.test/briefs/q3-outlook',
  });
};
const list = (ctx: Context, input: Record<string, unknown>) =>
  ctx.service.listSources({
    organizationId: ORG,
    archived: false,
    page: 1,
    ...input,
  } as Parameters<ContentStudioSourceService['listSources']>[0]);
const names = (value: { results: Array<{ name: string }> }) =>
  value.results.map((row) => row.name);
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
    ...((err as HttpException).getResponse() as object),
  };
};

describe('Source search (P8-03)', () => {
  it('S1/M5 finds a source beyond the first page by its name, on the server', async () => {
    const ctx = setup();
    library(ctx);
    const first = await list(ctx, {});
    expect(names(first)).not.toContain('Curated Quarterly Brief');
    expect(first.pages).toBe(3);
    const found = await list(ctx, { search: 'Curated' });
    expect(names(found)).toEqual(['Curated Quarterly Brief']);
    expect(found.pages).toBe(1);
  });

  it('S2 finds a source by a part of its address', async () => {
    const ctx = setup();
    library(ctx);
    expect(names(await list(ctx, { search: 'q3-outlook' }))).toEqual([
      'Curated Quarterly Brief',
    ]);
    expect(names(await list(ctx, { search: 'acme.test/briefs' }))).toEqual([
      'Curated Quarterly Brief',
    ]);
  });

  it('S3/M4 any case', async () => {
    const ctx = setup();
    library(ctx);
    for (const search of [
      'curated quarterly',
      'CURATED QUARTERLY',
      'Q3-OUTLOOK',
    ]) {
      expect(names(await list(ctx, { search }))).toEqual([
        'Curated Quarterly Brief',
      ]);
    }
  });

  it('S4/M6 kind=url leaves out a feed with the same words; no kind keeps it', async () => {
    const ctx = setup();
    library(ctx);
    expect(
      names(await list(ctx, { search: 'quarterly', kind: 'url' }))
    ).toEqual(['Curated Quarterly Brief']);
    expect(names(await list(ctx, { search: 'quarterly' })).sort()).toEqual(
      ['Curated Quarterly Brief', 'Quarterly feed'].sort()
    );
  });

  it('S5/M9 an archived source is found only among the archived', async () => {
    const ctx = setup();
    library(ctx);
    expect(names(await list(ctx, { search: 'notes' }))).toEqual([]);
    expect(names(await list(ctx, { search: 'notes', archived: true }))).toEqual(
      ['Archived Quarterly notes']
    );
  });

  it('S6/M1/M2 another organization is never listed or counted', async () => {
    const ctx = setup();
    library(ctx);
    const found = await list(ctx, { search: 'Curated Quarterly Brief' });
    expect(found.results.map((row) => row.id)).toEqual([id(45)]);
    expect(found.pages).toBe(1);
    expect(await ctx.source.count.mock.results.at(-1)!.value).toBe(1);
    for (const call of [
      ...ctx.source.findMany.mock.calls,
      ...ctx.source.count.mock.calls,
    ]) {
      expect(call[0].where.organizationId).toBe(ORG);
    }
  });

  it('S7 no search and a blank one are exactly the P8-02 query', async () => {
    const ctx = setup();
    library(ctx);
    const p802 = {
      where: { organizationId: ORG, archivedAt: null, kind: 'url' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: 20,
      take: 20,
    };
    for (const search of [undefined, null, '', '   ', '\n\t']) {
      ctx.source.findMany.mockClear();
      ctx.source.count.mockClear();
      await list(ctx, { kind: 'url', page: 2, search });
      const { select: _select, ...query } =
        ctx.source.findMany.mock.calls[0][0];
      expect(query).toStrictEqual(p802);
      expect(ctx.source.count.mock.calls[0][0]).toStrictEqual({
        where: p802.where,
      });
    }
    // and without a kind, the P3 one
    ctx.source.findMany.mockClear();
    await list(ctx, {});
    expect(ctx.source.findMany.mock.calls[0][0].where).toStrictEqual({
      organizationId: ORG,
      archivedAt: null,
    });
  });

  it('M3/M23 the list and its count share one where: name or address, any case, trimmed', async () => {
    const ctx = setup();
    library(ctx);
    await list(ctx, { search: '  Brief  ', kind: 'url', archived: true });
    const where = {
      organizationId: ORG,
      archivedAt: { not: null },
      kind: 'url',
      OR: [
        { name: { contains: 'Brief', mode: 'insensitive' } },
        { canonicalUrl: { contains: 'Brief', mode: 'insensitive' } },
      ],
    };
    expect(ctx.source.findMany.mock.calls[0][0].where).toStrictEqual(where);
    expect(ctx.source.count.mock.calls[0][0]).toStrictEqual({ where });
  });

  it('M3b % _ and \\ are escaped for ILIKE, the rest of the text as it is', async () => {
    const ctx = setup();
    await list(ctx, { search: ' 100%_a\\b ' });
    expect(ctx.source.findMany.mock.calls[0][0].where.OR).toStrictEqual([
      { name: { contains: '100\\%\\_a\\\\b', mode: 'insensitive' } },
      {
        canonicalUrl: { contains: '100\\%\\_a\\\\b', mode: 'insensitive' },
      },
    ]);
  });

  it('pages a search 20 at a time, newest change first, ties by id', async () => {
    const ctx = setup();
    for (let n = 1; n <= 45; n++) {
      // three share each minute
      ctx.add(n, `Market note ${n}`, {}, Math.ceil(n / 3));
    }
    const pages = [
      await list(ctx, { search: 'market', page: 1 }),
      await list(ctx, { search: 'market', page: 2 }),
      await list(ctx, { search: 'market', page: 3 }),
    ];
    expect(pages.map((page) => page.pages)).toEqual([3, 3, 3]);
    expect(pages.map((page) => page.results.length)).toEqual([20, 20, 5]);
    const all = pages.flatMap((page) => page.results.map((row) => row.id));
    expect(new Set(all).size).toBe(45);
    expect(all).toEqual(Array.from({ length: 45 }, (_, i) => id(i + 1)));
  });

  it.each([
    [
      'S8/M21 longer than 100 characters',
      'x'.repeat(CONTENT_STUDIO_SOURCE_SEARCH_MAX + 1),
    ],
    ['S9 not text', ['a']],
    ['S9 an object', { contains: 'a' }],
    ['S10/M22 NUL', 'brief\u0000'],
    ['an unpaired surrogate', 'brief\uD800'],
  ])(
    '%s is refused with a fixed message and nothing is read',
    async (_, search) => {
      const ctx = setup();
      library(ctx);
      expect(await refusal(list(ctx, { search }))).toEqual({
        status: 400,
        code: 'CS_SOURCE_SEARCH_INVALID',
        msg: 'The search is invalid.',
      });
      expect(ctx.source.findMany).not.toHaveBeenCalled();
      expect(ctx.source.count).not.toHaveBeenCalled();
    }
  );

  it('exactly 100 characters is a search', async () => {
    const ctx = setup();
    library(ctx);
    const value = await list(ctx, {
      search: 'y'.repeat(CONTENT_STUDIO_SOURCE_SEARCH_MAX),
    });
    expect(value).toEqual({ pages: 0, results: [] });
  });

  it('P803PG7 (unit) a search only reads', async () => {
    const ctx = setup();
    library(ctx);
    await list(ctx, { search: 'brief' });
    for (const name of [
      'create',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      'findFirst',
    ] as const) {
      expect([name, ctx.source[name].mock.calls]).toEqual([name, []]);
    }
    expect(ctx.transaction.$transaction).not.toHaveBeenCalled();
    expect(ctx.version.findMany).not.toHaveBeenCalled();
    expect(ctx.discovery.findMany).not.toHaveBeenCalled();
  });
});
