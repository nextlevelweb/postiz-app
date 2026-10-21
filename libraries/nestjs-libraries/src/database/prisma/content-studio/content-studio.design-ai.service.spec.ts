import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioDesignAIService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-ai.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import {
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextRequest } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import { storedContentStudioWritingProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile.revision';
import { parseContentStudioWritingProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// P6-02: Design Creative AI through the real design AI, design, AI writing
// (profile context) and AI execution services. Only the repositories, the
// provider resolver and its adapter are stand-ins: the design revision is
// stored canonical JSON with its hash and verified as in production, the
// Brand Kit revision too, and the operation is recorded through the real
// execution path. PostgreSQL pins the rows themselves
// (content-studio.phase6.postgres.integration.spec.ts)

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const DESIGN = '60200000-0000-4000-8000-0000000000a1';
const OTHER_DESIGN = '60200000-0000-4000-8000-0000000000a2';
const REV_3 = '60200000-0000-4000-8000-0000000000b3';
const REV_4 = '60200000-0000-4000-8000-0000000000b4';
const OTHER_REV = '60200000-0000-4000-8000-0000000000c1';
const KIT = '60200000-0000-4000-8000-0000000000d1';
const KIT_REV_2 = '60200000-0000-4000-8000-0000000000d2';
const KIT_REV_5 = '60200000-0000-4000-8000-0000000000d5';
const PKG = '60200000-0000-4000-8000-0000000000e1';
const PKG_REV = '60200000-0000-4000-8000-0000000000e2';
const WRITING_ID = '60200000-0000-4000-8000-0000000000f1';
const WRITING_REV = '60200000-0000-4000-8000-0000000000f2';
const T = new Date('2026-10-21T10:00:00.000Z');
const MEDIA = 'media_private_602';
const MEDIA_SHA = 'e'.repeat(64);
const DESIGN_TEXT = 'DESIGN_TEXT_PRIVATE_602 Spring sale';
const KIT_MARKER = 'KIT_NEW_REVISION_MARKER_602';
const INSTRUCTION = 'INSTRUCTION_PRIVATE_602 make it premium';
const SUMMARY = 'SUMMARY_PRIVATE_602 tighter copy';
const KEY = 'sk-content-studio-test-secret-602';
const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const kitContent = (marker = 'Acme') =>
  parseContentStudioBrandKitContent({
    schemaVersion: 1,
    identity: { brandName: marker, tagline: '', description: '' },
    colors: [
      { id: 'primary', name: 'Acme Red', value: '#cc0000', role: 'primary' },
    ],
    typography: [
      {
        id: 'heading',
        name: 'Heading',
        family: 'Inter',
        weight: 700,
        style: 'normal',
        role: 'heading',
      },
    ],
    visualDirection: { keywords: ['bold'], dos: [], donts: [] },
  });
const KIT_2 = storedContentStudioBrandKitContent(kitContent());

const designDocument = (withKit: boolean, text = DESIGN_TEXT) =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit: withKit
      ? {
          brandKitId: KIT,
          revisionId: KIT_REV_2,
          revisionNumber: 2,
          contentHash: KIT_2.contentHash,
        }
      : null,
    pages: [
      {
        id: 'page_1',
        name: 'Cover',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: withKit
            ? { type: 'brand', tokenId: 'primary' }
            : { type: 'literal', value: '#ffffff' },
        },
        layers: [
          {
            id: 'l_title',
            name: 'Title',
            type: 'text',
            x: 80,
            y: 80,
            width: 920,
            height: 300,
            rotation: 0,
            opacity: 1,
            visible: true,
            text,
            font: withKit
              ? { type: 'brand', tokenId: 'heading' }
              : {
                  type: 'family',
                  family: 'Arial',
                  weight: 400,
                  style: 'normal',
                },
            fontSize: 72,
            lineHeight: 1.2,
            letterSpacing: 0,
            color: { type: 'literal', value: '#000000' },
            align: 'left',
            verticalAlign: 'top',
            overflow: 'shrink',
          },
          {
            id: 'l_photo',
            name: 'Photo',
            type: 'image',
            x: 0,
            y: 500,
            width: 1080,
            height: 580,
            rotation: 0,
            opacity: 1,
            visible: true,
            imageRef: { type: 'media', mediaId: MEDIA, sha256: MEDIA_SHA },
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.5 },
          },
        ],
      },
    ],
  });

const storedRevision = (
  id: string,
  revisionNumber: number,
  document = designDocument(false)
) => ({
  id,
  revisionNumber,
  createdAt: T,
  ...storedContentStudioDesignDocument(document),
});

const answer = (operations: unknown[], summary = SUMMARY) =>
  JSON.stringify({ summary, operations });
const providerResult = (text: string) => ({
  text,
  finishReason: 'stop' as const,
  usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 },
  providerRequestId: 'req_602',
});

const setup = (
  options: {
    withKit?: boolean;
    latestRevisionNumber?: number;
    archived?: boolean;
    source?: boolean;
    defaultModel?: string | null;
  } = {}
) => {
  const document = designDocument(!!options.withKit);
  const state = {
    project: {
      id: DESIGN,
      name: 'Spring visual',
      latestRevisionNumber: options.latestRevisionNumber ?? 3,
      archivedAt: options.archived ? T : null,
      createdAt: T,
      updatedAt: T,
      sourcePackageRevisionId: options.source ? PKG_REV : null,
      sourcePackageContentHash: options.source ? 'c'.repeat(64) : null,
      sourcePackageRevision: options.source
        ? {
            id: PKG_REV,
            packageId: PKG,
            revisionNumber: 6,
            contentHash: 'c'.repeat(64),
            package: { name: 'Spring launch' },
          }
        : null,
    },
    revisions: new Map<string, ReturnType<typeof storedRevision>>([
      [REV_3, storedRevision(REV_3, 3, document)],
      [
        REV_4,
        storedRevision(REV_4, 4, designDocument(false, 'Revision four text')),
      ],
    ]),
  };
  const designs = {
    getProjectDetailForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === DESIGN ? { ...state.project } : null
    ),
    getRevisionForProject: jest.fn(
      async (organizationId: string, projectId: string, id: string) => {
        const row = state.revisions.get(id);
        return organizationId === ORG && projectId === DESIGN && row
          ? { ...row }
          : null;
      }
    ),
    // writes that must never happen here
    createProjectWithFirstRevision: jest.fn(),
    createRevisionWithCompareAndSwap: jest.fn(),
    updateProjectName: jest.fn(),
    archiveProject: jest.fn(),
    restoreProject: jest.fn(),
  };
  const kitState = {
    revisions: new Map<string, Record<string, unknown>>([
      [KIT_REV_2, { id: KIT_REV_2, revisionNumber: 2, createdAt: T, ...KIT_2 }],
      [
        KIT_REV_5,
        {
          id: KIT_REV_5,
          revisionNumber: 5,
          createdAt: T,
          ...storedContentStudioBrandKitContent(kitContent(KIT_MARKER)),
        },
      ],
    ]),
  };
  const brandKits = {
    getBrandKitForOrganization: jest.fn(async (organizationId: string) =>
      organizationId === ORG ? { id: KIT, latestRevisionNumber: 5 } : null
    ),
    getRevisionForBrandKit: jest.fn(
      async (organizationId: string, kitId: string, id: string) => {
        const row = kitState.revisions.get(id);
        return organizationId === ORG && kitId === KIT && row
          ? { ...row }
          : null;
      }
    ),
    getRevisionByNumber: jest.fn(
      async (organizationId: string, kitId: string, n: number) => {
        const row = Array.from(kitState.revisions.values()).find(
          (entry) => entry.revisionNumber === n
        );
        return organizationId === ORG && kitId === KIT && row
          ? { ...row }
          : null;
      }
    ),
  };
  const reviews = {
    getRevisionApprovalStatus: jest.fn(),
    getRevisionApprovalStatuses: jest.fn(),
    requireApprovedRevision: jest.fn(),
    openReview: jest.fn(),
    decide: jest.fn(),
  };
  const designService = new ContentStudioDesignService(
    designs as unknown as ContentStudioDesignRepository,
    brandKits as unknown as ContentStudioBrandKitRepository,
    reviews as unknown as ContentStudioReviewService
  );

  const connection = {
    id: CONNECTION,
    name: 'Team OpenAI',
    provider: 'openai',
    defaultModel:
      options.defaultModel === undefined ? 'gpt-6-luna' : options.defaultModel,
    disabledAt: null,
  };
  const connections = {
    getConnectionForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === CONNECTION ? { ...connection } : null
    ),
  };
  const adapter = {
    provider: 'openai',
    validateConnection: jest.fn(),
    generateText: jest.fn(async (_request: ContentStudioAITextRequest) =>
      providerResult(
        answer([
          { type: 'set_text', layer: 'TEXT_1', text: 'A brighter spring' },
        ])
      )
    ),
  };
  const resolver = {
    resolve: jest.fn(
      async (where: { organizationId: string; connectionId: string }) => {
        if (where.organizationId !== ORG || where.connectionId !== CONNECTION) {
          throw new ContentStudioAIResolutionError('NOT_FOUND');
        }
        return { connectionId: CONNECTION, provider: 'openai', adapter };
      }
    ),
  };
  const operations = {
    createRunningOperation: jest.fn(async () => ({ id: 'op' })),
    completeSucceededWithUsage: jest.fn(async () => ({ completed: true })),
    completeFailedWithUsage: jest.fn(async () => ({ completed: true })),
    getOperationForOrganization: jest.fn(),
  };
  // a package operation reads its package; a design operation never does
  const packages = {
    getPackageForOrganization: jest.fn(),
    getRevisionForPackage: jest.fn(),
    saveDraftCompareAndSwap: jest.fn(),
    createRevisionWithCompareAndSwap: jest.fn(),
  };
  const execution = new ContentStudioAIExecutionService(
    packages as unknown as ContentStudioRepository,
    resolver as unknown as ContentStudioAIProviderResolver,
    operations as unknown as ContentStudioAIOperationRepository
  );
  const executeForDesign = jest.spyOn(execution, 'executeForDesign');
  const execute = jest.spyOn(execution, 'execute');

  const writingStored = storedContentStudioWritingProfileContent(
    parseContentStudioWritingProfileContent({
      schemaVersion: 1,
      voice: 'WRITING_VOICE_602',
      toneTags: ['warm'],
      perspective: null,
      formatting: { emoji: 'none', hashtags: 'none', notes: null },
      vocabulary: { prefer: [], avoid: [] },
      dos: [],
      donts: [],
      examples: [],
    })
  );
  const writingProfiles = {
    getProfileForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === WRITING_ID
          ? { id: WRITING_ID, latestRevisionNumber: 1, archivedAt: null }
          : null
    ),
    getRevisionByNumber: jest.fn(async () => ({
      id: WRITING_REV,
      revisionNumber: 1,
      createdAt: T,
      ...writingStored,
    })),
  };
  const none = {
    getProfileForOrganization: jest.fn(async () => null),
    getRevisionByNumber: jest.fn(async () => null),
    getPolicyForOrganization: jest.fn(async () => null),
  };
  const sources = { getSourceForOrganization: jest.fn() };
  const writing = new ContentStudioAIWritingService(
    packages as unknown as ContentStudioRepository,
    writingProfiles as unknown as ContentStudioWritingProfileRepository,
    none as unknown as ContentStudioEditorialPolicyRepository,
    none as unknown as ContentStudioAudienceProfileRepository,
    none as unknown as ContentStudioExpertiseProfileRepository,
    execution,
    sources as unknown as ContentStudioSourceRepository
  );

  const service = new ContentStudioDesignAIService(
    designService,
    connections as unknown as ContentStudioAIConnectionRepository,
    writing,
    execution
  );
  return {
    service,
    state,
    designs,
    brandKits,
    kitState,
    reviews,
    connections,
    adapter,
    resolver,
    operations,
    packages,
    executeForDesign,
    execute,
    writingProfiles,
    sources,
  };
};
type Context = ReturnType<typeof setup>;

const input = (
  overrides: Record<string, unknown> = {},
  selection: Record<string, unknown> = {}
) => ({
  organizationId: ORG,
  userId: USER,
  designId: DESIGN,
  revisionId: REV_3,
  intent: 'improve_copy',
  ...overrides,
  selection: { connectionId: CONNECTION, ...selection },
});

const requestOf = (ctx: Context) =>
  ctx.adapter.generateText.mock.calls[0][0] as ContentStudioAITextRequest;

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const error = err as HttpException;
    return {
      status: error.getStatus(),
      body: error.getResponse() as { code: string; msg: string },
    };
  }
  throw new Error('expected a refusal');
};

// nothing of the design, its review or a package was ever written
const nothingWritten = (ctx: Context) => {
  for (const write of [
    ctx.designs.createProjectWithFirstRevision,
    ctx.designs.createRevisionWithCompareAndSwap,
    ctx.designs.updateProjectName,
    ctx.designs.archiveProject,
    ctx.designs.restoreProject,
    ctx.reviews.openReview,
    ctx.reviews.decide,
    ctx.reviews.requireApprovedRevision,
    ctx.reviews.getRevisionApprovalStatus,
    ctx.reviews.getRevisionApprovalStatuses,
    ctx.packages.getPackageForOrganization,
    ctx.packages.getRevisionForPackage,
    ctx.packages.saveDraftCompareAndSwap,
    ctx.packages.createRevisionWithCompareAndSwap,
  ]) {
    expect(write).not.toHaveBeenCalled();
  }
};

describe('Design Creative AI: a suggestion for an exact revision', () => {
  it('PA1/AO1-AO3/AO6 answers a proposal for revision 3, records one design operation and writes no design', async () => {
    const ctx = setup();
    const result = await ctx.service.proposeDesign(input());
    expect(result.base).toEqual({
      designId: DESIGN,
      revisionId: REV_3,
      revisionNumber: 3,
      contentHash: ctx.state.revisions.get(REV_3)!.contentHash,
    });
    expect(result.proposal).toEqual({
      schemaVersion: 1,
      intent: 'improve_copy',
      summary: SUMMARY,
      operations: [
        { type: 'set_text', layerId: 'l_title', text: 'A brighter spring' },
      ],
    });
    // PA7: the hash is the canonical JSON of exactly the proposal answered
    expect(result.proposalHash).toBe(
      sha256Hex(canonicalJsonWithFiniteNumbers(result.proposal))
    );
    expect(result.proposalHash).not.toBe(
      sha256Hex(
        canonicalJsonWithFiniteNumbers({
          ...result.proposal,
          operations: [
            { type: 'set_text', layerId: 'l_title', text: 'Tampered' },
          ],
        })
      )
    );
    expect(result.changes).toEqual([
      {
        kind: 'text',
        pageId: 'page_1',
        layerId: 'l_title',
        layerName: 'Title',
        layerType: 'text',
        before: DESIGN_TEXT,
        after: 'A brighter spring',
      },
    ]);
    expect(result.ai).toEqual({
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 'cs-design-improve-copy-v1',
    });

    // one operation on the revision, never on a package
    expect(ctx.operations.createRunningOperation).toHaveBeenCalledTimes(1);
    const [[created]] = ctx.operations.createRunningOperation.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(created).toMatchObject({
      organizationId: ORG,
      userId: USER,
      connectionId: CONNECTION,
      packageId: null,
      baseDraftVersion: null,
      designRevisionId: REV_3,
      kind: 'design_improve_copy',
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 'cs-design-improve-copy-v1',
      context: {
        v: 1,
        design: {
          designId: DESIGN,
          revisionId: REV_3,
          revisionNumber: 3,
          contentHash: ctx.state.revisions.get(REV_3)!.contentHash,
        },
      },
    });
    // AO2: the provider's usage, on the succeeded operation
    expect(ctx.operations.completeSucceededWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        usage: expect.objectContaining({
          outcome: 'succeeded',
          inputTokens: 1200,
          outputTokens: 80,
          totalTokens: 1280,
          provider: 'openai',
          model: 'gpt-6-luna',
          providerRequestId: 'req_602',
        }),
      })
    );
    expect(ctx.operations.completeFailedWithUsage).not.toHaveBeenCalled();
    expect(ctx.execute).not.toHaveBeenCalled();
    nothingWritten(ctx);
    // nothing stored holds the design text, the prompt or the answer
    const stored = inspect(
      Object.values(ctx.operations).map((fn) => fn.mock.calls),
      { depth: 20 }
    );
    expect(stored).not.toContain('DESIGN_TEXT_PRIVATE_602');
    expect(stored).not.toContain('SUMMARY_PRIVATE_602');
    expect(stored).not.toContain('A brighter spring');
  });

  it('BR1/PS3 the prompt is built from exactly revision 3, the design as it is now', async () => {
    const ctx = setup({ source: true });
    await ctx.service.proposeDesign(input({}, { instruction: INSTRUCTION }));
    const request = requestOf(ctx);
    expect(request.prompt).toContain(DESIGN_TEXT);
    expect(request.prompt).not.toContain('Revision four text');
    expect(request.prompt).toContain(INSTRUCTION);
    expect(request.output).toEqual({ type: 'text' });
    expect(request.model).toBe('gpt-6-luna');
  });

  it('BR2/M1 a newer revision never replaces the one asked for: an older revision is refused as stale, before any AI', async () => {
    const ctx = setup({ latestRevisionNumber: 4 });
    const refused = await failure(ctx.service.proposeDesign(input()));
    expect(refused).toEqual({
      status: 409,
      body: {
        code: 'CS_AI_DESIGN_BASE_STALE',
        msg: 'This revision is no longer the current revision of the design.',
      },
    });
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
    expect(ctx.operations.createRunningOperation).not.toHaveBeenCalled();
    // and revision 4, current, is used as itself
    await ctx.service.proposeDesign(input({ revisionId: REV_4 }));
    expect(requestOf(ctx).prompt).toContain('Revision four text');
    expect(
      (
        ctx.operations.createRunningOperation.mock.calls[0] as unknown as [
          Record<string, unknown>
        ]
      )[0].designRevisionId
    ).toBe(REV_4);
  });

  it('BR3 a stored revision that is not exactly what was written is an integrity error, never repaired', async () => {
    const ctx = setup();
    const row = ctx.state.revisions.get(REV_3)!;
    ctx.state.revisions.set(REV_3, {
      ...row,
      contentHash: 'f'.repeat(64),
    });
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_DESIGN_INTEGRITY_ERROR'
    );
    ctx.state.revisions.set(REV_3, {
      ...row,
      content: row.content.replace('Spring sale', 'Tampered'),
    });
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_DESIGN_INTEGRITY_ERROR'
    );
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  });

  it('BR4/BR5/SEC1 a revision of another design, another organization or an id that is no uuid is not found', async () => {
    const ctx = setup();
    for (const overrides of [
      { revisionId: OTHER_REV },
      { designId: OTHER_DESIGN },
      { organizationId: OTHER_ORG },
      { revisionId: 'latest' },
      { designId: 'not-a-uuid' },
    ]) {
      expect(
        await failure(ctx.service.proposeDesign(input(overrides)))
      ).toEqual({
        status: 404,
        body: { code: 'CS_NOT_FOUND', msg: 'Design not found.' },
      });
    }
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
    expect(ctx.connections.getConnectionForOrganization).not.toHaveBeenCalled();
  });

  it('an archived design gets no suggestion', async () => {
    const ctx = setup({ archived: true });
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_DESIGN_ARCHIVED'
    );
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  });
});

describe('Design Creative AI: the AI connection (AI)', () => {
  it('AI1/AI3 no connection of the organization is CONNECTION_REQUIRED, before any provider or operation', async () => {
    const ctx = setup();
    for (const overrides of [
      { connectionId: '49999999-9999-4999-8999-999999999999' },
    ]) {
      expect(
        await failure(ctx.service.proposeDesign(input({}, overrides)))
      ).toEqual({
        status: 400,
        body: {
          code: 'CS_AI_CONNECTION_REQUIRED',
          msg: 'Select an available AI connection.',
        },
      });
    }
    // another organization's own connection reads as missing
    const foreign = setup();
    await failure(
      foreign.service.proposeDesign(
        input({ organizationId: OTHER_ORG, designId: DESIGN })
      )
    );
    expect(ctx.resolver.resolve).not.toHaveBeenCalled();
    expect(ctx.operations.createRunningOperation).not.toHaveBeenCalled();
  });

  it('AI2/AI4/M18 uses exactly the chosen connection of the organization: no environment key, no other connection', async () => {
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
    try {
      const ctx = setup();
      ctx.connections.getConnectionForOrganization.mockResolvedValueOnce(null);
      const refused = await failure(ctx.service.proposeDesign(input()));
      expect(refused.body.code).toBe('CS_AI_CONNECTION_REQUIRED');
      expect(ctx.adapter.generateText).not.toHaveBeenCalled();

      await ctx.service.proposeDesign(input());
      expect(
        ctx.connections.getConnectionForOrganization
      ).toHaveBeenLastCalledWith(ORG, CONNECTION);
      expect(ctx.resolver.resolve).toHaveBeenCalledWith({
        organizationId: ORG,
        connectionId: CONNECTION,
      });
      expect(JSON.stringify(requestOf(ctx))).not.toContain(KEY);
    } finally {
      if (before === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = before;
      }
    }
  });

  it("AI5/SEC5 the model is the connection's own, else its provider's default: never one from the request", async () => {
    const ctx = setup({ defaultModel: 'not-a-catalog-model' });
    await ctx.service.proposeDesign(
      input(
        {},
        {
          model: 'gpt-evil',
          provider: 'anthropic',
          apiKey: KEY,
          contentHash: 'f'.repeat(64),
        }
      )
    );
    expect(requestOf(ctx).model).toBe('gpt-6.1-sol');
    // SEC3/M2: the base hash is the stored revision's, never one sent
    const [[created]] = ctx.operations.createRunningOperation.mock
      .calls as unknown as [[{ context: { design: { contentHash: string } } }]];
    expect(created.context.design.contentHash).toBe(
      ctx.state.revisions.get(REV_3)!.contentHash
    );
    const own = setup({ defaultModel: 'gpt-6-luna' });
    await own.service.proposeDesign(input({}, { model: 'gpt-evil' }));
    expect(requestOf(own).model).toBe('gpt-6-luna');
  });

  it('maps a disabled connection and provider failures to the AI writing codes, and records the failure', async () => {
    const ctx = setup();
    ctx.resolver.resolve.mockRejectedValueOnce(
      new ContentStudioAIResolutionError('DISABLED')
    );
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_AI_CONNECTION_DISABLED'
    );
    // AO5
    ctx.adapter.generateText.mockRejectedValueOnce(
      new ContentStudioAIProviderError('RATE_LIMITED')
    );
    expect(await failure(ctx.service.proposeDesign(input()))).toEqual({
      status: 429,
      body: {
        code: 'CS_AI_RATE_LIMITED',
        msg: 'The AI provider is rate limiting this connection.',
      },
    });
    expect(ctx.operations.completeFailedWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'RATE_LIMITED' })
    );
    nothingWritten(ctx);
  });
});

describe('Design Creative AI: the answer (OV, AO4)', () => {
  it('AO4/OV13/M8 an answer with one operation that does not fit is refused as a whole and recorded as INVALID_RESPONSE', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(
        answer([
          { type: 'set_text', layer: 'TEXT_1', text: 'Fine' },
          {
            type: 'set_bounds',
            layer: 'IMAGE_1',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        ])
      )
    );
    expect(await failure(ctx.service.proposeDesign(input()))).toEqual({
      status: 502,
      body: {
        code: 'CS_AI_DESIGN_PROPOSAL_INVALID',
        msg: 'The AI suggestion does not fit this design.',
      },
    });
    expect(ctx.operations.completeFailedWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'INVALID_RESPONSE',
        usage: expect.objectContaining({
          outcome: 'failed',
          inputTokens: 1200,
        }),
      })
    );
    expect(ctx.operations.completeSucceededWithUsage).not.toHaveBeenCalled();
    nothingWritten(ctx);
  });

  it('OV9/OV12/SEC6/SEC7 malformed JSON, a raw layer id, a Media id or URL are refused the same way, never quoted', async () => {
    for (const raw of [
      'Sure! Here is the JSON',
      '```json\n' +
        answer([{ type: 'set_text', layer: 'TEXT_1', text: 'x' }]) +
        '\n```',
      answer([{ type: 'set_text', layer: 'l_title', text: 'x' }]),
      answer([{ type: 'set_image', layer: 'IMAGE_1', mediaId: 'evil_media' }]),
      answer([
        {
          type: 'set_text',
          layer: 'TEXT_1',
          text: 'x',
          url: 'https://evil.test',
        },
      ]),
    ]) {
      const ctx = setup();
      ctx.adapter.generateText.mockResolvedValueOnce(providerResult(raw));
      const refused = await failure(ctx.service.proposeDesign(input()));
      expect(refused.body.code).toBe('CS_AI_DESIGN_PROPOSAL_INVALID');
      expect(JSON.stringify(refused)).not.toMatch(
        /evil|l_title|TEXT_1|Sure|DESIGN_TEXT/
      );
    }
  });

  it('a cut-off answer is an invalid response, a refused one a content refusal', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce({
      ...providerResult(
        answer([{ type: 'set_text', layer: 'TEXT_1', text: 'x' }])
      ),
      finishReason: 'length' as never,
    });
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_AI_INVALID_RESPONSE'
    );
    ctx.adapter.generateText.mockResolvedValueOnce({
      ...providerResult('{}'),
      finishReason: 'content_filter' as never,
    });
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_AI_CONTENT_REJECTED'
    );
  });
});

describe('Design Creative AI: the request (INT, SEC)', () => {
  it('INT4 refuses an unknown intent before anything is read', async () => {
    const ctx = setup();
    for (const intent of ['delete_layers', 'IMPROVE_COPY', undefined, 3]) {
      expect(
        await failure(ctx.service.proposeDesign(input({ intent })))
      ).toEqual({
        status: 400,
        body: {
          code: 'CS_AI_DESIGN_INTENT_INVALID',
          msg: 'This kind of design suggestion is not available.',
        },
      });
    }
    expect(ctx.designs.getProjectDetailForOrganization).not.toHaveBeenCalled();
  });

  it('a tone change needs a tone; profiles belong to copy suggestions only; an instruction is checked', async () => {
    const ctx = setup();
    expect(
      (
        await failure(
          ctx.service.proposeDesign(input({ intent: 'adapt_tone' }))
        )
      ).body.code
    ).toBe('CS_INVALID_REQUEST');
    for (const selection of [
      { writingProfileId: WRITING_ID },
      { editorialPolicy: true },
    ]) {
      expect(
        (
          await failure(
            ctx.service.proposeDesign(input({ intent: 'restyle' }, selection))
          )
        ).body.code
      ).toBe('CS_INVALID_REQUEST');
    }
    for (const instruction of ['x'.repeat(2001), 'a\u0000b', 42]) {
      expect(
        (await failure(ctx.service.proposeDesign(input({}, { instruction }))))
          .body.code
      ).toBe('CS_INVALID_REQUEST');
    }
    expect(
      (
        await failure(
          ctx.service.proposeDesign(input({}, { connectionId: 'x' }))
        )
      ).body.code
    ).toBe('CS_INVALID_REQUEST');
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  });

  it('copy suggestions use the chosen Writing Profile at its current revision, recorded by id', async () => {
    const ctx = setup();
    await ctx.service.proposeDesign(
      input({}, { writingProfileId: WRITING_ID })
    );
    expect(requestOf(ctx).prompt).toContain('WRITING_VOICE_602');
    expect(
      (
        ctx.operations.createRunningOperation.mock.calls[0] as unknown as [
          { context: Record<string, unknown> }
        ]
      )[0].context.profiles
    ).toEqual([
      {
        kind: 'writing',
        profileId: WRITING_ID,
        revisionId: WRITING_REV,
        revisionNumber: 1,
      },
    ]);
    expect(ctx.sources.getSourceForOrganization).not.toHaveBeenCalled();
  });

  it('P602-2/SEC6/SEC8 the prompt holds tokens only: no design, layer, page, Media, kit or revision id, no hash, no key', async () => {
    const ctx = setup({ withKit: true, source: true });
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(
        answer([
          { type: 'set_page_background', page: 'PAGE_1', color: '#101010' },
        ])
      )
    );
    await ctx.service.proposeDesign(
      input({ intent: 'restyle' }, { instruction: INSTRUCTION })
    );
    const request = requestOf(ctx);
    const prompt = `${request.system}\n${request.prompt}`;
    expect(prompt).toContain('TEXT_1');
    expect(prompt).toContain('IMAGE_1');
    expect(prompt).toContain('PAGE_1');
    expect(prompt).not.toMatch(UUID_ANYWHERE);
    for (const hidden of [
      'l_title',
      'l_photo',
      'page_1',
      MEDIA,
      MEDIA_SHA,
      KIT_2.contentHash,
      'c'.repeat(64),
      KEY,
      ORG,
      USER,
    ]) {
      expect(prompt).not.toContain(hidden);
    }
  });
});

describe('Design Creative AI: Brand Kit (BK)', () => {
  it('BK1/BK2/BK5/M11 uses exactly the kit revision the design names, never the current one, with its colors and fonts as tokens', async () => {
    const ctx = setup({ withKit: true });
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(
        answer([{ type: 'set_text_style', layer: 'TEXT_1', color: 'COLOR_1' }])
      )
    );
    const result = await ctx.service.proposeDesign(
      input({ intent: 'restyle' })
    );
    expect(ctx.brandKits.getRevisionForBrandKit).toHaveBeenCalledWith(
      ORG,
      KIT,
      KIT_REV_2
    );
    expect(ctx.brandKits.getRevisionForBrandKit).not.toHaveBeenCalledWith(
      ORG,
      KIT,
      KIT_REV_5
    );
    const prompt = requestOf(ctx).prompt;
    expect(prompt).toContain('COLOR_1: Acme Red (primary) #cc0000');
    expect(prompt).toContain('FONT_1: Heading (heading) Inter 700 normal');
    expect(prompt).not.toContain(KIT_MARKER);
    expect(result.proposal.operations).toEqual([
      {
        type: 'set_text_style',
        layerId: 'l_title',
        color: { type: 'brand', tokenId: 'primary' },
      },
    ]);
  });

  it('BK3 a kit revision that is not intact fails closed, before any AI', async () => {
    const ctx = setup({ withKit: true });
    ctx.kitState.revisions.set(KIT_REV_2, {
      ...ctx.kitState.revisions.get(KIT_REV_2)!,
      contentHash: '0'.repeat(64),
    });
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_DESIGN_BRAND_REFERENCE_INTEGRITY_ERROR'
    );
    ctx.kitState.revisions.delete(KIT_REV_2);
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND'
    );
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  });

  it('BK4 a design without a kit works, and a kit token in the answer is refused', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(
        answer([{ type: 'set_text_style', layer: 'TEXT_1', color: 'COLOR_1' }])
      )
    );
    expect(
      (await failure(ctx.service.proposeDesign(input({ intent: 'restyle' }))))
        .body.code
    ).toBe('CS_AI_DESIGN_PROPOSAL_INVALID');
    expect(ctx.brandKits.getBrandKitForOrganization).not.toHaveBeenCalled();
    await expect(ctx.service.proposeDesign(input())).resolves.toBeTruthy();
    expect(requestOf(ctx).prompt).not.toContain('## Brand Kit');
  });
});

describe('Design Creative AI: package provenance (PS)', () => {
  it('PS1/PS2/PS4 names the package and version only: no package copy is read, nothing of the provenance changes', async () => {
    const ctx = setup({ source: true });
    await ctx.service.proposeDesign(input());
    const prompt = requestOf(ctx).prompt;
    expect(prompt).toContain(
      'This design was created from the content package "Spring launch", version 6. Work from the design as it is now.'
    );
    // no thread item is assumed, no package revision is read
    expect(prompt).not.toMatch(/thread item|item id|post 1 of/i);
    expect(ctx.packages.getRevisionForPackage).not.toHaveBeenCalled();
    nothingWritten(ctx);
    expect(ctx.state.project.sourcePackageRevisionId).toBe(PKG_REV);
  });

  it('a tampered provenance fails closed like the design detail', async () => {
    const ctx = setup({ source: true });
    ctx.state.project.sourcePackageContentHash = 'd'.repeat(64);
    expect((await failure(ctx.service.proposeDesign(input()))).body.code).toBe(
      'CS_DESIGN_SOURCE_INTEGRITY_ERROR'
    );
  });
});
