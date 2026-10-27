import { Prisma } from '@prisma/client';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { ContentStudioSourceRetentionExecutionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.repository';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  ContentStudioSourceRetentionExecutionService,
  contentStudioSourceVersionRetentionExecutionExitCode,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.service';
import {
  contentStudioSourceVersionRetentionDryRunHash,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionRetentionExecutionError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// The retention execution's steps (P8-R1C), with its repository and the
// retention service mocked: what each command checks before it writes, the
// order of its writes, how each failure ends, and the exit code of each
// outcome. The same on a real database, with real races, is in
// content-studio.phase8-retention-execution.postgres.integration.spec.ts

const ORG = '11111111-1111-4111-8111-111111111111';
const EXECUTION = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const V = (n: number) =>
  `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const OLDER = new Date(NOW - 7 * 24 * HOUR);

const candidate = (n: number) => ({
  id: V(n),
  sourceId: SOURCE,
  versionNumber: n,
  contentHash: sha256Hex(`v${n}`),
  candidateReason: 'REPEAT_RUN_INTERIOR',
});
// a reviewed plan of these candidates, hashed as a dry run hashes it
const planOf = (numbers: number[]) => {
  const candidates = numbers.map(candidate);
  const plan = {
    format: 'content-studio.source-version-retention-dry-run',
    dryRunFormatVersion: 1,
    protectionVersion: 1,
    policyVersion: 1,
    organizationId: ORG,
    evaluationNow: new Date(NOW).toISOString(),
    validUntil: new Date(NOW + HOUR).toISOString(),
    policy: { mode: 'compact_repeats', olderThan: OLDER.toISOString() },
    candidateSummary: { logicalContentBytes: 10 },
    blockedSources: [],
    candidates,
  };
  return {
    text: canonicalJson({
      ...plan,
      dryRunHash: contentStudioSourceVersionRetentionDryRunHash({
        organizationId: ORG,
        evaluationNow: new Date(NOW),
        validUntil: new Date(NOW + HOUR),
        policy: { mode: 'compact_repeats', olderThan: OLDER },
        candidates,
        blockedSources: [],
      }),
    }),
    hash: contentStudioSourceVersionRetentionDryRunHash({
      organizationId: ORG,
      evaluationNow: new Date(NOW),
      validUntil: new Date(NOW + HOUR),
      policy: { mode: 'compact_repeats', olderThan: OLDER },
      candidates,
      blockedSources: [],
    }),
  };
};

const clockAt = (start: number, step = 0) => {
  let time = start - step;
  return () => new Date((time += step));
};

const executionRow = (over: Record<string, unknown> = {}) => ({
  id: EXECUTION,
  organizationId: ORG,
  planHash: 'h'.repeat(64),
  policyMode: 'compact_repeats',
  policyOlderThan: OLDER,
  planEvaluationNow: new Date(NOW),
  planValidUntil: new Date(NOW + HOUR),
  status: 'prepared',
  plannedCount: 2,
  sourceCount: 1,
  deletedCount: 0,
  batchCount: 0,
  errorCode: null,
  integrityCheck: null,
  backupConfirmedAt: null,
  quarantinedAt: new Date(NOW + 1_000),
  readyAt: new Date(NOW + 61_000),
  executionStartedAt: null,
  finishedAt: null,
  lock: { executionId: EXECUTION },
  ...over,
});
const items = (numbers: number[]) =>
  numbers.map((n) => ({
    sourceVersionId: V(n),
    sourceId: SOURCE,
    versionNumber: n,
    contentHash: sha256Hex(`v${n}`),
  }));

// the source after its candidates are removed: v1 and v9, one run of the
// same capture, v9 its latest, no page change
const keptVersion = (n: number) => ({
  id: V(n),
  organizationId: ORG,
  sourceId: SOURCE,
  versionNumber: n,
  contentHash: sha256Hex('same'),
  title: 'T',
  extractionVersion: 'content-studio-source-v2',
  fetchedAt: new Date(NOW - 30 * 24 * HOUR + n),
  createdAt: new Date(NOW - 30 * 24 * HOUR + n),
});
const KEPT = {
  source: {
    id: SOURCE,
    organizationId: ORG,
    kind: 'url',
    latestVersionNumber: 9,
    lastPageChangeAt: null,
    lastPageChangeVersionNumber: null,
    lastPageChangeKind: null,
    lastPageChangePreviousCaptureAt: null,
  },
  versions: [keptVersion(1), keptVersion(9)],
  held: 0,
};
const KEPT_RUNS = new Map([
  [SOURCE, { versionIds: [V(1), V(9)].sort(), runs: [[V(1), V(9)]] }],
]);

const setup = () => {
  let row = executionRow();
  const repository = {
    createExecution: jest.fn(async () => ({ id: EXECUTION })),
    getExecution: jest.fn(async () => row),
    getActiveExecution: jest.fn(async () => ({ executionId: EXECUTION })),
    listItems: jest.fn(async (input: { status: string }) =>
      input.status === 'planned' ? items([2, 3]) : []
    ),
    countOtherPlanPending: jest.fn(async () => 0),
    markPrepared: jest.fn(async () => ({ count: 1 })),
    startExecuting: jest.fn(async () => {
      row = { ...row, status: 'executing' };
      return { count: 1 };
    }),
    finishExecution: jest.fn(
      async (input: {
        status: string;
        errorCode: string | null;
        integrityCheck: string | null;
      }) => {
        row = {
          ...row,
          status: input.status,
          errorCode: input.errorCode,
          integrityCheck: input.integrityCheck,
        } as typeof row;
        return true;
      }
    ),
    deleteQuarantinedSourceVersionsForRetention: jest.fn(async () => {
      row = { ...row, deletedCount: row.deletedCount + 2 };
      return { deleted: 2 };
    }),
    countState: jest.fn(async () => ({ deleted: 2, versions: 0, held: 0 })),
    readSource: jest.fn(async () => KEPT as unknown),
  };
  const retention = {
    evaluateRetentionPlan: jest.fn(),
    recheckRetentionPlan: jest.fn(async () => KEPT_RUNS as unknown),
    quarantineSourceVersions: jest.fn(async () => ({
      created: 1,
      alreadyPending: 0,
    })),
    listSourceVersionQuarantine: jest.fn(async () => [] as unknown[]),
    releaseSourceVersionQuarantine: jest.fn(async () => ({ released: 0 })),
    computeProtectionMap: jest.fn(async () => new Map()),
  };
  const service = new ContentStudioSourceRetentionExecutionService(
    repository as unknown as ContentStudioSourceRetentionExecutionRepository,
    retention as unknown as ContentStudioSourceRetentionService
  );
  return {
    service,
    repository,
    retention,
    setRow: (over: Record<string, unknown>) => {
      row = executionRow(over);
    },
  };
};

const refused = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioSourceVersionRetentionExecutionError);
  return (err as ContentStudioSourceVersionRetentionExecutionError).code;
};
const writes = (s: ReturnType<typeof setup>) =>
  [
    ...Object.entries(s.repository)
      .filter(([name]) => !/^(get|list|count|read)/.test(name))
      .filter(([, fn]) => fn.mock.calls.length),
    ...Object.entries(s.retention)
      .filter(([name]) => /^(quarantine|release)/.test(name))
      .filter(([, fn]) => fn.mock.calls.length),
  ].map(([name]) => name);

describe('ContentStudioSourceRetentionExecutionService: exit codes (P8-R1C)', () => {
  it('SX1 0 done, 1 nothing removed and nothing held, 2 an operator must look', () => {
    expect(
      Object.fromEntries(
        (
          [
            'nothing_to_delete',
            'prepared',
            'completed',
            'cancelled',
            'not_ready',
            'aborted',
            'partial',
            'cleanup_required',
            'interrupted',
          ] as const
        ).map((outcome) => [
          outcome,
          contentStudioSourceVersionRetentionExecutionExitCode(outcome),
        ])
      )
    ).toEqual({
      nothing_to_delete: 0,
      prepared: 0,
      completed: 0,
      cancelled: 0,
      not_ready: 1,
      aborted: 1,
      partial: 2,
      cleanup_required: 2,
      interrupted: 2,
    });
  });
});

describe('ContentStudioSourceRetentionExecutionService: prepare (P8-R1C)', () => {
  it('SX2 the steps in order: recorded, made again, held a batch of 500 at a time at its own time, ready a minute after the last hold', async () => {
    const s = setup();
    const numbers = Array.from({ length: 501 }, (_, i) => i + 2);
    const plan = planOf(numbers);
    s.setRow({ status: 'preparing', readyAt: null, planHash: plan.hash });
    s.retention.evaluateRetentionPlan.mockResolvedValue({
      dryRunHash: plan.hash,
    });
    s.retention.listSourceVersionQuarantine.mockResolvedValue(
      numbers.map((n, i) => ({
        sourceVersionId: V(n),
        planHash: plan.hash,
        pendingAt: new Date(NOW + 1_000 + (i < 500 ? 0 : 7_000)),
      }))
    );
    const report = await s.service.prepare({
      organizationId: ORG,
      plan: plan.text,
      clock: clockAt(NOW + 1_000, 10),
    });
    expect(report.outcome).toBe('prepared');
    expect(s.repository.createExecution.mock.calls[0]).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        planHash: plan.hash,
        policyMode: 'compact_repeats',
        policyOlderThan: OLDER,
        planEvaluationNow: new Date(NOW),
        planValidUntil: new Date(NOW + HOUR),
        executionFormatVersion: 1,
        sourceCount: 1,
        items: expect.arrayContaining([
          {
            sourceVersionId: V(2),
            sourceId: SOURCE,
            versionNumber: 2,
            contentHash: sha256Hex('v2'),
          },
        ]),
      }),
    ]);
    expect(s.retention.evaluateRetentionPlan).toHaveBeenCalledWith({
      organizationId: ORG,
      now: new Date(NOW),
      policy: { mode: 'compact_repeats', olderThan: OLDER },
    });
    const holds = s.retention.quarantineSourceVersions.mock.calls.map(
      (call) =>
        (
          call as unknown as [
            { sourceVersionIds: string[]; now: Date; planHash: string }
          ]
        )[0]
    );
    expect(holds.map((h) => h.sourceVersionIds.length)).toEqual([500, 1]);
    expect(holds.every((h) => h.planHash === plan.hash)).toBe(true);
    expect(holds[0].now.getTime()).toBeLessThan(holds[1].now.getTime());
    expect(s.repository.markPrepared.mock.calls[0]).toEqual([
      expect.objectContaining({
        id: EXECUTION,
        organizationId: ORG,
        readyAt: new Date(NOW + 8_000 + 60_000),
      }),
    ]);
    const order = [
      s.repository.createExecution,
      s.retention.evaluateRetentionPlan,
      s.retention.quarantineSourceVersions,
      s.retention.listSourceVersionQuarantine,
      s.repository.markPrepared,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('SX3 refused before anything is written: the plan invalid, made for a later time, too close to its end; nothing for no candidate', async () => {
    const plan = planOf([2, 3]);
    for (const [text, at, code] of [
      ['{', NOW + 1_000, 'RETENTION_EXECUTION_PLAN_INVALID'],
      [plan.text, NOW - 1, 'RETENTION_EXECUTION_PLAN_INVALID'],
      [plan.text, NOW + HOUR - 60_000, 'RETENTION_EXECUTION_PLAN_EXPIRED'],
      [plan.text, NOW + HOUR, 'RETENTION_EXECUTION_PLAN_EXPIRED'],
    ] as const) {
      const s = setup();
      expect(
        await refused(
          s.service.prepare({
            organizationId: ORG,
            plan: text,
            clock: clockAt(at),
          })
        )
      ).toBe(code);
      expect(writes(s)).toEqual([]);
    }
    const s = setup();
    const empty = await s.service.prepare({
      organizationId: ORG,
      plan: planOf([]).text,
      clock: clockAt(NOW + 1_000),
    });
    expect(empty).toEqual(
      expect.objectContaining({
        outcome: 'nothing_to_delete',
        executionId: null,
        plannedCount: 0,
      })
    );
    expect(writes(s)).toEqual([]);
  });

  it('SX4 another active execution is named; a plan prepared before is refused', async () => {
    for (const code of [
      'RETENTION_EXECUTION_ALREADY_ACTIVE',
      'RETENTION_EXECUTION_ALREADY_RUN',
    ] as const) {
      const s = setup();
      s.repository.createExecution.mockRejectedValue(
        new ContentStudioSourceVersionRetentionExecutionError(code)
      );
      const err = await s.service
        .prepare({
          organizationId: ORG,
          plan: planOf([2]).text,
          clock: clockAt(NOW + 1_000),
        })
        .then(
          () => null,
          (e: ContentStudioSourceVersionRetentionExecutionError) => e
        );
      expect([err?.code, err?.detail]).toEqual([
        code,
        code === 'RETENTION_EXECUTION_ALREADY_ACTIVE'
          ? `execution ${EXECUTION}`
          : null,
      ]);
      expect(s.retention.quarantineSourceVersions).not.toHaveBeenCalled();
    }
  });

  it('SX5 made again with another hash, or not at all: aborted with nothing held', async () => {
    for (const replay of [
      async () => ({ dryRunHash: 'f'.repeat(64) }),
      async () => {
        throw new ContentStudioSourceRetentionIntegrityError({
          type: 'ContentPackage',
          id: 'p',
        });
      },
    ]) {
      const s = setup();
      s.setRow({ status: 'preparing' });
      s.retention.evaluateRetentionPlan.mockImplementation(replay);
      const report = await s.service.prepare({
        organizationId: ORG,
        plan: planOf([2]).text,
        clock: clockAt(NOW + 1_000),
      });
      expect(report.outcome).toBe('aborted');
      expect(s.retention.quarantineSourceVersions).not.toHaveBeenCalled();
      expect(s.repository.finishExecution.mock.calls[0]).toEqual([
        expect.objectContaining({
          status: 'aborted',
          from: ['preparing'],
          errorCode: 'RETENTION_EXECUTION_HASH_MISMATCH',
          deletedCount: 0,
        }),
      ]);
    }
  });

  it("SX6 a hold that fails, or held rows that are not exactly the plan's: everything released, aborted; a release that fails keeps the lock", async () => {
    const plan = planOf([2, 3]);
    const prepared = (s: ReturnType<typeof setup>) =>
      s.service.prepare({
        organizationId: ORG,
        plan: plan.text,
        clock: clockAt(NOW + 1_000),
      });
    const failing = setup();
    failing.setRow({ status: 'preparing', planHash: plan.hash });
    failing.retention.evaluateRetentionPlan.mockResolvedValue({
      dryRunHash: plan.hash,
    });
    failing.retention.quarantineSourceVersions.mockRejectedValue(
      new Error('x')
    );
    expect((await prepared(failing)).outcome).toBe('aborted');
    expect(
      failing.retention.releaseSourceVersionQuarantine
    ).toHaveBeenCalledWith({
      organizationId: ORG,
      planHash: plan.hash,
    });
    expect(failing.repository.finishExecution.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        errorCode: 'RETENTION_EXECUTION_QUARANTINE_FAILED',
      })
    );

    for (const [held, other] of [
      [[V(2)], 0],
      [[V(2), V(9)], 0],
      [[V(2), V(3)], 1],
    ] as const) {
      const s = setup();
      s.setRow({ status: 'preparing', planHash: plan.hash });
      s.retention.evaluateRetentionPlan.mockResolvedValue({
        dryRunHash: plan.hash,
      });
      s.retention.listSourceVersionQuarantine.mockResolvedValueOnce(
        held.map((id) => ({
          sourceVersionId: id,
          planHash: plan.hash,
          pendingAt: new Date(NOW),
        }))
      );
      s.repository.countOtherPlanPending.mockResolvedValue(other);
      expect((await prepared(s)).outcome).toBe('aborted');
      expect(s.repository.markPrepared).not.toHaveBeenCalled();
      expect(s.repository.finishExecution.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          errorCode: 'RETENTION_EXECUTION_QUARANTINE_FAILED',
        })
      );
    }

    const stuck = setup();
    stuck.setRow({ status: 'preparing', planHash: plan.hash });
    stuck.retention.evaluateRetentionPlan.mockResolvedValue({
      dryRunHash: plan.hash,
    });
    stuck.retention.quarantineSourceVersions.mockRejectedValue(new Error('x'));
    stuck.retention.releaseSourceVersionQuarantine.mockRejectedValue(
      new Error('y')
    );
    const report = await prepared(stuck);
    expect([report.outcome, report.errorCode, report.detail]).toEqual([
      'cleanup_required',
      'RETENTION_EXECUTION_CLEANUP_REQUIRED',
      'RETENTION_EXECUTION_QUARANTINE_FAILED',
    ]);
    expect(stuck.repository.finishExecution).not.toHaveBeenCalled();
    // released, but not to none: still the lock
    const left = setup();
    left.setRow({ status: 'preparing', planHash: plan.hash });
    left.retention.evaluateRetentionPlan.mockResolvedValue({
      dryRunHash: plan.hash,
    });
    left.retention.quarantineSourceVersions.mockRejectedValue(new Error('x'));
    left.retention.listSourceVersionQuarantine.mockResolvedValue([
      { sourceVersionId: V(2) },
    ]);
    expect((await prepared(left)).outcome).toBe('cleanup_required');
    expect(left.repository.finishExecution).not.toHaveBeenCalled();
  });

  it('SX7 ready at or after the end of the plan: released and aborted; cancelled meanwhile: released, interrupted', async () => {
    const plan = planOf([2]);
    const late = setup();
    late.setRow({ status: 'preparing', planHash: plan.hash });
    late.retention.evaluateRetentionPlan.mockResolvedValue({
      dryRunHash: plan.hash,
    });
    late.retention.listSourceVersionQuarantine.mockResolvedValueOnce([
      {
        sourceVersionId: V(2),
        planHash: plan.hash,
        pendingAt: new Date(NOW + HOUR - 60_000),
      },
    ]);
    const report = await late.service.prepare({
      organizationId: ORG,
      plan: plan.text,
      clock: clockAt(NOW + 1_000),
    });
    expect(report.outcome).toBe('aborted');
    expect(late.repository.finishExecution.mock.calls[0][0]).toEqual(
      expect.objectContaining({ errorCode: 'RETENTION_EXECUTION_PLAN_EXPIRED' })
    );
    const moved = setup();
    moved.setRow({ status: 'cancelled', planHash: plan.hash });
    moved.retention.evaluateRetentionPlan.mockResolvedValue({
      dryRunHash: plan.hash,
    });
    moved.retention.listSourceVersionQuarantine.mockResolvedValueOnce([
      {
        sourceVersionId: V(2),
        planHash: plan.hash,
        pendingAt: new Date(NOW + 1_000),
      },
    ]);
    moved.repository.markPrepared.mockResolvedValue({ count: 0 });
    expect(
      (
        await moved.service.prepare({
          organizationId: ORG,
          plan: plan.text,
          clock: clockAt(NOW + 1_000),
        })
      ).outcome
    ).toBe('interrupted');
    expect(moved.retention.releaseSourceVersionQuarantine).toHaveBeenCalled();
  });
});

describe('ContentStudioSourceRetentionExecutionService: execute (P8-R1C)', () => {
  const run = (s: ReturnType<typeof setup>, at = NOW + 61_000) =>
    s.service.execute({
      executionId: EXECUTION,
      clock: clockAt(at),
      hostname: 'host',
    });

  it('SX8 only a prepared execution with its lock, once ready and before its end; started by compare-and-swap', async () => {
    for (const [over, code] of [
      [{ status: 'completed' }, 'RETENTION_EXECUTION_ALREADY_RUN'],
      [{ status: 'partial' }, 'RETENTION_EXECUTION_ALREADY_RUN'],
      [{ status: 'preparing' }, 'RETENTION_EXECUTION_ALREADY_ACTIVE'],
      [{ status: 'executing' }, 'RETENTION_EXECUTION_ALREADY_ACTIVE'],
      [{ lock: null }, 'RETENTION_EXECUTION_STATE_INVALID'],
      [{ lock: { executionId: 'other' } }, 'RETENTION_EXECUTION_STATE_INVALID'],
      [{ readyAt: null }, 'RETENTION_EXECUTION_STATE_INVALID'],
    ] as const) {
      const s = setup();
      s.setRow(over);
      expect([over, await refused(run(s))]).toEqual([over, code]);
      expect(writes(s)).toEqual([]);
    }
    const missing = setup();
    missing.repository.getExecution.mockResolvedValue(null as never);
    expect(await refused(run(missing))).toBe(
      'RETENTION_EXECUTION_STATE_INVALID'
    );
    const early = setup();
    const report = await run(early, NOW + 61_000 - 1);
    expect([report.outcome, report.errorCode]).toEqual([
      'not_ready',
      'RETENTION_EXECUTION_NOT_READY',
    ]);
    expect(writes(early)).toEqual([]);
    const lost = setup();
    lost.repository.startExecuting.mockResolvedValue({ count: 0 });
    expect(await refused(run(lost))).toBe('RETENTION_EXECUTION_ALREADY_ACTIVE');
    expect(lost.retention.recheckRetentionPlan).not.toHaveBeenCalled();
  });

  it('SX9 at or after the end of the plan: released and aborted, nothing removed', async () => {
    for (const at of [NOW + HOUR, NOW + HOUR + 1]) {
      const s = setup();
      const report = await run(s, at);
      expect(report.outcome).toBe('aborted');
      expect(s.repository.startExecuting).not.toHaveBeenCalled();
      expect(
        s.repository.deleteQuarantinedSourceVersionsForRetention
      ).not.toHaveBeenCalled();
      expect(s.repository.finishExecution.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          status: 'aborted',
          from: ['prepared'],
          errorCode: 'RETENTION_EXECUTION_PLAN_EXPIRED',
        })
      );
    }
  });

  it("SX10 the recheck at the plan's time and now, of exactly the items, before the first removal; a failed one aborts the whole plan", async () => {
    const s = setup();
    expect((await run(s)).outcome).toBe('completed');
    expect(s.repository.startExecuting.mock.calls[0]).toEqual([
      {
        id: EXECUTION,
        organizationId: ORG,
        now: new Date(NOW + 61_000),
        hostname: 'host',
      },
    ]);
    expect(s.retention.recheckRetentionPlan.mock.calls[0]).toEqual([
      {
        organizationId: ORG,
        planHash: 'h'.repeat(64),
        planEvaluationNow: new Date(NOW),
        now: new Date(NOW + 61_000),
        policy: { mode: 'compact_repeats', olderThan: OLDER },
        candidates: [2, 3].map((n) => ({
          id: V(n),
          sourceId: SOURCE,
          versionNumber: n,
          contentHash: sha256Hex(`v${n}`),
        })),
      },
    ]);
    expect(
      s.retention.recheckRetentionPlan.mock.invocationCallOrder[0]
    ).toBeLessThan(
      s.repository.deleteQuarantinedSourceVersionsForRetention.mock
        .invocationCallOrder[0]
    );
    const failing = setup();
    failing.retention.recheckRetentionPlan.mockRejectedValue(
      new ContentStudioSourceVersionRetentionExecutionError(
        'RETENTION_EXECUTION_RECHECK_FAILED',
        'CANDIDATE_NOT_ELIGIBLE'
      )
    );
    const report = await run(failing);
    expect([report.outcome, report.detail]).toEqual([
      'aborted',
      'CANDIDATE_NOT_ELIGIBLE',
    ]);
    expect(
      failing.repository.deleteQuarantinedSourceVersionsForRetention
    ).not.toHaveBeenCalled();
    expect(failing.retention.releaseSourceVersionQuarantine).toHaveBeenCalled();
    expect(failing.repository.finishExecution.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: 'aborted',
        from: ['executing'],
        errorCode: 'RETENTION_EXECUTION_RECHECK_FAILED',
      })
    );
    // items that are not the plan's count: the same
    const changed = setup();
    changed.repository.listItems.mockResolvedValue(items([2]));
    expect((await run(changed)).outcome).toBe('aborted');
    expect(changed.retention.recheckRetentionPlan).not.toHaveBeenCalled();
  });

  it('SX11 completed only with every item deleted, nothing held or left, and the whole organization intact; otherwise partial, failed', async () => {
    const s = setup();
    const report = await run(s);
    expect(report.outcome).toBe('completed');
    expect(s.repository.finishExecution.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        from: ['executing'],
        integrityCheck: 'passed',
        errorCode: null,
        deletedCount: 2,
      })
    );
    expect(s.retention.computeProtectionMap).toHaveBeenCalledWith({
      organizationId: ORG,
      now: new Date(NOW + 61_000),
    });
    for (const broken of [
      (x: ReturnType<typeof setup>) =>
        x.repository.countState.mockResolvedValue({
          deleted: 2,
          versions: 1,
          held: 0,
        }),
      (x: ReturnType<typeof setup>) =>
        x.repository.countState.mockResolvedValue({
          deleted: 2,
          versions: 0,
          held: 1,
        }),
      (x: ReturnType<typeof setup>) =>
        x.repository.countState.mockResolvedValue({
          deleted: 1,
          versions: 0,
          held: 0,
        }),
      (x: ReturnType<typeof setup>) =>
        x.retention.computeProtectionMap.mockRejectedValue(
          new ContentStudioSourceRetentionIntegrityError({
            type: 'ContentPackage',
            id: 'p',
          })
        ),
    ]) {
      const x = setup();
      broken(x);
      const result = await run(x);
      expect(result.outcome).toBe('partial');
      expect(x.repository.finishExecution.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          status: 'partial',
          errorCode: 'RETENTION_EXECUTION_INTEGRITY_FAILED',
          integrityCheck: 'failed',
        })
      );
    }
  });

  it('SX12 a batch that fails stops the execution: nothing after it, the rest released; a write conflict is tried 3 times in all', async () => {
    const s = setup();
    s.repository.listItems.mockImplementation(
      async (input: { status: string }) =>
        input.status === 'planned'
          ? [
              ...items([2, 3]),
              ...Array.from({ length: 150 }, (_, i) => ({
                sourceVersionId: V(1000 + i),
                sourceId: '55555555-5555-4555-8555-555555555555',
                versionNumber: i + 2,
                contentHash: 'a'.repeat(64),
              })),
            ]
          : []
    );
    s.setRow({ plannedCount: 152 });
    s.repository.deleteQuarantinedSourceVersionsForRetention.mockRejectedValueOnce(
      new ContentStudioSourceVersionRetentionExecutionError(
        'RETENTION_EXECUTION_BATCH_FAILED',
        'NOT_HELD'
      )
    );
    const report = await run(s);
    expect([report.outcome, report.errorCode, report.detail]).toEqual([
      'aborted',
      'RETENTION_EXECUTION_BATCH_FAILED',
      'NOT_HELD',
    ]);
    expect(
      s.repository.deleteQuarantinedSourceVersionsForRetention
    ).toHaveBeenCalledTimes(1);

    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2034',
      clientVersion: '6.5.0',
    });
    const retried = setup();
    retried.repository.deleteQuarantinedSourceVersionsForRetention
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict);
    expect((await run(retried)).outcome).toBe('completed');
    expect(
      retried.repository.deleteQuarantinedSourceVersionsForRetention
    ).toHaveBeenCalledTimes(3);
    const exhausted = setup();
    exhausted.repository.deleteQuarantinedSourceVersionsForRetention.mockRejectedValue(
      conflict
    );
    const out = await run(exhausted);
    expect([out.outcome, out.detail]).toEqual(['aborted', 'WRITE_CONFLICT']);
    expect(
      exhausted.repository.deleteQuarantinedSourceVersionsForRetention
    ).toHaveBeenCalledTimes(3);
  });

  it('SX13 an unknown outcome is read back, never tried again, and stops: committed, not committed, or neither', async () => {
    for (const [error, state, detail, code] of [
      [
        new Prisma.PrismaClientKnownRequestError('timeout', {
          code: 'P2028',
          clientVersion: '6.5.0',
        }),
        { deleted: 2, versions: 0, held: 0 },
        'UNKNOWN_OUTCOME_COMMITTED',
        'RETENTION_EXECUTION_BATCH_FAILED',
      ],
      [
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P1001',
          clientVersion: '6.5.0',
        }),
        { deleted: 0, versions: 2, held: 2 },
        'UNKNOWN_OUTCOME_NOT_COMMITTED',
        'RETENTION_EXECUTION_BATCH_FAILED',
      ],
      [
        new Prisma.PrismaClientUnknownRequestError('lost', {
          clientVersion: '6.5.0',
        }),
        { deleted: 1, versions: 1, held: 1 },
        'UNKNOWN_OUTCOME_INCONSISTENT',
        'RETENTION_EXECUTION_INTEGRITY_FAILED',
      ],
      [
        new Prisma.PrismaClientKnownRequestError('gone', {
          code: 'P1017',
          clientVersion: '6.5.0',
        }),
        { deleted: 0, versions: 2, held: 1 },
        'UNKNOWN_OUTCOME_INCONSISTENT',
        'RETENTION_EXECUTION_INTEGRITY_FAILED',
      ],
    ] as const) {
      const s = setup();
      s.repository.deleteQuarantinedSourceVersionsForRetention.mockRejectedValue(
        error
      );
      s.repository.countState.mockResolvedValueOnce(state);
      const report = await run(s);
      expect([detail, report.errorCode, report.detail]).toEqual([
        detail,
        code,
        detail,
      ]);
      expect(
        s.repository.deleteQuarantinedSourceVersionsForRetention
      ).toHaveBeenCalledTimes(1);
    }
  });

  it('SX14 a source whose check fails after its last batch stops the execution: partial, its integrity failed', async () => {
    const s = setup();
    s.retention.recheckRetentionPlan.mockResolvedValue(
      new Map([[SOURCE, { versionIds: [], runs: [] }]])
    );
    s.repository.readSource.mockResolvedValue({
      source: {
        id: SOURCE,
        organizationId: ORG,
        kind: 'url',
        latestVersionNumber: 9,
        lastPageChangeAt: null,
        lastPageChangeVersionNumber: null,
        lastPageChangeKind: null,
        lastPageChangePreviousCaptureAt: null,
      },
      versions: [],
      held: 0,
    });
    const report = await run(s);
    expect([report.outcome, report.errorCode, report.detail]).toEqual([
      'partial',
      'RETENTION_EXECUTION_INTEGRITY_FAILED',
      'LATEST_CHANGED',
    ]);
    expect(s.repository.readSource).toHaveBeenCalledWith({
      organizationId: ORG,
      sourceId: SOURCE,
      sourceVersionIds: [V(2), V(3)],
    });
  });
});

describe('ContentStudioSourceRetentionExecutionService: cancel (P8-R1C)', () => {
  const cancel = (s: ReturnType<typeof setup>) =>
    s.service.cancel({ executionId: EXECUTION, clock: clockAt(NOW + 2_000) });

  it('SX15 an execution that has not ended: released, cancelled with nothing removed, partial after the organization is checked with some', async () => {
    const s = setup();
    s.retention.listSourceVersionQuarantine.mockResolvedValueOnce([
      { sourceVersionId: V(2), pendingAt: new Date(NOW + 5) },
      { sourceVersionId: V(3), pendingAt: new Date(NOW + 1) },
    ]);
    const report = await cancel(s);
    expect(report).toEqual(
      expect.objectContaining({
        outcome: 'cancelled',
        previousStatus: 'prepared',
        releasedCount: 2,
        oldestPendingAt: new Date(NOW + 1).toISOString(),
      })
    );
    expect(s.repository.finishExecution.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        from: ['prepared'],
        deletedCount: 0,
        integrityCheck: null,
      })
    );
    expect(s.retention.computeProtectionMap).not.toHaveBeenCalled();
    expect(
      s.repository.deleteQuarantinedSourceVersionsForRetention
    ).not.toHaveBeenCalled();

    const some = setup();
    some.setRow({ status: 'executing', deletedCount: 100 });
    expect((await cancel(some)).outcome).toBe('partial');
    expect(some.repository.finishExecution.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        status: 'partial',
        from: ['executing'],
        deletedCount: 100,
        integrityCheck: 'passed',
      })
    );
    expect(some.retention.computeProtectionMap).toHaveBeenCalled();
  });

  it('SX16 an ended one is refused; a failed release keeps it and its lock', async () => {
    for (const status of ['completed', 'cancelled', 'aborted', 'partial']) {
      const s = setup();
      s.setRow({ status });
      expect(await refused(cancel(s))).toBe(
        'RETENTION_EXECUTION_STATE_INVALID'
      );
      expect(writes(s)).toEqual([]);
    }
    const stuck = setup();
    stuck.retention.releaseSourceVersionQuarantine.mockRejectedValue(
      new Error('x')
    );
    expect((await cancel(stuck)).outcome).toBe('cleanup_required');
    expect(stuck.repository.finishExecution).not.toHaveBeenCalled();
  });
});
