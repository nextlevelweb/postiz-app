import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { parseContentStudioSourceVersionInput } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import {
  CONTENT_STUDIO_ACTIVE_FEEDS_MAX,
  CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
  CONTENT_STUDIO_URL_SOURCES_MAX,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

// No database: the repository is mocked; the URL canonicalizer, the content
// parser, canonical JSON and hashing run for real
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});
const uuid = jest.mocked(randomUUID);

const MARKER = 'SOURCE_SERVICE_SECRET_MARKER_123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const OTHER_SOURCE = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const VERSION = '66666666-6666-4666-8666-666666666666';
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const T0 = new Date('2026-10-15T10:00:00.000Z');
const FETCHED = new Date('2026-10-15T09:00:00.000Z');
const URL_A = 'https://example.com/news/a';

const stored = (text = `Body ${MARKER}`) =>
  parseContentStudioSourceVersionInput({
    requestedUrl: URL_A,
    finalUrl: URL_A,
    redirectCount: 0,
    fetchedAt: FETCHED,
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 900,
    title: 'News A',
    sourceHash: 'c'.repeat(64),
    extractionVersion: CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
    content: {
      schemaVersion: 1,
      blocks: [
        { id: 'h1', type: 'heading', text: 'News A', level: 1 },
        { id: 'p1', type: 'paragraph', text, level: null },
      ],
    },
  });

const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  id: SOURCE,
  kind: 'url',
  name: 'Example news',
  canonicalUrl: URL_A,
  latestVersionNumber: 2,
  archivedAt: null as Date | null,
  createdAt: T0,
  updatedAt: T0,
  lastCapturedAt: null as Date | null,
  scanPausedAt: null as Date | null,
  // a feed's schedule (P8-C4); null, null and 0 for a page
  captureIntervalMinutes: null as number | null,
  nextCaptureAt: null as Date | null,
  consecutiveCaptureFailures: 0,
  ...overrides,
});
const versionSummaryRow = (overrides: Record<string, unknown> = {}) => {
  const data = stored();
  return {
    id: VERSION,
    versionNumber: 2,
    schemaVersion: data.schemaVersion,
    extractionVersion: data.extractionVersion,
    requestedUrl: data.requestedUrl,
    finalUrl: data.finalUrl,
    redirectCount: data.redirectCount,
    fetchedAt: data.fetchedAt,
    httpStatus: data.httpStatus,
    contentType: data.contentType,
    contentLength: data.contentLength,
    title: data.title,
    contentHash: data.contentHash,
    sourceHash: data.sourceHash,
    createdAt: T0,
    ...overrides,
  };
};
const versionDetailRow = (overrides: Record<string, unknown> = {}) => ({
  ...versionSummaryRow(),
  content: stored().content,
  ...overrides,
});

const setup = () => {
  const repository = {
    listSourcesForOrganization: jest.fn(async () => [
      { ...sourceRow(), organizationId: ORG, createdById: USER },
    ]),
    countSourcesForOrganization: jest.fn(async () => 41),
    getSourceForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === SOURCE ? sourceRow() : null
    ),
    getSourceByCanonicalUrlForOrganization: jest.fn(
      async (_organizationId: string, _url: string): Promise<unknown> => null
    ),
    createSourcesWithinLimit: jest.fn(
      async (input: {
        kind: string;
        limit: number;
        sources: Array<{ id: string; name: string; canonicalUrl: string }>;
      }): Promise<Record<string, unknown>> => ({
        status: 'decided',
        results: input.sources.map((one) => ({
          status: 'created',
          source: sourceRow({
            id: one.id,
            kind: input.kind,
            name: one.name,
            canonicalUrl: one.canonicalUrl,
            latestVersionNumber: 0,
          }),
        })),
      })
    ),
    updateSourceName: jest.fn(async () => ({ count: 1 })),
    archiveSource: jest.fn(async () => ({ count: 1 })),
    pauseFeed: jest.fn(async () => ({ count: 1 })),
    resumeFeed: jest.fn(async () => ({ count: 1 })),
    restoreSourceWithinLimit: jest.fn(
      async (): Promise<Record<string, unknown>> => ({ status: 'restored' })
    ),
    listVersionsForSource: jest.fn(async () => [
      versionSummaryRow(),
      versionSummaryRow({ id: NEW_ID, versionNumber: 1 }),
    ]),
    countVersionsForSource: jest.fn(async () => 2),
    getVersionForSource: jest.fn(
      async (organizationId: string, sourceId: string, id: string) =>
        organizationId === ORG && sourceId === SOURCE && id === VERSION
          ? versionDetailRow()
          : null
    ),
    getVersionByNumber: jest.fn(
      async (): Promise<unknown> => versionSummaryRow()
    ),
    appendVersionWithCompareAndSwap: jest.fn(),
  };
  const service = new ContentStudioSourceService(
    repository as unknown as ContentStudioSourceRepository,
    {} as ContentStudioSourceDiscoveryRepository
  );
  return { repository, service };
};
type Repository = ReturnType<typeof setup>['repository'];

const writes = (repository: Repository) =>
  [
    repository.createSourcesWithinLimit,
    repository.updateSourceName,
    repository.archiveSource,
    repository.restoreSourceWithinLimit,
    repository.appendVersionWithCompareAndSwap,
  ].flatMap((fn) => (fn as jest.Mock).mock.calls);

const httpError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const text = [
    String(err),
    JSON.stringify((err as HttpException).getResponse()),
    inspect(err, { depth: 6 }),
  ].join('\n');
  expect(text).not.toContain(MARKER);
  expect(text).not.toMatch(/example\.com|[0-9a-f]{64}|zod|Prisma|P200/);
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse() as Record<string, unknown>,
  };
};

const NOT_FOUND = { msg: 'Source not found.', code: 'CS_NOT_FOUND' };
const INVALID = { msg: 'The source is invalid.', code: 'CS_SOURCE_INVALID' };
const URL_INVALID = {
  msg: 'The source URL is invalid.',
  code: 'CS_SOURCE_URL_INVALID',
};
const EXISTS = {
  msg: 'This source already exists.',
  code: 'CS_SOURCE_ALREADY_EXISTS',
};
const ARCHIVED = {
  msg: 'This source is archived.',
  code: 'CS_SOURCE_ARCHIVED',
};
const INTEGRITY = {
  msg: 'Stored source data could not be verified.',
  code: 'CS_SOURCE_INTEGRITY_ERROR',
};
const SUMMARY_KEYS = [
  'archivedAt',
  'canonicalUrl',
  'captureIntervalMinutes',
  'consecutiveCaptureFailures',
  'createdAt',
  'id',
  'kind',
  'lastCapturedAt',
  'latestVersionNumber',
  'name',
  'nextCaptureAt',
  'scanPausedAt',
  'updatedAt',
];
const VERSION_KEYS = [
  'contentHash',
  'contentLength',
  'contentType',
  'createdAt',
  'extractionVersion',
  'fetchedAt',
  'finalUrl',
  'httpStatus',
  'id',
  'redirectCount',
  'requestedUrl',
  'schemaVersion',
  'sourceHash',
  'title',
  'versionNumber',
];

const createInput = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  userId: USER,
  kind: 'url',
  name: 'Example news',
  url: URL_A,
  ...overrides,
});

beforeEach(() => {
  uuid.mockReturnValue(NEW_ID as ReturnType<typeof randomUUID>);
});

describe('ContentStudioSourceService: create', () => {
  it('SS1-SS3/SS8/SS10-SS12 creates a url source for any member, the request organization and user, without a version', async () => {
    const { repository, service } = setup();
    const result = await service.createSource(
      createInput({ url: 'HTTPS://Example.com:443/news/a#comments' })
    );

    expect(
      repository.getSourceByCanonicalUrlForOrganization
    ).toHaveBeenCalledWith(ORG, URL_A);
    expect(repository.createSourcesWithinLimit).toHaveBeenCalledWith({
      organizationId: ORG,
      kind: 'url',
      createdById: USER,
      // a page counts against all the organization's pages (P8-C1)
      limit: CONTENT_STUDIO_URL_SOURCES_MAX,
      sources: [{ id: NEW_ID, name: 'Example news', canonicalUrl: URL_A }],
    });
    expect(result).toEqual({
      id: NEW_ID,
      kind: 'url',
      name: 'Example news',
      canonicalUrl: URL_A,
      latestVersionNumber: 0,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
      lastCapturedAt: null,
      scanPausedAt: null,
      captureIntervalMinutes: null,
      nextCaptureAt: null,
      consecutiveCaptureFailures: 0,
    });
    expect(repository.appendVersionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('SK2/72/73 P8-01 creates a feed like a page: same name and URL rules, no fetch, and one canonical URL is one source whatever its kind', async () => {
    const { repository, service } = setup();
    await service.createSource(
      createInput({ kind: 'feed', url: 'HTTPS://Example.com:443/news/a#x' })
    );
    expect(repository.createSourcesWithinLimit).toHaveBeenCalledWith({
      organizationId: ORG,
      kind: 'feed',
      createdById: USER,
      // a feed against its live feeds (P8-C1)
      limit: CONTENT_STUDIO_ACTIVE_FEEDS_MAX,
      sources: [{ id: NEW_ID, name: 'Example news', canonicalUrl: URL_A }],
    });
    expect(repository.appendVersionWithCompareAndSwap).not.toHaveBeenCalled();
    // a page at that address already exists: the feed is refused
    repository.getSourceByCanonicalUrlForOrganization.mockResolvedValueOnce(
      sourceRow()
    );
    expect(
      await httpError(service.createSource(createInput({ kind: 'feed' })))
    ).toEqual({
      status: 409,
      body: {
        msg: 'This source already exists.',
        code: 'CS_SOURCE_ALREADY_EXISTS',
      },
    });
  });

  it('SS4/SK3 refuses any kind but url and feed', async () => {
    const { repository, service } = setup();
    for (const kind of [
      'URL',
      'Feed',
      'FEED',
      'feeds',
      'atom',
      'web',
      'website',
      'rss',
      'cms',
      'file',
      'constructor',
      'toString',
      '__proto__',
      '',
      undefined,
      null,
      ['url'],
    ]) {
      expect(
        await httpError(service.createSource(createInput({ kind })))
      ).toEqual({ status: 400, body: INVALID });
    }
    expect(writes(repository)).toEqual([]);
  });

  it('SS5-SS7 trims the name and needs 1-200 safe characters', async () => {
    const { repository, service } = setup();
    await service.createSource(createInput({ name: '  Example news \n' }));
    expect(
      repository.createSourcesWithinLimit.mock.calls[0][0].sources[0].name
    ).toBe('Example news');
    await service.createSource(createInput({ name: 'n'.repeat(200) }));
    for (const name of [
      '',
      '   ',
      'n'.repeat(201),
      `a\u0000${MARKER}`,
      `a\uD800${MARKER}`,
      42,
      null,
    ]) {
      expect(
        await httpError(service.createSource(createInput({ name })))
      ).toEqual({ status: 400, body: INVALID });
    }
    expect(repository.createSourcesWithinLimit).toHaveBeenCalledTimes(2);
  });

  it('SS9 refuses an invalid URL with a fixed error that does not repeat it', async () => {
    const { repository, service } = setup();
    for (const url of [
      'ftp://example.com/a',
      'javascript:alert(1)',
      `https://user:${MARKER}@example.com/`,
      `https://example.com/${'a'.repeat(2048)}`,
      `https://example.com/a\n${MARKER}`,
      'not a url',
      42,
    ]) {
      expect(
        await httpError(service.createSource(createInput({ url })))
      ).toEqual({ status: 400, body: URL_INVALID });
    }
    expect(writes(repository)).toEqual([]);
  });

  it('accepts a private address: SafeFetch, not the canonicalizer, refuses it at ingestion', async () => {
    const { repository, service } = setup();
    await service.createSource(createInput({ url: 'http://127.0.0.1/admin' }));
    expect(
      repository.createSourcesWithinLimit.mock.calls[0][0].sources[0]
        .canonicalUrl
    ).toBe('http://127.0.0.1/admin');
  });

  it('SS13 refuses a URL the organization already tracks, archived or not, without its id', async () => {
    const { repository, service } = setup();
    repository.getSourceByCanonicalUrlForOrganization.mockResolvedValueOnce(
      sourceRow({ archivedAt: T0 })
    );
    const error = await httpError(
      service.createSource(createInput({ url: `${URL_A}#other` }))
    );
    expect(error).toEqual({ status: 409, body: EXISTS });
    expect(JSON.stringify(error)).not.toContain(SOURCE);
    expect(repository.createSourcesWithinLimit).not.toHaveBeenCalled();
  });

  it('maps a unique-key race on create to the same conflict and lets other errors through', async () => {
    const { repository, service } = setup();
    repository.createSourcesWithinLimit.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(`Unique ${MARKER}`, {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    expect(await httpError(service.createSource(createInput()))).toEqual({
      status: 409,
      body: EXISTS,
    });
    const other = new Error('database down');
    repository.createSourcesWithinLimit.mockRejectedValueOnce(other);
    await expect(service.createSource(createInput())).rejects.toBe(other);
  });

  it('SS14 looks up the URL in the request organization only', async () => {
    const { repository, service } = setup();
    // a source of another organization with the same URL is not looked at
    repository.getSourceByCanonicalUrlForOrganization.mockImplementation(
      async (organizationId: string) =>
        organizationId === OTHER_ORG ? sourceRow() : null
    );
    await expect(service.createSource(createInput())).resolves.toMatchObject({
      id: NEW_ID,
    });
    expect(
      repository.getSourceByCanonicalUrlForOrganization.mock.calls
    ).toEqual([[ORG, URL_A]]);
  });
});

describe('ContentStudioSourceService: list', () => {
  it('SS15-SS18 lists a page of summaries, active or archived, never content or internal ids', async () => {
    const { repository, service } = setup();
    const result = await service.listSources({
      organizationId: ORG,
      archived: false,
      page: 3,
    });
    expect(repository.listSourcesForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      archived: false,
      skip: 40,
      take: 20,
    });
    expect(repository.countSourcesForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      archived: false,
    });
    expect(result.pages).toBe(3);
    expect(Object.keys(result.results[0]).sort()).toEqual(SUMMARY_KEYS);

    await service.listSources({ organizationId: ORG, archived: true, page: 1 });
    expect(repository.listSourcesForOrganization).toHaveBeenLastCalledWith({
      organizationId: ORG,
      archived: true,
      skip: 0,
      take: 20,
    });
  });

  it('K1/K2 P8-02 passes one kind to the list and its count; none keeps every kind', async () => {
    const { repository, service } = setup();
    await service.listSources({
      organizationId: ORG,
      archived: false,
      kind: 'feed',
      page: 1,
    });
    expect(repository.listSourcesForOrganization).toHaveBeenLastCalledWith({
      organizationId: ORG,
      archived: false,
      kind: 'feed',
      skip: 0,
      take: 20,
    });
    expect(repository.countSourcesForOrganization).toHaveBeenLastCalledWith({
      organizationId: ORG,
      archived: false,
      kind: 'feed',
    });
    await service.listSources({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(
      (repository.countSourcesForOrganization.mock.calls as unknown[][]).at(
        -1
      )![0]
    ).toStrictEqual({ organizationId: ORG, archived: false, kind: undefined });
  });
});

describe('ContentStudioSourceService: detail and lifecycle', () => {
  it('SS19 shows a source without versions with currentVersion null', async () => {
    const { repository, service } = setup();
    repository.getSourceForOrganization.mockResolvedValueOnce(
      sourceRow({ latestVersionNumber: 0 })
    );
    expect(await service.getSource(ORG, SOURCE)).toEqual({
      ...sourceRow({ latestVersionNumber: 0 }),
      currentVersion: null,
    });
    expect(repository.getVersionByNumber).not.toHaveBeenCalled();
  });

  it('SS20/SS21 shows the latest version metadata, never its blocks', async () => {
    const { repository, service } = setup();
    const result = await service.getSource(ORG, SOURCE);
    expect(repository.getVersionByNumber).toHaveBeenCalledWith(ORG, SOURCE, 2);
    expect(result).toEqual({
      ...sourceRow(),
      currentVersion: versionSummaryRow(),
    });
    expect(Object.keys(result.currentVersion as object).sort()).toEqual(
      VERSION_KEYS
    );
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('answers a fixed 500 when the current version is missing', async () => {
    const { repository, service } = setup();
    repository.getVersionByNumber.mockResolvedValueOnce(null);
    expect(await httpError(service.getSource(ORG, SOURCE))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });

  it('SS22 keeps an archived source readable', async () => {
    const { repository, service } = setup();
    repository.getSourceForOrganization.mockResolvedValueOnce(
      sourceRow({ archivedAt: T0 })
    );
    await expect(service.getSource(ORG, SOURCE)).resolves.toMatchObject({
      archivedAt: T0,
      currentVersion: { versionNumber: 2 },
    });
  });

  it('SS23/SS24 answers 404 for a missing, foreign or malformed source, malformed without a query', async () => {
    const { repository, service } = setup();
    expect(await httpError(service.getSource(OTHER_ORG, SOURCE))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    expect(await httpError(service.getSource(ORG, OTHER_SOURCE))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    repository.getSourceForOrganization.mockClear();
    for (const id of [
      'abc',
      `${SOURCE}x`,
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      '',
      MARKER,
    ]) {
      expect(await httpError(service.getSource(ORG, id))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(repository.getSourceForOrganization).not.toHaveBeenCalled();
  });

  it('SS25/SS26 renames a live source for any member, name only', async () => {
    const { repository, service } = setup();
    await expect(
      service.renameSource(ORG, SOURCE, '  Renamed  ')
    ).resolves.toEqual(sourceRow());
    expect(repository.updateSourceName).toHaveBeenCalledWith(
      ORG,
      SOURCE,
      'Renamed'
    );
    expect(
      await httpError(service.renameSource(ORG, SOURCE, 'n'.repeat(201)))
    ).toEqual({ status: 400, body: INVALID });
  });

  it('SS27 refuses to rename an archived source, and answers 404 when it is gone', async () => {
    const { repository, service } = setup();
    repository.updateSourceName.mockResolvedValueOnce({ count: 0 });
    repository.getSourceForOrganization.mockResolvedValueOnce(
      sourceRow({ archivedAt: T0 })
    );
    expect(await httpError(service.renameSource(ORG, SOURCE, 'New'))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
    repository.updateSourceName.mockResolvedValueOnce({ count: 0 });
    expect(
      await httpError(service.renameSource(OTHER_ORG, SOURCE, 'New'))
    ).toEqual({ status: 404, body: NOT_FOUND });
  });

  it('SS28-SS31 archives and restores idempotently, without touching versions', async () => {
    const { repository, service } = setup();
    await expect(service.archiveSource(ORG, SOURCE)).resolves.toEqual(
      sourceRow()
    );
    expect(repository.archiveSource).toHaveBeenCalledWith(
      ORG,
      SOURCE,
      expect.any(Date)
    );
    repository.archiveSource.mockResolvedValueOnce({ count: 0 });
    await expect(service.archiveSource(ORG, SOURCE)).resolves.toEqual(
      sourceRow()
    );
    await expect(service.restoreSource(ORG, SOURCE)).resolves.toEqual(
      sourceRow()
    );
    repository.restoreSourceWithinLimit.mockResolvedValueOnce({
      status: 'unchanged',
    });
    await expect(service.restoreSource(ORG, SOURCE)).resolves.toEqual(
      sourceRow()
    );
    expect(repository.restoreSourceWithinLimit).toHaveBeenCalledWith({
      organizationId: ORG,
      id: SOURCE,
      activeFeedsMax: CONTENT_STUDIO_ACTIVE_FEEDS_MAX,
    });
    expect(repository.appendVersionWithCompareAndSwap).not.toHaveBeenCalled();
    expect(await httpError(service.archiveSource(OTHER_ORG, SOURCE))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    repository.archiveSource.mockClear();
    expect(await httpError(service.archiveSource(ORG, 'x'))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    expect(repository.archiveSource).not.toHaveBeenCalled();
  });
});

describe('ContentStudioSourceService: versions', () => {
  it('SS32-SS35 lists the history newest first, metadata only, active or archived', async () => {
    const { repository, service } = setup();
    const result = await service.listVersions({
      organizationId: ORG,
      sourceId: SOURCE,
      page: 2,
    });
    expect(repository.listVersionsForSource).toHaveBeenCalledWith({
      organizationId: ORG,
      sourceId: SOURCE,
      skip: 20,
      take: 20,
    });
    expect(repository.countVersionsForSource).toHaveBeenCalledWith(ORG, SOURCE);
    expect(result.pages).toBe(1);
    expect(result.results.map((v) => v.versionNumber)).toEqual([2, 1]);
    for (const row of result.results) {
      expect(Object.keys(row).sort()).toEqual(VERSION_KEYS);
    }
    expect(JSON.stringify(result)).not.toContain(MARKER);

    repository.getSourceForOrganization.mockResolvedValueOnce(
      sourceRow({ archivedAt: T0 })
    );
    await expect(
      service.listVersions({ organizationId: ORG, sourceId: SOURCE, page: 1 })
    ).resolves.toMatchObject({ pages: 1 });
    expect(
      await httpError(
        service.listVersions({
          organizationId: OTHER_ORG,
          sourceId: SOURCE,
          page: 1,
        })
      )
    ).toEqual({ status: 404, body: NOT_FOUND });
  });

  it('SS36 shows a verified version with its structured blocks', async () => {
    const { service } = setup();
    const result = await service.getVersion({
      organizationId: ORG,
      sourceId: SOURCE,
      versionId: VERSION,
    });
    expect(result).toEqual({
      ...versionSummaryRow(),
      content: {
        schemaVersion: 1,
        blocks: [
          { id: 'h1', type: 'heading', text: 'News A', level: 1 },
          {
            id: 'p1',
            type: 'paragraph',
            text: `Body ${MARKER}`,
            level: null,
          },
        ],
      },
    });
    expect(Object.keys(result).sort()).toEqual(
      [...VERSION_KEYS, 'content'].sort()
    );
  });

  it('XV4 still reads a version captured by an older extractor, as it was stored', async () => {
    const { repository, service } = setup();
    repository.getVersionForSource.mockResolvedValueOnce(
      versionDetailRow({ extractionVersion: 'content-studio-source-v1' })
    );
    const result = await service.getVersion({
      organizationId: ORG,
      sourceId: SOURCE,
      versionId: VERSION,
    });
    expect(result.extractionVersion).toBe('content-studio-source-v1');
    expect(result.content.blocks).toHaveLength(2);
  });

  it('SS37/SS38 answers 404 for a version of another source or organization', async () => {
    const { repository, service } = setup();
    for (const input of [
      { organizationId: ORG, sourceId: OTHER_SOURCE, versionId: VERSION },
      { organizationId: OTHER_ORG, sourceId: SOURCE, versionId: VERSION },
      { organizationId: ORG, sourceId: SOURCE, versionId: NEW_ID },
    ]) {
      expect(await httpError(service.getVersion(input))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(repository.getVersionForSource.mock.calls).toEqual([
      [ORG, OTHER_SOURCE, VERSION],
      [OTHER_ORG, SOURCE, VERSION],
      [ORG, SOURCE, NEW_ID],
    ]);
  });

  it('SS39 answers 404 for a malformed id without a query', async () => {
    const { repository, service } = setup();
    for (const input of [
      { organizationId: ORG, sourceId: SOURCE, versionId: 'v1' },
      { organizationId: ORG, sourceId: 'bad', versionId: VERSION },
      { organizationId: ORG, sourceId: SOURCE, versionId: `${VERSION} ` },
    ]) {
      expect(await httpError(service.getVersion(input))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(repository.getVersionForSource).not.toHaveBeenCalled();
  });

  it('SS40/SS41 answers a fixed 500 for a corrupted version without quoting it', async () => {
    const { repository, service } = setup();
    const valid = versionDetailRow();
    for (const corrupt of [
      { content: `{"broken":"${MARKER}"` },
      { contentHash: 'f'.repeat(64) },
      { schemaVersion: 2 },
      {
        content: valid.content.replace(MARKER, `${MARKER}!`),
      },
      {
        content: JSON.stringify(JSON.parse(valid.content), null, 2),
      },
    ]) {
      repository.getVersionForSource.mockResolvedValueOnce({
        ...valid,
        ...corrupt,
      });
      expect(
        await httpError(
          service.getVersion({
            organizationId: ORG,
            sourceId: SOURCE,
            versionId: VERSION,
          })
        )
      ).toEqual({ status: 500, body: INTEGRITY });
    }
  });
});

describe('ContentStudioSourceService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.source.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('SS2 has no role, billing, AI or provider dependency', () => {
    expect(text).not.toMatch(
      /Role\.|assertManager|CheckPolicies|Sections\.|subscription|stripe|credit|AIExecution|ai\.execution|ai\.provider|AIProviderResolver|generateText|from 'openai'|@anthropic-ai|@ai-sdk/i
    );
  });

  it('logs nothing and never serializes source data for a message', () => {
    expect(text).not.toMatch(/console\.|Logger|JSON\.stringify|\.message\b/);
  });

  it('offers no way to append, change or delete a version', () => {
    expect(
      Object.getOwnPropertyNames(ContentStudioSourceService.prototype)
        .filter((name) => !['constructor'].includes(name))
        .sort()
    ).toEqual([
      'archiveSource',
      'assertId',
      // the page-change backfill (P8-04B1): derived fields only, never a
      // version
      'backfillPageChange',
      'backfillPageChanges',
      'canonicalUrl',
      'createSource',
      // a feed's interval (P8-C4): no version, no capture
      'feedInterval',
      'getRow',
      'getSource',
      'getVersion',
      // read only (P8-04A)
      'getVersionChanges',
      'intactContent',
      'lastPageChange',
      'listDiscoveries',
      'listOrganizationDiscoveries',
      // read only (P8-04B1)
      'listPageChanges',
      'listSources',
      'listVersions',
      // a feed's scheduled captures (P8-C3): no version, no capture
      'liveFeed',
      'pauseFeed',
      'renameSource',
      'restoreSource',
      'resumeFeed',
      'search',
      'setFeedInterval',
      'sourceName',
      'toPublicDiscovery',
    ]);
    expect(text).not.toMatch(/appendVersionWithCompareAndSwap/);
  });
});

describe('ContentStudioSourceService: organization limits (P8-C1)', () => {
  const FEED_LIMIT = {
    msg: 'The organization has too many active feeds.',
    code: 'CS_SOURCE_FEED_LIMIT',
  };
  const SOURCE_LIMIT = {
    msg: 'The organization has too many sources.',
    code: 'CS_SOURCE_LIMIT',
  };
  const CONFLICT = {
    msg: 'The sources changed meanwhile. Try again.',
    code: 'CS_SOURCE_CONFLICT',
  };

  it('FC2/SC2 a create at the limit is refused for its kind, with nothing created', async () => {
    const { repository, service } = setup();
    repository.createSourcesWithinLimit.mockResolvedValueOnce({
      status: 'decided',
      results: [{ status: 'limit' }],
    });
    expect(
      await httpError(service.createSource(createInput({ kind: 'feed' })))
    ).toEqual({ status: 409, body: FEED_LIMIT });
    repository.createSourcesWithinLimit.mockResolvedValueOnce({
      status: 'decided',
      results: [{ status: 'limit' }],
    });
    expect(await httpError(service.createSource(createInput()))).toEqual({
      status: 409,
      body: SOURCE_LIMIT,
    });
  });

  it('FC7 a duplicate URL is CS_SOURCE_ALREADY_EXISTS before any limit, also when it appears inside the transaction', async () => {
    const { repository, service } = setup();
    repository.getSourceByCanonicalUrlForOrganization.mockResolvedValueOnce(
      sourceRow({ kind: 'feed' })
    );
    expect(
      await httpError(service.createSource(createInput({ kind: 'feed' })))
    ).toEqual({ status: 409, body: EXISTS });
    expect(repository.createSourcesWithinLimit).not.toHaveBeenCalled();
    repository.createSourcesWithinLimit.mockResolvedValueOnce({
      status: 'decided',
      results: [{ status: 'exists', source: sourceRow({ kind: 'feed' }) }],
    });
    expect(
      await httpError(service.createSource(createInput({ kind: 'feed' })))
    ).toEqual({ status: 409, body: EXISTS });
  });

  it('FC10 a transaction that lost every attempt is a safe 409, never a Prisma error', async () => {
    const { repository, service } = setup();
    repository.createSourcesWithinLimit.mockResolvedValueOnce({
      status: 'conflict',
    });
    expect(await httpError(service.createSource(createInput()))).toEqual({
      status: 409,
      body: CONFLICT,
    });
    repository.restoreSourceWithinLimit.mockResolvedValueOnce({
      status: 'conflict',
    });
    expect(await httpError(service.restoreSource(ORG, SOURCE))).toEqual({
      status: 409,
      body: CONFLICT,
    });
  });

  it('FC5 a restore at the feed limit is refused; the source stays as it is', async () => {
    const { repository, service } = setup();
    repository.restoreSourceWithinLimit.mockResolvedValueOnce({
      status: 'limit',
    });
    expect(await httpError(service.restoreSource(ORG, SOURCE))).toEqual({
      status: 409,
      body: FEED_LIMIT,
    });
    expect(repository.getSourceForOrganization).not.toHaveBeenCalled();
    // a source that is not there is a 404, as before
    repository.restoreSourceWithinLimit.mockResolvedValueOnce({
      status: 'not-found',
    });
    expect(await httpError(service.restoreSource(OTHER_ORG, SOURCE))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
  });

  it('the limits come from the request organization, never from the request body', async () => {
    const { repository, service } = setup();
    await service.createSource({
      ...createInput(),
      limit: 1,
      activeFeedsMax: 1,
      urlSourcesMax: 1,
    } as Parameters<typeof service.createSource>[0]);
    expect(repository.createSourcesWithinLimit.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      limit: CONTENT_STUDIO_URL_SOURCES_MAX,
    });
  });
});

describe('ContentStudioSourceService: feed pause (P8-C3)', () => {
  const PAUSED_AT = new Date('2026-10-20T08:00:00.000Z');
  const KIND = {
    msg: 'This source type has no scheduled captures.',
    code: 'CS_SOURCE_KIND_UNSUPPORTED',
  };
  // the feed as the repository reads it, one read after another
  const feedReads = (repository: Repository, ...rows: unknown[]) => {
    for (const row of rows) {
      repository.getSourceForOrganization.mockResolvedValueOnce(row as never);
    }
  };
  const feed = (overrides: Record<string, unknown> = {}) =>
    sourceRow({ kind: 'feed', latestVersionNumber: 0, ...overrides });

  it('pauses a running feed of the request organization, answering it paused', async () => {
    const { repository, service } = setup();
    feedReads(repository, feed(), feed({ scanPausedAt: PAUSED_AT }));
    const before = Date.now();
    await expect(service.pauseFeed(ORG, SOURCE)).resolves.toEqual(
      feed({ scanPausedAt: PAUSED_AT })
    );
    expect(repository.getSourceForOrganization).toHaveBeenCalledWith(
      ORG,
      SOURCE
    );
    expect(repository.pauseFeed).toHaveBeenCalledTimes(1);
    const [organizationId, id, pausedAt] = repository.pauseFeed.mock
      .calls[0] as unknown as [string, string, Date];
    expect([organizationId, id]).toEqual([ORG, SOURCE]);
    expect(pausedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(pausedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(repository.resumeFeed).not.toHaveBeenCalled();
    expect(writes(repository)).toEqual([]);
  });

  it('API1-API4 the answer carries scanPausedAt: null for a running feed and a page, the time for a paused feed', async () => {
    const { repository, service } = setup();
    feedReads(repository, feed(), feed());
    // resuming a running feed: the feed as it is
    const running = await service.resumeFeed(ORG, SOURCE);
    expect(running.scanPausedAt).toBeNull();
    expect(Object.keys(running).sort()).toEqual(SUMMARY_KEYS);
    feedReads(repository, feed({ scanPausedAt: PAUSED_AT }));
    feedReads(repository, feed({ scanPausedAt: PAUSED_AT }));
    expect((await service.pauseFeed(ORG, SOURCE)).scanPausedAt).toEqual(
      PAUSED_AT
    );
    // a page read without the field (as before P8-C3) answers null
    const page = await service.getSource(ORG, SOURCE);
    expect(page.scanPausedAt).toBeNull();
    const {
      scanPausedAt: _omitted,
      captureIntervalMinutes: _interval,
      nextCaptureAt: _next,
      consecutiveCaptureFailures: _failures,
      ...withoutField
    } = sourceRow();
    repository.listSourcesForOrganization.mockResolvedValueOnce([
      { ...withoutField, organizationId: ORG, createdById: USER } as never,
    ]);
    const list = await service.listSources({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(list.results[0].scanPausedAt).toBeNull();
    // P8-C4: and the schedule as for a page: null, null and 0
    expect(list.results[0]).toMatchObject({
      captureIntervalMinutes: null,
      nextCaptureAt: null,
      consecutiveCaptureFailures: 0,
    });
  });

  it('EP4/M2 pausing a paused feed changes nothing: its first pause time stays', async () => {
    const { repository, service } = setup();
    feedReads(
      repository,
      feed({ scanPausedAt: PAUSED_AT }),
      feed({ scanPausedAt: PAUSED_AT })
    );
    await expect(service.pauseFeed(ORG, SOURCE)).resolves.toEqual(
      feed({ scanPausedAt: PAUSED_AT })
    );
    expect(repository.pauseFeed).not.toHaveBeenCalled();
  });

  it('resumes a paused feed, and resuming a running one changes nothing', async () => {
    const { repository, service } = setup();
    feedReads(repository, feed({ scanPausedAt: PAUSED_AT }), feed());
    await expect(service.resumeFeed(ORG, SOURCE)).resolves.toEqual(feed());
    expect(repository.resumeFeed).toHaveBeenCalledWith(ORG, SOURCE);
    repository.resumeFeed.mockClear();
    feedReads(repository, feed(), feed());
    await expect(service.resumeFeed(ORG, SOURCE)).resolves.toEqual(feed());
    expect(repository.resumeFeed).not.toHaveBeenCalled();
    expect(repository.pauseFeed).not.toHaveBeenCalled();
  });

  it('EP1 a source of another organization, or no source id, is a plain 404, with nothing written', async () => {
    const { repository, service } = setup();
    for (const action of ['pauseFeed', 'resumeFeed'] as const) {
      expect(await httpError(service[action](OTHER_ORG, SOURCE))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
      expect(await httpError(service[action](ORG, 'x'))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(repository.pauseFeed).not.toHaveBeenCalled();
    expect(repository.resumeFeed).not.toHaveBeenCalled();
  });

  it('EP3/M4 a page has no schedule: pause and resume are CS_SOURCE_KIND_UNSUPPORTED, archived or not', async () => {
    const { repository, service } = setup();
    for (const row of [sourceRow(), sourceRow({ archivedAt: T0 })]) {
      for (const action of ['pauseFeed', 'resumeFeed'] as const) {
        feedReads(repository, row);
        expect(await httpError(service[action](ORG, SOURCE))).toEqual({
          status: 400,
          body: KIND,
        });
      }
    }
    expect(repository.pauseFeed).not.toHaveBeenCalled();
    expect(repository.resumeFeed).not.toHaveBeenCalled();
  });

  it('EP2/M5 an archived feed is read-only: CS_SOURCE_ARCHIVED, paused or not, with nothing written', async () => {
    const { repository, service } = setup();
    for (const row of [
      feed({ archivedAt: T0 }),
      feed({ archivedAt: T0, scanPausedAt: PAUSED_AT }),
    ]) {
      for (const action of ['pauseFeed', 'resumeFeed'] as const) {
        feedReads(repository, row);
        expect(await httpError(service[action](ORG, SOURCE))).toEqual({
          status: 409,
          body: ARCHIVED,
        });
      }
    }
    expect(repository.pauseFeed).not.toHaveBeenCalled();
    expect(repository.resumeFeed).not.toHaveBeenCalled();
  });

  it('a feed archived during the pause is answered CS_SOURCE_ARCHIVED: archive goes first', async () => {
    const { repository, service } = setup();
    repository.pauseFeed.mockResolvedValueOnce({ count: 0 });
    feedReads(repository, feed(), feed({ archivedAt: T0 }));
    expect(await httpError(service.pauseFeed(ORG, SOURCE))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
  });

  it('M14 neither captures, counts or changes anything else: no ingestion, limit or version', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.source.service.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf('  async pauseFeed('),
      text.indexOf('  // History stays readable when the source is archived')
    );
    expect(block).toContain('this._contentStudioSourceRepository.pauseFeed(');
    expect(block).toContain('this._contentStudioSourceRepository.resumeFeed(');
    expect(block).not.toMatch(
      /refresh|capture\(|Ingestion|safeFetch|Limit|limits|Version|archiveSource|restore|temporal|workflow/i
    );
  });
});
