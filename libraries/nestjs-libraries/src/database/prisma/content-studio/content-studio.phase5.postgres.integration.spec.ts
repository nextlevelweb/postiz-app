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

// Phase 5 on a real PostgreSQL (P5-04): reviews, their claim review and
// approval decisions under real concurrent transactions, and (P5-05) the
// approval binding of exact revisions read through the real queries. Opt-in: runs only
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

// A service whose repository runs every transaction on the real client, with
// `hooks[model.method]` awaited right before that call inside it. Counts every
// call of a hooked method that was attempted. Everything else is the real
// client
const hookedService = (hooks: Record<string, () => Promise<void>>) => {
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
