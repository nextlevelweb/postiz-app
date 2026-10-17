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
import { ContentStudioRenderFontService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import {
  ContentStudioAIItemProposalDto,
  ContentStudioAIThreadProposalDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-writing.dto';

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

const MARKER = 'INSTRUCTION_PRIVATE_MARKER_321';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const WRITING = 'a1111111-1111-4111-8111-111111111111';
const AUDIENCE = 'b1111111-1111-4111-8111-111111111111';
const EXPERTISE = 'c1111111-1111-4111-8111-111111111111';
const REVISION = 'a2222222-2222-4222-8222-222222222222';
const SOURCE_A = 'e1111111-1111-4111-8111-111111111111';
const SOURCE_B = 'e2111111-1111-4111-8111-111111111111';
const sourceIdN = (n: number) => `e${n}111111-1111-4111-8111-111111111111`;
// an ordinary member: AI writing needs no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const setup = () => {
  const result = { from: 'service' };
  const writing = {
    proposeItem: jest.fn().mockResolvedValue(result),
    proposeThread: jest.fn().mockResolvedValue(result),
  };
  const controller = new ContentStudioController(
    {} as ContentStudioService,
    {} as ContentStudioHandoffService,
    {} as ContentStudioAIConnectionService,
    {} as ContentStudioWritingProfileService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioAudienceProfileService,
    {} as ContentStudioExpertiseProfileService,
    writing as unknown as ContentStudioAIWritingService,
    {} as ContentStudioSourceService,
    {} as ContentStudioSourceIngestionService,
    {} as ContentStudioBrandKitService,
    {} as ContentStudioDesignService,
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    {} as ContentStudioDesignReferenceService,
    {} as ContentStudioDesignTemplateService
  );
  return { writing, controller, result };
};

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

const selection = {
  connectionId: CONNECTION,
  model: 'gpt-6.1-sol',
  baseDraftVersion: 7,
  writingProfileId: WRITING,
  editorialPolicy: true,
  audienceProfileId: AUDIENCE,
  expertiseProfileId: EXPERTISE,
  sourceIds: [SOURCE_B, SOURCE_A],
  instruction: `Bold ${MARKER}`,
};
const itemBody = () => ({
  operation: 'rewrite_item',
  itemId: 'main',
  ...selection,
});
const threadBody = () => ({ operation: 'generate_thread', ...selection });

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    userId: 'user-b',
    provider: 'openai',
    prompt: MARKER,
    system: MARKER,
    apiKey: 'sk-content-studio-test-secret-123',
    writingProfileRevisionId: REVISION,
  });

describe('ContentStudioController AI writing routes', () => {
  it('CT1/CT2/CT13 declares exactly the item and thread routes, both 200, and nothing generic', () => {
    expect(route('generateItemProposal')).toBe('POST /packages/:id/ai/item');
    expect(route('generateThreadProposal')).toBe(
      'POST /packages/:id/ai/thread'
    );
    for (const name of ['generateItemProposal', 'generateThreadProposal']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    const routes = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(routes.filter((r) => /\/ai\/(item|thread)$/.test(r)).sort()).toEqual(
      ['POST /packages/:id/ai/item', 'POST /packages/:id/ai/thread']
    );
    expect(
      routes.filter((r) =>
        /generate|execute|operation|usage|openai|anthropic|openrouter|\/ai\/(?!item$|thread$|providers$|connections)/.test(
          r
        )
      )
    ).toEqual([]);
  });

  it('CT3/CT4/CT5 proposes an item for the request organization, user and route package, with the declared fields only', async () => {
    const { writing, controller, result } = setup();
    const body = withExtras(
      Object.assign(new ContentStudioAIItemProposalDto(), itemBody())
    );
    await expect(
      controller.generateItemProposal(ORG, USER, PACKAGE, body)
    ).resolves.toBe(result);
    expect(writing.proposeItem).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      packageId: PACKAGE,
      operation: 'rewrite_item',
      itemId: 'main',
      selection,
    });
    expect(controller.generateItemProposal).toHaveLength(4);
  });

  it('CT2-CT5 proposes a thread the same way, without an item', async () => {
    const { writing, controller, result } = setup();
    const body = withExtras(
      Object.assign(new ContentStudioAIThreadProposalDto(), threadBody())
    );
    await expect(
      controller.generateThreadProposal(ORG, USER, PACKAGE, body)
    ).resolves.toBe(result);
    expect(writing.proposeThread).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      packageId: PACKAGE,
      operation: 'generate_thread',
      selection,
    });
  });

  it('CT11/CT12 declares the DTOs and adds no role, billing or AI subscription gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('generateItemProposal')[3]).toBe(
      ContentStudioAIItemProposalDto
    );
    expect(types('generateThreadProposal')[3]).toBe(
      ContentStudioAIThreadProposalDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const start = text.indexOf("@Post('/packages/:id/ai/item')");
    const block = text.slice(
      text.lastIndexOf('\n\n', start),
      text.indexOf("@Get('/packages/:id/revisions')")
    );
    expect(block).toContain('generateThreadProposal');
    expect(block).not.toMatch(
      /CheckPolicies|Sections\.|Role\.|ADMIN|assertManager|UseGuards|billing|subscription|credit/i
    );
    expect(text).not.toMatch(/CheckPolicies|@Delete\(/);
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
  value: unknown
) => {
  const error = await run(metatype, value).then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(BadRequestException);
  const message = JSON.stringify((error as BadRequestException).getResponse());
  expect(message).not.toContain(MARKER);
  expect(message).not.toContain('sk-content-studio');
  return message;
};

describe('AI writing DTO validation', () => {
  it('CT5 takes an item body with exactly the declared fields', async () => {
    const body = await run(ContentStudioAIItemProposalDto, itemBody());
    expect(body).toBeInstanceOf(ContentStudioAIItemProposalDto);
    expect({ ...body }).toEqual(itemBody());
    const thread = await run(ContentStudioAIThreadProposalDto, threadBody());
    expect({ ...thread }).toEqual(threadBody());
  });

  it('takes a minimal body: no profile, no policy, no instruction', async () => {
    const minimal = {
      operation: 'generate_item',
      itemId: 'f1',
      connectionId: CONNECTION,
      model: 'claude-opus-5-5',
      baseDraftVersion: 1,
    };
    expect({ ...(await run(ContentStudioAIItemProposalDto, minimal)) }).toEqual(
      minimal
    );
    const nulls = {
      ...minimal,
      writingProfileId: null,
      audienceProfileId: null,
      expertiseProfileId: null,
      instruction: null,
      editorialPolicy: false,
    };
    expect({ ...(await run(ContentStudioAIItemProposalDto, nulls)) }).toEqual(
      nulls
    );
  });

  it.each([
    ['generate_item'],
    ['rewrite_item'],
    ['shorten_item'],
    ['expand_item'],
    ['change_tone'],
  ])('takes the item operation %s', async (operation) => {
    await run(ContentStudioAIItemProposalDto, { ...itemBody(), operation });
  });

  it.each([
    ['CT6 organizationId', { organizationId: 'org-b' }],
    ['userId', { userId: 'user-b' }],
    ['CT7 provider', { provider: 'openai' }],
    ['CT8 prompt', { prompt: MARKER }],
    ['CT8 system', { system: MARKER }],
    ['CT9 apiKey', { apiKey: 'sk-content-studio-test-secret-123' }],
    [
      'CT9 credential',
      { credential: { apiKey: 'sk-content-studio-test-secret-123' } },
    ],
    ['CT10 profileRevisionId', { profileRevisionId: REVISION }],
    ['CT10 writingProfileRevisionId', { writingProfileRevisionId: REVISION }],
    ['CT10 policyRevisionId', { policyRevisionId: REVISION }],
    ['CT10 editorialPolicyRevisionId', { editorialPolicyRevisionId: REVISION }],
    ['editorialPolicyId', { editorialPolicyId: REVISION }],
    ['maxOutputTokens', { maxOutputTokens: 100000 }],
    ['temperature', { temperature: 2 }],
    ['context', { context: { v: 1 } }],
    ['operationId', { operationId: REVISION }],
  ])('refuses a body with %s', async (field, extra) => {
    for (const [dto, body] of [
      [ContentStudioAIItemProposalDto, itemBody()],
      [ContentStudioAIThreadProposalDto, threadBody()],
    ] as const) {
      const message = await rejected(dto, { ...body, ...extra });
      expect(message).toContain(
        `property ${field.replace(/^CT\d+ /, '')} should not exist`
      );
    }
  });

  it('refuses an item id on the thread route', async () => {
    expect(
      await rejected(ContentStudioAIThreadProposalDto, {
        ...threadBody(),
        itemId: 'main',
      })
    ).toContain('property itemId should not exist');
  });

  it.each([
    ['no operation', { operation: undefined }],
    ['the thread operation', { operation: 'generate_thread' }],
    ['an unknown operation', { operation: 'summarize' }],
    ['no item', { itemId: undefined }],
    ['a malformed item id', { itemId: 'a b' }],
    ['a long item id', { itemId: 'x'.repeat(33) }],
    ['no connection', { connectionId: undefined }],
    ['a malformed connection', { connectionId: 'connection-1' }],
    ['no model', { model: undefined }],
    ['a long model', { model: 'm'.repeat(129) }],
    ['a model that is not text', { model: 7 }],
    ['no draft version', { baseDraftVersion: undefined }],
    ['draft version 0', { baseDraftVersion: 0 }],
    ['a fractional draft version', { baseDraftVersion: 1.5 }],
    ['a draft version past int4', { baseDraftVersion: 2 ** 31 }],
    ['a text draft version', { baseDraftVersion: '7' }],
    ['a malformed writing profile', { writingProfileId: 'writing-1' }],
    ['a malformed audience profile', { audienceProfileId: 'audience-1' }],
    ['a malformed expertise profile', { expertiseProfileId: 7 }],
    ['a policy flag as text', { editorialPolicy: 'true' }],
    ['a policy id instead of a flag', { editorialPolicy: REVISION }],
    ['an instruction over 2000 characters', { instruction: 'i'.repeat(2001) }],
    ['an instruction that is not text', { instruction: { text: MARKER } }],
  ])('refuses an item body with %s', async (_name, change) => {
    await rejected(ContentStudioAIItemProposalDto, {
      ...itemBody(),
      ...change,
    });
  });

  it.each([
    ['an item operation', { operation: 'rewrite_item' }],
    ['no operation', { operation: undefined }],
    ['no connection', { connectionId: undefined }],
  ])('refuses a thread body with %s', async (_name, change) => {
    await rejected(ContentStudioAIThreadProposalDto, {
      ...threadBody(),
      ...change,
    });
  });

  it('takes an instruction of exactly 2000 characters', async () => {
    await run(ContentStudioAIItemProposalDto, {
      ...itemBody(),
      instruction: 'i'.repeat(2000),
    });
  });
});

describe('AI writing DTO validation: sources', () => {
  const both = [
    [ContentStudioAIItemProposalDto, itemBody],
    [ContentStudioAIThreadProposalDto, threadBody],
  ] as const;
  const withoutSources = (body: Record<string, unknown>) => {
    const { sourceIds: _sourceIds, ...rest } = body;
    return rest;
  };

  it('SD-AI1-SD-AI4 takes no sources, an empty list, one id or five ids, in the order given', async () => {
    for (const [dto, body] of both) {
      const none = withoutSources(body());
      expect({ ...(await run(dto, none)) }).toEqual(none);
      for (const sourceIds of [
        [],
        [SOURCE_A],
        [5, 3, 1, 4, 2].map(sourceIdN),
      ]) {
        const value = await run(dto, { ...body(), sourceIds });
        expect(value.sourceIds).toEqual(sourceIds);
      }
      expect(
        (await run(dto, { ...body(), sourceIds: null })).sourceIds
      ).toBeNull();
    }
  });

  it.each([
    ['SD-AI5 six ids', [1, 2, 3, 4, 5, 6].map(sourceIdN)],
    ['SD-AI6 the same id twice', [SOURCE_A, SOURCE_B, SOURCE_A]],
    ['SD-AI7 a malformed id', ['source-1']],
    ['SD-AI7 an id that is not text', [7]],
    ['SD-AI7 an object in the list', [{ id: SOURCE_A }]],
    ['SD-AI8 one id as text instead of a list', SOURCE_A],
    ['an object instead of a list', { 0: SOURCE_A }],
  ])('refuses %s', async (_name, sourceIds) => {
    for (const [dto, body] of both) {
      await rejected(dto, { ...body(), sourceIds });
    }
  });

  it.each([
    ['SD-AI9 sourceVersionIds', { sourceVersionIds: [REVISION] }],
    [
      'SD-AI10 sourceVersions',
      { sourceVersions: [{ sourceId: SOURCE_A, versionId: REVISION }] },
    ],
    ['SD-AI11 sourceContent', { sourceContent: 'SOURCE_CONTENT_PRIVATE_456' }],
    ['SD-AI12 contentHash', { contentHash: 'a'.repeat(64) }],
    ['SD-AI13 versionId', { versionId: REVISION }],
    ['versionNumber', { versionNumber: 3 }],
    ['sources', { sources: [{ sourceId: SOURCE_A }] }],
    ['sourceId', { sourceId: SOURCE_A }],
    ['extractionVersion', { extractionVersion: 'content-studio-source-v2' }],
    ['finalUrl', { finalUrl: 'https://example.com/a' }],
    ['blocks', { blocks: [] }],
  ])('M1 refuses a body with %s', async (field, extra) => {
    for (const [dto, body] of both) {
      const message = await rejected(dto, { ...body(), ...extra });
      expect(message).toContain(
        `property ${field.replace(/^SD-AI\d+ /, '')} should not exist`
      );
      expect(message).not.toContain('SOURCE_CONTENT_PRIVATE_456');
    }
  });

  it('forwards the source ids as they came, for the item and the thread route', async () => {
    const { writing, controller } = setup();
    await controller.generateItemProposal(
      ORG,
      USER,
      PACKAGE,
      Object.assign(new ContentStudioAIItemProposalDto(), itemBody())
    );
    await controller.generateThreadProposal(
      ORG,
      USER,
      PACKAGE,
      Object.assign(new ContentStudioAIThreadProposalDto(), threadBody())
    );
    for (const fn of [writing.proposeItem, writing.proposeThread]) {
      expect(fn.mock.calls[0][0].selection.sourceIds).toEqual([
        SOURCE_B,
        SOURCE_A,
      ]);
    }
  });
});
