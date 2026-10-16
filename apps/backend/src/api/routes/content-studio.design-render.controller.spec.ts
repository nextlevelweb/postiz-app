import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
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
import {
  ContentStudioRenderFontService,
  RENDER_FONT_FILE_MAX_BYTES,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import {
  RenderAllContentStudioDesignDto,
  RenderContentStudioDesignDto,
  UploadContentStudioRenderFontDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-render.dto';

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

const MARKER = 'DESIGN_RENDER_ROUTE_PRIVATE_MARKER_852';
const DESIGN = '33333333-3333-4333-8333-333333333333';
const REVISION = '66666666-6666-4666-8666-666666666666';
const MAPPING = '77777777-7777-4777-8777-777777777777';
const org = (role: string) =>
  ({
    id: 'org-a',
    users: [{ disabled: false, role, userId: 'user-1' }],
  } as unknown as Organization);
const USER = { id: 'user-1' } as User;

const setup = () => {
  const result = { from: 'service' };
  const fonts = {
    listFonts: jest.fn().mockResolvedValue(result),
    uploadFont: jest.fn().mockResolvedValue(result),
    disableFont: jest.fn().mockResolvedValue(result),
    enableFont: jest.fn().mockResolvedValue(result),
  };
  const renders = {
    renderPage: jest.fn().mockResolvedValue(result),
    renderAllPages: jest.fn().mockResolvedValue(result),
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
    {} as ContentStudioSourceService,
    {} as ContentStudioSourceIngestionService,
    {} as ContentStudioBrandKitService,
    {} as ContentStudioDesignService,
    fonts as unknown as ContentStudioRenderFontService,
    renders as unknown as ContentStudioDesignRenderService
  );
  return { controller, fonts, renders, result };
};

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;
const allRoutes = () =>
  Object.getOwnPropertyNames(ContentStudioController.prototype)
    .filter((name) => name !== 'constructor')
    .map(route);

const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    userId: 'user-b',
    storageKey: 'fonts/x',
    sha256: 'f'.repeat(64),
  });

describe('ContentStudioController design render and render font routes', () => {
  // the five P4-05 routes and the P4-06 render-all route
  it('declares exactly the five P4-05 routes and the P4-06 render-all route', () => {
    expect(
      [
        'renderDesign',
        'listRenderFonts',
        'uploadRenderFont',
        'disableRenderFont',
        'enableRenderFont',
        'renderAllDesignPages',
      ].map(route)
    ).toEqual([
      'POST /designs/:id/render',
      'GET /render-fonts',
      'POST /render-fonts/upload',
      'POST /render-fonts/:id/disable',
      'POST /render-fonts/:id/enable',
      'POST /designs/:id/render-all',
    ]);
    expect(
      allRoutes()
        .filter((r) => /render/.test(r))
        .sort()
    ).toEqual([
      'GET /render-fonts',
      'POST /designs/:id/render',
      'POST /designs/:id/render-all',
      'POST /render-fonts/:id/disable',
      'POST /render-fonts/:id/enable',
      'POST /render-fonts/upload',
    ]);
    for (const name of [
      'renderDesign',
      'renderAllDesignPages',
      'disableRenderFont',
      'enableRenderFont',
    ]) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
  });

  it('M33 has no preview, export, batch, replay, carousel, font download, delete or Media read route', () => {
    expect(
      allRoutes().filter((r) =>
        /preview|export|batch|replay|carousel|thumbnail|download|renders|\/media|font.*\/(file|bytes)|^DELETE /i.test(
          r
        )
      )
    ).toEqual([]);
    expect(
      allRoutes().filter((r) => r.startsWith('GET /render-fonts'))
    ).toEqual(['GET /render-fonts']);
  });

  it('C-R1/RENDER-AUTH1-3 renders for any member, with the request organization, user and the declared fields only', async () => {
    for (const role of ['USER', 'ADMIN', 'SUPERADMIN']) {
      const { controller, renders, result } = setup();
      const body = withExtras(new RenderContentStudioDesignDto());
      body.revisionId = REVISION;
      body.pageId = 'cover';
      await expect(
        controller.renderDesign(org(role), USER, DESIGN, body)
      ).resolves.toBe(result);
      expect(renders.renderPage).toHaveBeenCalledWith({
        organizationId: 'org-a',
        userId: 'user-1',
        designId: DESIGN,
        revisionId: REVISION,
        pageId: 'cover',
      });
    }
  });

  it('C-F1/RF-AUTH1 lists for the request organization', async () => {
    const { controller, fonts } = setup();
    await controller.listRenderFonts(org('USER'));
    expect(fonts.listFonts).toHaveBeenCalledWith('org-a');
  });

  it('C-F2/C-F3/C-F4/RF-AUTH5/RF-AUTH6 hands upload, disable and enable to the service with the request membership', async () => {
    const { controller, fonts } = setup();
    const body = withExtras(new UploadContentStudioRenderFontDto());
    body.family = 'Inter';
    body.weight = 400;
    body.style = 'normal';
    const file = {
      buffer: Buffer.from('x'),
      originalname: MARKER,
    } as Express.Multer.File;
    await controller.uploadRenderFont(org('ADMIN'), USER, file, body);
    expect(fonts.uploadFont).toHaveBeenCalledWith(
      { organization: org('ADMIN'), user: USER },
      { family: 'Inter', weight: 400, style: 'normal', file }
    );
    await controller.disableRenderFont(org('SUPERADMIN'), USER, MAPPING);
    expect(fonts.disableFont).toHaveBeenCalledWith(
      { organization: org('SUPERADMIN'), user: USER },
      MAPPING
    );
    await controller.enableRenderFont(org('USER'), USER, MAPPING);
    expect(fonts.enableFont).toHaveBeenCalledWith(
      { organization: org('USER'), user: USER },
      MAPPING
    );
  });

  it('takes the font file in memory through its own interceptor: one part, the renderer limit, never the Media upload engine', () => {
    const interceptors = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      handler('uploadRenderFont')
    );
    expect(interceptors).toHaveLength(1);
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).toContain(
      "@UseInterceptors(FileInterceptor('file', renderFontUploadOptions))"
    );
    expect(text).toMatch(
      /const renderFontUploadOptions = \{\n\s+limits: \{\n\s+fileSize: RENDER_FONT_FILE_MAX_BYTES \+ 1,\n\s+files: 1,\n\s+fields: 3,\n\s+parts: 4,\n\s+\},\n\};/
    );
    expect(RENDER_FONT_FILE_MAX_BYTES).toBe(33_554_432);
    expect(text).not.toMatch(
      /streamUploadOptions|diskStorage|dest:|UploadFactory|MediaService/
    );
  });

  it('M32/RENDER-AUTH adds no role, policy, billing or credit gate to these routes', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(/CheckPolicies|Sections\.|Role\./);
    // code only, not the comments
    const render = fs
      .readFileSync(
        path.join(
          __dirname,
          '../../../../../libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-render.service.ts'
        ),
        'utf8'
      )
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(render).not.toMatch(
      /assertManager|Role\.|users\b|credit|billing|Subscription/i
    );
  });
});

// Runs a request value through the pipes Nest would use: the global
// ValidationPipe from main.ts first, then the pipe declared on the controller
const controllerPipes = (): PipeTransform[] =>
  Reflect.getMetadata(PIPES_METADATA, ContentStudioController);
const globalPipe = new ValidationPipe({ transform: true });
const run = async (metatype: ArgumentMetadata['metatype'], value: unknown) => {
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype,
    data: undefined,
  };
  let current = await globalPipe.transform(value, metadata);
  for (const pipe of controllerPipes()) {
    current = await pipe.transform(current, metadata);
  }
  return current;
};
const rejected = async (
  metatype: ArgumentMetadata['metatype'],
  value: unknown
) => {
  const error = await run(metatype, value).then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(BadRequestException);
  expect(
    JSON.stringify((error as BadRequestException).getResponse())
  ).not.toContain(MARKER);
};

describe('Render DTO validation', () => {
  const valid = { revisionId: REVISION, pageId: 'cover' };

  it('RD1/RD3 accepts an exact revision id and a Design page id', async () => {
    const body = await run(RenderContentStudioDesignDto, valid);
    expect(body).toBeInstanceOf(RenderContentStudioDesignDto);
    expect({ ...body }).toEqual(valid);
    expect({
      ...(await run(RenderContentStudioDesignDto, {
        ...valid,
        pageId: 'P_1-x',
      })),
    }).toEqual({
      ...valid,
      pageId: 'P_1-x',
    });
  });

  it('RD2/RD4 refuses another revision id or page id, and a missing one (no latest revision)', async () => {
    for (const revisionId of [
      undefined,
      '',
      'latest',
      'current',
      'ABCDEF66-6666-4666-8666-666666666666',
      42,
      MARKER,
    ]) {
      await rejected(RenderContentStudioDesignDto, { ...valid, revisionId });
    }
    for (const pageId of [
      undefined,
      '',
      '1cover',
      'a'.repeat(33),
      'a b',
      '../x',
      MARKER.toLowerCase() + '!',
    ]) {
      await rejected(RenderContentStudioDesignDto, { ...valid, pageId });
    }
  });

  it('RD5-RD10/M34 refuses an organization, user, assets, bytes and every render option', async () => {
    for (const extra of [
      { organizationId: 'org-b' },
      { userId: 'user-b' },
      { format: 'jpeg' },
      { quality: 90 },
      { width: 100 },
      { height: 100 },
      { mediaId: 'photo' },
      { sha256: 'f'.repeat(64) },
      { bytes: 'AAEC' },
      { base64: 'AAEC' },
      { image: { mediaId: 'x' } },
      { font: { family: 'Inter' } },
      { fontAssetId: MAPPING },
      { designContent: {} },
      { brandKit: null },
      { renderOptions: {} },
      { url: 'https://evil.test/x.png' },
    ]) {
      await rejected(RenderContentStudioDesignDto, { ...valid, ...extra });
    }
  });
});

describe('Render font upload DTO validation', () => {
  const valid = { family: 'Inter', weight: '400', style: 'normal' };

  it('FD1/FD2/FD3 accepts a family, a form weight and a style, as numbers and text', async () => {
    const body = await run(UploadContentStudioRenderFontDto, valid);
    expect({ ...body }).toEqual({
      family: 'Inter',
      weight: 400,
      style: 'normal',
    });
    expect(
      (
        await run(UploadContentStudioRenderFontDto, {
          ...valid,
          weight: 900,
          style: 'italic',
        })
      ).weight
    ).toBe(900);
  });

  it('FD2/FD3 refuses another weight or style', async () => {
    for (const weight of ['450', '4OO', '', '1000', '400.0', 'bold']) {
      await rejected(UploadContentStudioRenderFontDto, { ...valid, weight });
    }
    for (const style of ['oblique', 'Italic', '']) {
      await rejected(UploadContentStudioRenderFontDto, { ...valid, style });
    }
    await rejected(UploadContentStudioRenderFontDto, {
      ...valid,
      family: 'x'.repeat(201),
    });
    await rejected(UploadContentStudioRenderFontDto, { ...valid, family: 42 });
  });

  it('FD4-FD10 refuses a client hash, Media, storage key, path, URL, organization or anything unknown', async () => {
    for (const extra of [
      { sha256: 'f'.repeat(64) },
      { SHA256: 'F'.repeat(64) },
      { mediaId: 'font-media' },
      { storageKey: 'fonts/x/y.ttf' },
      { path: '/srv/fonts/x.ttf' },
      { fontUrl: 'https://cdn.test/x.ttf' },
      { url: 'https://cdn.test/x.ttf' },
      { organizationId: 'org-b' },
      { userId: 'user-b' },
      { bytes: 'AAEAAA==' },
      { fileName: 'x.ttf' },
      { unknown: MARKER },
    ]) {
      await rejected(UploadContentStudioRenderFontDto, { ...valid, ...extra });
    }
  });
});

describe('ContentStudioController render-all (P4-06)', () => {
  it('118/RENDER-AUTH renders every page for any member with the request organization and user and the revision only', async () => {
    for (const role of ['USER', 'ADMIN', 'SUPERADMIN']) {
      const { controller, renders, result } = setup();
      const body = withExtras(new RenderAllContentStudioDesignDto());
      body.revisionId = REVISION;
      Object.assign(body, { pageIds: ['p9'], pages: [], format: 'zip' });
      await expect(
        controller.renderAllDesignPages(org(role), USER, DESIGN, body)
      ).resolves.toBe(result);
      expect(renders.renderAllPages).toHaveBeenCalledWith({
        organizationId: 'org-a',
        userId: 'user-1',
        designId: DESIGN,
        revisionId: REVISION,
      });
      expect(renders.renderPage).not.toHaveBeenCalled();
    }
  });

  it('156 answers 200 with the strict body DTO', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('renderAllDesignPages'))
    ).toBe(200);
    expect(
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        'renderAllDesignPages'
      )[3]
    ).toBe(RenderAllContentStudioDesignDto);
  });

  it('120 adds no export, preview, batch, carousel, pdf, zip, retry, resume or render read route', () => {
    expect(
      allRoutes().filter((r) =>
        /export|preview|batch|carousel|pdf|zip|retry|resume|renders\/|^GET .*render(?!-fonts)/i.test(
          r
        )
      )
    ).toEqual([]);
  });
});

describe('Render-all DTO validation', () => {
  it('accepts exactly a revision id', async () => {
    const body = await run(RenderAllContentStudioDesignDto, {
      revisionId: REVISION,
    });
    expect(body).toBeInstanceOf(RenderAllContentStudioDesignDto);
    expect({ ...body }).toEqual({ revisionId: REVISION });
  });

  it('refuses a missing or malformed revision id (no latest revision)', async () => {
    for (const revisionId of [
      undefined,
      '',
      'latest',
      'ABCDEF66-6666-4666-8666-666666666666',
      7,
    ]) {
      await rejected(RenderAllContentStudioDesignDto, { revisionId });
    }
  });

  it('M25/M26/21 refuses pages, order, options, assets and identities', async () => {
    for (const extra of [
      { organizationId: 'org-b' },
      { userId: 'user-b' },
      { pageIds: ['cover'] },
      { pages: [0, 1] },
      { pageId: 'cover' },
      { order: 'desc' },
      { format: 'pdf' },
      { quality: 90 },
      { width: 100 },
      { height: 100 },
      { concurrency: 4 },
      { retry: true },
      { assets: [] },
      { mediaIds: ['m1'] },
      { fonts: [] },
      { brandKit: null },
      { output: 'zip' },
    ]) {
      await rejected(RenderAllContentStudioDesignDto, {
        revisionId: REVISION,
        ...extra,
      });
    }
  });
});
