// What a Content Studio source can be. The database keeps the kind as text,
// so a later phase adds a kind here (with its ingestion) instead of migrating
// an enum:
// - `url`: a web page an organization tracks, captured as versions;
// - `feed` (P8-01): an RSS or Atom feed. It is a way to find web pages, not
//   content: a capture records the pages its entries link to as ordinary
//   `url` sources (each with its own versions) and which feed listed them,
//   and the feed itself never gets a version.
// Like the editorial parsers this file uses no Node-only module

export const CONTENT_STUDIO_SOURCE_KINDS = ['url', 'feed'] as const;

export type ContentStudioSourceKind =
  (typeof CONTENT_STUDIO_SOURCE_KINDS)[number];

// Exact, case-sensitive names only. A list lookup, so a key inherited from
// Object.prototype (constructor, toString, ...) is never a kind
export const isContentStudioSourceKind = (
  value: unknown
): value is ContentStudioSourceKind =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_SOURCE_KINDS as readonly string[]).includes(value);

// News Radar (P8-02): how far back a first sighting may be, by name. The
// server turns a window into a time; 'all' has no bound
export const CONTENT_STUDIO_DISCOVERY_WINDOWS = [
  '24h',
  '7d',
  '30d',
  'all',
] as const;

export type ContentStudioDiscoveryWindow =
  (typeof CONTENT_STUDIO_DISCOVERY_WINDOWS)[number];

export const CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW: ContentStudioDiscoveryWindow =
  '7d';

// A found page with a version (captured) or without one (not captured: never
// fetched yet, failing, or archived before its capture). Never "failed"
export const CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES = [
  'captured',
  'not-captured',
] as const;

export type ContentStudioDiscoveryCaptureState =
  (typeof CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES)[number];

// The organization's own label for a source, trimmed. Not the page title:
// that is captured per version
export const CONTENT_STUDIO_SOURCE_NAME_MAX = 200;

// Source search (P8-03): words of a source's name or URL, plain text, never
// a pattern. The same bound as the review queue's search
export const CONTENT_STUDIO_SOURCE_SEARCH_MAX = 100;

// Names the extraction and normalization code that produced a version's
// title and blocks. It changes, deliberately, whenever that code can produce a
// different block selection, order, text, type or level, or another title from
// the same bytes; a refactor with byte-identical output keeps it. A version
// keeps the name it was made with, and every well-formed name stays readable:
// older versions are never extracted again.
// v1: P3-02, the first extractor. v2: content root, chrome and hidden
// subtrees left out, list items and quotes without repeats, charsets
export const CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION =
  'content-studio-source-v2';
export const CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Technical safety limits of one organization (P8-C1): fixed, never
// configuration, and not a plan. They stop runaway growth; nothing is hidden,
// archived or deleted when a limit is reached, only what would grow past it
// is refused:
// - live feeds: each one is read about hourly, with up to 25 pages. An
//   archived feed is not read, so archiving one frees its place
// - page sources, archived ones included: an archived page keeps its
//   versions and its URL, and sources are never deleted. The scale Source
//   lists and search were measured at (P8-03)
// - a refresh by a member: not sooner than this after the source's last
//   capture (a page's current version, a feed's last read). Scheduled
//   captures do not wait for it
export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;
export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;
export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export interface ContentStudioSourceLimits {
  activeFeedsMax: number;
  urlSourcesMax: number;
  manualRefreshCooldownMs: number;
}

// The limits of one organization: the fixed ones, for every organization.
// The one place a later policy may lower them; never from a request
export const contentStudioSourceLimits = (
  organizationId: string
): ContentStudioSourceLimits => ({
  activeFeedsMax: CONTENT_STUDIO_ACTIVE_FEEDS_MAX,
  urlSourcesMax: CONTENT_STUDIO_URL_SOURCES_MAX,
  manualRefreshCooldownMs: CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS,
});
