import { HttpException, Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { activityInfo, ApplicationFailure } from '@temporalio/activity';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';

// Failures worth another attempt: the feed could not be reached or answered
// too slowly. Every other refusal (blocked address, not a feed, too large,
// wrong type, broken stored data) would fail the same way again
const RETRYABLE_CODES = ['CS_SOURCE_FETCH_FAILED', 'CS_SOURCE_FETCH_TIMEOUT'];

// Scheduled feed capture of Content Studio (P8-01). The activities only hand
// ids to the same ingestion service the refresh route uses: the feed is read
// from the database by id and organization right before its capture, and no
// URL, content or option comes from the workflow. Failures carry a fixed
// message and the error code only, never a URL, host or feed text
@Injectable()
@Activity()
export class ContentStudioSourceActivity {
  constructor(
    private _contentStudioSourceIngestionService: ContentStudioSourceIngestionService
  ) {}

  @ActivityMethod()
  async listContentStudioFeedsForCapture(input: { afterId: string | null }) {
    return this._contentStudioSourceIngestionService.listFeedsDueForCapture(
      input
    );
  }

  // One record per capture workflow run (P8-O1): its run id names the
  // record, and this try's number is its try count. Nothing more comes from
  // the workflow
  @ActivityMethod()
  async captureContentStudioFeed(input: {
    organizationId: string;
    sourceId: string;
  }) {
    const { workflowExecution, attempt } = activityInfo();
    try {
      return await this._contentStudioSourceIngestionService.captureScheduledFeed(
        {
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          attemptId: workflowExecution.runId,
          attemptCount: attempt,
        }
      );
    } catch (err) {
      if (!(err instanceof HttpException)) {
        throw err;
      }
      const code =
        (err.getResponse() as { code?: unknown } | undefined)?.code ?? null;
      const type = typeof code === 'string' ? code : 'CS_SOURCE_CAPTURE_FAILED';
      if (RETRYABLE_CODES.includes(type)) {
        throw ApplicationFailure.retryable(
          'The Content Studio feed could not be captured.',
          type
        );
      }
      throw ApplicationFailure.nonRetryable(
        'The Content Studio feed capture was refused.',
        type
      );
    }
  }

  // A capture that failed with one of the codes above, after its attempts
  // (P8-C4): the feed's next automatic capture is delayed. Ids and the code
  // only; a feed gone or changed meanwhile is an answer, not an error
  @ActivityMethod()
  async recordContentStudioFeedCaptureFailure(input: {
    organizationId: string;
    sourceId: string;
    code: string;
  }) {
    return this._contentStudioSourceIngestionService.recordScheduledFeedFailure(
      input
    );
  }

  // The end of a scheduled capture that failed after its tries (P8-O1), once
  // its failure was recorded: the capture workflow's run id, the outcome and
  // the CS_ code of a failure of the feed (null for one of the system).
  // Ended once; a record ended already or never begun is an answer
  @ActivityMethod()
  async finishContentStudioFeedCaptureAttempt(input: {
    organizationId: string;
    sourceId: string;
    attemptId: string;
    status: 'source_failed' | 'infrastructure_failed';
    code: string | null;
  }) {
    return this._contentStudioSourceIngestionService.finishScheduledFeedCapture(
      input
    );
  }
}
