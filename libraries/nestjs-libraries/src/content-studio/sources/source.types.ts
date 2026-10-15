// What a Content Studio source can be. The database keeps the kind as text,
// so a later phase adds a kind here (with its ingestion) instead of migrating
// an enum. Only `url` exists for now: a web page an organization tracks.
// Like the editorial parsers this file uses no Node-only module

export const CONTENT_STUDIO_SOURCE_KINDS = ['url'] as const;

export type ContentStudioSourceKind =
  (typeof CONTENT_STUDIO_SOURCE_KINDS)[number];

// Exact, case-sensitive names only. A list lookup, so a key inherited from
// Object.prototype (constructor, toString, ...) is never a kind
export const isContentStudioSourceKind = (
  value: unknown
): value is ContentStudioSourceKind =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_SOURCE_KINDS as readonly string[]).includes(value);

// The organization's own label for a source, trimmed. Not the page title:
// that is captured per version
export const CONTENT_STUDIO_SOURCE_NAME_MAX = 200;

// Names the extraction and normalization code that produced a version's
// blocks. Changing that code means a new name here, deliberately; a version
// keeps the name it was made with
export const CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION =
  'content-studio-source-v1';
export const CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,63}$/;
