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
