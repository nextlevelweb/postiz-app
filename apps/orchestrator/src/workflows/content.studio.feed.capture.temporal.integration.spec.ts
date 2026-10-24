import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import {
  ActivityFailure,
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError,
  WorkflowHandle,
} from '@temporalio/client';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import {
  TEMPORAL_MODULE_OPTIONS,
  TemporalOptions,
  TemporalWorkerManagerService,
} from 'nestjs-temporal-core';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import {
  ContentStudioSourceIngestionService,
  FEED_CAPTURE_CONCURRENCY,
} from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import type { SafeFetchResult } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { CONTENT_STUDIO_CAPTURE_TASK_QUEUE } from '@gitroom/nestjs-libraries/temporal/content.studio.capture.queue';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { ContentStudioSourceActivity } from '@gitroom/orchestrator/activities/content-studio.source.activity';
import { createContentStudioPostgresClient } from '../../../../jest.content-studio.postgres.guard';
import { contentStudioTemporalAddressFromEnv } from '../../../../jest.content-studio.temporal.guard';
import { CONTENT_STUDIO_TEMPORAL_BUNDLE_ENV } from '../../../../jest.content-studio.temporal.setup';

// Global feed-capture concurrency (P8-C2) on a real Temporal server. The
// orchestrator's own Temporal module runs here, through nestjs-temporal-core
// as in production: the main Worker (with the feed workflows) and the
// Content Studio capture Worker, configured by CONTENT_STUDIO_CAPTURE_CONCURRENCY
// = 3. The workflows are the real ones, bundled from their source; the
// capture activity is the real one. Behind it, a capture is either held by
// the test (to see how many run at once) or the real ingestion service on the
// disposable PostgreSQL database, with an in-memory web. Opt-in: runs only
// through jest.content-studio.temporal.config.ts
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  // no provider queues: they load every provider SDK and are not under test
  socialIntegrationList: [],
}));

type Web = { feeds: Map<string, string>; pages: Map<string, string> };
const web: Web = { feeds: new Map(), pages: new Map() };
// the fetches in flight, by kind; when `gate` is set, page fetches wait
// until that many are in flight at once (or give up after a while)
const inFlight = {
  feeds: 0,
  feedsMax: 0,
  pages: 0,
  pagesMax: 0,
  gate: null as null | {
    size: number;
    waiting: Array<() => void>;
    timedOut: boolean;
  },
};
const mockSafeFetch = jest.fn(async (url: string): Promise<SafeFetchResult> => {
  const answer = (body: string, contentType: string): SafeFetchResult => {
    const bytes = new TextEncoder().encode(body);
    return {
      requestedUrl: url,
      finalUrl: url,
      redirects: [],
      status: 200,
      headers: { contentType },
      body: bytes,
      bytesRead: bytes.byteLength,
    };
  };
  if (web.feeds.has(url)) {
    inFlight.feeds += 1;
    inFlight.feedsMax = Math.max(inFlight.feedsMax, inFlight.feeds);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight.feeds -= 1;
    return answer(web.feeds.get(url)!, 'application/rss+xml');
  }
  if (web.pages.has(url)) {
    inFlight.pages += 1;
    inFlight.pagesMax = Math.max(inFlight.pagesMax, inFlight.pages);
    const gate = inFlight.gate;
    if (gate) {
      await new Promise<void>((resolve) => {
        gate.waiting.push(resolve);
        const open = () => {
          if (inFlight.gate === gate) {
            inFlight.gate = null;
            gate.waiting.forEach((go) => go());
          }
        };
        if (gate.waiting.length >= gate.size) {
          open();
        } else if (gate.waiting.length === 1) {
          setTimeout(() => {
            gate.timedOut = inFlight.gate === gate;
            open();
          }, 10_000).unref();
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight.pages -= 1;
    return answer(web.pages.get(url)!, 'text/html; charset=utf-8');
  }
  const { SafeFetchError } = jest.requireActual(
    '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'
  );
  throw new SafeFetchError('HTTP_STATUS', { statusCode: 404 });
});
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  ...jest.requireActual('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...(args as [string])),
}));
// the P8-C1 limits, unchanged unless a test lowers one
const mockLimits = {
  activeFeedsMax: 100,
  urlSourcesMax: 100_000,
  manualRefreshCooldownMs: 5 * 60 * 1000,
};
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/sources/source.types',
  () => ({
    ...jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/sources/source.types'
    ),
    contentStudioSourceLimits: () => ({ ...mockLimits }),
  })
);

const LIMIT = 3;
// Separate from the other fixtures: their own organizations and users
const ORG_A = '30c20000-0000-4000-8000-00000000000a';
const ORG_B = '30c20000-0000-4000-8000-00000000000b';
const ORG_C = '30c20000-0000-4000-8000-00000000000c';
const ORGS = [ORG_A, ORG_B, ORG_C];
const USER = (org: string) => org.replace(/0(\w)$/, 'f$1');
const SUMMARY = {
  entriesSeen: 1,
  entriesIgnored: 0,
  entriesSkipped: 0,
  entriesAccepted: 1,
  sourcesCreated: 0,
  versionsCreated: 1,
  unchanged: 0,
  failed: 0,
  archived: 0,
  entriesLimited: 0,
};
// PendingActivityState of the Temporal API
const SCHEDULED = 1;
const STARTED = 2;

let address: string;
let client: PrismaClient;
let ingestion: ContentStudioSourceIngestionService;
let sourceService: ContentStudioSourceService;
let app: TestingModule;
let options: TemporalOptions;
let connection: Connection;
let temporal: Client;

// Captures of the test: each waits until the test releases it, with
// nothing (done) or the error the ingestion service would throw
const held = new Map<
  string,
  { organizationId: string; release: (error?: Error) => void }
>();
const started: string[] = [];
const startedAt = new Map<string, number>();
const calls = new Map<string, number>();
// every capture activity in flight, held or real
const activities = {
  running: 0,
  max: 0,
  byOrganization: new Map<string, number>(),
};
// sources whose capture is the real one, on PostgreSQL
const real = new Set<string>();
let listFeeds: (input: { afterId: string | null }) => Promise<unknown>;
const handles: WorkflowHandle[] = [];

const heldCapture = async (input: {
  organizationId: string;
  sourceId: string;
}) => {
  started.push(input.sourceId);
  startedAt.set(input.sourceId, Date.now());
  const error = await new Promise<Error | undefined>((resolve) =>
    held.set(input.sourceId, {
      organizationId: input.organizationId,
      release: resolve,
    })
  );
  held.delete(input.sourceId);
  if (error) {
    throw error;
  }
  return { status: 'captured' as const, capture: SUMMARY };
};
// What the capture activity is given as its ingestion service
const router = {
  async captureScheduledFeed(input: {
    organizationId: string;
    sourceId: string;
  }) {
    calls.set(input.sourceId, (calls.get(input.sourceId) ?? 0) + 1);
    activities.running += 1;
    activities.max = Math.max(activities.max, activities.running);
    activities.byOrganization.set(
      input.organizationId,
      (activities.byOrganization.get(input.organizationId) ?? 0) + 1
    );
    try {
      return real.has(input.sourceId)
        ? await ingestion.captureScheduledFeed(input)
        : await heldCapture(input);
    } finally {
      activities.running -= 1;
      activities.byOrganization.set(
        input.organizationId,
        activities.byOrganization.get(input.organizationId)! - 1
      );
    }
  },
  listFeedsDueForCapture(input: { afterId: string | null }) {
    return listFeeds(input);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 30_000
) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(25);
  }
};
const workflowId = (sourceId: string) =>
  `content-studio-feed-capture-${sourceId}`;
const startCapture = async (organizationId: string, sourceId: string) => {
  const handle = await temporal.workflow.start(
    'contentStudioFeedCaptureWorkflowV1',
    {
      taskQueue: 'main',
      workflowId: workflowId(sourceId),
      args: [{ organizationId, sourceId }],
    }
  );
  handles.push(handle);
  return handle;
};
const release = (sourceId: string, error?: Error) => {
  const capture = held.get(sourceId);
  if (!capture) {
    throw new Error('that capture is not running');
  }
  capture.release(error);
};
const runningNow = () => [...held.keys()].sort();
// what Temporal says of the capture activity of a workflow
const pending = async (handle: WorkflowHandle) =>
  (await handle.describe()).raw.pendingActivities ?? [];
const captureEvents = async (handle: WorkflowHandle) => {
  const { events } = await handle.fetchHistory();
  return {
    queues: events!
      .filter(
        (e) =>
          e.activityTaskScheduledEventAttributes?.activityType?.name ===
          'captureContentStudioFeed'
      )
      .map((e) => e.activityTaskScheduledEventAttributes!.taskQueue!.name),
    attempts: events!
      .filter((e) => e.activityTaskStartedEventAttributes)
      .map((e) => e.activityTaskStartedEventAttributes!.attempt),
  };
};
const failure = (code: string) =>
  new HttpException({ msg: 'The test failure.', code }, 502);
const feedUrl = (name: string) => `https://p8c2.example/${name}.xml`;
const page = (name: string) => `https://p8c2.example/page-${name}`;
const html = (text: string) =>
  `<!doctype html><html><head><title>P8C2 page</title></head><body><main><p>${text}</p></main></body></html>`;
const rss = (links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>P8C2</title>${links
    .map(
      (link, i) =>
        `<item><title>Story ${i}</title><link>${link}</link><guid>g-${i}</guid></item>`
    )
    .join('')}</channel></rss>`;
// a live feed of the organization with `entries` new pages, captured for real
const realFeed = async (organizationId: string, name: string, entries = 1) => {
  const id = randomUUID();
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'feed',
      name: `P8C2 ${name}`,
      canonicalUrl: feedUrl(name),
      createdById: USER(organizationId),
    },
  });
  const links = Array.from({ length: entries }, (_, i) => page(`${name}-${i}`));
  web.feeds.set(feedUrl(name), rss(links));
  links.forEach((link, i) => web.pages.set(link, html(`${name} ${i}`)));
  real.add(id);
  return id;
};

const clean = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceDiscovery.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await clean();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: ORGS.map(USER) } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

beforeAll(async () => {
  address = contentStudioTemporalAddressFromEnv();
  // the SDK's own logs, native ones included: errors only
  Runtime.install({
    logger: new DefaultLogger('ERROR'),
    telemetryOptions: {
      logging: { filter: { core: 'ERROR', other: 'ERROR' } },
    },
  });
  client = createContentStudioPostgresClient();
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  const sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaTransaction(prisma)
  );
  const discoveries = new ContentStudioSourceDiscoveryRepository(
    new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
  );
  ingestion = new ContentStudioSourceIngestionService(sources, discoveries);
  sourceService = new ContentStudioSourceService(sources, discoveries);
  await cleanFixtures();
  for (const org of ORGS) {
    await client.organization.create({
      data: { id: org, name: `P8C2 ${org}` },
    });
    await client.user.create({
      data: {
        id: USER(org),
        email: `${USER(org)}@p8c2.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8C2 ${org}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: USER(org), organizationId: org, role: 'USER' },
    });
  }

  // the orchestrator's Temporal module, configured as on a server
  process.env.TEMPORAL_ADDRESS = address;
  process.env.CONTENT_STUDIO_CAPTURE_CONCURRENCY = String(LIMIT);
  delete process.env.WORKER_CONCURRENCY_DIVIDER;
  delete process.env.EXCLUDE_QUEUE;
  const module = getTemporalModule(
    true,
    undefined,
    [ContentStudioSourceActivity],
    [ContentStudioSourceActivity]
  );
  options = (
    module.providers as { provide?: unknown; useValue?: unknown }[]
  ).find((provider) => provider?.provide === TEMPORAL_MODULE_OPTIONS)!
    .useValue as TemporalOptions;
  // The one test-only step: the main Worker gets the feed workflows bundled
  // from their source by the global setup. The capture Worker is as built
  const main = options.workers!.find((worker) => worker.taskQueue === 'main')!;
  main.workflowBundle = {
    code: readFileSync(
      process.env[CONTENT_STUDIO_TEMPORAL_BUNDLE_ENV]!,
      'utf8'
    ),
  };
  app = await Test.createTestingModule({
    imports: [module],
    providers: [
      ContentStudioSourceActivity,
      { provide: ContentStudioSourceIngestionService, useValue: router },
    ],
  }).compile();
  await app.init();
  const workers = app.get(TemporalWorkerManagerService);
  await until(
    () =>
      ['main', CONTENT_STUDIO_CAPTURE_TASK_QUEUE].every(
        (queue) => workers.getWorkerStatusByTaskQueue(queue)?.isRunning
      ),
    'both Workers'
  );

  connection = await Connection.connect({ address });
  temporal = new Client({ connection, namespace: 'default' });
}, 180_000);

beforeEach(async () => {
  await clean();
  web.feeds.clear();
  web.pages.clear();
  real.clear();
  started.length = 0;
  startedAt.clear();
  calls.clear();
  handles.length = 0;
  activities.max = 0;
  activities.byOrganization.clear();
  Object.assign(inFlight, {
    feeds: 0,
    feedsMax: 0,
    pages: 0,
    pagesMax: 0,
    gate: null,
  });
  Object.assign(mockLimits, {
    activeFeedsMax: 100,
    urlSourcesMax: 100_000,
    manualRefreshCooldownMs: 5 * 60 * 1000,
  });
  listFeeds = async () => ({ feeds: [], next: null });
  mockSafeFetch.mockClear();
});

afterEach(async () => {
  // nothing left behind for the next test: every open workflow (a sleeping
  // scan, a capture waiting for a slot or for its retry) is ended, and the
  // captures still held finish
  for await (const open of temporal.workflow.list({
    query: 'ExecutionStatus="Running"',
  })) {
    await temporal.workflow
      .getHandle(open.workflowId, open.runId)
      .terminate('end of the test')
      .catch(() => undefined);
  }
  await until(() => {
    for (const sourceId of [...held.keys()]) {
      release(sourceId);
    }
    return activities.running === 0;
  }, 'no capture running');
});

afterAll(async () => {
  for (const sourceId of [...held.keys()]) {
    release(sourceId);
  }
  await app?.close();
  await connection?.close();
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
}, 60_000);

describe('P8-C2 on Temporal: the capture queue is bounded', () => {
  it('P8C2T1/P8C2T2 ten captures at a limit of three: three run, seven wait in the queue unattempted, then all ten complete', async () => {
    const ids = Array.from({ length: 10 }, () => randomUUID());
    const handlesByFeed = new Map<string, WorkflowHandle>();
    for (const id of ids) {
      handlesByFeed.set(id, await startCapture(ORG_A, id));
    }
    await until(() => held.size === LIMIT, 'three captures');
    // more time than a free slot takes to fill: still three
    await sleep(1500);
    expect(held.size).toBe(LIMIT);
    expect(activities.max).toBe(LIMIT);
    // Temporal's view: three started, seven scheduled on the capture queue,
    // none of them on a second attempt
    const states = await Promise.all(
      ids.map(async (id) => (await pending(handlesByFeed.get(id)!))[0])
    );
    expect(states.map((p) => p?.state).sort()).toEqual([
      ...Array(ids.length - LIMIT).fill(SCHEDULED),
      ...Array(LIMIT).fill(STARTED),
    ]);
    expect(states.every((p) => p?.attempt === 1)).toBe(true);
    expect(
      states.every((p) => p?.activityType?.name === 'captureContentStudioFeed')
    ).toBe(true);

    // released three at a time: each batch frees three slots for the next
    const batches: string[][] = [];
    const released = new Set<string>();
    while (released.size < ids.length) {
      const remaining = ids.length - released.size;
      await until(
        () =>
          runningNow().filter((id) => !released.has(id)).length ===
          Math.min(LIMIT, remaining),
        'the next batch'
      );
      const batch = runningNow().filter((id) => !released.has(id));
      batches.push(batch);
      batch.forEach((id) => {
        released.add(id);
        release(id);
      });
    }
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 3, 1]);
    const results = await Promise.all(
      ids.map((id) => handlesByFeed.get(id)!.result())
    );
    // the capture result passes through unchanged
    expect(results).toEqual(
      Array(ids.length).fill({ status: 'captured', capture: SUMMARY })
    );
    expect(activities.max).toBe(LIMIT);
    expect(started.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(calls.get(id)).toBe(1);
      // the capture ran on the capture queue, at its first attempt: waiting
      // for a slot used none
      expect(await captureEvents(handlesByFeed.get(id)!)).toEqual({
        queues: [CONTENT_STUDIO_CAPTURE_TASK_QUEUE],
        attempts: [1],
      });
    }
  });

  it('P8C2T3/P8C2T8 the main queue is not held up: while the capture queue is full, the scan lists feeds and starts more captures than there are slots', async () => {
    const busy = Array.from({ length: 5 }, () => randomUUID());
    for (const id of busy) {
      await startCapture(ORG_A, id);
    }
    await until(() => held.size === LIMIT, 'a full capture queue');
    const due = Array.from({ length: 6 }, (_, i) => ({
      organizationId: ORGS[i % ORGS.length],
      sourceId: randomUUID(),
    }));
    let listedAt = 0;
    listFeeds = async () => {
      listedAt = Date.now();
      return { feeds: due, next: null };
    };
    const askedAt = Date.now();
    const scan = await temporal.workflow.start(
      'contentStudioFeedScanWorkflowV1',
      { taskQueue: 'main', workflowId: `p8c2-scan-${randomUUID()}`, args: [{}] }
    );
    handles.push(scan);
    // the scan's list activity runs on `main` at once, behind no capture
    await until(() => listedAt > 0, 'the list activity on main');
    expect(listedAt - askedAt).toBeLessThan(5_000);
    // every due feed got its capture workflow, though no slot is free
    for (const feed of due) {
      const child = temporal.workflow.getHandle(workflowId(feed.sourceId));
      await until(
        async () =>
          (await child.describe().catch(() => null))?.status.name === 'RUNNING',
        'a capture workflow per due feed'
      );
      handles.push(child);
      await until(
        async () => (await pending(child)).length === 1,
        'its capture to be scheduled'
      );
      expect((await pending(child))[0]).toMatchObject({
        state: SCHEDULED,
        attempt: 1,
      });
    }
    // the scan went on to its sleep: it waits for no capture
    await until(
      async () =>
        (
          await scan.fetchHistory()
        ).events!.some((e) => e.timerStartedEventAttributes),
      'the scan to sleep'
    );
    expect(held.size).toBe(LIMIT);
    expect(activities.max).toBe(LIMIT);
    // and everything queued runs, three at a time
    const all = [...busy, ...due.map((feed) => feed.sourceId)];
    while (started.length < all.length || held.size) {
      runningNow().forEach((id) => release(id));
      await sleep(50);
    }
    expect(started.sort()).toEqual([...all].sort());
    expect(activities.max).toBe(LIMIT);
  });

  it('P8C2T4 the limit is global: one organization may fill every slot, the others wait behind it, never more than three in all', async () => {
    const byOrg = new Map(
      ORGS.map((org) => [org, Array.from({ length: 3 }, () => randomUUID())])
    );
    for (const id of byOrg.get(ORG_A)!) {
      await startCapture(ORG_A, id);
    }
    await until(() => held.size === LIMIT, 'organization A in every slot');
    for (const org of [ORG_B, ORG_C]) {
      for (const id of byOrg.get(org)!) {
        await startCapture(org, id);
      }
    }
    await sleep(1500);
    expect([...held.values()].map((capture) => capture.organizationId)).toEqual(
      [ORG_A, ORG_A, ORG_A]
    );
    // B and C are not given slots of their own
    expect(activities.byOrganization.get(ORG_B) ?? 0).toBe(0);
    expect(activities.byOrganization.get(ORG_C) ?? 0).toBe(0);
    let mixed = false;
    while (started.length < 9 || held.size) {
      const orgs = new Set(
        [...held.values()].map((capture) => capture.organizationId)
      );
      mixed = mixed || orgs.size > 1;
      expect(held.size).toBeLessThanOrEqual(LIMIT);
      runningNow()
        .slice(0, 1)
        .forEach((id) => release(id));
      await sleep(100);
    }
    expect(mixed).toBe(true);
    expect(activities.max).toBe(LIMIT);
    expect(new Set(started).size).toBe(9);
  });

  it('P8C2T5 a failing capture frees its slot: refused at once, or waiting for its retry without a slot; the queue goes on', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const handlesByFeed = new Map<string, WorkflowHandle>();
    for (const id of ids) {
      handlesByFeed.set(id, await startCapture(ORG_A, id));
    }
    await until(() => held.size === LIMIT, 'a full capture queue');
    const [refused, retried] = runningNow();
    // a refusal is not tried again: the workflow fails, the slot is free
    release(refused, failure('CS_SOURCE_FEED_INVALID'));
    const error = await handlesByFeed
      .get(refused)!
      .result()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const activity = (error as WorkflowFailedError).cause as ActivityFailure;
    expect(activity).toBeInstanceOf(ActivityFailure);
    expect((activity as { cause?: unknown }).cause).toMatchObject({
      type: 'CS_SOURCE_FEED_INVALID',
      nonRetryable: true,
    });
    await until(() => held.size === LIMIT, 'a queued capture in the slot');
    // a feed that could not be reached is tried again after the policy's
    // interval; while it waits, it holds no slot
    release(retried, failure('CS_SOURCE_FETCH_FAILED'));
    await until(
      async () =>
        (await pending(handlesByFeed.get(retried)!))[0]?.attempt === 2,
      'the second attempt to be scheduled'
    );
    const retry = (await pending(handlesByFeed.get(retried)!))[0]!;
    expect(retry.state).toBe(SCHEDULED);
    expect(retry.lastFailure?.applicationFailureInfo?.type).toBe(
      'CS_SOURCE_FETCH_FAILED'
    );
    await until(
      () => held.size === LIMIT,
      'the last queued capture in the slot'
    );
    expect(started).toHaveLength(ids.length);
    expect(held.has(retried)).toBe(false);
    expect(activities.max).toBe(LIMIT);
  });

  it('P8C2T6 the same feed never has two captures: a second start is refused, and the scan skips a feed whose capture waits or runs', async () => {
    const running = randomUUID();
    const queued = randomUUID();
    for (const id of [randomUUID(), randomUUID(), running, queued]) {
      await startCapture(ORG_A, id);
    }
    await until(() => held.size === LIMIT, 'a full capture queue');
    // the fourth waits in the queue; the third may be any of the first three
    const inSlot = runningNow()[0];
    for (const id of [inSlot, queued]) {
      await expect(startCapture(ORG_A, id)).rejects.toBeInstanceOf(
        WorkflowExecutionAlreadyStartedError
      );
    }
    listFeeds = async () => ({
      feeds: [
        { organizationId: ORG_A, sourceId: inSlot },
        { organizationId: ORG_A, sourceId: queued },
      ],
      next: null,
    });
    const scan = await temporal.workflow.start(
      'contentStudioFeedScanWorkflowV1',
      { taskQueue: 'main', workflowId: `p8c2-scan-${randomUUID()}`, args: [{}] }
    );
    handles.push(scan);
    await until(
      async () =>
        (
          await scan.fetchHistory()
        ).events!.some((e) => e.timerStartedEventAttributes),
      'the scan to sleep'
    );
    // the scan did not fail on them
    expect((await scan.describe()).status.name).toBe('RUNNING');
    while (started.length < 4 || held.size) {
      runningNow().forEach((id) => release(id));
      await sleep(50);
    }
    await sleep(500);
    expect(calls.get(inSlot)).toBe(1);
    expect(calls.get(queued)).toBe(1);
  });
});

describe('P8-C2 on Temporal and PostgreSQL: the real capture behind the queue', () => {
  it('P8C2T7 a feed archived while its capture waits is skipped when the capture starts: nothing fetched, nothing recorded', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await startCapture(ORG_A, randomUUID());
    }
    await until(() => held.size === LIMIT, 'a full capture queue');
    const feed = await realFeed(ORG_A, 'archived');
    const handle = await startCapture(ORG_A, feed);
    await sleep(500);
    expect((await pending(handle))[0]?.state).toBe(SCHEDULED);
    await sourceService.archiveSource(ORG_A, feed);
    runningNow().forEach((id) => release(id));
    expect(await handle.result()).toEqual({ status: 'skipped' });
    expect(mockSafeFetch).not.toHaveBeenCalled();
    const row = await client.contentStudioSource.findUniqueOrThrow({
      where: { id: feed },
    });
    expect(row.lastCapturedAt).toBeNull();
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A, kind: 'url' },
      })
    ).toBe(0);
  });

  it('P8C2T7 a feed whose organization is deleted while its capture waits is skipped too', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await startCapture(ORG_A, randomUUID());
    }
    await until(() => held.size === LIMIT, 'a full capture queue');
    const feed = await realFeed(ORG_B, 'deleted');
    const handle = await startCapture(ORG_B, feed);
    await sleep(500);
    await client.organization.update({
      where: { id: ORG_B },
      data: { deletedAt: new Date() },
    });
    try {
      runningNow().forEach((id) => release(id));
      expect(await handle.result()).toEqual({ status: 'skipped' });
      expect(mockSafeFetch).not.toHaveBeenCalled();
    } finally {
      await client.organization.update({
        where: { id: ORG_B },
        data: { deletedAt: null },
      });
    }
  });

  it('P8C2T10 a waiting feed is marked captured only once captured: it stays due, and the scan does not start it again', async () => {
    for (let i = 0; i < LIMIT; i++) {
      await startCapture(ORG_A, randomUUID());
    }
    await until(() => held.size === LIMIT, 'a full capture queue');
    const feed = await realFeed(ORG_C, 'waiting');
    const handle = await startCapture(ORG_C, feed);
    // the real list of due feeds, of these organizations only
    listFeeds = async (input) => {
      const due = await ingestion.listFeedsDueForCapture(input);
      return {
        ...due,
        feeds: due.feeds.filter((f) => ORGS.includes(f.organizationId)),
      };
    };
    const scan = await temporal.workflow.start(
      'contentStudioFeedScanWorkflowV1',
      { taskQueue: 'main', workflowId: `p8c2-scan-${randomUUID()}`, args: [{}] }
    );
    handles.push(scan);
    await until(
      async () =>
        (
          await scan.fetchHistory()
        ).events!.some((e) => e.timerStartedEventAttributes),
      'the scan to sleep'
    );
    const waiting = await client.contentStudioSource.findUniqueOrThrow({
      where: { id: feed },
    });
    expect(waiting.lastCapturedAt).toBeNull();
    runningNow().forEach((id) => release(id));
    const result = (await handle.result()) as {
      status: string;
      capture: Record<string, number>;
    };
    expect(result.status).toBe('captured');
    expect(calls.get(feed)).toBe(1);
    const captured = await client.contentStudioSource.findUniqueOrThrow({
      where: { id: feed },
    });
    expect(captured.lastCapturedAt).not.toBeNull();
  });

  it('P8C2T9 real captures under a full queue: at most 3 feeds and 3 x 5 pages fetched at once, results and P8-C1 limits as without the queue', async () => {
    // organization A may add 40 pages: its two feeds list 50 new ones
    mockLimits.urlSourcesMax = 40;
    const feeds = [
      [ORG_A, await realFeed(ORG_A, 'a1', 25)],
      [ORG_A, await realFeed(ORG_A, 'a2', 25)],
      [ORG_B, await realFeed(ORG_B, 'b1', 25)],
      [ORG_C, await realFeed(ORG_C, 'c1', 25)],
    ] as const;
    // the first page fetches wait until 15 are in flight at once
    inFlight.gate = {
      size: LIMIT * FEED_CAPTURE_CONCURRENCY,
      waiting: [],
      timedOut: false,
    };
    const gate = inFlight.gate;
    const handlesByFeed = await Promise.all(
      feeds.map(([org, id]) => startCapture(org, id))
    );
    const results = (await Promise.all(
      handlesByFeed.map((handle) => handle.result())
    )) as Array<{ status: string; capture: Record<string, number> }>;
    expect(gate.timedOut).toBe(false);
    expect(activities.max).toBe(LIMIT);
    expect(inFlight.feedsMax).toBeLessThanOrEqual(LIMIT);
    expect(inFlight.pagesMax).toBe(LIMIT * FEED_CAPTURE_CONCURRENCY);
    // what a capture reports is what it reports without the queue
    const byFeed = new Map(feeds.map(([, id], i) => [id, results[i]]));
    for (const [, id] of feeds) {
      expect(byFeed.get(id)!.status).toBe('captured');
    }
    const a = [feeds[0][1], feeds[1][1]].map((id) => byFeed.get(id)!.capture);
    for (const capture of [
      ...a,
      byFeed.get(feeds[2][1])!.capture,
      byFeed.get(feeds[3][1])!.capture,
    ]) {
      expect(capture).toMatchObject({
        entriesSeen: 25,
        entriesIgnored: 0,
        entriesSkipped: 0,
        unchanged: 0,
        failed: 0,
        archived: 0,
      });
      expect(capture.entriesAccepted + capture.entriesLimited).toBe(25);
      expect(capture.sourcesCreated).toBe(capture.entriesAccepted);
      expect(capture.versionsCreated).toBe(capture.entriesAccepted);
    }
    // P8-C1 holds behind the queue: A's limit is exact, B and C are whole
    expect(a.map((c) => c.sourcesCreated).reduce((x, y) => x + y)).toBe(40);
    expect(a.map((c) => c.entriesLimited).reduce((x, y) => x + y)).toBe(10);
    expect(byFeed.get(feeds[2][1])!.capture.entriesLimited).toBe(0);
    expect(byFeed.get(feeds[3][1])!.capture.entriesLimited).toBe(0);
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A, kind: 'url' },
      })
    ).toBe(40);
    // every page that was not limited was fetched once, every feed once
    expect(mockSafeFetch).toHaveBeenCalledTimes(4 + 40 + 25 + 25);
    for (const handle of handlesByFeed) {
      expect(await captureEvents(handle)).toEqual({
        queues: [CONTENT_STUDIO_CAPTURE_TASK_QUEUE],
        attempts: [1],
      });
    }
  });
});

describe('P8-C2 on Temporal: the Workers', () => {
  it('WC5 the capture Worker runs beside the main one, with the configured slots, and stops with the orchestrator', async () => {
    const workers = app.get(TemporalWorkerManagerService);
    expect(
      options.workers!.map((worker) => [
        worker.taskQueue,
        worker.workerOptions?.maxConcurrentActivityTaskExecutions,
      ])
    ).toEqual([
      ['main', 1000000],
      [CONTENT_STUDIO_CAPTURE_TASK_QUEUE, LIMIT],
    ]);
    const capture = workers.getWorker(CONTENT_STUDIO_CAPTURE_TASK_QUEUE)!;
    expect(capture.getState()).toBe('RUNNING');
    // the capture queue has a poller; the main queue still has its own
    const pollers = async (name: string) =>
      (
        await connection.workflowService.describeTaskQueue({
          namespace: 'default',
          taskQueue: { name },
          taskQueueType: 2, // TASK_QUEUE_TYPE_ACTIVITY
        })
      ).pollers ?? [];
    expect(
      (await pollers(CONTENT_STUDIO_CAPTURE_TASK_QUEUE)).length
    ).toBeGreaterThan(0);
    expect((await pollers('main')).length).toBeGreaterThan(0);
    await app.close();
    await until(
      () => ['STOPPED', 'DRAINED'].includes(capture.getState()),
      'the capture Worker to stop',
      40_000
    );
    app = undefined as unknown as TestingModule;
  });
});
