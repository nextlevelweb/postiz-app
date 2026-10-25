import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import type { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import type { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import type { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import type { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import type { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import type { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { ContentStudioAIResolutionError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextResult } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { parseContentStudioAIOperationContext } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  ContentStudioSourceVersionData,
  parseContentStudioSourceVersionInput,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// the package service's Media and handoff imports, never used here
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: jest.fn(),
}));

// Research into content (P8-03) on a real PostgreSQL: the Source list's
// search (Prisma contains, any case) with its organization scope, and AI
// writing reading the current version of a chosen source when it runs, never
// earlier, with the exact version kept by the suggestion, the draft and the
// revision. Opt-in: runs only through jest.content-studio.integration.config.ts
// against the disposable local database. The services and repositories run
// unchanged; Prisma is used directly only for fixtures and for rows that
// bypass the application on purpose. No network: the AI adapter is a fake

const ORG_A = '30830000-0000-4000-8000-00000000000a';
const ORG_B = '30830000-0000-4000-8000-00000000000b';
const USER_A = '30830000-0000-4000-8000-0000000000a1';
const USER_B = '30830000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };
const T1 = new Date('2026-10-01T10:00:00.000Z');

let client: PrismaClient;
let prisma: PrismaService;
let packages: ContentStudioRepository;
let connections: ContentStudioAIConnectionRepository;
let operations: ContentStudioAIOperationRepository;
let sources: ContentStudioSourceRepository;
let sourceService: ContentStudioSourceService;
let packageService: ContentStudioService;
let profileRepositories: {
  writing: ContentStudioWritingProfileRepository;
  editorial: ContentStudioEditorialPolicyRepository;
  audience: ContentStudioAudienceProfileRepository;
  expertise: ContentStudioExpertiseProfileRepository;
};

// --- sources ---
let n = 0;
const source = async (
  organizationId: string,
  over: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
) => {
  n += 1;
  return (
    await client.contentStudioSource.create({
      data: {
        organizationId,
        kind: 'url',
        name: `Found page ${n}`,
        canonicalUrl: `https://news.example/found-${n}`,
        createdById: OWNER[organizationId],
        ...over,
      },
      select: { id: true },
    })
  ).id;
};
// the capture ingestion appends after its fetch, parsed by the same function
const capture = (text: string): ContentStudioSourceVersionData =>
  parseContentStudioSourceVersionInput({
    requestedUrl: 'https://research.example/brief',
    finalUrl: 'https://research.example/brief',
    redirectCount: 0,
    fetchedAt: T1,
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    contentLength: 2048,
    title: `Brief: ${text}`,
    sourceHash: null,
    extractionVersion: 'content-studio-source-v2',
    content: {
      schemaVersion: 1,
      blocks: [
        { id: 'h1', type: 'heading', text: 'Outlook', level: 1 },
        { id: 'p1', type: 'paragraph', text, level: null },
      ],
    },
  });
// the next version, through the same compare-and-swap a capture uses
const append = async (
  organizationId: string,
  sourceId: string,
  text: string,
  repository = sources
) => {
  const row = await client.contentStudioSource.findUniqueOrThrow({
    where: { id: sourceId },
  });
  const result = await repository.appendVersionWithCompareAndSwap({
    organizationId,
    sourceId,
    expectedLatestVersionNumber: row.latestVersionNumber,
    versionId: randomUUID(),
    version: capture(text),
    createdById: OWNER[organizationId],
    validators: { mode: 'replace', etag: null, lastModified: null },
  });
  if (result.status !== 'created') {
    throw new Error(`fixture capture failed: ${result.status}`);
  }
  return result.version;
};
const search = (
  input: Partial<Parameters<ContentStudioSourceService['listSources']>[0]> = {}
) =>
  sourceService.listSources({
    organizationId: ORG_A,
    archived: false,
    page: 1,
    ...input,
  });
const names = (value: { results: Array<{ name: string }> }) =>
  value.results.map((row) => row.name);

// --- AI writing with a fake adapter ---
const draftJson = (text: string) =>
  JSON.stringify(
    parseContentPackageDraft({
      schemaVersion: 1,
      copy: { global: { thread: [{ id: 'main', text, mediaIds: [] }] } },
    })
  );
const createPackage = async (organizationId: string) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P803 package',
        draft: draftJson('Spring outlook'),
        draftVersion: 1,
        latestRevisionNumber: 0,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;
const createConnection = async (organizationId: string) =>
  (
    await client.contentStudioAIConnection.create({
      data: {
        organizationId,
        name: 'P803 connection',
        provider: 'openai',
        sealedCredential: 'sb1.placeholder.not-a-real-envelope',
        defaultModel: 'gpt-6.1-sol',
        credentialUpdatedAt: T1,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;
const answer = (text: string): ContentStudioAITextResult => ({
  text,
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 40 },
  providerRequestId: 'req_p803_fake',
});
// a grounded rewrite: one claim on the second block of the first source
const grounded = () =>
  answer(
    JSON.stringify({
      text: 'The outlook improved.',
      claims: [
        {
          text: 'The outlook improved.',
          evidence: [{ ref: 'S1-B2', quote: null }],
        },
      ],
    })
  );
const fakeResolver = () => {
  const adapter = {
    provider: 'openai' as const,
    validateConnection: jest.fn(),
    generateText: jest.fn(async () => grounded()),
  };
  const resolver = {
    resolve: jest.fn(
      async (where: { organizationId: string; connectionId: string }) => {
        const row = await connections.getSealedCredentialForResolver(
          where.organizationId,
          where.connectionId
        );
        if (!row) {
          throw new ContentStudioAIResolutionError('NOT_FOUND');
        }
        return { connectionId: row.id, provider: 'openai' as const, adapter };
      }
    ),
  };
  return { adapter, resolver };
};
const writing = (repository: ContentStudioSourceRepository = sources) =>
  new ContentStudioAIWritingService(
    packages,
    profileRepositories.writing,
    profileRepositories.editorial,
    profileRepositories.audience,
    profileRepositories.expertise,
    new ContentStudioAIExecutionService(
      packages,
      fakeResolver().resolver as unknown as ContentStudioAIProviderResolver,
      operations
    ),
    repository
  );
const propose = async (
  sourceIds: string[],
  repository: ContentStudioSourceRepository = sources
) => {
  const packageId = await createPackage(ORG_A);
  const connectionId = await createConnection(ORG_A);
  const value = await writing(repository).proposeItem({
    organizationId: ORG_A,
    userId: USER_A,
    packageId,
    operation: 'rewrite_item',
    itemId: 'main',
    selection: {
      connectionId,
      model: 'gpt-6.1-sol',
      baseDraftVersion: 1,
      sourceIds,
    },
  });
  return { packageId, value };
};
const storedContext = async (operationId: string) =>
  parseContentStudioAIOperationContext(
    (
      await client.contentStudioAIOperation.findUniqueOrThrow({
        where: { id: operationId },
      })
    ).context
  );
// the editor accepts the suggestion: its text and its claims, one save
const accept = (
  packageId: string,
  value: Awaited<ReturnType<typeof propose>>['value']
) =>
  packageService.saveDraft({
    organizationId: ORG_A,
    packageId,
    baseDraftVersion: 1,
    draft: {
      schemaVersion: 2,
      copy: {
        global: {
          thread: [
            {
              id: 'main',
              text: (value.proposal as { text: string }).text,
              mediaIds: [],
            },
          ],
        },
      },
      grounding: { claims: value.grounding!.claims },
    },
  });

const refusal = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const body = (err as HttpException).getResponse() as Record<string, unknown>;
  expect(JSON.stringify(body)).not.toMatch(
    /P20\d\d|[Cc]onstraint|[Pp]risma|\bSELECT\b|"ContentStudio|research\.example/
  );
  return { status: (err as HttpException).getStatus(), ...body } as {
    status: number;
    code?: unknown;
    msg?: unknown;
  };
};

const cleanHandoff = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentStudioAIUsage.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentStudioAIConnection.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
  await client.contentStudioSourceCaptureAttempt.deleteMany({ where });
  await client.contentStudioSourceDiscovery.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await cleanHandoff();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: USERS } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  prisma = client as unknown as PrismaService;
  const transaction = new PrismaTransaction(prisma);
  packages = new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(prisma),
    new PrismaRepository<'contentPackage'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    transaction
  );
  connections = new ContentStudioAIConnectionRepository(
    new PrismaRepository<'contentStudioAIConnection'>(prisma)
  );
  operations = new ContentStudioAIOperationRepository(
    new PrismaRepository<'contentStudioAIOperation'>(prisma),
    transaction
  );
  profileRepositories = {
    writing: new ContentStudioWritingProfileRepository(
      new PrismaRepository<'contentStudioWritingProfile'>(prisma),
      new PrismaRepository<'contentStudioWritingProfileRevision'>(prisma),
      transaction
    ),
    editorial: new ContentStudioEditorialPolicyRepository(
      new PrismaRepository<'contentStudioEditorialPolicy'>(prisma),
      new PrismaRepository<'contentStudioEditorialPolicyRevision'>(prisma),
      transaction
    ),
    audience: new ContentStudioAudienceProfileRepository(
      new PrismaRepository<'contentStudioAudienceProfile'>(prisma),
      new PrismaRepository<'contentStudioAudienceProfileRevision'>(prisma),
      transaction
    ),
    expertise: new ContentStudioExpertiseProfileRepository(
      new PrismaRepository<'contentStudioExpertiseProfile'>(prisma),
      new PrismaRepository<'contentStudioExpertiseProfileRevision'>(prisma),
      transaction
    ),
  };
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  sourceService = new ContentStudioSourceService(
    sources,
    new ContentStudioSourceDiscoveryRepository(
      new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
    ),
    new ContentStudioSourceCaptureAttemptRepository(
      new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
    )
  );
  // saving a draft and making a revision need the grounding check only
  packageService = new ContentStudioService(
    packages,
    {} as ContentStudioMediaService,
    new ContentStudioGroundingService(sources),
    {} as ContentStudioReviewService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioDesignService,
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignPageSetService
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P803 ${id}` } });
  }
  for (const [user, org] of [
    [USER_A, ORG_A],
    [USER_B, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p803.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P803 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanHandoff();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('Source search on PostgreSQL', () => {
  it('P803PG1 a curated source behind 59 newer ones, 40 of them recaptured, is found by name and by address', async () => {
    const curated = await source(ORG_A, {
      name: 'Curated Quarterly Brief',
      canonicalUrl: 'https://research.example/briefs/q3-outlook',
    });
    await append(ORG_A, curated, 'Curated first capture');
    const found: string[] = [];
    for (let i = 0; i < 59; i++) {
      found.push(await source(ORG_A));
    }
    // feed churn: 40 pages captured again, each bumping updatedAt
    for (const id of found.slice(0, 40)) {
      await append(ORG_A, id, `capture of ${id}`);
    }
    const all = [
      ...(await search({ page: 1 })).results,
      ...(await search({ page: 2 })).results,
      ...(await search({ page: 3 })).results,
    ].map((row) => row.id);
    expect(all).toHaveLength(60);
    // beyond row 50 of the list every picker used to read 20 of
    expect(all.indexOf(curated)).toBeGreaterThanOrEqual(50);
    for (const text of [
      'Curated Quarterly',
      'curated quarterly',
      'QUARTERLY BRIEF',
    ]) {
      const byName = await search({ search: text, kind: 'url' });
      expect(byName.results.map((row) => row.id)).toEqual([curated]);
      expect(byName.pages).toBe(1);
    }
    for (const text of [
      'q3-outlook',
      'research.example/briefs',
      'Q3-OUTLOOK',
    ]) {
      expect(
        (await search({ search: text })).results.map((row) => row.id)
      ).toEqual([curated]);
    }
    // a page of a search, 20 at a time, in the list's order
    const page2 = await search({ search: 'found page', page: 2 });
    expect(page2.pages).toBe(3);
    expect(page2.results).toHaveLength(20);
  });

  it('P803PG2 the same address and name in two organizations: each sees and counts its own only', async () => {
    const mine = await source(ORG_A, {
      name: 'Shared Market Outlook',
      canonicalUrl: 'https://research.example/shared',
    });
    const theirs = await source(ORG_B, {
      name: 'Shared Market Outlook',
      canonicalUrl: 'https://research.example/shared',
    });
    // 20 more in the other organization: a list or a count that leaked
    // across organizations would show them or a second page
    for (let i = 0; i < 20; i++) {
      await source(ORG_B, {
        name: `Shared Market Outlook ${i}`,
        canonicalUrl: `https://research.example/shared/${i}`,
      });
    }
    for (const text of ['shared market', 'research.example/shared']) {
      const value = await search({ search: text });
      expect(value.results.map((row) => row.id)).toEqual([mine]);
      expect(value.pages).toBe(1);
      const other = await search({ search: text, organizationId: ORG_B });
      expect(other.results).toHaveLength(20);
      expect(other.pages).toBe(2);
      expect(other.results.map((row) => row.id)).not.toContain(mine);
      expect(
        [
          ...other.results,
          ...(await search({ search: text, organizationId: ORG_B, page: 2 }))
            .results,
        ].map((row) => row.id)
      ).toContain(theirs);
    }
    // another organization's source is no source here, by id either
    expect((await refusal(sourceService.getSource(ORG_A, theirs))).status).toBe(
      404
    );
  });

  it('P803PG3 a feed named like a page is left out with kind=url, and AI writing refuses it', async () => {
    const page = await source(ORG_A, {
      name: 'Quarterly brief',
      canonicalUrl: 'https://research.example/q-brief',
    });
    await append(ORG_A, page, 'The page itself');
    const feed = await source(ORG_A, {
      kind: 'feed',
      name: 'Quarterly brief feed',
      canonicalUrl: 'https://research.example/q-brief.xml',
    });
    expect(
      (await search({ search: 'quarterly brief', kind: 'url' })).results.map(
        (row) => row.id
      )
    ).toEqual([page]);
    expect(
      (await search({ search: 'quarterly brief' })).results
        .map((row) => row.id)
        .sort()
    ).toEqual([page, feed].sort());
    expect(await refusal(propose([feed]))).toEqual({
      status: 400,
      code: 'CS_AI_SOURCE_NOT_READY',
      msg: 'A selected source has not been ingested yet.',
    });
    // even a feed that somehow holds a version is no source material
    await client.contentStudioSource.update({
      where: { id: feed },
      data: { latestVersionNumber: 1 },
    });
    const data = capture('Feed text that is never source material');
    await client.contentStudioSourceVersion.create({
      data: {
        ...data,
        id: randomUUID(),
        organizationId: ORG_A,
        sourceId: feed,
        versionNumber: 1,
        createdById: USER_A,
      },
    });
    expect((await refusal(propose([feed]))).code).toBe(
      'CS_AI_SOURCE_NOT_READY'
    );
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: ORG_A, status: 'SUCCEEDED' },
      })
    ).toBe(0);
  });

  // measured: Prisma's contains passes % and _ to ILIKE as wildcards and \
  // as its escape; the repository escapes them, so they are plain text
  it('P803PG6 % _ and \\ are plain text, escaped for ILIKE', async () => {
    const percent = await source(ORG_A, { name: 'Growth 100% organic' });
    await source(ORG_A, { name: 'Growth 1000 organic' });
    const underscore = await source(ORG_A, { name: 'snake_case notes' });
    await source(ORG_A, { name: 'snakeXcase notes' });
    const backslash = await source(ORG_A, { name: 'path a\\b notes' });
    await source(ORG_A, { name: 'path ab notes' });
    expect(
      (await search({ search: '100%' })).results.map((row) => row.id)
    ).toEqual([percent]);
    expect(
      (await search({ search: '%' })).results.map((row) => row.id)
    ).toEqual([percent]);
    expect(
      (await search({ search: 'snake_case' })).results.map((row) => row.id)
    ).toEqual([underscore]);
    expect(
      (await search({ search: '_' })).results.map((row) => row.id)
    ).toEqual([underscore]);
    expect(
      (await search({ search: 'a\\b' })).results.map((row) => row.id)
    ).toEqual([backslash]);
    expect(names(await search({ search: "'; DROP TABLE" }))).toEqual([]);
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(6);
  });

  it('P803PG7 a search only reads', async () => {
    for (let i = 0; i < 5; i++) {
      await append(ORG_A, await source(ORG_A), `page ${i}`);
    }
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          client.contentStudioSource.findMany({
            where: { organizationId: { in: ORGS } },
            orderBy: { id: 'asc' },
          }),
          client.contentStudioSourceVersion.findMany({
            where: { organizationId: { in: ORGS } },
            orderBy: { id: 'asc' },
          }),
        ])
      );
    const before = await snapshot();
    await search({ search: 'found' });
    await search({ search: 'FOUND', kind: 'url', page: 2 });
    await search({ search: 'nothing', archived: true });
    expect(await snapshot()).toBe(before);
  });
});

describe('Research sources in AI writing on PostgreSQL: the version is read when Generate runs', () => {
  it('P803PG4 v2 captured before Generate is used; v3 after the suggestion changes nothing it, the draft or the revision hold', async () => {
    const id = await source(ORG_A, { name: 'Research brief' });
    const v1 = await append(ORG_A, id, 'Version one says the outlook held.');
    // the source is chosen here (an id only); a capture adds v2 before Generate
    const v2 = await append(
      ORG_A,
      id,
      'Version two says the outlook improved.'
    );
    const { packageId, value } = await propose([id]);
    const ref = {
      sourceId: id,
      versionId: v2.id,
      versionNumber: 2,
      contentHash: v2.contentHash,
    };
    expect((await storedContext(value.operationId))!.sources).toEqual([ref]);
    expect(value.provenance.sources).toEqual([
      { ...ref, name: 'Research brief', title: v2.title },
    ]);
    expect(value.grounding!.claims[0].evidence).toEqual([
      { ...ref, blockId: 'p1', quote: null },
    ]);
    // a capture after the suggestion
    const v3 = await append(ORG_A, id, 'Version three says it worsened.');
    expect(v3.versionNumber).toBe(3);
    await accept(packageId, value);
    const revision = await packageService.createRevision({
      organizationId: ORG_A,
      packageId,
      userId: USER_A,
      draftVersion: 2,
    });
    const stored = await client.contentPackageRevision.findUniqueOrThrow({
      where: { id: revision.revision.id },
    });
    const content = JSON.parse(stored.content);
    expect(content.grounding.claims[0].evidence).toEqual([
      { ...ref, blockId: 'p1', quote: null },
    ]);
    expect(stored.content).not.toContain(v3.id);
    expect(stored.content).not.toContain(v1.id);
    // the operation still says v2, and v2 is still exactly what was stored
    expect((await storedContext(value.operationId))!.sources).toEqual([ref]);
    const version = await client.contentStudioSourceVersion.findUniqueOrThrow({
      where: { id: v2.id },
    });
    expect([version.versionNumber, version.contentHash]).toEqual([
      2,
      v2.contentHash,
    ]);
  });

  it('P803PG4 a capture after the server read the source does not tear the run: it uses that exact version', async () => {
    const id = await source(ORG_A, { name: 'Racing brief' });
    const v1 = await append(ORG_A, id, 'Version one, read by the run.');
    // the repository as the service uses it, with a capture landing right
    // after the source row is read
    const racing = Object.create(sources) as ContentStudioSourceRepository;
    racing.getSourceForOrganization = ((
      organizationId: string,
      sourceId: string
    ) =>
      sources
        .getSourceForOrganization(organizationId, sourceId)
        .then(async (row) => {
          await append(ORG_A, id, 'Version two, captured meanwhile.');
          return row;
        })) as unknown as ContentStudioSourceRepository['getSourceForOrganization'];
    const { value } = await propose([id], racing);
    const ref = {
      sourceId: id,
      versionId: v1.id,
      versionNumber: 1,
      contentHash: v1.contentHash,
    };
    expect((await storedContext(value.operationId))!.sources).toEqual([ref]);
    expect(value.grounding!.claims[0].evidence).toEqual([
      { ...ref, blockId: 'p1', quote: null },
    ]);
    expect(
      (await client.contentStudioSource.findUniqueOrThrow({ where: { id } }))
        .latestVersionNumber
    ).toBe(2);
  });

  it('P803PG5 an archived source: not in an active search, refused by AI writing, and its earlier evidence still verifies', async () => {
    const id = await source(ORG_A, { name: 'Archived research brief' });
    await append(ORG_A, id, 'The archived page said the outlook improved.');
    const { packageId, value } = await propose([id]);
    await sourceService.archiveSource(ORG_A, id);
    expect(names(await search({ search: 'archived research' }))).toEqual([]);
    expect(
      names(await search({ search: 'archived research', archived: true }))
    ).toEqual(['Archived research brief']);
    expect(await refusal(propose([id]))).toEqual({
      status: 409,
      code: 'CS_AI_SOURCE_ARCHIVED',
      msg: 'A selected source is archived.',
    });
    // the suggestion made before the archive is saved with its evidence
    expect(await accept(packageId, value)).toEqual({ draftVersion: 2 });
    const revision = await packageService.createRevision({
      organizationId: ORG_A,
      packageId,
      userId: USER_A,
      draftVersion: 2,
    });
    expect(revision.created).toBe(true);
  });
});
