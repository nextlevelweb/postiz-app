import {
  ActivityFailure,
  ApplicationFailure,
  continueAsNew,
  isCancellation,
  proxyActivities,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { ContentStudioSourceActivity } from '@gitroom/orchestrator/activities/content-studio.source.activity';
import { CONTENT_STUDIO_CAPTURE_TASK_QUEUE } from '@gitroom/nestjs-libraries/temporal/content.studio.capture.queue';

// Scheduled capture of Content Studio feed sources (P8-01).
//
// contentStudioFeedScanWorkflowV1 runs forever (one execution, started by
// the backend under RUN_CRON): it pages through the live feeds due for a
// capture, starts one contentStudioFeedCaptureWorkflowV1 per feed, and after
// the last page sleeps for the scan cadence. Every page continues as new, so
// its history stays small. A feed whose capture is still running keeps it:
// its workflow id is the feed's, so a second one is never started at the
// same time. A page that could not be listed (its attempts used up) is
// listed again after the cadence, from the same place: the scan never ends
// on its own (P8-C4).
//
// contentStudioFeedCaptureWorkflowV1 captures one feed through the same
// ingestion service as the refresh route, by ids only. A capture that could
// not reach the feed is tried again (3 attempts in all); a refused one is not
// tried again. When the last attempt failed for a reason of the feed (a
// CS_... code), the feed's next automatic capture is delayed (P8-C4) and the
// workflow still fails with that failure. Any other failure (the database, a
// timeout, a lost worker) changes nothing of the feed: it stays due.
//
// Each capture run has one record (P8-O1), named by its run id: the capture
// activity begins it when it starts reading the feed and ends it with a
// success. After a failure the workflow ends it, once the failure was
// recorded: source_failed with the CS_ code, or infrastructure_failed. A
// cancelled run ends nothing.

// How often the scan looks for due feeds (P8-C4). The shortest interval is an
// hour, so an hourly feed starts 60 to 70 minutes after its last capture,
// plus any wait in the capture queue: about the hour the scan kept before
// intervals. Sooner would only add scans, later would push hourly feeds
// toward two hours. A fixed value: a workflow reads no configuration
const SCAN_CADENCE = '10 minutes';

const { listContentStudioFeedsForCapture } =
  proxyActivities<ContentStudioSourceActivity>({
    startToCloseTimeout: '2 minute',
    taskQueue: 'main',
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '1 minute',
    },
  });

// a capture reads one feed and at most 25 pages, 5 at a time, each within
// its own fetch deadline. It runs on the capture queue (P8-C2), whose Worker
// runs a bounded number at once: the others wait there, with no deadline to
// start and no attempt used, and the workflows themselves stay on `main`
const { captureContentStudioFeed } =
  proxyActivities<ContentStudioSourceActivity>({
    startToCloseTimeout: '10 minute',
    taskQueue: CONTENT_STUDIO_CAPTURE_TASK_QUEUE,
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '2 minutes',
    },
  });

// small database writes (P8-C4, P8-O1), on `main`: never behind captures
// waiting in the capture queue
const {
  recordContentStudioFeedCaptureFailure,
  finishContentStudioFeedCaptureAttempt,
} = proxyActivities<ContentStudioSourceActivity>({
  startToCloseTimeout: '1 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '1 minute',
  },
});

export async function contentStudioFeedCaptureWorkflowV1(input: {
  organizationId: string;
  sourceId: string;
}) {
  try {
    return await captureContentStudioFeed({
      organizationId: input.organizationId,
      sourceId: input.sourceId,
    });
  } catch (err) {
    if (!(err instanceof ActivityFailure) || isCancellation(err)) {
      throw err;
    }
    // the feed's own failure, its attempts used up: delayed once per capture.
    // If that write itself fails, its failure is the workflow's
    const code =
      err.cause instanceof ApplicationFailure &&
      typeof err.cause.type === 'string' &&
      err.cause.type.startsWith('CS_')
        ? err.cause.type
        : null;
    if (code) {
      await recordContentStudioFeedCaptureFailure({
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        code,
      });
    }
    // then the run's record ends, with the schedule the failure left. If
    // that write fails, its failure is the workflow's too
    await finishContentStudioFeedCaptureAttempt({
      organizationId: input.organizationId,
      sourceId: input.sourceId,
      attemptId: workflowInfo().runId,
      status: code ? 'source_failed' : 'infrastructure_failed',
      code,
    });
    throw err;
  }
}

export async function contentStudioFeedScanWorkflowV1(
  input: { afterId?: string | null } = {}
): Promise<void> {
  let page;
  try {
    page = await listContentStudioFeedsForCapture({
      afterId: input.afterId ?? null,
    });
  } catch (err) {
    // the list failed every attempt (the database): this page again later
    if (!(err instanceof ActivityFailure)) {
      throw err;
    }
    await sleep(SCAN_CADENCE);
    return continueAsNew<typeof contentStudioFeedScanWorkflowV1>({
      afterId: input.afterId ?? null,
    });
  }
  const { feeds, next } = page;
  for (const feed of feeds) {
    try {
      await startChild(contentStudioFeedCaptureWorkflowV1, {
        workflowId: `content-studio-feed-capture-${feed.sourceId}`,
        taskQueue: 'main',
        parentClosePolicy: 'ABANDON',
        args: [
          { organizationId: feed.organizationId, sourceId: feed.sourceId },
        ],
      });
    } catch (err) {
      // the feed's capture from an earlier scan is still running
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        throw err;
      }
    }
  }
  if (next) {
    return continueAsNew<typeof contentStudioFeedScanWorkflowV1>({
      afterId: next,
    });
  }
  await sleep(SCAN_CADENCE);
  return continueAsNew<typeof contentStudioFeedScanWorkflowV1>({});
}
