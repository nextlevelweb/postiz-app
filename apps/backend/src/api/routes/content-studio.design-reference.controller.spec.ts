import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import fs from 'fs';
import path from 'path';
import { Organization } from '@prisma/client';
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

const DESIGN_REF_ROUTES = [
  'getMediaDesignReference',
  'getBrandKitDesignReference',
];
const REVISION = '66666666-6666-4666-8666-666666666666';
const org = (role: string) =>
  ({
    id: 'org-a',
    users: [{ disabled: false, role, userId: 'user-1' }],
  } as unknown as Organization);

const setup = () => {
  const result = { from: 'service' };
  const references = {
    getMediaReference: jest.fn().mockResolvedValue(result),
    getBrandKitReference: jest.fn().mockResolvedValue(result),
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
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    references as unknown as ContentStudioDesignReferenceService
  );
  return { controller, references, result };
};

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;
const block = (name: string) => {
  const text = fs.readFileSync(
    path.join(__dirname, 'content-studio.controller.ts'),
    'utf8'
  );
  const start = text.lastIndexOf('@Get(', text.indexOf(`  ${name}(`));
  return text.slice(start, text.indexOf('\n  }\n', start));
};

describe('ContentStudioController design reference routes (P4-08)', () => {
  it('P408-7 declares exactly two read-only GET routes, default status, no interceptor', () => {
    expect(DESIGN_REF_ROUTES.map(route)).toEqual([
      'GET /media/:id/design-ref',
      'GET /brand-kit/revisions/:revisionId/design-ref',
    ]);
    const all = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(all.filter((r) => r.endsWith('/design-ref')).sort()).toEqual([
      'GET /brand-kit/revisions/:revisionId/design-ref',
      'GET /media/:id/design-ref',
    ]);
    for (const name of DESIGN_REF_ROUTES) {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(INTERCEPTORS_METADATA, handler(name))
      ).toBeUndefined();
    }
  });

  it('MDR9/MDR12/BDR5 any member asks with the request organization and the path id only', async () => {
    for (const role of ['USER', 'ADMIN', 'SUPERADMIN']) {
      const { controller, references, result } = setup();
      await expect(
        controller.getMediaDesignReference(org(role), 'photo-1')
      ).resolves.toBe(result);
      expect(references.getMediaReference).toHaveBeenCalledWith(
        'org-a',
        'photo-1'
      );
      await expect(
        controller.getBrandKitDesignReference(org(role), REVISION)
      ).resolves.toBe(result);
      expect(references.getBrandKitReference).toHaveBeenCalledWith(
        'org-a',
        REVISION
      );
    }
    for (const name of DESIGN_REF_ROUTES) {
      const code = block(name);
      expect(code).not.toMatch(
        /@Body|@Query|@Req|@Res|@GetUserFromRequest|CheckPolicies|Role\./
      );
      expect(code.match(/@Param\('/g)).toHaveLength(1);
    }
  });
});
