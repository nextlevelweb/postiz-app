import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import {
  safeFetch,
  SafeFetchError,
  SafeFetchErrorCategory,
} from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
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
  CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
  CONTENT_STUDIO_SOURCE_NAME_MAX,
  contentStudioSourceLimits,
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
// here resolves names, follows redirects or sends headers of its own. Fixed
// limits, never configuration. Two limits belong to SafeFetch's production
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
// A scheduled scan reads a feed again once it was not read for this long
// (an hourly scan, so a feed read by hand in between is not read twice)
export const FEED_CAPTURE_INTERVAL_MS = 50 * 60 * 1000;
// Feeds handed to the schedule per scan page
export const FEED_SCAN_PAGE_SIZE = 200;

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

// What one feed capture did, in counts only: never a URL, a title or a
// source id. entriesAccepted = versionsCreated + unchanged + failed + archived
export interface ContentStudioFeedCaptureSummary {
  // entries in the feed
  entriesSeen: number;
  // entries past the capture limit, not read
  entriesIgnored: number;
  // read, but no https page link, a page listed before, or the address of
  // a source that is not a page (a feed)
  entriesSkipped: number;
  // pages recorded as discovered by this feed (but for a new page whose
  // source lost every creation attempt to concurrent ones: failed)
  entriesAccepted: number;
  // page sources this capture created
  sourcesCreated: number;
  // pages captured as a new version (a new source's first one included)
  versionsCreated: number;
  // pages captured with nothing new: no version
  unchanged: number;
  // pages that could not be captured this time: no version
  failed: number;
  // pages whose source is archived: recorded, not captured
  archived: number;
  // new pages while the organization has its most page sources (P8-C1): no
  // source, not recorded, not fetched. Never a failure
  entriesLimited: number;
}

type EntryOutcome =
  | 'skipped'
  | 'limited'
  | 'versionCreated'
  | 'unchanged'
  | 'failed'
  | 'archived';

// The page source of a feed entry, or why it has none
type PageSource =
  | { source: SourceRow; created: boolean }
  | 'skipped'
  | 'limited'
  | 'failed';

// The address of a source that is not a page (a feed) is no page
const pageOf = (source: SourceRow, created: boolean): PageSource =>
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
    private _contentStudioSourceDiscoveryRepository: ContentStudioSourceDiscoveryRepository
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
        return this.captureFeed(input.organizationId, source, input.userId);
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
        capturedBefore: new Date(Date.now() - FEED_CAPTURE_INTERVAL_MS),
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
  // it is. The captures are recorded in the name of the member who created
  // the feed
  async captureScheduledFeed(input: {
    organizationId: string;
    sourceId: string;
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
      source.createdById
    );
    return { status: 'captured' as const, capture };
  }

  // One capture of a page source. `always` appends every capture, as a
  // refresh does; `if-changed` (feed captures) adds no version when the page
  // gives exactly what its current version holds, and treats a version that
  // another capture appended meanwhile as that capture. Both compare the
  // capture with the current version by blocks hash, title and extraction
  // only (never the blocks themselves), and a change of the page is kept on
  // the source in the same append (P8-04B1)
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
    source: SourceRow,
    userId: string,
    mode: 'if-changed'
  ): Promise<
    | {
        status: 'created';
        version: Parameters<typeof toPublicContentStudioSourceVersion>[0];
      }
    | { status: 'unchanged' }
  >;
  private async captureUrl(
    organizationId: string,
    source: SourceRow,
    userId: string,
    mode: 'always' | 'if-changed'
  ) {
    if (!source.canonicalUrl) {
      throw integrityError();
    }
    // the version this capture follows, read before the fetch
    const expectedLatestVersionNumber = source.latestVersionNumber;

    let fetched;
    try {
      fetched = await safeFetch(source.canonicalUrl, {
        method: 'GET',
        allowedContentTypes: SOURCE_FETCH_ALLOWED_CONTENT_TYPES,
        maxBytes: SOURCE_FETCH_MAX_BYTES,
        timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      throw fromSafeFetchError(err);
    }
    const fetchedAt = new Date();
    // SafeFetch records each URL that redirected: the first is the requested
    // one, and without redirects the answer came from the requested URL
    if (
      fetched.redirects.length
        ? fetched.redirects[0].url !== fetched.requestedUrl
        : fetched.finalUrl !== fetched.requestedUrl
    ) {
      throw fetchFailed();
    }
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

  // One capture of a live feed source of the organization (see the class)
  private async captureFeed(
    organizationId: string,
    feed: SourceRow,
    userId: string
  ) {
    if (!feed.canonicalUrl) {
      throw integrityError();
    }
    let fetched;
    try {
      fetched = await safeFetch(feed.canonicalUrl, {
        method: 'GET',
        allowedContentTypes: FEED_FETCH_ALLOWED_CONTENT_TYPES,
        maxBytes: FEED_FETCH_MAX_BYTES,
        timeoutMs: FEED_FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      throw fromSafeFetchError(err);
    }
    // the time of this capture: every page it lists was seen then
    const capturedAt = new Date();
    if (
      fetched.redirects.length
        ? fetched.redirects[0].url !== fetched.requestedUrl
        : fetched.finalUrl !== fetched.requestedUrl
    ) {
      throw fetchFailed();
    }

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

    await this._contentStudioSourceRepository.markFeedCaptured(
      organizationId,
      feed.id,
      capturedAt
    );
    const current =
      await this._contentStudioSourceRepository.getSourceForOrganization(
        organizationId,
        feed.id
      );
    if (!current) {
      throw integrityError();
    }
    return { source: toPublicContentStudioSource(current), capture };
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
    const known: Array<SourceRow | null> = [];
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
