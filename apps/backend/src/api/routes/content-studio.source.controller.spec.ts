import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import fs from 'fs';
import path from 'path';
import { Organization, User } from '@prisma/client';
import { ContentStudioController } from '@gitroom/backend/api/routes/content-studio.controller';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioAIConnectionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';
import { ContentStudioWritingProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioAudienceProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.service';
import { ContentStudioExpertiseProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.service';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { ContentStudioBrandKitService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioRenderFontService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import {
  CreateContentStudioSourceDto,
  ListContentStudioSourcesDto,
  ListContentStudioSourceVersionsDto,
  UpdateContentStudioSourceDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.source.dto';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the composer serializer needs a DOM. Neither is used by these routes
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: (text: string) => text,
}));

const MARKER = 'SOURCE_CONTROLLER_SECRET_MARKER_123';
const ID = '33333333-3333-4333-8333-333333333333';
const VERSION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: sources need no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const setup = () => {
  const result = { from: 'service' };
  const sources = {
    listSources: jest.fn().mockResolvedValue(result),
    createSource: jest.fn().mockResolvedValue(result),
    getSource: jest.fn().mockResolvedValue(result),
    renameSource: jest.fn().mockResolvedValue(result),
    listVersions: jest.fn().mockResolvedValue(result),
    getVersion: jest.fn().mockResolvedValue(result),
    archiveSource: jest.fn().mockResolvedValue(result),
    restoreSource: jest.fn().mockResolvedValue(result),
  };
  const ingestion = {
    refreshSource: jest.fn().mockResolvedValue(result),
  };
  const controller = new ContentStudioController(
    {} as ContentStudioService,
    {} as ContentStudioHandoffService,
    {} as ContentStudioAIConnectionService,
    {} as ContentStudioWritingProfileService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioAudienceProfileService,
    {} as ContentStudioExpertiseProfileService,
    {} as ContentStudioAIWritingService,
    sources as unknown as ContentStudioSourceService,
    ingestion as unknown as ContentStudioSourceIngestionService,
    {} as ContentStudioBrandKitService,
    {} as ContentStudioDesignService,
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    {} as ContentStudioDesignReferenceService
  );
  return { sources, ingestion, controller, result };
};

// Provenance a client might try to send: the controller must forward only the
// declared fields even if a DTO carried more
const PROVENANCE = {
  organizationId: 'org-b',
  createdById: 'user-b',
  canonicalUrl: 'https://forged.example/',
  latestVersionNumber: 9,
  versionNumber: 9,
  content: { schemaVersion: 1, blocks: [] },
  blocks: [],
  requestedUrl: 'https://forged.example/',
  finalUrl: 'https://forged.example/',
  redirectCount: 0,
  fetchedAt: '2026-10-15T00:00:00.000Z',
  httpStatus: 200,
  contentType: 'text/html',
  contentLength: 1,
  title: MARKER,
  sourceHash: 'a'.repeat(64),
  contentHash: 'b'.repeat(64),
  extractionVersion: 'content-studio-source-v1',
};
const withExtras = <T extends object>(dto: T) => Object.assign(dto, PROVENANCE);

const prototype = ContentStudioController.prototype as unknown as Record<
  string,
  object
>;
const handler = (name: string) => prototype[name];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;
const allRoutes = () =>
  Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map(route);

describe('ContentStudioController source routes', () => {
  it('SRC1-SRC8/CR1 declares exactly these nine routes, with 200 for archive, restore and refresh', () => {
    expect(
      allRoutes()
        .filter((r) => / \/sources/.test(r))
        .sort()
    ).toEqual([
      'GET /sources',
      'GET /sources/:id',
      'GET /sources/:id/versions',
      'GET /sources/:id/versions/:versionId',
      'PATCH /sources/:id',
      'POST /sources',
      'POST /sources/:id/archive',
      'POST /sources/:id/refresh',
      'POST /sources/:id/restore',
    ]);
    for (const name of ['archiveSource', 'restoreSource', 'refreshSource']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createSource'))
    ).toBeUndefined();
  });

  it('CR10 has no route that creates a version, fetches a given URL, verifies, grounds or deletes', () => {
    const routes = allRoutes();
    expect(
      routes.filter(
        (r) =>
          /sources/.test(r) &&
          r !== 'POST /sources/:id/refresh' &&
          (/^(DELETE|PUT) /.test(r) ||
            /^POST .*versions/.test(r) ||
            /^PATCH .*versions/.test(r) ||
            /fetch|ingest|refresh|crawl|scrape|proxy|preview|url|verif|fact|ground|research|radar|import|upload|ai\b/i.test(
              r
            ))
      )
    ).toEqual([]);
    expect(routes).not.toContain('POST /sources/:id/versions');
    expect(routes.filter((r) => r.startsWith('DELETE '))).toEqual([]);
  });

  it('SRC1 lists for the request organization', async () => {
    const { sources, controller, result } = setup();
    const query = Object.assign(new ListContentStudioSourcesDto(), {
      page: 2,
      archived: true,
    });
    await expect(controller.listSources(ORG, query)).resolves.toBe(result);
    expect(sources.listSources).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
  });

  it('SRC2 creates for the request organization and user with kind, name and url only', async () => {
    const { sources, controller } = setup();
    const body = withExtras(new CreateContentStudioSourceDto());
    body.kind = 'url';
    body.name = 'Example news';
    body.url = 'https://example.com/news/a';
    await controller.createSource(ORG, USER, body);
    expect(sources.createSource).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      kind: 'url',
      name: 'Example news',
      url: 'https://example.com/news/a',
    });
  });

  it('SRC3/SRC4 reads and renames with the request organization', async () => {
    const { sources, controller } = setup();
    await controller.getSource(ORG, ID);
    const body = withExtras(new UpdateContentStudioSourceDto());
    body.name = 'Renamed';
    await controller.updateSource(ORG, ID, body);
    expect(sources.getSource).toHaveBeenCalledWith('org-a', ID);
    expect(sources.renameSource).toHaveBeenCalledWith('org-a', ID, 'Renamed');
  });

  it('SRC5/SRC6 reads the history and one version of the request organization', async () => {
    const { sources, controller } = setup();
    const query = Object.assign(new ListContentStudioSourceVersionsDto(), {
      page: 3,
    });
    await controller.listSourceVersions(ORG, ID, query);
    await controller.getSourceVersion(ORG, ID, VERSION);
    expect(sources.listVersions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      sourceId: ID,
      page: 3,
    });
    expect(sources.getVersion).toHaveBeenCalledWith({
      organizationId: 'org-a',
      sourceId: ID,
      versionId: VERSION,
    });
  });

  it('SRC7/SRC8 archives and restores for any member of the request organization', async () => {
    const { sources, controller } = setup();
    await controller.archiveSource(ORG, ID);
    await controller.restoreSource(ORG, ID);
    expect(sources.archiveSource).toHaveBeenCalledWith('org-a', ID);
    expect(sources.restoreSource).toHaveBeenCalledWith('org-a', ID);
  });

  it('declares the DTOs and adds no role, billing, AI or network gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('listSources')[1]).toBe(ListContentStudioSourcesDto);
    expect(types('createSource')[2]).toBe(CreateContentStudioSourceDto);
    expect(types('updateSource')[2]).toBe(UpdateContentStudioSourceDto);
    expect(types('listSourceVersions')[2]).toBe(
      ListContentStudioSourceVersionsDto
    );
    const text = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.controller.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    expect(text).not.toMatch(/CheckPolicies|Sections\.|@Delete\(/);
    const block = text.slice(
      text.indexOf("@Get('/sources')"),
      text.indexOf("@Get('/writing-profiles')")
    );
    expect(block.match(/@(Get|Post|Patch|Put|Delete)\(/g)).toHaveLength(9);
    expect(block).not.toMatch(
      /AIConnection|AIExecution|Role\.|assertManager|actor|users|appendVersion|safeFetch|fetch\(/
    );
  });
});

// Runs a request value through the pipes Nest would use: the global
// ValidationPipe from main.ts first, then the pipe declared on the controller
const controllerPipes = (): PipeTransform[] =>
  Reflect.getMetadata(PIPES_METADATA, ContentStudioController);
const globalPipe = new ValidationPipe({ transform: true });
const run = async (
  metatype: ArgumentMetadata['metatype'],
  value: unknown,
  type: ArgumentMetadata['type'] = 'body'
) => {
  const metadata: ArgumentMetadata = { type, metatype, data: undefined };
  let current = await globalPipe.transform(value, metadata);
  for (const pipe of controllerPipes()) {
    current = await pipe.transform(current, metadata);
  }
  return current;
};
const rejected = async (
  metatype: ArgumentMetadata['metatype'],
  value: unknown,
  type: ArgumentMetadata['type'] = 'body'
) => {
  const error = await run(metatype, value, type).then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(BadRequestException);
  const message = JSON.stringify((error as BadRequestException).getResponse());
  expect(message).not.toContain(MARKER);
  return message;
};
const CREATE = {
  kind: 'url',
  name: 'Example news',
  url: 'https://example.com/news/a',
};

describe('Source DTO validation', () => {
  it('SD1 accepts a valid create body as sent; the service checks kind and url', async () => {
    const body = await run(CreateContentStudioSourceDto, CREATE);
    expect(body).toBeInstanceOf(CreateContentStudioSourceDto);
    expect({ ...body }).toEqual(CREATE);
    // kind and URL syntax are the service's: it answers its fixed codes
    expect({
      ...(await run(CreateContentStudioSourceDto, {
        ...CREATE,
        kind: 'rss',
        url: 'ftp://x',
      })),
    }).toEqual({ ...CREATE, kind: 'rss', url: 'ftp://x' });
  });

  it.each([
    ['SD2 no kind', { name: CREATE.name, url: CREATE.url }],
    ['SD3 no name', { kind: 'url', url: CREATE.url }],
    ['SD4 no url', { kind: 'url', name: CREATE.name }],
    ['a kind that is no text', { ...CREATE, kind: 1 }],
    ['a name over 200 characters', { ...CREATE, name: 'n'.repeat(201) }],
    [
      'a url over 2048 characters',
      { ...CREATE, url: `https://example.com/${'a'.repeat(2048)}` },
    ],
    ['a url that is no text', { ...CREATE, url: { href: CREATE.url } }],
  ])('refuses a create body with %s', async (_name, body) => {
    await rejected(CreateContentStudioSourceDto, body);
  });

  it.each(
    Object.entries({
      'SD5 organizationId': 'organizationId',
      'SD6 createdById': 'createdById',
      'SD7 canonicalUrl': 'canonicalUrl',
      'SD8 latestVersionNumber': 'latestVersionNumber',
      'SD9 content': 'content',
      'SD10 finalUrl': 'finalUrl',
      'SD11 fetchedAt': 'fetchedAt',
      'SD12 sourceHash': 'sourceHash',
      'SD13 contentHash': 'contentHash',
      'SD14 extractionVersion': 'extractionVersion',
      requestedUrl: 'requestedUrl',
      redirectCount: 'redirectCount',
      httpStatus: 'httpStatus',
      contentType: 'contentType',
      contentLength: 'contentLength',
      title: 'title',
      blocks: 'blocks',
      versionNumber: 'versionNumber',
      archivedAt: 'archivedAt',
    })
  )('refuses a create body with %s', async (_name, field) => {
    const message = await rejected(CreateContentStudioSourceDto, {
      ...CREATE,
      [field]: (PROVENANCE as Record<string, unknown>)[field] ?? null,
    });
    expect(message).toContain(`property ${field} should not exist`);
  });

  it('SD15/SD16 takes a rename with the name only', async () => {
    expect({
      ...(await run(UpdateContentStudioSourceDto, { name: 'Renamed' })),
    }).toEqual({ name: 'Renamed' });
    await rejected(UpdateContentStudioSourceDto, {});
    for (const field of [
      'url',
      'canonicalUrl',
      'kind',
      'latestVersionNumber',
      'content',
      'organizationId',
      'archivedAt',
    ]) {
      const message = await rejected(UpdateContentStudioSourceDto, {
        name: 'Renamed',
        [field]: 'x',
      });
      expect(message).toContain(`property ${field} should not exist`);
    }
  });

  it('SD17/SD18 parses the list queries exactly', async () => {
    expect({
      ...(await run(ListContentStudioSourcesDto, {}, 'query')),
    }).toEqual({ page: 1, archived: false });
    expect({
      ...(await run(
        ListContentStudioSourcesDto,
        { page: '100000', archived: 'true' },
        'query'
      )),
    }).toEqual({ page: 100000, archived: true });
    for (const query of [
      { archived: 'yes' },
      { archived: '1' },
      { page: '0' },
      { page: '100001' },
      { page: '1.5' },
      { page: 'abc' },
      { organizationId: 'org-b' },
      { kind: 'url' },
    ]) {
      await rejected(ListContentStudioSourcesDto, query, 'query');
    }
    expect({
      ...(await run(
        ListContentStudioSourceVersionsDto,
        { page: '2' },
        'query'
      )),
    }).toEqual({ page: 2 });
    for (const query of [{ page: '-1' }, { page: '0' }, { archived: 'true' }]) {
      await rejected(ListContentStudioSourceVersionsDto, query, 'query');
    }
  });
});

describe('Source trusted-provenance boundary', () => {
  it('no public route, DTO or handler can create a version with fetch provenance', async () => {
    // no route: the only source routes that write are these
    expect(
      allRoutes()
        .filter((r) => /\/sources/.test(r) && !/^GET /.test(r))
        .sort()
    ).toEqual([
      'PATCH /sources/:id',
      'POST /sources',
      'POST /sources/:id/archive',
      'POST /sources/:id/refresh',
      'POST /sources/:id/restore',
    ]);
    // no handler that reaches the append
    const controller = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.controller.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    expect(controller).not.toMatch(
      /appendVersion|SourceVersionInput|parseContentStudioSourceVersionInput/
    );
    // no DTO: the only body DTOs of the source routes declare no provenance
    const dto = fs.readFileSync(
      path.join(
        __dirname,
        '../../../../../libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts'
      ),
      'utf8'
    );
    expect(dto.match(/^export class \w+/gm)).toEqual([
      'export class ListContentStudioSourcesDto',
      'export class CreateContentStudioSourceDto',
      'export class UpdateContentStudioSourceDto',
      'export class ListContentStudioSourceVersionsDto',
    ]);
    const body = await rejected(CreateContentStudioSourceDto, {
      ...CREATE,
      ...PROVENANCE,
    });
    for (const field of Object.keys(PROVENANCE)) {
      expect(body).toContain(`property ${field} should not exist`);
    }
  });
});

describe('ContentStudioController source refresh', () => {
  const refreshBlock = () => {
    const text = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.controller.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    const start = text.indexOf("@Post('/sources/:id/refresh')");
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf('\n  }\n', start));
  };

  it('CR1/CR2 is POST /sources/:id/refresh and answers 200', () => {
    expect(route('refreshSource')).toBe('POST /sources/:id/refresh');
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('refreshSource'))
    ).toBe(200);
  });

  it('CR3-CR5/CR7 refreshes for any member, with the request organization, user and path id only', async () => {
    const { ingestion, sources, controller, result } = setup();
    await expect(controller.refreshSource(ORG, USER, ID)).resolves.toBe(result);
    expect(ingestion.refreshSource).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      sourceId: ID,
    });
    expect(Object.values(sources).every((fn) => !fn.mock.calls.length)).toBe(
      true
    );
  });

  it('CR6 takes no body, query or DTO: nothing about the fetch comes from the request', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      ContentStudioController,
      'refreshSource'
    ) as Record<string, { index: number; data?: string }>;
    const keys = Object.keys(args);
    expect(keys).toHaveLength(3);
    expect(
      keys.filter(
        (key) =>
          key.startsWith(`${RouteParamtypes.BODY}:`) ||
          key.startsWith(`${RouteParamtypes.QUERY}:`) ||
          key.startsWith(`${RouteParamtypes.HEADERS}:`) ||
          key.startsWith(`${RouteParamtypes.REQUEST}:`)
      )
    ).toEqual([]);
    const params = keys.filter((key) =>
      key.startsWith(`${RouteParamtypes.PARAM}:`)
    );
    expect(params.map((key) => args[key].data)).toEqual(['id']);
    expect(
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        'refreshSource'
      )
    ).toHaveLength(3);
    expect(refreshBlock()).not.toMatch(/@Body|@Query|@Headers|@Req|Dto/);
  });

  it('CR8/CR9 adds no admin, policy, billing or AI gate', () => {
    expect(refreshBlock()).toContain(
      '_contentStudioSourceIngestionService.refreshSource'
    );
    expect(refreshBlock()).not.toMatch(
      /CheckPolicies|UseGuards|Sections\.|Role\.|assertManager|users|AIConnection|AIExecution|safeFetch|fetch\(|url/i
    );
  });
});
