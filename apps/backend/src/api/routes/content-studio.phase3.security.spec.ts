import fs from 'fs';
import path from 'path';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Prisma } from '@prisma/client';
import { ContentStudioController } from '@gitroom/backend/api/routes/content-studio.controller';
import {
  CreateContentStudioSourceDto,
  UpdateContentStudioSourceDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.source.dto';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import {
  toPublicContentStudioSource,
  toPublicContentStudioSourceVersion,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { parseContentStudioAIOperationContext } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the composer serializer needs a DOM. Neither is used here
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: (text: string) => text,
}));

// The Phase 3 security decisions in one place (P3-06), pinned on the source
// and the route metadata: who may use sources, what the routes take, which
// code may reach the network, what a version and an AI operation may hold,
// and what the Source Library may send. The behavior behind each line is
// covered by the unit specs of each layer and by the PostgreSQL integration
// suite; this spec keeps the decisions from drifting. The architecture guard
// stays the authority on network and HTML sinks. Comments are stripped: they
// explain the rules and may name them
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const code = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const PRISMA = 'libraries/nestjs-libraries/src/database/prisma/content-studio';
const SOURCES = 'libraries/nestjs-libraries/src/content-studio/sources';
const FILES = {
  controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
  sourceService: `${PRISMA}/content-studio.source.service.ts`,
  sourceRepository: `${PRISMA}/content-studio.source.repository.ts`,
  ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
  aiWriting: `${PRISMA}/content-studio.ai-writing.service.ts`,
  aiExecution:
    'libraries/nestjs-libraries/src/content-studio/ai/ai.execution.service.ts',
  aiOperationRepository: `${PRISMA}/content-studio.ai-operation.repository.ts`,
  dto: 'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts',
  frontendApi:
    'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
};
const SOURCE = Object.fromEntries(
  Object.entries(FILES).map(([name, file]) => [name, code(file)])
) as Record<keyof typeof FILES, string>;

// The body of one class method: from its name to the next method
const method = (source: string, name: string) => {
  const start = source.search(
    new RegExp(`\\n  (private )?(async )?${name}\\(`)
  );
  expect(start).toBeGreaterThan(-1);
  const next = source
    .slice(start + 1)
    .search(/\n  (private )?(async )?[a-zA-Z]+\(/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
};

// Every Content Studio route, from Nest's own metadata
const prototype = ContentStudioController.prototype as unknown as Record<
  string,
  object
>;
const handlers = Object.getOwnPropertyNames(prototype).filter(
  (name) => name !== 'constructor'
);
const routeOf = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, prototype[name])]
  } ${Reflect.getMetadata(PATH_METADATA, prototype[name])}`;
const sourceHandlers = handlers.filter((name) =>
  / \/sources/.test(routeOf(name))
);
const argsOf = (name: string) =>
  Object.entries(
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, ContentStudioController, name) ||
      {}) as Record<string, { data?: string }>
  ).map(([key, value]) => ({
    type: Number(key.split(':')[0]) as RouteParamtypes,
    data: value.data,
  }));

// Every production .ts/.tsx file under these roots
const walk = (dir: string): string[] =>
  fs
    .readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? ['node_modules', 'dist', '.next'].includes(entry.name)
          ? []
          : walk(`${dir}/${entry.name}`)
        : [`${dir}/${entry.name}`]
    )
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.(spec|test)\.tsx?$/.test(file) &&
        !file.endsWith('.d.ts')
    );
const PRODUCTION = [
  'libraries/nestjs-libraries/src',
  'libraries/helpers/src',
  'apps/backend/src',
  'apps/orchestrator/src',
  'apps/frontend/src',
].flatMap(walk);

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const refusedFields = async (metatype: unknown, body: object) => {
  try {
    await pipe.transform(body, {
      type: 'body',
      metatype: metatype as never,
    });
    return [];
  } catch (err) {
    return (
      (err as { response?: { message?: string[] } }).response?.message || []
    );
  }
};

// ten since P8-01 added the discoveries of a feed (read only)
const NINE_ROUTES = [
  'GET /sources',
  'GET /sources/:id',
  'GET /sources/:id/discoveries',
  'GET /sources/:id/versions',
  'GET /sources/:id/versions/:versionId',
  'PATCH /sources/:id',
  'POST /sources',
  'POST /sources/:id/archive',
  'POST /sources/:id/refresh',
  'POST /sources/:id/restore',
];

describe('Phase 3 source authorization', () => {
  it('P3TRUST1 there are exactly the ten source routes', () => {
    expect(sourceHandlers.map(routeOf).sort()).toEqual(NINE_ROUTES);
  });

  it('P3AUTH1/P3AUTH2 every member may use them: no role, policy, guard or billing gate', () => {
    for (const name of sourceHandlers) {
      expect(Reflect.getMetadataKeys(prototype[name])).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/polic|guard|role/i)])
      );
    }
    for (const file of ['sourceService', 'ingestion'] as const) {
      expect([file, SOURCE[file]]).not.toEqual([
        file,
        expect.stringMatching(
          /assertManager|MANAGER_ROLES|Role\.|ADMIN|\.role\b|CheckPolicies|Sections\.|subscription|billing|credits?\b|wallet|stripe/i
        ),
      ]);
    }
  });

  it('P3AUTH3 a source route takes the organization and user from the request, never from the body', () => {
    for (const name of sourceHandlers) {
      const args = argsOf(name);
      // the organization: the only custom decorator every source handler has
      expect(
        args.filter((arg) => arg.type === RouteParamtypes.BODY).length
      ).toBeLessThanOrEqual(1);
      const block = method(SOURCE.controller, name);
      expect(block).toContain('@GetOrgFromRequest() org: Organization');
      expect(block).not.toMatch(/body\.(organizationId|userId|createdById)/);
      expect(block).toMatch(/org\.id/);
    }
  });

  it('P3TRUST2 refresh takes the path id only: no body, query, header or request object', () => {
    const args = argsOf('refreshSource');
    expect(
      args.filter((arg) =>
        [
          RouteParamtypes.BODY,
          RouteParamtypes.QUERY,
          RouteParamtypes.HEADERS,
          RouteParamtypes.REQUEST,
        ].includes(arg.type)
      )
    ).toEqual([]);
    expect(
      args
        .filter((arg) => arg.type === RouteParamtypes.PARAM)
        .map((a) => a.data)
    ).toEqual(['id']);
    // the target is the stored source: ingestion reads it from the repository
    expect(method(SOURCE.ingestion, 'refreshSource')).toContain(
      'getSourceForOrganization'
    );
  });

  it('P3TRUST3 no route writes a version, fetches a given address or deletes', () => {
    const all = handlers.map(routeOf);
    expect(
      all.filter((r) => r.startsWith('DELETE ') && /sources/.test(r))
    ).toEqual([]);
    expect(
      all.filter(
        (r) =>
          /sources/.test(r) &&
          (/^(PUT|PATCH|POST) .*versions/.test(r) ||
            /fetch|preview|proxy|ingest|crawl|scrape|import|url/i.test(r))
      )
    ).toEqual([]);
  });
});

describe('Phase 3 network boundary', () => {
  const importsSafeFetch = (file: string) =>
    /from '[^']*dtos\/webhooks\/safe\.fetch'/.test(code(file));

  it('P3NET1 the source ingestion service is the only Content Studio importer of SafeFetch', () => {
    const importers = PRODUCTION.filter(
      (file) => /content-studio/.test(file) && importsSafeFetch(file)
    );
    expect(importers).toEqual([FILES.ingestion]);
    // the test seam is never used in production code
    expect(
      PRODUCTION.filter(
        (file) =>
          !file.endsWith('dtos/webhooks/safe.fetch.ts') &&
          /\bcreateSafeFetch\b/.test(code(file))
      )
    ).toEqual([]);
  });

  it('P3NET2 grounding, the source service and the repository reach no network and no ingestion', () => {
    for (const file of [
      'aiWriting',
      'aiExecution',
      'sourceService',
      'sourceRepository',
    ] as const) {
      expect([file, SOURCE[file]]).not.toEqual([
        file,
        expect.stringMatching(
          /safe\.fetch|safeFetch|source\.ingestion|IngestionService|\bfetch\(|axios|node:https?|from 'https?'|undici|node:net|node:dns/
        ),
      ]);
    }
  });
});

describe('Phase 3 immutable versions', () => {
  it('P3IMM1 the repository has no write for a version but the append, and no delete at all', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioSourceRepository.prototype
    );
    expect(
      names.filter((n) => /delete|remove|upsert|replace/i.test(n))
    ).toEqual([]);
    expect(names.filter((n) => /update|set/i.test(n))).toEqual([
      'updateSourceName',
    ]);
    const versionCalls = new Set(
      Array.from(
        SOURCE.sourceRepository.matchAll(/contentStudioSourceVersion\.(\w+)/g)
      ).map((m) => m[1])
    );
    expect([...versionCalls].sort()).toEqual(
      ['count', 'create', 'findFirst', 'findMany'].sort()
    );
    // the one create is inside the compare-and-swap transaction
    expect(
      method(SOURCE.sourceRepository, 'appendVersionWithCompareAndSwap')
    ).toContain('tx.contentStudioSourceVersion.create');
    const sourceCalls = new Set(
      Array.from(
        SOURCE.sourceRepository.matchAll(/contentStudioSource\.(\w+)/g)
      ).map((m) => m[1])
    );
    expect([...sourceCalls].sort()).toEqual(
      ['count', 'create', 'findFirst', 'findMany', 'updateMany'].sort()
    );
  });

  it('P3IMM1 no source update can touch the URL, the kind or the organization', () => {
    for (const name of ['updateSourceName', 'archiveSource', 'restoreSource']) {
      const data = method(SOURCE.sourceRepository, name).split('data:')[1];
      expect(data).not.toMatch(
        /canonicalUrl|kind|organizationId|createdById|latestVersionNumber/
      );
    }
  });

  it('P3IMM2 a create or rename body cannot carry provenance, a version or an owner', async () => {
    const forged = {
      organizationId: 'org',
      createdById: 'user',
      canonicalUrl: 'https://forged.example/',
      latestVersionNumber: 9,
      requestedUrl: 'https://forged.example/',
      finalUrl: 'https://forged.example/',
      fetchedAt: '2026-10-15T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64),
      content: { schemaVersion: 1, blocks: [] },
      blocks: [],
      extractionVersion: 'content-studio-source-v2',
    };
    const create = await refusedFields(CreateContentStudioSourceDto, {
      kind: 'url',
      name: 'n',
      url: 'https://example.com/',
      ...forged,
    });
    const rename = await refusedFields(UpdateContentStudioSourceDto, {
      name: 'n',
      url: 'https://example.com/',
      kind: 'url',
      ...forged,
    });
    for (const field of Object.keys(forged)) {
      expect(create).toContain(`property ${field} should not exist`);
      expect(rename).toContain(`property ${field} should not exist`);
    }
    expect(rename).toEqual(
      expect.arrayContaining([
        'property url should not exist',
        'property kind should not exist',
      ])
    );
    expect(
      await refusedFields(CreateContentStudioSourceDto, {
        kind: 'url',
        name: 'n',
        url: 'https://example.com/',
      })
    ).toEqual([]);
  });
});

describe('Phase 3 AI operations and source material', () => {
  const ref = {
    sourceId: '11111111-1111-4111-8111-111111111111',
    versionId: '22222222-2222-4222-8222-222222222222',
    versionNumber: 1,
    contentHash: 'c'.repeat(64),
  };

  it('P3AI1 an operation names a source version by ids and its content hash only', () => {
    expect(
      parseContentStudioAIOperationContext({ v: 1, sources: [ref] })
    ).toEqual({ v: 1, sources: [ref] });
    for (const extra of [
      { content: 'text' },
      { blocks: [] },
      { title: 'title' },
      { name: 'name' },
      { url: 'https://example.com/' },
      { sourceHash: 'd'.repeat(64) },
      { verified: true },
    ]) {
      expect(
        parseContentStudioAIOperationContext({
          v: 1,
          sources: [{ ...ref, ...extra }],
        })
      ).toBeUndefined();
    }
    // the service builds the reference with exactly these four fields
    const refs = SOURCE.aiWriting.slice(
      SOURCE.aiWriting.indexOf('sources: sources.map((source) => ({'),
      SOURCE.aiWriting.indexOf(
        '}))',
        SOURCE.aiWriting.indexOf('sources: sources.map((source) => ({')
      )
    );
    expect(
      Array.from(refs.matchAll(/^\s*(\w+): source\.\w+,?$/gm)).map((m) => m[1])
    ).toEqual(['sourceId', 'versionId', 'versionNumber', 'contentHash']);
  });

  it('P3AI2 source text goes to the prompt only: the execution and operation layers never see a source', () => {
    for (const file of ['aiExecution', 'aiOperationRepository'] as const) {
      expect([file, SOURCE[file]]).not.toEqual([
        file,
        expect.stringMatching(
          /content-studio\/sources|SourceRepository|SourceVersion/
        ),
      ]);
    }
    // the operation context is the refs, never the resolved sources
    expect(method(SOURCE.aiWriting, 'run')).toContain(
      'context: { v: 1, ...target, ...refs }'
    );
    expect(
      Object.keys(Prisma.ContentStudioAIOperationScalarFieldEnum).concat(
        Object.keys(Prisma.ContentStudioAIUsageScalarFieldEnum)
      )
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          // promptVersion names a template, not a prompt
          /^prompt$|prompt(Text|Body)|system|source(Id|Hash|Text|Name)|content|title|url|^text$|blocks/i
        ),
      ])
    );
  });

  it('P3FACT/P3HTML no source or AI column or public field claims truth or holds HTML', () => {
    const fields = [
      ...Object.keys(Prisma.ContentStudioSourceScalarFieldEnum),
      ...Object.keys(Prisma.ContentStudioSourceVersionScalarFieldEnum),
      ...Object.keys(Prisma.ContentStudioAIOperationScalarFieldEnum),
      ...Object.keys(Prisma.ContentStudioAIUsageScalarFieldEnum),
      ...Object.keys(
        toPublicContentStudioSource({
          id: 'i',
          kind: 'url',
          name: 'n',
          canonicalUrl: null,
          latestVersionNumber: 0,
          archivedAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })
      ),
      ...Object.keys(
        toPublicContentStudioSourceVersion({
          id: 'i',
          versionNumber: 1,
          schemaVersion: 1,
          extractionVersion: 'e',
          requestedUrl: 'u',
          finalUrl: 'u',
          redirectCount: 0,
          fetchedAt: new Date(0),
          httpStatus: null,
          contentType: null,
          contentLength: null,
          title: null,
          contentHash: 'h',
          sourceHash: null,
          createdAt: new Date(0),
        })
      ),
    ];
    expect(fields.length).toBeGreaterThan(40);
    expect(
      fields.filter((field) =>
        /verif|fact|trust|credib|reliab|accura|score|html/i.test(field)
      )
    ).toEqual([]);
  });
});

describe('Phase 3 Source Library trust surface', () => {
  const api = SOURCE.frontendApi;

  it('P3UI1 the browser calls only the ten source routes', () => {
    expect(
      Array.from(api.matchAll(/['`](\/content-studio[^'`]*)['`]/g)).map(
        (m) => m[1]
      )
    ).toEqual(['/content-studio/sources']);
    const suffixes = Array.from(
      api.matchAll(/\$\{sourcePath\([a-z]+\)\}(\/[a-z]+)/g)
    ).map((m) => m[1]);
    expect([...new Set(suffixes)].sort()).toEqual([
      '/archive',
      // a feed's pages (P8-01), read only
      '/discoveries',
      '/refresh',
      '/restore',
      '/versions',
    ]);
    expect(
      Array.from(api.matchAll(/method: '([A-Z]+)'/g)).map((m) => m[1])
    ).toEqual(['POST', 'PATCH', 'POST', 'POST', 'POST']);
    expect(api).not.toMatch(/'DELETE'|'PUT'|\/fetch|\/preview|\/ingest/);
  });

  it('P3UI1/34/92 it cannot forge a version: create sends kind, name and url; rename its name; capture nothing', () => {
    expect(
      Array.from(api.matchAll(/JSON\.stringify\(([^)]*)\)/g)).map((m) => m[1])
    ).toEqual(['{ kind, name, url }', '{ name }']);
    expect(api).toMatch(
      /`\$\{sourcePath\(id\)\}\/refresh`,\s*\{ method: 'POST' \}/
    );
    expect(api).not.toMatch(
      /createVersion|updateVersion|deleteVersion|ingest|provenance/i
    );
  });
});
