import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { parseContentStudioSourceVersionInput } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

// No database: the Prisma delegates are mocked. The transaction mock runs on
// a small in-memory copy of the rows, applies where clauses like Prisma
// (undefined is no condition) and puts everything back when the callback
// throws, like a rollback. Real constraints are left to a later PostgreSQL
// integration slice

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const OTHER_SOURCE = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-15T10:00:00.000Z');
const FETCHED = new Date('2026-10-15T09:00:00.000Z');
const URL_A = 'https://example.com/news/a';
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

// a capture as ingestion will hand it over, through the version parser
const capture = (text: string, overrides: Record<string, unknown> = {}) =>
  parseContentStudioSourceVersionInput({
    requestedUrl: URL_A,
    finalUrl: 'https://www.example.com/news/a',
    redirectCount: 1,
    fetchedAt: FETCHED,
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 2048,
    title: 'News A',
    sourceHash: 'b'.repeat(64),
    extractionVersion: CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
    content: {
      schemaVersion: 1,
      blocks: [{ id: 'p1', type: 'paragraph', text, level: null }],
    },
    ...overrides,
  });

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (value && typeof value === 'object' && 'not' in (value as Row)) {
      return row[key] !== (value as Row).not;
    }
    if (value && typeof value === 'object' && 'in' in (value as Row)) {
      return ((value as Row).in as unknown[]).includes(row[key]);
    }
    return row[key] === value;
  });

const pick = (row: Row, select?: Row) =>
  select
    ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
    : { ...row };

const setup = () => {
  const state = {
    sources: [] as Row[],
    versions: [] as Row[],
  };
  const delegate = (table: 'sources' | 'versions') => ({
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = state[table].find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
    findMany: jest.fn(async (args: { where: Row; select?: Row }) =>
      state[table]
        .filter((r) => matches(r, args.where))
        .sort((a, b) =>
          table === 'versions'
            ? (b.versionNumber as number) - (a.versionNumber as number)
            : 0
        )
        .map((r) => pick(r, args.select))
    ),
    count: jest.fn(
      async (args: { where: Row }) =>
        state[table].filter((r) => matches(r, args.where)).length
    ),
    create: jest.fn(async (args: { data: Row; select?: Row }) => {
      if (
        table === 'versions' &&
        state.versions.some(
          (r) =>
            r.sourceId === args.data.sourceId &&
            r.versionNumber === args.data.versionNumber
        )
      ) {
        throw new Error('Unique constraint failed (sourceId, versionNumber)');
      }
      const row = {
        createdAt: NOW,
        ...(table === 'sources' ? { updatedAt: NOW, archivedAt: null } : {}),
        ...args.data,
      };
      state[table].push(row);
      return pick(row, args.select);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const rows = state[table].filter((r) => matches(r, args.where));
      for (const row of rows) {
        for (const [key, value] of Object.entries(args.data)) {
          row[key] =
            value && typeof value === 'object' && 'increment' in (value as Row)
              ? (row[key] as number) + ((value as Row).increment as number)
              : value;
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
  const tx = {
    contentStudioSource: source,
    contentStudioSourceVersion: version,
  };
  const transaction = {
    // the options (P8-C1: serializable) are only recorded here
    $transaction: jest.fn(
      async (fn: (client: typeof tx) => unknown, options?: unknown) => {
        const snapshot = JSON.parse(JSON.stringify(state), (key, value) =>
          ['createdAt', 'updatedAt', 'archivedAt', 'fetchedAt'].includes(key) &&
          value
            ? new Date(value)
            : value
        );
        try {
          return await fn(tx);
        } catch (err) {
          state.sources = snapshot.sources;
          state.versions = snapshot.versions;
          throw err;
        }
      }
    ),
  };
  const repository = new ContentStudioSourceRepository(
    {
      model: { contentStudioSource: source },
    } as unknown as PrismaRepository<'contentStudioSource'>,
    {
      model: { contentStudioSourceVersion: version },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, source, version, transaction, state };
};

// far below any limit: the limits have their own tests
const create = async (
  repository: ContentStudioSourceRepository,
  overrides: Partial<{
    id: string;
    organizationId: string;
    url: string;
    kind: string;
  }> = {}
) => {
  const result = await repository.createSourcesWithinLimit({
    organizationId: overrides.organizationId ?? ORG,
    kind: overrides.kind ?? 'url',
    createdById: USER,
    limit: 100,
    sources: [
      {
        id: overrides.id ?? SOURCE,
        name: 'Example news',
        canonicalUrl: overrides.url ?? URL_A,
      },
    ],
  });
  if (result.status !== 'decided' || result.results[0].status !== 'created') {
    throw new Error('not created');
  }
  return result.results[0].source;
};

const append = (
  repository: ContentStudioSourceRepository,
  expectedLatestVersionNumber: number,
  text: string,
  overrides: Partial<{ organizationId: string; sourceId: string }> = {}
) =>
  repository.appendVersionWithCompareAndSwap({
    organizationId: overrides.organizationId ?? ORG,
    sourceId: overrides.sourceId ?? SOURCE,
    expectedLatestVersionNumber,
    versionId: `version-${expectedLatestVersionNumber + 1}-${text}`,
    version: capture(text),
    createdById: USER,
  });

const SOURCE_FIELDS = {
  id: true,
  kind: true,
  name: true,
  canonicalUrl: true,
  latestVersionNumber: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  lastCapturedAt: true,
};
const VERSION_FIELDS = {
  id: true,
  versionNumber: true,
  schemaVersion: true,
  extractionVersion: true,
  requestedUrl: true,
  finalUrl: true,
  redirectCount: true,
  fetchedAt: true,
  httpStatus: true,
  contentType: true,
  contentLength: true,
  title: true,
  contentHash: true,
  sourceHash: true,
  createdAt: true,
};

describe('ContentStudioSourceRepository: sources', () => {
  it('SR1/SR2 creates a source with exactly its fields and no version', async () => {
    const { repository, source, state } = setup();
    const result = await create(repository);

    expect(source.create).toHaveBeenCalledWith({
      data: {
        id: SOURCE,
        organizationId: ORG,
        kind: 'url',
        name: 'Example news',
        canonicalUrl: URL_A,
        latestVersionNumber: 0,
        createdById: USER,
      },
      select: SOURCE_FIELDS,
    });
    expect(result).toEqual({
      id: SOURCE,
      kind: 'url',
      name: 'Example news',
      canonicalUrl: URL_A,
      latestVersionNumber: 0,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(state.versions).toEqual([]);
  });

  it('SR3-SR5 lists and counts active or archived sources of the organization, newest first', async () => {
    const { repository, source } = setup();
    await repository.listSourcesForOrganization({
      organizationId: ORG,
      archived: false,
      skip: 20,
      take: 20,
    });
    await repository.listSourcesForOrganization({
      organizationId: ORG,
      archived: true,
      skip: 0,
      take: 20,
    });
    expect(source.findMany.mock.calls.map(([args]) => args)).toEqual([
      {
        where: { organizationId: ORG, archivedAt: null },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: SOURCE_FIELDS,
        skip: 20,
        take: 20,
      },
      {
        where: { organizationId: ORG, archivedAt: { not: null } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: SOURCE_FIELDS,
        skip: 0,
        take: 20,
      },
    ]);

    await repository.countSourcesForOrganization({
      organizationId: ORG,
      archived: false,
    });
    await repository.countSourcesForOrganization({
      organizationId: ORG,
      archived: true,
    });
    expect(source.count.mock.calls.map(([args]) => args)).toEqual([
      { where: { organizationId: ORG, archivedAt: null } },
      { where: { organizationId: ORG, archivedAt: { not: null } } },
    ]);
  });

  it('SR3/SR4 really separates organizations and archived sources', async () => {
    const { repository } = setup();
    await create(repository);
    await create(repository, { id: OTHER_SOURCE, organizationId: OTHER_ORG });
    await repository.archiveSource(OTHER_ORG, OTHER_SOURCE, NOW);
    const ids = async (organizationId: string, archived: boolean) =>
      (
        await repository.listSourcesForOrganization({
          organizationId,
          archived,
          skip: 0,
          take: 20,
        })
      ).map((row) => row.id);
    expect(await ids(ORG, false)).toEqual([SOURCE]);
    expect(await ids(ORG, true)).toEqual([]);
    expect(await ids(OTHER_ORG, true)).toEqual([OTHER_SOURCE]);
    expect(
      await repository.countSourcesForOrganization({
        organizationId: OTHER_ORG,
        archived: false,
      })
    ).toBe(0);
  });

  it('K1-K3/K5 P8-02 lists and counts one kind when asked; without a kind exactly as before', async () => {
    const { repository, source } = setup();
    await create(repository);
    const feed = (id: string, organizationId: string) =>
      create(repository, {
        id,
        organizationId,
        kind: 'feed',
        url: 'https://example.com/feed.xml',
      });
    await feed(OTHER_SOURCE, ORG);
    await feed('66666666-6666-4666-8666-666666666666', OTHER_ORG);
    // the creates read and counted within their limit
    source.count.mockClear();
    source.findMany.mockClear();
    const ids = async (kind?: string) =>
      (
        await repository.listSourcesForOrganization({
          organizationId: ORG,
          archived: false,
          kind,
          skip: 0,
          take: 20,
        })
      )
        .map((row) => row.id)
        .sort();
    expect(await ids()).toEqual([SOURCE, OTHER_SOURCE].sort());
    expect(await ids('feed')).toEqual([OTHER_SOURCE]);
    expect(await ids('url')).toEqual([SOURCE]);
    expect(
      await repository.countSourcesForOrganization({
        organizationId: ORG,
        archived: false,
        kind: 'feed',
      })
    ).toBe(1);
    expect(
      await repository.countSourcesForOrganization({
        organizationId: OTHER_ORG,
        archived: false,
        kind: 'url',
      })
    ).toBe(0);
    // the query a missing kind sends is the P3 one, key for key
    const calls = source.findMany.mock.calls.map(([args]) => args.where);
    expect(calls[0]).toStrictEqual({ organizationId: ORG, archivedAt: null });
    expect(calls[1]).toStrictEqual({
      organizationId: ORG,
      archivedAt: null,
      kind: 'feed',
    });
    expect(source.count.mock.calls[0][0].where).toStrictEqual({
      organizationId: ORG,
      archivedAt: null,
      kind: 'feed',
    });
  });

  it('SR6/SR7 reads a source of the organization only', async () => {
    const { repository, source } = setup();
    await create(repository);
    source.findFirst.mockClear();
    expect(
      await repository.getSourceForOrganization(ORG, SOURCE)
    ).toMatchObject({ id: SOURCE, canonicalUrl: URL_A });
    expect(
      await repository.getSourceForOrganization(OTHER_ORG, SOURCE)
    ).toBeNull();
    expect(source.findFirst.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: SOURCE, organizationId: ORG }, select: SOURCE_FIELDS },
      {
        where: { id: SOURCE, organizationId: OTHER_ORG },
        select: SOURCE_FIELDS,
      },
    ]);
  });

  it('SR8 looks a canonical URL up within the organization, archived sources included', async () => {
    const { repository, source } = setup();
    await create(repository);
    await repository.archiveSource(ORG, SOURCE, NOW);
    expect(
      await repository.getSourceByCanonicalUrlForOrganization(ORG, URL_A)
    ).toMatchObject({ id: SOURCE });
    expect(
      await repository.getSourceByCanonicalUrlForOrganization(OTHER_ORG, URL_A)
    ).toBeNull();
    expect(source.findFirst.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, canonicalUrl: URL_A },
      select: SOURCE_FIELDS,
    });
  });

  it('SR9-SR12 renames live sources only, archives and restores, and touches no version', async () => {
    const { repository, source, state } = setup();
    await create(repository);
    await append(repository, 0, 'one');
    const versions = JSON.stringify(state.versions);

    expect(await repository.updateSourceName(ORG, SOURCE, 'Renamed')).toEqual({
      count: 1,
    });
    expect(
      await repository.updateSourceName(OTHER_ORG, SOURCE, 'Stolen')
    ).toEqual({ count: 0 });
    expect(await repository.archiveSource(ORG, SOURCE, NOW)).toEqual({
      count: 1,
    });
    // archived: read-only, and archiving again changes nothing
    expect(await repository.updateSourceName(ORG, SOURCE, 'Later')).toEqual({
      count: 0,
    });
    expect(await repository.archiveSource(ORG, SOURCE, NOW)).toEqual({
      count: 0,
    });
    const restore = (organizationId: string) =>
      repository.restoreSourceWithinLimit({
        organizationId,
        id: SOURCE,
        activeFeedsMax: 100,
      });
    expect(await restore(OTHER_ORG)).toEqual({ status: 'not-found' });
    expect(await restore(ORG)).toEqual({ status: 'restored' });
    expect(await restore(ORG)).toEqual({ status: 'unchanged' });

    expect(source.updateMany.mock.calls.map(([args]) => args)).toEqual(
      expect.arrayContaining([
        {
          where: { id: SOURCE, organizationId: ORG, archivedAt: null },
          data: { name: 'Renamed' },
        },
        {
          where: { id: SOURCE, organizationId: ORG, archivedAt: null },
          data: { archivedAt: NOW },
        },
        {
          where: {
            id: SOURCE,
            organizationId: ORG,
            archivedAt: { not: null },
          },
          data: { archivedAt: null },
        },
      ])
    );
    expect(state.sources[0]).toMatchObject({
      name: 'Renamed',
      archivedAt: null,
      latestVersionNumber: 1,
      canonicalUrl: URL_A,
    });
    expect(JSON.stringify(state.versions)).toBe(versions);
  });

  it('SR13-SR15 has no delete, URL change or version-changing method', () => {
    expect(
      Object.getOwnPropertyNames(ContentStudioSourceRepository.prototype).sort()
    ).toEqual([
      'appendVersionWithCompareAndSwap',
      'archiveSource',
      'constructor',
      // reads (P8-04B1)
      'countPageChangesForOrganization',
      'countSourcesForOrganization',
      'countVersionsForSource',
      // the only create of sources, within the organization's limit (P8-C1)
      'createSourcesWithinLimit',
      // reads (P8-04A)
      'getFirstRepeatOfVersion',
      'getPageSourceForBackfill',
      'getPreviousDifferentVersion',
      'getSourceByCanonicalUrlForOrganization',
      'getSourceForCapture',
      'getSourceForOrganization',
      'getVersionByNumber',
      'getVersionDetailByNumber',
      'getVersionForSource',
      'getVersionsByIdsForOrganization',
      'getVersionsByNumbersForOrganization',
      'listFeedsDueForCapture',
      'listPageChangesForOrganization',
      'listPageSourcesForBackfill',
      'listSourcesForOrganization',
      'listVersionCapturesForBackfill',
      'listVersionsForSource',
      'markFeedCaptured',
      'restoreSourceWithinLimit',
      // the page-change backfill (P8-04B1): the derived fields only
      'setPageChangeWithCompareAndSwap',
      'updateSourceName',
      // one serializable transaction, retried (P8-C1)
      'withinLimitTransaction',
    ]);
  });
});

describe('ContentStudioSourceRepository: organization limits (P8-C1)', () => {
  const P2034 = () =>
    new Prisma.PrismaClientKnownRequestError('Transaction write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
  const ids = (n: number) =>
    `${'9'.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const sources = (...ns: number[]) =>
    ns.map((n) => ({
      id: ids(n),
      name: `Source ${n}`,
      canonicalUrl: `https://example.com/${n}`,
    }));
  const input = (
    overrides: Partial<{
      organizationId: string;
      kind: string;
      limit: number;
      sources: Array<{ id: string; name: string; canonicalUrl: string }>;
    }> = {}
  ) => ({
    organizationId: overrides.organizationId ?? ORG,
    kind: overrides.kind ?? 'url',
    createdById: USER,
    limit: overrides.limit ?? 2,
    sources: overrides.sources ?? sources(1),
  });
  const statuses = (result: {
    status: string;
    results?: { status: string }[];
  }) =>
    result.status === 'decided'
      ? result.results!.map((item) => item.status)
      : result.status;

  it('P8C1-9/10 a feed limit counts the live feeds of the organization, a page limit all its pages', async () => {
    const { repository, source } = setup();
    await repository.createSourcesWithinLimit(input({ kind: 'feed' }));
    await repository.createSourcesWithinLimit(input({ sources: sources(2) }));
    expect(source.count.mock.calls.map(([args]) => args)).toEqual([
      { where: { organizationId: ORG, kind: 'feed', archivedAt: null } },
      { where: { organizationId: ORG, kind: 'url' } },
    ]);
  });

  it('FC1/FC2/SC1/SC2 creates in their order below the limit and refuses the rest, creating nothing for them', async () => {
    const { repository, state, source } = setup();
    const result = await repository.createSourcesWithinLimit(
      input({ sources: sources(1, 2, 3, 4) })
    );
    expect(statuses(result)).toEqual(['created', 'created', 'limit', 'limit']);
    expect(state.sources.map((row) => row.id)).toEqual([ids(1), ids(2)]);
    // one look at the URLs, one count, for all of them
    expect(source.findMany).toHaveBeenCalledTimes(1);
    expect(source.count).toHaveBeenCalledTimes(1);
    expect(
      statuses(
        await repository.createSourcesWithinLimit(
          input({ sources: sources(5) })
        )
      )
    ).toEqual(['limit']);
  });

  it('FC3/SC3 archived feeds free their place; archived pages do not', async () => {
    const { repository, state } = setup();
    for (const kind of ['feed', 'url']) {
      await repository.createSourcesWithinLimit(
        input({ kind, sources: sources(1, 2) })
      );
      for (const row of state.sources) {
        row.archivedAt = NOW;
      }
      const result = await repository.createSourcesWithinLimit(
        input({ kind, sources: sources(3) })
      );
      expect([kind, statuses(result)]).toEqual([
        kind,
        [kind === 'feed' ? 'created' : 'limit'],
      ]);
      state.sources = [];
    }
  });

  it('FC8/SC13 another organization at its limit changes nothing', async () => {
    const { repository } = setup();
    await repository.createSourcesWithinLimit(
      input({ organizationId: OTHER_ORG, sources: sources(1, 2) })
    );
    expect(
      statuses(
        await repository.createSourcesWithinLimit(
          input({ sources: sources(3) })
        )
      )
    ).toEqual(['created']);
  });

  it('FC7/SC5 an existing canonical URL, archived included, is that source whatever the limit, and takes no place', async () => {
    const { repository, source, state } = setup();
    await create(repository, { id: ids(1), url: 'https://example.com/1' });
    state.sources[0].archivedAt = NOW;
    source.create.mockClear();
    const result = await repository.createSourcesWithinLimit(
      input({ limit: 1, sources: sources(1, 2) })
    );
    expect(result).toMatchObject({
      status: 'decided',
      results: [
        { status: 'exists', source: { id: ids(1) } },
        { status: 'limit' },
      ],
    });
    expect(source.create).not.toHaveBeenCalled();
    expect(source.findMany.mock.calls.at(-1)![0].where).toEqual({
      organizationId: ORG,
      canonicalUrl: {
        in: ['https://example.com/1', 'https://example.com/2'],
      },
    });
  });

  it('FC9/P8C1-8 runs serializable and runs again from a fresh read after a serialization failure', async () => {
    const { repository, transaction, source } = setup();
    transaction.$transaction.mockRejectedValueOnce(P2034());
    expect(
      statuses(await repository.createSourcesWithinLimit(input()))
    ).toEqual(['created']);
    expect(transaction.$transaction).toHaveBeenCalledTimes(2);
    for (const call of transaction.$transaction.mock.calls) {
      expect(call[1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
    // the second attempt read and counted again
    expect(source.findMany).toHaveBeenCalledTimes(1);
    expect(source.count).toHaveBeenCalledTimes(1);
  });

  it('a retry that finds the limit reached meanwhile is the limit, not a conflict', async () => {
    const { repository, transaction, state } = setup();
    await create(repository, { id: ids(1), url: 'https://example.com/1' });
    transaction.$transaction.mockImplementationOnce(async () => {
      // another writer takes the last place, and this attempt is aborted
      state.sources.push({
        ...state.sources[0],
        id: ids(2),
        canonicalUrl: 'https://example.com/2',
      });
      throw P2034();
    });
    expect(
      statuses(
        await repository.createSourcesWithinLimit(
          input({ sources: sources(3) })
        )
      )
    ).toEqual(['limit']);
  });

  it('FC10/M16 gives up after 3 attempts in all with a conflict; any other error is thrown at once', async () => {
    const { repository, transaction, state } = setup();
    transaction.$transaction.mockRejectedValue(P2034());
    expect(await repository.createSourcesWithinLimit(input())).toEqual({
      status: 'conflict',
    });
    expect(
      await repository.restoreSourceWithinLimit({
        organizationId: ORG,
        id: SOURCE,
        activeFeedsMax: 1,
      })
    ).toEqual({ status: 'conflict' });
    expect(transaction.$transaction).toHaveBeenCalledTimes(6);
    expect(state.sources).toEqual([]);
    transaction.$transaction.mockReset();
    const down = new Error('database down');
    transaction.$transaction.mockRejectedValueOnce(down);
    await expect(repository.createSourcesWithinLimit(input())).rejects.toBe(
      down
    );
    const unique = new Prisma.PrismaClientKnownRequestError('Unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    transaction.$transaction.mockRejectedValueOnce(unique);
    await expect(repository.createSourcesWithinLimit(input())).rejects.toBe(
      unique
    );
    expect(transaction.$transaction).toHaveBeenCalledTimes(2);
  });

  it('FC4/FC5/FC6/SC4 a feed is restored below the live feed limit only; a page always; a live one is unchanged', async () => {
    const { repository, state, source } = setup();
    await create(repository, { id: ids(1), kind: 'feed', url: 'https://f/1' });
    await create(repository, { id: ids(2), kind: 'feed', url: 'https://f/2' });
    await create(repository, { id: ids(3), url: 'https://p/3' });
    for (const row of state.sources) {
      row.archivedAt = NOW;
    }
    const restore = (id: string) =>
      repository.restoreSourceWithinLimit({
        organizationId: ORG,
        id,
        activeFeedsMax: 1,
      });
    expect(await restore(ids(1))).toEqual({ status: 'restored' });
    // a live feed is not restored again and takes no second place
    expect(await restore(ids(1))).toEqual({ status: 'unchanged' });
    source.count.mockClear();
    expect(await restore(ids(2))).toEqual({ status: 'limit' });
    expect(state.sources[1].archivedAt).toEqual(NOW);
    expect(source.count.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, kind: 'feed', archivedAt: null },
    });
    source.count.mockClear();
    // a page is restored at any count
    expect(await restore(ids(3))).toEqual({ status: 'restored' });
    expect(source.count).not.toHaveBeenCalled();
    // another organization's feed is not there
    expect(
      await repository.restoreSourceWithinLimit({
        organizationId: OTHER_ORG,
        id: ids(2),
        activeFeedsMax: 10,
      })
    ).toEqual({ status: 'not-found' });
  });
});

describe('ContentStudioSourceRepository: version append', () => {
  it('SR16-SR21 appends the first capture as version 1, with its provenance and both hashes', async () => {
    const { repository, transaction, version, state } = setup();
    await create(repository);
    transaction.$transaction.mockClear();
    const data = capture('First capture.');
    const result = await repository.appendVersionWithCompareAndSwap({
      organizationId: ORG,
      sourceId: SOURCE,
      expectedLatestVersionNumber: 0,
      versionId: 'version-1',
      version: data,
      createdById: USER,
    });

    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.sources[0].latestVersionNumber).toBe(1);
    expect(version.create).toHaveBeenCalledWith({
      data: {
        id: 'version-1',
        organizationId: ORG,
        sourceId: SOURCE,
        versionNumber: 1,
        schemaVersion: 1,
        extractionVersion: 'content-studio-source-v2',
        requestedUrl: URL_A,
        finalUrl: 'https://www.example.com/news/a',
        redirectCount: 1,
        fetchedAt: FETCHED,
        httpStatus: 200,
        contentType: 'text/html',
        contentLength: 2048,
        title: 'News A',
        content: data.content,
        contentHash: data.contentHash,
        sourceHash: 'b'.repeat(64),
        createdById: USER,
      },
      select: VERSION_FIELDS,
    });
    expect(data.content).toBe(
      '{"blocks":[{"id":"p1","level":null,"text":"First capture.","type":"paragraph"}],"schemaVersion":1}'
    );
    expect(data.sourceHash).not.toBe(data.contentHash);
    expect(result).toEqual({
      status: 'created',
      version: expect.objectContaining({ id: 'version-1', versionNumber: 1 }),
    });
    // the answer carries no stored text
    expect(Object.keys((result as { version: Row }).version)).not.toContain(
      'content'
    );
  });

  it('SR22 appends the next capture as version 2', async () => {
    const { repository, state } = setup();
    await create(repository);
    await append(repository, 0, 'one');
    expect(await append(repository, 1, 'two')).toMatchObject({
      status: 'created',
      version: { versionNumber: 2 },
    });
    expect(state.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(state.sources[0].latestVersionNumber).toBe(2);
  });

  it('SR23 refuses a stale expected version without writing', async () => {
    const { repository, source, version, state } = setup();
    await create(repository);
    await append(repository, 0, 'one');
    source.updateMany.mockClear();
    version.create.mockClear();
    expect(await append(repository, 0, 'two')).toEqual({
      status: 'conflict',
      currentVersionNumber: 1,
    });
    expect(source.updateMany).not.toHaveBeenCalled();
    expect(version.create).not.toHaveBeenCalled();
    expect(state.versions).toHaveLength(1);
  });

  it('SR24 never appends to an archived source', async () => {
    const { repository, state } = setup();
    await create(repository);
    await repository.archiveSource(ORG, SOURCE, NOW);
    expect(await append(repository, 0, 'one')).toEqual({ status: 'archived' });
    expect(state.versions).toEqual([]);
    expect(state.sources[0].latestVersionNumber).toBe(0);
  });

  it('SR25 answers not found for a missing or foreign source', async () => {
    const { repository, state } = setup();
    await create(repository);
    expect(
      await append(repository, 0, 'one', { organizationId: OTHER_ORG })
    ).toEqual({ status: 'not-found' });
    expect(
      await append(repository, 0, 'one', { sourceId: OTHER_SOURCE })
    ).toEqual({ status: 'not-found' });
    expect(state.versions).toEqual([]);
  });

  it('SR26-SR28 advances the number only for the organization, a live source and the expected number', async () => {
    const { repository, source } = setup();
    await create(repository);
    source.findFirst.mockClear();
    await append(repository, 0, 'one');
    expect(source.findFirst.mock.calls[0][0]).toEqual({
      where: { id: SOURCE, organizationId: ORG },
      select: { latestVersionNumber: true, archivedAt: true },
    });
    expect(source.updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: SOURCE,
        organizationId: ORG,
        archivedAt: null,
        latestVersionNumber: 0,
      },
      data: { latestVersionNumber: { increment: 1 } },
    });
  });

  it('SR29 makes a new version for a later capture with the same blocks', async () => {
    const { repository, version, state } = setup();
    await create(repository);
    await append(repository, 0, 'same');
    // the same text captured again: a capture is a version, not only a change
    expect(await append(repository, 1, 'same')).toMatchObject({
      status: 'created',
      version: { versionNumber: 2 },
    });
    expect(state.versions).toHaveLength(2);
    expect(state.versions[0].contentHash).toBe(state.versions[1].contentHash);
    // no read of the previous version's content to compare with
    expect(version.findFirst).not.toHaveBeenCalled();
  });

  it('SR30 lets only one of two captures take the next number', async () => {
    const { repository, source, state } = setup();
    await create(repository);
    // the other capture commits between this read and the update
    const realUpdate = source.updateMany.getMockImplementation();
    source.updateMany.mockImplementationOnce(async (args) => {
      state.sources[0].latestVersionNumber = 1;
      state.versions.push({ sourceId: SOURCE, versionNumber: 1 });
      return (realUpdate as typeof source.updateMany)(args);
    });
    expect(await append(repository, 0, 'late')).toEqual({ status: 'changed' });
    expect(state.versions.filter((v) => v.versionNumber === 1)).toHaveLength(1);
    expect(state.sources[0].latestVersionNumber).toBe(1);
  });

  it('rolls the number back when the version cannot be written', async () => {
    const { repository, version, state } = setup();
    await create(repository);
    version.create.mockRejectedValueOnce(new Error('database down'));
    await expect(append(repository, 0, 'one')).rejects.toThrow('database down');
    expect(state.sources[0].latestVersionNumber).toBe(0);
    expect(state.versions).toEqual([]);
  });
});

describe('ContentStudioSourceRepository: history', () => {
  it('SR31-SR34 reads versions of one source of the organization only, newest first, archived or not', async () => {
    const { repository, version } = setup();
    await create(repository);
    await create(repository, {
      id: OTHER_SOURCE,
      url: 'https://example.com/news/b',
    });
    await append(repository, 0, 'one');
    await append(repository, 1, 'two');
    await repository.archiveSource(ORG, SOURCE, NOW);

    const list = await repository.listVersionsForSource({
      organizationId: ORG,
      sourceId: SOURCE,
      skip: 0,
      take: 20,
    });
    expect(version.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, sourceId: SOURCE },
      orderBy: { versionNumber: 'desc' },
      select: VERSION_FIELDS,
      skip: 0,
      take: 20,
    });
    expect(list.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(list.map((v) => Object.keys(v))).not.toContainEqual(
      expect.arrayContaining(['content'])
    );
    expect(await repository.countVersionsForSource(ORG, SOURCE)).toBe(2);
    expect(await repository.countVersionsForSource(OTHER_ORG, SOURCE)).toBe(0);

    expect(
      await repository.getVersionForSource(ORG, SOURCE, 'version-2-two')
    ).toMatchObject({ versionNumber: 2, content: capture('two').content });
    // the version exists, but under another source or organization
    expect(
      await repository.getVersionForSource(ORG, OTHER_SOURCE, 'version-2-two')
    ).toBeNull();
    expect(
      await repository.getVersionForSource(OTHER_ORG, SOURCE, 'version-2-two')
    ).toBeNull();
    expect(version.findFirst.mock.calls.slice(-3).map(([a]) => a)).toEqual([
      {
        where: { id: 'version-2-two', sourceId: SOURCE, organizationId: ORG },
        select: { ...VERSION_FIELDS, content: true },
      },
      {
        where: {
          id: 'version-2-two',
          sourceId: OTHER_SOURCE,
          organizationId: ORG,
        },
        select: { ...VERSION_FIELDS, content: true },
      },
      {
        where: {
          id: 'version-2-two',
          sourceId: SOURCE,
          organizationId: OTHER_ORG,
        },
        select: { ...VERSION_FIELDS, content: true },
      },
    ]);

    // by number: metadata only, and organization scoped
    const current = await repository.getVersionByNumber(ORG, SOURCE, 2);
    expect(current).toMatchObject({ versionNumber: 2 });
    expect(Object.keys(current as Row)).not.toContain('content');
    expect(version.findFirst.mock.calls.at(-1)?.[0]).toEqual({
      where: { organizationId: ORG, sourceId: SOURCE, versionNumber: 2 },
      select: VERSION_FIELDS,
    });
    expect(
      await repository.getVersionByNumber(OTHER_ORG, SOURCE, 2)
    ).toBeNull();

    // by number with its content, for AI writing: organization and source
    // scoped like every other read
    expect(
      await repository.getVersionDetailByNumber(ORG, SOURCE, 2)
    ).toMatchObject({ versionNumber: 2, content: capture('two').content });
    expect(
      await repository.getVersionDetailByNumber(OTHER_ORG, SOURCE, 2)
    ).toBeNull();
    expect(
      await repository.getVersionDetailByNumber(ORG, OTHER_SOURCE, 2)
    ).toBeNull();
    expect(
      await repository.getVersionDetailByNumber(ORG, SOURCE, 3)
    ).toBeNull();
    expect(version.findFirst.mock.calls.slice(-4).map(([a]) => a)).toEqual([
      {
        where: { organizationId: ORG, sourceId: SOURCE, versionNumber: 2 },
        select: { ...VERSION_FIELDS, content: true },
      },
      {
        where: {
          organizationId: OTHER_ORG,
          sourceId: SOURCE,
          versionNumber: 2,
        },
        select: { ...VERSION_FIELDS, content: true },
      },
      {
        where: {
          organizationId: ORG,
          sourceId: OTHER_SOURCE,
          versionNumber: 2,
        },
        select: { ...VERSION_FIELDS, content: true },
      },
      {
        where: { organizationId: ORG, sourceId: SOURCE, versionNumber: 3 },
        select: { ...VERSION_FIELDS, content: true },
      },
    ]);
  });
});

describe('ContentStudioSourceRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('SR13/SR15 only ever creates versions, never changes a URL and deletes nothing', () => {
    expect(text).not.toMatch(
      /contentStudioSourceVersion\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(text.match(/contentStudioSourceVersion\.create\(/g)).toHaveLength(1);
    // canonicalUrl is written by createSourcesWithinLimit only
    expect(text.match(/canonicalUrl: source\.canonicalUrl/g)).toHaveLength(1);
    expect(text.match(/canonicalUrl: input\.canonicalUrl/g)).toBeNull();
    expect(text.match(/data: \{\s*canonicalUrl/g)).toBeNull();
  });

  it('reads no environment, network client, AI service or logger', () => {
    expect(text).not.toMatch(
      /process\.env|\bfetch\(|axios|undici|safe\.fetch|safeFetch|node:dns|from 'dns'|from 'http|ai\.execution|ai\.provider|console\.|Logger/
    );
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(module.match(/ContentStudioSourceRepository\b/g)).toHaveLength(2);
    expect(module.match(/ContentStudioSourceService\b/g)).toHaveLength(2);
  });
});

describe('ContentStudioSource schema', () => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const block = (name: string) => {
    const match = schema.match(
      new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`)
    );
    if (!match) {
      throw new Error(`model ${name} not found`);
    }
    return match[1];
  };
  const fields = (name: string) =>
    Object.fromEntries(
      block(name)
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([field]) => field && !field.startsWith('@@'))
        .map(([field, type]) => [field, type])
    );

  it('stores exactly these source and version fields, the kind as text', () => {
    expect(fields('ContentStudioSource')).toEqual({
      id: 'String',
      organizationId: 'String',
      kind: 'String',
      name: 'String',
      canonicalUrl: 'String?',
      latestVersionNumber: 'Int',
      archivedAt: 'DateTime?',
      createdById: 'String',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      // a feed's last successful capture (P8-01)
      lastCapturedAt: 'DateTime?',
      // a page's last page change, derived from its versions (P8-04B1)
      lastPageChangeAt: 'DateTime?',
      lastPageChangeVersionNumber: 'Int?',
      lastPageChangeKind: 'String?',
      lastPageChangePreviousCaptureAt: 'DateTime?',
      organization: 'Organization',
      createdBy: 'User',
      versions: 'ContentStudioSourceVersion[]',
      feedDiscoveries: 'ContentStudioSourceDiscovery[]',
      discoveredBy: 'ContentStudioSourceDiscovery[]',
    });
    expect(block('ContentStudioSource')).toMatch(
      /latestVersionNumber\s+Int\s+@default\(0\)/
    );
    expect(fields('ContentStudioSourceVersion')).toEqual({
      id: 'String',
      organizationId: 'String',
      sourceId: 'String',
      versionNumber: 'Int',
      schemaVersion: 'Int',
      extractionVersion: 'String',
      requestedUrl: 'String',
      finalUrl: 'String',
      redirectCount: 'Int',
      fetchedAt: 'DateTime',
      httpStatus: 'Int?',
      contentType: 'String?',
      contentLength: 'Int?',
      title: 'String?',
      content: 'String',
      contentHash: 'String',
      sourceHash: 'String?',
      createdById: 'String',
      createdAt: 'DateTime',
      organization: 'Organization',
      source: 'ContentStudioSource',
      createdBy: 'User',
    });
    expect(schema).not.toMatch(/enum ContentStudioSource/);
  });

  it('binds a version to a source of its own organization, numbered once, and a URL to one source per organization', () => {
    const version = block('ContentStudioSourceVersion');
    expect(version).toMatch(
      /source\s+ContentStudioSource\s+@relation\(fields: \[sourceId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(version).toMatch(/@@unique\(\[sourceId, versionNumber\]\)/);
    expect(version).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(version).toMatch(/@@index\(\[sourceId, createdAt\]\)/);
    const source = block('ContentStudioSource');
    expect(source).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(source).toMatch(/@@unique\(\[organizationId, canonicalUrl\]\)/);
    expect(source).toMatch(/@@index\(\[organizationId, archivedAt\]\)/);
    expect(source).toMatch(/@@index\(\[organizationId, kind\]\)/);
    expect(block('Organization')).toMatch(
      /contentStudioSources\s+ContentStudioSource\[\]\n\s+contentStudioSourceVersions\s+ContentStudioSourceVersion\[\]/
    );
    expect(block('User')).toMatch(
      /contentStudioSources\s+ContentStudioSource\[\]\s+@relation\("ContentStudioSourceCreatedBy"\)/
    );
    expect(block('User')).toMatch(
      /contentStudioSourceVersions\s+ContentStudioSourceVersion\[\]\s+@relation\("ContentStudioSourceVersionCreatedBy"\)/
    );
  });
});

// P3-11: the versions a package's grounding names, by exact id, in one query
describe('ContentStudioSourceRepository: grounding evidence versions', () => {
  it('reads exactly the named versions of this organization, with their content and source', async () => {
    const { repository, version } = setup();
    await create(repository);
    await append(repository, 0, 'one');
    await append(repository, 1, 'two');
    const ids = ['version-1-one', 'version-9-missing'];
    const rows = await repository.getVersionsByIdsForOrganization(ORG, ids);
    expect(version.findMany.mock.calls.at(-1)?.[0]).toEqual({
      where: { organizationId: ORG, id: { in: ids } },
      select: {
        ...VERSION_FIELDS,
        content: true,
        sourceId: true,
        source: { select: { name: true } },
      },
    });
    // the named version only: never the latest one of its source
    expect(
      rows.map((row) => [row.id, row.versionNumber, row.sourceId])
    ).toEqual([['version-1-one', 1, SOURCE]]);
    expect(rows[0].content).toBe(capture('one').content);
    expect(
      await repository.getVersionsByIdsForOrganization(OTHER_ORG, ids)
    ).toEqual([]);
  });
});
