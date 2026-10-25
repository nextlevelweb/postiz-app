import fs from 'fs';
import path from 'path';
import { HttpException } from '@nestjs/common';
import { activityInfo, ApplicationFailure } from '@temporalio/activity';
import { ContentStudioSourceActivity } from './content-studio.source.activity';
import type { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';

// The feed capture activities (P8-01): ids in, the shared ingestion service
// out, and every refusal turned into a Temporal failure that says whether
// another attempt can help
const ORG = '11111111-1111-4111-8111-111111111111';
const FEED = '33333333-3333-4333-8333-333333333333';
const MARKER = 'ACTIVITY_PRIVATE_URL_MARKER_123';
const RUN = '77777777-7777-4777-8777-777777777777';

// the Temporal context of a running activity (P8-O1): its workflow run and
// which try this is
jest.mock('@temporalio/activity', () => ({
  ...jest.requireActual('@temporalio/activity'),
  activityInfo: jest.fn(),
}));
const infoMock = jest.mocked(activityInfo);
beforeEach(() => {
  infoMock.mockReturnValue({
    workflowExecution: {
      workflowId: `content-studio-feed-capture-${FEED}`,
      runId: RUN,
    },
    attempt: 2,
  } as ReturnType<typeof activityInfo>);
});

const setup = () => {
  const ingestion = {
    listFeedsDueForCapture: jest.fn(),
    captureScheduledFeed: jest.fn(),
    recordScheduledFeedFailure: jest.fn(),
    finishScheduledFeedCapture: jest.fn(),
  };
  const activity = new ContentStudioSourceActivity(
    ingestion as unknown as ContentStudioSourceIngestionService
  );
  return { ingestion, activity };
};

const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApplicationFailure);
  return err as ApplicationFailure;
};

describe('ContentStudioSourceActivity', () => {
  it('TM5 lists and captures through the same ingestion service as the refresh route', async () => {
    const { ingestion, activity } = setup();
    ingestion.listFeedsDueForCapture.mockResolvedValue({
      feeds: [],
      next: null,
    });
    ingestion.captureScheduledFeed.mockResolvedValue({ status: 'skipped' });
    await expect(
      activity.listContentStudioFeedsForCapture({ afterId: null })
    ).resolves.toEqual({ feeds: [], next: null });
    await expect(
      activity.captureContentStudioFeed({ organizationId: ORG, sourceId: FEED })
    ).resolves.toEqual({ status: 'skipped' });
    expect(ingestion.listFeedsDueForCapture).toHaveBeenCalledWith({
      afterId: null,
    });
    expect(ingestion.captureScheduledFeed).toHaveBeenCalledWith({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: RUN,
      attemptCount: 2,
    });
  });

  it('P8O1 a capture names its record by its workflow run and counts this try; nothing else comes from the workflow', async () => {
    const { ingestion, activity } = setup();
    ingestion.captureScheduledFeed.mockResolvedValue({ status: 'skipped' });
    await activity.captureContentStudioFeed({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: 'from-the-workflow',
      attemptCount: 99,
    } as Parameters<typeof activity.captureContentStudioFeed>[0]);
    expect(ingestion.captureScheduledFeed).toHaveBeenCalledWith({
      organizationId: ORG,
      sourceId: FEED,
      attemptId: RUN,
      attemptCount: 2,
    });
  });

  it('P8O1 the end of a failed capture goes to the ingestion service as it is, and its answer comes back', async () => {
    const { ingestion, activity } = setup();
    ingestion.finishScheduledFeedCapture.mockResolvedValue({
      status: 'finished',
    });
    const input = {
      organizationId: ORG,
      sourceId: FEED,
      attemptId: RUN,
      status: 'source_failed' as const,
      code: 'CS_SOURCE_FETCH_FAILED',
    };
    await expect(
      activity.finishContentStudioFeedCaptureAttempt(input)
    ).resolves.toEqual({ status: 'finished' });
    expect(ingestion.finishScheduledFeedCapture).toHaveBeenCalledWith(input);
    expect(ingestion.recordScheduledFeedFailure).not.toHaveBeenCalled();
    expect(ingestion.captureScheduledFeed).not.toHaveBeenCalled();
  });

  it.each([
    ['CS_SOURCE_FETCH_FAILED', 502],
    ['CS_SOURCE_FETCH_TIMEOUT', 504],
  ])('TM6 %s may succeed later: a retryable failure', async (code, status) => {
    const { ingestion, activity } = setup();
    ingestion.captureScheduledFeed.mockRejectedValue(
      new HttpException({ msg: `fixed ${MARKER}`, code }, status)
    );
    const err = await failure(
      activity.captureContentStudioFeed({ organizationId: ORG, sourceId: FEED })
    );
    expect(err.nonRetryable).toBe(false);
    expect(err.type).toBe(code);
    expect(err.message).toBe('The Content Studio feed could not be captured.');
    // M21 an attempt never records a failure itself: the workflow does, once
    expect(ingestion.recordScheduledFeedFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['CS_SOURCE_FEED_INVALID', 422],
    ['CS_SOURCE_FETCH_BLOCKED', 400],
    ['CS_SOURCE_URL_INVALID', 400],
    ['CS_SOURCE_FETCH_TOO_LARGE', 413],
    ['CS_SOURCE_CONTENT_TYPE_UNSUPPORTED', 415],
    ['CS_SOURCE_INTEGRITY_ERROR', 500],
    ['CS_SOURCE_KIND_UNSUPPORTED', 400],
  ])(
    'TM4/TM7 %s fails the same way again: never retried',
    async (code, status) => {
      const { ingestion, activity } = setup();
      ingestion.captureScheduledFeed.mockRejectedValue(
        new HttpException({ msg: `fixed ${MARKER}`, code }, status)
      );
      const err = await failure(
        activity.captureContentStudioFeed({
          organizationId: ORG,
          sourceId: FEED,
        })
      );
      expect(err.nonRetryable).toBe(true);
      expect(err.type).toBe(code);
      expect(JSON.stringify(err)).not.toContain(MARKER);
      expect(err.message).not.toContain(MARKER);
    }
  );

  it('an error that is not a refusal (the database) is left to the retry policy as it is', async () => {
    const { ingestion, activity } = setup();
    const db = new Error('connection reset');
    ingestion.captureScheduledFeed.mockRejectedValue(db);
    await expect(
      activity.captureContentStudioFeed({ organizationId: ORG, sourceId: FEED })
    ).rejects.toBe(db);
  });

  it('a refusal without a code is still a fixed, non-retryable failure', async () => {
    const { ingestion, activity } = setup();
    ingestion.captureScheduledFeed.mockRejectedValue(
      new HttpException('plain', 400)
    );
    const err = await failure(
      activity.captureContentStudioFeed({ organizationId: ORG, sourceId: FEED })
    );
    expect([err.type, err.nonRetryable]).toEqual([
      'CS_SOURCE_CAPTURE_FAILED',
      true,
    ]);
  });

  // P8-C4: the failure record hands its ids and the code on as they are
  it('P8C4-7 records a failure through the same ingestion service, with the ids and the code', async () => {
    const { ingestion, activity } = setup();
    ingestion.recordScheduledFeedFailure.mockResolvedValue({
      status: 'recorded',
    });
    const input = {
      organizationId: ORG,
      sourceId: FEED,
      code: 'CS_SOURCE_FETCH_FAILED',
    };
    await expect(
      activity.recordContentStudioFeedCaptureFailure(input)
    ).resolves.toEqual({ status: 'recorded' });
    expect(ingestion.recordScheduledFeedFailure.mock.calls).toEqual([[input]]);
    expect(ingestion.captureScheduledFeed).not.toHaveBeenCalled();
  });

  it('a database error of the failure record is left to its retry policy', async () => {
    const { ingestion, activity } = setup();
    const db = new Error('connection reset');
    ingestion.recordScheduledFeedFailure.mockRejectedValue(db);
    await expect(
      activity.recordContentStudioFeedCaptureFailure({
        organizationId: ORG,
        sourceId: FEED,
        code: 'CS_SOURCE_FEED_INVALID',
      })
    ).rejects.toBe(db);
  });

  it('P801-1/P801-5 fetches nothing and uses no AI itself', () => {
    const text = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.source.activity.ts'),
        'utf8'
      )
      .replace(/^\s*\/\/.*$/gm, '');
    expect(text).not.toMatch(
      /safeFetch|\bfetch\(|axios|undici|rss-parser|PrismaRepository|prisma\.|AIExecution|openai|anthropic/i
    );
  });
});
