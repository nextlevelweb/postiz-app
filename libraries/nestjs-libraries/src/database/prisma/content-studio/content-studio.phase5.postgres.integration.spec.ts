import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioReviewRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.repository';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { parseContentStudioSourceVersionInput } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { emptyContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';

// P5-07: the handoff runs here too. The real MediaService pulls in uploads,
// Redis and Temporal at import time and the sanitizer needs a DOM; a handoff
// is only created here, of revisions without Media
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: jest.fn(),
}));

// Phase 5 on a real PostgreSQL (P5-04): reviews, their claim review and
// approval decisions under real concurrent transactions, (P5-05) the
// approval binding of exact revisions read through the real queries, and
// (P5-06) the Review & Approval queue: its filters, names and pages, and
// (P5-07) the handoff of a revision where the policy requires approval,
// racing a withdrawal on the review row. Opt-in: runs only
// through jest.content-studio.integration.config.ts against the disposable
// local database (see jest.content-studio.postgres.guard.ts). The review
// repository and service run unchanged on real Prisma; Prisma is used
// directly only to build fixtures, read final state and bypass the service
// on purpose, to prove what the database itself enforces and what only the
// application does.
//
// Concurrency is ordered with promise barriers placed in the transaction the
// repository is given (a test object, not a production hook): both requests
// are inside their own transactions, right before the statement that holds
// the review row, when the barrier opens. Who wins is never timed: races are
// judged by their final state and every outcome both orders allow is checked

const ORG_A = '50400000-0000-4000-8000-00000000000a';
const ORG_B = '50400000-0000-4000-8000-00000000000b';
const USER_A1 = '50400000-0000-4000-8000-0000000000a1';
const USER_A2 = '50400000-0000-4000-8000-0000000000a2';
const USER_B1 = '50400000-0000-4000-8000-0000000000b1';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A1, USER_A2, USER_B1];
const OWNER: Record<string, string> = { [ORG_A]: USER_A1, [ORG_B]: USER_B1 };
const REFUSAL = 'Legal has not cleared the offer.';
const WITHDRAWAL = 'Decided too early.';
const C1 = 'c_p504claim0000001';
const C2 = 'c_p504claim0000002';

let client: PrismaClient;
let prisma: PrismaService;
let sources: ContentStudioSourceRepository;
let service: ContentStudioReviewService;

// --- barriers: no sleeps. A latch opens once `parties` callers arrived; the
// timer only turns a deadlock into a failure, it never orders anything ---
const latch = (parties: number) => {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      open();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      opened,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('barrier not reached: deadlock')),
          4000
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
};

const repositoryWith = (transaction: PrismaTransaction) =>
  new ContentStudioReviewRepository(
    new PrismaRepository<'contentStudioReview'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    new PrismaRepository<'contentStudioDesignRevision'>(prisma),
    new PrismaRepository<'contentStudioReviewComment'>(prisma),
    new PrismaRepository<'contentStudioReviewRevisionRequest'>(prisma),
    new PrismaRepository<'contentStudioReviewClaim'>(prisma),
    new PrismaRepository<'contentStudioApproval'>(prisma),
    transaction
  );

// A transaction that runs on the real client, with `hooks[model.method]`
// awaited right before that call inside it. Counts every call of a hooked
// method that was attempted. Everything else is the real client
const hookedTransaction = (hooks: Record<string, () => Promise<void>>) => {
  const calls: Record<string, number> = {};
  const transaction = {
    model: {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        client.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, model, receiver) {
                const value = Reflect.get(target, model, receiver);
                if (typeof model !== 'string' || !value) {
                  return value;
                }
                return new Proxy(value, {
                  get(delegate, method, delegateReceiver) {
                    const original = Reflect.get(
                      delegate,
                      method,
                      delegateReceiver
                    );
                    const key = `${model}.${String(method)}`;
                    if (typeof original !== 'function') {
                      return original;
                    }
                    return async (args: unknown) => {
                      calls[key] = (calls[key] ?? 0) + 1;
                      await hooks[key]?.();
                      return original.call(delegate, args);
                    };
                  },
                });
              },
            })
          )
        ),
    },
  } as unknown as PrismaTransaction;
  return { transaction, calls };
};

// A review service whose repository runs every transaction hooked as above
const hookedService = (hooks: Record<string, () => Promise<void>>) => {
  const { transaction, calls } = hookedTransaction(hooks);
  const repository = repositoryWith(transaction);
  return {
    repository,
    service: new ContentStudioReviewService(
      repository,
      new ContentStudioGroundingService(sources)
    ),
    calls,
  };
};

// Both requests reach the statement that holds the review row inside their
// transactions before either runs it
const atHold = () => {
  const both = latch(2);
  return () =>
    hookedService({ 'contentStudioReview.updateMany': () => both() });
};

const codeOf = (err: unknown) =>
  err instanceof HttpException
    ? ((err.getResponse() as { code: string }).code as string)
    : `UNEXPECTED ${String(err)}`;
const outcome = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return codeOf(err);
  }
};
const failure = async (promise: Promise<unknown>) => {
  const result = await outcome(promise);
  expect(result).not.toBe('ok');
  return result;
};

// --- fixtures ---
const hashOf = (text: string) =>
  createHash('sha256').update(text).digest('hex');

const packageRevisionData = (
  organizationId: string,
  draft: unknown,
  packageId: string,
  revisionNumber: number
) => {
  const parsed = parseContentPackageDraft(draft);
  const content = canonicalJson(parsed);
  return {
    organizationId,
    packageId,
    revisionNumber,
    schemaVersion: parsed.schemaVersion,
    content,
    contentHash: sha256Hex(content),
    origin: 'manual',
    sourceDraftVersion: 1,
    createdById: OWNER[organizationId],
  };
};

const createPackage = async (organizationId = ORG_A) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P504 package',
        draft: JSON.stringify(
          parseContentPackageDraft({
            schemaVersion: 1,
            copy: {
              global: { thread: [{ id: 'main', text: '', mediaIds: [] }] },
            },
          })
        ),
        latestRevisionNumber: 3,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

// A v1 revision: no claims
const packageRevision = async (
  organizationId = ORG_A,
  text = 'Spring sale',
  revisionNumber = 1,
  packageId?: string
) =>
  await client.contentPackageRevision.create({
    data: packageRevisionData(
      organizationId,
      {
        schemaVersion: 1,
        copy: { global: { thread: [{ id: 'main', text, mediaIds: [] }] } },
      },
      packageId ?? (await createPackage(organizationId)),
      revisionNumber
    ),
    select: { id: true, contentHash: true },
  });

// A captured source version, appended through the real repository
const sourceVersion = async (organizationId = ORG_A) => {
  const sourceId = (
    await sources.createSource({
      id: randomUUID(),
      organizationId,
      kind: 'url',
      name: 'P504 report',
      canonicalUrl: `https://example.com/${randomUUID()}`,
      createdById: OWNER[organizationId],
    })
  ).id;
  const result = await sources.appendVersionWithCompareAndSwap({
    organizationId,
    sourceId,
    expectedLatestVersionNumber: 0,
    versionId: randomUUID(),
    version: parseContentStudioSourceVersionInput({
      requestedUrl: 'https://example.com/report',
      finalUrl: 'https://example.com/report',
      redirectCount: 0,
      fetchedAt: new Date('2026-10-01T10:00:00.000Z'),
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      contentLength: 1024,
      title: 'Annual report',
      sourceHash: hashOf(randomUUID()),
      extractionVersion: 'content-studio-source-v2',
      content: {
        schemaVersion: 1,
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'Sales grew by ten percent.',
            level: null,
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'The outlook is stable.',
            level: null,
          },
        ],
      },
    }),
    createdById: OWNER[organizationId],
  });
  if (result.status !== 'created') {
    throw new Error('fixture capture failed');
  }
  return { ...result.version, sourceId };
};

// A v2 revision with two grounded claims on one stored source version
const groundedRevision = async (organizationId = ORG_A) => {
  const version = await sourceVersion(organizationId);
  const evidence = (blockId: string, quote: string | null) => ({
    sourceId: version.sourceId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    contentHash: version.contentHash,
    blockId,
    quote,
  });
  return client.contentPackageRevision.create({
    data: packageRevisionData(
      organizationId,
      {
        schemaVersion: 2,
        copy: {
          global: {
            thread: [{ id: 'main', text: 'Sales grew.', mediaIds: [] }],
          },
        },
        grounding: {
          claims: [
            {
              id: C1,
              threadItemId: 'main',
              text: 'Sales grew by ten percent.',
              evidence: [evidence('p1', 'grew by ten percent')],
            },
            {
              id: C2,
              threadItemId: 'main',
              text: 'The outlook is stable.',
              evidence: [evidence('p2', null)],
            },
          ],
        },
      },
      await createPackage(organizationId),
      1
    ),
    select: { id: true, contentHash: true },
  });
};

const designRevision = async (organizationId = ORG_A) => {
  const project = await client.contentStudioDesignProject.create({
    data: {
      organizationId,
      name: 'P504 design',
      latestRevisionNumber: 1,
      createdById: OWNER[organizationId],
    },
    select: { id: true },
  });
  return client.contentStudioDesignRevision.create({
    data: {
      organizationId,
      designProjectId: project.id,
      revisionNumber: 1,
      ...storedContentStudioDesignDocument(
        parseContentStudioDesignDocument({
          schemaVersion: 1,
          brandKit: null,
          pages: [
            {
              id: 'cover',
              name: 'Cover',
              width: 1080,
              height: 1350,
              background: {
                type: 'solid',
                color: { type: 'literal', value: '#ffffff' },
              },
              layers: [],
            },
          ],
        })
      ),
      createdById: OWNER[organizationId],
    },
    select: { id: true, contentHash: true },
  });
};

const as = (organizationId: string, userId: string) => ({
  organizationId,
  userId,
});
const A1 = as(ORG_A, USER_A1);
const A2 = as(ORG_A, USER_A2);

const requestReview = (targetType: string, targetRevisionId: string) =>
  service.requestReview({ ...A1, targetType, targetRevisionId });
const move = (
  id: string,
  action: 'start' | 'ready-for-approval' | 'cancel',
  on = service
) => on.transitionReview({ ...A1, id, action });

// A review of a fresh revision, moved on to IN_REVIEW or READY_FOR_APPROVAL
const reviewOf = async (
  kind: 'package' | 'design' | 'grounded',
  until: 'IN_REVIEW' | 'READY_FOR_APPROVAL' = 'READY_FOR_APPROVAL'
) => {
  const revision =
    kind === 'design'
      ? await designRevision()
      : kind === 'grounded'
      ? await groundedRevision()
      : await packageRevision();
  const review = await requestReview(
    kind === 'design' ? 'DESIGN_REVISION' : 'PACKAGE_REVISION',
    revision.id
  );
  await move(review.id, 'start');
  if (kind === 'grounded' && until === 'READY_FOR_APPROVAL') {
    for (const claimId of [C1, C2]) {
      await service.assessClaim({
        ...A2,
        reviewId: review.id,
        claimId,
        status: 'VERIFIED',
        finding: null,
      });
    }
  }
  if (until === 'READY_FOR_APPROVAL') {
    await move(review.id, 'ready-for-approval');
  }
  return { reviewId: review.id, revision };
};

const decide = (
  reviewId: string,
  action: 'approve' | 'refuse' | 'withdraw',
  on = service,
  actor = A2
) =>
  on.decideApproval({
    ...actor,
    reviewId,
    action,
    note:
      action === 'approve' ? null : action === 'refuse' ? REFUSAL : WITHDRAWAL,
  });

const approvalRows = (reviewId: string) =>
  client.contentStudioApproval.findMany({
    where: { reviewId },
    orderBy: { sequence: 'asc' },
  });
const reviewState = (id: string) =>
  client.contentStudioReview.findUniqueOrThrow({
    where: { id },
    select: { state: true, version: true, updatedAt: true },
  });
const eventsOf = (reviewId: string) =>
  client.contentStudioReviewStateEvent.findMany({
    where: { reviewId },
    orderBy: { sequence: 'asc' },
  });

const cleanPhase5 = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioHandoff.deleteMany({ where });
  await client.contentStudioEditorialPolicyRevision.deleteMany({ where });
  await client.contentStudioEditorialPolicy.deleteMany({ where });
  await client.contentStudioApproval.deleteMany({ where });
  await client.contentStudioReviewClaim.deleteMany({ where });
  await client.contentStudioReviewRevisionRequest.deleteMany({ where });
  await client.contentStudioReviewComment.deleteMany({ where });
  await client.contentStudioReviewStateEvent.deleteMany({ where });
  await client.contentStudioReview.deleteMany({ where });
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
  await client.contentStudioDesignRevision.deleteMany({ where });
  await client.contentStudioDesignProject.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};

const cleanFixtures = async () => {
  await cleanPhase5();
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
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaTransaction(prisma)
  );
  service = new ContentStudioReviewService(
    repositoryWith(new PrismaTransaction(prisma)),
    new ContentStudioGroundingService(sources)
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P504 ${id}` } });
  }
  // ordinary members: nothing here needs a manager or approver role
  for (const [user, org] of [
    [USER_A1, ORG_A],
    [USER_A2, ORG_A],
    [USER_B1, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p504.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P504 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanPhase5();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

// ============================================================================
describe('PG1-PG4. Reviews and claim review under real concurrency', () => {
  it('PG1 two simultaneous review requests for one revision: exactly one review and one initial event', async () => {
    const revision = await packageRevision();
    const both = latch(2);
    const hooks = { 'contentStudioReview.create': () => both() };
    const [first, second] = [hookedService(hooks), hookedService(hooks)];
    const results = await Promise.all(
      [first, second].map((on) =>
        outcome(
          on.service.requestReview({
            ...A1,
            targetType: 'PACKAGE_REVISION',
            targetRevisionId: revision.id,
          })
        )
      )
    );
    expect(results.sort()).toEqual(['CS_REVIEW_ALREADY_EXISTS', 'ok']);
    const reviews = await client.contentStudioReview.findMany({
      where: { packageRevisionId: revision.id },
    });
    expect(reviews).toHaveLength(1);
    expect(await eventsOf(reviews[0].id)).toEqual([
      expect.objectContaining({
        sequence: 1,
        fromState: null,
        toState: 'REQUESTED',
      }),
    ]);
  });

  it('PG2 simultaneous transitions: exactly one compare-and-swap wins and the history stays consistent', async () => {
    for (let round = 0; round < 3; round += 1) {
      const revision = await packageRevision(ORG_A, `PG2 ${round}`);
      const review = await requestReview('PACKAGE_REVISION', revision.id);
      const next = atHold();
      const results = await Promise.all([
        outcome(move(review.id, 'start', next().service)),
        outcome(move(review.id, 'cancel', next().service)),
      ]);
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r !== 'ok')).toEqual(['CS_REVIEW_CONFLICT']);
      const stored = await reviewState(review.id);
      const events = await eventsOf(review.id);
      expect(stored.version).toBe(2);
      expect(events.map((e) => [e.sequence, e.fromState, e.toState])).toEqual([
        [1, null, 'REQUESTED'],
        [2, 'REQUESTED', stored.state],
      ]);
      expect(['IN_REVIEW', 'CANCELLED']).toContain(stored.state);
      expect(results[stored.state === 'IN_REVIEW' ? 0 : 1]).toBe('ok');
    }
  });

  it('PG3 READY_FOR_APPROVAL racing a claim marked NEEDS_REVISION: never ready with a claim that is not verified', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 4; round += 1) {
      const { reviewId } = await reviewOf('grounded', 'IN_REVIEW');
      for (const claimId of [C1, C2]) {
        await service.assessClaim({
          ...A2,
          reviewId,
          claimId,
          status: 'VERIFIED',
          finding: null,
        });
      }
      const next = atHold();
      const [ready, assessed] = await Promise.all([
        outcome(move(reviewId, 'ready-for-approval', next().service)),
        outcome(
          next().service.assessClaim({
            ...A1,
            reviewId,
            claimId: C2,
            status: 'NEEDS_REVISION',
            finding: 'The outlook quote is wrong.',
          })
        ),
      ]);
      const stored = await reviewState(reviewId);
      const c2 = await client.contentStudioReviewClaim.findFirstOrThrow({
        where: { reviewId, claimId: C2 },
      });
      if (ready === 'ok') {
        // READY held the row first: the assessment found it no longer in review
        expect(assessed).toBe('CS_REVIEW_CLAIM_MUTATION_FORBIDDEN');
        expect(stored).toMatchObject({
          state: 'READY_FOR_APPROVAL',
          version: 3,
        });
        expect(c2.status).toBe('VERIFIED');
      } else {
        // the assessment held it first: READY saw it inside its transaction
        expect([ready, assessed]).toEqual([
          'CS_REVIEW_CLAIMS_INCOMPLETE',
          'ok',
        ]);
        expect(stored).toMatchObject({ state: 'IN_REVIEW', version: 2 });
        expect(c2.status).toBe('NEEDS_REVISION');
      }
      seen.add(ready);
      expect(await eventsOf(reviewId)).toHaveLength(stored.version);
    }
    // whichever order PostgreSQL chose, only these two outcomes exist
    expect(
      [...seen].every((r) => ['ok', 'CS_REVIEW_CLAIMS_INCOMPLETE'].includes(r))
    ).toBe(true);
  });

  it("PG3 READY committed between an assessment's read and its transaction: the assessment is refused", async () => {
    const { reviewId } = await reviewOf('grounded', 'IN_REVIEW');
    for (const claimId of [C1, C2]) {
      await service.assessClaim({
        ...A2,
        reviewId,
        claimId,
        status: 'VERIFIED',
        finding: null,
      });
    }
    const late = hookedService({});
    const original = late.repository.setClaimAssessment.bind(late.repository);
    late.repository.setClaimAssessment = async (input) => {
      await move(reviewId, 'ready-for-approval');
      return original(input);
    };
    expect(
      await failure(
        late.service.assessClaim({
          ...A1,
          reviewId,
          claimId: C2,
          status: 'NEEDS_REVISION',
          finding: 'Too late.',
        })
      )
    ).toBe('CS_REVIEW_CLAIM_MUTATION_FORBIDDEN');
    expect(await reviewState(reviewId)).toMatchObject({
      state: 'READY_FOR_APPROVAL',
      version: 3,
    });
    expect(
      (
        await client.contentStudioReviewClaim.findMany({ where: { reviewId } })
      ).map((r) => r.status)
    ).toEqual(['VERIFIED', 'VERIFIED']);
  });

  it('PG4 request-changes racing a claim assessment: serialized on the review row', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { reviewId } = await reviewOf('grounded', 'IN_REVIEW');
      const next = atHold();
      const [changes, assessed] = await Promise.all([
        outcome(
          next().service.requestChanges({
            ...A1,
            id: reviewId,
            body: 'Fix the outlook claim.',
          })
        ),
        outcome(
          next().service.assessClaim({
            ...A2,
            reviewId,
            claimId: C2,
            status: 'NEEDS_REVISION',
            finding: 'Wrong.',
          })
        ),
      ]);
      expect(changes).toBe('ok');
      const rows = await client.contentStudioReviewClaim.findMany({
        where: { reviewId },
      });
      if (assessed === 'ok') {
        // it held the row first: the assessment is part of what was frozen
        expect(rows.map((r) => r.status)).toEqual(['NEEDS_REVISION']);
      } else {
        expect(assessed).toBe('CS_REVIEW_CLAIM_MUTATION_FORBIDDEN');
        expect(rows).toEqual([]);
      }
      expect(await reviewState(reviewId)).toMatchObject({
        state: 'CHANGES_REQUESTED',
        version: 3,
      });
      expect(await eventsOf(reviewId)).toHaveLength(3);
      expect(
        await client.contentStudioReviewRevisionRequest.count({
          where: { reviewId },
        })
      ).toBe(1);
    }
  });
});

// ============================================================================
describe('PG5-PG10. Approval decisions under real concurrency', () => {
  // one decision each, both inside their transactions at the hold
  const race = async (
    reviewId: string,
    actions: ('approve' | 'refuse' | 'withdraw')[]
  ) => {
    const both = latch(actions.length);
    const services = actions.map(() =>
      hookedService({ 'contentStudioReview.updateMany': () => both() })
    );
    const results = await Promise.all(
      actions.map((action, index) =>
        outcome(
          decide(reviewId, action, services[index].service, index % 2 ? A1 : A2)
        )
      )
    );
    const inserts = services.reduce(
      (sum, entry) => sum + (entry.calls['contentStudioApproval.create'] ?? 0),
      0
    );
    return { results, inserts };
  };

  it.each([['package'], ['design'], ['grounded']] as const)(
    'PG5 approve and refuse at once on a %s review: one winner, one CS_APPROVAL_CONFLICT, one row',
    async (kind) => {
      for (let round = 0; round < 3; round += 1) {
        const { reviewId } = await reviewOf(kind);
        const before = await reviewState(reviewId);
        const { results, inserts } = await race(reviewId, [
          'approve',
          'refuse',
        ]);
        expect([...results].sort()).toEqual(['CS_APPROVAL_CONFLICT', 'ok']);
        const rows = await approvalRows(reviewId);
        expect(rows).toHaveLength(1);
        const winner = results[0] === 'ok' ? 'APPROVED' : 'REFUSED';
        expect(rows[0]).toMatchObject({ sequence: 1, decision: winner });
        expect((await service.getApproval({ ...A1, reviewId })).state).toBe(
          winner
        );
        // M12: the loser is decided by its history read under the hold,
        // never by a failing insert
        expect(inserts).toBe(1);
        // the review is only the serialization point
        const after = await reviewState(reviewId);
        expect(after).toMatchObject({
          state: 'READY_FOR_APPROVAL',
          version: before.version,
        });
        expect(await eventsOf(reviewId)).toHaveLength(before.version);
      }
    }
  );

  it('PG6 two approvals at once: one APPROVED row', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { reviewId } = await reviewOf('package');
      const { results, inserts } = await race(reviewId, ['approve', 'approve']);
      expect([...results].sort()).toEqual(['CS_APPROVAL_CONFLICT', 'ok']);
      expect((await approvalRows(reviewId)).map((r) => r.decision)).toEqual([
        'APPROVED',
      ]);
      expect(inserts).toBe(1);
    }
  });

  it('PG7 two withdrawals at once: exactly one WITHDRAWN row', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { reviewId } = await reviewOf('design');
      await decide(reviewId, 'approve');
      const { results } = await race(reviewId, ['withdraw', 'withdraw']);
      expect([...results].sort()).toEqual(['CS_APPROVAL_CONFLICT', 'ok']);
      expect(
        (await approvalRows(reviewId)).map((r) => [r.sequence, r.decision])
      ).toEqual([
        [1, 'APPROVED'],
        [2, 'WITHDRAWN'],
      ]);
      expect((await service.getApproval({ ...A1, reviewId })).state).toBe(
        'PENDING'
      );
    }
  });

  it('PG8 the sequence stays 1, 2, 3... under rounds of concurrent decisions', async () => {
    const { reviewId } = await reviewOf('package');
    for (let round = 0; round < 4; round += 1) {
      const decided = await race(reviewId, [
        'approve',
        'refuse',
        'approve',
        'refuse',
      ]);
      expect(decided.results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(decided.results.filter((r) => r !== 'ok')).toEqual(
        Array(3).fill('CS_APPROVAL_CONFLICT')
      );
      const withdrawn = await race(reviewId, [
        'withdraw',
        'withdraw',
        'withdraw',
      ]);
      expect(withdrawn.results.filter((r) => r === 'ok')).toHaveLength(1);
    }
    const rows = await approvalRows(reviewId);
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    rows.forEach((row, index) =>
      expect(row.decision).toMatch(
        index % 2 ? /^WITHDRAWN$/ : /^(APPROVED|REFUSED)$/
      )
    );
    expect(await service.getApproval({ ...A1, reviewId })).toMatchObject({
      state: 'PENDING',
      version: 8,
    });
    expect(await reviewState(reviewId)).toMatchObject({ version: 3 });
  });

  it('PG9 a refusal asked for while APPROVED is never reinterpreted after a concurrent withdrawal', async () => {
    const { reviewId } = await reviewOf('package');
    await decide(reviewId, 'approve');
    // the withdrawal commits right after the refusal read APPROVED
    const stale = hookedService({});
    const original = stale.repository.listApprovalsForReview.bind(
      stale.repository
    );
    let ran = false;
    stale.repository.listApprovalsForReview = ((
      organizationId: string,
      id: string
    ) =>
      original(organizationId, id).then(async (rows) => {
        if (!ran) {
          ran = true;
          await decide(reviewId, 'withdraw', service, A1);
        }
        return rows;
      })) as unknown as typeof stale.repository.listApprovalsForReview;
    expect(await failure(decide(reviewId, 'refuse', stale.service))).toBe(
      'CS_APPROVAL_INVALID_DECISION'
    );
    expect((await approvalRows(reviewId)).map((r) => r.decision)).toEqual([
      'APPROVED',
      'WITHDRAWN',
    ]);
  });

  it('PG9/M14 a withdrawal decided on a stale history conflicts: it never withdraws the newer approval', async () => {
    const { reviewId } = await reviewOf('package');
    await decide(reviewId, 'approve');
    const stale = hookedService({});
    const original = stale.repository.appendApprovalDecision.bind(
      stale.repository
    );
    stale.repository.appendApprovalDecision = async (input) => {
      // someone else withdraws and approves again, both committed
      await decide(reviewId, 'withdraw', service, A1);
      await decide(reviewId, 'approve', service, A1);
      return original(input);
    };
    expect(await failure(decide(reviewId, 'withdraw', stale.service))).toBe(
      'CS_APPROVAL_CONFLICT'
    );
    expect(
      (await approvalRows(reviewId)).map((r) => [
        r.sequence,
        r.decision,
        r.actorUserId,
      ])
    ).toEqual([
      [1, 'APPROVED', USER_A2],
      [2, 'WITHDRAWN', USER_A1],
      [3, 'APPROVED', USER_A1],
    ]);
    expect((await service.getApproval({ ...A1, reviewId })).state).toBe(
      'APPROVED'
    );
  });

  it('PG9 a stale decision blocked on the hold while another commits conflicts too', async () => {
    const { reviewId } = await reviewOf('package');
    // the approval read PENDING; a refusal and its withdrawal commit while it
    // waits at its hold
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const waiting = hookedService({
      'contentStudioReview.updateMany': () => released,
    });
    const pending = outcome(decide(reviewId, 'approve', waiting.service));
    await decide(reviewId, 'refuse', service, A1);
    await decide(reviewId, 'withdraw', service, A1);
    release();
    expect(await pending).toBe('CS_APPROVAL_CONFLICT');
    expect((await approvalRows(reviewId)).map((r) => r.decision)).toEqual([
      'REFUSED',
      'WITHDRAWN',
    ]);
  });

  it("PG10 every decision keeps exactly the review's target and hash under concurrency", async () => {
    for (const kind of ['package', 'design'] as const) {
      const { reviewId, revision } = await reviewOf(kind);
      await race(reviewId, ['approve', 'refuse']);
      await race(reviewId, ['withdraw', 'withdraw']);
      await race(reviewId, ['refuse', 'approve']);
      const review = await client.contentStudioReview.findUniqueOrThrow({
        where: { id: reviewId },
      });
      const rows = await approvalRows(reviewId);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          organizationId: ORG_A,
          packageRevisionId: kind === 'package' ? revision.id : null,
          designRevisionId: kind === 'design' ? revision.id : null,
          targetContentHash: review.targetContentHash,
        });
        expect(row.targetContentHash).toBe(revision.contentHash);
      }
    }
  });

  it('no carry-over: the review of an identical newer revision starts PENDING', async () => {
    const packageId = await createPackage();
    const first = await packageRevision(ORG_A, 'Same text', 1, packageId);
    const second = await packageRevision(ORG_A, 'Same text', 2, packageId);
    expect(second.contentHash).toBe(first.contentHash);
    for (const revision of [first, second]) {
      const review = await requestReview('PACKAGE_REVISION', revision.id);
      await move(review.id, 'start');
      await move(review.id, 'ready-for-approval');
      if (revision === first) {
        await decide(review.id, 'approve');
      } else {
        expect(
          await service.getApproval({ ...A1, reviewId: review.id })
        ).toMatchObject({
          state: 'PENDING',
          version: 0,
          history: [],
        });
      }
    }
  });

  it('ASEC another organization reads and decides nothing on the real database', async () => {
    const { reviewId } = await reviewOf('package');
    await decide(reviewId, 'approve');
    const other = as(ORG_B, USER_B1);
    expect(await failure(service.getApproval({ ...other, reviewId }))).toBe(
      'CS_NOT_FOUND'
    );
    expect(
      await failure(
        service.decideApproval({
          ...other,
          reviewId,
          action: 'withdraw',
          note: 'x',
        })
      )
    ).toBe('CS_NOT_FOUND');
    expect(await approvalRows(reviewId)).toHaveLength(1);
  });
});

// ============================================================================
describe('Approval decisions: what PostgreSQL enforces and what only the application does', () => {
  const rowFor = async (
    overrides: Partial<Prisma.ContentStudioApprovalUncheckedCreateInput> = {}
  ) => {
    const { reviewId, revision } = await reviewOf('package');
    return {
      reviewId,
      revision,
      data: {
        organizationId: ORG_A,
        reviewId,
        sequence: 1,
        decision: 'APPROVED',
        packageRevisionId: revision.id,
        designRevisionId: null,
        targetContentHash: revision.contentHash,
        actorUserId: USER_A2,
        note: null,
        ...overrides,
      } as Prisma.ContentStudioApprovalUncheckedCreateInput,
    };
  };
  const prismaCode = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      return (err as Prisma.PrismaClientKnownRequestError).code;
    }
    throw new Error('expected the database to refuse it');
  };

  it('M27 one decision per sequence of a review: a second sequence 1 is refused (P2002)', async () => {
    const { data } = await rowFor();
    await client.contentStudioApproval.create({ data });
    expect(
      await prismaCode(
        client.contentStudioApproval.create({
          data: { ...data, decision: 'REFUSED', note: 'x' },
        })
      )
    ).toBe('P2002');
  });

  it('AI8 a decision is bound to its review inside the organization: another organization is refused (P2003)', async () => {
    const { data } = await rowFor();
    expect(
      await prismaCode(
        client.contentStudioApproval.create({
          data: { ...data, organizationId: ORG_B },
        })
      )
    ).toBe('P2003');
  });

  it('a decision can only name a revision of its organization, and an existing actor', async () => {
    const foreign = await packageRevision(ORG_B);
    const { data } = await rowFor();
    expect(
      await prismaCode(
        client.contentStudioApproval.create({
          data: { ...data, packageRevisionId: foreign.id },
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioApproval.create({
          data: { ...data, actorUserId: randomUUID() },
        })
      )
    ).toBe('P2003');
  });

  it('the application, not PostgreSQL, checks the decision, the single target, the hash and immutability: each fails closed', async () => {
    for (const overrides of [
      { decision: 'BOGUS' },
      { packageRevisionId: null },
      { targetContentHash: 'e'.repeat(64) },
      { decision: 'REFUSED', note: null },
    ]) {
      const { data, reviewId } = await rowFor(overrides);
      // PostgreSQL accepts it
      await client.contentStudioApproval.create({ data });
      expect(await failure(service.getApproval({ ...A1, reviewId }))).toBe(
        'CS_APPROVAL_INTEGRITY_ERROR'
      );
      expect(await failure(decide(reviewId, 'withdraw'))).toBe(
        'CS_APPROVAL_INTEGRITY_ERROR'
      );
    }
    // and a row rewritten behind the service
    const { reviewId } = await reviewOf('package');
    await decide(reviewId, 'approve');
    await client.contentStudioApproval.updateMany({
      where: { reviewId },
      data: { decision: 'REFUSED', note: null },
    });
    expect(await failure(service.getApproval({ ...A1, reviewId }))).toBe(
      'CS_APPROVAL_INTEGRITY_ERROR'
    );
  });

  it('a decision changes the review only by its updatedAt: state, version and events stay', async () => {
    const { reviewId } = await reviewOf('package');
    const before = await reviewState(reviewId);
    const events = await eventsOf(reviewId);
    await decide(reviewId, 'refuse');
    const after = await reviewState(reviewId);
    expect(after).toMatchObject({
      state: before.state,
      version: before.version,
    });
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime()
    );
    expect(await eventsOf(reviewId)).toEqual(events);
    expect(
      await client.contentStudioReviewRevisionRequest.count({
        where: { reviewId },
      })
    ).toBe(0);
    expect(
      await client.contentStudioReviewComment.count({ where: { reviewId } })
    ).toBe(0);
  });
});

// ============================================================================
describe('PB1-PB6. Approval binding of exact revisions on the real database (P5-05)', () => {
  const binding = (
    targetType: string,
    targetRevisionId: string,
    organizationId = ORG_A
  ) =>
    service.getRevisionApprovalStatus({
      organizationId,
      targetType,
      targetRevisionId,
    });
  const page = (
    targetType: 'PACKAGE_REVISION' | 'DESIGN_REVISION',
    revisionIds: string[],
    organizationId = ORG_A
  ) =>
    service.getRevisionApprovalStatuses({
      organizationId,
      targetType,
      revisionIds,
    });
  // revisions 1-5 of one package: none, approved, refused, withdrawn,
  // re-approved
  const history = async () => {
    const packageId = await createPackage();
    const ids: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      ids.push((await packageRevision(ORG_A, `Version ${n}`, n, packageId)).id);
    }
    const ready = async (id: string) => {
      const review = await requestReview('PACKAGE_REVISION', id);
      await move(review.id, 'start');
      await move(review.id, 'ready-for-approval');
      return review.id;
    };
    await decide(await ready(ids[1]), 'approve');
    await decide(await ready(ids[2]), 'refuse');
    const withdrawn = await ready(ids[3]);
    await decide(withdrawn, 'approve');
    await decide(withdrawn, 'withdraw');
    const again = await ready(ids[4]);
    await decide(again, 'approve');
    await decide(again, 'withdraw');
    await decide(again, 'approve');
    return { packageId, ids };
  };

  it('PB1 a page of revisions gets exactly its own states through the real batch queries', async () => {
    const { ids } = await history();
    const statuses = await page('PACKAGE_REVISION', [...ids].reverse());
    expect([...statuses]).toEqual([
      [ids[4], { approved: true, state: 'APPROVED' }],
      [ids[3], { approved: false, state: 'PENDING_APPROVAL' }],
      [ids[2], { approved: false, state: 'REFUSED' }],
      [ids[1], { approved: true, state: 'APPROVED' }],
      [ids[0], { approved: false, state: 'NOT_REVIEWED' }],
    ]);
    // the single predicate agrees on every one
    for (const id of ids) {
      const single = await binding('PACKAGE_REVISION', id);
      expect({ approved: single.approved, state: single.state }).toEqual(
        statuses.get(id)
      );
    }
    expect(await binding('PACKAGE_REVISION', ids[4])).toMatchObject({
      approvalVersion: 3,
      currentDecision: { sequence: 3, decision: 'APPROVED' },
    });
  });

  it('PB2 a withdrawal is not approved from the very next read: nothing is cached', async () => {
    const { reviewId, revision } = await reviewOf('design');
    await decide(reviewId, 'approve');
    expect((await binding('DESIGN_REVISION', revision.id)).approved).toBe(true);
    // withdrawn through another client of the same database
    await decide(reviewId, 'withdraw', hookedService({}).service, A1);
    expect(await binding('DESIGN_REVISION', revision.id)).toMatchObject({
      approved: false,
      state: 'PENDING_APPROVAL',
      approvalVersion: 2,
      currentDecision: null,
    });
    expect(
      (await page('DESIGN_REVISION', [revision.id])).get(revision.id)
    ).toEqual({ approved: false, state: 'PENDING_APPROVAL' });
  });

  it('PB3 a grounded package revision is approved with its claims, and a corrupt assessment fails closed', async () => {
    const { reviewId, revision } = await reviewOf('grounded');
    await decide(reviewId, 'approve');
    expect(
      (await page('PACKAGE_REVISION', [revision.id])).get(revision.id)
    ).toEqual({ approved: true, state: 'APPROVED' });
    // behind the service's back: an assessment no longer verified
    await client.contentStudioReviewClaim.updateMany({
      where: { reviewId, claimId: C2 },
      data: { status: 'NEEDS_REVISION', finding: 'Changed directly.' },
    });
    expect(await failure(binding('PACKAGE_REVISION', revision.id))).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    expect(await failure(page('PACKAGE_REVISION', [revision.id]))).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    expect(
      await failure(
        service.requireApprovedRevision({
          organizationId: ORG_A,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: revision.id,
        })
      )
    ).toBe('CS_REVIEW_INTEGRITY_ERROR');
  });

  it('PB4 another organization reads no binding: 404 for one revision, nothing in a page', async () => {
    const { reviewId, revision } = await reviewOf('package');
    await decide(reviewId, 'approve');
    expect(await failure(binding('PACKAGE_REVISION', revision.id, ORG_B))).toBe(
      'CS_NOT_FOUND'
    );
    expect(
      (await page('PACKAGE_REVISION', [revision.id], ORG_B)).get(revision.id)
    ).toEqual({ approved: false, state: 'NOT_REVIEWED' });
  });

  it('PB5 an identical revision of the same package with the same hash inherits nothing', async () => {
    const packageId = await createPackage();
    const first = await packageRevision(ORG_A, 'Same text', 1, packageId);
    const twin = await packageRevision(ORG_A, 'Same text', 2, packageId);
    expect(twin.contentHash).toBe(first.contentHash);
    const review = await requestReview('PACKAGE_REVISION', first.id);
    await move(review.id, 'start');
    await move(review.id, 'ready-for-approval');
    await decide(review.id, 'approve');
    expect([...(await page('PACKAGE_REVISION', [twin.id, first.id]))]).toEqual([
      [twin.id, { approved: false, state: 'NOT_REVIEWED' }],
      [first.id, { approved: true, state: 'APPROVED' }],
    ]);
  });

  it('PB6 a read racing a withdrawal sees one committed history: approved before, pending after, never a mix', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { reviewId, revision } = await reviewOf('package');
      await decide(reviewId, 'approve');
      const both = latch(2);
      const withdrawing = hookedService({
        'contentStudioReview.updateMany': () => both(),
      });
      const [read] = await Promise.all([
        both().then(() => binding('PACKAGE_REVISION', revision.id)),
        decide(reviewId, 'withdraw', withdrawing.service, A1),
      ]);
      expect([
        [true, 'APPROVED', 1, 1],
        [false, 'PENDING_APPROVAL', 2, null],
      ]).toContainEqual([
        read.approved,
        read.state,
        read.approvalVersion,
        read.currentDecision?.sequence ?? null,
      ]);
      // and from then on it is withdrawn
      expect((await binding('PACKAGE_REVISION', revision.id)).approved).toBe(
        false
      );
    }
  });
});

// ============================================================================
describe('PQ1-PQ8. The Review & Approval queue on the real database (P5-06)', () => {
  const queue = (
    filter: Record<string, unknown> = {},
    organizationId = ORG_A,
    page = 1
  ) => service.listReviews({ organizationId, page, ...filter });
  const ids = async (
    filter: Record<string, unknown> = {},
    organizationId = ORG_A
  ) => (await queue(filter, organizationId)).results.map((item) => item.id);
  const named = async (id: string, name: string) => {
    const revision = await client.contentPackageRevision.findUniqueOrThrow({
      where: { id },
      select: { packageId: true },
    });
    await client.contentPackage.update({
      where: { id: revision.packageId },
      data: { name },
    });
    return revision.packageId;
  };
  const ready = async (revisionId: string, targetType = 'PACKAGE_REVISION') => {
    const review = await requestReview(targetType, revisionId);
    await move(review.id, 'start');
    await move(review.id, 'ready-for-approval');
    return review.id;
  };
  // every binding state of one organization:
  // approved, refused, pending (none), approved->withdrawn, refused->withdrawn,
  // re-approved, in review, cancelled; and a design approved
  const board = async () => {
    const r: Record<string, string> = {};
    r.approved = await ready((await packageRevision()).id);
    await decide(r.approved, 'approve');
    r.refused = await ready((await packageRevision()).id);
    await decide(r.refused, 'refuse');
    r.pending = await ready((await packageRevision()).id);
    r.withdrawnApproval = await ready((await packageRevision()).id);
    await decide(r.withdrawnApproval, 'approve');
    await decide(r.withdrawnApproval, 'withdraw');
    r.withdrawnRefusal = await ready((await packageRevision()).id);
    await decide(r.withdrawnRefusal, 'refuse');
    await decide(r.withdrawnRefusal, 'withdraw');
    r.reapproved = await ready((await packageRevision()).id);
    await decide(r.reapproved, 'approve');
    await decide(r.reapproved, 'withdraw');
    await decide(r.reapproved, 'approve');
    const inReview = await requestReview(
      'PACKAGE_REVISION',
      (
        await packageRevision()
      ).id
    );
    await move(inReview.id, 'start');
    r.inReview = inReview.id;
    const cancelled = await requestReview(
      'PACKAGE_REVISION',
      (
        await packageRevision()
      ).id
    );
    await move(cancelled.id, 'cancel');
    r.cancelled = cancelled.id;
    const design = await designRevision();
    r.design = await ready(design.id, 'DESIGN_REVISION');
    await decide(r.design, 'approve');
    return r;
  };
  // org B's own approved package review
  const otherOrganization = async () => {
    const revision = await packageRevision(ORG_B, 'Rival');
    const b = as(ORG_B, USER_B1);
    const review = await service.requestReview({
      ...b,
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: revision.id,
    });
    for (const action of ['start', 'ready-for-approval'] as const) {
      await service.transitionReview({ ...b, id: review.id, action });
    }
    await service.decideApproval({
      ...b,
      reviewId: review.id,
      action: 'approve',
      note: null,
    });
    await named(revision.id, 'Rival Plan');
    return review.id;
  };

  it("PQ1 mixed package and design rows are the organization's own, in every queue", async () => {
    const r = await board();
    const foreign = await otherOrganization();
    const all = await queue();
    expect(all.results).toHaveLength(9);
    expect(new Set(all.results.map((item) => item.target.type))).toEqual(
      new Set(['PACKAGE_REVISION', 'DESIGN_REVISION'])
    );
    expect(JSON.stringify(all)).not.toMatch(
      /Rival|50400000-0000-4000-8000-00000000000b/
    );
    expect(new Set(await ids({ queue: 'APPROVED' }))).toEqual(
      new Set([r.approved, r.reapproved, r.design])
    );
    expect(await ids({ queue: 'APPROVED' }, ORG_B)).toEqual([foreign]);
    expect(await ids({ search: 'rival' })).toEqual([]);
    expect(
      (await queue({}, ORG_B)).results.map((item) => item.target.parentName)
    ).toEqual(['Rival Plan']);
  });

  it('PQ2 Pending approval: no decision, a withdrawn approval and a withdrawn refusal; never one approved or refused now', async () => {
    const r = await board();
    expect(new Set(await ids({ queue: 'PENDING_APPROVAL' }))).toEqual(
      new Set([r.pending, r.withdrawnApproval, r.withdrawnRefusal])
    );
  });

  it('PQ3/PQ4 Approved and Refused hold the current decision only', async () => {
    const r = await board();
    const approved = await ids({ queue: 'APPROVED' });
    expect(approved).toContain(r.reapproved);
    expect(approved).not.toContain(r.withdrawnApproval);
    expect(await ids({ queue: 'REFUSED' })).toEqual([r.refused]);
    expect(new Set(await ids({ queue: 'NEEDS_REVIEW' }))).toEqual(
      new Set([r.inReview])
    );
    expect(await ids({ queue: 'CANCELLED' })).toEqual([r.cancelled]);
    // a withdrawal moves a review at once, through another client
    await decide(r.approved, 'withdraw', hookedService({}).service, A1);
    expect(await ids({ queue: 'APPROVED' })).not.toContain(r.approved);
    expect(await ids({ queue: 'PENDING_APPROVAL' })).toContain(r.approved);
    // most recently decided first
    expect((await ids({ queue: 'PENDING_APPROVAL' }))[0]).toBe(r.approved);
  });

  it('PQ5 each row names exactly its own package or design and revision; search finds part of a name in any case', async () => {
    const packageId = await createPackage();
    const first = await packageRevision(ORG_A, 'One', 2, packageId);
    const second = await packageRevision(ORG_A, 'Two', 7, packageId);
    await named(first.id, 'Summer Launch');
    const other = await packageRevision(ORG_A, 'Other', 3);
    const otherPackage = await named(other.id, 'Autumn Promo');
    const design = await designRevision();
    const designProject = (
      await client.contentStudioDesignRevision.findUniqueOrThrow({
        where: { id: design.id },
        select: { designProjectId: true },
      })
    ).designProjectId;
    await client.contentStudioDesignProject.update({
      where: { id: designProject },
      data: { name: 'Hero Banner' },
    });
    const reviews = {
      first: await requestReview('PACKAGE_REVISION', first.id),
      second: await requestReview('PACKAGE_REVISION', second.id),
      other: await requestReview('PACKAGE_REVISION', other.id),
      design: await requestReview('DESIGN_REVISION', design.id),
    };
    const items = (await queue()).results;
    const of = (id: string) => items.find((item) => item.id === id)!;
    expect(of(reviews.first.id).target).toEqual({
      type: 'PACKAGE_REVISION',
      revisionId: first.id,
      revisionNumber: 2,
      parentId: packageId,
      parentName: 'Summer Launch',
    });
    expect(of(reviews.second.id).target).toMatchObject({
      revisionId: second.id,
      revisionNumber: 7,
      parentId: packageId,
    });
    expect(of(reviews.other.id).target).toMatchObject({
      parentId: otherPackage,
      parentName: 'Autumn Promo',
    });
    expect(of(reviews.design.id).target).toEqual({
      type: 'DESIGN_REVISION',
      revisionId: design.id,
      revisionNumber: 1,
      parentId: designProject,
      parentName: 'Hero Banner',
    });
    expect(new Set(await ids({ search: 'SUMMER' }))).toEqual(
      new Set([reviews.first.id, reviews.second.id])
    );
    expect(await ids({ search: 'banner' })).toEqual([reviews.design.id]);
    expect(
      await ids({ search: 'banner', targetType: 'PACKAGE_REVISION' })
    ).toEqual([]);
    expect(await ids({ search: 'promo', queue: 'NEEDS_REVIEW' })).toEqual([
      reviews.other.id,
    ]);
  });

  it('PQ6 another revision with the same hash shows nothing of an approval', async () => {
    const packageId = await createPackage();
    const first = await packageRevision(ORG_A, 'Same text', 1, packageId);
    const twin = await packageRevision(ORG_A, 'Same text', 2, packageId);
    expect(twin.contentHash).toBe(first.contentHash);
    const approved = await ready(first.id);
    await decide(approved, 'approve');
    const pending = await ready(twin.id);
    expect(await ids({ queue: 'APPROVED' })).toEqual([approved]);
    expect(await ids({ queue: 'PENDING_APPROVAL' })).toEqual([pending]);
    const items = (await queue()).results;
    expect(items.find((item) => item.id === pending)!.approval).toEqual({
      approved: false,
      state: 'PENDING_APPROVAL',
      decidedAt: null,
    });
  });

  it('PQ7 a derived queue is paged after it is derived: deterministic, nothing twice, nothing lost', async () => {
    const approved: string[] = [];
    const packageId = await createPackage();
    for (let n = 1; n <= 56; n += 1) {
      const reviewId = await ready(
        (
          await packageRevision(ORG_A, `Page ${n}`, n, packageId)
        ).id
      );
      await decide(reviewId, 'approve');
      if (n % 7) {
        approved.push(reviewId);
      } else {
        // every seventh is taken back: pending, and never counted approved
        await decide(reviewId, 'withdraw');
      }
    }
    expect(approved).toHaveLength(48);
    const first = await queue({ queue: 'APPROVED' });
    // M5: 48 approved now fit one page; 56 ever approved would not
    expect([first.pages, first.results.length]).toEqual([1, 48]);
    // 48 fit one page; 8 more approved make two
    for (let n = 57; n <= 64; n += 1) {
      const reviewId = await ready(
        (
          await packageRevision(ORG_A, `Page ${n}`, n, packageId)
        ).id
      );
      await decide(reviewId, 'approve');
      approved.push(reviewId);
    }
    const one = await queue({ queue: 'APPROVED' });
    const two = await queue({ queue: 'APPROVED' }, ORG_A, 2);
    expect([one.pages, one.results.length, two.results.length]).toEqual([
      2, 50, 6,
    ]);
    const paged = [...one.results, ...two.results].map((item) => item.id);
    expect(new Set(paged).size).toBe(56);
    expect(new Set(paged)).toEqual(new Set(approved));
    // most recently decided first, and the same on every read
    expect(paged).toEqual([...approved].reverse());
    expect(await ids({ queue: 'APPROVED' })).toEqual(
      one.results.map((item) => item.id)
    );
    const pending = await queue({ queue: 'PENDING_APPROVAL' });
    expect([pending.pages, pending.results.length]).toEqual([1, 8]);
  });

  it('PQ7 the decision scan continues exactly after its cursor on the real ordering', async () => {
    const r = await board();
    const repository = repositoryWith(new PrismaTransaction(prisma));
    const filter = {
      organizationId: ORG_A,
      target: {},
      states: ['READY_FOR_APPROVAL'],
    };
    const whole = await repository.listReviewDecisionsForOrganization({
      ...filter,
      after: null,
      take: 100,
    });
    expect(whole).toHaveLength(7);
    const chunks: string[] = [];
    let after: string | null = null;
    for (;;) {
      const chunk: { id: string }[] =
        await repository.listReviewDecisionsForOrganization({
          ...filter,
          after,
          take: 3,
        });
      chunks.push(...chunk.map((row) => row.id));
      if (chunk.length < 3) {
        break;
      }
      after = chunk[chunk.length - 1].id;
    }
    expect(chunks).toEqual(whole.map((row) => row.id));
    // the decisions of each review, in sequence order, its own only
    const reapproved = whole.find((row) => row.id === r.reapproved)!;
    expect(reapproved.approvals).toEqual([
      { sequence: 1, decision: 'APPROVED' },
      { sequence: 2, decision: 'WITHDRAWN' },
      { sequence: 3, decision: 'APPROVED' },
    ]);
    expect(Object.keys(reapproved).sort()).toEqual([
      'approvals',
      'id',
      'state',
    ]);
  });

  it('PQ8 no row twice from the joins: many decisions, both name relations and a search', async () => {
    const r = await board();
    const all = await queue({ search: 'p504' });
    expect(all.results).toHaveLength(9);
    expect(new Set(all.results.map((item) => item.id)).size).toBe(9);
    expect(all.pages).toBe(1);
    const count = await client.contentStudioReview.count({
      where: { organizationId: ORG_A },
    });
    expect(count).toBe(9);
    for (const queueName of [
      'APPROVED',
      'PENDING_APPROVAL',
      'REFUSED',
      'NEEDS_REVIEW',
      'CANCELLED',
    ]) {
      const listed = await ids({ queue: queueName });
      expect(new Set(listed).size).toBe(listed.length);
    }
    expect(r.reapproved).toBeDefined();
  });
});

// ============================================================================
// --- the handoff (P5-07) on the real repositories, shared by PH and PA ---
const packages = () =>
  new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(prisma),
    new PrismaRepository<'contentPackage'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    new PrismaTransaction(prisma)
  );
const policies = () =>
  new ContentStudioEditorialPolicyService(
    new ContentStudioEditorialPolicyRepository(
      new PrismaRepository<'contentStudioEditorialPolicy'>(prisma),
      new PrismaRepository<'contentStudioEditorialPolicyRevision'>(prisma),
      new PrismaTransaction(prisma)
    )
  );
// The real client with `hooks[model.method]` awaited right before that
// call, outside any transaction (P5-08)
const hookedClient = (hooks: Record<string, () => Promise<void>>) =>
  new Proxy(client, {
    get(target, model, receiver) {
      const value = Reflect.get(target, model, receiver);
      if (typeof model !== 'string' || !value || typeof value !== 'object') {
        return value;
      }
      return new Proxy(value, {
        get(delegate, method, delegateReceiver) {
          const original = Reflect.get(delegate, method, delegateReceiver);
          if (typeof original !== 'function') {
            return original;
          }
          return async (args: unknown) => {
            await hooks[`${model}.${String(method)}`]?.();
            return original.call(delegate, args);
          };
        },
      });
    },
  }) as unknown as PrismaService;
// the real handoff service on the real repositories and policy; its
// transaction may be hooked, and (P5-08) its statements outside the
// transaction too. Every Media is ready (there are none)
const handoffService = (
  hooks: Record<string, () => Promise<void>> = {},
  reviews = service,
  outside: Record<string, () => Promise<void>> = {}
) =>
  new ContentStudioHandoffService(
    packages(),
    new ContentStudioHandoffRepository(
      new PrismaRepository<'contentStudioHandoff'>(hookedClient(outside)),
      hookedTransaction(hooks).transaction
    ),
    {
      resolveForHandoff: async (
        _org: string,
        draft: { copy: { global: { thread: unknown[] } } }
      ) => draft.copy.global.thread.map(() => []),
    } as unknown as ContentStudioMediaService,
    policies(),
    reviews
  );
// the organization's policy as saved through its real service: a new
// revision each time, the switch on or off
const requireApproval = async (organizationId: string, on: boolean) => {
  const policy = policies();
  const { latestRevisionNumber } = await policy.getPolicy(organizationId);
  await policy.createRevision({
    organizationId,
    userId: OWNER[organizationId],
    baseRevisionNumber: latestRevisionNumber,
    content: {
      ...emptyContentStudioEditorialPolicyContent(),
      principles: [`Version ${latestRevisionNumber + 1}`],
      ...(on ? { workflow: { requireApprovalForHandoff: true } } : {}),
    },
  });
};
const packageOf = async (revisionId: string) =>
  (
    await client.contentPackageRevision.findUniqueOrThrow({
      where: { id: revisionId },
      select: { packageId: true },
    })
  ).packageId;
const handOff = async (
  revisionId: string,
  organizationId = ORG_A,
  on = handoffService()
) =>
  on.createHandoff({
    organizationId,
    userId: OWNER[organizationId],
    packageId: await packageOf(revisionId),
    revisionId,
  });
const handoffsOf = (revisionId: string) =>
  client.contentStudioHandoff.findMany({
    where: { packageRevisionId: revisionId },
    select: { id: true, organizationId: true, userId: true },
  });
const approvedPackage = async () => {
  const { reviewId, revision } = await reviewOf('package');
  await decide(reviewId, 'approve');
  return { reviewId, revision };
};

describe('PH1-PH8. Handoff requiring an approved revision on the real database (P5-07)', () => {
  it('PH1 policy off: an unreviewed and a refused revision are handed off exactly as before', async () => {
    const unreviewed = await packageRevision();
    await handOff(unreviewed.id);
    const { reviewId, revision } = await reviewOf('package');
    await decide(reviewId, 'refuse');
    // a saved policy with the switch off is the same as none
    await requireApproval(ORG_A, false);
    await handOff(revision.id);
    expect(await handoffsOf(unreviewed.id)).toHaveLength(1);
    expect(await handoffsOf(revision.id)).toHaveLength(1);
  });

  it('PH2 policy on: an approved revision is handed off, and its review and decisions do not change', async () => {
    const { reviewId, revision } = await approvedPackage();
    await requireApproval(ORG_A, true);
    const before = await reviewState(reviewId);
    const history = await approvalRows(reviewId);
    const handoff = await handOff(revision.id);
    expect(Object.keys(handoff).sort()).toEqual(['expiresAt', 'id']);
    expect(await handoffsOf(revision.id)).toEqual([
      { id: handoff.id, organizationId: ORG_A, userId: USER_A1 },
    ]);
    // the hold wrote back what it read: not even updatedAt moved
    expect(await reviewState(reviewId)).toEqual(before);
    expect(await approvalRows(reviewId)).toEqual(history);
  });

  it('PH3 policy on: an unreviewed, an in-review and a pending revision write nothing', async () => {
    await requireApproval(ORG_A, true);
    const unreviewed = await packageRevision();
    const inReview = (await reviewOf('package', 'IN_REVIEW')).revision;
    const pending = (await reviewOf('package')).revision;
    for (const revision of [unreviewed, inReview, pending]) {
      expect(await failure(handOff(revision.id))).toBe('CS_APPROVAL_REQUIRED');
    }
    expect(
      await client.contentStudioHandoff.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(0);
  });

  it('PH4 policy on: refused and withdrawn are refused; approved again hands off', async () => {
    await requireApproval(ORG_A, true);
    const refused = await reviewOf('package');
    await decide(refused.reviewId, 'refuse');
    expect(await failure(handOff(refused.revision.id))).toBe(
      'CS_APPROVAL_REQUIRED'
    );
    const withdrawn = await approvedPackage();
    await decide(withdrawn.reviewId, 'withdraw');
    expect(await failure(handOff(withdrawn.revision.id))).toBe(
      'CS_APPROVAL_REQUIRED'
    );
    expect(await handoffsOf(refused.revision.id)).toEqual([]);
    expect(await handoffsOf(withdrawn.revision.id)).toEqual([]);
    await decide(withdrawn.reviewId, 'approve');
    await handOff(withdrawn.revision.id);
    expect(await handoffsOf(withdrawn.revision.id)).toHaveLength(1);
  });

  it('PH5/PH6 the approval of revision N applies to N only: a newer N+1, even with the same hash, is refused', async () => {
    await requireApproval(ORG_A, true);
    const { revision } = await approvedPackage();
    const packageId = await packageOf(revision.id);
    const newer = await packageRevision(ORG_A, 'Summer sale', 2, packageId);
    const same = await packageRevision(ORG_A, 'Spring sale', 3, packageId);
    expect(same.contentHash).toBe(revision.contentHash);
    await handOff(revision.id);
    expect(await failure(handOff(newer.id))).toBe('CS_APPROVAL_REQUIRED');
    expect(await failure(handOff(same.id))).toBe('CS_APPROVAL_REQUIRED');
    expect(await handoffsOf(newer.id)).toEqual([]);
    expect(await handoffsOf(same.id)).toEqual([]);
  });

  it('POL6/POL7 the current policy decides on every request: on, then off again', async () => {
    const unreviewed = await packageRevision();
    await requireApproval(ORG_A, true);
    expect(await failure(handOff(unreviewed.id))).toBe('CS_APPROVAL_REQUIRED');
    await requireApproval(ORG_A, false);
    await handOff(unreviewed.id);
    expect(await handoffsOf(unreviewed.id)).toHaveLength(1);
  });

  it('PH7/WR1 a withdrawal committed between the check and the hold: the handoff is refused and writes nothing', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    let withdrawn = false;
    // the first statement of the handoff transaction waits for a whole
    // withdrawal: it commits after the approval was checked
    const on = handoffService({
      'contentStudioReview.findFirst': async () => {
        if (!withdrawn) {
          withdrawn = true;
          await decide(reviewId, 'withdraw');
        }
      },
    });
    expect(await failure(handOff(revision.id, ORG_A, on))).toBe(
      'CS_APPROVAL_REQUIRED'
    );
    expect(await handoffsOf(revision.id)).toEqual([]);
    expect((await approvalRows(reviewId)).map((row) => row.decision)).toEqual([
      'APPROVED',
      'WITHDRAWN',
    ]);
  });

  it('PH7/WR2/WR3 the handoff holds the review first: it is created, the withdrawal waits and follows, the next handoff is refused', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    let withdrawal: Promise<string> | undefined;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (release = resolve));
    // the withdrawal is asked for while the handoff holds the review: it
    // reaches its own hold of that row, which waits for the handoff
    const withdrawing = hookedService({
      'contentStudioReview.updateMany': async () => release(),
    });
    const on = handoffService({
      'contentStudioApproval.count': async () => {
        withdrawal = outcome(decide(reviewId, 'withdraw', withdrawing.service));
        await reached;
      },
    });
    const handoff = await handOff(revision.id, ORG_A, on);
    expect(await withdrawal).toBe('ok');
    expect(await handoffsOf(revision.id)).toEqual([
      { id: handoff.id, organizationId: ORG_A, userId: USER_A1 },
    ]);
    expect((await approvalRows(reviewId)).map((row) => row.decision)).toEqual([
      'APPROVED',
      'WITHDRAWN',
    ]);
    // the handoff made while approved stays; a new one is refused
    expect(await failure(handOff(revision.id))).toBe('CS_APPROVAL_REQUIRED');
    expect(await handoffsOf(revision.id)).toHaveLength(1);
  });

  it('PH7/M11 a withdrawal asked for after the check never commits between the check and the handoff write', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    let withdrawal: Promise<string> | undefined;
    let settled = false;
    let settledBeforeWrite = false;
    // right before the handoff row is written, a withdrawal is asked for and
    // given a moment: while the handoff holds the review it cannot commit
    // (it waits for the hold); the wait only bounds how long it is given,
    // it never decides what is right
    const on = handoffService({
      'contentStudioHandoff.create': async () => {
        withdrawal = outcome(decide(reviewId, 'withdraw')).then((result) => {
          settled = true;
          return result;
        });
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          withdrawal,
          new Promise((resolve) => (timer = setTimeout(resolve, 1500))),
        ]).finally(() => clearTimeout(timer));
        settledBeforeWrite = settled;
      },
    });
    const handed = await outcome(handOff(revision.id, ORG_A, on));
    expect(await withdrawal).toBe('ok');
    const rows = await handoffsOf(revision.id);
    if (handed === 'ok') {
      // the handoff held the review: the withdrawal came after its write
      expect(rows).toHaveLength(1);
    } else {
      expect(rows).toEqual([]);
    }
    // a handoff is never written once a withdrawal committed after its check
    expect(settledBeforeWrite && handed === 'ok').toBe(false);
  });

  it('PH7 racing at the hold: either the handoff first and the withdrawal after, or the withdrawal and no handoff; never a handoff after a withdrawal', async () => {
    await requireApproval(ORG_A, true);
    const seen = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const { reviewId, revision } = await approvedPackage();
      const both = latch(2);
      const [handed, withdrawal] = await Promise.all([
        outcome(
          handOff(
            revision.id,
            ORG_A,
            handoffService({ 'contentStudioReview.updateMany': () => both() })
          )
        ),
        outcome(
          decide(
            reviewId,
            'withdraw',
            hookedService({ 'contentStudioReview.updateMany': () => both() })
              .service
          )
        ),
      ]);
      expect(withdrawal).toBe('ok');
      const rows = await handoffsOf(revision.id);
      if (handed === 'ok') {
        expect(rows).toHaveLength(1);
      } else {
        expect(handed).toBe('CS_APPROVAL_REQUIRED');
        expect(rows).toEqual([]);
      }
      seen.add(handed);
      // withdrawn from now on, whoever won
      expect(await failure(handOff(revision.id))).toBe('CS_APPROVAL_REQUIRED');
      expect(await handoffsOf(revision.id)).toHaveLength(rows.length);
    }
    expect(
      [...seen].every((o) => ['ok', 'CS_APPROVAL_REQUIRED'].includes(o))
    ).toBe(true);
  });

  it("PH8 another organization's approval is never used, and its policy is its own", async () => {
    const { revision } = await approvedPackage();
    await requireApproval(ORG_B, true);
    // org B names org A's approved revision: not found, nothing written
    const packageId = await packageOf(revision.id);
    expect(
      await failure(
        handoffService().createHandoff({
          organizationId: ORG_B,
          userId: USER_B1,
          packageId,
          revisionId: revision.id,
        })
      )
    ).toBe('CS_NOT_FOUND');
    // org B's own unreviewed revision is refused under org B's policy
    const own = await packageRevision(ORG_B);
    expect(await failure(handOff(own.id, ORG_B))).toBe('CS_APPROVAL_REQUIRED');
    // org A requires nothing: its unreviewed revision is handed off
    const unreviewed = await packageRevision();
    await handOff(unreviewed.id);
    expect(await handoffsOf(revision.id)).toEqual([]);
    expect(await handoffsOf(own.id)).toEqual([]);
    expect(await handoffsOf(unreviewed.id)).toHaveLength(1);
  });
});

// ============================================================================
// P5-08: what authorized a handoff, and the Phase 5 audit guarantees, on the
// real database: the snapshot written in the transaction that holds the
// review, the serialized winner it records, what PostgreSQL itself refuses
// and what the application detects
const handoffRow = (id: string) =>
  client.contentStudioHandoff.findUniqueOrThrow({ where: { id } });
const opened = (id: string, organizationId = ORG_A) =>
  handoffService().resolveHandoff({
    organizationId,
    userId: OWNER[organizationId],
    handoffId: id,
  });
const contiguous = (rows: { sequence: number }[]) =>
  rows.every((row, index) => row.sequence === index + 1);

describe('PA1-PA11. Phase 5 audit guarantees on the real database (P5-08)', () => {
  it('PA1 review transitions racing each other keep a contiguous, legal state history', async () => {
    for (let round = 0; round < 4; round += 1) {
      const revision = await packageRevision();
      const review = await requestReview('PACKAGE_REVISION', revision.id);
      const hold = atHold();
      const [one, two] = await Promise.all([
        outcome(move(review.id, 'start', hold().service)),
        outcome(move(review.id, 'cancel', hold().service)),
      ]);
      expect([one, two].sort()).toEqual(['CS_REVIEW_CONFLICT', 'ok']);
      const events = await eventsOf(review.id);
      const row = await reviewState(review.id);
      expect(contiguous(events)).toBe(true);
      expect(events).toHaveLength(row.version);
      expect(events.map((event) => event.fromState)).toEqual([
        null,
        'REQUESTED',
      ]);
      expect(events[1].toState).toBe(row.state);
      // and the service reads it as intact
      expect(
        (
          await service.listReviews({
            organizationId: ORG_A,
            targetType: 'PACKAGE_REVISION',
            targetRevisionId: revision.id,
            page: 1,
          })
        ).results
      ).toHaveLength(1);
    }
  });

  it('PA2 rounds of concurrent decisions keep the approval sequence 1, 2, 3... and the history legal', async () => {
    const { reviewId } = await reviewOf('package');
    for (let round = 0; round < 3; round += 1) {
      const hold = atHold();
      const results = await Promise.all([
        outcome(decide(reviewId, 'approve', hold().service)),
        outcome(decide(reviewId, 'refuse', hold().service)),
      ]);
      expect(results.filter((result) => result === 'ok')).toHaveLength(1);
      await decide(reviewId, 'withdraw');
    }
    const rows = await approvalRows(reviewId);
    expect(contiguous(rows)).toBe(true);
    expect(rows).toHaveLength(6);
    expect((await service.getApproval({ ...A1, reviewId })).state).toBe(
      'PENDING'
    );
  });

  it('PA3 READY_FOR_APPROVAL against a claim assessment: never ready with a claim that is not verified, and frozen after', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { reviewId } = await reviewOf('grounded', 'IN_REVIEW');
      for (const claimId of [C1, C2]) {
        await service.assessClaim({
          ...A2,
          reviewId,
          claimId,
          status: 'VERIFIED',
          finding: null,
        });
      }
      const hold = atHold();
      await Promise.all([
        outcome(move(reviewId, 'ready-for-approval', hold().service)),
        outcome(
          hold().service.assessClaim({
            ...A2,
            reviewId,
            claimId: C1,
            status: 'NEEDS_REVISION',
            finding: 'Not supported.',
          })
        ),
      ]);
      const { state } = await reviewState(reviewId);
      const claims = await client.contentStudioReviewClaim.findMany({
        where: { reviewId },
      });
      if (state === 'READY_FOR_APPROVAL') {
        expect(claims.every((row) => row.status === 'VERIFIED')).toBe(true);
        expect(
          await failure(
            service.assessClaim({
              ...A2,
              reviewId,
              claimId: C2,
              status: 'NEEDS_REVISION',
              finding: 'Too late.',
            })
          )
        ).toBe('CS_REVIEW_CLAIM_MUTATION_FORBIDDEN');
        expect(
          await client.contentStudioReviewClaim.findMany({
            where: { reviewId },
          })
        ).toEqual(claims);
      } else {
        expect(state).toBe('IN_REVIEW');
      }
    }
  });

  it('PA4 an approval racing a handoff of a pending revision: either refused, or authorized by exactly that approval', async () => {
    await requireApproval(ORG_A, true);
    for (let round = 0; round < 4; round += 1) {
      const { reviewId, revision } = await reviewOf('package');
      const [handed] = await Promise.all([
        outcome(handOff(revision.id)),
        outcome(decide(reviewId, 'approve')),
      ]);
      const rows = await client.contentStudioHandoff.findMany({
        where: { packageRevisionId: revision.id },
      });
      if (handed === 'ok') {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          approvalRequiredAtCreation: true,
          approvalReviewId: reviewId,
          approvalSequence: 1,
        });
      } else {
        expect(handed).toBe('CS_APPROVAL_REQUIRED');
        expect(rows).toEqual([]);
      }
    }
  });

  it('PA5/HAS2-HAS4 the handoff holds the review first: it keeps the APPROVED decision it was judged on, the withdrawal follows it', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    let withdrawal: Promise<string> | undefined;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (release = resolve));
    const withdrawing = hookedService({
      'contentStudioReview.updateMany': async () => release(),
    });
    // M16/M20: anything the handoff reads or writes of it outside its
    // transaction only comes after the withdrawal committed
    const on = handoffService(
      {
        'contentStudioApproval.findFirst': async () => {
          withdrawal = outcome(
            decide(reviewId, 'withdraw', withdrawing.service)
          );
          await reached;
        },
      },
      service,
      {
        'contentStudioApproval.findFirst': async () => {
          await withdrawal;
        },
        'contentStudioApproval.findMany': async () => {
          await withdrawal;
        },
        'contentStudioHandoff.updateMany': async () => {
          await withdrawal;
        },
      }
    );
    const handoff = await handOff(revision.id, ORG_A, on);
    expect(await withdrawal).toBe('ok');
    expect(await handoffRow(handoff.id)).toMatchObject({
      approvalRequiredAtCreation: true,
      approvalReviewId: reviewId,
      approvalSequence: 1,
      approvalContentHash: revision.contentHash,
    });
    expect((await approvalRows(reviewId)).map((row) => row.decision)).toEqual([
      'APPROVED',
      'WITHDRAWN',
    ]);
    expect((await opened(handoff.id)).approvalAuthorization).toEqual({
      status: 'APPROVED',
      reviewId,
      approvalSequence: 1,
      targetContentHash: revision.contentHash,
    });
  });

  it('PA5 racing at the hold: every handoff written records the APPROVED decision before the withdrawal, never a later one', async () => {
    await requireApproval(ORG_A, true);
    for (let round = 0; round < 5; round += 1) {
      const { reviewId, revision } = await approvedPackage();
      const both = latch(2);
      const [handed, withdrawn] = await Promise.all([
        outcome(
          handOff(
            revision.id,
            ORG_A,
            handoffService({ 'contentStudioReview.updateMany': () => both() })
          )
        ),
        outcome(
          decide(
            reviewId,
            'withdraw',
            hookedService({ 'contentStudioReview.updateMany': () => both() })
              .service
          )
        ),
      ]);
      expect(withdrawn).toBe('ok');
      const rows = await client.contentStudioHandoff.findMany({
        where: { packageRevisionId: revision.id },
      });
      if (handed === 'ok') {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          approvalReviewId: reviewId,
          approvalSequence: 1,
        });
      } else {
        expect(handed).toBe('CS_APPROVAL_REQUIRED');
        expect(rows).toEqual([]);
      }
    }
  });

  it('PA6 simultaneous handoffs of one approved revision all record the same exact authorization', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    await decide(reviewId, 'withdraw');
    await decide(reviewId, 'approve');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => outcome(handOff(revision.id)))
    );
    // a handoff never changes the review, so none of them conflicts
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const rows = await client.contentStudioHandoff.findMany({
      where: { packageRevisionId: revision.id },
    });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatchObject({
        approvalRequiredAtCreation: true,
        approvalReviewId: reviewId,
        approvalSequence: 3,
        approvalContentHash: revision.contentHash,
      });
    }
  });

  it('PA7/HAS6/HAS7/M20 a withdrawal after a committed handoff changes nothing of it; a later approval is its own', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    const first = await handOff(revision.id);
    const before = await handoffRow(first.id);
    await decide(reviewId, 'withdraw');
    expect(await handoffRow(first.id)).toEqual(before);
    expect((await opened(first.id)).approvalAuthorization).toMatchObject({
      status: 'APPROVED',
      approvalSequence: 1,
    });
    expect(await failure(handOff(revision.id))).toBe('CS_APPROVAL_REQUIRED');
    await decide(reviewId, 'approve');
    const second = await handOff(revision.id);
    // opening either never rewrites what authorized it
    await opened(first.id);
    await opened(second.id);
    expect((await handoffRow(first.id)).approvalSequence).toBe(1);
    expect((await handoffRow(second.id)).approvalSequence).toBe(3);
    expect({
      ...(await handoffRow(first.id)),
      openedAt: null,
    }).toEqual({ ...before, openedAt: null });
    // spec 34: the withdrawal revoked nothing; revoking changes no approval
    expect((await handoffRow(first.id)).revokedAt).toBeNull();
    const decisions = await approvalRows(reviewId);
    await handoffService().revokeHandoff({
      ...A1,
      handoffId: first.id,
    });
    expect(await approvalRows(reviewId)).toEqual(decisions);
    expect((await handoffRow(first.id)).approvalSequence).toBe(1);
  });

  it('PA8/TEN9 the snapshot review is bound inside the organization by PostgreSQL itself', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    const handoff = await handOff(revision.id);
    const row = await handoffRow(handoff.id);
    const other = await packageRevision(ORG_B);
    const reviewB = await service.requestReview({
      organizationId: ORG_B,
      userId: USER_B1,
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: other.id,
    });
    const prismaCode = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (err) {
        return (err as Prisma.PrismaClientKnownRequestError).code;
      }
      return 'accepted';
    };
    // a handoff of A naming B's review
    expect(
      await prismaCode(
        client.contentStudioHandoff.create({
          data: { ...row, id: 'f'.repeat(64), approvalReviewId: reviewB.id },
        })
      )
    ).toBe('P2003');
    // a review that does not exist
    expect(
      await prismaCode(
        client.contentStudioHandoff.update({
          where: { id: handoff.id },
          data: { approvalReviewId: randomUUID() },
        })
      )
    ).toBe('P2003');
    // and a review a handoff names cannot be deleted
    expect(
      await prismaCode(
        client.contentStudioReview.delete({ where: { id: reviewId } })
      )
    ).toBe('P2003');
    expect(await handoffRow(handoff.id)).toEqual(row);
  });

  it('PA8 what PostgreSQL does not refuse, the application does: a partial or wrong snapshot fails closed on open', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    await decide(reviewId, 'withdraw');
    await decide(reviewId, 'approve');
    for (const [data, code] of [
      [{ approvalContentHash: null }, 'CS_STORED_HANDOFF_INVALID'],
      [{ approvalRequiredAtCreation: null }, 'CS_STORED_HANDOFF_INVALID'],
      [{ approvalRequiredAtCreation: false }, 'CS_STORED_HANDOFF_INVALID'],
      [{ approvalSequence: 0 }, 'CS_STORED_HANDOFF_INVALID'],
      // HAS9: the WITHDRAWN decision, one beyond the history, another hash
      [{ approvalSequence: 2 }, 'CS_APPROVAL_INTEGRITY_ERROR'],
      [{ approvalSequence: 9 }, 'CS_APPROVAL_INTEGRITY_ERROR'],
      [{ approvalContentHash: 'e'.repeat(64) }, 'CS_APPROVAL_INTEGRITY_ERROR'],
    ] as const) {
      const handoff = await handOff(revision.id);
      await client.contentStudioHandoff.update({
        where: { id: handoff.id },
        data,
      });
      expect(await failure(opened(handoff.id))).toBe(code);
      expect((await handoffRow(handoff.id)).openedAt).toBeNull();
    }
  });

  it('PA9 approval history rewritten behind the service: binding, the enforced handoff and the historical open fail closed', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await approvedPackage();
    const handoff = await handOff(revision.id);
    await client.contentStudioApproval.updateMany({
      where: { reviewId },
      data: { targetContentHash: 'e'.repeat(64) },
    });
    for (const run of [
      () =>
        service.getRevisionApprovalStatus({
          organizationId: ORG_A,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: revision.id,
        }),
      () => handOff(revision.id),
      () => opened(handoff.id),
    ]) {
      expect(await failure(run())).toBe('CS_APPROVAL_INTEGRITY_ERROR');
    }
    expect(await handoffsOf(revision.id)).toHaveLength(1);
    // a gap: the first decision renumbered
    const gap = await approvedPackage();
    await client.contentStudioApproval.updateMany({
      where: { reviewId: gap.reviewId },
      data: { sequence: 2 },
    });
    expect(await failure(handOff(gap.revision.id))).toBe(
      'CS_APPROVAL_INTEGRITY_ERROR'
    );
  });

  it('PA10 review history rewritten behind the service: binding, the enforced handoff and the historical open fail closed', async () => {
    await requireApproval(ORG_A, true);
    for (const corrupt of [
      (reviewId: string) =>
        client.contentStudioReviewStateEvent.updateMany({
          where: { reviewId, sequence: 2 },
          data: { fromState: 'IN_REVIEW' },
        }),
      (reviewId: string) =>
        client.contentStudioReviewStateEvent.deleteMany({
          where: { reviewId, sequence: 2 },
        }),
      (reviewId: string) =>
        client.contentStudioReview.update({
          where: { id: reviewId },
          data: { targetContentHash: 'e'.repeat(64) },
        }),
      // ARV1: both targets (PostgreSQL has no check for exactly one)
      async (reviewId: string) => {
        const design = await designRevision();
        await client.contentStudioReview.update({
          where: { id: reviewId },
          data: { designRevisionId: design.id },
        });
      },
    ]) {
      const { reviewId, revision } = await approvedPackage();
      const handoff = await handOff(revision.id);
      await corrupt(reviewId);
      for (const run of [
        () =>
          service.getRevisionApprovalStatus({
            organizationId: ORG_A,
            targetType: 'PACKAGE_REVISION',
            targetRevisionId: revision.id,
          }),
        () => handOff(revision.id),
        () => opened(handoff.id),
      ]) {
        expect(await failure(run())).toBe('CS_REVIEW_INTEGRITY_ERROR');
      }
      expect(await handoffsOf(revision.id)).toHaveLength(1);
    }
  });

  it('PA10/ARV8 a review can only bind a revision of its own organization: PostgreSQL refuses another one', async () => {
    const { reviewId } = await approvedPackage();
    const foreign = await packageRevision(ORG_B);
    await expect(
      client.contentStudioReview.update({
        where: { id: reviewId },
        data: { packageRevisionId: foreign.id },
      })
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('PA9/ACL8 evidence rewritten behind the service: the enforced handoff fails closed as an integrity error', async () => {
    await requireApproval(ORG_A, true);
    const { reviewId, revision } = await reviewOf('grounded');
    await decide(reviewId, 'approve');
    const handoff = await handOff(revision.id);
    await client.contentStudioSourceVersion.updateMany({
      where: { organizationId: ORG_A },
      data: { contentHash: 'e'.repeat(64) },
    });
    expect(await failure(handOff(revision.id))).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    // what authorized the earlier one is unchanged history
    expect((await opened(handoff.id)).approvalAuthorization).toMatchObject({
      status: 'APPROVED',
      approvalSequence: 1,
    });
  });

  it('PA11/HAS1 policy off: a handoff with no review records NOT_REQUIRED and no approval metadata', async () => {
    const unreviewed = await packageRevision();
    const handoff = await handOff(unreviewed.id);
    expect(await handoffRow(handoff.id)).toMatchObject({
      approvalRequiredAtCreation: false,
      approvalReviewId: null,
      approvalSequence: null,
      approvalContentHash: null,
    });
    expect((await opened(handoff.id)).approvalAuthorization).toEqual({
      status: 'NOT_REQUIRED',
    });
    // an approved revision handed off with the policy off says the same:
    // approval was not what allowed it
    const { revision } = await approvedPackage();
    const approved = await handOff(revision.id);
    expect((await handoffRow(approved.id)).approvalRequiredAtCreation).toBe(
      false
    );
  });

  it('HAS8/M21 a handoff stored before P5-08 is LEGACY_UNKNOWN, even for an approved revision under a policy that requires approval', async () => {
    const { revision } = await approvedPackage();
    await requireApproval(ORG_A, true);
    const id = 'd'.repeat(64);
    // the row as P5-07 wrote it: no authorization column set
    await client.contentStudioHandoff.create({
      data: {
        id,
        organizationId: ORG_A,
        userId: USER_A1,
        packageId: await packageOf(revision.id),
        packageRevisionId: revision.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await handoffRow(id)).toMatchObject({
      approvalRequiredAtCreation: null,
      approvalReviewId: null,
      approvalSequence: null,
      approvalContentHash: null,
    });
    expect((await opened(id)).approvalAuthorization).toEqual({
      status: 'LEGACY_UNKNOWN',
    });
    // still unknown after opening: nothing was filled in
    expect((await handoffRow(id)).approvalRequiredAtCreation).toBeNull();
  });

  it('TEN10/TEN9 another organization never opens, revokes or authorizes a handoff of this one', async () => {
    await requireApproval(ORG_A, true);
    const { revision } = await approvedPackage();
    const handoff = await handOff(revision.id);
    const B = { organizationId: ORG_B, userId: USER_B1, handoffId: handoff.id };
    expect(await failure(handoffService().resolveHandoff(B))).toBe(
      'CS_NOT_FOUND'
    );
    expect(await failure(handoffService().revokeHandoff(B))).toBe(
      'CS_NOT_FOUND'
    );
    expect((await handoffRow(handoff.id)).revokedAt).toBeNull();
  });
});
