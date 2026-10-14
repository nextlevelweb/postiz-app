import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Opt-in: runs only through jest.content-studio.integration.config.ts against
// the disposable local database (see jest.content-studio.postgres.guard.ts).
// The repositories run unchanged on a real PostgreSQL; Prisma is used directly
// only to build fixtures, read final state and bypass the repositories on
// purpose to prove what the database itself enforces. Concurrent calls are
// judged by the final state, never by timing

// Media and the composer HTML are not under test (as in the service unit
// specs): the Media service is stubbed below, the real MediaService would pull
// in the upload providers, and the sanitizer only loads under a DOM
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: jest.fn(),
}));

const ORG_A = 'p111-org-a';
const ORG_B = 'p111-org-b';
const USER_A = 'p111-user-a';
const USER_B = 'p111-user-b';
const MISSING_USER = 'p111-user-missing';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };

let client: PrismaClient;
let repository: ContentStudioRepository;
let handoffs: ContentStudioHandoffRepository;

const draftJson = (text: string) =>
  JSON.stringify(
    parseContentPackageDraft({
      schemaVersion: 1,
      copy: { global: { thread: [{ id: 'item-1', text, mediaIds: [] }] } },
    })
  );

// what the service stores as a revision: canonical content and its hash
const revisionContent = (text: string) => {
  const content = canonicalJson(JSON.parse(draftJson(text)));
  return { content, contentHash: sha256Hex(content), schemaVersion: 1 };
};

const createPackage = async (
  organizationId: string,
  options: {
    draftVersion?: number;
    latestRevisionNumber?: number;
    archivedAt?: Date | null;
    projectId?: string | null;
    text?: string;
  } = {}
) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        projectId: options.projectId ?? null,
        name: 'P111 package',
        draft: draftJson(options.text ?? 'draft A'),
        draftVersion: options.draftVersion ?? 1,
        latestRevisionNumber: options.latestRevisionNumber ?? 0,
        archivedAt: options.archivedAt ?? null,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

const createProject = async (organizationId: string) =>
  (
    await client.contentStudioProject.create({
      data: {
        organizationId,
        name: 'P111 project',
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

// bypasses the counter on purpose: for constraint tests only
const insertRevision = (
  organizationId: string,
  packageId: string,
  revisionNumber: number,
  createdById = OWNER[organizationId]
) =>
  client.contentPackageRevision.create({
    data: {
      organizationId,
      packageId,
      revisionNumber,
      ...revisionContent(`revision ${revisionNumber}`),
      origin: 'manual',
      sourceDraftVersion: 1,
      createdById,
    },
    select: { id: true },
  });

const revisionCas = (
  organizationId: string,
  packageId: string,
  expectedDraftVersion: number,
  expectedLatestRevisionNumber: number,
  createdById = OWNER[organizationId]
) =>
  repository.createRevisionWithCompareAndSwap({
    organizationId,
    packageId,
    expectedDraftVersion,
    expectedLatestRevisionNumber,
    ...revisionContent(`version from draft ${expectedDraftVersion}`),
    origin: 'manual',
    createdById,
  });

const newHandoffId = () => randomBytes(32).toString('hex');

const createHandoff = (
  organizationId: string,
  packageId: string,
  packageRevisionId: string,
  id = newHandoffId(),
  userId = OWNER[organizationId]
) =>
  handoffs.createHandoff({
    id,
    organizationId,
    userId,
    packageId,
    packageRevisionId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

// Package with one revision made through the repository
const packageWithRevision = async (organizationId: string) => {
  const packageId = await createPackage(organizationId, { draftVersion: 3 });
  const result = await revisionCas(organizationId, packageId, 3, 0);
  if (!result.created) {
    throw new Error('fixture revision was not created');
  }
  return { packageId, revisionId: result.revision.id };
};

const packageRow = (id: string) =>
  client.contentPackage.findUniqueOrThrow({
    where: { id },
    select: {
      draft: true,
      draftVersion: true,
      latestRevisionNumber: true,
      archivedAt: true,
    },
  });

const revisionsOf = (packageId: string) =>
  client.contentPackageRevision.findMany({
    where: { packageId },
    orderBy: { revisionNumber: 'asc' },
  });

// The Prisma error code of a failed write; a write that succeeds fails the
// test. Raw database messages are never asserted
const prismaCode = async (write: Promise<unknown>) => {
  try {
    await write;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return err.code;
    }
    throw err;
  }
  throw new Error('the write was expected to fail');
};

const counts = (results: PromiseSettledResult<{ count: number }>[]) =>
  results
    .map((r) => {
      if (r.status !== 'fulfilled') {
        throw r.reason;
      }
      return r.value.count;
    })
    .sort();

const cleanStudio = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioHandoff.deleteMany({ where });
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
  await client.contentStudioProject.deleteMany({ where });
};

const cleanFixtures = async () => {
  await cleanStudio();
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
  const prisma = client as unknown as PrismaService;
  repository = new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(prisma),
    new PrismaRepository<'contentPackage'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    new PrismaTransaction(prisma)
  );
  handoffs = new ContentStudioHandoffRepository(
    new PrismaRepository<'contentStudioHandoff'>(prisma)
  );

  await cleanFixtures();
  for (const [org, user] of [
    [ORG_A, USER_A],
    [ORG_B, USER_B],
  ]) {
    await client.organization.create({
      data: { id: org, name: `P111 ${org}` },
    });
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p111.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P111 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'ADMIN' },
    });
  }
});

beforeEach(cleanStudio);

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('draft compare-and-swap on PostgreSQL', () => {
  it('two writers on the same base version: exactly one wins, 10 races', async () => {
    for (let race = 0; race < 10; race++) {
      const packageId = await createPackage(ORG_A);
      const drafts = [draftJson(`B ${race}`), draftJson(`C ${race}`)];
      const results = await Promise.allSettled(
        drafts.map((draft) =>
          repository.saveDraftCompareAndSwap({
            organizationId: ORG_A,
            packageId,
            baseDraftVersion: 1,
            draft,
          })
        )
      );
      expect(counts(results)).toEqual([0, 1]);
      const winner = results.findIndex(
        (r) => r.status === 'fulfilled' && r.value.count === 1
      );
      const row = await packageRow(packageId);
      expect(row.draftVersion).toBe(2);
      expect(row.draft).toBe(drafts[winner]);
    }
  });

  it('a stale writer cannot overwrite; the next version can', async () => {
    const packageId = await createPackage(ORG_A, { draftVersion: 4 });
    const save = (baseDraftVersion: number, text: string) =>
      repository.saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion,
        draft: draftJson(text),
      });

    expect(await save(4, 'first')).toEqual({ count: 1 });
    expect(await save(4, 'stale')).toEqual({ count: 0 });
    expect(await packageRow(packageId)).toMatchObject({
      draftVersion: 5,
      draft: draftJson('first'),
    });
    expect(await save(5, 'next')).toEqual({ count: 1 });
    expect(await packageRow(packageId)).toMatchObject({
      draftVersion: 6,
      draft: draftJson('next'),
    });
  });

  it('another organization cannot save over a package', async () => {
    const packageId = await createPackage(ORG_A);
    const before = await packageRow(packageId);
    expect(
      await repository.saveDraftCompareAndSwap({
        organizationId: ORG_B,
        packageId,
        baseDraftVersion: 1,
        draft: draftJson('foreign'),
      })
    ).toEqual({ count: 0 });
    expect(await packageRow(packageId)).toEqual(before);
  });

  it('an archived package takes no draft or metadata write', async () => {
    const packageId = await createPackage(ORG_A, {
      archivedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const before = await packageRow(packageId);
    expect(
      await repository.saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: draftJson('archived'),
      })
    ).toEqual({ count: 0 });
    expect(
      await repository.updatePackageMetadata({
        organizationId: ORG_A,
        packageId,
        name: 'renamed',
      })
    ).toEqual({ count: 0 });
    expect(await packageRow(packageId)).toEqual(before);
  });
});

describe('revision compare-and-swap on PostgreSQL', () => {
  it('two creators on the same counter: one revision #1, 10 races', async () => {
    for (let race = 0; race < 10; race++) {
      const packageId = await createPackage(ORG_A, { draftVersion: 5 });
      const results = await Promise.allSettled([
        revisionCas(ORG_A, packageId, 5, 0),
        revisionCas(ORG_A, packageId, 5, 0),
      ]);
      // no P2002 or other error escapes
      const values = results.map((r) => {
        if (r.status !== 'fulfilled') {
          throw r.reason;
        }
        return r.value;
      });
      expect(values.filter((v) => v.created)).toHaveLength(1);
      expect(values.filter((v) => !v.created)).toEqual([
        { created: false, reason: 'compare-and-swap-failed' },
      ]);

      const rows = await revisionsOf(packageId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        revisionNumber: 1,
        sourceDraftVersion: 5,
      });
      expect((await packageRow(packageId)).latestRevisionNumber).toBe(1);
    }
  });

  it('numbers are monotonic and a stale counter creates nothing', async () => {
    const packageId = await createPackage(ORG_A, { draftVersion: 5 });
    for (const expected of [0, 1, 2]) {
      const result = await revisionCas(ORG_A, packageId, 5, expected);
      expect(result.created && result.revision.revisionNumber).toBe(
        expected + 1
      );
    }
    expect(await revisionCas(ORG_A, packageId, 5, 1)).toEqual({
      created: false,
      reason: 'compare-and-swap-failed',
    });
    expect((await revisionsOf(packageId)).map((r) => r.revisionNumber)).toEqual(
      [1, 2, 3]
    );
    expect((await packageRow(packageId)).latestRevisionNumber).toBe(3);
  });

  it('a stale draft version creates nothing', async () => {
    const packageId = await createPackage(ORG_A, { draftVersion: 6 });
    expect(await revisionCas(ORG_A, packageId, 5, 0)).toEqual({
      created: false,
      reason: 'compare-and-swap-failed',
    });
    expect(await revisionsOf(packageId)).toEqual([]);
    expect((await packageRow(packageId)).latestRevisionNumber).toBe(0);
  });

  it('an archived package or another organization creates nothing', async () => {
    const archived = await createPackage(ORG_A, {
      draftVersion: 5,
      archivedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(await revisionCas(ORG_A, archived, 5, 0)).toEqual({
      created: false,
      reason: 'compare-and-swap-failed',
    });
    const foreign = await createPackage(ORG_A, { draftVersion: 5 });
    expect(await revisionCas(ORG_B, foreign, 5, 0)).toEqual({
      created: false,
      reason: 'compare-and-swap-failed',
    });
    for (const packageId of [archived, foreign]) {
      expect(await revisionsOf(packageId)).toEqual([]);
      expect((await packageRow(packageId)).latestRevisionNumber).toBe(0);
    }
  });

  it('a draft save racing a revision create always ends consistent, 10 races', async () => {
    const outcomes = { revisionFirst: 0, draftFirst: 0 };
    for (let race = 0; race < 10; race++) {
      const packageId = await createPackage(ORG_A, { draftVersion: 5 });
      const [save, revision] = await Promise.allSettled([
        repository.saveDraftCompareAndSwap({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 5,
          draft: draftJson(`racing ${race}`),
        }),
        revisionCas(ORG_A, packageId, 5, 0),
      ]);
      if (save.status !== 'fulfilled') {
        throw save.reason;
      }
      if (revision.status !== 'fulfilled') {
        throw revision.reason;
      }
      // a revision never changes the draft version, so the save always lands
      expect(save.value).toEqual({ count: 1 });
      const row = await packageRow(packageId);
      const rows = await revisionsOf(packageId);
      expect(row.draftVersion).toBe(6);
      expect(row.latestRevisionNumber).toBe(rows.length);
      if (revision.value.created) {
        outcomes.revisionFirst += 1;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          revisionNumber: 1,
          sourceDraftVersion: 5,
        });
      } else {
        outcomes.draftFirst += 1;
        expect(revision.value).toEqual({
          created: false,
          reason: 'compare-and-swap-failed',
        });
        expect(rows).toEqual([]);
      }
    }
    expect(outcomes.revisionFirst + outcomes.draftFirst).toBe(10);
    console.log(`draft/revision race outcomes: ${JSON.stringify(outcomes)}`);
  });

  // the ordering the race above may not produce: the revision commits first
  it('a revision committed first leaves the draft save on the same base valid', async () => {
    const packageId = await createPackage(ORG_A, { draftVersion: 5 });
    const revision = await revisionCas(ORG_A, packageId, 5, 0);
    expect(revision.created && revision.revision.sourceDraftVersion).toBe(5);
    expect(
      await repository.saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 5,
        draft: draftJson('after the revision'),
      })
    ).toEqual({ count: 1 });
    expect(await packageRow(packageId)).toMatchObject({
      draftVersion: 6,
      latestRevisionNumber: 1,
    });
    expect(await revisionsOf(packageId)).toHaveLength(1);
  });

  it('rolls the counter back when the revision insert fails after the CAS', async () => {
    const packageId = await createPackage(ORG_A, { draftVersion: 5 });
    // the counter update matches, then the insert breaks the createdBy FK
    expect(
      await prismaCode(revisionCas(ORG_A, packageId, 5, 0, MISSING_USER))
    ).toBe('P2003');
    expect((await packageRow(packageId)).latestRevisionNumber).toBe(0);
    expect(await revisionsOf(packageId)).toEqual([]);

    const retry = await revisionCas(ORG_A, packageId, 5, 0);
    expect(retry.created && retry.revision.revisionNumber).toBe(1);
  });
});

describe('tenant constraints enforced by PostgreSQL', () => {
  it('a revision cannot point at a package of another organization', async () => {
    const packageId = await createPackage(ORG_A);
    expect(await prismaCode(insertRevision(ORG_B, packageId, 1))).toBe('P2003');
    expect(await revisionsOf(packageId)).toEqual([]);
  });

  it('a revision cannot point at a missing package; a valid one is stored', async () => {
    expect(
      await prismaCode(insertRevision(ORG_A, 'p111-missing-package', 1))
    ).toBe('P2003');
    const packageId = await createPackage(ORG_A);
    await insertRevision(ORG_A, packageId, 1);
    expect(await revisionsOf(packageId)).toHaveLength(1);
  });

  it('DOCUMENTED: the database lets a package use a project of another organization; the service refuses it', async () => {
    // ContentPackage.projectId references ContentStudioProject(id) only
    const projectA = await createProject(ORG_A);
    const packageB = await createPackage(ORG_B, { projectId: projectA });
    expect(
      await client.contentPackage.findUniqueOrThrow({
        where: { id: packageB },
        select: { organizationId: true, projectId: true },
      })
    ).toEqual({ organizationId: ORG_B, projectId: projectA });

    // P1-04: the service only attaches a project found in the organization
    expect(await repository.getProjectForOrganization(ORG_B, projectA)).toBe(
      null
    );
    const service = new ContentStudioService(
      repository,
      {} as ContentStudioMediaService
    );
    const refused = await service
      .createPackage({
        organizationId: ORG_B,
        userId: USER_B,
        projectId: projectA,
      })
      .catch((err) => err);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(404);
    expect(
      await client.contentPackage.count({
        where: { organizationId: ORG_B, projectId: projectA },
      })
    ).toBe(1);
  });

  it('a handoff cannot point at a package of another organization', async () => {
    const a = await packageWithRevision(ORG_A);
    expect(
      await prismaCode(
        client.contentStudioHandoff.create({
          data: {
            id: newHandoffId(),
            organizationId: ORG_B,
            userId: USER_B,
            packageId: a.packageId,
            packageRevisionId: a.revisionId,
            expiresAt: new Date(Date.now() + 60_000),
          },
        })
      )
    ).toBe('P2003');
  });

  it('a handoff cannot point at a revision of another organization', async () => {
    const a = await packageWithRevision(ORG_A);
    const b = await packageWithRevision(ORG_B);
    expect(
      await prismaCode(createHandoff(ORG_A, a.packageId, b.revisionId))
    ).toBe('P2003');
    expect(await client.contentStudioHandoff.count()).toBe(0);
  });

  it('DOCUMENTED: the database accepts a same-organization package/revision mismatch; the P1-07 service refuses it', async () => {
    const a = await packageWithRevision(ORG_A);
    const x = await packageWithRevision(ORG_A);

    // both references belong to the handoff's organization, which is all the
    // two composite foreign keys check: revision X is not of package A
    await createHandoff(ORG_A, a.packageId, x.revisionId);
    expect(
      await client.contentStudioHandoff.count({
        where: { packageId: a.packageId, packageRevisionId: x.revisionId },
      })
    ).toBe(1);

    // the service reads the revision with getRevisionForPackage(org,
    // package, revision) first, so the pairing never reaches the database
    expect(
      await repository.getRevisionForPackage(ORG_A, a.packageId, x.revisionId)
    ).toBe(null);
    const resolveForHandoff = jest.fn(async () => [[]]);
    const service = new ContentStudioHandoffService(repository, handoffs, {
      resolveForHandoff,
    } as unknown as ContentStudioMediaService);
    const refused = await service
      .createHandoff({
        organizationId: ORG_A,
        userId: USER_A,
        packageId: a.packageId,
        revisionId: x.revisionId,
      })
      .catch((err) => err);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getResponse()).toMatchObject({
      code: 'CS_NOT_FOUND',
    });
    expect(
      await client.contentStudioHandoff.count({
        where: { packageId: a.packageId },
      })
    ).toBe(1);

    // and the matching pair goes through the same service
    const made = await service.createHandoff({
      organizationId: ORG_A,
      userId: USER_A,
      packageId: a.packageId,
      revisionId: a.revisionId,
    });
    expect(made.id).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await client.contentStudioHandoff.findUniqueOrThrow({
        where: { id: made.id },
        select: { packageId: true, packageRevisionId: true },
      })
    ).toEqual({ packageId: a.packageId, packageRevisionId: a.revisionId });
  });
});

describe('organization and user scope of the real repositories', () => {
  it('packages and revisions of one organization are invisible to another', async () => {
    const a = await packageWithRevision(ORG_A);

    expect(
      await repository.getPackageForOrganization(ORG_A, a.packageId)
    ).toMatchObject({ id: a.packageId });
    expect(await repository.getPackageForOrganization(ORG_B, a.packageId)).toBe(
      null
    );
    expect(
      await repository.getRevisionForPackage(ORG_A, a.packageId, a.revisionId)
    ).toMatchObject({ id: a.revisionId, packageId: a.packageId });
    expect(
      await repository.getRevisionForPackage(ORG_B, a.packageId, a.revisionId)
    ).toBe(null);
    const list = (organizationId: string) =>
      repository.listRevisionsForPackage({
        organizationId,
        packageId: a.packageId,
        skip: 0,
        take: 20,
      });
    expect((await list(ORG_A)).map((r) => r.id)).toEqual([a.revisionId]);
    expect(await list(ORG_B)).toEqual([]);
    expect(await repository.countRevisionsForPackage(ORG_B, a.packageId)).toBe(
      0
    );
  });

  it('a handoff is only found and stamped by its own organization and user', async () => {
    const a = await packageWithRevision(ORG_A);
    const { id } = await createHandoff(ORG_A, a.packageId, a.revisionId);
    const get = (organizationId: string, userId: string, handoffId = id) =>
      handoffs.getHandoffForOrganizationAndUser({
        organizationId,
        userId,
        id: handoffId,
      });

    expect(await get(ORG_A, USER_A)).toMatchObject({
      id,
      packageId: a.packageId,
      packageRevisionId: a.revisionId,
    });
    expect(await get(ORG_A, USER_B)).toBe(null);
    expect(await get(ORG_B, USER_A)).toBe(null);
    expect(await get(ORG_A, USER_A, newHandoffId())).toBe(null);

    const at = new Date('2026-10-13T10:00:00.000Z');
    for (const [organizationId, userId] of [
      [ORG_A, USER_B],
      [ORG_B, USER_A],
    ]) {
      expect(
        await handoffs.markOpenedIfNeeded({
          organizationId,
          userId,
          id,
          openedAt: at,
        })
      ).toEqual({ count: 0 });
      expect(
        await handoffs.revokeHandoff({
          organizationId,
          userId,
          id,
          revokedAt: at,
        })
      ).toEqual({ count: 0 });
    }
    expect(await get(ORG_A, USER_A)).toMatchObject({
      openedAt: null,
      revokedAt: null,
    });

    expect(
      await handoffs.markOpenedIfNeeded({
        organizationId: ORG_A,
        userId: USER_A,
        id,
        openedAt: at,
      })
    ).toEqual({ count: 1 });
    expect(
      await handoffs.revokeHandoff({
        organizationId: ORG_A,
        userId: USER_A,
        id,
        revokedAt: at,
      })
    ).toEqual({ count: 1 });
    expect(await get(ORG_A, USER_A)).toMatchObject({
      openedAt: at,
      revokedAt: at,
    });
  });
});

describe('handoff first-write stamps on PostgreSQL', () => {
  const T1 = new Date('2026-10-13T10:00:01.000Z');
  const T2 = new Date('2026-10-13T10:00:02.000Z');
  const T3 = new Date('2026-10-13T10:00:03.000Z');

  const handoff = async () => {
    const a = await packageWithRevision(ORG_A);
    return (await createHandoff(ORG_A, a.packageId, a.revisionId)).id;
  };
  const stamps = (id: string) =>
    client.contentStudioHandoff.findUniqueOrThrow({
      where: { id },
      select: { openedAt: true, revokedAt: true },
    });

  it('two opens at once: the first stamp stays', async () => {
    const id = await handoff();
    const open = (openedAt: Date) =>
      handoffs.markOpenedIfNeeded({
        organizationId: ORG_A,
        userId: USER_A,
        id,
        openedAt,
      });
    const results = await Promise.allSettled([open(T1), open(T2)]);
    expect(counts(results)).toEqual([0, 1]);
    const winner =
      results[0].status === 'fulfilled' && results[0].value.count === 1
        ? T1
        : T2;
    expect((await stamps(id)).openedAt).toEqual(winner);

    expect(await open(T3)).toEqual({ count: 0 });
    expect((await stamps(id)).openedAt).toEqual(winner);
  });

  it('two revokes at once: the first stamp stays', async () => {
    const id = await handoff();
    const revoke = (revokedAt: Date) =>
      handoffs.revokeHandoff({
        organizationId: ORG_A,
        userId: USER_A,
        id,
        revokedAt,
      });
    const results = await Promise.allSettled([revoke(T1), revoke(T2)]);
    expect(counts(results)).toEqual([0, 1]);
    const winner =
      results[0].status === 'fulfilled' && results[0].value.count === 1
        ? T1
        : T2;
    expect((await stamps(id)).revokedAt).toEqual(winner);

    expect(await revoke(T3)).toEqual({ count: 0 });
    expect((await stamps(id)).revokedAt).toEqual(winner);
  });
});

describe('unique keys enforced by PostgreSQL', () => {
  it('a revision number is unique per package, not across packages', async () => {
    const first = await createPackage(ORG_A);
    await insertRevision(ORG_A, first, 1);
    expect(await prismaCode(insertRevision(ORG_A, first, 1))).toBe('P2002');

    const second = await createPackage(ORG_A);
    await insertRevision(ORG_A, second, 1);
    expect(await revisionsOf(first)).toHaveLength(1);
    expect(await revisionsOf(second)).toHaveLength(1);
  });

  it('a handoff id is unique', async () => {
    const a = await packageWithRevision(ORG_A);
    const id = newHandoffId();
    await createHandoff(ORG_A, a.packageId, a.revisionId, id);
    expect(
      await prismaCode(createHandoff(ORG_A, a.packageId, a.revisionId, id))
    ).toBe('P2002');
    expect(await client.contentStudioHandoff.count({ where: { id } })).toBe(1);
  });
});

describe('revision immutability boundary', () => {
  const ALLOWED_REVISION_METHODS = [
    'countRevisionsForPackage',
    'createRevisionWithCompareAndSwap',
    'getLatestRevisionForPackage',
    'getRevisionForPackage',
    'listRevisionsForPackage',
  ];

  it('later repository operations never change an earlier revision', async () => {
    const packageId = await createPackage(ORG_A, { draftVersion: 5 });
    const first = await revisionCas(ORG_A, packageId, 5, 0);
    if (!first.created) {
      throw new Error('revision #1 was not created');
    }
    const snapshot = await client.contentPackageRevision.findUniqueOrThrow({
      where: { id: first.revision.id },
    });

    expect(
      await repository.saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 5,
        draft: draftJson('edited after revision #1'),
      })
    ).toEqual({ count: 1 });
    const second = await revisionCas(ORG_A, packageId, 6, 1);
    expect(second.created && second.revision.revisionNumber).toBe(2);
    const { id } = await createHandoff(ORG_A, packageId, first.revision.id);
    const scope = { organizationId: ORG_A, userId: USER_A, id };
    await handoffs.markOpenedIfNeeded({ ...scope, openedAt: new Date() });
    await handoffs.revokeHandoff({ ...scope, revokedAt: new Date() });
    await repository.archivePackage(ORG_A, packageId, new Date());
    await repository.restorePackage(ORG_A, packageId);

    const after = await client.contentPackageRevision.findUniqueOrThrow({
      where: { id: first.revision.id },
    });
    expect(after).toEqual(snapshot);
    for (const field of [
      'content',
      'contentHash',
      'schemaVersion',
      'revisionNumber',
      'sourceDraftVersion',
      'origin',
      'createdById',
      'createdAt',
    ] as const) {
      expect(after[field]).toEqual(snapshot[field]);
    }
  });

  it('the repositories offer no way to change or remove a revision or handoff', () => {
    const methods = (prototype: object) =>
      Object.getOwnPropertyNames(prototype).filter((m) => m !== 'constructor');
    const content = methods(ContentStudioRepository.prototype);
    for (const forbidden of [
      'updateRevision',
      'deleteRevision',
      'archiveRevision',
      'restoreRevision',
      'upsertRevision',
    ]) {
      expect(content).not.toContain(forbidden);
    }
    expect(content.filter((m) => /revision/i.test(m)).sort()).toEqual(
      ALLOWED_REVISION_METHODS
    );
    expect(methods(ContentStudioHandoffRepository.prototype).sort()).toEqual([
      'createHandoff',
      'getHandoffForOrganizationAndUser',
      'markOpenedIfNeeded',
      'revokeHandoff',
    ]);
  });

  it('DOCUMENTED: PostgreSQL itself does not block a direct revision update (no trigger)', async () => {
    const packageId = await createPackage(ORG_A);
    const { id } = await insertRevision(ORG_A, packageId, 1);
    await client.contentPackageRevision.update({
      where: { id },
      data: { origin: 'handoff' },
    });
    expect(
      (
        await client.contentPackageRevision.findUniqueOrThrow({
          where: { id },
          select: { origin: true },
        })
      ).origin
    ).toBe('handoff');
  });
});
