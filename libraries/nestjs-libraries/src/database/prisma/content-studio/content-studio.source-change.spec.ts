import fs from 'fs';
import path from 'path';
import { HttpException } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { ContentStudioSourceBlock } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';

// What changed in a source version (P8-04A) with the real service and
// repository over an in-memory Prisma that implements exactly the filters the
// two lookups use, with SQL's null rules: `title <> 'x'` and `title < 1` are
// never true for a null. Anything else throws, so a lookup that is written
// another way fails here. Real Prisma and PostgreSQL are in the P8-04A
// PostgreSQL suite

type Row = Record<string, any>;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const OTHER_SOURCE = '44444444-4444-4444-8444-444444444444';
const FEED = '55555555-5555-4555-8555-555555555555';
const USER = '66666666-6666-4666-8666-666666666666';
const V2 = 'content-studio-source-v2';
const V1 = 'content-studio-source-v1';
const BASE = new Date('2026-10-22T08:00:00.000Z').getTime();
const MARKER = 'SOURCE_CHANGE_SECRET_MARKER_804';

const versionId = (source: string, n: number) =>
  `${source.slice(0, 8)}-${String(n).padStart(4, '0')}-4000-8000-000000000000`;

const blocks = (...texts: string[]): ContentStudioSourceBlock[] =>
  texts.map((text, i) => ({
    id: `b${i + 1}`,
    type: 'paragraph',
    text,
    level: null,
  }));

const compare = (row: Row, key: string, condition: unknown): boolean => {
  const value = row[key];
  if (condition === null) {
    return value === null;
  }
  if (typeof condition !== 'object') {
    // equality: never true for a null
    return value !== null && value === condition;
  }
  const parts = condition as Row;
  for (const operator of Object.keys(parts)) {
    if (!['not', 'lt', 'gt', 'in'].includes(operator)) {
      throw new Error(`unsupported operator ${operator} on ${key}`);
    }
  }
  if ('not' in parts) {
    if (
      parts.not === null
        ? value === null
        : value === null || value === parts.not
    ) {
      return false;
    }
  }
  if ('lt' in parts && !(value !== null && value < parts.lt)) {
    return false;
  }
  if ('gt' in parts && !(value !== null && value > parts.gt)) {
    return false;
  }
  if ('in' in parts && !(parts.in as unknown[]).includes(value)) {
    return false;
  }
  return true;
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
    if (key === 'NOT' || key === 'AND') {
      throw new Error(`unsupported ${key}`);
    }
    return compare(row, key, condition);
  });

const pick = (row: Row, select: Row) =>
  Object.fromEntries(
    Object.keys(select).map((key) => [
      key,
      key === 'source' ? { name: 'unused' } : row[key],
    ])
  );

const setup = () => {
  const sources: Row[] = [];
  const versions: Row[] = [];
  const addSource = (extra: Partial<Row> = {}) => {
    const row = {
      id: SOURCE,
      organizationId: ORG,
      kind: 'url',
      name: 'Pricing page',
      canonicalUrl: 'https://example.com/pricing',
      latestVersionNumber: 0,
      archivedAt: null,
      createdById: USER,
      createdAt: new Date(BASE),
      updatedAt: new Date(BASE),
      lastCapturedAt: null,
      ...extra,
    };
    sources.push(row);
    return row;
  };
  // a version as a capture stores it: canonical content and its hash
  const addVersion = (
    n: number,
    content: ContentStudioSourceBlock[],
    extra: Partial<Row> = {}
  ) => {
    const sourceId = extra.sourceId ?? SOURCE;
    const row = {
      id: versionId(sourceId, n),
      organizationId: ORG,
      sourceId,
      versionNumber: n,
      requestedUrl: 'https://example.com/pricing',
      finalUrl: 'https://example.com/pricing',
      redirectCount: 0,
      fetchedAt: new Date(BASE + n * 60_000),
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 1000,
      title: 'Pricing',
      sourceHash: 'f'.repeat(64),
      extractionVersion: V2,
      createdById: USER,
      createdAt: new Date(BASE + n * 60_000),
      ...storedContentStudioSourceContent({
        schemaVersion: 1,
        blocks: content,
      }),
      ...extra,
    };
    versions.push(row);
    const source = sources.find((s) => s.id === sourceId);
    if (source && n > source.latestVersionNumber) {
      source.latestVersionNumber = n;
    }
    return row;
  };
  const sourceDelegate = {
    findFirst: jest.fn(
      async (args: { where: Row; select: Row }) =>
        (sources.find((row) => matches(row, args.where)) &&
          pick(
            sources.find((row) => matches(row, args.where))!,
            args.select
          )) ||
        null
    ),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const versionDelegate = {
    findFirst: jest.fn(
      async (args: {
        where: Row;
        select: Row;
        orderBy?: { versionNumber: 'asc' | 'desc' };
      }) => {
        const found = versions
          .filter((row) => matches(row, args.where))
          .sort((a, b) =>
            args.orderBy?.versionNumber === 'desc'
              ? b.versionNumber - a.versionNumber
              : a.versionNumber - b.versionNumber
          );
        return found.length ? pick(found[0], args.select) : null;
      }
    ),
    findMany: jest.fn(),
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
  const service = new ContentStudioSourceService(repository, discoveries);
  const changes = (n: number, organizationId = ORG, sourceId = SOURCE) =>
    service.getVersionChanges({
      organizationId,
      sourceId,
      versionId: versionId(sourceId, n),
    });
  return {
    sources,
    versions,
    addSource,
    addVersion,
    sourceDelegate,
    versionDelegate,
    transaction,
    repository,
    service,
    changes,
  };
};

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
const NOT_FOUND = {
  status: 404,
  body: { msg: 'Source not found.', code: 'CS_NOT_FOUND' },
};
const INTEGRITY = {
  status: 500,
  body: {
    msg: 'Stored source data could not be verified.',
    code: 'CS_SOURCE_INTEGRITY_ERROR',
  },
};

describe('the version a capture is compared with', () => {
  it('PD1/M7/M9 v1 A, v2 A, v3 B: v3 is compared with v1, not with the repeat before it', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    t.addVersion(2, blocks('A'));
    t.addVersion(3, blocks('B'));
    const result = await t.changes(3);
    expect(result.before).toMatchObject({
      id: versionId(SOURCE, 1),
      versionNumber: 1,
    });
    expect(result.repeatOf).toBeNull();
    expect(result.change).toBe('content_changed');
  });

  it('PD2/15 v1 A, v2 A, v3 A: no earlier different capture, a repeat of v1', async () => {
    const t = setup();
    t.addSource();
    for (const n of [1, 2, 3]) {
      t.addVersion(n, blocks('A'));
    }
    const result = await t.changes(3);
    expect(result).toMatchObject({
      before: null,
      repeatOf: {
        id: versionId(SOURCE, 1),
        versionNumber: 1,
        fetchedAt: new Date(BASE + 60_000),
      },
      change: 'no_earlier_change',
      blocks: [],
    });
  });

  it('15/M8 v1 A, v2 A, v3 A, v4 B: v4 is compared with v1; v1 itself is the first capture', async () => {
    const t = setup();
    t.addSource();
    for (const n of [1, 2, 3]) {
      t.addVersion(n, blocks('A'));
    }
    t.addVersion(4, blocks('A', 'B'));
    expect((await t.changes(4)).before?.versionNumber).toBe(1);
    expect(await t.changes(1)).toMatchObject({
      before: null,
      repeatOf: null,
      change: 'no_earlier_change',
    });
    // the newest different capture, never the oldest
    t.addVersion(5, blocks('C'));
    expect((await t.changes(5)).before?.versionNumber).toBe(4);
  });

  it('M8 content that comes back: A, B, A, C compares v4 with the second A, the newest run, never the first', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    t.addVersion(2, blocks('B'));
    t.addVersion(3, blocks('A'));
    t.addVersion(4, blocks('C'));
    t.addVersion(5, blocks('C'));
    expect((await t.changes(4)).before?.versionNumber).toBe(3);
    expect(await t.changes(5)).toMatchObject({
      before: { versionNumber: 3 },
      repeatOf: { versionNumber: 4 },
    });
    // and v3 itself is compared with v2, not with the first A
    expect(await t.changes(3)).toMatchObject({
      before: { versionNumber: 2 },
      repeatOf: null,
      change: 'content_changed',
    });
  });

  it('PD3 a title-only capture is a different capture', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'), { title: 'Pricing' });
    t.addVersion(2, blocks('A'), { title: 'Pricing 2026' });
    t.addVersion(3, blocks('A'), { title: 'Pricing 2026' });
    const result = await t.changes(3);
    expect(result).toMatchObject({
      before: { versionNumber: 1, title: 'Pricing' },
      repeatOf: { versionNumber: 2 },
      change: 'title_changed',
      titleChanged: true,
    });
  });

  it('PD4 an extraction-only capture is a different capture', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'), { extractionVersion: V1 });
    t.addVersion(2, blocks('A'), { extractionVersion: V2 });
    expect(await t.changes(2)).toMatchObject({
      before: { versionNumber: 1, extractionVersion: V1 },
      after: { versionNumber: 2, extractionVersion: V2 },
      change: 'extraction_changed',
      sameFetchedBytes: true,
    });
  });

  it('PD5/13 a missing title is compared as a value: null vs null, null vs text, text vs null', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'), { title: null });
    t.addVersion(2, blocks('A'), { title: null });
    t.addVersion(3, blocks('A'), { title: 'Now titled' });
    t.addVersion(4, blocks('A'), { title: null });
    // null after null: the same capture
    expect(await t.changes(2)).toMatchObject({
      before: null,
      repeatOf: { versionNumber: 1 },
    });
    // text after null: different; compared with the first of v1 and its
    // repeat v2
    expect(await t.changes(3)).toMatchObject({
      before: { versionNumber: 1, title: null },
      change: 'title_changed',
    });
    // null after text: different, with the null-titled v3 not skipped
    expect(await t.changes(4)).toMatchObject({
      before: { versionNumber: 3, title: 'Now titled' },
      repeatOf: null,
      change: 'title_changed',
    });
  });

  it('14/M10 a repeat is read from the rows: a gap in the numbers changes nothing', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    // no version 2 (a later retention may leave gaps)
    t.addVersion(3, blocks('B'));
    t.addVersion(4, blocks('B'));
    expect(await t.changes(4)).toMatchObject({
      before: { versionNumber: 1 },
      repeatOf: { id: versionId(SOURCE, 3), versionNumber: 3 },
    });
  });

  it('pins both lookups: org, source, earlier versions, one of the three differs, newest first; repeats oldest first', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    t.addVersion(2, blocks('B'));
    await t.changes(2);
    const calls = t.versionDelegate.findFirst.mock.calls.map(([args]) => args);
    const hash = t.versions[1].contentHash;
    expect(calls[1]).toEqual({
      where: {
        organizationId: ORG,
        sourceId: SOURCE,
        versionNumber: { lt: 2 },
        OR: [
          { contentHash: { not: hash } },
          { extractionVersion: { not: V2 } },
          { title: { not: 'Pricing' } },
          { title: null },
        ],
      },
      orderBy: { versionNumber: 'desc' },
      // metadata only: a version is read with its text when it is compared
      select: expect.objectContaining({
        contentHash: true,
        title: true,
        extractionVersion: true,
      }),
    });
    expect(calls[1].select).not.toHaveProperty('content');
    expect(calls[2]).toEqual({
      where: {
        organizationId: ORG,
        sourceId: SOURCE,
        versionNumber: { lt: 2, gt: 1 },
        contentHash: hash,
        title: 'Pricing',
        extractionVersion: V2,
      },
      orderBy: { versionNumber: 'asc' },
      select: { id: true, versionNumber: true, fetchedAt: true },
    });
    // then the run of the baseline: its own earlier different capture and
    // its first capture, and the baseline read with its text by id
    expect(calls[3].where.versionNumber).toEqual({ lt: 1 });
    expect(calls[4].where.versionNumber).toEqual({ lt: 1 });
    expect(calls[5]).toEqual({
      where: {
        id: versionId(SOURCE, 1),
        sourceId: SOURCE,
        organizationId: ORG,
      },
      select: expect.objectContaining({ content: true }),
    });
    expect(calls).toHaveLength(6);
  });

  it('a version without a title looks for any title, and a run without a baseline starts at the first version', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'), { title: null });
    await t.changes(1);
    const calls = t.versionDelegate.findFirst.mock.calls.map(([args]) => args);
    expect(calls[1].where.OR[2]).toEqual({ title: { not: null } });
    expect(calls[1].where.OR).toHaveLength(3);
    expect(calls[2].where.versionNumber).toEqual({ lt: 1 });
  });
});

describe('getVersionChanges', () => {
  it('S1/28/29 a content change, as the answer is shaped: no hashes, ids of blocks, organization or creator', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('Intro', 'Old price', 'Footer'));
    t.addVersion(2, blocks('Intro', 'New price', 'Footer', 'FAQ'), {
      finalUrl: 'https://www.example.com/pricing',
      redirectCount: 1,
      sourceHash: 'e'.repeat(64),
    });
    const result = await t.changes(2);
    expect(result).toEqual({
      source: {
        id: SOURCE,
        name: 'Pricing page',
        canonicalUrl: 'https://example.com/pricing',
      },
      after: {
        id: versionId(SOURCE, 2),
        versionNumber: 2,
        fetchedAt: new Date(BASE + 2 * 60_000),
        title: 'Pricing',
        extractionVersion: V2,
      },
      before: {
        id: versionId(SOURCE, 1),
        versionNumber: 1,
        fetchedAt: new Date(BASE + 60_000),
        title: 'Pricing',
        extractionVersion: V2,
      },
      repeatOf: null,
      change: 'content_changed',
      titleChanged: false,
      sameFetchedBytes: false,
      counts: {
        added: 2,
        removed: 1,
        unchanged: 2,
        beforeBlocks: 3,
        afterBlocks: 4,
      },
      blocks: [
        { change: 'unchanged', count: 1 },
        {
          change: 'removed',
          type: 'paragraph',
          level: null,
          text: 'Old price',
        },
        { change: 'added', type: 'paragraph', level: null, text: 'New price' },
        { change: 'unchanged', count: 1 },
        { change: 'added', type: 'paragraph', level: null, text: 'FAQ' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /contentHash|sourceHash|organizationId|createdById|"b\d"|ffff|eeee/
    );
  });

  it('S2 title only', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'), { title: null });
    t.addVersion(2, blocks('A'), { title: 'Pricing' });
    expect(await t.changes(2)).toMatchObject({
      change: 'title_changed',
      titleChanged: true,
      before: { title: null },
      after: { title: 'Pricing' },
      blocks: [{ change: 'unchanged', count: 1 }],
    });
  });

  it('S3/M3/M25 another extraction is extraction_changed, never content_changed; the differences are still shown', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('Menu', 'Body'), {
      extractionVersion: V1,
      sourceHash: 'a'.repeat(64),
    });
    t.addVersion(2, blocks('Body'), {
      extractionVersion: V2,
      sourceHash: 'a'.repeat(64),
    });
    expect(await t.changes(2)).toMatchObject({
      change: 'extraction_changed',
      sameFetchedBytes: true,
      counts: { added: 0, removed: 1, unchanged: 1 },
    });
    t.addVersion(3, blocks('Body', 'More'), {
      extractionVersion: V1,
      sourceHash: 'b'.repeat(64),
    });
    expect(await t.changes(3)).toMatchObject({
      change: 'extraction_changed',
      sameFetchedBytes: false,
    });
  });

  it('S4/M1 a manual repeat is no change: a later version number is not a change', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    t.addVersion(2, blocks('A'), {
      fetchedAt: new Date(BASE + 999_000),
      sourceHash: 'c'.repeat(64),
      finalUrl: 'https://www.example.com/pricing',
      redirectCount: 1,
      httpStatus: 203,
      contentLength: 9,
    });
    expect(await t.changes(2)).toMatchObject({
      before: null,
      repeatOf: { versionNumber: 1 },
      change: 'no_earlier_change',
      titleChanged: false,
      sameFetchedBytes: false,
    });
  });

  it('S5/34 an archived page source can still be compared', async () => {
    const t = setup();
    t.addSource({ archivedAt: new Date(BASE) });
    t.addVersion(1, blocks('A'));
    t.addVersion(2, blocks('B'));
    expect((await t.changes(2)).change).toBe('content_changed');
  });

  it('S6/33/M23 a feed is refused before any version is read, even one stored with a version', async () => {
    const t = setup();
    t.addSource({
      id: FEED,
      kind: 'feed',
      canonicalUrl: 'https://example.com/feed.xml',
    });
    t.addVersion(1, blocks('A'), { sourceId: FEED });
    expect(await refusal(t.changes(1, ORG, FEED))).toEqual({
      status: 400,
      body: {
        msg: 'This source type has no versions.',
        code: 'CS_SOURCE_KIND_UNSUPPORTED',
      },
    });
    expect(t.versionDelegate.findFirst).not.toHaveBeenCalled();
    // an unknown kind is no page either
    t.sources[0].kind = 'podcast';
    expect((await refusal(t.changes(1, ORG, FEED))).status).toBe(400);
    expect(t.versionDelegate.findFirst).not.toHaveBeenCalled();
  });

  it('S7/S8/35 a missing source and one of another organization answer the same 404', async () => {
    const t = setup();
    t.addSource({ organizationId: OTHER_ORG });
    t.addVersion(1, blocks('A'), { organizationId: OTHER_ORG });
    t.addVersion(2, blocks(MARKER), { organizationId: OTHER_ORG });
    const other = await refusal(t.changes(2));
    const missing = await refusal(
      t.service.getVersionChanges({
        organizationId: ORG,
        sourceId: OTHER_SOURCE,
        versionId: versionId(OTHER_SOURCE, 1),
      })
    );
    expect(other).toEqual(NOT_FOUND);
    expect(missing).toEqual(NOT_FOUND);
    expect(t.sourceDelegate.findFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
    });
    expect(t.versionDelegate.findFirst).not.toHaveBeenCalled();
  });

  it('35/M22 a version of another organization under a source of this one is a 404', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'), { organizationId: OTHER_ORG });
    expect(await refusal(t.changes(1))).toEqual(NOT_FOUND);
    expect(t.versionDelegate.findFirst.mock.calls[0][0].where).toEqual({
      id: versionId(SOURCE, 1),
      sourceId: SOURCE,
      organizationId: ORG,
    });
  });

  it('S9/36/M21 a version of another source is a 404: never compared', async () => {
    const t = setup();
    t.addSource();
    t.addSource({
      id: OTHER_SOURCE,
      canonicalUrl: 'https://example.com/other',
    });
    t.addVersion(1, blocks('A'));
    t.addVersion(1, blocks('B'), { sourceId: OTHER_SOURCE });
    expect(
      await refusal(
        t.service.getVersionChanges({
          organizationId: ORG,
          sourceId: SOURCE,
          versionId: versionId(OTHER_SOURCE, 1),
        })
      )
    ).toEqual(NOT_FOUND);
    // the baseline is looked for in the same source only
    t.addVersion(2, blocks('C'));
    await t.changes(2);
    for (const [args] of t.versionDelegate.findFirst.mock.calls) {
      expect(args.where).toMatchObject({
        sourceId: SOURCE,
        organizationId: ORG,
      });
    }
  });

  it('ids that are not UUIDs are a 404 before anything is read', async () => {
    const t = setup();
    for (const [sourceId, id] of [
      ['x', versionId(SOURCE, 1)],
      [SOURCE, 'not-a-uuid'],
      [SOURCE, "1' OR '1'='1"],
    ]) {
      expect(
        await refusal(
          t.service.getVersionChanges({
            organizationId: ORG,
            sourceId,
            versionId: id,
          })
        )
      ).toEqual(NOT_FOUND);
    }
    expect(t.sourceDelegate.findFirst).not.toHaveBeenCalled();
  });

  it('S10/37/M19 a corrupt version compared is an integrity error that quotes nothing', async () => {
    for (const corrupt of [
      { contentHash: '0'.repeat(64) },
      {
        content: `{"blocks":[{"id":"b1","type":"paragraph","text":"${MARKER}","level":null}],"schemaVersion":1}`,
      },
      { content: 'not json' },
    ]) {
      const t = setup();
      t.addSource();
      t.addVersion(1, blocks('A'));
      t.addVersion(2, blocks(MARKER), corrupt);
      const result = await refusal(t.changes(2));
      expect(result).toEqual(INTEGRITY);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });

  it('S11/37/M20 a corrupt baseline is an integrity error that quotes nothing', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks(MARKER), { contentHash: '0'.repeat(64) });
    t.addVersion(2, blocks('B'));
    const result = await refusal(t.changes(2));
    expect(result).toEqual(INTEGRITY);
    expect(JSON.stringify(result)).not.toContain(MARKER);
    // the baseline is the first capture of its run: that is the one checked
    const run = setup();
    run.addSource();
    run.addVersion(1, blocks('A'), { content: 'not json' });
    run.addVersion(2, blocks('A'));
    run.addVersion(3, blocks('B'));
    expect(await refusal(run.changes(3))).toEqual(INTEGRITY);
  });

  it('38 the repeats skipped on the way are matched by their stored fields only, never parsed: bounded cost', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    const after = t.addVersion(3, blocks('B'));
    // between them a repeat of v3 whose stored text does not even parse: it
    // is skipped by its blocks hash, title and extraction, never read
    t.addVersion(2, blocks('B'), { content: 'not json' });
    expect(t.versions[2].contentHash).toBe(after.contentHash);
    expect(await t.changes(3)).toMatchObject({
      before: { versionNumber: 1 },
      repeatOf: { versionNumber: 2 },
      change: 'content_changed',
    });
    // and a repeat inside the baseline's run is skipped the same way
    const run = setup();
    run.addSource();
    run.addVersion(1, blocks('A'));
    run.addVersion(3, blocks('B'));
    run.addVersion(2, blocks('A'), { content: 'not json' });
    expect(await run.changes(3)).toMatchObject({
      before: { versionNumber: 1 },
      repeatOf: null,
      change: 'content_changed',
    });
  });

  it('P804A-3 reads only: nothing is written, captured or fetched', async () => {
    const t = setup();
    t.addSource();
    t.addVersion(1, blocks('A'));
    t.addVersion(2, blocks('B'));
    const before = JSON.stringify([t.sources, t.versions]);
    await t.changes(2);
    expect(JSON.stringify([t.sources, t.versions])).toBe(before);
    for (const delegate of [t.sourceDelegate, t.versionDelegate]) {
      for (const write of [
        'create',
        'update',
        'updateMany',
        'upsert',
        'delete',
        'deleteMany',
      ] as const) {
        expect(delegate[write]).not.toHaveBeenCalled();
      }
    }
    expect(t.transaction.$transaction).not.toHaveBeenCalled();
  });
});

describe('the change service boundary', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
  const code = (file: string) =>
    fs
      .readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
  const service = code(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts'
  );
  const method = service.slice(
    service.indexOf('async getVersionChanges('),
    service.indexOf('async listDiscoveries(')
  );

  it('P804A-3/P804A-4/P804A-5 compares with the pure module, writes nothing, fetches nothing, asks no AI', () => {
    expect(method).toContain(
      'compareContentStudioSourceVersions(before, after)'
    );
    expect(method).not.toMatch(
      /appendVersion|create\(|update|delete|safeFetch|refresh|ingestion|AIConnection|AIOperation|AIUsage|\$transaction/
    );
  });

  it('37 both compared versions go through the stored-version check', () => {
    expect(method.match(/this\.intactContent\(/g)).toHaveLength(2);
    expect(service.slice(service.indexOf('private intactContent('))).toMatch(
      /parseVerifiedContentStudioSourceVersion\(row\)/
    );
  });

  it('P804A-12 no raw SQL in the lookups', () => {
    const repository = code(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts'
    );
    expect(repository).not.toMatch(
      /\$queryRaw|\$executeRaw|Prisma\.sql|\$queryRawUnsafe/
    );
  });
});
