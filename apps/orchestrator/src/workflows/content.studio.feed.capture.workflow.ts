import {
  continueAsNew,
  proxyActivities,
  sleep,
  startChild,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { ContentStudioSourceActivity } from '@gitroom/orchestrator/activities/content-studio.source.activity';
import { CONTENT_STUDIO_CAPTURE_TASK_QUEUE } from '@gitroom/nestjs-libraries/temporal/content.studio.capture.queue';

// Scheduled capture of Content Studio feed sources (P8-01).
//
// contentStudioFeedScanWorkflowV1 runs forever (one execution, started by
// the backend under RUN_CRON): it pages through the live feeds due for a
// capture, starts one contentStudioFeedCaptureWorkflowV1 per feed, and after
// the last page sleeps an hour. Every page continues as new, so its history
// stays small. A feed whose capture is still running keeps it: its workflow
// id is the feed's, so a second one is never started at the same time.
//
// contentStudioFeedCaptureWorkflowV1 captures one feed through the same
// ingestion service as the refresh route, by ids only. A capture that could
// not reach the feed is tried again (3 attempts in all); a refused one is not

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

export async function contentStudioFeedCaptureWorkflowV1(input: {
  organizationId: string;
  sourceId: string;
}) {
  return captureContentStudioFeed({
    organizationId: input.organizationId,
    sourceId: input.sourceId,
  });
}

export async function contentStudioFeedScanWorkflowV1(
  input: { afterId?: string | null } = {}
): Promise<void> {
  const { feeds, next } = await listContentStudioFeedsForCapture({
    afterId: input.afterId ?? null,
  });
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
  await sleep('1 hour');
  return continueAsNew<typeof contentStudioFeedScanWorkflowV1>({});
}
