import { ContentStudioAISetupService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-setup.service';
import { ContentStudioActivationService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.activation.service';
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
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { ContentStudioDesignStylePresetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-style-preset.service';
import { ContentStudioDesignLayoutPatternService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-layout-pattern.service';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioDesignBlockService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-block.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import {
  CreateContentStudioSourceDto,
  ListContentStudioSourcesDto,
  ListContentStudioSourceVersionsDto,
  ListContentStudioSourceDiscoveriesDto,
  ListContentStudioDiscoveriesDto,
  ListContentStudioFeedCapturesDto,
  ListContentStudioSourceChangesDto,
  SetContentStudioFeedIntervalDto,
  UpdateContentStudioSourceDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.source.dto';
import { ContentStudioDesignAIService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-ai.service';

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
    getVersionChanges: jest.fn().mockResolvedValue(result),
    archiveSource: jest.fn().mockResolvedValue(result),
    restoreSource: jest.fn().mockResolvedValue(result),
    pauseFeed: jest.fn().mockResolvedValue(result),
    resumeFeed: jest.fn().mockResolvedValue(result),
    setFeedInterval: jest.fn().mockResolvedValue(result),
    listDiscoveries: jest.fn().mockResolvedValue(result),
    listFeedCaptures: jest.fn().mockResolvedValue(result),
    listOrganizationDiscoveries: jest.fn().mockResolvedValue(result),
    listPageChanges: jest.fn().mockResolvedValue(result),
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
    {} as ContentStudioDesignReferenceService,
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignStylePresetService,
    {} as ContentStudioDesignLayoutPatternService,
    {} as ContentStudioDesignPageSetService,
    {} as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService,
    {} as ContentStudioAISetupService,
    {} as ContentStudioActivationService
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
  it('SRC1-SRC8/CR1 declares exactly these fifteen routes, with 200 for archive, restore, pause, resume, refresh and interval', () => {
    expect(
      allRoutes()
        .filter((r) => / \/sources/.test(r))
        .sort()
    ).toEqual([
      'GET /sources',
      'GET /sources/:id',
      // a feed's capture history (P8-O1), read only
      'GET /sources/:id/captures',
      // the pages a feed found (P8-01), read only
      'GET /sources/:id/discoveries',
      'GET /sources/:id/versions',
      'GET /sources/:id/versions/:versionId',
      // what changed in a version (P8-04A), read only
      'GET /sources/:id/versions/:versionId/changes',
      'PATCH /sources/:id',
      'POST /sources',
      'POST /sources/:id/archive',
      // a feed's interval (P8-C4)
      'POST /sources/:id/interval',
      // a feed's scheduled captures (P8-C3)
      'POST /sources/:id/pause',
      'POST /sources/:id/refresh',
      'POST /sources/:id/restore',
      'POST /sources/:id/resume',
    ]);
    for (const name of [
      'archiveSource',
      'restoreSource',
      'pauseSource',
      'resumeSource',
      'refreshSource',
      'setSourceInterval',
    ]) {
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

  it('K1/K5 lists one kind only when asked, still for the request organization', async () => {
    const { sources, controller } = setup();
    await controller.listSources(
      ORG,
      Object.assign(new ListContentStudioSourcesDto(), {
        page: 1,
        archived: false,
        kind: 'feed',
        organizationId: 'org-b',
      })
    );
    expect(sources.listSources).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: false,
      kind: 'feed',
      page: 1,
    });
    // without a kind: exactly the previous call, every kind
    await controller.listSources(
      ORG,
      Object.assign(new ListContentStudioSourcesDto(), {
        page: 1,
        archived: false,
      })
    );
    expect(sources.listSources.mock.calls[1][0]).toEqual({
      organizationId: 'org-a',
      archived: false,
      kind: undefined,
      page: 1,
    });
  });

  it('S9/P803 passes the search as sent, still for the request organization; the service trims it', async () => {
    const { sources, controller } = setup();
    await controller.listSources(
      ORG,
      Object.assign(new ListContentStudioSourcesDto(), {
        page: 3,
        archived: false,
        kind: 'url',
        search: '  Weekly ',
        organizationId: 'org-b',
      })
    );
    expect(sources.listSources.mock.calls[0][0]).toStrictEqual({
      organizationId: 'org-a',
      archived: false,
      kind: 'url',
      search: '  Weekly ',
      page: 3,
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

  it('TEN1/TEN2/M17 P8-01 lists the pages a feed found for the request organization, the path id and page only', async () => {
    const { sources, ingestion, controller, result } = setup();
    const query = withExtras(
      Object.assign(new ListContentStudioSourceDiscoveriesDto(), { page: 2 })
    );
    await expect(
      controller.listSourceDiscoveries(ORG, ID, query)
    ).resolves.toBe(result);
    expect(sources.listDiscoveries).toHaveBeenCalledWith({
      organizationId: 'org-a',
      sourceId: ID,
      page: 2,
    });
    expect(ingestion.refreshSource).not.toHaveBeenCalled();
    // a feed is captured through the one refresh route, like a page
    await controller.refreshSource(ORG, USER, ID);
    expect(ingestion.refreshSource).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      sourceId: ID,
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
    expect(types('listSourceDiscoveries')[2]).toBe(
      ListContentStudioSourceDiscoveriesDto
    );
    expect(types('listSourceCaptures')[2]).toBe(
      ListContentStudioFeedCapturesDto
    );
    expect(types('listDiscoveries')[1]).toBe(ListContentStudioDiscoveriesDto);
    expect(types('listSourceChanges')[1]).toBe(
      ListContentStudioSourceChangesDto
    );
    expect(types('setSourceInterval')[2]).toBe(SetContentStudioFeedIntervalDto);
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
    // the fifteen source routes, News Radar (P8-02) and Changes (P8-04B1)
    expect(block.match(/@(Get|Post|Patch|Put|Delete)\(/g)).toHaveLength(17);
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
      // P8-02: one known kind, exactly
      { kind: 'rss' },
      { kind: 'URL' },
      { kind: '' },
      { kind: 'constructor' },
    ]) {
      await rejected(ListContentStudioSourcesDto, query, 'query');
    }
    for (const kind of ['url', 'feed']) {
      expect({
        ...(await run(ListContentStudioSourcesDto, { kind }, 'query')),
      }).toEqual({ page: 1, archived: false, kind });
    }
    // P8-03: plain text of at most 100 characters; the service trims it and
    // refuses control text
    expect({
      ...(await run(
        ListContentStudioSourcesDto,
        { search: 'x'.repeat(100), kind: 'url', page: '2' },
        'query'
      )),
    }).toEqual({
      page: 2,
      archived: false,
      kind: 'url',
      search: 'x'.repeat(100),
    });
    expect({
      ...(await run(ListContentStudioSourcesDto, { search: '%_\\' }, 'query')),
    }).toEqual({ page: 1, archived: false, search: '%_\\' });
    for (const query of [
      // S8: too long
      { search: 'x'.repeat(101) },
      // S9: not one string
      { search: ['a', 'b'] },
      { search: { contains: 'a' } },
      // S11: no other field
      { q: 'a' },
      { name: 'a' },
      { orderBy: 'name' },
      { mode: 'insensitive' },
      { origin: 'manual' },
      { discovered: 'true' },
      { captured: 'true' },
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
    // P8-01: the pages a feed found, one page of them and nothing else
    expect({
      ...(await run(ListContentStudioSourceDiscoveriesDto, {}, 'query')),
    }).toEqual({ page: 1 });
    expect({
      ...(await run(
        ListContentStudioSourceDiscoveriesDto,
        { page: '7' },
        'query'
      )),
    }).toEqual({ page: 7 });
    for (const query of [
      { page: '0' },
      { page: '100001' },
      { page: 'x' },
      { organizationId: 'org-b' },
      { feedSourceId: ID },
      { kind: 'feed' },
      { sort: 'score' },
    ]) {
      await rejected(ListContentStudioSourceDiscoveriesDto, query, 'query');
    }
    // P8-O1: a feed's capture history, one page of it and nothing else: no
    // size, filter, order, organization or time
    expect({
      ...(await run(ListContentStudioFeedCapturesDto, {}, 'query')),
    }).toEqual({ page: 1 });
    expect({
      ...(await run(ListContentStudioFeedCapturesDto, { page: '3' }, 'query')),
    }).toEqual({ page: 3 });
    for (const query of [
      { page: '0' },
      { page: '-1' },
      { page: '1.5' },
      { page: '100001' },
      { page: 'x' },
      { limit: '1000' },
      { take: '1000' },
      { status: 'success' },
      { trigger: 'manual' },
      { organizationId: 'org-b' },
      { sourceId: ID },
      { since: '2026-01-01' },
      { order: 'asc' },
    ]) {
      await rejected(ListContentStudioFeedCapturesDto, query, 'query');
    }
  });
});

describe('ContentStudioController feed capture history (P8-O1)', () => {
  it('P8O1-R1 is GET /sources/:id/captures, the 149th route, read only with the default 200', () => {
    expect(route('listSourceCaptures')).toBe('GET /sources/:id/captures');
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('listSourceCaptures'))
    ).toBeUndefined();
    // activation flow 01: one more, reading a setup draft back
    // activation flow 01: two more, the first post and starting it
    expect(allRoutes()).toHaveLength(153);
    // one history route: no other capture route, none for the organization
    expect(allRoutes().filter((r) => /captur|attempt|histor/i.test(r))).toEqual(
      ['GET /sources/:id/captures']
    );
  });

  it('P8O1-R2 reads for the request organization with the path id and the page only, for any member', async () => {
    const { sources, controller } = setup();
    await expect(
      controller.listSourceCaptures(ORG, ID, { page: 2 })
    ).resolves.toEqual({ from: 'service' });
    expect(sources.listFeedCaptures).toHaveBeenCalledWith({
      organizationId: 'org-a',
      sourceId: ID,
      page: 2,
    });
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
      // a feed's interval only (P8-C4)
      'POST /sources/:id/interval',
      // a feed's schedule only (P8-C3)
      'POST /sources/:id/pause',
      'POST /sources/:id/refresh',
      'POST /sources/:id/restore',
      'POST /sources/:id/resume',
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
      // a preset of minutes or null only (P8-C4)
      'export class SetContentStudioFeedIntervalDto',
      'export class ListContentStudioSourceVersionsDto',
      'export class ListContentStudioSourceDiscoveriesDto',
      // a page number only (P8-O1)
      'export class ListContentStudioFeedCapturesDto',
      'export class ListContentStudioDiscoveriesDto',
      'export class ListContentStudioSourceChangesDto',
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

// News Radar (P8-02): what the organization's live feeds found
// What changed in one version (P8-04A): the path ids and the request
// organization only. The server chooses what the version is compared with
describe('ContentStudioController source version changes', () => {
  const ARGS = () =>
    Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      ContentStudioController,
      'getSourceVersionChanges'
    ) as Record<string, { index: number; data?: string }>;

  it('R1 is GET /sources/:id/versions/:versionId/changes, with the default 200', () => {
    expect(route('getSourceVersionChanges')).toBe(
      'GET /sources/:id/versions/:versionId/changes'
    );
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handler('getSourceVersionChanges')
      )
    ).toBeUndefined();
  });

  it('R2/R3 compares for the request organization, with the path ids only', async () => {
    const { sources, ingestion, controller, result } = setup();
    expect(await controller.getSourceVersionChanges(ORG, ID, VERSION)).toBe(
      result
    );
    expect(sources.getVersionChanges).toHaveBeenCalledTimes(1);
    expect(sources.getVersionChanges).toHaveBeenCalledWith({
      organizationId: 'org-a',
      sourceId: ID,
      versionId: VERSION,
    });
    // read only: no capture
    expect(ingestion.refreshSource).not.toHaveBeenCalled();
  });

  it('R4/P804A-11 takes no body, query, header or request: no baseline, hash or content can be sent', () => {
    const args = ARGS();
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
    expect(
      keys
        .filter((key) => key.startsWith(`${RouteParamtypes.PARAM}:`))
        .map((key) => args[key].data)
        .sort()
    ).toEqual(['id', 'versionId']);
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Get('/sources/:id/versions/:versionId/changes')"),
      text.indexOf("@Get('/sources/:id/discoveries')")
    );
    expect(block).toContain('getVersionChanges({');
    expect(block).not.toMatch(
      /@Body|@Query|@Headers|@Req|Dto|before|baseline|hash|\bcontent\b|refresh|ingest|\bAI/
    );
  });

  it('R5 is the 144th route (145 with P8-04B1, 147 with P8-C3, 148 with P8-C4, 149 with P8-O1)', () => {
    // activation flow 01: one more, reading a setup draft back
    // activation flow 01: two more, the first post and starting it
    expect(allRoutes()).toHaveLength(153);
  });
});

// Organization Changes (P8-04B1): the request organization, a page and a
// window only. Nothing is fetched or captured
describe('ContentStudioController organization page changes', () => {
  it('OC1 is GET /source-changes, the 145th route (147 with P8-C3, 148 with P8-C4, 149 with P8-O1), with the default 200', () => {
    expect(route('listSourceChanges')).toBe('GET /source-changes');
    expect(
      allRoutes()
        // a review's request-changes is no source route
        .filter((r) => /source/.test(r) && /changes/.test(r))
        .sort()
    ).toEqual([
      'GET /source-changes',
      'GET /sources/:id/versions/:versionId/changes',
    ]);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('listSourceChanges'))
    ).toBeUndefined();
    // activation flow 01: one more, reading a setup draft back
    // activation flow 01: two more, the first post and starting it
    expect(allRoutes()).toHaveLength(153);
  });

  it('OC2 reads for the request organization with the page and window only', async () => {
    const { sources, ingestion, controller, result } = setup();
    const query = Object.assign(new ListContentStudioSourceChangesDto(), {
      page: 2,
      since: '30d',
      organizationId: 'org-b',
      kind: 'feed',
      orderBy: 'updatedAt',
    });
    await expect(controller.listSourceChanges(ORG, query)).resolves.toBe(
      result
    );
    expect(sources.listPageChanges).toHaveBeenCalledTimes(1);
    expect(sources.listPageChanges).toHaveBeenCalledWith({
      organizationId: 'org-a',
      page: 2,
      since: '30d',
    });
    expect(ingestion.refreshSource).not.toHaveBeenCalled();
    const text = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.controller.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    const start = text.indexOf("@Get('/source-changes')");
    const block = text.slice(start, text.indexOf('\n  }\n', start));
    expect(block).toContain('_contentStudioSourceService.listPageChanges');
    expect(block).not.toMatch(
      /@Body|@Param|@Headers|@Req|Ingestion|refresh|capture|fetch|backfill|AIConnection|AIExecution|Role\.|users/i
    );
  });

  it('OC3 parses a page and a named window exactly, and nothing else', async () => {
    expect({
      ...(await run(ListContentStudioSourceChangesDto, {}, 'query')),
    }).toEqual({ page: 1 });
    expect({
      ...(await run(
        ListContentStudioSourceChangesDto,
        { page: '3', since: 'all' },
        'query'
      )),
    }).toEqual({ page: 3, since: 'all' });
    for (const since of ['24h', '7d', '30d', 'all']) {
      expect(
        (await run(ListContentStudioSourceChangesDto, { since }, 'query')).since
      ).toBe(since);
    }
    for (const query of [
      { page: '0' },
      { page: '100001' },
      { page: '1.5' },
      { page: 'abc' },
      { since: '1h' },
      { since: '7D' },
      { since: '' },
      { since: '2026-10-01T00:00:00.000Z' },
      // P8-04B1 has no other filter
      { search: 'x' },
      { feedSourceId: ID },
      { kind: 'url' },
      { change: 'title_changed' },
      { archived: 'true' },
      { origin: 'feed' },
      { organizationId: 'org-b' },
      { orderBy: 'updatedAt' },
    ]) {
      await rejected(ListContentStudioSourceChangesDto, query, 'query');
    }
  });
});

describe('ContentStudioController News Radar', () => {
  const FEED = '44444444-4444-4444-8444-444444444444';

  it('is GET /discoveries, read only, for the request organization with the declared filters only', async () => {
    expect(route('listDiscoveries')).toBe('GET /discoveries');
    expect(allRoutes().filter((r) => / \/discoveries/.test(r))).toEqual([
      'GET /discoveries',
    ]);
    const { sources, ingestion, controller, result } = setup();
    const query = Object.assign(new ListContentStudioDiscoveriesDto(), {
      page: 3,
      since: '30d',
      feedSourceId: FEED,
      captureState: 'not-captured',
      organizationId: 'org-b',
      sort: 'publishedAt',
    });
    await expect(controller.listDiscoveries(ORG, query)).resolves.toBe(result);
    expect(sources.listOrganizationDiscoveries).toHaveBeenCalledWith({
      organizationId: 'org-a',
      page: 3,
      since: '30d',
      feedSourceId: FEED,
      captureState: 'not-captured',
    });
    expect(ingestion.refreshSource).not.toHaveBeenCalled();
    const text = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.controller.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    const start = text.indexOf("@Get('/discoveries')");
    const block = text.slice(start, text.indexOf('\n  }\n', start));
    expect(block).toContain(
      '_contentStudioSourceService.listOrganizationDiscoveries'
    );
    expect(block).not.toMatch(
      /Ingestion|refresh|captureFeed|captureUrl|capture\(|fetch|AIConnection|AIExecution|Package|Role\.|users/i
    );
  });

  it('parses the Radar query exactly: a named window, a feed id, a capture state and a page', async () => {
    expect({
      ...(await run(ListContentStudioDiscoveriesDto, {}, 'query')),
    }).toEqual({ page: 1 });
    expect({
      ...(await run(
        ListContentStudioDiscoveriesDto,
        {
          page: '2',
          since: 'all',
          feedSourceId: FEED,
          captureState: 'captured',
        },
        'query'
      )),
    }).toEqual({
      page: 2,
      since: 'all',
      feedSourceId: FEED,
      captureState: 'captured',
    });
    for (const since of ['24h', '7d', '30d', 'all']) {
      expect(
        (await run(ListContentStudioDiscoveriesDto, { since }, 'query')).since
      ).toBe(since);
    }
    for (const query of [
      { page: '0' },
      { page: '100001' },
      { page: '1.5' },
      { since: '1h' },
      { since: '7D' },
      { since: '2026-10-01T00:00:00.000Z' },
      { since: '' },
      { feedSourceId: 'not-a-uuid' },
      { feedSourceId: '' },
      { captureState: 'failed' },
      { captureState: 'all' },
      { captureState: 'Captured' },
      { organizationId: 'org-b' },
      { kind: 'feed' },
      { orderBy: 'publishedAt' },
      { sort: 'score' },
      { where: '{}' },
      { search: 'x' },
      { archived: 'true' },
    ]) {
      await rejected(ListContentStudioDiscoveriesDto, query, 'query');
    }
  });
});

// A feed's scheduled captures (P8-C3): the request organization and the path
// id only. Nothing is fetched or captured
describe('ContentStudioController feed pause', () => {
  const ARGS = (name: string) =>
    Reflect.getMetadata(ROUTE_ARGS_METADATA, ContentStudioController, name) as
      | Record<string, { index: number; data?: string }>
      | undefined;

  it('P8C3-11 is POST /sources/:id/pause and /resume, 200, the 146th and 147th routes', () => {
    expect(route('pauseSource')).toBe('POST /sources/:id/pause');
    expect(route('resumeSource')).toBe('POST /sources/:id/resume');
    for (const name of ['pauseSource', 'resumeSource']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    // P8-C4: one more, a feed's interval; P8-O1: its capture history
    // activation flow 01: one more, reading a setup draft back
    // activation flow 01: two more, the first post and starting it
    expect(allRoutes()).toHaveLength(153);
    expect(
      allRoutes().filter((r) => /pause|resume|schedul|interval/i.test(r))
    ).toEqual([
      'POST /sources/:id/pause',
      'POST /sources/:id/resume',
      'POST /sources/:id/interval',
    ]);
  });

  it('P8C3-11 pauses and resumes for the request organization with the path id only', async () => {
    const { sources, ingestion, controller, result } = setup();
    await expect(controller.pauseSource(ORG, ID)).resolves.toBe(result);
    expect(sources.pauseFeed).toHaveBeenCalledWith('org-a', ID);
    await expect(controller.resumeSource(ORG, ID)).resolves.toBe(result);
    expect(sources.resumeFeed).toHaveBeenCalledWith('org-a', ID);
    // M14 neither captures
    expect(ingestion.refreshSource).not.toHaveBeenCalled();
    expect(sources.archiveSource).not.toHaveBeenCalled();
    expect(sources.restoreSource).not.toHaveBeenCalled();
  });

  it('P8C3-11 takes no body, query, header, request or user: no organization or time can be sent', () => {
    for (const name of ['pauseSource', 'resumeSource']) {
      const args = ARGS(name)!;
      const keys = Object.keys(args);
      expect(keys).toHaveLength(2);
      expect(
        keys.filter((key) => key.startsWith(`${RouteParamtypes.PARAM}:`))
      ).toHaveLength(1);
      expect(
        keys.filter(
          (key) =>
            key.startsWith(`${RouteParamtypes.BODY}:`) ||
            key.startsWith(`${RouteParamtypes.QUERY}:`) ||
            key.startsWith(`${RouteParamtypes.HEADERS}:`) ||
            key.startsWith(`${RouteParamtypes.REQUEST}:`)
        )
      ).toEqual([]);
      expect(
        keys
          .filter((key) => key.startsWith(`${RouteParamtypes.PARAM}:`))
          .map((key) => args[key].data)
      ).toEqual(['id']);
    }
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Post('/sources/:id/pause')"),
      text.indexOf("@Post('/sources/:id/refresh')")
    );
    expect(block).toContain('pauseFeed(org.id, id)');
    expect(block).toContain('resumeFeed(org.id, id)');
    expect(block).not.toMatch(
      /@Body|@Query|@Headers|@Req|Dto|refresh|ingest|capture\(|organizationId/
    );
  });
});

describe('ContentStudioController feed interval (P8-C4)', () => {
  const ARGS = (name: string) =>
    Reflect.getMetadata(ROUTE_ARGS_METADATA, ContentStudioController, name) as
      | Record<string, { index: number; data?: string }>
      | undefined;

  it('P8C4-17 is POST /sources/:id/interval, 200, the 148th route (149 with P8-O1)', () => {
    expect(route('setSourceInterval')).toBe('POST /sources/:id/interval');
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('setSourceInterval'))
    ).toBe(200);
    // activation flow 01: one more, reading a setup draft back
    // activation flow 01: two more, the first post and starting it
    expect(allRoutes()).toHaveLength(153);
  });

  it('sets the interval for the request organization with the path id and the value only, for any member', async () => {
    const { sources, ingestion, controller, result } = setup();
    for (const intervalMinutes of [180, null]) {
      const body = Object.assign(new SetContentStudioFeedIntervalDto(), {
        intervalMinutes,
      });
      await expect(
        controller.setSourceInterval(ORG, ID, withExtras(body))
      ).resolves.toBe(result);
    }
    expect(sources.setFeedInterval.mock.calls).toEqual([
      ['org-a', ID, 180],
      ['org-a', ID, null],
    ]);
    // nothing is captured, paused or archived here
    expect(ingestion.refreshSource).not.toHaveBeenCalled();
    expect(sources.pauseFeed).not.toHaveBeenCalled();
    expect(sources.archiveSource).not.toHaveBeenCalled();
  });

  it('takes the organization from the request, the id from the path and the body DTO only: no user, query or header', () => {
    const args = ARGS('setSourceInterval')!;
    const keys = Object.keys(args);
    expect(keys).toHaveLength(3);
    expect(
      keys
        .filter((key) => key.startsWith(`${RouteParamtypes.PARAM}:`))
        .map((key) => args[key].data)
    ).toEqual(['id']);
    expect(
      keys.filter((key) => key.startsWith(`${RouteParamtypes.BODY}:`))
    ).toHaveLength(1);
    expect(
      keys.filter(
        (key) =>
          key.startsWith(`${RouteParamtypes.QUERY}:`) ||
          key.startsWith(`${RouteParamtypes.HEADERS}:`) ||
          key.startsWith(`${RouteParamtypes.REQUEST}:`)
      )
    ).toEqual([]);
    const text = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.controller.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    const start = text.indexOf("@Post('/sources/:id/interval')");
    const block = text.slice(start, text.indexOf('\n  }\n', start));
    expect(block).toContain(
      'this._contentStudioSourceService.setFeedInterval(\n      org.id,\n      id,\n      body.intervalMinutes\n    );'
    );
    expect(block).not.toMatch(
      /GetUserFromRequest|@Query|@Req|Role|Polic|ingestion|refresh|organizationId|nextCaptureAt|Failures/
    );
  });

  it.each([null, 60, 180, 360, 720, 1440])(
    'DTO accepts %p as sent',
    async (intervalMinutes) => {
      const body = await run(SetContentStudioFeedIntervalDto, {
        intervalMinutes,
      });
      expect(body).toBeInstanceOf(SetContentStudioFeedIntervalDto);
      expect({ ...body }).toEqual({ intervalMinutes });
    }
  );

  it.each([
    ['missing', {}],
    ['a string', { intervalMinutes: '60' }],
    ['0', { intervalMinutes: 0 }],
    ['-1', { intervalMinutes: -1 }],
    ['59', { intervalMinutes: 59 }],
    ['61', { intervalMinutes: 61 }],
    ['60.5', { intervalMinutes: 60.5 }],
    ['1000000', { intervalMinutes: 1_000_000 }],
    ['a list', { intervalMinutes: [60] }],
    ['true', { intervalMinutes: true }],
  ])('M30 DTO refuses %s', async (_name, body) => {
    await rejected(SetContentStudioFeedIntervalDto, body);
  });

  it.each([
    'organizationId',
    'nextCaptureAt',
    'consecutiveCaptureFailures',
    'captureIntervalMinutes',
    'code',
    'scanPausedAt',
  ])('DTO refuses a body with %s', async (field) => {
    const message = await rejected(SetContentStudioFeedIntervalDto, {
      intervalMinutes: 60,
      [field]: field === 'organizationId' ? 'org-b' : 1,
    });
    expect(message).toContain(`property ${field} should not exist`);
  });
});
