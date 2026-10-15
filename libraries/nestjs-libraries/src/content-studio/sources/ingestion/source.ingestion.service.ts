import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import {
  safeFetch,
  SafeFetchError,
  SafeFetchErrorCategory,
} from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
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
import { CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

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

// Refreshes a source: fetches its stored URL once and appends the capture as
// its next immutable version. Any member may refresh; the organization and
// the user come from the request, the URL from the stored source only. A
// failed fetch or a page that cannot be processed adds no version. Two
// refreshes of the same version both fetch, but only one is stored: the other
// gets a conflict and is never retried by itself, since one request is one
// capture
@Injectable()
export class ContentStudioSourceIngestionService {
  constructor(
    private _contentStudioSourceRepository: ContentStudioSourceRepository
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
    switch (source.kind) {
      case 'url':
        break;
      default:
        throw kindUnsupported();
    }
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

    let result;
    try {
      result =
        await this._contentStudioSourceRepository.appendVersionWithCompareAndSwap(
          {
            organizationId: input.organizationId,
            sourceId: source.id,
            expectedLatestVersionNumber,
            versionId: randomUUID(),
            version,
            createdById: input.userId,
          }
        );
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      result = { status: 'changed' as const };
    }

    switch (result.status) {
      case 'created': {
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
      case 'not-found':
        throw notFound();
      case 'archived':
        throw sourceArchived();
      default:
        throw versionConflict();
    }
  }
}
