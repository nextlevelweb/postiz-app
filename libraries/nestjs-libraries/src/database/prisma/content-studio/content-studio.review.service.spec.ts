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
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  emptyContentPackageDraft,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
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
  const person = (id: string) => {
    const user = tables.user.find((entry) => entry.id === id)!;
    return { id: user.id, name: user.name };
  };
  const revisionRef = (table: Row[], id: string | null, org: string) => {
    // the composite relation: the revision with that id IN the organization
    const row = table.find(
      (entry) => entry.id === id && entry.organizationId === org
    );
    return row
      ? {
          id: row.id,
          revisionNumber: row.revisionNumber,
          contentHash: row.contentHash,
        }
      : null;
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
        for (const row of rows) {
          for (const [key, value] of Object.entries(args.data)) {
            row[key] =
              value && typeof value === 'object' && 'increment' in value
                ? row[key] + (value as Row).increment
                : value;
          }
          row.updatedAt = now();
        }
        return { count: rows.length };
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
    { model: prisma } as unknown as PrismaTransaction
  );
  const service = new ContentStudioReviewService(repository);
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
const act = (
  db: ReturnType<typeof createDb>,
  id: string,
  action: 'start' | 'request-changes' | 'ready-for-approval' | 'cancel',
  org = ORG_A,
  user = USER_A
) =>
  db.service.transitionReview({
    organizationId: org,
    userId: user,
    id,
    action,
  });
const snapshot = (db: ReturnType<typeof createDb>) =>
  JSON.stringify({ review: db.tables.review, event: db.tables.event });

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

  it('RT4 request changes moves IN_REVIEW to CHANGES_REQUESTED (no reason exists yet: P5-02)', async () => {
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

  it('P501-9/M5/M7 binds revisions only: no package, design, "latest" or project lookup', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      const source = code(file);
      expect(source).not.toMatch(
        /latest|orderBy:\s*\{\s*revisionNumber|contentPackage\.|contentStudioDesignProject|packageId|designProjectId/i
      );
    }
    expect(code('content-studio.review.repository.ts')).toMatch(
      /packageRevisionId: input\.packageRevisionId/
    );
  });

  it('P501-4/P501-5/M28 no approval, comment, reason, reviewer, due date or notification', () => {
    for (const file of [
      'content-studio.review.service.ts',
      'content-studio.review.repository.ts',
    ]) {
      expect(code(file)).not.toMatch(
        /approved|approvedBy|signature|comment|reason|assign|reviewer|dueAt|deadline|notif|email|slack/i
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
    expect(queries.length).toBe(9);
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
        /\.delete(Many)?\(|stateEvent\.update|contentStudioReviewStateEvent\.update|upsert/
      );
    }
  });
});
