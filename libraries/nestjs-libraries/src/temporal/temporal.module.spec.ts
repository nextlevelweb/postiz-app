import { TEMPORAL_MODULE_OPTIONS, TemporalOptions } from 'nestjs-temporal-core';
import {
  CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT,
  CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX,
  CONTENT_STUDIO_CAPTURE_TASK_QUEUE,
  ContentStudioCaptureConcurrencyError,
  contentStudioCaptureConcurrency,
} from '@gitroom/nestjs-libraries/temporal/content.studio.capture.queue';

// The Temporal Workers the orchestrator registers (P8-C2: the Content Studio
// capture Worker beside the main and provider ones). The provider list is
// replaced by a small one: the real list loads every provider SDK
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  socialIntegrationList: [
    { identifier: 'x', maxConcurrentJob: 1 },
    { identifier: 'reddit', maxConcurrentJob: 6 },
    { identifier: 'linkedin-page', maxConcurrentJob: 2 },
    { identifier: 'mastodon' },
  ],
}));

const { getTemporalModule } = require('./temporal.module');

class MainActivity {}
class OtherActivity {}
class CaptureActivity {}

const ENV = [
  'CONTENT_STUDIO_CAPTURE_CONCURRENCY',
  'WORKER_CONCURRENCY_DIVIDER',
  'EXCLUDE_QUEUE',
] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

const options = (
  env: Partial<Record<(typeof ENV)[number], string>> = {},
  isWorkers = true
): TemporalOptions => {
  for (const name of ENV) {
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }
  const module = getTemporalModule(
    isWorkers,
    '/workflows',
    [MainActivity, OtherActivity, CaptureActivity],
    [CaptureActivity]
  );
  return (module.providers as { provide?: unknown; useValue?: unknown }[]).find(
    (provider) => provider?.provide === TEMPORAL_MODULE_OPTIONS
  )!.useValue as TemporalOptions;
};
const worker = (opts: TemporalOptions, taskQueue: string) =>
  opts.workers!.find((item) => item.taskQueue === taskQueue);

describe('CONTENT_STUDIO_CAPTURE_CONCURRENCY (P8-C2)', () => {
  it('WC1 one queue name, and a bounded default within a bounded range', () => {
    expect(CONTENT_STUDIO_CAPTURE_TASK_QUEUE).toBe('content-studio-capture');
    expect(CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT).toBe(8);
    expect(CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX).toBe(32);
  });

  it('ENV1 unset or empty is the default', () => {
    expect(contentStudioCaptureConcurrency(undefined)).toBe(8);
    expect(contentStudioCaptureConcurrency('')).toBe(8);
  });

  it('ENV2/ENV3 a whole number from 1 to the maximum is taken as it is', () => {
    expect(contentStudioCaptureConcurrency('1')).toBe(1);
    expect(contentStudioCaptureConcurrency('12')).toBe(12);
    expect(contentStudioCaptureConcurrency('32')).toBe(32);
  });

  it.each([
    ['ENV4 zero', '0'],
    ['ENV5 negative', '-4'],
    ['ENV6 decimal', '2.5'],
    ['ENV6 exponent', '1e1'],
    ['ENV7 not a number', 'NaN'],
    ['ENV7 words', 'eight'],
    ['ENV8 above the maximum', '33'],
    ['ENV8 effectively unlimited', '1000000'],
    ['ENV8 Infinity', 'Infinity'],
    ['ENV9 surrounding whitespace', ' 8'],
    ['ENV9 trailing whitespace', '8 '],
    ['ENV9 only whitespace', '   '],
    ['a sign', '+8'],
    ['a leading zero', '08'],
    ['hexadecimal', '0x8'],
  ])('%s is refused', (_, value) => {
    expect(() => contentStudioCaptureConcurrency(value)).toThrow(
      ContentStudioCaptureConcurrencyError
    );
  });

  it('the refusal names the variable and the range, never the value given', () => {
    expect(() => contentStudioCaptureConcurrency('9999secret')).toThrow(
      'CONTENT_STUDIO_CAPTURE_CONCURRENCY must be a whole number from 1 to 32'
    );
    try {
      contentStudioCaptureConcurrency('9999secret');
    } catch (err) {
      expect((err as Error).message).not.toContain('9999secret');
    }
  });
});

describe('the orchestrator Workers (P8-C2)', () => {
  it('WC2/WC7 the capture Worker runs its queue with the default number of slots', () => {
    const capture = worker(options(), CONTENT_STUDIO_CAPTURE_TASK_QUEUE)!;
    expect(capture).toEqual({
      taskQueue: 'content-studio-capture',
      activityClasses: [CaptureActivity],
      autoStart: true,
      workerOptions: {
        maxConcurrentActivityTaskExecutions: 8,
        maxHeartbeatThrottleInterval: '15s',
      },
    });
  });

  it('WC2/WC8 the capture Worker takes the configured number, up to the maximum', () => {
    for (const [value, slots] of [
      ['1', 1],
      ['3', 3],
      ['32', 32],
    ] as const) {
      expect(
        worker(
          options({ CONTENT_STUDIO_CAPTURE_CONCURRENCY: value }),
          CONTENT_STUDIO_CAPTURE_TASK_QUEUE
        )!.workerOptions!.maxConcurrentActivityTaskExecutions
      ).toBe(slots);
    }
  });

  it('WC6 a wrong value stops the orchestrator: the module is never built', () => {
    for (const value of ['0', '-1', '2.5', 'NaN', '33', '1000000', ' 8']) {
      expect(() =>
        options({ CONTENT_STUDIO_CAPTURE_CONCURRENCY: value })
      ).toThrow(ContentStudioCaptureConcurrencyError);
    }
  });

  it('the backend and the commands run no Worker and never read the capture setting', () => {
    const opts = options(
      { CONTENT_STUDIO_CAPTURE_CONCURRENCY: 'not read here' },
      false
    );
    expect(opts.workers).toBeUndefined();
    expect(opts.taskQueue).toBe('main');
  });

  it('WC4 the capture Worker registers the capture activities only, and runs no workflow', () => {
    const capture = worker(options(), CONTENT_STUDIO_CAPTURE_TASK_QUEUE)!;
    expect(capture.activityClasses).toEqual([CaptureActivity]);
    expect(capture.workflowsPath).toBeUndefined();
    expect(capture.workflowBundle).toBeUndefined();
  });

  it('WC3 the main and provider Workers are as they were', () => {
    const opts = options();
    expect(
      opts.workers!.map((item) => [
        item.taskQueue,
        item.workerOptions!.maxConcurrentActivityTaskExecutions,
        item.workflowsPath ?? null,
        item.activityClasses!.length,
      ])
    ).toEqual([
      ['main', 1000000, '/workflows', 3],
      ['x', 1, null, 3],
      ['reddit', 6, null, 3],
      ['mastodon', 1000000, null, 3],
      ['content-studio-capture', 8, null, 1],
    ]);
    // one Worker per queue, the workflows on `main` only
    expect(new Set(opts.workers!.map((item) => item.taskQueue)).size).toBe(
      opts.workers!.length
    );
  });

  it('WC5 every Worker starts with the orchestrator and is shut down with it', () => {
    // nestjs-temporal-core starts every autoStart Worker on bootstrap and
    // shuts every registered Worker down on shutdown: no Worker of its own
    for (const item of options().workers!) {
      expect([item.taskQueue, item.autoStart]).toEqual([item.taskQueue, true]);
    }
  });

  it('several servers split the slots like the provider queues (never below one)', () => {
    const slots = (divider: string) =>
      worker(
        options({ WORKER_CONCURRENCY_DIVIDER: divider }),
        CONTENT_STUDIO_CAPTURE_TASK_QUEUE
      )!.workerOptions!.maxConcurrentActivityTaskExecutions;
    expect(slots('1')).toBe(8);
    expect(slots('2')).toBe(4);
    expect(slots('3')).toBe(2);
    expect(slots('16')).toBe(1);
  });

  it('EXCLUDE_QUEUE pins the capture queue to one server; the setting is still checked', () => {
    const opts = options({ EXCLUDE_QUEUE: 'reddit,content-studio-capture' });
    expect(worker(opts, CONTENT_STUDIO_CAPTURE_TASK_QUEUE)).toBeUndefined();
    expect(worker(opts, 'main')).toBeDefined();
    expect(() =>
      options({
        EXCLUDE_QUEUE: 'content-studio-capture',
        CONTENT_STUDIO_CAPTURE_CONCURRENCY: '0',
      })
    ).toThrow(ContentStudioCaptureConcurrencyError);
  });
});
