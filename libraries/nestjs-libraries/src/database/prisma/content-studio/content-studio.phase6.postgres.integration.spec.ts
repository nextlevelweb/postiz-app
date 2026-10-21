import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioDesignTemplateRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.repository';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { ContentStudioDesignPageSetRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.repository';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { parseVerifiedContentStudioDesignRevision } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioDesignAIService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-ai.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { ContentStudioAIResolutionError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { applyContentStudioDesignAIProposal } from '@gitroom/nestjs-libraries/content-studio/design/design.ai.proposal';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// no Media is read here
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// P6-01 on a real PostgreSQL: a design from a saved package revision, made
// by the real package, design, template and page set services on the real
// repositories. What the database itself enforces is pinned by going
// around the services on purpose: the composite foreign key that keeps the
// source in the design's own organization, Restrict on the revision, and
// the one transaction that writes the project, its first revision and its
// source together or not at all. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database (see jest.content-studio.postgres.guard.ts)

const ORG_A = '60100000-0000-4000-8000-00000000000a';
const ORG_B = '60100000-0000-4000-8000-00000000000b';
const USER_A = '60100000-0000-4000-8000-0000000000a1';
const USER_B = '60100000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const TEXT = '  Spring sale 🌸\n\n\tTwo lines — été 春\n  ';

let client: PrismaClient;
let prisma: PrismaService;
let service: ContentStudioService;
let designs: ContentStudioDesignService;
let designRepository: ContentStudioDesignRepository;
let designAI: ContentStudioDesignAIService;
// the provider's answer for the next suggestion (P6-02): no network
let answer: string;

const createPackage = async (organizationId = ORG_A) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P601 package',
        draft: JSON.stringify(
          parseContentPackageDraft({
            schemaVersion: 1,
            copy: {
              global: { thread: [{ id: 'main', text: '', mediaIds: [] }] },
            },
          })
        ),
        latestRevisionNumber: 0,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

// A stored revision exactly as the revision service writes one
const createRevision = async (
  packageId: string,
  revisionNumber: number,
  text: string,
  organizationId = ORG_A
) => {
  const content = canonicalJson(
    parseContentPackageDraft({
      schemaVersion: 1,
      copy: {
        global: {
          thread: [
            { id: 'main', text, mediaIds: [] },
            { id: 'second', text: 'Not this one', mediaIds: [] },
          ],
        },
      },
    })
  );
  const revision = await client.contentPackageRevision.create({
    data: {
      organizationId,
      packageId,
      revisionNumber,
      schemaVersion: 1,
      content,
      contentHash: sha256Hex(content),
      origin: 'manual',
      sourceDraftVersion: revisionNumber,
      createdById: OWNER[organizationId],
    },
    select: { id: true, contentHash: true },
  });
  await client.contentPackage.updateMany({
    where: { id: packageId },
    data: { latestRevisionNumber: revisionNumber },
  });
  return revision;
};

const create = (
  input: { packageId: string; revisionId: string },
  body: Record<string, unknown> = { canvas: 'square' },
  organizationId = ORG_A
) =>
  service.createDesignFromRevision({
    organizationId,
    userId: OWNER[organizationId],
    packageId: input.packageId,
    revisionId: input.revisionId,
    name: 'P601 design',
    itemId: 'main',
    ...body,
  }) as Promise<{ id: string }>;

const codeOf = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  if (err instanceof HttpException) {
    return (err.getResponse() as { code: string }).code;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code;
  }
  throw err;
};

const projectsOf = (organizationId = ORG_A) =>
  client.contentStudioDesignProject.findMany({
    where: { organizationId },
    select: {
      id: true,
      updatedAt: true,
      sourcePackageRevisionId: true,
      sourcePackageContentHash: true,
    },
    orderBy: { createdAt: 'asc' },
  });

const cleanPhase6 = async () => {
  const where = { organizationId: { in: ORGS } };
  // P6-02: AI operations first: they restrict deleting their design revision
  await client.contentStudioAIUsage.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentStudioAIConnection.deleteMany({ where });
  // designs first: their source restricts deleting the package revision
  await client.contentStudioDesignRevision.deleteMany({ where });
  await client.contentStudioDesignProject.deleteMany({ where });
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
};

const cleanFixtures = async () => {
  await cleanPhase6();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: USERS } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

beforeAll(async () => {
  // checks CONTENT_STUDIO_POSTGRES_INTEGRATION_URL before any client exists
  client = createContentStudioPostgresClient();
  await client.$connect();
  prisma = client as unknown as PrismaService;
  designRepository = new ContentStudioDesignRepository(
    new PrismaRepository<'contentStudioDesignProject'>(prisma),
    new PrismaRepository<'contentStudioDesignRevision'>(prisma),
    new PrismaTransaction(prisma)
  );
  designs = new ContentStudioDesignService(
    designRepository,
    new ContentStudioBrandKitRepository(
      new PrismaRepository<'contentStudioBrandKit'>(prisma),
      new PrismaRepository<'contentStudioBrandKitRevision'>(prisma),
      new PrismaTransaction(prisma)
    ),
    // never reached: creating and reading a design asks no review
    {} as ContentStudioReviewService
  );
  const templates = new ContentStudioDesignTemplateService(
    new ContentStudioDesignTemplateRepository(
      new PrismaRepository<'contentStudioDesignTemplate'>(prisma),
      new PrismaRepository<'contentStudioDesignTemplateRevision'>(prisma),
      new PrismaTransaction(prisma)
    ),
    designs,
    // no Media is used here
    {} as ContentStudioDesignReferenceService
  );
  const pageSets = new ContentStudioDesignPageSetService(
    new ContentStudioDesignPageSetRepository(
      new PrismaRepository<'contentStudioDesignPageSet'>(prisma)
    ),
    designs
  );
  service = new ContentStudioService(
    new ContentStudioRepository(
      new PrismaRepository<'contentStudioProject'>(prisma),
      new PrismaRepository<'contentPackage'>(prisma),
      new PrismaRepository<'contentPackageRevision'>(prisma),
      new PrismaTransaction(prisma)
    ),
    {} as ContentStudioMediaService,
    {} as ContentStudioGroundingService,
    // never reached: a design asks for no review, approval or policy
    {} as ContentStudioReviewService,
    {} as ContentStudioEditorialPolicyService,
    designs,
    templates,
    pageSets
  );
  // P6-02: the real design AI path on the real repositories; only the
  // provider is a stand-in that answers `answer`
  const execution = new ContentStudioAIExecutionService(
    {} as ContentStudioRepository,
    {
      resolve: async (where: {
        organizationId: string;
        connectionId: string;
      }) => {
        const row = await client.contentStudioAIConnection.findFirst({
          where: {
            id: where.connectionId,
            organizationId: where.organizationId,
          },
          select: { id: true },
        });
        if (!row) {
          throw new ContentStudioAIResolutionError('NOT_FOUND');
        }
        return {
          connectionId: row.id,
          provider: 'openai',
          adapter: {
            provider: 'openai',
            validateConnection: async () => ({ ok: true }),
            generateText: async () => ({
              text: answer,
              finishReason: 'stop',
              usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960 },
              providerRequestId: 'req_p6ai',
            }),
          },
        };
      },
    } as unknown as ContentStudioAIProviderResolver,
    new ContentStudioAIOperationRepository(
      new PrismaRepository<'contentStudioAIOperation'>(prisma),
      new PrismaTransaction(prisma)
    )
  );
  designAI = new ContentStudioDesignAIService(
    designs,
    new ContentStudioAIConnectionRepository(
      new PrismaRepository<'contentStudioAIConnection'>(prisma)
    ),
    // no profile is chosen here, so no profile is read
    new ContentStudioAIWritingService(
      {} as ContentStudioRepository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      execution,
      {} as never
    ),
    execution
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P601 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p601.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P601 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanPhase6();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('P6-01 a design from a saved package revision on PostgreSQL', () => {
  it('P6PG1/PD1/M1 writes the project, its first revision and the exact source together, from the revision asked for', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    await createRevision(packageId, 4, 'The latest version');
    const created = await create({ packageId, revisionId: three.id });
    const [project] = await projectsOf();
    expect(project).toMatchObject({
      id: created.id,
      sourcePackageRevisionId: three.id,
      sourcePackageContentHash: three.contentHash,
    });
    const revisions = await client.contentStudioDesignRevision.findMany({
      where: { designProjectId: created.id },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revisionNumber).toBe(1);
    const document = parseVerifiedContentStudioDesignRevision(revisions[0]);
    expect(document.pages[0].layers).toEqual([
      expect.objectContaining({ type: 'text', text: TEXT }),
    ]);
    expect(revisions[0].content).not.toContain('The latest version');
    expect(revisions[0].content).not.toContain('Not this one');
  });

  it('P6PG2/PV7 the source is read through the relation of the same organization, as exactly that revision', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    const created = await create({ packageId, revisionId: three.id });
    const detail = (await designs.getDesign(ORG_A, created.id)) as {
      source: unknown;
    };
    expect(detail.source).toEqual({
      packageId,
      packageName: 'P601 package',
      packageRevisionId: three.id,
      packageRevisionNumber: 3,
      packageContentHash: three.contentHash,
    });
    // another organization reads no such design at all
    expect(await codeOf(designs.getDesign(ORG_B, created.id))).toBe(
      'CS_NOT_FOUND'
    );
  });

  it('P6PG3/SEC1/M10 a revision of another organization is not found through the service, and refused by the foreign key around it', async () => {
    const foreignPackage = await createPackage(ORG_B);
    const foreign = await createRevision(foreignPackage, 1, 'Theirs', ORG_B);
    expect(
      await codeOf(
        create({ packageId: foreignPackage, revisionId: foreign.id })
      )
    ).toBe('CS_NOT_FOUND');
    // the revision exists, in another package of this organization: not this one
    const packageId = await createPackage();
    const other = await createPackage();
    const mine = await createRevision(other, 1, 'Other package');
    expect(await codeOf(create({ packageId, revisionId: mine.id }))).toBe(
      'CS_NOT_FOUND'
    );
    // around the service: a design of A naming B's revision, or none at all
    for (const sourcePackageRevisionId of [foreign.id, randomUUID()]) {
      expect(
        await codeOf(
          designRepository.createProjectWithFirstRevision({
            designProjectId: randomUUID(),
            revisionId: randomUUID(),
            organizationId: ORG_A,
            name: 'Forged',
            createdById: USER_A,
            revision: {
              schemaVersion: 1,
              content: '{}',
              contentHash: 'a'.repeat(64),
            },
            source: {
              packageRevisionId: sourcePackageRevisionId,
              contentHash: foreign.contentHash,
            },
          })
        )
      ).toBe('P2003');
    }
    expect(await projectsOf()).toEqual([]);
    expect(
      await client.contentStudioDesignRevision.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(0);
  });

  it('P6PG3 Restrict: a package revision a design came from cannot be deleted from under it', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    await create({ packageId, revisionId: three.id });
    expect(
      await codeOf(
        client.contentPackageRevision.delete({ where: { id: three.id } })
      )
    ).toBe('P2003');
    expect(
      await client.contentPackageRevision.count({ where: { id: three.id } })
    ).toBe(1);
  });

  it('P6PG4/PD7/PV3 one revision seeds many designs, each its own project and revision', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    const made = await Promise.all([
      create({ packageId, revisionId: three.id }),
      create(
        { packageId, revisionId: three.id },
        { pageSetId: 'system:page-set-social-core' }
      ),
      create(
        { packageId, revisionId: three.id },
        {
          templateSource: 'system',
          templateId: 'system:square-post',
          templateRevisionNumber: 2,
          textSlotId: 'body',
          values: { headline: 'Given' },
        }
      ),
    ]);
    expect(new Set(made.map((design) => design.id)).size).toBe(3);
    const projects = await projectsOf();
    expect(projects.map((p) => p.sourcePackageRevisionId)).toEqual([
      three.id,
      three.id,
      three.id,
    ]);
    expect(
      await client.contentStudioDesignRevision.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(3);
  });

  it('P6PG5/PV2/F10 a newer package revision changes nothing of a design made from an older one', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    const created = await create({ packageId, revisionId: three.id });
    const [before] = await projectsOf();
    await createRevision(packageId, 4, 'Version four');
    await client.contentPackage.updateMany({
      where: { id: packageId },
      data: { name: 'Renamed later' },
    });
    const [after] = await projectsOf();
    expect(after).toEqual(before);
    const detail = (await designs.getDesign(ORG_A, created.id)) as {
      source: { packageRevisionId: string; packageRevisionNumber: number };
    };
    expect(detail.source).toMatchObject({
      packageRevisionId: three.id,
      packageRevisionNumber: 3,
    });
  });

  it('P6PG6 a first revision that cannot be written leaves no project and no source', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    const existing = await create({ packageId, revisionId: three.id });
    const taken = (
      await client.contentStudioDesignRevision.findFirstOrThrow({
        where: { designProjectId: existing.id },
      })
    ).id;
    const designProjectId = randomUUID();
    expect(
      await codeOf(
        designRepository.createProjectWithFirstRevision({
          designProjectId,
          // the id of a revision that exists: the second insert fails
          revisionId: taken,
          organizationId: ORG_A,
          name: 'Half made',
          createdById: USER_A,
          revision: {
            schemaVersion: 1,
            content: '{}',
            contentHash: 'a'.repeat(64),
          },
          source: {
            packageRevisionId: three.id,
            contentHash: three.contentHash,
          },
        })
      )
    ).toBe('P2002');
    expect(
      await client.contentStudioDesignProject.count({
        where: { id: designProjectId },
      })
    ).toBe(0);
    expect((await projectsOf()).map((p) => p.id)).toEqual([existing.id]);
  });

  it('PV6/M6 a source rewritten behind the service fails closed, never pointing at another revision', async () => {
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    const four = await createRevision(packageId, 4, 'Version four');
    const created = await create({ packageId, revisionId: three.id });
    for (const data of [
      { sourcePackageContentHash: four.contentHash },
      { sourcePackageContentHash: null },
      { sourcePackageRevisionId: four.id },
    ]) {
      await client.contentStudioDesignProject.updateMany({
        where: { id: created.id },
        data,
      });
      expect(await codeOf(designs.getDesign(ORG_A, created.id))).toBe(
        'CS_DESIGN_SOURCE_INTEGRITY_ERROR'
      );
      await client.contentStudioDesignProject.updateMany({
        where: { id: created.id },
        data: {
          sourcePackageRevisionId: three.id,
          sourcePackageContentHash: three.contentHash,
        },
      });
    }
    expect(
      (
        (await designs.getDesign(ORG_A, created.id)) as {
          source: { packageRevisionId: string };
        }
      ).source.packageRevisionId
    ).toBe(three.id);
  });

  it('PV4 a design created on its own has no source, and existing rows need none', async () => {
    const created = (await designs.createDesign({
      organizationId: ORG_A,
      userId: USER_A,
      name: 'Manual',
      content: {
        schemaVersion: 1,
        brandKit: null,
        pages: [
          {
            id: 'p',
            name: '',
            width: 1080,
            height: 1080,
            background: {
              type: 'solid',
              color: { type: 'literal', value: '#ffffff' },
            },
            layers: [],
          },
        ],
      },
    })) as { id: string };
    expect(await projectsOf()).toEqual([
      expect.objectContaining({
        id: created.id,
        sourcePackageRevisionId: null,
        sourcePackageContentHash: null,
      }),
    ]);
    expect(
      ((await designs.getDesign(ORG_A, created.id)) as { source: unknown })
        .source
    ).toBeNull();
  });
});

// P6-02 on a real PostgreSQL: a Design Creative AI suggestion records one AI
// operation with its usage on the exact design revision, and nothing else:
// no design revision, project change, review, approval or handoff. The
// composite foreign key keeps an operation on a revision of its own
// organization, and Restrict keeps that revision
describe('P6-02 Design Creative AI suggestions on PostgreSQL', () => {
  const DOCUMENT = {
    schemaVersion: 1,
    brandKit: null,
    pages: [
      {
        id: 'p1',
        name: '',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#ffffff' },
        },
        layers: [
          {
            id: 'l_title',
            name: 'Title',
            type: 'text',
            x: 80,
            y: 80,
            width: 900,
            height: 300,
            rotation: 0,
            opacity: 1,
            visible: true,
            text: 'Spring sale',
            font: {
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
        ],
      },
    ],
  };
  const TEXT_ANSWER = JSON.stringify({
    summary: 'Warmer.',
    operations: [{ type: 'set_text', layer: 'TEXT_1', text: 'Spring is here' }],
  });

  const createConnection = async (organizationId = ORG_A) =>
    (
      await client.contentStudioAIConnection.create({
        data: {
          organizationId,
          name: 'P6AI connection',
          provider: 'openai',
          sealedCredential: 'sb1.placeholder.not-a-real-envelope',
          defaultModel: 'gpt-6-luna',
          credentialUpdatedAt: new Date('2026-10-01T10:00:00.000Z'),
          createdById: OWNER[organizationId],
        },
        select: { id: true },
      })
    ).id;
  const createDesign = async (organizationId = ORG_A) => {
    const created = (await designs.createDesign({
      organizationId,
      userId: OWNER[organizationId],
      name: 'P6AI design',
      content: DOCUMENT,
    })) as { id: string };
    const revision = await client.contentStudioDesignRevision.findFirstOrThrow({
      where: { designProjectId: created.id },
      select: { id: true, contentHash: true },
    });
    return { designId: created.id, revision };
  };
  const propose = (
    designId: string,
    revisionId: string,
    connectionId: string,
    organizationId = ORG_A
  ) =>
    designAI.proposeDesign({
      organizationId,
      userId: OWNER[organizationId],
      designId,
      revisionId,
      intent: 'improve_copy',
      selection: { connectionId },
    });
  // everything of the design, its review and handoffs, to compare before
  // and after
  const designState = async (designId: string) => ({
    project: await client.contentStudioDesignProject.findUniqueOrThrow({
      where: { id: designId },
    }),
    revisions: await client.contentStudioDesignRevision.findMany({
      where: { designProjectId: designId },
      orderBy: { revisionNumber: 'asc' },
    }),
    reviews: await client.contentStudioReview.count({
      where: { organizationId: { in: ORGS } },
    }),
    approvals: await client.contentStudioApproval.count({
      where: { organizationId: { in: ORGS } },
    }),
    handoffs: await client.contentStudioHandoff.count({
      where: { organizationId: { in: ORGS } },
    }),
  });

  beforeEach(() => {
    answer = TEXT_ANSWER;
  });

  it('P6AI-PG1/AO1/AO2/PA1 records one operation and its usage on exactly the revision, and writes no design revision', async () => {
    const connectionId = await createConnection();
    const { designId, revision } = await createDesign();
    const before = await designState(designId);
    const result = (await propose(designId, revision.id, connectionId)) as {
      operationId: string;
      proposal: Parameters<typeof applyContentStudioDesignAIProposal>[1];
    };
    expect(await designState(designId)).toEqual(before);
    const operation = await client.contentStudioAIOperation.findUniqueOrThrow({
      where: { id: result.operationId },
      include: { usages: true },
    });
    expect(operation).toMatchObject({
      organizationId: ORG_A,
      userId: USER_A,
      connectionId,
      packageId: null,
      baseDraftVersion: null,
      designRevisionId: revision.id,
      kind: 'design_improve_copy',
      status: 'succeeded',
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 'cs-design-improve-copy-v1',
      errorCode: null,
      context: {
        v: 1,
        design: {
          designId,
          revisionId: revision.id,
          revisionNumber: 1,
          contentHash: revision.contentHash,
        },
      },
    });
    expect(operation.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(operation.usages).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'succeeded',
        inputTokens: 900,
        outputTokens: 60,
        totalTokens: 960,
        providerRequestId: 'req_p6ai',
      }),
    ]);
    // no text of the design, the prompt or the answer is stored
    expect(JSON.stringify(operation)).not.toMatch(/Spring|Warmer/);
    // PA4: applied in the editor and saved, it is an ordinary next revision
    const saved = (await designs.createRevision({
      organizationId: ORG_A,
      designId,
      userId: USER_A,
      baseRevisionNumber: 1,
      content: applyContentStudioDesignAIProposal(
        parseVerifiedContentStudioDesignRevision(before.revisions[0]),
        result.proposal,
        null
      ),
    })) as { created: boolean; revision: { revisionNumber: number } };
    expect(saved).toMatchObject({
      created: true,
      revision: { revisionNumber: 2 },
    });
    expect(
      await client.contentStudioReview.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(0);
  });

  it('P6AI-PG2/AO4 an answer that does not fit records a failed operation and changes no design', async () => {
    const connectionId = await createConnection();
    const { designId, revision } = await createDesign();
    const before = await designState(designId);
    answer = JSON.stringify({
      summary: 'x',
      operations: [{ type: 'delete_layer', layer: 'TEXT_1' }],
    });
    expect(await codeOf(propose(designId, revision.id, connectionId))).toBe(
      'CS_AI_DESIGN_PROPOSAL_INVALID'
    );
    answer = 'not json';
    expect(await codeOf(propose(designId, revision.id, connectionId))).toBe(
      'CS_AI_DESIGN_PROPOSAL_INVALID'
    );
    expect(await designState(designId)).toEqual(before);
    const operations = await client.contentStudioAIOperation.findMany({
      where: { designRevisionId: revision.id },
      include: { usages: true },
    });
    expect(operations).toHaveLength(2);
    for (const operation of operations) {
      expect(operation).toMatchObject({
        status: 'failed',
        errorCode: 'INVALID_RESPONSE',
        resultHash: null,
      });
      expect(operation.usages).toEqual([
        expect.objectContaining({ outcome: 'failed', inputTokens: 900 }),
      ]);
    }
  });

  it('P6AI-PG3/BR2/M13 a normal save after the suggestion makes it stale: revision 1 is not asked again, revision 2 is used as itself', async () => {
    const connectionId = await createConnection();
    const { designId, revision } = await createDesign();
    await propose(designId, revision.id, connectionId);
    await designs.createRevision({
      organizationId: ORG_A,
      designId,
      userId: USER_A,
      baseRevisionNumber: 1,
      content: {
        ...DOCUMENT,
        pages: [{ ...DOCUMENT.pages[0], name: 'Saved by hand' }],
      },
    });
    expect(await codeOf(propose(designId, revision.id, connectionId))).toBe(
      'CS_AI_DESIGN_BASE_STALE'
    );
    const two = await client.contentStudioDesignRevision.findFirstOrThrow({
      where: { designProjectId: designId, revisionNumber: 2 },
      select: { id: true },
    });
    const result = (await propose(designId, two.id, connectionId)) as {
      operationId: string;
      base: { revisionId: string; revisionNumber: number };
    };
    expect(result.base).toMatchObject({
      revisionId: two.id,
      revisionNumber: 2,
    });
    expect(
      (
        await client.contentStudioAIOperation.findUniqueOrThrow({
          where: { id: result.operationId },
        })
      ).designRevisionId
    ).toBe(two.id);
    // the stale request recorded nothing: one operation per revision asked
    expect(
      await client.contentStudioAIOperation.count({
        where: { designRevisionId: revision.id },
      })
    ).toBe(1);
  });

  it('P6AI-PG4/PS1/PS2 the package provenance of a design stays exactly as it was', async () => {
    const connectionId = await createConnection();
    const packageId = await createPackage();
    const three = await createRevision(packageId, 3, TEXT);
    const created = await create({ packageId, revisionId: three.id });
    const revision = await client.contentStudioDesignRevision.findFirstOrThrow({
      where: { designProjectId: created.id },
      select: { id: true },
    });
    const before = await designState(created.id);
    answer = JSON.stringify({
      summary: 'Shorter.',
      operations: [{ type: 'set_text', layer: 'TEXT_1', text: 'Spring' }],
    });
    await propose(created.id, revision.id, connectionId);
    expect(await designState(created.id)).toEqual(before);
    expect(before.project).toMatchObject({
      sourcePackageRevisionId: three.id,
      sourcePackageContentHash: three.contentHash,
    });
    // and the package itself is untouched
    expect(
      await client.contentPackageRevision.count({ where: { packageId } })
    ).toBe(1);
  });

  it('P6AI-PG5/M17 the AI workflow creates no review, approval or handoff row', async () => {
    const connectionId = await createConnection();
    const { designId, revision } = await createDesign();
    await propose(designId, revision.id, connectionId);
    const state = await designState(designId);
    expect([state.reviews, state.approvals, state.handoffs]).toEqual([0, 0, 0]);
  });

  it('SEC1/AI3/M10 another organization cannot ask for the design, and its connection is not ours', async () => {
    const mine = await createConnection();
    const theirs = await createConnection(ORG_B);
    const { designId, revision } = await createDesign();
    expect(await codeOf(propose(designId, revision.id, theirs, ORG_B))).toBe(
      'CS_NOT_FOUND'
    );
    expect(await codeOf(propose(designId, revision.id, theirs))).toBe(
      'CS_AI_CONNECTION_REQUIRED'
    );
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(0);
    await propose(designId, revision.id, mine);
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(1);
  });

  it('the foreign key keeps an operation on a revision of its own organization, and Restrict keeps that revision', async () => {
    const theirs = await createConnection(ORG_B);
    const mine = await createConnection();
    const { revision } = await createDesign();
    const row = (organizationId: string, connectionId: string) => ({
      id: randomUUID(),
      organizationId,
      userId: OWNER[organizationId],
      connectionId,
      designRevisionId: revision.id,
      kind: 'design_restyle',
      status: 'running',
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 'cs-design-restyle-v1',
      context: { v: 1 },
      requestHash: 'a'.repeat(64),
    });
    expect(
      await codeOf(
        client.contentStudioAIOperation.create({ data: row(ORG_B, theirs) })
      )
    ).toBe('P2003');
    await client.contentStudioAIOperation.create({ data: row(ORG_A, mine) });
    expect(
      await codeOf(
        client.contentStudioDesignRevision.delete({
          where: { id: revision.id },
        })
      )
    ).toBe('P2003');
  });
});
