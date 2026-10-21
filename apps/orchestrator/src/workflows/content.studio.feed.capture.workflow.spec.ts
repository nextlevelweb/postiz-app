import fs from 'fs';
import path from 'path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';

// The feed capture workflows (P8-01) as plain functions: the Temporal
// workflow API is replaced by mocks, so this checks what the workflows ask
// Temporal to do (activities, child starts, sleeps, continue-as-new), not a
// running Temporal. There is no Temporal test server in this repository
const mockActivities = {
  listContentStudioFeedsForCapture: jest.fn(),
  captureContentStudioFeed: jest.fn(),
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

beforeEach(() => {
  mockActivities.listContentStudioFeedsForCapture.mockReset();
  mockActivities.captureContentStudioFeed.mockReset();
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

  it('TM6/TM7 a capture is tried at most three times, a list at most three times, each within a deadline', () => {
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
        taskQueue: 'main',
        retry: {
          maximumAttempts: 3,
          backoffCoefficient: 1,
          initialInterval: '2 minutes',
        },
      },
    ]);
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
    // the last page: an hour of sleep, then a fresh scan from the start
    expect(mockSleep).toHaveBeenCalledWith('1 hour');
    expect(next).toEqual([{}]);
  });

  it('a full page continues at once from where it ended, without sleeping', async () => {
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

  it('51/52 a feed whose capture still runs keeps it: no second capture, the others start', async () => {
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
    expect(mockStartChild).not.toHaveBeenCalled();
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
    expect(module.match(/ContentStudioSourceActivity/g)).toHaveLength(2);
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
    expect(
      Array.from(workflow.matchAll(/export async function (\w+)/g), (m) => m[1])
    ).toEqual([
      'contentStudioFeedCaptureWorkflowV1',
      'contentStudioFeedScanWorkflowV1',
    ]);
  });
});
