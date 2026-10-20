import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioReviewRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.repository';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  emptyContentPackageDraft,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { parseContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { hashContentPackageClaim } from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';

// Reviews (P5-01) through the real service AND the real repository, on an
// in-memory stand-in for Prisma that keeps what this needs of PostgreSQL:
// the where clauses as written (so a query without organizationId really
// sees another organization), the two unique review targets and the unique
// (reviewId, sequence) as P2002, and transactions that run one at a time and
// roll back on a throw (so a compare-and-swap that lost changes nothing).
// Concurrent requests read before either writes, as two requests would; who
// wins is judged by the final state, never by timing

type Row = Record<string, any>;
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const USER_A = 'user-a';
const USER_A2 = 'user-a2';
const USER_B = 'user-b';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PKG_REV_4 = uuid(4);
const PKG_REV_5 = uuid(5);
const DESIGN_REV_7 = uuid(7);
const DESIGN_REV_8 = uuid(8);
const PKG_REV_B = uuid(40);
const DESIGN_REV_B = uuid(70);
const MISSING = uuid(99);
const SECRET = 'REVIEW_PRIVATE_CONTENT_MARKER_123';

const packageRevision = (id: string, org: string, n: number, text = '') => {
  const draft = parseContentPackageDraft(emptyContentPackageDraft('item-1'));
  draft.copy.global.thread[0].text = text;
  const content = canonicalJson(draft);
  return {
    id,
    organizationId: org,
    packageId: `package-${org}`,
    revisionNumber: n,
    schemaVersion: 1,
    content,
    contentHash: sha256Hex(content),
  };
};
const designRevision = (id: string, org: string, n: number, color: string) => {
  const stored = storedContentStudioDesignDocument(
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
            color: { type: 'literal', value: color },
          },
          layers: [],
        },
      ],
    })
  );
  return {
    id,
    organizationId: org,
    designProjectId: `design-${org}`,
    revisionNumber: n,
    ...stored,
  };
};

// integrity failures are logged with the row id only, never content or a hash
let logged: jest.SpyInstance;
beforeEach(() => {
  logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => {
  for (const [message] of logged.mock.calls) {
    expect(String(message)).not.toMatch(/REVIEW_PRIVATE|[0-9a-f]{64}/);
  }
});

const uniqueError = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

// --- the in-memory database ---
const createDb = () => {
  let tables = {
    review: [] as Row[],
    event: [] as Row[],
    packageRevision: [] as Row[],
    designRevision: [] as Row[],
    comment: [] as Row[],
    revisionRequest: [] as Row[],
    // P5-03B: claim assessments, and the stored source versions evidence
    // names
    claim: [] as Row[],
    sourceVersion: [] as Row[],
    // P5-04: approval decisions
    approval: [] as Row[],
    user: [
      { id: USER_A, name: 'Ann' },
      { id: USER_A2, name: 'Bo' },
      { id: USER_B, name: 'Other' },
    ] as Row[],
  };
  let clock = Date.parse('2026-10-19T10:00:00.000Z');
  const now = () => new Date((clock += 1000));
  const log: { op: string; where?: Row; data?: Row }[] = [];

  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value === undefined) {
        return true;
      }
      if (value && typeof value === 'object' && 'not' in value) {
        return row[key] !== value.not;
      }
      return row[key] === value;
    });
  const person = (id: string | null) => {
    const user = tables.user.find((entry) => entry.id === id);
    return user ? { id: user.id, name: user.name } : null;
  };
  const revisionRef = (table: Row[], id: string | null, org: string) => {
    // the composite relation: the revision with that id IN the organization
    const row = table.find(
      (entry) => entry.id === id && entry.organizationId === org
    );
    return row
      ? {
          id: row.id,
          ...('packageId' in row
            ? { packageId: row.packageId }
            : { designProjectId: row.designProjectId }),
          revisionNumber: row.revisionNumber,
          contentHash: row.contentHash,
        }
      : null;
  };
  const commentView = (row: Row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt ?? null,
    author: person(row.authorUserId),
  });
  const revisionRequestView = (row: Row) => ({
    id: row.id,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolvedByPackageRevisionId: row.resolvedByPackageRevisionId ?? null,
    resolvedByDesignRevisionId: row.resolvedByDesignRevisionId ?? null,
    resolvedByContentHash: row.resolvedByContentHash ?? null,
    requestedBy: person(row.requestedByUserId),
    resolvedBy: person(row.resolvedByUserId ?? null),
    resolvedByPackageRevision: revisionRef(
      tables.packageRevision,
      row.resolvedByPackageRevisionId ?? null,
      row.organizationId
    ),
    resolvedByDesignRevision: revisionRef(
      tables.designRevision,
      row.resolvedByDesignRevisionId ?? null,
      row.organizationId
    ),
  });
  const claimView = (row: Row) => ({
    id: row.id,
    claimId: row.claimId,
    claimContentHash: row.claimContentHash,
    status: row.status,
    finding: row.finding ?? null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewedBy: person(row.reviewedByUserId ?? null),
  });
  const approvalView = (row: Row) => ({
    id: row.id,
    sequence: row.sequence,
    decision: row.decision,
    packageRevisionId: row.packageRevisionId,
    designRevisionId: row.designRevisionId,
    targetContentHash: row.targetContentHash,
    actorUserId: row.actorUserId,
    note: row.note,
    createdAt: row.createdAt,
    actorUser: person(row.actorUserId),
  });
  const update = (rows: Row[], data: Row) => {
    for (const row of rows) {
      for (const [key, value] of Object.entries(data)) {
        row[key] =
          value && typeof value === 'object' && 'increment' in value
            ? row[key] + (value as Row).increment
            : value;
      }
    }
  };
  const reviewView = (row: Row) => ({
    id: row.id,
    packageRevisionId: row.packageRevisionId,
    designRevisionId: row.designRevisionId,
    targetContentHash: row.targetContentHash,
    state: row.state,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    requestedBy: person(row.requestedById),
    packageRevision: revisionRef(
      tables.packageRevision,
      row.packageRevisionId,
      row.organizationId
    ),
    designRevision: revisionRef(
      tables.designRevision,
      row.designRevisionId,
      row.organizationId
    ),
    stateEvents: tables.event
      .filter(
        (event) =>
          event.reviewId === row.id &&
          event.organizationId === row.organizationId
      )
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => ({
        sequence: event.sequence,
        fromState: event.fromState,
        toState: event.toState,
        createdAt: event.createdAt,
        actorUser: person(event.actorUserId),
      })),
  });
  const pick = (row: Row, select: Row) =>
    Object.fromEntries(
      Object.keys(select).map((key) => [key, row[key]] as const)
    );

  const model = {
    contentStudioReview: {
      findFirst: async (args: Row) => {
        log.push({ op: 'review.findFirst', where: args.where });
        const row = tables.review.find((entry) => matches(entry, args.where));
        return row ? reviewView(row) : null;
      },
      findMany: async (args: Row) => {
        log.push({ op: 'review.findMany', where: args.where });
        expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
        return tables.review
          .filter((entry) => matches(entry, args.where))
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              a.id.localeCompare(b.id)
          )
          .slice(args.skip, args.skip + args.take)
          .map(reviewView);
      },
      count: async (args: Row) => {
        log.push({ op: 'review.count', where: args.where });
        return tables.review.filter((entry) => matches(entry, args.where))
          .length;
      },
      create: async (args: Row) => {
        log.push({ op: 'review.create', data: args.data });
        const data = args.data;
        if (
          tables.review.some(
            (entry) =>
              entry.organizationId === data.organizationId &&
              ((data.packageRevisionId !== null &&
                entry.packageRevisionId === data.packageRevisionId) ||
                (data.designRevisionId !== null &&
                  entry.designRevisionId === data.designRevisionId))
          )
        ) {
          throw uniqueError();
        }
        const at = now();
        const row = { ...data, createdAt: at, updatedAt: at };
        tables.review.push(row);
        return { id: row.id };
      },
      updateMany: async (args: Row) => {
        log.push({
          op: 'review.updateMany',
          where: args.where,
          data: args.data,
        });
        const rows = tables.review.filter((entry) =>
          matches(entry, args.where)
        );
        update(rows, args.data);
        for (const row of rows) {
          row.updatedAt = now();
        }
        return { count: rows.length };
      },
    },
    contentStudioReviewComment: {
      findFirst: async (args: Row) => {
        log.push({ op: 'comment.findFirst', where: args.where });
        const row = tables.comment.find((entry) => matches(entry, args.where));
        return row ? commentView(row) : null;
      },
      findMany: async (args: Row) => {
        log.push({ op: 'comment.findMany', where: args.where });
        expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
        return tables.comment
          .filter((entry) => matches(entry, args.where))
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id)
          )
          .slice(args.skip, args.skip + args.take)
          .map(commentView);
      },
      count: async (args: Row) => {
        log.push({ op: 'comment.count', where: args.where });
        return tables.comment.filter((entry) => matches(entry, args.where))
          .length;
      },
      create: async (args: Row) => {
        log.push({ op: 'comment.create', data: args.data });
        tables.comment.push({ ...args.data, createdAt: now(), editedAt: null });
        return { id: args.data.id };
      },
      updateMany: async (args: Row) => {
        log.push({
          op: 'comment.updateMany',
          where: args.where,
          data: args.data,
        });
        const rows = tables.comment.filter((entry) =>
          matches(entry, args.where)
        );
        update(rows, args.data);
        return { count: rows.length };
      },
    },
    contentStudioReviewRevisionRequest: {
      findFirst: async (args: Row) => {
        log.push({ op: 'revisionRequest.findFirst', where: args.where });
        const row = tables.revisionRequest.find((entry) =>
          matches(entry, args.where)
        );
        return row ? revisionRequestView(row) : null;
      },
      create: async (args: Row) => {
        log.push({ op: 'revisionRequest.create', data: args.data });
        const data = args.data;
        // unique (reviewId, organizationId): one per review
        if (
          tables.revisionRequest.some(
            (entry) =>
              entry.reviewId === data.reviewId &&
              entry.organizationId === data.organizationId
          )
        ) {
          throw uniqueError();
        }
        tables.revisionRequest.push({
          resolvedByUserId: null,
          resolvedAt: null,
          resolvedByPackageRevisionId: null,
          resolvedByDesignRevisionId: null,
          resolvedByContentHash: null,
          ...data,
          createdAt: now(),
        });
        return { id: data.id };
      },
      updateMany: async (args: Row) => {
        log.push({
          op: 'revisionRequest.updateMany',
          where: args.where,
          data: args.data,
        });
        const rows = tables.revisionRequest.filter((entry) =>
          matches(entry, args.where)
        );
        update(rows, args.data);
        return { count: rows.length };
      },
    },
    contentStudioReviewClaim: {
      findMany: async (args: Row) => {
        log.push({ op: 'claim.findMany', where: args.where });
        expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
        return tables.claim
          .filter((entry) => matches(entry, args.where))
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id)
          )
          .map(claimView);
      },
      updateMany: async (args: Row) => {
        log.push({
          op: 'claim.updateMany',
          where: args.where,
          data: args.data,
        });
        const rows = tables.claim.filter((entry) => matches(entry, args.where));
        update(rows, args.data);
        for (const row of rows) {
          row.updatedAt = now();
        }
        return { count: rows.length };
      },
      create: async (args: Row) => {
        log.push({ op: 'claim.create', data: args.data });
        const data = args.data;
        // unique (reviewId, organizationId, claimId)
        if (
          tables.claim.some(
            (entry) =>
              entry.reviewId === data.reviewId &&
              entry.organizationId === data.organizationId &&
              entry.claimId === data.claimId
          )
        ) {
          throw uniqueError();
        }
        const at = now();
        tables.claim.push({
          id: `claim-row-${tables.claim.length + 1}`,
          ...data,
          createdAt: at,
          updatedAt: at,
        });
        return { id: 'claim-row' };
      },
    },
    contentStudioApproval: {
      findMany: async (args: Row) => {
        log.push({ op: 'approval.findMany', where: args.where });
        expect(args.orderBy).toEqual({ sequence: 'asc' });
        return tables.approval
          .filter((entry) => matches(entry, args.where))
          .sort((a, b) => a.sequence - b.sequence)
          .map(approvalView);
      },
      create: async (args: Row) => {
        log.push({ op: 'approval.create', data: args.data });
        const data = args.data;
        // unique (reviewId, sequence)
        if (
          tables.approval.some(
            (entry) =>
              entry.reviewId === data.reviewId &&
              entry.sequence === data.sequence
          )
        ) {
          throw uniqueError();
        }
        tables.approval.push({
          id: uuid(9000 + tables.approval.length),
          ...data,
          createdAt: now(),
        });
        return { id: 'approval' };
      },
    },
    contentStudioReviewStateEvent: {
      create: async (args: Row) => {
        log.push({ op: 'event.create', data: args.data });
        const data = args.data;
        if (
          tables.event.some(
            (entry) =>
              entry.reviewId === data.reviewId &&
              entry.sequence === data.sequence
          )
        ) {
          throw uniqueError();
        }
        tables.event.push({
          ...data,
          id: `event-${tables.event.length}`,
          createdAt: now(),
        });
        return { id: 'event' };
      },
    },
    contentPackageRevision: {
      findFirst: async (args: Row) => {
        log.push({ op: 'packageRevision.findFirst', where: args.where });
        const row = tables.packageRevision.find((entry) =>
          matches(entry, args.where)
        );
        return row ? pick(row, args.select) : null;
      },
    },
    contentStudioDesignRevision: {
      findFirst: async (args: Row) => {
        log.push({ op: 'designRevision.findFirst', where: args.where });
        const row = tables.designRevision.find((entry) =>
          matches(entry, args.where)
        );
        return row ? pick(row, args.select) : null;
      },
    },
  };

  // one transaction at a time; a throw restores every table
  let queue: Promise<unknown> = Promise.resolve();
  const $transaction = (fn: (tx: typeof model) => Promise<unknown>) => {
    const run = queue.then(async () => {
      const snapshot = JSON.parse(JSON.stringify(tables), (key, value) =>
        /At$/.test(key) && typeof value === 'string' ? new Date(value) : value
      );
      try {
        return await fn(model);
      } catch (err) {
        tables = snapshot;
        throw err;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const prisma = { ...model, $transaction };
  const repository = new ContentStudioReviewRepository(
    { model: prisma } as unknown as PrismaRepository<'contentStudioReview'>,
    { model: prisma } as unknown as PrismaRepository<'contentPackageRevision'>,
    {
      model: prisma,
    } as unknown as PrismaRepository<'contentStudioDesignRevision'>,
    {
      model: prisma,
    } as unknown as PrismaRepository<'contentStudioReviewComment'>,
    {
      model: prisma,
    } as unknown as PrismaRepository<'contentStudioReviewRevisionRequest'>,
    {
      model: prisma,
    } as unknown as PrismaRepository<'contentStudioReviewClaim'>,
    { model: prisma } as unknown as PrismaRepository<'contentStudioApproval'>,
    { model: prisma } as unknown as PrismaTransaction
  );
  // the real grounding service, on stored source versions only: the one
  // query it makes is organization-scoped and by exact version id
  const sources = {
    getVersionsByIdsForOrganization: async (
      organizationId: string,
      ids: string[]
    ) => {
      log.push({
        op: 'sourceVersion.findMany',
        where: { organizationId, ids },
      });
      return tables.sourceVersion
        .filter(
          (entry) =>
            entry.organizationId === organizationId && ids.includes(entry.id)
        )
        .map(({ organizationId: _org, sourceName, ...rest }) => ({
          ...rest,
          source: { name: sourceName },
        }));
    },
  };
  const grounding = new ContentStudioGroundingService(
    sources as unknown as ContentStudioSourceRepository
  );
  const service = new ContentStudioReviewService(repository, grounding);
  return {
    get tables() {
      return tables;
    },
    log,
    repository,
    service,
  };
};

const seeded = () => {
  const db = createDb();
  db.tables.packageRevision.push(
    packageRevision(PKG_REV_4, ORG_A, 4, `v4 ${SECRET}`),
    packageRevision(PKG_REV_5, ORG_A, 5, 'v5'),
    packageRevision(PKG_REV_B, ORG_B, 1, 'other')
  );
  db.tables.designRevision.push(
    designRevision(DESIGN_REV_7, ORG_A, 7, '#ffffff'),
    designRevision(DESIGN_REV_8, ORG_A, 8, '#000000'),
    designRevision(DESIGN_REV_B, ORG_B, 1, '#ff0000')
  );
  return db;
};

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const response = (err as HttpException).getResponse() as Row;
    expect(JSON.stringify(response)).not.toMatch(
      /REVIEW_PRIVATE|org-b|user-b|P2002|prisma/i
    );
    return { status: (err as HttpException).getStatus(), code: response.code };
  }
  throw new Error('expected a failure');
};

const request = (
  db: ReturnType<typeof createDb>,
  targetType: string,
  targetRevisionId: string,
  org = ORG_A,
  user = USER_A
) =>
  db.service.requestReview({
    organizationId: org,
    userId: user,
    targetType,
    targetRevisionId,
  });
// request changes always carries its revision request (P5-02)
const CHANGES = 'Change the call to action.';
const act = (
  db: ReturnType<typeof createDb>,
  id: string,
  action: 'start' | 'request-changes' | 'ready-for-approval' | 'cancel',
  org = ORG_A,
  user = USER_A
) =>
  action === 'request-changes'
    ? db.service.requestChanges({
        organizationId: org,
        userId: user,
        id,
        body: CHANGES,
      })
    : db.service.transitionReview({
        organizationId: org,
        userId: user,
        id,
        action,
      });
const snapshot = (db: ReturnType<typeof createDb>) =>
  JSON.stringify({
    review: db.tables.review,
    event: db.tables.event,
    comment: db.tables.comment,
    revisionRequest: db.tables.revisionRequest,
    claim: db.tables.claim,
    approval: db.tables.approval,
  });

describe('ContentStudioReviewService: requesting a review', () => {
  it('RC1/RH1 a package revision gets a REQUESTED review bound to it and its stored hash', async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    const stored = db.tables.packageRevision[0];
    expect(review).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: PKG_REV_4,
      targetRevisionNumber: 4,
      targetContentHash: stored.contentHash,
      state: 'REQUESTED',
      version: 1,
      requestedBy: { id: USER_A, name: 'Ann' },
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      events: [
        {
          sequence: 1,
          fromState: null,
          toState: 'REQUESTED',
          actor: { id: USER_A, name: 'Ann' },
          createdAt: expect.any(Date),
        },
      ],
    });
    expect(db.tables.review).toEqual([
      expect.objectContaining({
        organizationId: ORG_A,
        packageRevisionId: PKG_REV_4,
        designRevisionId: null,
        targetContentHash: stored.contentHash,
        state: 'REQUESTED',
        version: 1,
        requestedById: USER_A,
      }),
    ]);
    // the review holds no content: only the revision id and its hash
    expect(JSON.stringify(db.tables.review)).not.toContain(SECRET);
    expect(JSON.stringify(review)).not.toContain(SECRET);
    expect(Object.keys(db.tables.review[0]).sort()).toEqual([
      'createdAt',
      'designRevisionId',
      'id',
      'organizationId',
      'packageRevisionId',
      'requestedById',
      'state',
      'targetContentHash',
      'updatedAt',
      'version',
    ]);
  });

  it('RC2/RH2 a design revision gets a REQUESTED review bound to it and its stored hash', async () => {
    const db = seeded();
    const review = await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    const stored = db.tables.designRevision[0];
    expect(review).toMatchObject({
      targetType: 'DESIGN_REVISION',
      targetRevisionId: DESIGN_REV_7,
      targetRevisionNumber: 7,
      targetContentHash: stored.contentHash,
      state: 'REQUESTED',
      version: 1,
    });
    expect(db.tables.review[0]).toMatchObject({
      packageRevisionId: null,
      designRevisionId: DESIGN_REV_7,
    });
    expect(JSON.stringify(review)).not.toContain('"pages"');
  });

  it('RC3/RH3 the hash is read from the revision; anything else the caller passes is ignored', async () => {
    const db = seeded();
    const review = await db.service.requestReview({
      organizationId: ORG_A,
      userId: USER_A,
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: PKG_REV_4,
      ...({
        contentHash: 'f'.repeat(64),
        targetContentHash: 'e'.repeat(64),
        state: 'READY_FOR_APPROVAL',
        version: 9,
      } as object),
    });
    expect(review.targetContentHash).toBe(
      db.tables.packageRevision[0].contentHash
    );
    expect(review.state).toBe('REQUESTED');
    expect(review.version).toBe(1);
  });

  it('RC4/RE1/RE2 writes the review and event 1 in one transaction: a failed event leaves no review', async () => {
    const db = seeded();
    await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    expect(db.tables.event).toEqual([
      expect.objectContaining({
        organizationId: ORG_A,
        sequence: 1,
        fromState: null,
        toState: 'REQUESTED',
        actorUserId: USER_A,
      }),
    ]);
    // an event that cannot be written takes the review with it
    const broken = seeded();
    const eventCreate = (broken.repository as any)._transaction.model
      .contentStudioReviewStateEvent;
    const original = eventCreate.create;
    eventCreate.create = async () => {
      throw new Error('event write failed');
    };
    await expect(
      request(broken, 'DESIGN_REVISION', DESIGN_REV_7)
    ).rejects.toThrow('event write failed');
    eventCreate.create = original;
    expect(broken.tables.review).toEqual([]);
  });

  it('RC5/RC6/RE5 the organization and the requester are the ones the request is made for', async () => {
    const db = seeded();
    const review = await request(
      db,
      'DESIGN_REVISION',
      DESIGN_REV_7,
      ORG_A,
      USER_A2
    );
    expect(review.requestedBy).toEqual({ id: USER_A2, name: 'Bo' });
    expect(review.events[0].actor).toEqual({ id: USER_A2, name: 'Bo' });
    expect(db.tables.review[0].organizationId).toBe(ORG_A);
    expect(db.tables.event[0].organizationId).toBe(ORG_A);
    expect(db.tables.event[0].actorUserId).toBe(USER_A2);
  });

  it('RC7 a second review of the same package revision is CS_REVIEW_ALREADY_EXISTS; nothing is added', async () => {
    const db = seeded();
    await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    const before = snapshot(db);
    expect(
      await code(request(db, 'PACKAGE_REVISION', PKG_REV_4, ORG_A, USER_A2))
    ).toEqual({ status: 409, code: 'CS_REVIEW_ALREADY_EXISTS' });
    expect(snapshot(db)).toBe(before);
  });

  it('RC8 a second review of the same design revision is CS_REVIEW_ALREADY_EXISTS, even after the first ended', async () => {
    const db = seeded();
    const first = await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    await act(db, first.id, 'cancel');
    const before = snapshot(db);
    expect(await code(request(db, 'DESIGN_REVISION', DESIGN_REV_7))).toEqual({
      status: 409,
      code: 'CS_REVIEW_ALREADY_EXISTS',
    });
    expect(snapshot(db)).toBe(before);
  });

  it('RC9 package and design reviews are separate reviews of separate revisions', async () => {
    const db = seeded();
    const a = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    const b = await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    expect(a.id).not.toBe(b.id);
    expect(db.tables.review).toHaveLength(2);
    // a design revision id is no package revision: not found, nothing added
    expect(await code(request(db, 'PACKAGE_REVISION', DESIGN_REV_8))).toEqual({
      status: 404,
      code: 'CS_REVIEW_TARGET_NOT_FOUND',
    });
    expect(await code(request(db, 'DESIGN_REVISION', PKG_REV_5))).toEqual({
      status: 404,
      code: 'CS_REVIEW_TARGET_NOT_FOUND',
    });
    expect(db.tables.review).toHaveLength(2);
  });

  it('RC10/RSEC1/RSEC2 a missing, malformed or foreign revision is the same 404, and nothing is written', async () => {
    const db = seeded();
    const results = [];
    for (const [type, id] of [
      ['PACKAGE_REVISION', MISSING],
      ['PACKAGE_REVISION', PKG_REV_B],
      ['PACKAGE_REVISION', 'not-a-uuid'],
      ['DESIGN_REVISION', MISSING],
      ['DESIGN_REVISION', DESIGN_REV_B],
    ]) {
      results.push(await code(request(db, type, id)));
    }
    expect(results).toEqual(
      Array(5).fill({ status: 404, code: 'CS_REVIEW_TARGET_NOT_FOUND' })
    );
    expect(db.tables.review).toEqual([]);
    expect(db.tables.event).toEqual([]);
    // every revision lookup was inside the organization
    for (const entry of db.log.filter((e) =>
      /Revision\.findFirst/.test(e.op)
    )) {
      expect(entry.where).toEqual({
        id: expect.any(String),
        organizationId: ORG_A,
      });
    }
  });

  it('RC11/RC12 a review binds exactly one revision: no target type, both or neither is refused', async () => {
    const db = seeded();
    for (const targetType of [
      undefined,
      'BOTH',
      'PACKAGE',
      'DESIGN',
      '',
      'PACKAGE_REVISION,DESIGN_REVISION',
    ]) {
      expect(await code(request(db, targetType as string, PKG_REV_4))).toEqual({
        status: 400,
        code: 'CS_INVALID_REQUEST',
      });
    }
    expect(
      await code(
        db.service.requestReview({
          organizationId: ORG_A,
          userId: USER_A,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: [PKG_REV_4, DESIGN_REV_7],
        })
      )
    ).toEqual({ status: 400, code: 'CS_INVALID_REQUEST' });
    expect(db.tables.review).toEqual([]);
    // what the repository was asked to write: one id and one null
    await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    const created = db.log.filter((e) => e.op === 'review.create');
    expect(
      created.map((e) => [e.data!.packageRevisionId, e.data!.designRevisionId])
    ).toEqual([
      [PKG_REV_4, null],
      [null, DESIGN_REV_7],
    ]);
  });

  it('a corrupt target revision is refused as an integrity error, never reviewed', async () => {
    const db = seeded();
    db.tables.packageRevision[1].content =
      db.tables.packageRevision[1].content.replace('v5', 'v6');
    expect(await code(request(db, 'PACKAGE_REVISION', PKG_REV_5))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    db.tables.designRevision[1].contentHash = 'a'.repeat(64);
    expect(await code(request(db, 'DESIGN_REVISION', DESIGN_REV_8))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    expect(db.tables.review).toEqual([]);
  });
});

describe('ContentStudioReviewService: state transitions', () => {
  const started = async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    return { db, review };
  };

  it('RT1/RT2/RT3/RE3 start moves REQUESTED to IN_REVIEW, version 2, event 2', async () => {
    const { db, review } = await started();
    const next = await act(db, review.id, 'start', ORG_A, USER_A2);
    expect(next.state).toBe('IN_REVIEW');
    expect(next.version).toBe(2);
    expect(
      next.events.map((e) => [e.sequence, e.fromState, e.toState, e.actor.id])
    ).toEqual([
      [1, null, 'REQUESTED', USER_A],
      [2, 'REQUESTED', 'IN_REVIEW', USER_A2],
    ]);
    expect(db.tables.review[0]).toMatchObject({
      state: 'IN_REVIEW',
      version: 2,
    });
    expect(db.tables.event).toHaveLength(2);
  });

  it('RT4 request changes moves IN_REVIEW to CHANGES_REQUESTED (with its revision request: P5-02)', async () => {
    const { db, review } = await started();
    await act(db, review.id, 'start');
    const next = await act(db, review.id, 'request-changes');
    expect(next).toMatchObject({ state: 'CHANGES_REQUESTED', version: 3 });
    expect(next.events[2]).toMatchObject({
      sequence: 3,
      fromState: 'IN_REVIEW',
      toState: 'CHANGES_REQUESTED',
    });
    expect(Object.keys(db.tables.event[2]).sort()).toEqual([
      'actorUserId',
      'createdAt',
      'fromState',
      'id',
      'organizationId',
      'reviewId',
      'sequence',
      'toState',
    ]);
  });

  it('RT5 ready for approval moves IN_REVIEW to READY_FOR_APPROVAL (not approved)', async () => {
    const { db, review } = await started();
    await act(db, review.id, 'start');
    const next = await act(db, review.id, 'ready-for-approval');
    expect(next).toMatchObject({ state: 'READY_FOR_APPROVAL', version: 3 });
    expect(JSON.stringify(next)).not.toMatch(/approved/i);
  });

  it('RT6 cancel from REQUESTED', async () => {
    const { db, review } = await started();
    const next = await act(db, review.id, 'cancel');
    expect(next).toMatchObject({ state: 'CANCELLED', version: 2 });
    expect(next.events[1]).toMatchObject({
      fromState: 'REQUESTED',
      toState: 'CANCELLED',
    });
  });

  it('RT7 cancel from IN_REVIEW', async () => {
    const { db, review } = await started();
    await act(db, review.id, 'start');
    const next = await act(db, review.id, 'cancel');
    expect(next).toMatchObject({ state: 'CANCELLED', version: 3 });
  });

  it('RT8 an illegal transition is CS_REVIEW_INVALID_TRANSITION and changes nothing', async () => {
    const { db, review } = await started();
    const before = snapshot(db);
    for (const action of ['ready-for-approval', 'request-changes'] as const) {
      expect(await code(act(db, review.id, action))).toEqual({
        status: 409,
        code: 'CS_REVIEW_INVALID_TRANSITION',
      });
    }
    expect(snapshot(db)).toBe(before);
    expect(db.log.some((e) => e.op === 'review.updateMany')).toBe(false);
  });

  it('RT9 a final state takes no transition at all', async () => {
    for (const end of [
      'request-changes',
      'ready-for-approval',
      'cancel',
    ] as const) {
      const { db, review } = await started();
      await act(db, review.id, 'start');
      await act(db, review.id, end);
      const before = snapshot(db);
      for (const action of [
        'start',
        'request-changes',
        'ready-for-approval',
        'cancel',
      ] as const) {
        expect(await code(act(db, review.id, action))).toEqual({
          status: 409,
          code: 'CS_REVIEW_INVALID_TRANSITION',
        });
      }
      expect(snapshot(db)).toBe(before);
    }
  });

  it('RT10/RE4/RE6/RE7 the target never changes; state, version and the last event always agree', async () => {
    const { db, review } = await started();
    const target = () =>
      JSON.stringify([
        db.tables.review[0].packageRevisionId,
        db.tables.review[0].designRevisionId,
        db.tables.review[0].targetContentHash,
      ]);
    const bound = target();
    await act(db, review.id, 'start');
    expect(target()).toBe(bound);
    const done = await act(db, review.id, 'ready-for-approval');
    expect(target()).toBe(bound);
    expect(done.targetRevisionId).toBe(PKG_REV_4);
    expect(done.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(done.events[done.events.length - 1].toState).toBe(done.state);
    expect(done.events[done.events.length - 1].sequence).toBe(done.version);
    // only the state and the version are ever written by a transition
    for (const entry of db.log.filter((e) => e.op === 'review.updateMany')) {
      expect(Object.keys(entry.data!).sort()).toEqual(['state', 'version']);
      expect(entry.data!.version).toEqual({ increment: 1 });
    }
  });

  it('RSEC4-RSEC7 another organization cannot move a review: the same 404 as a missing one, nothing changes', async () => {
    const { db, review } = await started();
    const before = snapshot(db);
    for (const action of [
      'start',
      'request-changes',
      'ready-for-approval',
      'cancel',
    ] as const) {
      expect(await code(act(db, review.id, action, ORG_B, USER_B))).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
      });
      expect(await code(act(db, MISSING, action))).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
      });
      expect(await code(act(db, 'not-a-uuid', action))).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
      });
    }
    expect(snapshot(db)).toBe(before);
    for (const entry of db.log.filter((e) => e.op === 'review.findFirst')) {
      expect(entry.where).toEqual({
        id: expect.any(String),
        organizationId: expect.any(String),
      });
    }
  });

  it('RE5 every event actor is the request user, never the requester by default', async () => {
    const { db, review } = await started();
    await act(db, review.id, 'start', ORG_A, USER_A2);
    await act(db, review.id, 'cancel', ORG_A, USER_A);
    expect(db.tables.event.map((e) => e.actorUserId)).toEqual([
      USER_A,
      USER_A2,
      USER_A,
    ]);
  });
});

describe('ContentStudioReviewService: target integrity', () => {
  it('RH4/RH5 a target whose stored hash no longer matches fails closed, and nothing is repaired', async () => {
    const db = seeded();
    const review = await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    // the revision itself rewritten consistently: a valid other revision
    const other = designRevision(DESIGN_REV_7, ORG_A, 7, '#123456');
    Object.assign(db.tables.designRevision[0], other);
    const before = snapshot(db);
    expect(await code(act(db, review.id, 'start'))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    expect(snapshot(db)).toBe(before);
    expect(db.tables.review[0].targetContentHash).toBe(
      review.targetContentHash
    );
    expect(db.tables.review[0].targetContentHash).not.toBe(other.contentHash);
    expect(db.log.some((e) => e.op === 'review.updateMany')).toBe(false);
  });

  it('RH4 the transition re-verifies the revision content, not only the relation', async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    // same stored hash, different bytes
    db.tables.packageRevision[0].content =
      db.tables.packageRevision[0].content.replace('v4', 'v9');
    const before = snapshot(db);
    expect(await code(act(db, review.id, 'start'))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    expect(snapshot(db)).toBe(before);
  });

  it('a malformed binding (both, neither, unknown state, wrong hash, broken history) is an integrity error on read', async () => {
    const corruptions: ((row: Row, db: ReturnType<typeof createDb>) => void)[] =
      [
        (row) => (row.designRevisionId = DESIGN_REV_7),
        (row) => (row.packageRevisionId = null),
        (row) => (row.state = 'APPROVED'),
        (row) => (row.targetContentHash = 'b'.repeat(64)),
        (row) => (row.targetContentHash = 'not-a-hash'),
        (row) => (row.version = 2),
        (row, db) => (db.tables.event[0].fromState = 'IN_REVIEW'),
        (row, db) => db.tables.event.splice(0, 1),
        (row, db) => (row.packageRevisionId = PKG_REV_B),
      ];
    for (const corrupt of corruptions) {
      const db = seeded();
      const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
      corrupt(db.tables.review[0], db);
      const before = snapshot(db);
      expect(await code(act(db, review.id, 'cancel'))).toEqual({
        status: 500,
        code: 'CS_REVIEW_INTEGRITY_ERROR',
      });
      expect(
        await code(db.service.listReviews({ organizationId: ORG_A, page: 1 }))
      ).toEqual({ status: 500, code: 'CS_REVIEW_INTEGRITY_ERROR' });
      expect(snapshot(db)).toBe(before);
    }
  });

  it('a reviewed revision that disappeared fails closed', async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    db.tables.packageRevision.splice(0, 1);
    expect(await code(act(db, review.id, 'start'))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
  });
});

describe('ContentStudioReviewService: concurrency', () => {
  it('CON1 two simultaneous requests for one revision: one review, one REQUESTED event, the other a conflict', async () => {
    const db = seeded();
    const results = await Promise.allSettled([
      request(db, 'PACKAGE_REVISION', PKG_REV_4, ORG_A, USER_A),
      request(db, 'PACKAGE_REVISION', PKG_REV_4, ORG_A, USER_A2),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect((rejected.reason as HttpException).getResponse()).toMatchObject({
      code: 'CS_REVIEW_ALREADY_EXISTS',
    });
    expect(db.tables.review).toHaveLength(1);
    expect(db.tables.event).toHaveLength(1);
    expect(db.tables.event[0]).toMatchObject({
      sequence: 1,
      toState: 'REQUESTED',
    });
  });

  it('CON2/CON3 two simultaneous transitions from REQUESTED: exactly one wins, one event, the loser is CS_REVIEW_CONFLICT', async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    const results = await Promise.allSettled([
      act(db, review.id, 'start', ORG_A, USER_A),
      act(db, review.id, 'cancel', ORG_A, USER_A2),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect((rejected.reason as HttpException).getResponse()).toMatchObject({
      code: 'CS_REVIEW_CONFLICT',
    });
    expect((rejected.reason as HttpException).getStatus()).toBe(409);
    const won = (
      results.find(
        (r) => r.status === 'fulfilled'
      ) as PromiseFulfilledResult<any>
    ).value;
    expect(db.tables.event).toHaveLength(2);
    expect(db.tables.review[0].version).toBe(2);
    expect(db.tables.review[0].state).toBe(won.state);
    expect(db.tables.event[1]).toMatchObject({
      sequence: 2,
      fromState: 'REQUESTED',
      toState: won.state,
    });
    // what is read back is still intact
    const listed = await db.service.listReviews({
      organizationId: ORG_A,
      page: 1,
    });
    expect(listed.results[0]).toMatchObject({ state: won.state, version: 2 });
  });

  it('CON2 the same action twice at once is also one winner and one conflict', async () => {
    const db = seeded();
    const review = await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    const results = await Promise.allSettled([
      act(db, review.id, 'start'),
      act(db, review.id, 'start'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.tables.event.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('the compare-and-swap matches the organization, the read state and the read version, and a loss writes no event', async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    expect(
      await db.repository.transitionReviewWithCompareAndSwap({
        organizationId: ORG_A,
        reviewId: review.id,
        expectedState: 'REQUESTED',
        expectedVersion: 2,
        toState: 'IN_REVIEW',
        actorUserId: USER_A,
      })
    ).toBe(false);
    expect(
      await db.repository.transitionReviewWithCompareAndSwap({
        organizationId: ORG_A,
        reviewId: review.id,
        expectedState: 'IN_REVIEW',
        expectedVersion: 1,
        toState: 'CANCELLED',
        actorUserId: USER_A,
      })
    ).toBe(false);
    expect(
      await db.repository.transitionReviewWithCompareAndSwap({
        organizationId: ORG_B,
        reviewId: review.id,
        expectedState: 'REQUESTED',
        expectedVersion: 1,
        toState: 'IN_REVIEW',
        actorUserId: USER_B,
      })
    ).toBe(false);
    expect(db.tables.event).toHaveLength(1);
    expect(db.tables.review[0]).toMatchObject({
      state: 'REQUESTED',
      version: 1,
    });
    const cas = db.log.filter((e) => e.op === 'review.updateMany');
    expect(cas[0].where).toEqual({
      id: review.id,
      organizationId: ORG_A,
      state: 'REQUESTED',
      version: 2,
    });
  });
});

describe('ContentStudioReviewService: listing', () => {
  const many = async () => {
    const db = seeded();
    const p4 = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    const d7 = await request(db, 'DESIGN_REVISION', DESIGN_REV_7);
    const p5 = await request(db, 'PACKAGE_REVISION', PKG_REV_5);
    await act(db, d7.id, 'start');
    const b = await request(db, 'PACKAGE_REVISION', PKG_REV_B, ORG_B, USER_B);
    return { db, p4, d7, p5, b };
  };

  it("RSEC3 lists the organization's reviews only, newest first", async () => {
    const { db, p4, d7, p5, b } = await many();
    const listed = await db.service.listReviews({
      organizationId: ORG_A,
      page: 1,
    });
    expect(listed.pages).toBe(1);
    expect(listed.results.map((r) => r.id)).toEqual([p5.id, d7.id, p4.id]);
    expect(JSON.stringify(listed)).not.toContain(b.id);
    for (const entry of db.log.filter((e) =>
      /review\.(findMany|count)/.test(e.op)
    )) {
      expect(entry.where!.organizationId).toBeDefined();
    }
  });

  it('filters by target type, exact revision and state', async () => {
    const { db, p4, d7, p5 } = await many();
    const ids = async (filter: Row) =>
      (
        await db.service.listReviews({
          organizationId: ORG_A,
          page: 1,
          ...filter,
        })
      ).results.map((r) => r.id);
    expect(await ids({ targetType: 'PACKAGE_REVISION' })).toEqual([
      p5.id,
      p4.id,
    ]);
    expect(await ids({ targetType: 'DESIGN_REVISION' })).toEqual([d7.id]);
    expect(
      await ids({ targetType: 'PACKAGE_REVISION', targetRevisionId: PKG_REV_4 })
    ).toEqual([p4.id]);
    expect(
      await ids({
        targetType: 'DESIGN_REVISION',
        targetRevisionId: DESIGN_REV_8,
      })
    ).toEqual([]);
    expect(
      await ids({ targetType: 'PACKAGE_REVISION', targetRevisionId: PKG_REV_B })
    ).toEqual([]);
    expect(await ids({ state: 'IN_REVIEW' })).toEqual([d7.id]);
    expect(
      await ids({ state: 'REQUESTED', targetType: 'PACKAGE_REVISION' })
    ).toEqual([p5.id, p4.id]);
  });

  it('refuses a revision id without its target type, an unknown type or state', async () => {
    const { db } = await many();
    for (const filter of [
      { targetRevisionId: PKG_REV_4 },
      { targetType: 'PACKAGE' },
      { state: 'APPROVED' },
      { targetType: 'PACKAGE_REVISION', targetRevisionId: 'nope' },
    ]) {
      expect(
        await code(
          db.service.listReviews({ organizationId: ORG_A, page: 1, ...filter })
        )
      ).toEqual({ status: 400, code: 'CS_INVALID_REQUEST' });
    }
  });

  it('pages by 50', async () => {
    const db = seeded();
    for (let n = 0; n < 51; n++) {
      const id = uuid(1000 + n);
      db.tables.packageRevision.push(packageRevision(id, ORG_A, 10 + n));
      await request(db, 'PACKAGE_REVISION', id);
    }
    const first = await db.service.listReviews({
      organizationId: ORG_A,
      page: 1,
    });
    const second = await db.service.listReviews({
      organizationId: ORG_A,
      page: 2,
    });
    expect(first.pages).toBe(2);
    expect(first.results).toHaveLength(50);
    expect(second.results).toHaveLength(1);
    expect(
      new Set([...first.results, ...second.results].map((r) => r.id)).size
    ).toBe(51);
  });
});

describe('ContentStudioReviewService: newer revisions', () => {
  it('NR1/NR2/NR3/NR4/RH6 a review stays on its revision; the next revision has none until it gets its own', async () => {
    const db = seeded();
    const r4 = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    await act(db, r4.id, 'start');
    await act(db, r4.id, 'request-changes');
    // revision 5 exists already (made after 4): it has no review
    expect(
      (
        await db.service.listReviews({
          organizationId: ORG_A,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: PKG_REV_5,
          page: 1,
        })
      ).results
    ).toEqual([]);
    // a newer revision 6 appears later: nothing moves
    db.tables.packageRevision.push(packageRevision(uuid(6), ORG_A, 6, 'v6'));
    const [old] = (
      await db.service.listReviews({
        organizationId: ORG_A,
        targetType: 'PACKAGE_REVISION',
        targetRevisionId: PKG_REV_4,
        page: 1,
      })
    ).results;
    expect(old).toMatchObject({
      id: r4.id,
      targetRevisionId: PKG_REV_4,
      targetRevisionNumber: 4,
      targetContentHash: r4.targetContentHash,
      state: 'CHANGES_REQUESTED',
    });
    const r5 = await request(db, 'PACKAGE_REVISION', PKG_REV_5);
    expect(r5).toMatchObject({
      state: 'REQUESTED',
      version: 1,
      targetRevisionNumber: 5,
    });
    expect(r5.targetContentHash).not.toBe(r4.targetContentHash);
    expect(db.tables.review.find((r) => r.id === r4.id)).toMatchObject({
      packageRevisionId: PKG_REV_4,
      state: 'CHANGES_REQUESTED',
    });
  });
});

describe('ContentStudioReviewService boundaries', () => {
  const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
  const code = (file: string) => read(file).replace(/\/\/.*$/gm, '');

  it('P501-9/M5/M7/M14 binds revisions only: no package, design, "latest" or project lookup', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      const source = code(file);
      expect(source).not.toMatch(
        /latest|orderBy:\s*\{\s*revisionNumber|contentPackage\.|contentStudioDesignProject|contentStudioDesign\.|where:\s*\{[^}]*(packageId|designProjectId)/i
      );
    }
    // the package or design of a revision is only ever read from the
    // revision itself (P5-02: a resolving revision must share it)
    const repository = code('content-studio.review.repository.ts');
    expect(repository.match(/packageId: true/g)).toHaveLength(3);
    expect(repository.match(/designProjectId: true/g)).toHaveLength(3);
    expect(repository).toMatch(/packageRevisionId: input\.packageRevisionId/);
  });

  it('P501-4/P501-5/M28/P502-1/P502-8/P504-9/P504-10 no approver, reason, reviewer, due date, mention or notification (approval decisions are P5-04)', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      expect(code(file)).not.toMatch(
        /approvedBy|approver|quorum|signature|reason|assign|reviewer|dueAt|deadline|notif|email|slack|mention|reaction|attachment|parentCommentId|replyTo|threadId/i
      );
    }
  });

  it('P501-7/P501-8/58/59 renders nothing, touches no Media, AI, handoff or publishing', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      expect(code(file)).not.toMatch(
        /render|sharp|media|handoff|publish|integration|\bai\b|openai|anthropic|fetch\(/i
      );
    }
  });

  it('M18-M20 every repository query names the organization', () => {
    const source = code('content-studio.review.repository.ts');
    const queries = source
      .split(/\.(?:findFirst|findMany|count|updateMany|create)\(/)
      .slice(1);
    // P5-03B: the claim reads (one inside the READY transition), the hold
    // and the assessment write; P5-04: the approval history read, the hold,
    // the history read inside it and the append
    expect(queries.length).toBe(27);
    for (const query of queries) {
      expect(query.slice(0, 400)).toMatch(/organizationId/);
    }
  });

  it('no delete or event update anywhere', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      expect(code(file)).not.toMatch(
        /\.delete(Many)?\(|stateEvent\.update|contentStudioReviewStateEvent\.update|upsert|contentStudioReviewComment\.delete/
      );
    }
  });
});

// --- the discussion (P5-02): comments and the formal revision request ---

const PKG_REV_3 = uuid(3);
const PKG_REV_6 = uuid(6);
const PKG_REV_OTHER = uuid(9);
const DESIGN_REV_6 = uuid(16);
const DESIGN_REV_9 = uuid(19);
const DESIGN_REV_OTHER = uuid(29);

// revision 3 (older) and 6 (newer) of the same package, 9 of another package
// of the same organization; the same for designs
const discussion = () => {
  const db = seeded();
  db.tables.packageRevision.push(
    packageRevision(PKG_REV_3, ORG_A, 3, 'v3'),
    packageRevision(PKG_REV_6, ORG_A, 6, 'v6'),
    {
      ...packageRevision(PKG_REV_OTHER, ORG_A, 9, 'other package'),
      packageId: 'package-other',
    }
  );
  db.tables.designRevision.push(
    designRevision(DESIGN_REV_6, ORG_A, 6, '#111111'),
    designRevision(DESIGN_REV_9, ORG_A, 9, '#999999'),
    {
      ...designRevision(DESIGN_REV_OTHER, ORG_A, 12, '#222222'),
      designProjectId: 'design-other',
    }
  );
  return db;
};
type Db = ReturnType<typeof createDb>;
const reviewIn = async (
  db: Db,
  state:
    | 'REQUESTED'
    | 'IN_REVIEW'
    | 'CHANGES_REQUESTED'
    | 'READY_FOR_APPROVAL'
    | 'CANCELLED',
  targetType = 'PACKAGE_REVISION',
  revisionId = PKG_REV_4
) => {
  const review = await request(db, targetType, revisionId);
  if (state === 'REQUESTED') {
    return review;
  }
  if (state === 'CANCELLED') {
    return act(db, review.id, 'cancel');
  }
  const started = await act(db, review.id, 'start');
  if (state === 'IN_REVIEW') {
    return started;
  }
  return act(
    db,
    review.id,
    state === 'CHANGES_REQUESTED' ? 'request-changes' : 'ready-for-approval'
  );
};
const say = (
  db: Db,
  reviewId: string,
  body: unknown,
  org = ORG_A,
  user = USER_A
) =>
  db.service.addComment({ organizationId: org, userId: user, reviewId, body });
const edit = (
  db: Db,
  reviewId: string,
  commentId: string,
  body: unknown,
  org = ORG_A,
  user = USER_A
) =>
  db.service.editComment({
    organizationId: org,
    userId: user,
    reviewId,
    commentId,
    body,
  });
const comments = (db: Db, reviewId: string, page = 1, org = ORG_A) =>
  db.service.listComments({ organizationId: org, reviewId, page });
const askChanges = (
  db: Db,
  id: string,
  body: unknown,
  org = ORG_A,
  user = USER_A
) => db.service.requestChanges({ organizationId: org, userId: user, id, body });
const resolve = (
  db: Db,
  reviewId: string,
  resolutionRevisionId: unknown,
  org = ORG_A,
  user = USER_A
) =>
  db.service.resolveRevisionRequest({
    organizationId: org,
    userId: user,
    reviewId,
    resolutionRevisionId,
  });
const revisionRequestOf = (db: Db, reviewId: string, org = ORG_A) =>
  db.service.getRevisionRequest({ organizationId: org, reviewId });
const reviewFacts = (db: Db) =>
  JSON.stringify({
    review: db.tables.review.map((r) => [
      r.id,
      r.state,
      r.version,
      r.packageRevisionId,
      r.designRevisionId,
      r.targetContentHash,
    ]),
    event: db.tables.event,
  });

describe('ContentStudioReviewService: comments', () => {
  it.each([
    ['C1', 'REQUESTED'],
    ['C2', 'IN_REVIEW'],
    ['C3', 'CHANGES_REQUESTED'],
    ['C4', 'READY_FOR_APPROVAL'],
  ] as const)(
    '%s a comment on a %s review is posted, and the review does not move',
    async (_, state) => {
      const db = discussion();
      const review = await reviewIn(db, state);
      const before = reviewFacts(db);
      const comment = await say(db, review.id, 'Can we tighten this intro?');
      expect(comment).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        body: 'Can we tighten this intro?',
        author: { id: USER_A, name: 'Ann' },
        createdAt: expect.any(Date),
        editedAt: null,
      });
      // no state, version, event or target change (38, P502-4)
      expect(reviewFacts(db)).toBe(before);
      expect(db.tables.comment).toEqual([
        {
          id: comment.id,
          organizationId: ORG_A,
          reviewId: review.id,
          authorUserId: USER_A,
          body: 'Can we tighten this intro?',
          createdAt: expect.any(Date),
          editedAt: null,
        },
      ]);
    }
  );

  it('C5 a cancelled review takes no new comment; nothing is written', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CANCELLED');
    const before = snapshot(db);
    const mark = db.log.length;
    expect(await code(say(db, review.id, 'Too late?'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CANCELLED',
    });
    expect(snapshot(db)).toBe(before);
    expect(db.log.some((e) => e.op === 'comment.create')).toBe(false);
    // refused on the state read: no write is even attempted (the hold in the
    // write is the second line, for a cancel that lands in between)
    expect(
      db.log.slice(mark).filter((e) => /updateMany|create/.test(e.op))
    ).toEqual([]);
  });

  it('C6 an empty, blank or non-text comment is CS_REVIEW_COMMENT_INVALID', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    for (const body of [
      '',
      ' ',
      '\n\t \n',
      undefined,
      null,
      42,
      ['text'],
      { body: 'text' },
      'with a \0 inside',
    ]) {
      expect(await code(say(db, review.id, body))).toEqual({
        status: 400,
        code: 'CS_REVIEW_COMMENT_INVALID',
      });
    }
    expect(db.tables.comment).toEqual([]);
  });

  it('C7 a comment is at most 10,000 characters', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    expect(await code(say(db, review.id, 'x'.repeat(10_001)))).toEqual({
      status: 400,
      code: 'CS_REVIEW_COMMENT_INVALID',
    });
    expect((await say(db, review.id, 'x'.repeat(10_000))).body).toHaveLength(
      10_000
    );
  });

  it('C8 keeps the text exactly: inner spaces, blank lines, leading indentation', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const text = '  First line\n\n    indented   line  \n<b>not html</b>\n';
    expect((await say(db, review.id, text)).body).toBe(text);
    expect(db.tables.comment[0].body).toBe(text);
    expect((await comments(db, review.id)).results[0].body).toBe(text);
  });

  it('C9/C10/CSEC6/CSEC7 the author and the organization are the request ones, whatever else is passed', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const comment = await db.service.addComment({
      organizationId: ORG_A,
      userId: USER_A2,
      reviewId: review.id,
      body: 'Looks good.',
      ...({
        authorUserId: USER_B,
        organizationId_: ORG_B,
        createdAt: new Date(0),
        editedAt: new Date(0),
      } as object),
    });
    expect(comment.author).toEqual({ id: USER_A2, name: 'Bo' });
    expect(db.tables.comment[0]).toMatchObject({
      organizationId: ORG_A,
      authorUserId: USER_A2,
      reviewId: review.id,
      editedAt: null,
    });
    expect(
      Object.keys(db.log.find((e) => e.op === 'comment.create')!.data!).sort()
    ).toEqual(['authorUserId', 'body', 'id', 'organizationId', 'reviewId']);
  });

  it('C11 lists oldest first, pages by 50, id breaking ties, and only that review', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const other = await reviewIn(
      db,
      'IN_REVIEW',
      'DESIGN_REVISION',
      DESIGN_REV_7
    );
    await say(db, other.id, 'elsewhere');
    const posted = [];
    for (let n = 0; n < 51; n++) {
      posted.push((await say(db, review.id, `comment ${n}`)).id);
    }
    const first = await comments(db, review.id, 1);
    const second = await comments(db, review.id, 2);
    expect(first.pages).toBe(2);
    expect(first.results).toHaveLength(50);
    expect([...first.results, ...second.results].map((c) => c.id)).toEqual(
      posted
    );
    expect(first.results[0].body).toBe('comment 0');
    expect(JSON.stringify(first)).not.toContain('elsewhere');
    expect(JSON.stringify(first)).not.toMatch(/organizationId|reviewId/);
    // the same instant: id decides
    for (const row of db.tables.comment) {
      row.createdAt = new Date(0);
    }
    const tied = await comments(db, review.id, 1);
    const ids = tied.results.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('C12/C13 the author edits their comment: body replaced, editedAt set, createdAt and author kept', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const comment = await say(db, review.id, 'Frist draft', ORG_A, USER_A2);
    const before = reviewFacts(db);
    const edited = await edit(
      db,
      review.id,
      comment.id,
      'First draft\nwith a second line',
      ORG_A,
      USER_A2
    );
    expect(edited).toEqual({
      id: comment.id,
      body: 'First draft\nwith a second line',
      author: { id: USER_A2, name: 'Bo' },
      createdAt: comment.createdAt,
      editedAt: expect.any(Date),
    });
    expect(db.tables.comment).toHaveLength(1);
    expect(db.tables.comment[0]).toMatchObject({
      authorUserId: USER_A2,
      createdAt: comment.createdAt,
    });
    // only the body and editedAt are written, for the author's own comment
    const write = db.log.find((e) => e.op === 'comment.updateMany')!;
    expect(Object.keys(write.data!).sort()).toEqual(['body', 'editedAt']);
    expect(write.where).toEqual({
      id: comment.id,
      organizationId: ORG_A,
      reviewId: review.id,
      authorUserId: USER_A2,
    });
    expect(reviewFacts(db)).toBe(before);
  });

  it('C14 another member reads the comment but cannot edit it: CS_REVIEW_COMMENT_FORBIDDEN', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const comment = await say(db, review.id, 'Mine', ORG_A, USER_A);
    const before = snapshot(db);
    expect(
      await code(edit(db, review.id, comment.id, 'Hijacked', ORG_A, USER_A2))
    ).toEqual({ status: 403, code: 'CS_REVIEW_COMMENT_FORBIDDEN' });
    expect(snapshot(db)).toBe(before);
    expect(db.log.some((e) => e.op === 'comment.updateMany')).toBe(false);
    expect(
      (await comments(db, review.id, 1)).results.map((c) => c.body)
    ).toEqual(['Mine']);
  });

  it('C15/40 a cancelled review freezes its discussion: no edit, still readable', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'REQUESTED');
    const comment = await say(db, review.id, 'Before the cancel');
    await act(db, review.id, 'cancel');
    const before = snapshot(db);
    expect(await code(edit(db, review.id, comment.id, 'After'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CANCELLED',
    });
    expect(await code(say(db, review.id, 'After'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CANCELLED',
    });
    expect(snapshot(db)).toBe(before);
    expect((await comments(db, review.id)).results).toEqual([
      expect.objectContaining({ body: 'Before the cancel', editedAt: null }),
    ]);
  });

  it('C15 the frozen check holds inside the write: a comment or edit after a committed cancel writes nothing', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const comment = await say(db, review.id, 'Before');
    await act(db, review.id, 'cancel');
    const before = snapshot(db);
    expect(
      await db.repository.createComment({
        id: uuid(500),
        organizationId: ORG_A,
        reviewId: review.id,
        authorUserId: USER_A,
        body: 'Raced in',
      })
    ).toBe(false);
    expect(
      await db.repository.editCommentOfAuthor({
        organizationId: ORG_A,
        reviewId: review.id,
        id: comment.id,
        authorUserId: USER_A,
        body: 'Raced in',
        editedAt: new Date(),
      })
    ).toBe(false);
    expect(snapshot(db)).toBe(before);
    // the hold matches only a review that is not cancelled, in the
    // organization, and writes its version back unchanged
    const holds = db.log.filter(
      (e) => e.op === 'review.updateMany' && e.data!.version?.increment === 0
    );
    expect(holds.length).toBeGreaterThan(0);
    for (const hold of holds) {
      expect(hold.where).toEqual({
        id: review.id,
        organizationId: ORG_A,
        state: { not: 'CANCELLED' },
      });
      expect(hold.data).toEqual({ version: { increment: 0 } });
    }
  });

  it('41 two comments at once both land; a comment racing a cancel either lands before it or not at all', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const both = await Promise.allSettled([
      say(db, review.id, 'one', ORG_A, USER_A),
      say(db, review.id, 'two', ORG_A, USER_A2),
    ]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(db.tables.comment).toHaveLength(2);
    const [posted, cancelled] = await Promise.allSettled([
      say(db, review.id, 'three'),
      act(db, review.id, 'cancel', ORG_A, USER_A2),
    ]);
    expect(cancelled.status).toBe('fulfilled');
    const cancelEvent = db.tables.event.find((e) => e.toState === 'CANCELLED')!;
    if (posted.status === 'fulfilled') {
      expect(posted.value.createdAt.getTime()).toBeLessThan(
        cancelEvent.createdAt.getTime()
      );
    } else {
      expect((posted.reason as HttpException).getResponse()).toMatchObject({
        code: 'CS_REVIEW_CANCELLED',
      });
    }
    for (const row of db.tables.comment) {
      expect(row.createdAt.getTime()).toBeLessThan(
        cancelEvent.createdAt.getTime()
      );
    }
    // the review is still exactly CANCELLED at the version of its history
    expect(db.tables.review[0]).toMatchObject({
      state: 'CANCELLED',
      version: 3,
    });
  });

  it('CSEC1/CSEC2/CSEC3 another organization cannot list, post or edit: the same 404 as a missing review', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const comment = await say(db, review.id, 'Private A note');
    const before = snapshot(db);
    for (const attempt of [
      comments(db, review.id, 1, ORG_B),
      say(db, review.id, 'from B', ORG_B, USER_B),
      edit(db, review.id, comment.id, 'from B', ORG_B, USER_B),
      comments(db, MISSING),
      say(db, 'not-a-uuid', 'x'),
    ]) {
      expect(await code(attempt)).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
      });
    }
    expect(snapshot(db)).toBe(before);
    for (const entry of db.log.filter((e) => /^comment\./.test(e.op))) {
      expect((entry.where ?? entry.data)!.organizationId).toBe(ORG_A);
    }
  });

  it('a comment is only reached through its own review', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const other = await reviewIn(
      db,
      'IN_REVIEW',
      'DESIGN_REVISION',
      DESIGN_REV_7
    );
    const comment = await say(db, review.id, 'On the package');
    const mark = db.log.length;
    for (const commentId of [comment.id, MISSING, 'not-a-uuid']) {
      expect(await code(edit(db, other.id, commentId, 'moved'))).toEqual({
        status: 404,
        code: 'CS_REVIEW_COMMENT_NOT_FOUND',
      });
    }
    expect(db.tables.comment[0].body).toBe('On the package');
    for (const entry of db.log
      .slice(mark)
      .filter((e) => e.op === 'comment.findFirst')) {
      expect(entry.where).toEqual({
        id: expect.any(String),
        organizationId: ORG_A,
        reviewId: other.id,
      });
    }
  });

  it('a malformed stored comment fails closed', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    await say(db, review.id, 'fine');
    db.tables.comment[0].body = null;
    expect(await code(comments(db, review.id))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
  });
});

describe('ContentStudioReviewService: requesting changes', () => {
  it('RR1 request changes needs its description: no body, a non-text body or the plain transition is refused', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const before = snapshot(db);
    const mark = db.log.length;
    for (const body of [undefined, null, 7, ['Change it'], { text: 'x' }]) {
      expect(await code(askChanges(db, review.id, body))).toEqual({
        status: 400,
        code: 'CS_REVIEW_REVISION_REQUEST_INVALID',
      });
    }
    // M6: the bare state change does not exist any more
    expect(
      await code(
        db.service.transitionReview({
          organizationId: ORG_A,
          userId: USER_A,
          id: review.id,
          action: 'request-changes',
        })
      )
    ).toEqual({ status: 400, code: 'CS_REVIEW_REVISION_REQUEST_INVALID' });
    expect(snapshot(db)).toBe(before);
    expect(db.log.slice(mark).some((e) => e.op === 'review.updateMany')).toBe(
      false
    );
  });

  it('RR2/RR3 a blank or oversized description is refused; 20,000 characters is the limit', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    for (const body of ['', '   ', '\n\n\t', 'x'.repeat(20_001), 'a\0b']) {
      expect(await code(askChanges(db, review.id, body))).toEqual({
        status: 400,
        code: 'CS_REVIEW_REVISION_REQUEST_INVALID',
      });
    }
    expect(db.tables.revisionRequest).toEqual([]);
    expect(db.tables.review[0].state).toBe('IN_REVIEW');
    await askChanges(db, review.id, 'y'.repeat(20_000));
    expect(db.tables.revisionRequest[0].body).toHaveLength(20_000);
  });

  it('RR4/RR5/RR6/RR7 writes the OPEN revision request, CHANGES_REQUESTED and event 3 together', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const text =
      '  Change CTA to "Book a call".\n\nRemove the unsupported claim.  ';
    const next = await askChanges(db, review.id, text, ORG_A, USER_A2);
    expect(next).toMatchObject({ state: 'CHANGES_REQUESTED', version: 3 });
    expect(next.events[2]).toMatchObject({
      sequence: 3,
      fromState: 'IN_REVIEW',
      toState: 'CHANGES_REQUESTED',
      actor: { id: USER_A2, name: 'Bo' },
    });
    expect(db.tables.revisionRequest).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        organizationId: ORG_A,
        reviewId: review.id,
        requestedByUserId: USER_A2,
        body: text,
        status: 'OPEN',
        resolvedByUserId: null,
        resolvedAt: null,
        resolvedByPackageRevisionId: null,
        resolvedByDesignRevisionId: null,
        resolvedByContentHash: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect(await revisionRequestOf(db, review.id)).toEqual({
      id: db.tables.revisionRequest[0].id,
      body: text,
      status: 'OPEN',
      requestedBy: { id: USER_A2, name: 'Bo' },
      createdAt: expect.any(Date),
      resolution: null,
    });
    // the state event holds the transition only, never the request text
    expect(JSON.stringify(db.tables.event)).not.toContain('Book a call');
    // the target is untouched
    expect(db.tables.review[0]).toMatchObject({
      packageRevisionId: PKG_REV_4,
      targetContentHash: review.targetContentHash,
    });
    const created = db.log.find((e) => e.op === 'revisionRequest.create')!;
    expect(Object.keys(created.data!).sort()).toEqual([
      'body',
      'id',
      'organizationId',
      'requestedByUserId',
      'reviewId',
      'status',
    ]);
  });

  it('RR7/CSEC8/CSEC9 the requester, status and resolution are never taken from the caller', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    await db.service.requestChanges({
      organizationId: ORG_A,
      userId: USER_A,
      id: review.id,
      body: 'Replace the image.',
      ...({
        requestedByUserId: USER_B,
        status: 'RESOLVED',
        resolvedByUserId: USER_B,
        resolvedByContentHash: 'f'.repeat(64),
      } as object),
    });
    expect(db.tables.revisionRequest[0]).toMatchObject({
      requestedByUserId: USER_A,
      status: 'OPEN',
      resolvedByUserId: null,
      resolvedByContentHash: null,
    });
  });

  it('RR8/RR10/13 one formal revision request per review: a final review takes no second one', async () => {
    for (const end of [
      'CHANGES_REQUESTED',
      'READY_FOR_APPROVAL',
      'CANCELLED',
    ] as const) {
      const db = discussion();
      const review = await reviewIn(db, end);
      const before = snapshot(db);
      expect(await code(askChanges(db, review.id, 'Once more'))).toEqual({
        status: 409,
        code: 'CS_REVIEW_INVALID_TRANSITION',
      });
      expect(snapshot(db)).toBe(before);
      expect(db.tables.revisionRequest).toHaveLength(
        end === 'CHANGES_REQUESTED' ? 1 : 0
      );
    }
  });

  it('RR9 a REQUESTED review cannot take a revision request', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'REQUESTED');
    expect(await code(askChanges(db, review.id, 'Too early'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_INVALID_TRANSITION',
    });
    expect(db.tables.revisionRequest).toEqual([]);
    expect(db.tables.review[0]).toMatchObject({
      state: 'REQUESTED',
      version: 1,
    });
  });

  it('RR8/TX1 a second revision request of one review is CS_REVIEW_REVISION_REQUEST_ALREADY_EXISTS and moves nothing', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    // a stray row the unique (reviewId, organizationId) already holds
    db.tables.revisionRequest.push({
      id: uuid(600),
      organizationId: ORG_A,
      reviewId: review.id,
      requestedByUserId: USER_A,
      body: 'stray',
      status: 'OPEN',
      createdAt: new Date(0),
    });
    const before = snapshot(db);
    expect(await code(askChanges(db, review.id, 'Change it'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_REVISION_REQUEST_ALREADY_EXISTS',
    });
    expect(snapshot(db)).toBe(before);
    expect(db.tables.review[0]).toMatchObject({
      state: 'IN_REVIEW',
      version: 2,
    });
  });

  it('a request on another organization review or a missing one is the same 404, and nothing is written', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const before = snapshot(db);
    for (const attempt of [
      askChanges(db, review.id, 'from B', ORG_B, USER_B),
      askChanges(db, MISSING, 'x'),
      askChanges(db, 'not-a-uuid', 'x'),
    ]) {
      expect(await code(attempt)).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
      });
    }
    expect(snapshot(db)).toBe(before);
  });
});

describe('ContentStudioReviewService: request-changes transaction', () => {
  const failing = (db: Db, model: string, op = 'create') => {
    const target = (db.repository as any)._transaction.model[model];
    const original = target[op];
    target[op] = async () => {
      throw new Error(`${model} write failed`);
    };
    return () => (target[op] = original);
  };

  it('TX1 a revision request that cannot be written leaves the review IN_REVIEW with two events', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const before = snapshot(db);
    const restore = failing(db, 'contentStudioReviewRevisionRequest');
    await expect(askChanges(db, review.id, 'Change it')).rejects.toThrow(
      'write failed'
    );
    restore();
    expect(snapshot(db)).toBe(before);
    expect(db.tables.review[0]).toMatchObject({
      state: 'IN_REVIEW',
      version: 2,
    });
    expect(db.tables.event).toHaveLength(2);
  });

  it('TX2 a compare-and-swap that lost writes no revision request', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    expect(
      await db.repository.transitionReviewWithCompareAndSwap({
        organizationId: ORG_A,
        reviewId: review.id,
        expectedState: 'IN_REVIEW',
        expectedVersion: 1,
        toState: 'CHANGES_REQUESTED',
        actorUserId: USER_A,
        revisionRequest: { id: uuid(700), body: 'lost' },
      })
    ).toBe(false);
    expect(
      await db.repository.transitionReviewWithCompareAndSwap({
        organizationId: ORG_B,
        reviewId: review.id,
        expectedState: 'IN_REVIEW',
        expectedVersion: 2,
        toState: 'CHANGES_REQUESTED',
        actorUserId: USER_B,
        revisionRequest: { id: uuid(701), body: 'foreign' },
      })
    ).toBe(false);
    expect(db.tables.revisionRequest).toEqual([]);
    expect(db.tables.review[0]).toMatchObject({
      state: 'IN_REVIEW',
      version: 2,
    });
  });

  it('TX3 a state event that cannot be written takes the transition and the revision request with it', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    const before = snapshot(db);
    const restore = failing(db, 'contentStudioReviewStateEvent');
    await expect(askChanges(db, review.id, 'Change it')).rejects.toThrow(
      'write failed'
    );
    restore();
    expect(snapshot(db)).toBe(before);
    expect(db.tables.revisionRequest).toEqual([]);
  });

  it.each([
    ['request changes first', 0],
    ['ready for approval first', 1],
  ])(
    'TX4/42 ready-for-approval racing request-changes (%s): exactly one outcome, never both',
    async (_, readyFirst) => {
      const db = discussion();
      const review = await reviewIn(db, 'IN_REVIEW');
      const attempts = [
        () => askChanges(db, review.id, 'Change it', ORG_A, USER_A),
        () => act(db, review.id, 'ready-for-approval', ORG_A, USER_A2),
      ];
      if (readyFirst) {
        attempts.reverse();
      }
      const results = await Promise.allSettled(attempts.map((go) => go()));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find(
        (r) => r.status === 'rejected'
      ) as PromiseRejectedResult;
      expect((lost.reason as HttpException).getResponse()).toMatchObject({
        code: 'CS_REVIEW_CONFLICT',
      });
      const state = db.tables.review[0].state;
      expect(db.tables.review[0].version).toBe(3);
      expect(db.tables.event).toHaveLength(3);
      expect(db.tables.event[2].toState).toBe(state);
      if (state === 'CHANGES_REQUESTED') {
        expect(db.tables.revisionRequest).toHaveLength(1);
        expect((await revisionRequestOf(db, review.id)).status).toBe('OPEN');
      } else {
        expect(state).toBe('READY_FOR_APPROVAL');
        expect(db.tables.revisionRequest).toEqual([]);
        expect(await code(revisionRequestOf(db, review.id))).toEqual({
          status: 404,
          code: 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND',
        });
      }
    }
  );
});

describe('ContentStudioReviewService: resolving a package revision request', () => {
  const ready = async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CHANGES_REQUESTED');
    return { db, review };
  };
  const unresolved = (db: Db) => {
    const row = db.tables.revisionRequest[0];
    expect(row).toMatchObject({
      status: 'OPEN',
      resolvedByUserId: null,
      resolvedAt: null,
      resolvedByPackageRevisionId: null,
      resolvedByDesignRevisionId: null,
      resolvedByContentHash: null,
    });
  };

  it('RP1/RP7 a newer revision of the same package resolves it, with the hash read from that revision', async () => {
    const { db, review } = await ready();
    const v5 = db.tables.packageRevision.find((r) => r.id === PKG_REV_5)!;
    const resolved = await resolve(db, review.id, PKG_REV_5, ORG_A, USER_A2);
    expect(resolved).toEqual({
      id: db.tables.revisionRequest[0].id,
      body: CHANGES,
      status: 'RESOLVED',
      requestedBy: { id: USER_A, name: 'Ann' },
      createdAt: expect.any(Date),
      resolution: {
        revisionId: PKG_REV_5,
        revisionNumber: 5,
        contentHash: v5.contentHash,
        resolvedBy: { id: USER_A2, name: 'Bo' },
        resolvedAt: expect.any(Date),
      },
    });
    expect(db.tables.revisionRequest[0]).toMatchObject({
      status: 'RESOLVED',
      resolvedByUserId: USER_A2,
      resolvedAt: expect.any(Date),
      resolvedByPackageRevisionId: PKG_REV_5,
      resolvedByDesignRevisionId: null,
      resolvedByContentHash: v5.contentHash,
    });
    // no content of the resolving revision is sent back
    expect(JSON.stringify(resolved)).not.toMatch(/"content"|"thread"|v5/);
    // and the revision lookup was the exact id inside the organization
    expect(
      db.log.filter((e) => e.op === 'packageRevision.findFirst').at(-1)!.where
    ).toEqual({ id: PKG_REV_5, organizationId: ORG_A });
  });

  it('RP1 any newer revision of that package, not only the next one', async () => {
    const { db, review } = await ready();
    expect((await resolve(db, review.id, PKG_REV_6)).resolution).toMatchObject({
      revisionId: PKG_REV_6,
      revisionNumber: 6,
    });
  });

  it.each([
    ['RP2 the reviewed revision itself', () => PKG_REV_4],
    ['RP3 an older revision', () => PKG_REV_3],
    ['RP4 a newer revision of another package', () => PKG_REV_OTHER],
    ['RP5 a revision of another organization', () => PKG_REV_B],
    ['RP6 a design revision (no package revision at all)', () => DESIGN_REV_8],
    ['RP6 a missing revision', () => MISSING],
    ['RP6 a draft: the package, not a revision', () => 'package-org-a'],
    ['M14 "latest"', () => 'latest'],
    ['no revision', () => undefined],
    ['a list', () => [PKG_REV_5]],
  ])(
    '%s is CS_REVIEW_REVISION_REQUEST_INVALID_RESOLUTION; nothing changes',
    async (_, id) => {
      const { db, review } = await ready();
      const before = snapshot(db);
      expect(await code(resolve(db, review.id, id()))).toEqual({
        status: 400,
        code: 'CS_REVIEW_REVISION_REQUEST_INVALID_RESOLUTION',
      });
      expect(snapshot(db)).toBe(before);
      unresolved(db);
      expect(db.log.some((e) => e.op === 'revisionRequest.updateMany')).toBe(
        false
      );
    }
  );

  it('RP7/CSEC10 a hash, status, user or time from the caller is never used', async () => {
    const { db, review } = await ready();
    await db.service.resolveRevisionRequest({
      organizationId: ORG_A,
      userId: USER_A,
      reviewId: review.id,
      resolutionRevisionId: PKG_REV_5,
      ...({
        resolvedByContentHash: 'f'.repeat(64),
        contentHash: 'e'.repeat(64),
        resolvedByUserId: USER_B,
        resolvedAt: new Date(0),
        targetType: 'DESIGN_REVISION',
        status: 'OPEN',
      } as object),
    });
    const row = db.tables.revisionRequest[0];
    expect(row.resolvedByContentHash).toBe(
      db.tables.packageRevision.find((r) => r.id === PKG_REV_5)!.contentHash
    );
    expect(row.resolvedByUserId).toBe(USER_A);
    expect(row.resolvedAt.getTime()).toBeGreaterThan(0);
    expect(row.resolvedByPackageRevisionId).toBe(PKG_REV_5);
  });

  it('RP8/RP9/15/16 the review stays CHANGES_REQUESTED, and the resolving revision gets no review', async () => {
    const { db, review } = await ready();
    const before = reviewFacts(db);
    await resolve(db, review.id, PKG_REV_5);
    expect(reviewFacts(db)).toBe(before);
    expect(db.tables.review).toHaveLength(1);
    expect(
      (
        await db.service.listReviews({
          organizationId: ORG_A,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: PKG_REV_5,
          page: 1,
        })
      ).results
    ).toEqual([]);
    // nothing review-related was written by the resolution itself
    const sinceResolve = db.log.slice(
      db.log.findIndex((e) => e.op === 'revisionRequest.updateMany')
    );
    expect(
      sinceResolve.filter((e) =>
        /^(review|event)\.(create|updateMany)/.test(e.op)
      )
    ).toEqual([]);
    // a review of revision 5 is still requested explicitly
    expect(await request(db, 'PACKAGE_REVISION', PKG_REV_5)).toMatchObject({
      state: 'REQUESTED',
      targetRevisionNumber: 5,
    });
  });

  it('a resolved request is resolved for good: a second resolution is CS_REVIEW_REVISION_REQUEST_CONFLICT', async () => {
    const { db, review } = await ready();
    await resolve(db, review.id, PKG_REV_5);
    const before = snapshot(db);
    for (const id of [PKG_REV_6, PKG_REV_5]) {
      expect(await code(resolve(db, review.id, id))).toEqual({
        status: 409,
        code: 'CS_REVIEW_REVISION_REQUEST_CONFLICT',
      });
    }
    expect(snapshot(db)).toBe(before);
  });

  it('a corrupt resolving revision or reviewed revision fails closed, and nothing is resolved', async () => {
    const { db, review } = await ready();
    const v5 = db.tables.packageRevision.find((r) => r.id === PKG_REV_5)!;
    v5.content = v5.content.replace('v5', 'v7');
    expect(await code(resolve(db, review.id, PKG_REV_5))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    const v4 = db.tables.packageRevision.find((r) => r.id === PKG_REV_4)!;
    v4.content = v4.content.replace('v4', 'v8');
    expect(await code(resolve(db, review.id, PKG_REV_6))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    unresolved(db);
  });

  it('a review without a revision request has none to read or resolve', async () => {
    for (const state of [
      'REQUESTED',
      'IN_REVIEW',
      'READY_FOR_APPROVAL',
      'CANCELLED',
    ] as const) {
      const db = discussion();
      const review = await reviewIn(db, state);
      expect(await code(revisionRequestOf(db, review.id))).toEqual({
        status: 404,
        code: 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND',
      });
      expect(await code(resolve(db, review.id, PKG_REV_5))).toEqual({
        status: 404,
        code: 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND',
      });
    }
  });
});

describe('ContentStudioReviewService: resolving a design revision request', () => {
  const ready = async () => {
    const db = discussion();
    const review = await reviewIn(
      db,
      'CHANGES_REQUESTED',
      'DESIGN_REVISION',
      DESIGN_REV_7
    );
    return { db, review };
  };

  it('RD1/RD6/RD7 a newer revision of the same design resolves it with its stored hash; the review stays', async () => {
    const { db, review } = await ready();
    const before = reviewFacts(db);
    const v8 = db.tables.designRevision.find((r) => r.id === DESIGN_REV_8)!;
    const resolved = await resolve(db, review.id, DESIGN_REV_8);
    expect(resolved.resolution).toEqual({
      revisionId: DESIGN_REV_8,
      revisionNumber: 8,
      contentHash: v8.contentHash,
      resolvedBy: { id: USER_A, name: 'Ann' },
      resolvedAt: expect.any(Date),
    });
    expect(db.tables.revisionRequest[0]).toMatchObject({
      resolvedByPackageRevisionId: null,
      resolvedByDesignRevisionId: DESIGN_REV_8,
      resolvedByContentHash: v8.contentHash,
    });
    expect(JSON.stringify(resolved)).not.toMatch(/"pages"|"layers"/);
    expect(reviewFacts(db)).toBe(before);
    expect(db.tables.review[0].state).toBe('CHANGES_REQUESTED');
    expect(db.tables.review).toHaveLength(1);
  });

  it.each([
    ['RD2 the reviewed revision itself', DESIGN_REV_7],
    ['RD3 an older revision', DESIGN_REV_6],
    ['RD4 a newer revision of another design', DESIGN_REV_OTHER],
    ['RD5 a revision of another organization', DESIGN_REV_B],
    ['a package revision', PKG_REV_5],
  ])('%s is refused; nothing changes', async (_, id) => {
    const { db, review } = await ready();
    const before = snapshot(db);
    expect(await code(resolve(db, review.id, id))).toEqual({
      status: 400,
      code: 'CS_REVIEW_REVISION_REQUEST_INVALID_RESOLUTION',
    });
    expect(snapshot(db)).toBe(before);
    for (const entry of db.log.filter((e) =>
      /Revision\.findFirst/.test(e.op)
    )) {
      expect(entry.where).toEqual({
        id: expect.any(String),
        organizationId: ORG_A,
      });
    }
  });

  it("RD1 the design read for the parent check is the revision's own, never a design lookup", async () => {
    const { db, review } = await ready();
    await resolve(db, review.id, DESIGN_REV_9);
    expect(db.log.some((e) => /design\.|project/i.test(e.op))).toBe(false);
  });
});

describe('ContentStudioReviewService: stored revision request integrity', () => {
  const resolvedPackage = async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CHANGES_REQUESTED');
    await resolve(db, review.id, PKG_REV_5);
    return { db, review };
  };
  const openPackage = async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CHANGES_REQUESTED');
    return { db, review };
  };
  const fails = async (db: Db, reviewId: string) => {
    const before = snapshot(db);
    expect(await code(revisionRequestOf(db, reviewId))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    expect(await code(resolve(db, reviewId, PKG_REV_6))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    // reported, never repaired
    expect(snapshot(db)).toBe(before);
  };

  it('RI1/M19 an OPEN request with any resolution field set fails closed', async () => {
    const corruptions: ((row: Row) => void)[] = [
      (row) => (row.resolvedByUserId = USER_A),
      (row) => (row.resolvedAt = new Date()),
      (row) => (row.resolvedByPackageRevisionId = PKG_REV_5),
      (row) => (row.resolvedByDesignRevisionId = DESIGN_REV_8),
      (row) => (row.resolvedByContentHash = 'a'.repeat(64)),
    ];
    for (const corrupt of corruptions) {
      const { db, review } = await openPackage();
      corrupt(db.tables.revisionRequest[0]);
      await fails(db, review.id);
    }
  });

  it('RI2 a RESOLVED request with every field in agreement reads back', async () => {
    const { db, review } = await resolvedPackage();
    expect((await revisionRequestOf(db, review.id)).resolution).toMatchObject({
      revisionId: PKG_REV_5,
      revisionNumber: 5,
    });
  });

  it.each([
    [
      'RI3 the other target type',
      (row: Row) => {
        row.resolvedByDesignRevisionId = DESIGN_REV_8;
        row.resolvedByPackageRevisionId = null;
      },
    ],
    [
      'RI3 both target types',
      (row: Row) => (row.resolvedByDesignRevisionId = DESIGN_REV_8),
    ],
    [
      'RI4 no resolving revision',
      (row: Row) => (row.resolvedByPackageRevisionId = null),
    ],
    [
      'RI4 a missing resolving revision',
      (row: Row) => (row.resolvedByPackageRevisionId = MISSING),
    ],
    [
      'RI4 a resolving revision of another organization',
      (row: Row) => (row.resolvedByPackageRevisionId = PKG_REV_B),
    ],
    [
      'RI5 another hash',
      (row: Row) => (row.resolvedByContentHash = 'a'.repeat(64)),
    ],
    ['RI5 no hash', (row: Row) => (row.resolvedByContentHash = null)],
    [
      'RI5 a malformed hash',
      (row: Row) => (row.resolvedByContentHash = 'not-a-hash'),
    ],
    ['M20 no resolving user', (row: Row) => (row.resolvedByUserId = null)],
    [
      'a resolving user that does not exist',
      (row: Row) => (row.resolvedByUserId = 'ghost'),
    ],
    ['no resolution time', (row: Row) => (row.resolvedAt = null)],
    ['RI8 an unknown status', (row: Row) => (row.status = 'REJECTED')],
    ['RI8 a lower-case status', (row: Row) => (row.status = 'resolved')],
    ['RI8 OPEN with the resolution kept', (row: Row) => (row.status = 'OPEN')],
    ['a body that is not text', (row: Row) => (row.body = null)],
  ])('%s fails closed', async (_, corrupt) => {
    const { db, review } = await resolvedPackage();
    corrupt(db.tables.revisionRequest[0]);
    const before = snapshot(db);
    expect(await code(revisionRequestOf(db, review.id))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    expect(snapshot(db)).toBe(before);
  });

  it('RI6 a resolving revision that is not of the reviewed package fails closed', async () => {
    const { db, review } = await resolvedPackage();
    db.tables.packageRevision.find((r) => r.id === PKG_REV_5)!.packageId =
      'package-other';
    await expect(code(revisionRequestOf(db, review.id))).resolves.toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
  });

  it('RI7 a resolving revision that is not newer fails closed', async () => {
    for (const number of [4, 3]) {
      const { db, review } = await resolvedPackage();
      db.tables.packageRevision.find(
        (r) => r.id === PKG_REV_5
      )!.revisionNumber = number;
      expect(await code(revisionRequestOf(db, review.id))).toEqual({
        status: 500,
        code: 'CS_REVIEW_INTEGRITY_ERROR',
      });
    }
  });

  it('a revision request of a review that is not CHANGES_REQUESTED fails closed', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    db.tables.revisionRequest.push({
      id: uuid(800),
      organizationId: ORG_A,
      reviewId: review.id,
      requestedByUserId: USER_A,
      body: 'stray',
      status: 'OPEN',
      resolvedByUserId: null,
      resolvedAt: null,
      resolvedByPackageRevisionId: null,
      resolvedByDesignRevisionId: null,
      resolvedByContentHash: null,
      createdAt: new Date(0),
    });
    await fails(db, review.id);
  });

  it('a malformed review fails closed before its revision request is read', async () => {
    const { db, review } = await openPackage();
    db.tables.review[0].targetContentHash = 'b'.repeat(64);
    expect(await code(revisionRequestOf(db, review.id))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
  });
});

describe('ContentStudioReviewService: resolution concurrency and tenancy', () => {
  it("RCON1/RCON2/RCON3 two resolutions at once: one wins, the other is a conflict, the fields are all the winner's", async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CHANGES_REQUESTED');
    const results = await Promise.allSettled([
      resolve(db, review.id, PKG_REV_5, ORG_A, USER_A),
      resolve(db, review.id, PKG_REV_6, ORG_A, USER_A2),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const lost = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect((lost.reason as HttpException).getResponse()).toMatchObject({
      code: 'CS_REVIEW_REVISION_REQUEST_CONFLICT',
    });
    const won = (
      results.find(
        (r) => r.status === 'fulfilled'
      ) as PromiseFulfilledResult<any>
    ).value;
    const row = db.tables.revisionRequest[0];
    const winner = db.tables.packageRevision.find(
      (r) => r.id === won.resolution.revisionId
    )!;
    expect(row).toMatchObject({
      status: 'RESOLVED',
      resolvedByPackageRevisionId: winner.id,
      resolvedByContentHash: winner.contentHash,
      resolvedByUserId: won.resolution.resolvedBy.id,
      resolvedByDesignRevisionId: null,
    });
    expect((await revisionRequestOf(db, review.id)).resolution).toEqual(
      won.resolution
    );
  });

  it('RCON3 the resolution is one compare-and-swap writing every field at once, from OPEN with none set', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CHANGES_REQUESTED');
    await resolve(db, review.id, PKG_REV_5);
    const writes = db.log.filter((e) => e.op === 'revisionRequest.updateMany');
    expect(writes).toHaveLength(1);
    expect(writes[0].where).toEqual({
      id: db.tables.revisionRequest[0].id,
      organizationId: ORG_A,
      reviewId: review.id,
      status: 'OPEN',
      resolvedByUserId: null,
      resolvedAt: null,
      resolvedByPackageRevisionId: null,
      resolvedByDesignRevisionId: null,
      resolvedByContentHash: null,
    });
    expect(Object.keys(writes[0].data!).sort()).toEqual([
      'resolvedAt',
      'resolvedByContentHash',
      'resolvedByDesignRevisionId',
      'resolvedByPackageRevisionId',
      'resolvedByUserId',
      'status',
    ]);
    // a lost swap writes nothing
    expect(
      await db.repository.resolveRevisionRequestWithCompareAndSwap({
        organizationId: ORG_A,
        reviewId: review.id,
        id: db.tables.revisionRequest[0].id,
        resolvedByUserId: USER_A2,
        resolvedAt: new Date(),
        resolvedByPackageRevisionId: PKG_REV_6,
        resolvedByDesignRevisionId: null,
        resolvedByContentHash: 'c'.repeat(64),
      })
    ).toBe(false);
    expect(db.tables.revisionRequest[0].resolvedByPackageRevisionId).toBe(
      PKG_REV_5
    );
  });

  it('CSEC4/CSEC5 another organization cannot read or resolve the revision request: the same 404 as a missing review', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CHANGES_REQUESTED');
    const before = snapshot(db);
    for (const attempt of [
      revisionRequestOf(db, review.id, ORG_B),
      resolve(db, review.id, PKG_REV_5, ORG_B, USER_B),
      resolve(db, review.id, PKG_REV_B, ORG_B, USER_B),
      revisionRequestOf(db, MISSING),
      resolve(db, 'not-a-uuid', PKG_REV_5),
    ]) {
      expect(await code(attempt)).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
      });
    }
    expect(snapshot(db)).toBe(before);
    expect(
      await db.repository.resolveRevisionRequestWithCompareAndSwap({
        organizationId: ORG_B,
        reviewId: review.id,
        id: db.tables.revisionRequest[0].id,
        resolvedByUserId: USER_B,
        resolvedAt: new Date(),
        resolvedByPackageRevisionId: PKG_REV_B,
        resolvedByDesignRevisionId: null,
        resolvedByContentHash: 'c'.repeat(64),
      })
    ).toBe(false);
    for (const entry of db.log.filter((e) => /^revisionRequest\./.test(e.op))) {
      expect((entry.where ?? entry.data)!.organizationId).toBeDefined();
    }
  });
});

describe('ContentStudioReviewService discussion boundaries (P5-02)', () => {
  const source = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/\/\/.*$/gm, '');
  const method = (name: string) => {
    const text = source('content-studio.review.service.ts');
    const start = text.indexOf(`async ${name}(`);
    return text.slice(start, text.indexOf('\n  }\n', start));
  };

  it('P502-5/M16/M17 resolving creates or moves no review', () => {
    const resolveSource = method('resolveRevisionRequest');
    expect(resolveSource).toContain('resolveRevisionRequestWithCompareAndSwap');
    expect(resolveSource).not.toMatch(
      /createReview|transitionReviewWithCompareAndSwap|changeState|requestReview/
    );
  });

  it('P502-10/M15 the resolution hash and the target type come from the server', () => {
    const resolveSource = method('resolveRevisionRequest');
    expect(resolveSource).toMatch(
      /resolvedByContentHash: resolution\.contentHash/
    );
    expect(resolveSource).toMatch(/targetType: review\.targetType/);
    expect(resolveSource).not.toMatch(
      /input\.(targetType|contentHash|resolvedBy)/
    );
  });

  it('P502-6/P502-7/P502-9 no comment delete, attachment, annotation or layer target', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      expect(source(file)).not.toMatch(
        /deleteComment|removeComment|attachment|upload|layerId|pageId|coordinates|annotation|sourceId/i
      );
    }
    // claims exist since P5-03B, but a comment never names one (P503B-9)
    const repository = source('content-studio.review.repository.ts');
    const comments = [
      repository.slice(
        repository.indexOf('const COMMENT = {'),
        repository.indexOf('const REVISION_REQUEST = {')
      ),
      repository.slice(
        repository.indexOf('listCommentsForReview('),
        repository.indexOf('getRevisionRequestForReview(')
      ),
    ];
    for (const section of comments) {
      expect(section.length).toBeGreaterThan(100);
      expect(section).not.toMatch(/claim/i);
    }
  });
});

// --- claim review (P5-03B): the grounded claims of the exact package
// revision a review is about, their assessments and their exact evidence ---

const SOURCE_A = uuid(500);
const SOURCE_V1 = uuid(501);
const SOURCE_V2 = uuid(502);
const SOURCE_B = uuid(510);
const SOURCE_B_V1 = uuid(511);
const PKG_REV_G = uuid(60);
const PKG_REV_G_NEXT = uuid(61);
const PKG_REV_EMPTY = uuid(62);

const sourceVersionRow = (
  id: string,
  org: string,
  sourceId: string,
  n: number
) => ({
  id,
  organizationId: org,
  sourceId,
  sourceName: `Weekly report ${org}`,
  versionNumber: n,
  title: `Report v${n}`,
  fetchedAt: new Date('2026-10-10T10:00:00.000Z'),
  finalUrl: 'https://example.com/report?token=REVIEW_PRIVATE_URL',
  ...storedContentStudioSourceContent(
    parseContentStudioSourceContent({
      schemaVersion: 1,
      blocks: [
        {
          id: 'b1',
          type: 'paragraph',
          text: `Sales grew by ten percent in v${n}.`,
          level: null,
        },
        { id: 'b2', type: 'heading', text: `Outlook v${n}`, level: 2 },
      ],
    })
  ),
});
const SOURCE_ROWS = () => [
  sourceVersionRow(SOURCE_V1, ORG_A, SOURCE_A, 1),
  sourceVersionRow(SOURCE_V2, ORG_A, SOURCE_A, 2),
  sourceVersionRow(SOURCE_B_V1, ORG_B, SOURCE_B, 1),
];
const evidenceOf = (
  row: ReturnType<typeof sourceVersionRow>,
  blockId = 'b1',
  quote: string | null = null
) => ({
  sourceId: row.sourceId,
  versionId: row.id,
  versionNumber: row.versionNumber,
  contentHash: row.contentHash,
  blockId,
  quote,
});
const claimOf = (id: string, text: string, evidence: Row[]) => ({
  id,
  threadItemId: 'item-1',
  text,
  evidence,
});
const groundedRevision = (
  id: string,
  org: string,
  n: number,
  claims: Row[]
) => {
  const draft = parseContentPackageDraft({
    schemaVersion: 2,
    copy: {
      global: {
        thread: [{ id: 'item-1', text: `Grounded v${n}`, mediaIds: [] }],
      },
    },
    grounding: { claims },
  });
  const content = canonicalJson(draft);
  return {
    id,
    organizationId: org,
    packageId: `package-${org}`,
    revisionNumber: n,
    schemaVersion: 2,
    content,
    contentHash: sha256Hex(content),
  };
};
const C1 = 'c_claim000000000001';
const C2 = 'c_claim000000000002';
const C3 = 'c_claim000000000003';

const claimed = async (
  start = true,
  claims?: (rows: ReturnType<typeof SOURCE_ROWS>) => Row[]
) => {
  const db = seeded();
  const rows = SOURCE_ROWS();
  db.tables.sourceVersion.push(...rows);
  const [v1] = rows;
  db.tables.packageRevision.push(
    groundedRevision(
      PKG_REV_G,
      ORG_A,
      6,
      claims
        ? claims(rows)
        : [
            claimOf(C1, 'Sales grew by ten percent.', [
              evidenceOf(v1, 'b1', 'grew by ten percent'),
            ]),
            claimOf(C2, 'The outlook is covered.', [evidenceOf(v1, 'b2')]),
          ]
    ),
    // a newer revision of the same package: other claims, C1 reworded
    groundedRevision(PKG_REV_G_NEXT, ORG_A, 7, [
      claimOf(C1, 'Sales grew by twenty percent.', [evidenceOf(rows[1])]),
      claimOf(C3, 'A claim only revision 7 has.', [evidenceOf(rows[1], 'b2')]),
    ]),
    groundedRevision(PKG_REV_EMPTY, ORG_A, 8, [])
  );
  let review = await request(db, 'PACKAGE_REVISION', PKG_REV_G);
  if (start) {
    review = await act(db, review.id, 'start');
  }
  return { db, review, rows };
};
const listClaims = (
  db: ReturnType<typeof createDb>,
  reviewId: string,
  org = ORG_A
) => db.service.listClaims({ organizationId: org, reviewId });
const assess = (
  db: ReturnType<typeof createDb>,
  reviewId: string,
  claimId: string,
  status: unknown,
  finding?: unknown,
  user = USER_A2,
  org = ORG_A
) =>
  db.service.assessClaim({
    organizationId: org,
    userId: user,
    reviewId,
    claimId,
    status,
    finding,
  });
const claimHash = (
  db: ReturnType<typeof createDb>,
  revisionId: string,
  id: string
) => {
  const revision = db.tables.packageRevision.find((r) => r.id === revisionId)!;
  const claim = JSON.parse(revision.content).grounding.claims.find(
    (entry: Row) => entry.id === id
  );
  return hashContentPackageClaim(claim);
};
const reviewRow = (db: ReturnType<typeof createDb>, id: string) =>
  db.tables.review.find((row) => row.id === id)!;

describe('ContentStudioReviewService: claim inventory (P5-03B)', () => {
  it('CI1 a v1 package revision has no claims: nothing to review, complete', async () => {
    const db = seeded();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_4);
    const list = await listClaims(db, review.id);
    expect(list.summary).toEqual({
      total: 0,
      verified: 0,
      needsRevision: 0,
      unreviewed: 0,
      complete: true,
    });
    expect(list.claims).toEqual([]);
  });

  it('CI2 a v2 revision without claims has none either', async () => {
    const { db } = await claimed();
    const review = await request(db, 'PACKAGE_REVISION', PKG_REV_EMPTY);
    expect((await listClaims(db, review.id)).claims).toEqual([]);
  });

  it('CI3/CI4/CI5 exactly the claims of the reviewed revision, in its order, each with its server hash and UNREVIEWED', async () => {
    const { db, review } = await claimed();
    const list = await listClaims(db, review.id);
    expect(list.reviewId).toBe(review.id);
    expect(list.reviewState).toBe('IN_REVIEW');
    expect(
      list.claims.map((claim) => [
        claim.claimId,
        claim.threadItemId,
        claim.claimText,
        claim.claimContentHash,
        claim.status,
        claim.finding,
        claim.reviewedBy,
        claim.reviewedAt,
      ])
    ).toEqual([
      [
        C1,
        'item-1',
        'Sales grew by ten percent.',
        claimHash(db, PKG_REV_G, C1),
        'UNREVIEWED',
        null,
        null,
        null,
      ],
      [
        C2,
        'item-1',
        'The outlook is covered.',
        claimHash(db, PKG_REV_G, C2),
        'UNREVIEWED',
        null,
        null,
        null,
      ],
    ]);
    expect(list.summary).toEqual({
      total: 2,
      verified: 0,
      needsRevision: 0,
      unreviewed: 2,
      complete: false,
    });
  });

  it('CI6/RG9 the newer revision of the package is never read: its claims never enter this review', async () => {
    const { db, review } = await claimed();
    db.log.length = 0;
    const list = await listClaims(db, review.id);
    expect(list.claims.map((claim) => claim.claimText)).not.toContain(
      'A claim only revision 7 has.'
    );
    expect(
      db.log
        .filter((entry) => entry.op === 'packageRevision.findFirst')
        .map((entry) => entry.where)
    ).toEqual([{ id: PKG_REV_G, organizationId: ORG_A }]);
  });

  it('CI8 a revision changed after it was reviewed fails closed, with nothing returned', async () => {
    const { db, review } = await claimed();
    const revision = db.tables.packageRevision.find((r) => r.id === PKG_REV_G)!;
    revision.content = revision.content.replace(
      'ten percent.',
      'nine percent.'
    );
    expect(await code(listClaims(db, review.id))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    // rehashed: the review's own targetContentHash no longer matches
    revision.contentHash = sha256Hex(revision.content);
    expect((await code(listClaims(db, review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });
});

describe('ContentStudioReviewService: claim evidence (P5-03B)', () => {
  it('CE1-CE5 each claim shows its exact evidence: source, version number and hash, block and quote', async () => {
    const { db, review, rows } = await claimed();
    const [first, second] = (await listClaims(db, review.id)).claims;
    expect(first.evidence).toEqual([
      {
        source: { id: SOURCE_A, name: `Weekly report ${ORG_A}` },
        version: {
          id: SOURCE_V1,
          versionNumber: 1,
          title: 'Report v1',
          contentHash: rows[0].contentHash,
          fetchedAt: new Date('2026-10-10T10:00:00.000Z'),
        },
        block: {
          id: 'b1',
          type: 'paragraph',
          text: 'Sales grew by ten percent in v1.',
        },
        quote: 'grew by ten percent',
      },
    ]);
    expect(
      second.evidence.map((entry) => [entry.block.id, entry.quote])
    ).toEqual([['b2', null]]);
    // no URL, fetch provenance or full source body
    expect(JSON.stringify(first)).not.toMatch(
      /https?:|REVIEW_PRIVATE_URL|finalUrl|blocks|Outlook v1/
    );
  });

  it('CE6 a newer capture of the source is never shown in its place', async () => {
    const { db, review } = await claimed();
    const evidence = (await listClaims(db, review.id)).claims.flatMap(
      (claim) => claim.evidence
    );
    expect(evidence.map((entry) => entry.version.versionNumber)).toEqual([
      1, 1,
    ]);
    expect(JSON.stringify(evidence)).not.toContain('v2.');
  });

  it('reads every source version once, in one organization-scoped query', async () => {
    const { db, review } = await claimed();
    db.log.length = 0;
    await listClaims(db, review.id);
    expect(
      db.log
        .filter((entry) => entry.op === 'sourceVersion.findMany')
        .map((entry) => entry.where)
    ).toEqual([{ organizationId: ORG_A, ids: [SOURCE_V1] }]);
  });

  it('CE7/CLSEC4 evidence of a version that is missing or of another organization fails closed', async () => {
    const missing = await claimed();
    missing.db.tables.sourceVersion.splice(0, 1);
    expect(await code(listClaims(missing.db, missing.review.id))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    const foreign = await claimed();
    foreign.db.tables.sourceVersion[0].organizationId = ORG_B;
    expect((await code(listClaims(foreign.db, foreign.review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });

  it('CE8 a corrupted source version fails closed', async () => {
    const { db, review } = await claimed();
    db.tables.sourceVersion[0].content =
      db.tables.sourceVersion[0].content.replace('ten', 'nine');
    expect((await code(listClaims(db, review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });
});

describe('ContentStudioReviewService: assessing a claim (P5-03B)', () => {
  it('CU1/CU2/CU3/CU8 VERIFIED while IN_REVIEW: the request user, a server time and the server claim hash', async () => {
    const { db, review } = await claimed();
    const list = await assess(db, review.id, C1, 'VERIFIED');
    const [claim] = list.claims;
    expect(claim).toMatchObject({
      claimId: C1,
      status: 'VERIFIED',
      finding: null,
      reviewedBy: { id: USER_A2, name: 'Bo' },
      reviewedAt: expect.any(Date),
    });
    expect(db.tables.claim).toEqual([
      expect.objectContaining({
        organizationId: ORG_A,
        reviewId: review.id,
        claimId: C1,
        claimContentHash: claimHash(db, PKG_REV_G, C1),
        status: 'VERIFIED',
        finding: null,
        reviewedByUserId: USER_A2,
        reviewedAt: expect.any(Date),
      }),
    ]);
    expect(list.summary).toMatchObject({ verified: 1, unreviewed: 1 });
  });

  it('CU4 a VERIFIED finding is kept exactly as written; a blank one is none', async () => {
    const { db, review } = await claimed();
    const finding = '  Checked against\nthe report.  ';
    expect(
      (await assess(db, review.id, C1, 'VERIFIED', finding)).claims[0].finding
    ).toBe(finding);
    expect(
      (await assess(db, review.id, C1, 'VERIFIED', '   ')).claims[0].finding
    ).toBe(null);
  });

  it('CU5/CU6 NEEDS_REVISION needs a finding and keeps it exactly', async () => {
    const { db, review } = await claimed();
    for (const finding of [undefined, null, '', '   \n ']) {
      expect(
        await code(assess(db, review.id, C1, 'NEEDS_REVISION', finding))
      ).toEqual({
        status: 400,
        code: 'CS_REVIEW_CLAIM_INVALID',
      });
    }
    expect(db.tables.claim).toEqual([]);
    const finding = 'The quote says ten,\n  not twenty.';
    const list = await assess(db, review.id, C2, 'NEEDS_REVISION', finding);
    expect(list.claims[1]).toMatchObject({
      status: 'NEEDS_REVISION',
      finding,
      reviewedBy: { id: USER_A2, name: 'Bo' },
    });
    expect(list.summary).toMatchObject({ needsRevision: 1, complete: false });
  });

  it.each([
    ['an unknown status', 'APPROVED', null],
    ['a lower-case status', 'verified', null],
    ['UNREVIEWED with a finding', 'UNREVIEWED', 'no'],
    ['a finding over 10,000 characters', 'VERIFIED', 'x'.repeat(10_001)],
    ['a NUL in a finding', 'NEEDS_REVISION', 'a\u0000b'],
    ['a finding that is not text', 'VERIFIED', 5],
  ])(
    'CD6/API refuses %s and writes nothing',
    async (_label, status, finding) => {
      const { db, review } = await claimed();
      expect(await code(assess(db, review.id, C1, status, finding))).toEqual({
        status: 400,
        code: 'CS_REVIEW_CLAIM_INVALID',
      });
      expect(db.tables.claim).toEqual([]);
    }
  );

  it('CU7/M7 reset to UNREVIEWED keeps the row and clears reviewer, time and finding', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'NEEDS_REVISION', 'Wrong figure.');
    const list = await assess(db, review.id, C1, 'UNREVIEWED', null);
    expect(list.claims[0]).toMatchObject({
      status: 'UNREVIEWED',
      finding: null,
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(db.tables.claim).toHaveLength(1);
    expect(db.tables.claim[0]).toMatchObject({
      status: 'UNREVIEWED',
      finding: null,
      reviewedByUserId: null,
      reviewedAt: null,
      claimContentHash: claimHash(db, PKG_REV_G, C1),
    });
  });

  it('a second assessment of a claim updates its one row: the later one wins', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED', null, USER_A);
    await assess(
      db,
      review.id,
      C1,
      'NEEDS_REVISION',
      'Changed my mind.',
      USER_A2
    );
    expect(db.tables.claim).toHaveLength(1);
    expect(db.tables.claim[0]).toMatchObject({
      status: 'NEEDS_REVISION',
      reviewedByUserId: USER_A2,
    });
  });

  it('CU9/M5 a stored row with another claim hash fails closed and is never overwritten', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    db.tables.claim[0].claimContentHash = 'f'.repeat(64);
    const before = JSON.stringify(db.tables.claim);
    expect(await code(listClaims(db, review.id))).toEqual({
      status: 500,
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    });
    expect(
      (await code(assess(db, review.id, C1, 'NEEDS_REVISION', 'x'))).code
    ).toBe('CS_REVIEW_INTEGRITY_ERROR');
    expect((await code(assess(db, review.id, C2, 'VERIFIED'))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    expect(JSON.stringify(db.tables.claim)).toBe(before);
  });

  it.each([
    [
      'M7 UNREVIEWED with a reviewer',
      {
        status: 'UNREVIEWED',
        reviewedByUserId: USER_A,
        reviewedAt: new Date(),
      },
    ],
    ['UNREVIEWED with a finding', { status: 'UNREVIEWED', finding: 'x' }],
    [
      'CD2 VERIFIED without a reviewer',
      { status: 'VERIFIED', reviewedAt: new Date() },
    ],
    [
      'CD2 VERIFIED without a time',
      { status: 'VERIFIED', reviewedByUserId: USER_A },
    ],
    [
      'M6 NEEDS_REVISION without a finding',
      {
        status: 'NEEDS_REVISION',
        reviewedByUserId: USER_A,
        reviewedAt: new Date(),
      },
    ],
    [
      'NEEDS_REVISION with a blank finding',
      {
        status: 'NEEDS_REVISION',
        finding: '  ',
        reviewedByUserId: USER_A,
        reviewedAt: new Date(),
      },
    ],
    [
      'an unknown status',
      { status: 'APPROVED', reviewedByUserId: USER_A, reviewedAt: new Date() },
    ],
    [
      'a reviewer that does not exist',
      { status: 'VERIFIED', reviewedByUserId: 'ghost', reviewedAt: new Date() },
    ],
  ])('a malformed stored row (%s) fails closed', async (_label, fields) => {
    const { db, review } = await claimed();
    db.tables.claim.push({
      id: 'claim-row-x',
      organizationId: ORG_A,
      reviewId: review.id,
      claimId: C1,
      claimContentHash: claimHash(db, PKG_REV_G, C1),
      finding: null,
      reviewedByUserId: null,
      reviewedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...fields,
    });
    expect((await code(listClaims(db, review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });

  it('two stored rows for one claim fail closed', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    db.tables.claim.push({ ...db.tables.claim[0], id: 'claim-row-copy' });
    expect((await code(listClaims(db, review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });

  it('CU10 a claim that is not in the reviewed revision is not found, and writes nothing', async () => {
    const { db, review } = await claimed();
    for (const claimId of [C3, 'c_unknown0000', 'item-1', '0', '../c1']) {
      expect(await code(assess(db, review.id, claimId, 'VERIFIED'))).toEqual({
        status: 404,
        code: 'CS_REVIEW_CLAIM_NOT_FOUND',
      });
    }
    expect(db.tables.claim).toEqual([]);
  });

  it('CU11/M8 REQUESTED: no assessment yet', async () => {
    const { db, review } = await claimed(false);
    expect(await code(assess(db, review.id, C1, 'VERIFIED'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN',
    });
    expect(db.tables.claim).toEqual([]);
  });

  it.each([
    ['CU12 CHANGES_REQUESTED', 'request-changes'],
    ['CU13/M9 READY_FOR_APPROVAL', 'ready-for-approval'],
    ['CU14 CANCELLED', 'cancel'],
  ] as const)(
    '%s: assessments are frozen and stay readable',
    async (_label, action) => {
      const { db, review } = await claimed(true, (rows) => [
        claimOf(C1, 'Sales grew.', [evidenceOf(rows[0])]),
      ]);
      await assess(db, review.id, C1, 'VERIFIED');
      await act(db, review.id, action);
      const before = JSON.stringify(db.tables.claim);
      for (const status of ['VERIFIED', 'NEEDS_REVISION', 'UNREVIEWED']) {
        expect(
          await code(
            assess(
              db,
              review.id,
              C1,
              status,
              status === 'NEEDS_REVISION' ? 'x' : null
            )
          )
        ).toEqual({ status: 409, code: 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN' });
      }
      expect(JSON.stringify(db.tables.claim)).toBe(before);
      expect((await listClaims(db, review.id)).claims[0].status).toBe(
        'VERIFIED'
      );
    }
  );

  it('CU15/M10 an assessment changes no review state, version or history; only its updatedAt moves', async () => {
    const { db, review } = await claimed();
    const before = { ...reviewRow(db, review.id) };
    const events = JSON.stringify(db.tables.event);
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'NEEDS_REVISION', 'Missing source.');
    await assess(db, review.id, C2, 'UNREVIEWED');
    const after = reviewRow(db, review.id);
    expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
    expect(after.state).toBe('IN_REVIEW');
    expect(after.version).toBe(2);
    expect(JSON.stringify(db.tables.event)).toBe(events);
  });

  it('M15 the write holds the review row IN_REVIEW at the version read, in the same transaction', async () => {
    const { db, review } = await claimed();
    db.log.length = 0;
    await assess(db, review.id, C1, 'VERIFIED');
    const writes = db.log.filter((entry) => /updateMany|create/.test(entry.op));
    expect(writes[0]).toEqual({
      op: 'review.updateMany',
      where: {
        id: review.id,
        organizationId: ORG_A,
        state: 'IN_REVIEW',
        version: 2,
      },
      data: { version: { increment: 0 } },
    });
    expect(writes.slice(1).map((entry) => entry.op)).toEqual([
      'claim.updateMany',
      'claim.create',
    ]);
  });

  it('RG7/M4 an assessment of a claim the revision does not have is an integrity error, never ignored', async () => {
    const { db, review } = await claimed();
    db.tables.claim.push({
      id: 'orphan',
      organizationId: ORG_A,
      reviewId: review.id,
      claimId: C3,
      claimContentHash: claimHash(db, PKG_REV_G_NEXT, C3),
      status: 'VERIFIED',
      finding: null,
      reviewedByUserId: USER_A,
      reviewedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await code(listClaims(db, review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    expect((await code(act(db, review.id, 'ready-for-approval'))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    expect(reviewRow(db, review.id).state).toBe('IN_REVIEW');
  });
});

describe('ContentStudioReviewService: design reviews have no claims (P5-03B)', () => {
  it('DR1/DR2/DR4 listing or assessing claims of a design review is refused, and nothing is read or written', async () => {
    const db = seeded();
    const review = await act(
      db,
      (
        await request(db, 'DESIGN_REVISION', DESIGN_REV_7)
      ).id,
      'start'
    );
    db.log.length = 0;
    expect(await code(listClaims(db, review.id))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CLAIMS_UNAVAILABLE',
    });
    expect(await code(assess(db, review.id, C1, 'VERIFIED'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CLAIMS_UNAVAILABLE',
    });
    expect(db.tables.claim).toEqual([]);
    expect(db.log.map((entry) => entry.op)).toEqual([
      'review.findFirst',
      'review.findFirst',
    ]);
  });

  it('DR3/M13 a design review becomes ready exactly as before: no claim or source query', async () => {
    const db = seeded();
    const review = await act(
      db,
      (
        await request(db, 'DESIGN_REVISION', DESIGN_REV_7)
      ).id,
      'start'
    );
    db.log.length = 0;
    const ready = await act(db, review.id, 'ready-for-approval');
    expect(ready.state).toBe('READY_FOR_APPROVAL');
    expect(db.log.map((entry) => entry.op)).not.toEqual(
      expect.arrayContaining(['claim.findMany'])
    );
    expect(db.log.map((entry) => entry.op)).not.toEqual(
      expect.arrayContaining(['sourceVersion.findMany'])
    );
  });
});

describe('ContentStudioReviewService: the READY_FOR_APPROVAL claim gate (P5-03B)', () => {
  const blocked = async (db: ReturnType<typeof createDb>, id: string) => {
    expect(await code(act(db, id, 'ready-for-approval'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CLAIMS_INCOMPLETE',
    });
    // rolled back: still IN_REVIEW at version 2 with two events
    expect(reviewRow(db, id)).toMatchObject({ state: 'IN_REVIEW', version: 2 });
    expect(db.tables.event.filter((e) => e.reviewId === id)).toHaveLength(2);
  };

  it('RG1 a v1 package review has no claims and becomes ready', async () => {
    const db = seeded();
    const review = await act(
      db,
      (
        await request(db, 'PACKAGE_REVISION', PKG_REV_4)
      ).id,
      'start'
    );
    expect((await act(db, review.id, 'ready-for-approval')).state).toBe(
      'READY_FOR_APPROVAL'
    );
  });

  it('RG2 a v2 package review without claims becomes ready', async () => {
    const { db } = await claimed();
    const review = await act(
      db,
      (
        await request(db, 'PACKAGE_REVISION', PKG_REV_EMPTY)
      ).id,
      'start'
    );
    expect((await act(db, review.id, 'ready-for-approval')).state).toBe(
      'READY_FOR_APPROVAL'
    );
  });

  it('RG4/M11 a claim without an assessment blocks it', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await blocked(db, review.id);
  });

  it('RG3 a claim reset to UNREVIEWED blocks it', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED');
    await assess(db, review.id, C2, 'UNREVIEWED');
    await blocked(db, review.id);
  });

  it('RG5/M12 a claim that needs revision blocks it', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'NEEDS_REVISION', 'Wrong source.');
    await blocked(db, review.id);
  });

  it('RG6/RRACE4 every claim VERIFIED: ready, version 3, event 3, assessments frozen', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED', 'Checked.');
    const ready = await act(db, review.id, 'ready-for-approval');
    expect(ready.state).toBe('READY_FOR_APPROVAL');
    expect(ready.version).toBe(3);
    expect(ready.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect((await listClaims(db, review.id)).summary.complete).toBe(true);
  });

  it('RG8 an assessment whose claim hash differs is an integrity error, never a pass', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED');
    db.tables.claim[1].claimContentHash = 'e'.repeat(64);
    expect((await code(act(db, review.id, 'ready-for-approval'))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
    expect(reviewRow(db, review.id).state).toBe('IN_REVIEW');
  });

  it("RG9/RG10/M14 the newer revision's claims never count: verifying revision 6 is enough", async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED');
    // revision 7 has C3, never assessed here
    expect((await act(db, review.id, 'ready-for-approval')).state).toBe(
      'READY_FOR_APPROVAL'
    );
  });

  it('the gate reads the assessments inside the transition, after the review row is held', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED');
    db.log.length = 0;
    await act(db, review.id, 'ready-for-approval');
    const ops = db.log.map((entry) => entry.op);
    const cas = ops.indexOf('review.updateMany');
    expect(cas).toBeGreaterThan(-1);
    expect(ops.slice(cas)).toEqual([
      'review.updateMany',
      'claim.findMany',
      'event.create',
      'review.findFirst',
    ]);
  });
});

describe('ContentStudioReviewService: claim review races (P5-03B)', () => {
  // the other request runs to completion exactly between this one's reads
  // and its transaction
  const between = <
    K extends 'transitionReviewWithCompareAndSwap' | 'setClaimAssessment'
  >(
    db: ReturnType<typeof createDb>,
    method: K,
    other: () => Promise<unknown>
  ) => {
    const original = db.repository[method].bind(db.repository) as (
      ...args: unknown[]
    ) => Promise<boolean>;
    let ran = false;
    (db.repository as unknown as Record<string, unknown>)[method] = async (
      ...args: unknown[]
    ) => {
      if (!ran) {
        ran = true;
        await other();
      }
      return original(...args);
    };
  };

  it('RRACE1/M16 a claim marked NEEDS_REVISION just before READY commits: READY fails and the review stays IN_REVIEW', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED');
    between(db, 'transitionReviewWithCompareAndSwap', () =>
      assess(
        db,
        review.id,
        C2,
        'NEEDS_REVISION',
        'Changed: the quote is wrong.'
      )
    );
    expect((await code(act(db, review.id, 'ready-for-approval'))).code).toBe(
      'CS_REVIEW_CLAIMS_INCOMPLETE'
    );
    expect(reviewRow(db, review.id)).toMatchObject({
      state: 'IN_REVIEW',
      version: 2,
    });
    expect(db.tables.claim[1].status).toBe('NEEDS_REVISION');
  });

  it('RRACE2/RRACE3 READY commits just before a NEEDS_REVISION: the assessment fails and VERIFIED stays', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    await assess(db, review.id, C2, 'VERIFIED');
    between(db, 'setClaimAssessment', () =>
      act(db, review.id, 'ready-for-approval')
    );
    expect(
      await code(assess(db, review.id, C2, 'NEEDS_REVISION', 'Too late.'))
    ).toEqual({ status: 409, code: 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN' });
    expect(reviewRow(db, review.id)).toMatchObject({
      state: 'READY_FOR_APPROVAL',
      version: 3,
    });
    expect(db.tables.claim.map((row) => row.status)).toEqual([
      'VERIFIED',
      'VERIFIED',
    ]);
    expect(
      db.tables.event.filter((e) => e.reviewId === review.id)
    ).toHaveLength(3);
  });

  it('RRACE3 truly at once: whichever order, never READY with a NEEDS_REVISION written', async () => {
    for (let round = 0; round < 2; round += 1) {
      const { db, review } = await claimed();
      await assess(db, review.id, C1, 'VERIFIED');
      await assess(db, review.id, C2, 'VERIFIED');
      const calls = [
        () => act(db, review.id, 'ready-for-approval'),
        () => assess(db, review.id, C2, 'NEEDS_REVISION', 'At once.'),
      ];
      if (round) {
        calls.reverse();
      }
      await Promise.allSettled(calls.map((call) => call()));
      const state = reviewRow(db, review.id).state;
      const status = db.tables.claim[1].status;
      expect([state, status]).not.toEqual([
        'READY_FOR_APPROVAL',
        'NEEDS_REVISION',
      ]);
      expect([
        ['READY_FOR_APPROVAL', 'VERIFIED'],
        ['IN_REVIEW', 'NEEDS_REVISION'],
      ]).toContainEqual([state, status]);
    }
  });

  it('a review row that moved to another version under the write writes nothing and fails closed', async () => {
    const { db, review } = await claimed();
    // no transition keeps IN_REVIEW while moving the version, so this can
    // only be a damaged row: the hold misses and the reread is refused
    between(db, 'setClaimAssessment', async () => {
      reviewRow(db, review.id).version = 99;
    });
    expect((await code(assess(db, review.id, C1, 'VERIFIED'))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });

  it('RACE3 two assessments of one claim at once: both serialize on the review row, one row, the later wins', async () => {
    const { db, review } = await claimed();
    await Promise.all([
      assess(db, review.id, C1, 'VERIFIED', null, USER_A),
      assess(db, review.id, C1, 'NEEDS_REVISION', 'Second.', USER_A2),
    ]);
    expect(db.tables.claim).toHaveLength(1);
    expect(db.tables.claim[0]).toMatchObject({
      status: 'NEEDS_REVISION',
      reviewedByUserId: USER_A2,
    });
  });

  it('CRACE1 an assessment before request-changes: both stand, the review ends CHANGES_REQUESTED', async () => {
    const { db, review } = await claimed();
    between(db, 'transitionReviewWithCompareAndSwap', () =>
      assess(db, review.id, C1, 'NEEDS_REVISION', 'Wrong figure.')
    );
    expect((await act(db, review.id, 'request-changes')).state).toBe(
      'CHANGES_REQUESTED'
    );
    expect(db.tables.claim[0].status).toBe('NEEDS_REVISION');
    expect(db.tables.revisionRequest).toHaveLength(1);
  });

  it('CRACE2/P502R4 request-changes first: a later assessment fails and nothing is written', async () => {
    const { db, review } = await claimed();
    between(db, 'setClaimAssessment', () =>
      act(db, review.id, 'request-changes')
    );
    expect(await code(assess(db, review.id, C1, 'VERIFIED'))).toEqual({
      status: 409,
      code: 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN',
    });
    expect(db.tables.claim).toEqual([]);
    expect(reviewRow(db, review.id).state).toBe('CHANGES_REQUESTED');
  });

  it('CRACE3 a request-changes that fails (a second revision request) still rolls back as a whole; assessments are untouched', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    db.tables.revisionRequest.push({
      id: 'existing',
      organizationId: ORG_A,
      reviewId: review.id,
      requestedByUserId: USER_A,
      body: 'x',
      status: 'OPEN',
      createdAt: new Date(),
    });
    const before = snapshot(db);
    expect((await code(act(db, review.id, 'request-changes'))).code).toBe(
      'CS_REVIEW_REVISION_REQUEST_ALREADY_EXISTS'
    );
    expect(snapshot(db)).toBe(before);
  });
});

describe('ContentStudioReviewService: claim review tenancy (P5-03B)', () => {
  it('CLSEC1/CLSEC2 another organization cannot list or assess the claims: a plain 404, nothing written', async () => {
    const { db, review } = await claimed();
    expect(await code(listClaims(db, review.id, ORG_B))).toEqual({
      status: 404,
      code: 'CS_NOT_FOUND',
    });
    expect(
      await code(assess(db, review.id, C1, 'VERIFIED', null, USER_B, ORG_B))
    ).toEqual({ status: 404, code: 'CS_NOT_FOUND' });
    expect(db.tables.claim).toEqual([]);
  });

  it("CLSEC3/M18 a review whose revision is another organization's binds nothing: integrity error", async () => {
    const { db, review } = await claimed();
    db.tables.packageRevision.push(groundedRevision(uuid(63), ORG_B, 1, []));
    reviewRow(db, review.id).packageRevisionId = uuid(63);
    expect((await code(listClaims(db, review.id))).code).toBe(
      'CS_REVIEW_INTEGRITY_ERROR'
    );
  });

  it('M17 every assessment read and write names the organization and the review', async () => {
    const { db, review } = await claimed();
    db.log.length = 0;
    await assess(db, review.id, C1, 'VERIFIED');
    // and the READY gate's read inside the transition
    await code(act(db, review.id, 'ready-for-approval'));
    expect(
      db.log.filter((e) => e.op === 'claim.findMany').length
    ).toBeGreaterThan(2);
    for (const entry of db.log.filter((e) => e.op.startsWith('claim.'))) {
      expect(entry.where ?? entry.data).toMatchObject({
        organizationId: ORG_A,
        reviewId: review.id,
      });
    }
  });
});

describe('ContentStudioReviewService: claim review and the discussion (P5-03B)', () => {
  it('P502R1/P502R2 NEEDS_REVISION writes no revision request and no comment', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'NEEDS_REVISION', 'Wrong figure.');
    expect(db.tables.revisionRequest).toEqual([]);
    expect(db.tables.comment).toEqual([]);
    expect(reviewRow(db, review.id).state).toBe('IN_REVIEW');
  });

  it('P502R3 request-changes still needs its own body', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'NEEDS_REVISION', 'Wrong figure.');
    expect(
      (
        await code(
          db.service.requestChanges({
            organizationId: ORG_A,
            userId: USER_A,
            id: review.id,
            body: '',
          })
        )
      ).code
    ).toBe('CS_REVIEW_REVISION_REQUEST_INVALID');
  });

  it("P502R5/P502R6/NCR the resolving revision's review starts with every claim UNREVIEWED; the old assessments stay", async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'NEEDS_REVISION', 'Wrong figure.');
    await act(db, review.id, 'request-changes');
    await db.service.resolveRevisionRequest({
      organizationId: ORG_A,
      userId: USER_A,
      reviewId: review.id,
      resolutionRevisionId: PKG_REV_G_NEXT,
    });
    const next = await act(
      db,
      (
        await request(db, 'PACKAGE_REVISION', PKG_REV_G_NEXT)
      ).id,
      'start'
    );
    const fresh = await listClaims(db, next.id);
    // C1 shares its id with revision 6's claim: no carry-over
    expect(fresh.claims.map((claim) => [claim.claimId, claim.status])).toEqual([
      [C1, 'UNREVIEWED'],
      [C3, 'UNREVIEWED'],
    ]);
    expect(fresh.claims[0].claimText).toBe('Sales grew by twenty percent.');
    const old = await listClaims(db, review.id);
    expect(old.claims[0]).toMatchObject({
      claimId: C1,
      status: 'NEEDS_REVISION',
      claimText: 'Sales grew by ten percent.',
    });
    expect(db.tables.claim).toHaveLength(1);
  });
});

describe('ContentStudioReviewService claim review boundaries (P5-03B)', () => {
  const source = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/\/\/.*$/gm, '');
  const root = join(__dirname, '..', '..', '..', '..', '..', '..');
  const schema = readFileSync(join(__dirname, '..', 'schema.prisma'), 'utf8');

  it('P503B-1/P503B-4/P503B-5 one claim model only: no source review or claim event model (the approval decisions are P5-04)', () => {
    const models = (schema.match(/^model \w+/gm) ?? []).filter((model) =>
      /Review|Approval|Claim/.test(model)
    );
    expect(models).toEqual([
      'model ContentStudioReview',
      'model ContentStudioReviewStateEvent',
      'model ContentStudioReviewComment',
      'model ContentStudioReviewRevisionRequest',
      'model ContentStudioReviewClaim',
      'model ContentStudioApproval',
    ]);
    // the existing APPROVED_SUBMIT_FOR_ORDER enum of posts is not an
    // approval; decisions are plain strings checked in code, not columns
    expect(schema.replace(/\/\/.*$/gm, '')).not.toMatch(
      /approvedBy|rejectedBy|approvedAt|\bAPPROVED\b/
    );
  });

  it('the assessment row holds no claim text, item, evidence or source', () => {
    const model = schema.slice(
      schema.indexOf('model ContentStudioReviewClaim {'),
      schema.indexOf('}', schema.indexOf('model ContentStudioReviewClaim {'))
    );
    expect(model).not.toMatch(
      /text|threadItem|evidence|source|quote|blockId|versionId|Json/i
    );
    expect(model).toMatch(/@@unique\(\[reviewId, organizationId, claimId\]\)/);
  });

  it('P503B-6/P503B-7/P503B-8 no AI operation, live fetch, ingestion or latest-version lookup in claim review', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      expect(source(file)).not.toMatch(
        /AIOperation|aiOperation|safeFetch|SafeFetch|fetch\(|ingest|refresh|getVersionDetailByNumber|latestVersionNumber|latestRevision|getPackageForOrganization|\.draft\b(?!')|draftVersion/i
      );
    }
  });

  it('P503B-2/P503B-3 handoff and publishing know nothing of claim review', () => {
    for (const file of [
      'content-studio.handoff.service.ts',
      'content-studio.handoff.repository.ts',
    ]) {
      expect(source(file)).not.toMatch(/claim|Claim|review|Review|READY/);
    }
  });

  it('P503B-10 assessing a claim requests no changes and writes no comment', () => {
    const text = source('content-studio.review.service.ts');
    const assessClaim = text.slice(
      text.indexOf('async assessClaim('),
      text.indexOf('private claimReview(')
    );
    expect(assessClaim).not.toMatch(
      /requestChanges|revisionRequest|createComment|transitionReview/
    );
  });

  it('P503B-11 assessments are only ever read for their own review', () => {
    const text = source('content-studio.review.repository.ts');
    const reads = text
      .split(/contentStudioReviewClaim\.(?:findMany|updateMany|create)\(/)
      .slice(1);
    expect(reads).toHaveLength(4);
    for (const read of reads) {
      expect(read.slice(0, 300)).toMatch(/reviewId/);
    }
  });

  it('P503B-12/P503B-13/P503B-14 package grounding, the Design Document and dependencies are unchanged', () => {
    const draft = readFileSync(
      join(
        root,
        'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts'
      ),
      'utf8'
    );
    expect(draft).toMatch(
      /export const CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION = 2;/
    );
    expect(draft).not.toMatch(/status|VERIFIED|reviewed/);
    const design = readFileSync(
      join(
        root,
        'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      ),
      'utf8'
    );
    expect(design).toMatch(/export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;/);
    expect(design).not.toMatch(/claim/i);
  });
});

// --- approval decisions (P5-04) ---

const decide = (
  db: Db,
  reviewId: string,
  action: 'approve' | 'refuse' | 'withdraw',
  note?: unknown,
  user = USER_A2,
  org = ORG_A
) =>
  db.service.decideApproval({
    organizationId: org,
    userId: user,
    reviewId,
    action,
    note,
  });
const approvalOf = (db: Db, reviewId: string, org = ORG_A) =>
  db.service.getApproval({ organizationId: org, reviewId });
const readyPackage = async () => {
  const db = discussion();
  const review = await reviewIn(db, 'READY_FOR_APPROVAL');
  return { db, review };
};
const readyDesign = async () => {
  const db = discussion();
  const review = await reviewIn(
    db,
    'READY_FOR_APPROVAL',
    'DESIGN_REVISION',
    DESIGN_REV_7
  );
  return { db, review };
};
// a grounded package review whose two claims are verified, made ready
const readyClaimed = async () => {
  const { db, review } = await claimed();
  await assess(db, review.id, C1, 'VERIFIED');
  await assess(db, review.id, C2, 'VERIFIED', 'Checked.');
  const ready = await act(db, review.id, 'ready-for-approval');
  return { db, review: ready };
};
const REFUSAL = 'The offer is not cleared by legal.';
const WITHDRAWAL = 'Decided too early: legal is still checking.';
const decisions = (db: Db) =>
  db.tables.approval.map((row) => [row.sequence, row.decision]);

describe('ContentStudioReviewService: approving (P5-04)', () => {
  it('AC1/AC7 a READY package review is approved: decision 1, bound to its exact revision and hash', async () => {
    const { db, review } = await readyPackage();
    const stored = db.tables.packageRevision.find((r) => r.id === PKG_REV_4)!;
    const approval = await decide(db, review.id, 'approve');
    expect(approval).toEqual({
      reviewId: review.id,
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: PKG_REV_4,
      targetRevisionNumber: 4,
      targetContentHash: stored.contentHash,
      state: 'APPROVED',
      version: 1,
      history: [
        {
          sequence: 1,
          decision: 'APPROVED',
          note: null,
          actor: { id: USER_A2, name: 'Bo' },
          createdAt: expect.any(Date),
        },
      ],
    });
    expect(db.tables.approval).toEqual([
      {
        id: expect.any(String),
        organizationId: ORG_A,
        reviewId: review.id,
        sequence: 1,
        decision: 'APPROVED',
        packageRevisionId: PKG_REV_4,
        designRevisionId: null,
        targetContentHash: stored.contentHash,
        actorUserId: USER_A2,
        note: null,
        createdAt: expect.any(Date),
      },
    ]);
    // no content, no updatedAt: a decision is never changed
    expect(JSON.stringify(db.tables.approval)).not.toContain(SECRET);
    expect(JSON.stringify(approval)).not.toContain(SECRET);
  });

  it('AC2/AI2 a READY design review is approved the same way, bound to its design revision', async () => {
    const { db, review } = await readyDesign();
    const stored = db.tables.designRevision.find((r) => r.id === DESIGN_REV_7)!;
    const approval = await decide(db, review.id, 'approve', 'On brand.');
    expect(approval).toMatchObject({
      targetType: 'DESIGN_REVISION',
      targetRevisionId: DESIGN_REV_7,
      targetRevisionNumber: 7,
      targetContentHash: stored.contentHash,
      state: 'APPROVED',
      version: 1,
    });
    expect(db.tables.approval[0]).toMatchObject({
      packageRevisionId: null,
      designRevisionId: DESIGN_REV_7,
      targetContentHash: stored.contentHash,
      note: 'On brand.',
    });
  });

  it('AC3 a READY package review is refused with its note, kept exactly', async () => {
    const { db, review } = await readyPackage();
    const note = '  Not on brand.\n\nSee the second post.  ';
    const approval = await decide(db, review.id, 'refuse', note);
    expect(approval.state).toBe('REFUSED');
    expect(approval.history[0]).toMatchObject({ decision: 'REFUSED', note });
    expect(db.tables.approval[0].note).toBe(note);
  });

  it('FA9/AC approving takes an optional note: none, null or blank is none, text is kept exactly', async () => {
    for (const [note, stored] of [
      [undefined, null],
      [null, null],
      ['', null],
      ['  \n ', null],
      [' Looks good. ', ' Looks good. '],
    ]) {
      const { db, review } = await readyPackage();
      await decide(db, review.id, 'approve', note);
      expect(db.tables.approval[0].note).toBe(stored);
    }
  });

  it("AC4/AC5/AC6/AC10 the actor, hash, revision and sequence are the server's: nothing the caller adds is used", async () => {
    const { db, review } = await readyPackage();
    const stored = db.tables.packageRevision.find((r) => r.id === PKG_REV_4)!;
    await db.service.decideApproval({
      organizationId: ORG_A,
      userId: USER_A2,
      reviewId: review.id,
      action: 'approve',
      note: null,
      ...({
        actorUserId: USER_B,
        targetContentHash: 'f'.repeat(64),
        packageRevisionId: PKG_REV_5,
        designRevisionId: DESIGN_REV_7,
        sequence: 7,
        decision: 'REFUSED',
        state: 'APPROVED',
      } as object),
    });
    expect(db.tables.approval).toEqual([
      expect.objectContaining({
        sequence: 1,
        decision: 'APPROVED',
        actorUserId: USER_A2,
        packageRevisionId: PKG_REV_4,
        designRevisionId: null,
        targetContentHash: stored.contentHash,
      }),
    ]);
  });

  it('AC8/UCON6/P504 the review keeps its state, version and events; only its updatedAt may move', async () => {
    const { db, review } = await readyPackage();
    const before = reviewFacts(db);
    await decide(db, review.id, 'approve');
    await decide(db, review.id, 'withdraw', WITHDRAWAL);
    await decide(db, review.id, 'refuse', REFUSAL);
    expect(reviewFacts(db)).toBe(before);
    expect(reviewRow(db, review.id)).toMatchObject({
      state: 'READY_FOR_APPROVAL',
      version: 3,
    });
  });

  it.each([
    ['REQUESTED'],
    ['IN_REVIEW'],
    ['CHANGES_REQUESTED'],
    ['CANCELLED'],
  ] as const)(
    'AC9/P503R2/M8 a %s review has no approval: every decision and the read are CS_APPROVAL_UNAVAILABLE',
    async (state) => {
      const db = discussion();
      const review = await reviewIn(db, state);
      const before = snapshot(db);
      for (const [action, note] of [
        ['approve', undefined],
        ['refuse', REFUSAL],
        ['withdraw', WITHDRAWAL],
      ] as const) {
        expect(await code(decide(db, review.id, action, note))).toEqual({
          status: 409,
          code: 'CS_APPROVAL_UNAVAILABLE',
        });
      }
      expect(await code(approvalOf(db, review.id))).toEqual({
        status: 409,
        code: 'CS_APPROVAL_UNAVAILABLE',
      });
      expect(snapshot(db)).toBe(before);
    }
  );

  it('FA2 a READY review without decisions is PENDING at version 0', async () => {
    const { db, review } = await readyPackage();
    expect(await approvalOf(db, review.id)).toEqual({
      reviewId: review.id,
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: PKG_REV_4,
      targetRevisionNumber: 4,
      targetContentHash: review.targetContentHash,
      state: 'PENDING',
      version: 0,
      history: [],
    });
  });

  it('the requester and a reviewer of the review may decide too (no approver role yet)', async () => {
    const { db, review } = await readyPackage();
    // USER_A requested, started and readied it
    expect((await decide(db, review.id, 'approve', null, USER_A)).state).toBe(
      'APPROVED'
    );
  });
});

describe('ContentStudioReviewService: withdrawing a decision (P5-04)', () => {
  it('AW1/AW5/AW6 APPROVED -> WITHDRAWN: decision 2, the approval is PENDING again', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    const approval = await decide(db, review.id, 'withdraw', WITHDRAWAL);
    expect(approval.state).toBe('PENDING');
    expect(approval.version).toBe(2);
    expect(approval.history.map((h) => [h.sequence, h.decision])).toEqual([
      [1, 'APPROVED'],
      [2, 'WITHDRAWN'],
    ]);
    expect(approval.history[1].note).toBe(WITHDRAWAL);
  });

  it('AW2 REFUSED -> WITHDRAWN', async () => {
    const { db, review } = await readyDesign();
    await decide(db, review.id, 'refuse', REFUSAL);
    expect((await decide(db, review.id, 'withdraw', WITHDRAWAL)).state).toBe(
      'PENDING'
    );
    expect(decisions(db)).toEqual([
      [1, 'REFUSED'],
      [2, 'WITHDRAWN'],
    ]);
  });

  it('AW3/M10 withdrawing needs a note with text; nothing is written without one', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    const before = snapshot(db);
    for (const note of [undefined, null, '', '   ', '\n\t', 'a\u0000b', 5]) {
      expect(await code(decide(db, review.id, 'withdraw', note))).toEqual({
        status: 400,
        code: 'CS_APPROVAL_NOTE_INVALID',
      });
    }
    expect(snapshot(db)).toBe(before);
  });

  it('AW4/AH3/M11 earlier decisions are never changed: every later one is a new row', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve', 'First look.');
    const first = JSON.stringify(db.tables.approval[0]);
    await decide(db, review.id, 'withdraw', WITHDRAWAL);
    const second = JSON.stringify(db.tables.approval[1]);
    await decide(db, review.id, 'refuse', REFUSAL);
    expect(JSON.stringify(db.tables.approval[0])).toBe(first);
    expect(JSON.stringify(db.tables.approval[1])).toBe(second);
    expect(db.tables.approval).toHaveLength(3);
    // the history is appended, never updated
    expect(
      db.log.map((e) => e.op).filter((op) => /approval\./.test(op))
    ).not.toContain('approval.updateMany');
  });

  it('AW7 approving after a withdrawal is decision 3', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'refuse', REFUSAL);
    await decide(db, review.id, 'withdraw', WITHDRAWAL);
    const approval = await decide(db, review.id, 'approve');
    expect(approval).toMatchObject({ state: 'APPROVED', version: 3 });
    expect(decisions(db)).toEqual([
      [1, 'REFUSED'],
      [2, 'WITHDRAWN'],
      [3, 'APPROVED'],
    ]);
  });

  it('AW8 refusing after a withdrawal is decision 3', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    await decide(db, review.id, 'withdraw', WITHDRAWAL);
    expect((await decide(db, review.id, 'refuse', REFUSAL)).state).toBe(
      'REFUSED'
    );
    expect(decisions(db)).toEqual([
      [1, 'APPROVED'],
      [2, 'WITHDRAWN'],
      [3, 'REFUSED'],
    ]);
  });
});

describe('ContentStudioReviewService: refusing (P5-04)', () => {
  it('AR1/M9 refusing needs a note with text; nothing is written without one', async () => {
    const { db, review } = await readyPackage();
    const before = snapshot(db);
    for (const note of [undefined, null, '', '  ', 'x'.repeat(10_001)]) {
      expect(await code(decide(db, review.id, 'refuse', note))).toEqual({
        status: 400,
        code: 'CS_APPROVAL_NOTE_INVALID',
      });
    }
    expect(snapshot(db)).toBe(before);
    // the limit itself is fine
    const max = 'x'.repeat(10_000);
    expect((await decide(db, review.id, 'refuse', max)).history[0].note).toBe(
      max
    );
  });

  it('a note over the limit or with NUL is refused for an approval too', async () => {
    const { db, review } = await readyPackage();
    for (const note of ['x'.repeat(10_001), ' '.repeat(10_001), 'a\u0000', 5]) {
      expect((await code(decide(db, review.id, 'approve', note))).code).toBe(
        'CS_APPROVAL_NOTE_INVALID'
      );
    }
    expect(db.tables.approval).toEqual([]);
  });

  it('AR2/AR3/AR4/P502R1/M26 a refusal requests no changes: no revision request, no comment, the review unchanged', async () => {
    const { db, review } = await readyPackage();
    const before = reviewFacts(db);
    db.log.length = 0;
    await decide(db, review.id, 'refuse', REFUSAL);
    expect(db.tables.revisionRequest).toEqual([]);
    expect(db.tables.comment).toEqual([]);
    expect(reviewFacts(db)).toBe(before);
    expect(reviewRow(db, review.id).state).toBe('READY_FOR_APPROVAL');
    // and no new revision, review or event either: one write only
    expect(db.tables.review).toHaveLength(1);
    expect(
      db.log.map((e) => e.op).filter((op) => /create|updateMany/.test(op))
    ).toEqual(['review.updateMany', 'approval.create']);
  });

  it('AR5/P503R3 decisions never touch the claim assessments', async () => {
    const { db, review } = await readyClaimed();
    const claims = JSON.stringify(db.tables.claim);
    db.log.length = 0;
    await decide(db, review.id, 'refuse', REFUSAL);
    await decide(db, review.id, 'withdraw', WITHDRAWAL);
    await decide(db, review.id, 'approve');
    expect(JSON.stringify(db.tables.claim)).toBe(claims);
    // read to check them, never written
    expect(db.log.filter((e) => e.op === 'claim.findMany')).not.toEqual([]);
    expect(
      db.log.filter((e) => /^claim\.(updateMany|create)$/.test(e.op))
    ).toEqual([]);
  });
});

describe('ContentStudioReviewService: legal approval decisions (P5-04)', () => {
  const invalid = async (
    db: Db,
    reviewId: string,
    action: 'approve' | 'refuse' | 'withdraw'
  ) => {
    const before = snapshot(db);
    expect(
      await code(
        decide(db, reviewId, action, action === 'approve' ? null : 'Because.')
      )
    ).toEqual({ status: 409, code: 'CS_APPROVAL_INVALID_DECISION' });
    expect(snapshot(db)).toBe(before);
  };

  it('AD8/M1 PENDING cannot be withdrawn', async () => {
    const { db, review } = await readyPackage();
    await invalid(db, review.id, 'withdraw');
  });

  it('AD10/AD11/M2/M3 APPROVED is only withdrawn: no second approval, no direct refusal', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    await invalid(db, review.id, 'approve');
    await invalid(db, review.id, 'refuse');
  });

  it('AD13 REFUSED is only withdrawn: no approval, no second refusal', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'refuse', REFUSAL);
    await invalid(db, review.id, 'approve');
    await invalid(db, review.id, 'refuse');
  });

  it('WITHDRAWN cannot be withdrawn again', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    await decide(db, review.id, 'withdraw', WITHDRAWAL);
    await invalid(db, review.id, 'withdraw');
  });

  it('an unknown action decides nothing', async () => {
    const { db, review } = await readyPackage();
    await expect(
      db.service.decideApproval({
        organizationId: ORG_A,
        userId: USER_A,
        reviewId: review.id,
        action: 'reject' as 'approve',
        note: 'x',
      })
    ).rejects.toThrow();
    expect(db.tables.approval).toEqual([]);
  });
});

describe('ContentStudioReviewService: approval target integrity (P5-04)', () => {
  const broken = async (
    db: Db,
    reviewId: string,
    errorCode: string,
    status = 500
  ) => {
    const before = snapshot(db);
    expect(await code(approvalOf(db, reviewId))).toEqual({
      status,
      code: errorCode,
    });
    for (const [action, note] of [
      ['approve', null],
      ['refuse', REFUSAL],
      ['withdraw', WITHDRAWAL],
    ] as const) {
      expect(await code(decide(db, reviewId, action, note))).toEqual({
        status,
        code: errorCode,
      });
    }
    expect(snapshot(db)).toBe(before);
  };

  it('AI1 a package decision keeps the exact revision id and stored hash', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    const stored = db.tables.packageRevision.find((r) => r.id === PKG_REV_4)!;
    expect(db.tables.approval[0]).toMatchObject({
      packageRevisionId: PKG_REV_4,
      designRevisionId: null,
      targetContentHash: stored.contentHash,
    });
  });

  it('AI9/M7 a reviewed revision that changed stops every approval read and decision', async () => {
    const { db, review } = await readyPackage();
    const stored = db.tables.packageRevision.find((r) => r.id === PKG_REV_4)!;
    stored.content = stored.content.replace('v4', 'v9');
    await broken(db, review.id, 'CS_REVIEW_INTEGRITY_ERROR');
  });

  it('AI9 a design revision whose hash no longer matches stops it too', async () => {
    const { db, review } = await readyDesign();
    const stored = db.tables.designRevision.find((r) => r.id === DESIGN_REV_7)!;
    stored.content = stored.content.replace('#ffffff', '#fffffe');
    await broken(db, review.id, 'CS_REVIEW_INTEGRITY_ERROR');
  });

  it('a review whose state history is broken has no approval', async () => {
    const { db, review } = await readyPackage();
    db.tables.event.pop();
    await broken(db, review.id, 'CS_REVIEW_INTEGRITY_ERROR');
  });

  it('AI10/P503R4/M17 a package review whose claim assessments are corrupt has no approval', async () => {
    for (const corrupt of [
      // a claim no longer verified although the review is ready
      (db: Db) => {
        db.tables.claim[1].status = 'NEEDS_REVISION';
        db.tables.claim[1].finding = 'Changed behind the service.';
      },
      // an assessment of another claim hash
      (db: Db) => {
        db.tables.claim[0].claimContentHash = 'e'.repeat(64);
      },
      // an assessment of no claim of the revision
      (db: Db) => {
        db.tables.claim[0].claimId = 'c_orphan000000000001';
      },
      // a claim without its assessment row
      (db: Db) => {
        db.tables.claim.pop();
      },
    ]) {
      const { db, review } = await readyClaimed();
      corrupt(db);
      await broken(db, review.id, 'CS_REVIEW_INTEGRITY_ERROR');
    }
  });

  it('a package review without claims, and a design review, need no claim assessment', async () => {
    const { db, review } = await readyPackage();
    expect((await decide(db, review.id, 'approve')).state).toBe('APPROVED');
    const design = await readyDesign();
    design.db.log.length = 0;
    await decide(design.db, design.review.id, 'approve');
    // AI2: a design approval reads no claim or source
    expect(
      design.db.log.filter((e) => /claim\.|sourceVersion\./.test(e.op))
    ).toEqual([]);
  });

  it('M6 the exact reviewed revision is read, never the newer one of the same package', async () => {
    const { db, review } = await readyPackage();
    db.log.length = 0;
    await decide(db, review.id, 'approve');
    await approvalOf(db, review.id);
    const reads = db.log.filter((e) => e.op === 'packageRevision.findFirst');
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.where).toEqual({ id: PKG_REV_4, organizationId: ORG_A });
    }
  });
});

describe('ContentStudioReviewService: stored approval history (P5-04)', () => {
  // a valid row, then broken as each test needs
  const row = (db: Db, review: { id: string }, overrides: Row = {}) => {
    const stored = db.tables.packageRevision.find((r) => r.id === PKG_REV_4)!;
    return {
      id: uuid(9900 + db.tables.approval.length),
      organizationId: ORG_A,
      reviewId: review.id,
      sequence: db.tables.approval.length + 1,
      decision: 'APPROVED',
      packageRevisionId: PKG_REV_4,
      designRevisionId: null,
      targetContentHash: stored.contentHash,
      actorUserId: USER_A2,
      note: null,
      createdAt: new Date('2026-10-19T12:00:00.000Z'),
      ...overrides,
    };
  };
  const corrupt = async (rows: (db: Db, review: { id: string }) => Row[]) => {
    const { db, review } = await readyPackage();
    db.tables.approval.push(...rows(db, review));
    const before = snapshot(db);
    expect(await code(approvalOf(db, review.id))).toEqual({
      status: 500,
      code: 'CS_APPROVAL_INTEGRITY_ERROR',
    });
    for (const [action, note] of [
      ['approve', null],
      ['refuse', REFUSAL],
      ['withdraw', WITHDRAWAL],
    ] as const) {
      expect((await code(decide(db, review.id, action, note))).code).toBe(
        'CS_APPROVAL_INTEGRITY_ERROR'
      );
    }
    expect(snapshot(db)).toBe(before);
  };

  it('a whole stored history reads back as written', async () => {
    const { db, review } = await readyPackage();
    db.tables.approval.push(row(db, review));
    db.tables.approval.push(
      row(db, review, { decision: 'WITHDRAWN', note: 'Why.' })
    );
    expect((await approvalOf(db, review.id)).state).toBe('PENDING');
  });

  it('AH2/AD14/M4 a history that does not start at 1 fails closed', async () => {
    await corrupt((db, review) => [row(db, review, { sequence: 2 })]);
  });

  it('AH1/AD14/M4 a gap in the sequence fails closed', async () => {
    await corrupt((db, review) => [
      row(db, review),
      row(db, review, { sequence: 3, decision: 'WITHDRAWN', note: 'Why.' }),
    ]);
  });

  it('AH4 APPROVED followed directly by REFUSED fails closed', async () => {
    await corrupt((db, review) => [
      row(db, review),
      { ...row(db, review), sequence: 2, decision: 'REFUSED', note: 'No.' },
    ]);
  });

  it('AH5 two approvals in a row fail closed', async () => {
    await corrupt((db, review) => [
      row(db, review),
      { ...row(db, review), sequence: 2 },
    ]);
  });

  it('AH6 a withdrawal of nothing fails closed', async () => {
    await corrupt((db, review) => [
      row(db, review, { decision: 'WITHDRAWN', note: 'Why.' }),
    ]);
  });

  it('AD15 an unknown decision fails closed', async () => {
    await corrupt((db, review) => [row(db, review, { decision: 'REJECTED' })]);
    await corrupt((db, review) => [row(db, review, { decision: 'approved' })]);
  });

  it('AI3/AH8 a decision with another hash fails closed', async () => {
    await corrupt((db, review) => [
      row(db, review, { targetContentHash: 'e'.repeat(64) }),
    ]);
  });

  it('AI4 a decision about another package revision fails closed', async () => {
    await corrupt((db, review) => [
      row(db, review, { packageRevisionId: PKG_REV_5 }),
    ]);
  });

  it('AI5 a decision about another design revision fails closed', async () => {
    const { db, review } = await readyDesign();
    const stored = db.tables.designRevision.find((r) => r.id === DESIGN_REV_7)!;
    db.tables.approval.push({
      ...row(db, review),
      packageRevisionId: null,
      designRevisionId: DESIGN_REV_8,
      targetContentHash: stored.contentHash,
    });
    expect((await code(approvalOf(db, review.id))).code).toBe(
      'CS_APPROVAL_INTEGRITY_ERROR'
    );
  });

  it('AI6/AI7 a decision naming both revisions, or neither, fails closed', async () => {
    await corrupt((db, review) => [
      row(db, review, { designRevisionId: DESIGN_REV_7 }),
    ]);
    await corrupt((db, review) => [
      row(db, review, { packageRevisionId: null }),
    ]);
  });

  it('AH7 a decision whose actor is gone, or a stored note that is not whole, fails closed', async () => {
    await corrupt((db, review) => [row(db, review, { actorUserId: 'ghost' })]);
    await corrupt((db, review) => [
      row(db, review, { decision: 'REFUSED', note: null }),
    ]);
    await corrupt((db, review) => [row(db, review, { note: '   ' })]);
  });

  it('AH7 the actor is told by id and name only', async () => {
    const { db, review } = await readyPackage();
    db.tables.user.find((u) => u.id === USER_A2)!.email = 'bo@example.com';
    const approval = await decide(db, review.id, 'approve');
    expect(Object.keys(approval.history[0].actor).sort()).toEqual([
      'id',
      'name',
    ]);
    expect(JSON.stringify(approval)).not.toMatch(/example\.com|org-a/);
  });

  it('decisions stored for a review that is not ready fail closed', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    db.tables.approval.push(row(db, review));
    expect(await code(approvalOf(db, review.id))).toEqual({
      status: 500,
      code: 'CS_APPROVAL_INTEGRITY_ERROR',
    });
  });

  it('P502R4 a history entry has the decision, note, actor, time and sequence only', async () => {
    const { db, review } = await readyPackage();
    const approval = await decide(db, review.id, 'refuse', REFUSAL);
    expect(Object.keys(approval).sort()).toEqual([
      'history',
      'reviewId',
      'state',
      'targetContentHash',
      'targetRevisionId',
      'targetRevisionNumber',
      'targetType',
      'version',
    ]);
    expect(Object.keys(approval.history[0]).sort()).toEqual([
      'actor',
      'createdAt',
      'decision',
      'note',
      'sequence',
    ]);
  });
});

describe('ContentStudioReviewService: approval tenancy (P5-04)', () => {
  it('ASEC1-ASEC4 another organization reads and decides nothing: a plain 404', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    const before = snapshot(db);
    expect(await code(approvalOf(db, review.id, ORG_B))).toEqual({
      status: 404,
      code: 'CS_NOT_FOUND',
    });
    for (const [action, note] of [
      ['approve', null],
      ['refuse', REFUSAL],
      ['withdraw', WITHDRAWAL],
    ] as const) {
      expect(
        await code(decide(db, review.id, action, note, USER_B, ORG_B))
      ).toEqual({ status: 404, code: 'CS_NOT_FOUND' });
    }
    expect(snapshot(db)).toBe(before);
  });

  it('M15/M16 every approval query names the organization', async () => {
    const { db, review } = await readyClaimed();
    db.log.length = 0;
    await decide(db, review.id, 'approve');
    await approvalOf(db, review.id);
    const reads = db.log.filter((e) => e.where);
    expect(reads.length).toBeGreaterThan(5);
    for (const read of reads) {
      expect(read.where!.organizationId).toBe(ORG_A);
    }
    expect(
      db.log.filter((e) => e.op === 'approval.create')[0].data!.organizationId
    ).toBe(ORG_A);
  });

  it('AI8 a decision row of another organization is not part of the history', async () => {
    const { db, review } = await readyPackage();
    db.tables.approval.push({
      id: uuid(9990),
      organizationId: ORG_B,
      reviewId: review.id,
      sequence: 1,
      decision: 'APPROVED',
      packageRevisionId: PKG_REV_4,
      designRevisionId: null,
      targetContentHash: review.targetContentHash,
      actorUserId: USER_B,
      note: null,
      createdAt: new Date(),
    });
    expect((await approvalOf(db, review.id)).state).toBe('PENDING');
  });
});

describe('ContentStudioReviewService: approval races (P5-04)', () => {
  // the other request runs to completion exactly between this one's reads
  // and its transaction
  const between = (db: Db, other: () => Promise<unknown>) => {
    const original = db.repository.appendApprovalDecision.bind(db.repository);
    let ran = false;
    db.repository.appendApprovalDecision = async (input) => {
      if (!ran) {
        ran = true;
        await other();
      }
      return original(input);
    };
  };
  const settle = async (...calls: Promise<unknown>[]) => {
    const results = await Promise.allSettled(calls);
    return results.map((result) =>
      result.status === 'fulfilled'
        ? 'ok'
        : ((result.reason as HttpException).getResponse() as Row).code
    );
  };

  it('UCON1 approve and refuse at once: one wins, the other is CS_APPROVAL_CONFLICT, one decision', async () => {
    for (const first of ['approve', 'refuse'] as const) {
      const { db, review } = await readyPackage();
      const results = await settle(
        first === 'approve'
          ? decide(db, review.id, 'approve')
          : decide(db, review.id, 'refuse', REFUSAL),
        first === 'approve'
          ? decide(db, review.id, 'refuse', REFUSAL, USER_A)
          : decide(db, review.id, 'approve', null, USER_A)
      );
      expect(results).toEqual(['ok', 'CS_APPROVAL_CONFLICT']);
      expect(db.tables.approval).toHaveLength(1);
      expect((await approvalOf(db, review.id)).state).toBe(
        first === 'approve' ? 'APPROVED' : 'REFUSED'
      );
    }
  });

  it("UCON1 a refusal that commits between an approval's read and its transaction wins", async () => {
    const { db, review } = await readyPackage();
    between(db, () => decide(db, review.id, 'refuse', REFUSAL, USER_A));
    expect(await code(decide(db, review.id, 'approve'))).toEqual({
      status: 409,
      code: 'CS_APPROVAL_CONFLICT',
    });
    expect(decisions(db)).toEqual([[1, 'REFUSED']]);
  });

  it('UCON2 two approvals at once: one row', async () => {
    const { db, review } = await readyDesign();
    expect(
      await settle(
        decide(db, review.id, 'approve'),
        decide(db, review.id, 'approve', null, USER_A)
      )
    ).toEqual(['ok', 'CS_APPROVAL_CONFLICT']);
    expect(decisions(db)).toEqual([[1, 'APPROVED']]);
  });

  it('UCON3 two withdrawals at once: one WITHDRAWN row', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    expect(
      await settle(
        decide(db, review.id, 'withdraw', WITHDRAWAL),
        decide(db, review.id, 'withdraw', 'Me too.', USER_A)
      )
    ).toEqual(['ok', 'CS_APPROVAL_CONFLICT']);
    expect(decisions(db)).toEqual([
      [1, 'APPROVED'],
      [2, 'WITHDRAWN'],
    ]);
  });

  it('UCON4/M14 a withdrawal decided on a stale history conflicts: it never withdraws the newer approval', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    // someone else withdraws and approves again in the meantime
    between(db, async () => {
      await decide(db, review.id, 'withdraw', 'Rechecking.', USER_A);
      await decide(db, review.id, 'approve', 'Rechecked.', USER_A);
    });
    expect(await code(decide(db, review.id, 'withdraw', WITHDRAWAL))).toEqual({
      status: 409,
      code: 'CS_APPROVAL_CONFLICT',
    });
    expect(decisions(db)).toEqual([
      [1, 'APPROVED'],
      [2, 'WITHDRAWN'],
      [3, 'APPROVED'],
    ]);
  });

  it('UCON4 an approval decided on PENDING conflicts once the history moved on, even back to PENDING', async () => {
    const { db, review } = await readyPackage();
    between(db, async () => {
      await decide(db, review.id, 'refuse', REFUSAL, USER_A);
      await decide(db, review.id, 'withdraw', WITHDRAWAL, USER_A);
    });
    expect((await code(decide(db, review.id, 'approve'))).code).toBe(
      'CS_APPROVAL_CONFLICT'
    );
    expect(decisions(db)).toEqual([
      [1, 'REFUSED'],
      [2, 'WITHDRAWN'],
    ]);
  });

  it('PG9 a refusal asked for while APPROVED is never reinterpreted after a withdrawal', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    // the withdrawal commits right after the refusal read APPROVED
    const repository = db.repository as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const original = repository.listApprovalsForReview.bind(db.repository);
    let ran = false;
    repository.listApprovalsForReview = async (...args) => {
      const rows = await original(...args);
      if (!ran) {
        ran = true;
        await decide(db, review.id, 'withdraw', WITHDRAWAL, USER_A);
      }
      return rows;
    };
    expect((await code(decide(db, review.id, 'refuse', REFUSAL))).code).toBe(
      'CS_APPROVAL_INVALID_DECISION'
    );
    expect(decisions(db)).toEqual([
      [1, 'APPROVED'],
      [2, 'WITHDRAWN'],
    ]);
  });

  it('UCON5 many decisions at once: the sequence stays 1, 2, 3... without a gap or a duplicate', async () => {
    const { db, review } = await readyPackage();
    for (let round = 0; round < 3; round += 1) {
      await settle(
        decide(db, review.id, 'approve'),
        decide(db, review.id, 'refuse', REFUSAL, USER_A),
        decide(db, review.id, 'approve', null, USER_A)
      );
      await settle(
        decide(db, review.id, 'withdraw', WITHDRAWAL),
        decide(db, review.id, 'withdraw', WITHDRAWAL, USER_A)
      );
    }
    expect(db.tables.approval.map((r) => r.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(db.tables.approval.map((r) => r.decision)).toEqual([
      expect.stringMatching(/^(APPROVED|REFUSED)$/),
      'WITHDRAWN',
      expect.stringMatching(/^(APPROVED|REFUSED)$/),
      'WITHDRAWN',
      expect.stringMatching(/^(APPROVED|REFUSED)$/),
      'WITHDRAWN',
    ]);
    expect((await approvalOf(db, review.id)).state).toBe('PENDING');
  });

  it('M12/M13 the decision is appended inside one transaction after the review row is held and the history read again', async () => {
    const { db, review } = await readyPackage();
    db.log.length = 0;
    await decide(db, review.id, 'approve');
    const ops = db.log.map((e) => e.op);
    const hold = ops.lastIndexOf('review.updateMany');
    expect(ops.slice(hold)).toEqual([
      'review.updateMany',
      'approval.findMany',
      'approval.create',
      // the answer
      'approval.findMany',
    ]);
    expect(db.log[hold]).toMatchObject({
      where: {
        id: review.id,
        organizationId: ORG_A,
        state: 'READY_FOR_APPROVAL',
        version: 3,
      },
      data: { version: { increment: 0 } },
    });
  });

  it('a held review that is no longer ready at that version writes nothing', async () => {
    const { db, review } = await readyPackage();
    between(db, async () => {
      reviewRow(db, review.id).version = 4;
    });
    expect((await code(decide(db, review.id, 'approve'))).code).toBe(
      'CS_APPROVAL_CONFLICT'
    );
    expect(db.tables.approval).toEqual([]);
  });

  it('M27 a decision whose sequence is already taken is a conflict, never a second current decision', async () => {
    const { db, review } = await readyPackage();
    db.tables.approval.push({
      id: uuid(9991),
      organizationId: ORG_A,
      reviewId: review.id,
      sequence: 1,
      decision: 'REFUSED',
      packageRevisionId: PKG_REV_4,
      designRevisionId: null,
      targetContentHash: review.targetContentHash,
      actorUserId: USER_A,
      note: REFUSAL,
      createdAt: new Date(),
    });
    // every history read misses it, as if nothing serialized the decisions:
    // the unique (reviewId, sequence) still refuses the second decision 1
    (db.repository as any)._transaction.model.contentStudioApproval.findMany =
      async () => [];
    expect((await code(decide(db, review.id, 'approve'))).code).toBe(
      'CS_APPROVAL_CONFLICT'
    );
    expect(decisions(db)).toEqual([[1, 'REFUSED']]);
  });
});

describe('ContentStudioReviewService: no approval carry-over (P5-04)', () => {
  it('P504-8/M22 the review of a newer revision starts with no decision, even when the older one is approved', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    const next = await reviewIn(
      db,
      'READY_FOR_APPROVAL',
      'PACKAGE_REVISION',
      PKG_REV_5
    );
    expect(await approvalOf(db, next.id)).toMatchObject({
      targetRevisionId: PKG_REV_5,
      state: 'PENDING',
      version: 0,
      history: [],
    });
    // and the older one stays approved
    expect((await approvalOf(db, review.id)).state).toBe('APPROVED');
  });

  it('P504-8 a revision with exactly the same content and hash still has its own approval', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'approve');
    const twin = uuid(44);
    db.tables.packageRevision.push(
      packageRevision(twin, ORG_A, 10, `v4 ${SECRET}`)
    );
    const next = await reviewIn(
      db,
      'READY_FOR_APPROVAL',
      'PACKAGE_REVISION',
      twin
    );
    expect(next.targetContentHash).toBe(review.targetContentHash);
    expect((await approvalOf(db, next.id)).state).toBe('PENDING');
    await decide(db, next.id, 'refuse', REFUSAL);
    expect((await approvalOf(db, review.id)).state).toBe('APPROVED');
    expect(
      db.tables.approval.map((r) => [r.reviewId, r.sequence, r.decision])
    ).toEqual([
      [review.id, 1, 'APPROVED'],
      [next.id, 1, 'REFUSED'],
    ]);
  });

  it('a grounded package review whose claims repeat in the next revision does not carry its approval', async () => {
    const { db, review } = await readyClaimed();
    await decide(db, review.id, 'approve');
    const next = await act(
      db,
      (
        await request(db, 'PACKAGE_REVISION', PKG_REV_G_NEXT)
      ).id,
      'start'
    );
    expect(await code(approvalOf(db, next.id))).toEqual({
      status: 409,
      code: 'CS_APPROVAL_UNAVAILABLE',
    });
  });
});

describe('ContentStudioReviewService: approval and the review workflow (P5-04)', () => {
  it('P503R1 a grounded package review reaches approval only once every claim is verified', async () => {
    const { db, review } = await claimed();
    await assess(db, review.id, C1, 'VERIFIED');
    expect((await code(act(db, review.id, 'ready-for-approval'))).code).toBe(
      'CS_REVIEW_CLAIMS_INCOMPLETE'
    );
    expect((await code(decide(db, review.id, 'approve'))).code).toBe(
      'CS_APPROVAL_UNAVAILABLE'
    );
    await assess(db, review.id, C2, 'VERIFIED');
    await act(db, review.id, 'ready-for-approval');
    expect((await decide(db, review.id, 'approve')).state).toBe('APPROVED');
  });

  it('P502R2 an approval note is not a comment, and comments stay open on a decided review', async () => {
    const { db, review } = await readyPackage();
    await decide(db, review.id, 'refuse', REFUSAL);
    expect((await comments(db, review.id)).results).toEqual([]);
    await say(db, review.id, 'Noted.');
    expect((await approvalOf(db, review.id)).version).toBe(1);
  });

  it('P502R3 requesting changes is unchanged: it needs its own description and makes no decision', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'IN_REVIEW');
    expect((await code(askChanges(db, review.id, '  '))).code).toBe(
      'CS_REVIEW_REVISION_REQUEST_INVALID'
    );
    await askChanges(db, review.id, CHANGES);
    expect(db.tables.approval).toEqual([]);
    expect((await code(approvalOf(db, review.id))).code).toBe(
      'CS_APPROVAL_UNAVAILABLE'
    );
  });

  it('a cancelled review never gets an approval', async () => {
    const db = discussion();
    const review = await reviewIn(db, 'CANCELLED');
    expect((await code(decide(db, review.id, 'approve'))).code).toBe(
      'CS_APPROVAL_UNAVAILABLE'
    );
  });
});

describe('ContentStudioReviewService approval boundaries (P5-04)', () => {
  const source = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/\/\/.*$/gm, '');
  const root = join(__dirname, '..', '..', '..', '..', '..', '..');
  const schema = readFileSync(join(__dirname, '..', 'schema.prisma'), 'utf8');
  const modelOf = (name: string) => {
    const start = schema.indexOf(`model ${name} {`);
    return schema.slice(start, schema.indexOf('\n}', start));
  };

  it('P504-1/M23 the review state machine has no APPROVED state', () => {
    const state = source('../../../content-studio/review/review.state.ts');
    expect(state).not.toMatch(/'APPROVED'|'REFUSED'|'WITHDRAWN'/);
    expect(state).toMatch(
      /'REQUESTED',\s*'IN_REVIEW',\s*'CHANGES_REQUESTED',\s*'READY_FOR_APPROVAL',\s*'CANCELLED',\s*\]/
    );
  });

  it('P504-2/M24 the review row holds no approval state: it is derived from the decisions', () => {
    const review = modelOf('ContentStudioReview');
    expect(review).not.toMatch(
      /approval\w*\s+(String|Int|DateTime)|currentApproval|approvedAt|approvedBy/i
    );
    expect(review).toMatch(/approvals\s+ContentStudioApproval\[\]/);
  });

  it('P504-3 a decision row has exactly its decision fields and no updatedAt', () => {
    const fields = modelOf('ContentStudioApproval')
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((field) => /^[a-z]/.test(field));
    expect(fields).toEqual([
      'id',
      'organizationId',
      'reviewId',
      'sequence',
      'decision',
      'packageRevisionId',
      'designRevisionId',
      'targetContentHash',
      'actorUserId',
      'note',
      'createdAt',
      'organization',
      'review',
      'actorUser',
      'packageRevision',
      'designRevision',
    ]);
    const model = modelOf('ContentStudioApproval');
    expect(model).not.toMatch(
      /updatedAt|@updatedAt|deletedAt|editedAt|comment|revisionRequest|Json/i
    );
    expect(model).toMatch(/@@unique\(\[reviewId, sequence\]\)/);
    expect(model).toMatch(
      /review\s+ContentStudioReview\s+@relation\(fields: \[reviewId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(model).toMatch(
      /packageRevision\s+ContentPackageRevision\?\s+@relation\(fields: \[packageRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(model).toMatch(
      /designRevision\s+ContentStudioDesignRevision\?\s+@relation\(fields: \[designRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
  });

  it('P504-3/M11 decisions are only ever created: no update, upsert or delete', () => {
    const text = source('content-studio.review.repository.ts');
    expect(text).not.toMatch(
      /contentStudioApproval\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(
      text.split(/contentStudioApproval\.(?:findMany|create)\(/).length - 1
    ).toBe(3);
  });

  it('P504-6/P504-7/M25 handoff and publishing know nothing of approval', () => {
    for (const file of [
      'content-studio.handoff.service.ts',
      'content-studio.handoff.repository.ts',
    ]) {
      expect(source(file)).not.toMatch(/approv|review/i);
    }
    const posts = readFileSync(
      join(
        root,
        'libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts'
      ),
      'utf8'
    );
    expect(posts).not.toMatch(
      /ContentStudioApproval|contentStudioApproval|content-studio/
    );
  });

  it('P504-10/P504-11 no notification, email, MCP or agent integration', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
      '../../../content-studio/review/review.approval.ts',
    ]) {
      expect(source(file)).not.toMatch(/notif|email|mcp|agent|webhook|credit/i);
    }
  });

  it('P504-9 the approval domain is pure: no Node, database or browser dependency, and no approver policy', () => {
    const text = readFileSync(
      join(__dirname, '../../../content-studio/review/review.approval.ts'),
      'utf8'
    );
    expect(text.match(/from '[^']+'/g)).toEqual([
      "from '@gitroom/nestjs-libraries/content-studio/review/review.state'",
    ]);
    expect(text.replace(/\/\/.*$/gm, '')).not.toMatch(
      /approver|quorum|group|assign|role|self/i
    );
  });

  it('M26 a decision never requests changes, posts a comment or moves the review', () => {
    const text = source('content-studio.review.service.ts');
    const approval = text.slice(
      text.indexOf('async getApproval('),
      text.indexOf('private claimReview(')
    );
    expect(approval).not.toMatch(
      /requestChanges|revisionRequest|createComment|transitionReview|changeState|setClaimAssessment|createReview/
    );
  });

  it('P504-12/P504-13 package grounding and the Design Document are unchanged', () => {
    const draft = readFileSync(
      join(
        root,
        'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts'
      ),
      'utf8'
    );
    expect(draft).toMatch(
      /export const CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION = 2;/
    );
    expect(draft).not.toMatch(/approv/i);
    const design = readFileSync(
      join(
        root,
        'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      ),
      'utf8'
    );
    expect(design).toMatch(/export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;/);
    expect(design).not.toMatch(/approv/i);
  });
});
