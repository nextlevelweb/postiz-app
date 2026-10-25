import fs from 'fs';
import path from 'path';
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  RetryState,
  TimeoutFailure,
  TimeoutType,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';

// The feed capture workflows (P8-01) as plain functions: the Temporal
// workflow API is replaced by mocks, so this checks what the workflows ask
// Temporal to do (activities, child starts, sleeps, continue-as-new), not a
// running Temporal. There is no Temporal test server in this repository
const mockActivities = {
  listContentStudioFeedsForCapture: jest.fn(),
  captureContentStudioFeed: jest.fn(),
  recordContentStudioFeedCaptureFailure: jest.fn(),
};
const mockProxyOptions: unknown[] = [];
const mockStartChild = jest.fn();
const mockSleep = jest.fn();
class MockContinueAsNew extends Error {
  constructor(readonly args: unknown[]) {
    super('continueAsNew');
  }
}
const mockContinueAsNew = jest.fn((...args: unknown[]) => {
  throw new MockContinueAsNew(args);
});
jest.mock('@temporalio/workflow', () => ({
  // the real failure classes: the workflow tells failures apart by them
  ActivityFailure: jest.requireActual('@temporalio/common').ActivityFailure,
  ApplicationFailure:
    jest.requireActual('@temporalio/common').ApplicationFailure,
  proxyActivities: (options: unknown) => {
    mockProxyOptions.push(options);
    return mockActivities;
  },
  startChild: (...args: unknown[]) => mockStartChild(...args),
  sleep: (...args: unknown[]) => mockSleep(...args),
  continueAsNew: (...args: unknown[]) => mockContinueAsNew(...args),
}));

const {
  contentStudioFeedCaptureWorkflowV1,
  contentStudioFeedScanWorkflowV1,
} = require('./content.studio.feed.capture.workflow');

const ORG = '11111111-1111-4111-8111-111111111111';
const FEED = (n: number) => `33333333-3333-4333-8333-00000000000${n}`;

const scan = async (input?: unknown) => {
  try {
    await contentStudioFeedScanWorkflowV1(input);
  } catch (err) {
    if (err instanceof MockContinueAsNew) {
      return err.args;
    }
    throw err;
  }
  throw new Error('the scan never ends: it continues as new');
};

// What a workflow sees when an activity failed for good: its last failure as
// the cause
const activityFailure = (cause: Error) =>
  new ActivityFailure(
    'Activity task failed',
    'captureContentStudioFeed',
    '1',
    RetryState.MAXIMUM_ATTEMPTS_REACHED,
    'worker',
    cause
  );

beforeEach(() => {
  mockActivities.listContentStudioFeedsForCapture.mockReset();
  mockActivities.captureContentStudioFeed.mockReset();
  mockActivities.recordContentStudioFeedCaptureFailure.mockReset();
  mockStartChild.mockReset();
  mockSleep.mockReset();
  mockContinueAsNew.mockClear();
});

describe('contentStudioFeedCaptureWorkflowV1', () => {
  it('TM2/TM5 hands the ids, and only the ids, to the capture activity', async () => {
    mockActivities.captureContentStudioFeed.mockResolvedValue({
      status: 'captured',
    });
    await expect(
      contentStudioFeedCaptureWorkflowV1({
        organizationId: ORG,
        sourceId: FEED(1),
        url: 'https://evil.example/',
      })
    ).resolves.toEqual({ status: 'captured' });
    expect(mockActivities.captureContentStudioFeed).toHaveBeenCalledWith({
      organizationId: ORG,
      sourceId: FEED(1),
    });
  });

  // P8-C2: the capture runs on its own queue, the list stays on `main`; the
  // same deadlines and attempts, and no deadline to start (a capture waits
  // in its queue for a free slot)
  it('TM6/TM7/WR1-WR4/P8C4-8 a capture is tried at most three times, a list and a failure record at most three times, each within a deadline', () => {
    expect(mockProxyOptions).toEqual([
      {
        startToCloseTimeout: '2 minute',
        taskQueue: 'main',
        retry: {
          maximumAttempts: 3,
          backoffCoefficient: 1,
          initialInterval: '1 minute',
        },
      },
      {
        startToCloseTimeout: '10 minute',
        taskQueue: 'content-studio-capture',
        retry: {
          maximumAttempts: 3,
          backoffCoefficient: 1,
          initialInterval: '2 minutes',
        },
      },
      // P8-C4: the failure record, a small write on `main`
      {
        startToCloseTimeout: '1 minute',
        taskQueue: 'main',
        retry: {
          maximumAttempts: 3,
          backoffCoefficient: 1,
          initialInterval: '1 minute',
        },
      },
    ]);
  });

  // P8-C4: a capture that failed for a reason of the feed delays its next
  // automatic one, once, and still fails; any other failure changes nothing
  const run = (organizationId = ORG) =>
    contentStudioFeedCaptureWorkflowV1({
      organizationId,
      sourceId: FEED(1),
    }).then(
      () => {
        throw new Error('expected a failure');
      },
      (err: unknown) => err
    );

  it('WF1 a capture that succeeds records no failure', async () => {
    mockActivities.captureContentStudioFeed.mockResolvedValue({
      status: 'captured',
    });
    await contentStudioFeedCaptureWorkflowV1({
      organizationId: ORG,
      sourceId: FEED(1),
    });
    expect(
      mockActivities.recordContentStudioFeedCaptureFailure
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['CS_SOURCE_FETCH_FAILED', false],
    ['CS_SOURCE_FETCH_TIMEOUT', false],
    ['CS_SOURCE_FEED_INVALID', true],
    ['CS_SOURCE_INTEGRITY_ERROR', true],
  ])(
    'WF2/P8C4-6/P8C4-7/M28/M29 %s, its attempts used up: recorded once with the ids and the code, then the workflow fails with it',
    async (type, nonRetryable) => {
      const failure = activityFailure(
        ApplicationFailure.create({
          message: 'The Content Studio feed could not be captured.',
          type,
          nonRetryable,
        })
      );
      mockActivities.captureContentStudioFeed.mockRejectedValue(failure);
      mockActivities.recordContentStudioFeedCaptureFailure.mockResolvedValue({
        status: 'recorded',
      });
      expect(await run()).toBe(failure);
      expect(
        mockActivities.recordContentStudioFeedCaptureFailure.mock.calls
      ).toEqual([[{ organizationId: ORG, sourceId: FEED(1), code: type }]]);
    }
  );

  it.each([
    [
      'WF3 an application failure without a CS_ code (the database)',
      activityFailure(
        ApplicationFailure.create({
          message: 'connection reset',
          type: 'PrismaClientKnownRequestError',
        })
      ),
    ],
    [
      'an application failure without a type',
      activityFailure(ApplicationFailure.create({ message: 'x' })),
    ],
    [
      'WF4 a timeout (a capture over its deadline, a lost worker)',
      activityFailure(
        new TimeoutFailure('timed out', undefined, TimeoutType.START_TO_CLOSE)
      ),
    ],
    ['a cancellation', activityFailure(new CancelledFailure('cancelled'))],
    ['WF5 a plain error', new Error('raw')],
    [
      'a CS_ code that is not the activity failure itself',
      ApplicationFailure.create({
        message: 'x',
        type: 'CS_SOURCE_FEED_INVALID',
      }),
    ],
  ])(
    'M27 %s records nothing; the workflow fails with it',
    async (_, failure) => {
      mockActivities.captureContentStudioFeed.mockRejectedValue(failure);
      expect(await run()).toBe(failure);
      expect(
        mockActivities.recordContentStudioFeedCaptureFailure
      ).not.toHaveBeenCalled();
    }
  );

  it('WF6 a record that failed every attempt fails the workflow with that failure, never quietly', async () => {
    mockActivities.captureContentStudioFeed.mockRejectedValue(
      activityFailure(
        ApplicationFailure.create({ type: 'CS_SOURCE_FETCH_FAILED' })
      )
    );
    const recordFailure = activityFailure(new Error('database down'));
    mockActivities.recordContentStudioFeedCaptureFailure.mockRejectedValue(
      recordFailure
    );
    expect(await run()).toBe(recordFailure);
    expect(
      mockActivities.recordContentStudioFeedCaptureFailure
    ).toHaveBeenCalledTimes(1);
  });
});

describe('contentStudioFeedScanWorkflowV1', () => {
  it('starts one capture per due feed, with the feed as its workflow id, abandoned by the scan', async () => {
    mockActivities.listContentStudioFeedsForCapture.mockResolvedValue({
      feeds: [
        { organizationId: ORG, sourceId: FEED(1) },
        { organizationId: ORG, sourceId: FEED(2) },
      ],
      next: null,
    });
    const next = await scan();
    expect(
      mockActivities.listContentStudioFeedsForCapture
    ).toHaveBeenCalledWith({ afterId: null });
    expect(mockStartChild.mock.calls).toEqual(
      [1, 2].map((n) => [
        contentStudioFeedCaptureWorkflowV1,
        {
          workflowId: `content-studio-feed-capture-${FEED(n)}`,
          taskQueue: 'main',
          parentClosePolicy: 'ABANDON',
          args: [{ organizationId: ORG, sourceId: FEED(n) }],
        },
      ])
    );
    // WS1/P8C4-4/M39 the last page: the scan cadence (P8-C4), then a fresh
    // scan from the start
    expect(mockSleep.mock.calls).toEqual([['10 minutes']]);
    expect(next).toEqual([{}]);
  });

  it('WS2 a full page continues at once from where it ended, without sleeping', async () => {
    mockActivities.listContentStudioFeedsForCapture.mockResolvedValue({
      feeds: [{ organizationId: ORG, sourceId: FEED(1) }],
      next: FEED(1),
    });
    expect(await scan({ afterId: FEED(0) })).toEqual([{ afterId: FEED(1) }]);
    expect(
      mockActivities.listContentStudioFeedsForCapture
    ).toHaveBeenCalledWith({ afterId: FEED(0) });
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('51/52/WS7 a feed whose capture still runs keeps it: no second capture, the others start', async () => {
    mockActivities.listContentStudioFeedsForCapture.mockResolvedValue({
      feeds: [
        { organizationId: ORG, sourceId: FEED(1) },
        { organizationId: ORG, sourceId: FEED(2) },
      ],
      next: null,
    });
    mockStartChild.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError(
        'running',
        `content-studio-feed-capture-${FEED(1)}`,
        'contentStudioFeedCaptureWorkflowV1'
      )
    );
    await scan();
    expect(mockStartChild).toHaveBeenCalledTimes(2);
  });

  it('any other failure to start fails the scan run (Temporal retries the workflow task)', async () => {
    mockActivities.listContentStudioFeedsForCapture.mockResolvedValue({
      feeds: [{ organizationId: ORG, sourceId: FEED(1) }],
      next: null,
    });
    mockStartChild.mockRejectedValueOnce(new Error('other'));
    await expect(scan()).rejects.toThrow('other');
  });

  it('no feeds: sleeps and scans again', async () => {
    mockActivities.listContentStudioFeedsForCapture.mockResolvedValue({
      feeds: [],
      next: null,
    });
    expect(await scan()).toEqual([{}]);
    expect(mockSleep.mock.calls).toEqual([['10 minutes']]);
    expect(mockStartChild).not.toHaveBeenCalled();
  });

  // P8-C4 (P8-DEFERRED-29): a list that failed every attempt never ends the
  // scan: the same page again after the cadence
  it.each([
    [{ afterId: FEED(4) }, { afterId: FEED(4) }],
    [{}, { afterId: null }],
    [undefined, { afterId: null }],
  ])(
    'WS3/WS4/P8C4-5/M40/M41 a list that failed for good: sleeps the cadence, then the same page (%j)',
    async (input, again) => {
      mockActivities.listContentStudioFeedsForCapture.mockRejectedValue(
        activityFailure(new Error('database down'))
      );
      expect(await scan(input)).toEqual([again]);
      expect(mockSleep.mock.calls).toEqual([['10 minutes']]);
      expect(mockStartChild).not.toHaveBeenCalled();
    }
  );

  it('WS5/M42 any other failure of the list still fails the scan run', async () => {
    mockActivities.listContentStudioFeedsForCapture.mockRejectedValue(
      new TypeError('a bug')
    );
    await expect(scan()).rejects.toThrow('a bug');
    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockContinueAsNew).not.toHaveBeenCalled();
  });

  it('WS6 after a list failure the next run starts the due feeds with their own workflow ids', async () => {
    mockActivities.listContentStudioFeedsForCapture
      .mockRejectedValueOnce(activityFailure(new Error('database down')))
      .mockResolvedValueOnce({
        feeds: [{ organizationId: ORG, sourceId: FEED(5) }],
        next: null,
      });
    const again = await scan({ afterId: FEED(4) });
    await scan(again[0]);
    expect(mockActivities.listContentStudioFeedsForCapture.mock.calls).toEqual([
      [{ afterId: FEED(4) }],
      [{ afterId: FEED(4) }],
    ]);
    expect(mockStartChild.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({
        workflowId: `content-studio-feed-capture-${FEED(5)}`,
      }),
    ]);
  });
});

describe('TM1 registration', () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(__dirname, '../../../..', file), 'utf8');

  it('exports both workflows from the workflow bundle, and registers the activity', () => {
    expect(read('apps/orchestrator/src/workflows/index.ts')).toContain(
      "export * from './content.studio.feed.capture.workflow';"
    );
    const module = read('apps/orchestrator/src/app.module.ts');
    expect(module).toMatch(
      /import \{ ContentStudioSourceActivity \} from '@gitroom\/orchestrator\/activities\/content-studio\.source\.activity';/
    );
    // in the activities, and the only class of the capture Worker (P8-C2)
    expect(module.match(/ContentStudioSourceActivity/g)).toHaveLength(3);
    expect(module).toMatch(
      /getTemporalModule\(true, require\.resolve\('\.\/workflows'\), activities, \[\s*ContentStudioSourceActivity,\s*\]\)/
    );
  });

  it('the backend starts exactly one scan, under RUN_CRON, with a fixed id', () => {
    const register = read(
      'libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts'
    );
    expect(register).toMatch(
      /if \(!!process\.env\.RUN_CRON\) \{[\s\S]*'contentStudioFeedScanWorkflowV1', \{\s*workflowId: 'content-studio-feed-scan-workflow',/
    );
    expect(register.match(/contentStudioFeedScanWorkflowV1/g)).toHaveLength(1);
  });

  it('is a new workflow: the existing workflow files are unchanged in what they export', () => {
    const workflow = read(
      'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts'
    ).replace(/^\s*\/\/.*$/gm, '');
    // the activity is a type only: no Nest, Prisma or fetch code in the bundle
    expect(workflow).toMatch(
      /import type \{ ContentStudioSourceActivity \} from/
    );
    expect(workflow).not.toMatch(
      /@nestjs|@prisma|safeFetch|\bfetch\(|rss-parser|fast-xml-parser|process\.env|Date\.now|Math\.random/
    );
    // P8-C2: the queue name comes from its one module, never a literal
    expect(workflow).toContain(
      "import { CONTENT_STUDIO_CAPTURE_TASK_QUEUE } from '@gitroom/nestjs-libraries/temporal/content.studio.capture.queue';"
    );
    expect(workflow).not.toContain("'content-studio-capture'");
    // the list, the capture, the failure record (P8-C4) and the child start
    expect(workflow.match(/taskQueue: /g)).toHaveLength(4);
    expect(workflow).toMatch(
      /const \{ captureContentStudioFeed \} =\s*proxyActivities<ContentStudioSourceActivity>\(\{\s*startToCloseTimeout: '10 minute',\s*taskQueue: CONTENT_STUDIO_CAPTURE_TASK_QUEUE,/
    );
    // no deadline to wait in the queue, and none on the capture workflow
    expect(workflow).not.toMatch(
      /scheduleToStartTimeout|scheduleToCloseTimeout|workflowExecutionTimeout|workflowRunTimeout/
    );
    // P8C4-4 one cadence, written once; P8C4-14 no Temporal schedule of its own
    expect(workflow).toContain("const SCAN_CADENCE = '10 minutes';");
    expect(workflow.match(/sleep\(SCAN_CADENCE\)/g)).toHaveLength(2);
    expect(workflow).not.toMatch(
      /sleep\('|1 hour|schedule\.create|cronSchedule/
    );
    expect(
      Array.from(workflow.matchAll(/export async function (\w+)/g), (m) => m[1])
    ).toEqual([
      'contentStudioFeedCaptureWorkflowV1',
      'contentStudioFeedScanWorkflowV1',
    ]);
  });
});
