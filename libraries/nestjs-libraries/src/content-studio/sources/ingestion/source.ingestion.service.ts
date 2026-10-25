import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import {
  safeFetch,
  SafeFetchError,
  SafeFetchErrorCategory,
  SafeFetchResult,
} from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import {
  ContentStudioSourceRepository,
  ContentStudioSourceValidatorUpdate,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import {
  toPublicContentStudioSource,
  toPublicContentStudioSourceVersion,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import {
  ContentStudioSourceExtractionError,
  extractContentStudioSource,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.extract';
import { ContentStudioSourceContentError } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import {
  ContentStudioSourceVersionError,
  parseContentStudioSourceVersionInput,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { ContentStudioSourceUrlError } from '@gitroom/nestjs-libraries/content-studio/sources/source.url';
import {
  classifyContentStudioSourceCaptureTransition,
  isContentStudioSourcePageChange,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import {
  CONTENT_STUDIO_FEED_CAPTURE_ERROR_CODE,
  CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
  CONTENT_STUDIO_SOURCE_NAME_MAX,
  ContentStudioFeedCaptureSummary,
  ContentStudioFeedCaptureTrigger,
  contentStudioSourceLimits,
  effectiveFeedIntervalMinutes,
  nextCaptureAfterSuccess,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  ContentStudioSourceFeed,
  ContentStudioSourceFeedEntry,
  ContentStudioSourceFeedError,
  parseContentStudioSourceFeed,
  SOURCE_FEED_MEDIA_TYPES,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.feed';

// The one place Content Studio fetches a source, and only through safeFetch:
// it refuses private, loopback, link-local and reserved destinations, checks
// every redirect hop again, allows https only and caps time and size. Nothing
// here resolves names or follows redirects, and the only headers it sends are
// the two conditional ones (P8-G1, fetchSource). Fixed limits, never
// configuration. Two limits belong to SafeFetch's production
// policy and are deliberately not widened here (createSafeFetch is not used):
// - an http:// source is a valid source URL but is refused when refreshed
// - at most 5 redirects; safeFetch takes no per-request redirect limit
export const SOURCE_FETCH_MAX_BYTES = 2_097_152;
export const SOURCE_FETCH_TIMEOUT_MS = 15_000;
export const SOURCE_FETCH_ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
];
// A feed (P8-01) is fetched the same way, with its own XML types and a larger
// cap (feeds can carry whole articles), still far below SafeFetch's ceiling.
// No text/plain, octet-stream or HTML: only what declares itself XML
export const FEED_FETCH_MAX_BYTES = 5_242_880;
export const FEED_FETCH_TIMEOUT_MS = 15_000;
export const FEED_FETCH_ALLOWED_CONTENT_TYPES = [...SOURCE_FEED_MEDIA_TYPES];
// The pages of one feed capture are captured this many at a time
export const FEED_CAPTURE_CONCURRENCY = 5;
// Feeds handed to the schedule per scan page. A feed is due by its
// nextCaptureAt alone (P8-C4): its interval after a capture, a failure delay
// after a failed one
export const FEED_SCAN_PAGE_SIZE = 200;
// A scheduled capture that failed for a reason of the feed (P8-C4), after its
// own attempts, is next tried this long after the failure: an hour, doubled
// by each failure in a row, a day at most (the longest interval), whatever
// the feed's interval. A success ends it
export const FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES = 60;
export const FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES = 1440;

// The delay after the `failures`-th failure in a row (1 or more): 60, 120,
// 240, 480, 960, then 1440 minutes
export const captureFailureDelayMinutes = (failures: number) => {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new RangeError('A failure delay needs one failure or more.');
  }
  return Math.min(
    FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES * 2 ** (failures - 1),
    FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES
  );
};

// The earliest automatic capture after the `failures`-th failure in a row
export const nextCaptureAfterFailure = (failedAt: Date, failures: number) =>
  new Date(
    failedAt.getTime() + captureFailureDelayMinutes(failures) * 60 * 1000
  );

// HTTP validators (P8-G1): a source's ETag and Last-Modified, sent back so the
// server can answer 304 Not Modified when its representation did not change.
// They come from the server, so one is kept, and sent, only when it is safe
// as a header value: printable ASCII (spaces inside only), so no CR, LF, NUL
// or other control character, not empty, and short: an ETag at most
// SafeFetch's own cap on a request header, a Last-Modified far above an HTTP
// date (29 characters). Exactly as the server sent it: a weak W/"..." ETag
// stays weak and quoted, a date is not parsed or rewritten (a server ignores
// an If-Modified-Since it cannot read). Anything else is not used
export const SOURCE_ETAG_MAX_LENGTH = 1024;
export const SOURCE_LAST_MODIFIED_MAX_LENGTH = 256;
const HEADER_VALUE = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

export const usableSourceValidator = (value: unknown, maxLength: number) =>
  typeof value === 'string' &&
  value.length <= maxLength &&
  HEADER_VALUE.test(value)
    ? value
    : null;

interface SourceValidators {
  etag: string | null;
  lastModified: string | null;
}

// What a capture sends: the stored validators that are still usable, each
// one on its own. None: an ordinary request
const storedValidators = (row: {
  httpEtag: string | null;
  httpLastModified: string | null;
}): SourceValidators => ({
  etag: usableSourceValidator(row.httpEtag, SOURCE_ETAG_MAX_LENGTH),
  lastModified: usableSourceValidator(
    row.httpLastModified,
    SOURCE_LAST_MODIFIED_MAX_LENGTH
  ),
});

const NO_VALIDATORS: SourceValidators = { etag: null, lastModified: null };

// The validators of an answer, as the server sent them (Headers already
// joins a repeated header), or null when absent or not usable
const answerValidators = (fetched: SafeFetchResult): SourceValidators => ({
  etag: usableSourceValidator(fetched.headers.etag, SOURCE_ETAG_MAX_LENGTH),
  lastModified: usableSourceValidator(
    fetched.headers.lastModified,
    SOURCE_LAST_MODIFIED_MAX_LENGTH
  ),
});

// Only If-None-Match and If-Modified-Since, only for a validator there is
export const conditionalRequestHeaders = (
  validators: SourceValidators
): Record<string, string> => ({
  ...(validators.etag ? { 'If-None-Match': validators.etag } : {}),
  ...(validators.lastModified
    ? { 'If-Modified-Since': validators.lastModified }
    : {}),
});

// Fixed messages only: never the URL, a host, an address, the page or the
// SafeFetch error itself
const error = (status: number, code: string, msg: string) =>
  new HttpException({ msg, code }, status);
const notFound = () => error(404, 'CS_NOT_FOUND', 'Source not found.');
const sourceArchived = () =>
  error(409, 'CS_SOURCE_ARCHIVED', 'This source is archived.');
const kindUnsupported = () =>
  error(
    400,
    'CS_SOURCE_KIND_UNSUPPORTED',
    'This source type cannot be refreshed.'
  );
const integrityError = () =>
  error(
    500,
    'CS_SOURCE_INTEGRITY_ERROR',
    'Stored source data could not be verified.'
  );
const urlInvalid = () =>
  error(400, 'CS_SOURCE_URL_INVALID', 'The source URL is invalid.');
const fetchBlocked = () =>
  error(400, 'CS_SOURCE_FETCH_BLOCKED', 'The source URL cannot be fetched.');
const fetchTooLarge = () =>
  error(413, 'CS_SOURCE_FETCH_TOO_LARGE', 'The source response is too large.');
const contentTypeUnsupported = () =>
  error(
    415,
    'CS_SOURCE_CONTENT_TYPE_UNSUPPORTED',
    'The source content type is not supported.'
  );
const fetchTimeout = () =>
  error(504, 'CS_SOURCE_FETCH_TIMEOUT', 'The source did not respond in time.');
const fetchFailed = () =>
  error(502, 'CS_SOURCE_FETCH_FAILED', 'The source could not be fetched.');
const contentTooLarge = () =>
  error(413, 'CS_SOURCE_TOO_LARGE', 'The source content is too large.');
const contentInvalid = () =>
  error(
    422,
    'CS_SOURCE_CONTENT_INVALID',
    'The source content could not be processed.'
  );
const extractionFailed = () =>
  error(
    500,
    'CS_SOURCE_EXTRACTION_FAILED',
    'The source content could not be processed.'
  );
const versionConflict = () =>
  error(
    409,
    'CS_SOURCE_VERSION_CONFLICT',
    'The source changed. Reload it and try again.'
  );
// Not XML, a document type, not RSS or Atom: nothing of the feed is quoted
const feedInvalid = () =>
  error(422, 'CS_SOURCE_FEED_INVALID', 'The feed could not be read.');
const refreshTooSoon = () =>
  error(
    429,
    'CS_SOURCE_REFRESH_TOO_SOON',
    'This source was captured a moment ago. Try again in a few minutes.'
  );

// A member's refresh (P8-C1) comes at least the cooldown after the source's
// last capture, or is refused before anything is fetched. Exactly the
// cooldown is late enough; a source never captured is always due
const assertRefreshDue = (
  lastCaptureAt: Date | null | undefined,
  cooldownMs: number
) => {
  if (lastCaptureAt && Date.now() - lastCaptureAt.getTime() < cooldownMs) {
    throw refreshTooSoon();
  }
};

// One answer per thing the member can do about it: the address cannot be
// fetched (blocked, refused scheme or port, bad redirect), the page is too
// big, of an unsupported type, too slow, or the fetch failed otherwise
const FETCH_ERRORS: Record<SafeFetchErrorCategory, () => HttpException> = {
  INVALID_URL: urlInvalid,
  INVALID_REQUEST: fetchFailed,
  BLOCKED_DESTINATION: fetchBlocked,
  UNSUPPORTED_SCHEME: fetchBlocked,
  UNSUPPORTED_PORT: fetchBlocked,
  DNS_FAILURE: fetchFailed,
  REDIRECT_INVALID: fetchBlocked,
  TOO_MANY_REDIRECTS: fetchBlocked,
  REDIRECT_LOOP: fetchBlocked,
  DOWNGRADE_BLOCKED: fetchBlocked,
  TIMEOUT: fetchTimeout,
  TOO_LARGE: fetchTooLarge,
  UNSUPPORTED_CONTENT_TYPE: contentTypeUnsupported,
  HTTP_STATUS: fetchFailed,
  NETWORK: fetchFailed,
};

const fromSafeFetchError = (err: unknown) =>
  err instanceof SafeFetchError &&
  Object.prototype.hasOwnProperty.call(FETCH_ERRORS, err.category)
    ? FETCH_ERRORS[err.category]()
    : fetchFailed();

// One fetch of a source's stored URL (P8-G1), conditional when validators are
// given: `not-modified` (304, no body: nothing to read, hash or extract) is
// only possible then, as SafeFetch refuses a 304 to an ordinary request.
// The answer has to come from the requested URL, or a redirect chain that
// starts there (SafeFetch checks every hop, with the same headers). What the
// answer would leave on the source is decided here and written only by the
// success it belongs to: a representation read replaces both validators, a
// 304 replaces only the usable ones it sent and keeps the others
type SourceFetch =
  | {
      status: 'not-modified';
      validators: ContentStudioSourceValidatorUpdate;
    }
  | {
      status: 'fetched';
      fetched: SafeFetchResult;
      validators: ContentStudioSourceValidatorUpdate;
    };

const fetchSource = async (
  url: string,
  request: {
    allowedContentTypes: string[];
    maxBytes: number;
    timeoutMs: number;
  },
  sent: SourceValidators
): Promise<SourceFetch> => {
  const headers = conditionalRequestHeaders(sent);
  const conditional = Object.keys(headers).length > 0;
  let fetched;
  try {
    fetched = await safeFetch(url, {
      method: 'GET',
      ...request,
      ...(conditional ? { headers } : {}),
    });
  } catch (err) {
    throw fromSafeFetchError(err);
  }
  // SafeFetch records each URL that redirected: the first is the requested
  // one, and without redirects the answer came from the requested URL
  if (
    fetched.redirects.length
      ? fetched.redirects[0].url !== fetched.requestedUrl
      : fetched.finalUrl !== fetched.requestedUrl
  ) {
    throw fetchFailed();
  }
  const answered = answerValidators(fetched);
  if (fetched.status === 304) {
    if (!conditional) {
      throw fetchFailed();
    }
    return {
      status: 'not-modified',
      validators: {
        mode: 'merge',
        ...(answered.etag ? { etag: answered.etag } : {}),
        ...(answered.lastModified
          ? { lastModified: answered.lastModified }
          : {}),
      },
    };
  }
  return {
    status: 'fetched',
    fetched,
    validators: { mode: 'replace', ...answered },
  };
};

// The validators a source has after an update, to write only a change
const afterValidatorUpdate = (
  stored: SourceValidators,
  update: ContentStudioSourceValidatorUpdate
): SourceValidators =>
  update.mode === 'replace'
    ? { etag: update.etag, lastModified: update.lastModified }
    : {
        etag: update.etag ?? stored.etag,
        lastModified: update.lastModified ?? stored.lastModified,
      };

// Source and version ids are Prisma uuid() values; anything else cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface SourceRow {
  id: string;
  kind: string;
  name: string;
  canonicalUrl: string | null;
  latestVersionNumber: number;
  archivedAt: Date | null;
}

// A page as a feed capture reads it (P8-G1): with its stored validators,
// and its updatedAt, which writing them keeps
interface PageRow extends SourceRow {
  updatedAt: Date;
  httpEtag: string | null;
  httpLastModified: string | null;
}

// A feed's own schedule setting (P8-C4), null for the default
interface FeedRow extends SourceRow {
  captureIntervalMinutes: number | null;
}

// The record of one feed capture (P8-O1): its id, what started it, who asked
// (a member's refresh only) and the highest try that started reading
interface FeedCaptureAttempt {
  id: string;
  trigger: ContentStudioFeedCaptureTrigger;
  requestedByUserId: string | null;
  attemptCount: number;
}

type FeedCaptureFailure =
  | { status: 'source_failed'; code: string }
  | { status: 'infrastructure_failed'; code: null };

// How a capture failed, as its record keeps it: a refusal of ours is the
// feed's (its CS_ code, the scheduled capture's generic one without), anything
// else the system's. Never the message
const feedCaptureFailure = (err: unknown): FeedCaptureFailure => {
  if (!(err instanceof HttpException)) {
    return { status: 'infrastructure_failed', code: null };
  }
  const code = (err.getResponse() as { code?: unknown } | undefined)?.code;
  return {
    status: 'source_failed',
    code:
      typeof code === 'string' &&
      CONTENT_STUDIO_FEED_CAPTURE_ERROR_CODE.test(code)
        ? code
        : 'CS_SOURCE_CAPTURE_FAILED',
  };
};

// A feed that answered 304 Not Modified (P8-G1): nothing of it was read
const NOT_MODIFIED_CAPTURE: ContentStudioFeedCaptureSummary = {
  entriesSeen: 0,
  entriesIgnored: 0,
  entriesSkipped: 0,
  entriesAccepted: 0,
  sourcesCreated: 0,
  versionsCreated: 0,
  unchanged: 0,
  failed: 0,
  archived: 0,
  entriesLimited: 0,
};

type EntryOutcome =
  | 'skipped'
  | 'limited'
  | 'versionCreated'
  | 'unchanged'
  | 'failed'
  | 'archived';

// The page source of a feed entry, or why it has none
type PageSource =
  | { source: PageRow; created: boolean }
  | 'skipped'
  | 'limited'
  | 'failed';

// The address of a source that is not a page (a feed) is no page
const pageOf = (source: PageRow, created: boolean): PageSource =>
  source.kind === 'url' ? { source, created } : 'skipped';

// `items` run through `work` at most `limit` at a time; the results keep the
// order of the items. The first error stops new work and is thrown once the
// running ones end
const inBatches = async <T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
) => {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async () => {
    while (!failure && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        failure = failure ?? { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane)
  );
  if (failure) {
    throw (failure as { error: unknown }).error;
  }
  return results;
};

// The name a page found in a feed starts with: the entry's title, else its
// host. The organization may rename it; a capture never does
const discoveredSourceName = (entry: ContentStudioSourceFeedEntry) =>
  entry.title ??
  new URL(entry.url).hostname.slice(0, CONTENT_STUDIO_SOURCE_NAME_MAX);

// Ingestion: the only code that fetches a source and the only one that adds
// versions. Any member may refresh; the organization and the user come from
// the request, the URL from the stored source only. Nothing is retried here
// (a scheduled capture may be retried by its workflow).
//
// A `url` source: its stored URL is fetched once and the capture appended as
// its next immutable version. A failed fetch or a page that cannot be
// processed adds no version. Two refreshes of the same version both fetch,
// but only one is stored: the other gets a conflict, since one request is
// one capture.
//
// A `feed` source (P8-01): its stored URL is fetched once, as XML, and read
// (source.feed.ts). Each page its first entries link to becomes (or is) an
// ordinary `url` source of the organization, found by its canonical URL, so
// a page listed by several feeds is one source; the sighting is recorded as
// a discovery of this feed, and the page is captured like a refresh, except
// that a capture equal to the page's current version (same blocks, title and
// extraction) adds no version. A page that cannot be captured is counted and
// left for the next capture; the others are kept. The feed gets no version
@Injectable()
export class ContentStudioSourceIngestionService {
  constructor(
    private _contentStudioSourceRepository: ContentStudioSourceRepository,
    private _contentStudioSourceDiscoveryRepository: ContentStudioSourceDiscoveryRepository,
    private _contentStudioSourceCaptureAttemptRepository: ContentStudioSourceCaptureAttemptRepository
  ) {}

  async refreshSource(input: {
    organizationId: string;
    userId: string;
    sourceId: string;
  }) {
    if (typeof input.sourceId !== 'string' || !UUID.test(input.sourceId)) {
      throw notFound();
    }
    const source =
      await this._contentStudioSourceRepository.getSourceForOrganization(
        input.organizationId,
        input.sourceId
      );
    if (!source) {
      throw notFound();
    }
    if (source.archivedAt) {
      throw sourceArchived();
    }
    const { manualRefreshCooldownMs } = contentStudioSourceLimits(
      input.organizationId
    );
    switch (source.kind) {
      case 'url':
        break;
      case 'feed':
        // its last read. A paused feed too (P8-C3): pausing stops only the
        // schedule, and the refresh leaves it paused
        assertRefreshDue(source.lastCapturedAt, manualRefreshCooldownMs);
        return this.refreshFeed(input.organizationId, source, input.userId);
      default:
        throw kindUnsupported();
    }
    // a page's last capture is its current version
    if (source.latestVersionNumber > 0) {
      const latest =
        await this._contentStudioSourceRepository.getVersionByNumber(
          input.organizationId,
          source.id,
          source.latestVersionNumber
        );
      if (!latest) {
        throw integrityError();
      }
      assertRefreshDue(latest.fetchedAt, manualRefreshCooldownMs);
    }

    const result = await this.captureUrl(
      input.organizationId,
      source,
      input.userId,
      'always'
    );
    const current =
      await this._contentStudioSourceRepository.getSourceForOrganization(
        input.organizationId,
        source.id
      );
    if (!current) {
      throw integrityError();
    }
    return {
      source: toPublicContentStudioSource(current),
      version: toPublicContentStudioSourceVersion(result.version),
    };
  }

  // For the feed capture schedule only (no route reaches it): the live feeds
  // due for a capture, one page at a time. `next` is where the following
  // page starts, null after the last one
  async listFeedsDueForCapture(input: { afterId: string | null }) {
    const rows =
      await this._contentStudioSourceRepository.listFeedsDueForCapture({
        dueAt: new Date(),
        afterId:
          typeof input.afterId === 'string' && UUID.test(input.afterId)
            ? input.afterId
            : null,
        take: FEED_SCAN_PAGE_SIZE,
      });
    return {
      feeds: rows.map((row) => ({
        organizationId: row.organizationId,
        sourceId: row.id,
      })),
      next:
        rows.length === FEED_SCAN_PAGE_SIZE ? rows[rows.length - 1].id : null,
    };
  }

  // For the feed capture schedule only: one feed, read from the database
  // right before its capture, so only the stored URL of a live feed of that
  // organization is ever fetched. Anything else (gone, archived, paused
  // (P8-C3), another kind) is skipped, never an error to retry, and left as
  // it is, with no record (P8-O1). The captures are recorded in the name of
  // the member who created the feed. `attemptId` is the capture workflow's
  // run id and `attemptCount` this try, both from Temporal (the activity's
  // own context): every try of one scheduled capture keeps one record
  async captureScheduledFeed(input: {
    organizationId: string;
    sourceId: string;
    attemptId: string;
    attemptCount: number;
  }) {
    if (
      typeof input.organizationId !== 'string' ||
      typeof input.sourceId !== 'string' ||
      !UUID.test(input.sourceId)
    ) {
      return { status: 'skipped' as const };
    }
    const source =
      await this._contentStudioSourceRepository.getSourceForCapture(
        input.organizationId,
        input.sourceId
      );
    if (
      !source ||
      source.archivedAt ||
      source.scanPausedAt ||
      source.kind !== 'feed'
    ) {
      return { status: 'skipped' as const };
    }
    const { capture } = await this.captureFeed(
      input.organizationId,
      source,
      source.createdById,
      {
        id: input.attemptId,
        trigger: 'scheduled',
        requestedByUserId: null,
        attemptCount: input.attemptCount,
      }
    );
    return { status: 'captured' as const, capture };
  }

  // For the feed capture schedule only: a scheduled capture of a live feed
  // that failed for a reason of the feed, after its own attempts (P8-C4).
  // Ids from the workflow; the feed is read here, once, and the write is
  // decided on that read: a feed gone, archived or of another kind is
  // skipped, and a write that finds the feed changed meanwhile (a retry of
  // this one, a concurrent one, a member's successful refresh) changes
  // nothing and is not tried again. A paused feed is recorded: the pause
  // keeps it out of the scan either way. `code` is the failure's fixed code
  // (CS_...): the capture's record keeps it (finishScheduledFeedCapture,
  // P8-O1), this write does not
  async recordScheduledFeedFailure(input: {
    organizationId: string;
    sourceId: string;
    code: string;
  }) {
    if (
      typeof input.organizationId !== 'string' ||
      typeof input.sourceId !== 'string' ||
      !UUID.test(input.sourceId)
    ) {
      return { status: 'skipped' as const };
    }
    const source =
      await this._contentStudioSourceRepository.getSourceForCapture(
        input.organizationId,
        input.sourceId
      );
    if (!source || source.archivedAt || source.kind !== 'feed') {
      return { status: 'skipped' as const };
    }
    // one time for the failure and its delay
    const failedAt = new Date();
    const nextCaptureAt = nextCaptureAfterFailure(
      failedAt,
      source.consecutiveCaptureFailures + 1
    );
    const { count } =
      await this._contentStudioSourceRepository.recordFeedCaptureFailure({
        organizationId: input.organizationId,
        id: source.id,
        expectedFailures: source.consecutiveCaptureFailures,
        failedAt,
        nextCaptureAt,
      });
    return {
      status: count === 1 ? ('recorded' as const) : ('unchanged' as const),
    };
  }

  // For the feed capture schedule only: the end of a scheduled capture that
  // failed after its tries (P8-O1), once its failure was recorded: the
  // feed's (source_failed, its CS_ code) or the system's
  // (infrastructure_failed, no code). The record ends once, with the feed's
  // schedule as it is now; a record that has ended, or none (the capture
  // never read the feed), stays as it is. Anything else is skipped
  async finishScheduledFeedCapture(input: {
    organizationId: string;
    sourceId: string;
    attemptId: string;
    status: string;
    code: string | null;
  }) {
    if (
      typeof input.organizationId !== 'string' ||
      typeof input.sourceId !== 'string' ||
      !UUID.test(input.sourceId) ||
      typeof input.attemptId !== 'string' ||
      !UUID.test(input.attemptId)
    ) {
      return { status: 'skipped' as const };
    }
    let failure: FeedCaptureFailure;
    if (
      input.status === 'source_failed' &&
      typeof input.code === 'string' &&
      CONTENT_STUDIO_FEED_CAPTURE_ERROR_CODE.test(input.code)
    ) {
      failure = { status: 'source_failed', code: input.code };
    } else if (
      input.status === 'infrastructure_failed' &&
      input.code === null
    ) {
      failure = { status: 'infrastructure_failed', code: null };
    } else {
      return { status: 'skipped' as const };
    }
    return {
      status: await this.finishFeedCapture(
        input.organizationId,
        input.sourceId,
        input.attemptId,
        failure
      ),
    };
  }

  // One capture of a page source. `always` appends every capture, as a
  // refresh does; `if-changed` (feed captures) adds no version when the page
  // gives exactly what its current version holds, and treats a version that
  // another capture appended meanwhile as that capture. Both compare the
  // capture with the current version by blocks hash, title and extraction
  // only (never the blocks themselves), and a change of the page is kept on
  // the source in the same append (P8-04B1).
  //
  // HTTP validators (P8-G1): `if-changed` asks conditionally with the page's
  // stored validators, once it has a version. A 304 is the current version
  // again (`not-modified`): nothing is read, extracted or stored but the
  // validators. `always` never asks conditionally, so a member's refresh
  // always reads the page and appends it, as before. A new version brings
  // the validators of its own answer; a page found as its current version
  // keeps them only from the state the capture started from
  // (markPageUnchanged)
  private async captureUrl(
    organizationId: string,
    source: SourceRow,
    userId: string,
    mode: 'always'
  ): Promise<{
    status: 'created';
    version: Parameters<typeof toPublicContentStudioSourceVersion>[0];
  }>;
  private async captureUrl(
    organizationId: string,
    source: PageRow,
    userId: string,
    mode: 'if-changed'
  ): Promise<
    | {
        status: 'created';
        version: Parameters<typeof toPublicContentStudioSourceVersion>[0];
      }
    | { status: 'unchanged' }
    | { status: 'not-modified' }
  >;
  private async captureUrl(
    organizationId: string,
    source: SourceRow | PageRow,
    userId: string,
    mode: 'always' | 'if-changed'
  ) {
    if (!source.canonicalUrl) {
      throw integrityError();
    }
    // the version this capture follows, read before the fetch
    const expectedLatestVersionNumber = source.latestVersionNumber;
    // the validators it sends, of that version's page: only a feed capture
    // of a page that has one
    const page =
      mode === 'if-changed' && expectedLatestVersionNumber > 0
        ? (source as PageRow)
        : null;
    const sent = page ? storedValidators(page) : NO_VALIDATORS;

    const answer = await fetchSource(
      source.canonicalUrl,
      {
        allowedContentTypes: SOURCE_FETCH_ALLOWED_CONTENT_TYPES,
        maxBytes: SOURCE_FETCH_MAX_BYTES,
        timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
      },
      sent
    );
    if (answer.status === 'not-modified') {
      await this.keepPageValidators(organizationId, page!, answer.validators);
      return { status: 'not-modified' as const };
    }
    const { fetched } = answer;
    const fetchedAt = new Date();
    // the exact bytes SafeFetch returned (after HTTP content encoding is
    // undone), before anything is extracted from them
    const sourceHash = createHash('sha256').update(fetched.body).digest('hex');

    let extracted;
    try {
      extracted = extractContentStudioSource({
        contentType: fetched.headers.contentType,
        body: fetched.body,
      });
    } catch (err) {
      if (!(err instanceof ContentStudioSourceExtractionError)) {
        throw extractionFailed();
      }
      // a type or charset that is not read, or bytes that do not decode in
      // their charset or nest too deeply
      throw err.code === 'UNSUPPORTED_MEDIA_TYPE' ||
        err.code === 'UNSUPPORTED_CHARSET'
        ? contentTypeUnsupported()
        : contentInvalid();
    }

    let version;
    try {
      version = parseContentStudioSourceVersionInput({
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl,
        redirectCount: fetched.redirects.length,
        fetchedAt,
        httpStatus: fetched.status,
        // the media type only, no charset or other parameter
        contentType: extracted.mediaType,
        // what was read, not what the server announced
        contentLength: fetched.bytesRead,
        title: extracted.title,
        sourceHash,
        extractionVersion: CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
        content: extracted.content,
      });
    } catch (err) {
      if (
        err instanceof ContentStudioSourceContentError &&
        (err.code === 'TOO_LARGE' ||
          (err.issues || []).some((issue) => issue.code === 'too_big'))
      ) {
        throw contentTooLarge();
      }
      if (
        err instanceof ContentStudioSourceContentError ||
        err instanceof ContentStudioSourceVersionError ||
        err instanceof ContentStudioSourceUrlError
      ) {
        throw contentInvalid();
      }
      throw err;
    }

    // the version this capture follows: the one it is a repeat or a change
    // of (P8-04B1), none for a first capture
    const previous =
      expectedLatestVersionNumber > 0
        ? await this._contentStudioSourceRepository.getVersionByNumber(
            organizationId,
            source.id,
            expectedLatestVersionNumber
          )
        : null;
    if (expectedLatestVersionNumber > 0 && !previous) {
      throw integrityError();
    }
    // the one rule of captures, the one change detection uses
    const transition = classifyContentStudioSourceCaptureTransition(
      previous,
      version
    );
    if (mode === 'if-changed' && transition === 'repeat') {
      if (page) {
        await this.keepPageValidators(organizationId, page, answer.validators);
      }
      return { status: 'unchanged' as const };
    }
    // a change of the page itself becomes the source's last page change,
    // with the version; a first capture, a repeat or another extraction
    // version leaves the last one as it is
    const pageChange =
      previous && isContentStudioSourcePageChange(transition)
        ? {
            at: version.fetchedAt,
            versionNumber: expectedLatestVersionNumber + 1,
            kind: transition,
            previousCaptureAt: previous.fetchedAt,
          }
        : null;

    let result;
    try {
      result =
        await this._contentStudioSourceRepository.appendVersionWithCompareAndSwap(
          {
            organizationId,
            sourceId: source.id,
            expectedLatestVersionNumber,
            versionId: randomUUID(),
            version,
            createdById: userId,
            pageChange,
            validators: answer.validators,
          }
        );
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      result = { status: 'changed' as const };
    }

    switch (result.status) {
      case 'created':
        return { status: 'created' as const, version: result.version };
      case 'not-found':
        throw notFound();
      case 'archived':
        throw sourceArchived();
      default:
        // another capture of the same page went first: for a feed capture
        // that capture is this one's result
        if (mode === 'if-changed') {
          return { status: 'unchanged' as const };
        }
        throw versionConflict();
    }
  }

  // The validators of a page that a feed capture found as its current version
  // (P8-G1), written only when they change, and only from the page as it
  // was read before the fetch: if the page changed meanwhile (a version, a
  // rename, an archive, or validators another capture wrote first), they
  // stay as they are
  private async keepPageValidators(
    organizationId: string,
    page: PageRow,
    validators: ContentStudioSourceValidatorUpdate
  ) {
    const stored = {
      etag: page.httpEtag ?? null,
      lastModified: page.httpLastModified ?? null,
    };
    const after = afterValidatorUpdate(stored, validators);
    if (
      after.etag === stored.etag &&
      after.lastModified === stored.lastModified
    ) {
      return;
    }
    await this._contentStudioSourceRepository.markPageUnchanged({
      organizationId,
      id: page.id,
      expected: {
        latestVersionNumber: page.latestVersionNumber,
        updatedAt: page.updatedAt,
        httpEtag: stored.etag,
        httpLastModified: stored.lastModified,
      },
      validators,
    });
  }

  // A member's refresh of a feed (P8-O1): one recorded capture, ended here
  // whatever happens. A failure changes nothing of the feed's schedule
  // (P8-C4) and is answered as before; if its record cannot be ended, that
  // error is the answer
  private async refreshFeed(
    organizationId: string,
    feed: FeedRow,
    userId: string
  ) {
    const attemptId = randomUUID();
    try {
      return await this.captureFeed(organizationId, feed, userId, {
        id: attemptId,
        trigger: 'manual',
        requestedByUserId: userId,
        attemptCount: 1,
      });
    } catch (err) {
      await this.finishFeedCapture(
        organizationId,
        feed.id,
        attemptId,
        feedCaptureFailure(err)
      );
      throw err;
    }
  }

  // The end of a failed capture's record, with the feed's schedule as it is
  // now: after the failure was recorded (P8-C4), or as another capture left
  // it. `unchanged`: the record had ended already, or there is none
  private async finishFeedCapture(
    organizationId: string,
    sourceId: string,
    attemptId: string,
    failure: FeedCaptureFailure
  ) {
    const feed =
      await this._contentStudioSourceRepository.getSourceForOrganization(
        organizationId,
        sourceId
      );
    if (!feed) {
      return 'unchanged' as const;
    }
    const { count } =
      await this._contentStudioSourceCaptureAttemptRepository.finishFeedCaptureAttempt(
        {
          id: attemptId,
          organizationId,
          sourceId,
          status: failure.status,
          errorCode: failure.code,
          finishedAt: new Date(),
          nextCaptureAtAfter: feed.nextCaptureAt,
          consecutiveFailuresAfter: feed.consecutiveCaptureFailures,
        }
      );
    return count === 1 ? ('finished' as const) : ('unchanged' as const);
  }

  // One capture of a live feed source of the organization (see the class),
  // recorded from here on (P8-O1). A success, by a member or the schedule,
  // schedules the feed's next automatic capture from this capture's own time
  // and ends its failures (P8-C4), and ends its record with its counts, in
  // one transaction; a failure changes nothing here. A try of a scheduled
  // capture whose record has ended (its success was written, its answer
  // lost) captures again, and its record stays as it was.
  //
  // The feed is asked conditionally with its stored validators (P8-G1),
  // whoever started the capture. A 304 Not Modified is a success like any
  // other (schedule, failures, record), with nothing read: no entry, page,
  // discovery or version, every count 0. The validators are written only
  // with that success, so a feed that could not be read or processed keeps
  // the ones it had and is read in full next time
  private async captureFeed(
    organizationId: string,
    feed: FeedRow,
    userId: string,
    attempt: FeedCaptureAttempt
  ) {
    const begun =
      await this._contentStudioSourceCaptureAttemptRepository.beginFeedCaptureAttempt(
        {
          id: attempt.id,
          organizationId,
          sourceId: feed.id,
          trigger: attempt.trigger,
          requestedByUserId: attempt.requestedByUserId,
          startedAt: new Date(),
          attemptCount: attempt.attemptCount,
        }
      );
    if (begun.status === 'mismatch') {
      throw integrityError();
    }
    // a stored interval that is no preset is never used as it is
    const intervalMinutes = effectiveFeedIntervalMinutes(
      feed.captureIntervalMinutes
    );
    if (!feed.canonicalUrl || intervalMinutes === undefined) {
      throw integrityError();
    }
    const stored = await this._contentStudioSourceRepository.getFeedValidators(
      organizationId,
      feed.id
    );
    const answer = await fetchSource(
      feed.canonicalUrl,
      {
        allowedContentTypes: FEED_FETCH_ALLOWED_CONTENT_TYPES,
        maxBytes: FEED_FETCH_MAX_BYTES,
        timeoutMs: FEED_FETCH_TIMEOUT_MS,
      },
      stored ? storedValidators(stored) : NO_VALIDATORS
    );
    // the time of this capture: every page it lists was seen then
    const capturedAt = new Date();
    if (answer.status === 'not-modified') {
      return this.feedCaptured(
        organizationId,
        feed.id,
        capturedAt,
        intervalMinutes,
        answer.validators,
        attempt,
        NOT_MODIFIED_CAPTURE,
        true
      );
    }
    const { fetched } = answer;

    let parsed: ContentStudioSourceFeed;
    try {
      parsed = parseContentStudioSourceFeed({
        contentType: fetched.headers.contentType,
        body: fetched.body,
      });
    } catch (err) {
      if (!(err instanceof ContentStudioSourceFeedError)) {
        throw feedInvalid();
      }
      throw err.code === 'UNSUPPORTED_MEDIA_TYPE' ||
        err.code === 'UNSUPPORTED_CHARSET'
        ? contentTypeUnsupported()
        : feedInvalid();
    }

    const pages = await this.pageSources(
      organizationId,
      parsed.entries,
      userId
    );
    const outcomes = await inBatches(
      parsed.entries.map((entry, index) => ({ entry, page: pages[index] })),
      FEED_CAPTURE_CONCURRENCY,
      ({ entry, page }) =>
        this.captureFeedEntry(
          organizationId,
          feed.id,
          entry,
          page,
          userId,
          capturedAt
        )
    );
    const count = (outcome: EntryOutcome) =>
      outcomes.filter((item) => item.outcome === outcome).length;
    const capture: ContentStudioFeedCaptureSummary = {
      entriesSeen: parsed.entriesSeen,
      entriesIgnored: parsed.entriesIgnored,
      entriesSkipped: parsed.entriesSkipped + count('skipped'),
      entriesAccepted: outcomes.length - count('skipped') - count('limited'),
      sourcesCreated: outcomes.filter((item) => item.created).length,
      versionsCreated: count('versionCreated'),
      unchanged: count('unchanged'),
      failed: count('failed'),
      archived: count('archived'),
      entriesLimited: count('limited'),
    };

    // pages that failed or were limited are counted: the feed was read
    return this.feedCaptured(
      organizationId,
      feed.id,
      capturedAt,
      intervalMinutes,
      answer.validators,
      attempt,
      capture,
      false
    );
  }

  // The success of a feed capture (see captureFeed), read or not modified
  private async feedCaptured(
    organizationId: string,
    feedId: string,
    capturedAt: Date,
    intervalMinutes: number,
    validators: ContentStudioSourceValidatorUpdate,
    attempt: FeedCaptureAttempt,
    capture: ContentStudioFeedCaptureSummary,
    notModified: boolean
  ) {
    await this._contentStudioSourceRepository.markFeedCaptured(
      organizationId,
      feedId,
      capturedAt,
      nextCaptureAfterSuccess(capturedAt, intervalMinutes),
      validators,
      { id: attempt.id, finishedAt: new Date(), summary: capture, notModified }
    );
    const current =
      await this._contentStudioSourceRepository.getSourceForOrganization(
        organizationId,
        feedId
      );
    if (!current) {
      throw integrityError();
    }
    return {
      source: toPublicContentStudioSource(current),
      capture,
      notModified,
    };
  }

  // One page of a feed, with its source (found or created): the discovery,
  // then its capture. A page that cannot be captured is a counted failure,
  // never the feed's: what was recorded stays. A new page past the
  // organization's limit is only counted, and the next entries go on
  private async captureFeedEntry(
    organizationId: string,
    feedSourceId: string,
    entry: ContentStudioSourceFeedEntry,
    page: PageSource,
    userId: string,
    capturedAt: Date
  ): Promise<{ outcome: EntryOutcome; created: boolean }> {
    if (typeof page === 'string') {
      return { outcome: page, created: false };
    }
    await this._contentStudioSourceDiscoveryRepository.recordDiscovery({
      organizationId,
      feedSourceId,
      discoveredSourceId: page.source.id,
      entryId: entry.entryId,
      entryTitle: entry.title,
      publishedAt: entry.publishedAt,
      seenAt: capturedAt,
    });
    if (page.source.archivedAt) {
      return { outcome: 'archived', created: page.created };
    }
    try {
      // a page that answered 304 Not Modified (P8-G1) is unchanged too
      const result = await this.captureUrl(
        organizationId,
        page.source,
        userId,
        'if-changed'
      );
      return {
        outcome: result.status === 'created' ? 'versionCreated' : 'unchanged',
        created: page.created,
      };
    } catch (err) {
      if (err instanceof HttpException) {
        return { outcome: 'failed', created: page.created };
      }
      throw err;
    }
  }

  // The organization's `url` sources of the entries' pages, in their order.
  // One canonical URL is one source: an existing one is used whatever the
  // limits, and so is one created meanwhile by another capture or a member,
  // never a second one. The address of a source of another kind is no page
  // (skipped). The new pages are created together (P8-C1), in one
  // transaction, so captures of the organization's feeds at the same time
  // abort each other's at most once each: in the feed's order, while the
  // organization is below its page source limit, the rest limited. When
  // that transaction lost every attempt to concurrent ones, the new pages
  // are left for the next capture (failed)
  private async pageSources(
    organizationId: string,
    entries: ContentStudioSourceFeedEntry[],
    userId: string
  ): Promise<PageSource[]> {
    const known: Array<PageRow | null> = [];
    for (const entry of entries) {
      known.push(
        await this._contentStudioSourceRepository.getSourceByCanonicalUrlForOrganization(
          organizationId,
          entry.url
        )
      );
    }
    const fresh = entries.filter((_, index) => !known[index]);
    const created = fresh.length
      ? await this.newPageSources(organizationId, fresh, userId)
      : [];
    let next = 0;
    return known.map((source) =>
      source ? pageOf(source, false) : created[next++]
    );
  }

  private async newPageSources(
    organizationId: string,
    entries: ContentStudioSourceFeedEntry[],
    userId: string
  ): Promise<PageSource[]> {
    let result;
    try {
      result =
        await this._contentStudioSourceRepository.createSourcesWithinLimit({
          organizationId,
          kind: 'url',
          createdById: userId,
          limit: contentStudioSourceLimits(organizationId).urlSourcesMax,
          sources: entries.map((entry) => ({
            id: randomUUID(),
            name: discoveredSourceName(entry),
            canonicalUrl: entry.url,
          })),
        });
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      // one of them was created meanwhile and nothing of this transaction
      // was kept: what exists now is used, the rest waits
      const pages: PageSource[] = [];
      for (const entry of entries) {
        const raced =
          await this._contentStudioSourceRepository.getSourceByCanonicalUrlForOrganization(
            organizationId,
            entry.url
          );
        pages.push(raced ? pageOf(raced, false) : 'failed');
      }
      return pages;
    }
    if (result.status === 'conflict') {
      return entries.map(() => 'failed' as const);
    }
    return result.results.map((item) => {
      switch (item.status) {
        case 'created':
          return { source: item.source, created: true };
        case 'exists':
          return pageOf(item.source, false);
        default:
          return 'limited';
      }
    });
  }
}
