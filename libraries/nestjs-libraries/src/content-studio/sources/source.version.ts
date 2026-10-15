import { z } from 'zod';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { trimmedText } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  ContentStudioSourceContentV1,
  parseContentStudioSourceContent,
  SOURCE_CONTENT_SCHEMA_VERSION,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { canonicalContentStudioSourceUrl } from '@gitroom/nestjs-libraries/content-studio/sources/source.url';
import { CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION_PATTERN } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

// A source version is one capture of a source: provenance (where it was
// requested, where it ended up after redirects, when, with which response
// metadata) plus the normalized blocks extracted from it. It records what was
// captured, not whether it is true.
//
// These fields describe a fetch the server made, so only server-side
// ingestion produces them, through parseContentStudioSourceVersionInput;
// no request body ever reaches it.
//
// Two hashes with different meanings:
// - contentHash: SHA-256 of the canonical JSON of the normalized blocks,
//   computed here, never taken from the caller
// - sourceHash: SHA-256 of what was fetched before extraction, when
//   ingestion has it. Never derived from the blocks

export const SOURCE_VERSION_REDIRECTS_MAX = 10;
export const SOURCE_VERSION_TITLE_MAX = 1000;
export const SOURCE_VERSION_CONTENT_TYPE_MAX = 255;
// contentLength is a PostgreSQL integer
const INT4_MAX = 2_147_483_647;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// printable ASCII, as a header value
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

// What a version stores for parsed content: its canonical JSON text and the
// SHA-256 of exactly that text. Equal content gives equal text and hash
export function storedContentStudioSourceContent(
  content: ContentStudioSourceContentV1
) {
  const text = canonicalJson(content);
  return {
    schemaVersion: SOURCE_CONTENT_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioSourceIntegrityError extends Error {
  constructor() {
    super('A stored source version failed its integrity check');
    this.name = 'ContentStudioSourceIntegrityError';
  }
}

// Reads a stored version back and proves its data is still exactly what was
// written: valid content, in canonical form, matching its hash and schema
// version. "Verified" here is about stored bytes, never about the facts in
// the text. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioSourceVersion(version: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioSourceContentV1 {
  let content: ContentStudioSourceContentV1;
  try {
    content = parseContentStudioSourceContent(JSON.parse(version.content));
  } catch {
    throw new ContentStudioSourceIntegrityError();
  }
  if (
    content.schemaVersion !== version.schemaVersion ||
    canonicalJson(content) !== version.content ||
    sha256Hex(version.content) !== version.contentHash
  ) {
    throw new ContentStudioSourceIntegrityError();
  }
  return content;
}

// Fixed messages, naming the field only: provenance can hold URLs with tokens
export class ContentStudioSourceVersionError extends Error {
  constructor(readonly fields: Array<string | number>) {
    super('The source version provenance is invalid');
    this.name = 'ContentStudioSourceVersionError';
  }
}

// null or blank is stored as null
const optionalText = (max: number) =>
  trimmedText(max)
    .nullable()
    .transform((text) => text || null);

// Every field is required, null included, so ingestion states what it did not
// get instead of leaving it out
const provenanceSchema = z
  .object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    redirectCount: z.number().int().min(0).max(SOURCE_VERSION_REDIRECTS_MAX),
    fetchedAt: z.date(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    contentType: z
      .string()
      .nullable()
      .transform((type) => (type ? type.trim() : '') || null)
      .pipe(
        z
          .string()
          .max(SOURCE_VERSION_CONTENT_TYPE_MAX)
          .regex(PRINTABLE_ASCII)
          .nullable()
      ),
    contentLength: z.number().int().min(0).max(INT4_MAX).nullable(),
    title: optionalText(SOURCE_VERSION_TITLE_MAX),
    sourceHash: z.string().regex(SHA256_HEX).nullable(),
    extractionVersion: z
      .string()
      .regex(CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION_PATTERN),
    content: z.unknown(),
  })
  .strict();

export type ContentStudioSourceVersionInput = z.input<typeof provenanceSchema>;

// Exactly what the repository writes for a new version
export interface ContentStudioSourceVersionData {
  requestedUrl: string;
  finalUrl: string;
  redirectCount: number;
  fetchedAt: Date;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  title: string | null;
  sourceHash: string | null;
  extractionVersion: string;
  schemaVersion: number;
  content: string;
  contentHash: string;
}

// Checks a capture from server-side ingestion and turns it into the data of a
// new version: both URLs canonical, bounded metadata, the blocks parsed and
// canonicalized, contentHash computed. Throws ContentStudioSourceVersionError,
// ContentStudioSourceUrlError or ContentStudioSourceContentError; nothing is
// repaired. A status is not judged here: whether a capture is worth a version
// is up to ingestion
export function parseContentStudioSourceVersionInput(
  input: unknown
): ContentStudioSourceVersionData {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new ContentStudioSourceVersionError([]);
  }
  const result = provenanceSchema.safeParse(input);
  if (!result.success) {
    // each field once; an unknown field has no path and is not named
    throw new ContentStudioSourceVersionError(
      Array.from(
        new Set(result.error.issues.map(({ path }) => path[0]))
      ).filter((field) => field !== undefined)
    );
  }
  // z.date() has already refused an Invalid Date
  const data = result.data;
  const requestedUrl = canonicalContentStudioSourceUrl(data.requestedUrl);
  const finalUrl = canonicalContentStudioSourceUrl(data.finalUrl);
  // without a redirect the response came from the requested URL
  if (data.redirectCount === 0 && finalUrl !== requestedUrl) {
    throw new ContentStudioSourceVersionError(['finalUrl']);
  }

  const stored = storedContentStudioSourceContent(
    parseContentStudioSourceContent(data.content)
  );
  return {
    requestedUrl,
    finalUrl,
    redirectCount: data.redirectCount,
    fetchedAt: new Date(data.fetchedAt.getTime()),
    httpStatus: data.httpStatus,
    contentType: data.contentType,
    contentLength: data.contentLength,
    title: data.title,
    sourceHash: data.sourceHash,
    extractionVersion: data.extractionVersion,
    ...stored,
  };
}
