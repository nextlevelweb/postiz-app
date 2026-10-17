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
  CreateContentStudioAIConnectionDto,
  ReplaceContentStudioAIConnectionCredentialDto,
  UpdateContentStudioAIConnectionDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-connection.dto';

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

const MARKER = 'sk-content-studio-test-secret-123';
const ID = '33333333-3333-4333-8333-333333333333';
// as the auth middleware sets it: only the requesting user's membership
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const setup = () => {
  const result = { from: 'service' };
  const ai = {
    listProviders: jest.fn().mockReturnValue(result),
    listConnections: jest.fn().mockResolvedValue(result),
    getConnection: jest.fn().mockResolvedValue(result),
    createConnection: jest.fn().mockResolvedValue(result),
    updateConnection: jest.fn().mockResolvedValue(result),
    replaceCredential: jest.fn().mockResolvedValue(result),
    disableConnection: jest.fn().mockResolvedValue(result),
    enableConnection: jest.fn().mockResolvedValue(result),
    archiveConnection: jest.fn().mockResolvedValue(result),
    testConnection: jest.fn().mockResolvedValue({ ok: true }),
  };
  const controller = new ContentStudioController(
    {} as ContentStudioService,
    {} as ContentStudioHandoffService,
    ai as unknown as ContentStudioAIConnectionService,
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
    {} as ContentStudioDesignReferenceService,
    {} as ContentStudioDesignTemplateService
  );
  return { ai, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    createdById: 'user-b',
    sealedCredential: 'sb1.k1.x.y.z',
    provider: 'openrouter',
    role: 'ADMIN',
  });

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

describe('ContentStudioController AI connection routes', () => {
  it('C1 lists the providers', () => {
    const { ai, controller, result } = setup();
    expect(controller.listAIProviders()).toBe(result);
    expect(ai.listProviders).toHaveBeenCalledWith();
  });

  it('C2/C3 lists and reads connections of the request organization', async () => {
    const { ai, controller, result } = setup();
    await expect(controller.listAIConnections(ORG)).resolves.toBe(result);
    await expect(controller.getAIConnection(ORG, ID)).resolves.toBe(result);
    expect(ai.listConnections).toHaveBeenCalledWith('org-a');
    expect(ai.getConnection).toHaveBeenCalledWith('org-a', ID);
  });

  it('C4 creates with the request org and user and the declared fields only', async () => {
    const { ai, controller, result } = setup();
    const body = withExtras(new CreateContentStudioAIConnectionDto());
    body.name = 'Main';
    body.provider = 'openai';
    body.credential = { apiKey: MARKER };
    body.defaultModel = 'gpt-6-luna';

    await expect(controller.createAIConnection(ORG, USER, body)).resolves.toBe(
      result
    );
    expect(ai.createConnection).toHaveBeenCalledWith(
      { organization: ORG, user: USER },
      {
        name: 'Main',
        provider: 'openai',
        credential: { apiKey: MARKER },
        defaultModel: 'gpt-6-luna',
      }
    );
  });

  it('C5 updates with the name and the default model only', async () => {
    const { ai, controller } = setup();
    const body = withExtras(new UpdateContentStudioAIConnectionDto());
    body.name = 'Renamed';
    body.defaultModel = null;
    await controller.updateAIConnection(ORG, USER, ID, body);
    expect(ai.updateConnection).toHaveBeenCalledWith(
      { organization: ORG, user: USER },
      ID,
      { name: 'Renamed', defaultModel: null }
    );
  });

  it('C6 replaces the credential with the credential object only', async () => {
    const { ai, controller } = setup();
    const body = withExtras(
      new ReplaceContentStudioAIConnectionCredentialDto()
    );
    body.credential = { apiKey: MARKER };
    await controller.replaceAIConnectionCredential(ORG, USER, ID, body);
    expect(ai.replaceCredential).toHaveBeenCalledWith(
      { organization: ORG, user: USER },
      ID,
      { apiKey: MARKER }
    );
  });

  it('C7-C9 disables, enables and archives for the request org and user', async () => {
    const { ai, controller } = setup();
    await controller.disableAIConnection(ORG, USER, ID);
    await controller.enableAIConnection(ORG, USER, ID);
    await controller.archiveAIConnection(ORG, USER, ID);
    for (const fn of [
      ai.disableConnection,
      ai.enableConnection,
      ai.archiveConnection,
    ]) {
      expect(fn).toHaveBeenCalledWith({ organization: ORG, user: USER }, ID);
    }
  });

  it('C12 tests a connection for the request org and user, with no body', async () => {
    const { ai, controller } = setup();
    await expect(controller.testAIConnection(ORG, USER, ID)).resolves.toEqual({
      ok: true,
    });
    expect(ai.testConnection).toHaveBeenCalledWith(
      { organization: ORG, user: USER },
      ID
    );
    expect(controller.testAIConnection).toHaveLength(3);
  });

  it('declares exactly these AI routes, with 200 for the lifecycle posts', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /AI/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /ai/connections',
      'GET /ai/connections/:id',
      'GET /ai/providers',
      'PATCH /ai/connections/:id',
      'POST /ai/connections',
      'POST /ai/connections/:id/archive',
      'POST /ai/connections/:id/disable',
      'POST /ai/connections/:id/enable',
      'POST /ai/connections/:id/test',
      'PUT /ai/connections/:id/credential',
    ]);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createAIConnection'))
    ).toBeUndefined();
    for (const name of [
      'disableAIConnection',
      'enableAIConnection',
      'archiveAIConnection',
      'testAIConnection',
    ]) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
  });

  it('C10/C11 has no delete, restore, model, usage, operation or generation route', () => {
    const routes = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(routes.filter((r) => r.includes('/ai/'))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^DELETE /)])
    );
    expect(
      routes.filter((r) =>
        /\/ai\/.*(restore|model|usage|validate|operation|generat)/.test(r)
      )
    ).toEqual([]);
    expect(routes.filter((r) => r.startsWith('DELETE '))).toEqual([]);
  });

  it('declares the DTOs as the bodies and takes org and user from decorators', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('createAIConnection')[2]).toBe(
      CreateContentStudioAIConnectionDto
    );
    expect(types('updateAIConnection')[3]).toBe(
      UpdateContentStudioAIConnectionDto
    );
    expect(types('replaceAIConnectionCredential')[3]).toBe(
      ReplaceContentStudioAIConnectionCredentialDto
    );
    for (const dto of [
      CreateContentStudioAIConnectionDto,
      UpdateContentStudioAIConnectionDto,
      ReplaceContentStudioAIConnectionCredentialDto,
    ]) {
      const fields = Object.keys(new dto());
      for (const forbidden of [
        'organizationId',
        'createdById',
        'sealedCredential',
        'id',
        'role',
      ]) {
        expect(fields).not.toContain(forbidden);
      }
    }
  });

  it('adds no billing, subscription or CheckPolicies gate to the controller', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(
      /CheckPolicies|Sections\.|AuthorizationActions|SubscriptionException|@Delete\(/
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
  const message = JSON.stringify((error as BadRequestException).getResponse());
  // a validation answer never repeats a key or an envelope
  expect(message).not.toContain(MARKER);
  expect(message).not.toContain('sb1.');
  return message;
};

const VALID = {
  name: 'Main OpenAI',
  provider: 'openai',
  credential: { apiKey: MARKER },
};

describe('AI connection DTO validation', () => {
  it('D1 accepts a valid create body and keeps the credential object as sent', async () => {
    const body = await run(CreateContentStudioAIConnectionDto, VALID);
    expect(body).toBeInstanceOf(CreateContentStudioAIConnectionDto);
    expect({ ...body }).toEqual(VALID);
  });

  it.each([
    ['D2 no provider', { name: 'x', credential: { apiKey: MARKER } }],
    ['a provider that is not text', { ...VALID, provider: 7 }],
    ['D4 no credential', { name: 'x', provider: 'openai' }],
    ['D5 a credential that is a string', { ...VALID, credential: MARKER }],
    ['D5 a credential that is null', { ...VALID, credential: null }],
    ['no name', { provider: 'openai', credential: { apiKey: MARKER } }],
    ['D13 a name over 100 characters', { ...VALID, name: 'x'.repeat(101) }],
  ])('rejects a create body with %s', async (_name, body) => {
    await rejected(CreateContentStudioAIConnectionDto, body);
  });

  it.each([
    [
      'D6 organizationId',
      CreateContentStudioAIConnectionDto,
      { ...VALID, organizationId: 'org-b' },
    ],
    [
      'createdById',
      CreateContentStudioAIConnectionDto,
      { ...VALID, createdById: 'user-b' },
    ],
    [
      'D7 sealedCredential',
      CreateContentStudioAIConnectionDto,
      { ...VALID, sealedCredential: `sb1.k1.${MARKER}` },
    ],
    ['id', CreateContentStudioAIConnectionDto, { ...VALID, id: ID }],
    ['role', CreateContentStudioAIConnectionDto, { ...VALID, role: 'ADMIN' }],
    [
      'D9 provider',
      UpdateContentStudioAIConnectionDto,
      { name: 'x', provider: 'openrouter' },
    ],
    [
      'credential',
      UpdateContentStudioAIConnectionDto,
      { name: 'x', credential: { apiKey: MARKER } },
    ],
    [
      'disabledAt',
      UpdateContentStudioAIConnectionDto,
      { name: 'x', disabledAt: null },
    ],
    [
      'D10 sealedCredential',
      ReplaceContentStudioAIConnectionCredentialDto,
      { credential: { apiKey: MARKER }, sealedCredential: 'sb1.k1.x.y.z' },
    ],
    [
      'provider',
      ReplaceContentStudioAIConnectionCredentialDto,
      { credential: { apiKey: MARKER }, provider: 'openrouter' },
    ],
  ])('rejects a body with %s', async (field, dto, body) => {
    const message = await rejected(dto, body);
    expect(message).toContain(
      `property ${field.replace(/^D\d+ /, '')} should not exist`
    );
  });

  it('D11 leaves nested credential fields to the strict provider parser', async () => {
    // class-validator does not look inside the credential; the service's
    // parser refuses { apiKey, baseURL } with CS_AI_CREDENTIAL_INVALID
    const body = await run(CreateContentStudioAIConnectionDto, {
      ...VALID,
      credential: { apiKey: MARKER, baseURL: 'https://x.test' },
    });
    expect(body.credential).toEqual({
      apiKey: MARKER,
      baseURL: 'https://x.test',
    });
  });

  it('D12 lets the service trim and refuse a blank name', async () => {
    // a blank name is a string within limits; the service answers 400
    const body = await run(UpdateContentStudioAIConnectionDto, { name: '   ' });
    expect(body.name).toBe('   ');
    await rejected(UpdateContentStudioAIConnectionDto, {
      name: 'x'.repeat(101),
    });
    await rejected(UpdateContentStudioAIConnectionDto, { name: null });
    // an empty update passes the DTO; the service refuses it with a 400
    expect({ ...(await run(UpdateContentStudioAIConnectionDto, {})) }).toEqual(
      {}
    );
  });

  it('D8 takes a default model as text on create and as text or null on update', async () => {
    // which models exist is the service's catalog check, not the DTO's
    expect(
      (
        await run(CreateContentStudioAIConnectionDto, {
          ...VALID,
          defaultModel: 'any-model',
        })
      ).defaultModel
    ).toBe('any-model');
    expect(
      (
        await run(UpdateContentStudioAIConnectionDto, {
          defaultModel: 'gpt-6-luna',
        })
      ).defaultModel
    ).toBe('gpt-6-luna');
    expect(
      (await run(UpdateContentStudioAIConnectionDto, { defaultModel: null }))
        .defaultModel
    ).toBeNull();
    for (const defaultModel of [null, 42, ['gpt-6-luna'], 'm'.repeat(129)]) {
      await rejected(CreateContentStudioAIConnectionDto, {
        ...VALID,
        defaultModel,
      });
    }
    for (const defaultModel of [42, { id: 'gpt-6-luna' }, 'm'.repeat(129)]) {
      await rejected(UpdateContentStudioAIConnectionDto, { defaultModel });
    }
  });

  it('accepts a replacement with the credential only', async () => {
    const body = await run(ReplaceContentStudioAIConnectionCredentialDto, {
      credential: { apiKey: MARKER },
    });
    expect({ ...body }).toEqual({ credential: { apiKey: MARKER } });
    await rejected(ReplaceContentStudioAIConnectionCredentialDto, {});
  });
});
