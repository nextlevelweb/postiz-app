import {
  classifyContentStudioSourceCaptureTransition,
  ContentStudioSourceCaptureIdentity,
  ContentStudioSourcePageChange,
  isContentStudioSourcePageChange,
  isSameContentStudioSourceCapture,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import {
  ContentStudioSourcePageChangeRow,
  storedContentStudioSourcePageChange,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// Which captured source versions are protected, and why (P8-R1A). The one
// place the protection of a version is decided: the protection map, the
// explanation of one version and, later, a retention dry-run and the recheck
// before anything is removed all come from here. Pure and deterministic: no
// database, network, environment, clock or randomness; the caller passes the
// rows and the time. It never removes anything and says nothing about whether
// a version may be removed:
// - a version is protected while anything stored names it exactly (a draft,
//   a revision, a review of a revision, an AI operation), while its source
//   needs it (the latest version, the last page change with the capture it
//   was found against and the first capture of that capture's run), and for
//   a while after it was made (IN_FLIGHT)
// - a version with no protection is only eligible in principle: whether
//   source history may be shortened at all is a product decision (PD1), not
//   taken here
// - anything that does not resolve exactly (a missing or other version, a
//   source or change state that cannot be, a row of another organization)
//   fails the whole organization: nothing is skipped, so nothing becomes
//   eligible by being unreadable

export const CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS = [
  // the source's current version
  'LATEST',
  // the source's last page change: the version, the capture before it and
  // the first capture of that capture's run (what the change is shown against)
  'PAGE_CHANGE',
  // grounding evidence of a package's current draft
  'DRAFT_EVIDENCE',
  // grounding evidence of a package revision, every revision
  'REVISION_EVIDENCE',
  // grounding evidence of a reviewed revision (its claims and approvals)
  'REVIEW_EVIDENCE',
  // a source an AI operation put in its prompt
  'AI_OPERATION',
  // a technical guard while a version may still be in use, never a policy
  'IN_FLIGHT',
] as const;

export type ContentStudioSourceVersionProtectionReason =
  (typeof CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS)[number];

export type ContentStudioSourceVersionProtectionRole =
  | 'latest'
  | 'changed'
  | 'predecessor'
  | 'comparison_baseline'
  | 'age'
  | 'picker_window';

export const CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REFERENCE_TYPES = [
  'ContentStudioSource',
  'ContentPackage',
  'ContentPackageRevision',
  'ContentStudioReview',
  'ContentStudioAIOperation',
  'ContentStudioSourceVersion',
] as const;

export type ContentStudioSourceVersionProtectionReferenceType =
  (typeof CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REFERENCE_TYPES)[number];

// What each reason is held by, and with which role: nothing else is a valid
// protection
const PROTECTION_SHAPES: Record<
  ContentStudioSourceVersionProtectionReason,
  ReadonlyArray<{
    referenceType: ContentStudioSourceVersionProtectionReferenceType;
    role?: ContentStudioSourceVersionProtectionRole;
  }>
> = {
  LATEST: [{ referenceType: 'ContentStudioSource', role: 'latest' }],
  PAGE_CHANGE: [
    { referenceType: 'ContentStudioSource', role: 'changed' },
    { referenceType: 'ContentStudioSource', role: 'predecessor' },
    { referenceType: 'ContentStudioSource', role: 'comparison_baseline' },
  ],
  DRAFT_EVIDENCE: [{ referenceType: 'ContentPackage' }],
  REVISION_EVIDENCE: [{ referenceType: 'ContentPackageRevision' }],
  REVIEW_EVIDENCE: [{ referenceType: 'ContentStudioReview' }],
  AI_OPERATION: [{ referenceType: 'ContentStudioAIOperation' }],
  IN_FLIGHT: [
    { referenceType: 'ContentStudioSourceVersion', role: 'age' },
    { referenceType: 'ContentStudioSource', role: 'picker_window' },
  ],
};

// A temporary technical race guard, never a retention policy: every version
// made in the last 24 hours is protected. It is far longer than anything that
// may still be using a version it just read (a feed capture with its
// retries, about 34 minutes at worst; one AI attempt, 30 seconds; a save,
// seconds). A version older than this is not removable for being older
export const CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS = 24 * 60 * 60 * 1000;

// The newest versions of a source the evidence picker offers: the first page
// of its version history (the page size of the source service). A member may
// keep that list open for any time, so these are protected whatever their age
export const CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW = 20;

// One reason one version is protected, held by one stored record (by model
// and id), with the role the version has for it
export interface ContentStudioSourceVersionProtection {
  readonly organizationId: string;
  readonly sourceVersionId: string;
  readonly reason: ContentStudioSourceVersionProtectionReason;
  readonly referenceType: ContentStudioSourceVersionProtectionReferenceType;
  readonly referenceId: string;
  readonly role?: ContentStudioSourceVersionProtectionRole;
}

// By version id, in id order; each version's protections in reason order,
// then by model, record and role. A version without any is not in it
export type ContentStudioSourceVersionProtectionMap = ReadonlyMap<
  string,
  readonly ContentStudioSourceVersionProtection[]
>;

// A source as protection reads it: its kind, current version and last page
// change
export interface ContentStudioSourceVersionProtectionSource
  extends ContentStudioSourcePageChangeRow {
  id: string;
  organizationId: string;
  kind: string;
}

// A version's metadata, never its content
export interface ContentStudioSourceVersionProtectionVersion
  extends ContentStudioSourceCaptureIdentity {
  id: string;
  organizationId: string;
  sourceId: string;
  versionNumber: number;
  fetchedAt: Date;
  createdAt: Date;
}

// One exact version a stored record names, as it names it: the source, the
// version by id and number, and the hash of its blocks
export interface ContentStudioSourceVersionReference {
  reason: Extract<
    ContentStudioSourceVersionProtectionReason,
    'DRAFT_EVIDENCE' | 'REVISION_EVIDENCE' | 'REVIEW_EVIDENCE' | 'AI_OPERATION'
  >;
  referenceType: ContentStudioSourceVersionProtectionReferenceType;
  referenceId: string;
  sourceId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
}

// A fixed message only: never content, a quote, a draft, a context or a URL.
// The record that failed is named by model and id, for the operator
export class ContentStudioSourceRetentionIntegrityError extends Error {
  constructor(
    readonly reference: {
      type: ContentStudioSourceVersionProtectionReferenceType;
      id: string;
    }
  ) {
    super(
      'Stored data a source version protection depends on could not be verified'
    );
    this.name = 'ContentStudioSourceRetentionIntegrityError';
  }
}

const integrity = (
  type: ContentStudioSourceVersionProtectionReferenceType,
  id: string
) => new ContentStudioSourceRetentionIntegrityError({ type, id });

const isDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const isShape = (protection: {
  reason: string;
  referenceType: string;
  role?: string;
}) =>
  Object.prototype.hasOwnProperty.call(PROTECTION_SHAPES, protection.reason) &&
  PROTECTION_SHAPES[
    protection.reason as ContentStudioSourceVersionProtectionReason
  ].some(
    (shape) =>
      shape.referenceType === protection.referenceType &&
      shape.role === protection.role
  );

// The protections a source's own state and the versions' age give: LATEST,
// PAGE_CHANGE and IN_FLIGHT. Every source and version is checked as it is
// read; the numbers of a source's versions may have gaps (only the rows that
// exist count, never a number computed from another). `now` is the caller's
// time; a version made at the cutoff exactly is still protected
export function deriveContentStudioSourceVersionProtections(input: {
  organizationId: string;
  sources: readonly ContentStudioSourceVersionProtectionSource[];
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  now: Date;
  inFlightMs: number;
  pickerWindow: number;
}): ContentStudioSourceVersionProtection[] {
  if (
    !isDate(input.now) ||
    !Number.isSafeInteger(input.inFlightMs) ||
    input.inFlightMs < 1 ||
    !Number.isSafeInteger(input.pickerWindow) ||
    input.pickerWindow < 1
  ) {
    throw new RangeError('Invalid source version protection window');
  }
  const organizationId = input.organizationId;

  const sources = new Map<string, ContentStudioSourceVersionProtectionSource>();
  for (const source of input.sources) {
    if (source.organizationId !== organizationId || sources.has(source.id)) {
      throw integrity('ContentStudioSource', source.id);
    }
    sources.set(source.id, source);
  }

  // a version belongs to a page source of this organization, once, with a
  // number and both times
  const versionIds = new Set<string>();
  const bySource = new Map<
    string,
    ContentStudioSourceVersionProtectionVersion[]
  >();
  for (const version of input.versions) {
    const source = sources.get(version.sourceId);
    if (
      version.organizationId !== organizationId ||
      versionIds.has(version.id) ||
      !source ||
      !Number.isSafeInteger(version.versionNumber) ||
      version.versionNumber < 1 ||
      !isDate(version.fetchedAt) ||
      !isDate(version.createdAt)
    ) {
      throw integrity('ContentStudioSourceVersion', version.id);
    }
    // a feed never has versions, whatever is stored for it
    if (source.kind !== 'url') {
      throw integrity('ContentStudioSource', source.id);
    }
    versionIds.add(version.id);
    const list = bySource.get(source.id);
    if (list) {
      list.push(version);
    } else {
      bySource.set(source.id, [version]);
    }
  }

  const protections: ContentStudioSourceVersionProtection[] = [];
  const protect = (
    version: ContentStudioSourceVersionProtectionVersion,
    reason: ContentStudioSourceVersionProtectionReason,
    referenceType: ContentStudioSourceVersionProtectionReferenceType,
    referenceId: string,
    role: ContentStudioSourceVersionProtectionRole
  ) =>
    protections.push({
      organizationId,
      sourceVersionId: version.id,
      reason,
      referenceType,
      referenceId,
      role,
    });
  const cutoff = input.now.getTime() - input.inFlightMs;

  for (const source of sources.values()) {
    const change = storedContentStudioSourcePageChange(source);
    if (
      !Number.isSafeInteger(source.latestVersionNumber) ||
      source.latestVersionNumber < 0 ||
      change === undefined
    ) {
      throw integrity('ContentStudioSource', source.id);
    }
    if (source.kind !== 'url') {
      // a feed (it has no versions, see above) has no current version and
      // no page change either
      if (source.latestVersionNumber !== 0 || change !== null) {
        throw integrity('ContentStudioSource', source.id);
      }
      continue;
    }

    // oldest first; a number twice is a broken history
    const versions = (bySource.get(source.id) ?? [])
      .slice()
      .sort((a, b) => a.versionNumber - b.versionNumber);
    if (
      versions.some(
        (version, index) =>
          index > 0 &&
          version.versionNumber === versions[index - 1].versionNumber
      )
    ) {
      throw integrity('ContentStudioSource', source.id);
    }

    // LATEST: the source's current version exists, and no version is newer
    // than it. A source without versions has neither
    const latest = versions[versions.length - 1];
    if (
      source.latestVersionNumber === 0
        ? latest !== undefined
        : latest?.versionNumber !== source.latestVersionNumber
    ) {
      throw integrity('ContentStudioSource', source.id);
    }
    if (latest) {
      protect(latest, 'LATEST', 'ContentStudioSource', source.id, 'latest');
    }

    // PAGE_CHANGE: the changed version at its stored time; the version
    // before it that exists, which must be the capture it was found against
    // (its stored time and the same change between them); and the first
    // capture of that capture's run, which the change is shown against
    // (v1 A, v2 A, v3 B: v3 against v1). Only the last change is stored, so
    // only it is protected
    if (change) {
      const index = versions.findIndex(
        (version) => version.versionNumber === change.versionNumber
      );
      const changed = versions[index];
      const predecessor = versions[index - 1];
      if (
        index < 1 ||
        changed.fetchedAt.getTime() !== change.at.getTime() ||
        predecessor.fetchedAt.getTime() !==
          change.previousCaptureAt.getTime() ||
        classifyContentStudioSourceCaptureTransition(predecessor, changed) !==
          change.kind
      ) {
        throw integrity('ContentStudioSource', source.id);
      }
      let first = index - 1;
      while (
        first > 0 &&
        isSameContentStudioSourceCapture(versions[first - 1], predecessor)
      ) {
        first--;
      }
      protect(
        changed,
        'PAGE_CHANGE',
        'ContentStudioSource',
        source.id,
        'changed'
      );
      protect(
        predecessor,
        'PAGE_CHANGE',
        'ContentStudioSource',
        source.id,
        'predecessor'
      );
      protect(
        versions[first],
        'PAGE_CHANGE',
        'ContentStudioSource',
        source.id,
        'comparison_baseline'
      );
    }

    // IN_FLIGHT: the newest versions that exist, as the picker lists them,
    // and every version made since the cutoff
    for (const version of versions.slice(-input.pickerWindow)) {
      protect(
        version,
        'IN_FLIGHT',
        'ContentStudioSource',
        source.id,
        'picker_window'
      );
    }
    for (const version of versions) {
      if (version.createdAt.getTime() >= cutoff) {
        protect(
          version,
          'IN_FLIGHT',
          'ContentStudioSourceVersion',
          version.id,
          'age'
        );
      }
    }
  }
  return protections;
}

// The protections stored records give: each reference must name exactly a
// version of this organization (its id, source, number and blocks hash), or
// the whole organization fails. A record naming one version more than once
// protects it once
export function resolveContentStudioSourceVersionReferences(input: {
  organizationId: string;
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  references: readonly ContentStudioSourceVersionReference[];
}): ContentStudioSourceVersionProtection[] {
  const versions = new Map(
    input.versions.map((version) => [version.id, version])
  );
  const seen = new Set<string>();
  const protections: ContentStudioSourceVersionProtection[] = [];
  for (const reference of input.references) {
    if (!isShape(reference)) {
      throw new RangeError('Invalid source version reference');
    }
    const version = versions.get(reference.versionId);
    if (
      !version ||
      version.organizationId !== input.organizationId ||
      version.sourceId !== reference.sourceId ||
      version.versionNumber !== reference.versionNumber ||
      version.contentHash !== reference.contentHash
    ) {
      throw integrity(reference.referenceType, reference.referenceId);
    }
    const key = `${reference.reason}\n${reference.referenceId}\n${version.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      protections.push({
        organizationId: input.organizationId,
        sourceVersionId: version.id,
        reason: reference.reason,
        referenceType: reference.referenceType,
        referenceId: reference.referenceId,
      });
    }
  }
  return protections;
}

// Code unit order: the same everywhere, whatever the locale
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const compareProtections = (
  a: ContentStudioSourceVersionProtection,
  b: ContentStudioSourceVersionProtection
) =>
  CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS.indexOf(a.reason) -
    CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS.indexOf(b.reason) ||
  compareText(a.referenceType, b.referenceType) ||
  compareText(a.referenceId, b.referenceId) ||
  compareText(a.role ?? '', b.role ?? '');

// The protections of one organization by version, deterministic whatever
// the order they come in: an exact repeat is kept once, distinct reasons,
// records and roles all stay. A protection of no known shape, or of another
// organization than the others, is refused
export function buildContentStudioSourceVersionProtectionMap(
  protections: readonly ContentStudioSourceVersionProtection[]
): ContentStudioSourceVersionProtectionMap {
  const byVersion = new Map<
    string,
    Map<string, ContentStudioSourceVersionProtection>
  >();
  const organizationId = protections[0]?.organizationId;
  for (const protection of protections) {
    if (
      protection.organizationId !== organizationId ||
      !protection.sourceVersionId ||
      !protection.referenceId ||
      !isShape(protection)
    ) {
      throw new RangeError('Invalid source version protection');
    }
    const key = [
      protection.reason,
      protection.referenceType,
      protection.referenceId,
      protection.role ?? '',
    ].join('\n');
    let entries = byVersion.get(protection.sourceVersionId);
    if (!entries) {
      entries = new Map();
      byVersion.set(protection.sourceVersionId, entries);
    }
    if (!entries.has(key)) {
      entries.set(
        key,
        Object.freeze({
          organizationId: protection.organizationId,
          sourceVersionId: protection.sourceVersionId,
          reason: protection.reason,
          referenceType: protection.referenceType,
          referenceId: protection.referenceId,
          ...(protection.role ? { role: protection.role } : {}),
        })
      );
    }
  }
  const map = new Map<
    string,
    readonly ContentStudioSourceVersionProtection[]
  >();
  for (const id of [...byVersion.keys()].sort(compareText)) {
    map.set(
      id,
      Object.freeze([...byVersion.get(id)!.values()].sort(compareProtections))
    );
  }
  return map;
}

// The one way an organization's protection map is made: the source state
// and age protections and the stored references, merged
export function computeContentStudioSourceVersionProtectionMap(input: {
  organizationId: string;
  sources: readonly ContentStudioSourceVersionProtectionSource[];
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  references: readonly ContentStudioSourceVersionReference[];
  now: Date;
  inFlightMs: number;
  pickerWindow: number;
}): ContentStudioSourceVersionProtectionMap {
  return buildContentStudioSourceVersionProtectionMap([
    ...deriveContentStudioSourceVersionProtections(input),
    ...resolveContentStudioSourceVersionReferences(input),
  ]);
}

// Why one version of the map is protected. eligibleInPrinciple says only
// that no protection is known: never that the version may be removed
export const explainContentStudioSourceVersionProtection = (
  map: ContentStudioSourceVersionProtectionMap,
  sourceVersionId: string
) => {
  const protections = map.get(sourceVersionId) ?? [];
  return {
    sourceVersionId,
    eligibleInPrinciple: protections.length === 0,
    protections: [...protections],
  };
};

// The retention dry run (P8-R1B): which versions one policy would select,
// from the protections above and nothing else, as a report and a hash of
// what it selected. It selects; it never removes anything, and a candidate
// is never more than a candidate: removing one needs the product's approval
// (PD1a), a quarantine and a fresh check first. One policy only,
// compact_repeats: when the same capture (the same blocks, title and
// extraction version) was stored several times in a row, the first and the
// last of that run are kept and the ones between them, that nothing
// protects and that are old enough, are candidates. Every page change, every
// What changed comparison and the source's last page change stay exactly as
// they are (a version is compared with the first capture of its run and of
// the run before it, and found against the last capture of the run before)

// What the protections above are: their reasons and shapes, the page change
// closure, the records read for them and the in-flight guard. A change of
// any of them is a new version, and a new hash for the same rows
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION = 1;
// What compact_repeats is: runs of the same capture, their first and last
// kept, the age (createdAt, strictly before olderThan, at least the minimum
// age) and the one mode
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION = 1;
// The shape and order of what is hashed
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION = 1;
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT =
  'content-studio.source-version-retention-dry-run';

// The only policy there is. Removing whatever nothing protects
// (all_unprotected) would change what older versions are compared with, and
// is not enabled
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MODES = [
  'compact_repeats',
] as const;

// A floor of the policy, never a protection and never a commercial
// retention period: a version younger than a week is never selected,
// whatever the operator asks. IN_FLIGHT (24 hours) stays as it is
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS =
  7 * 24 * 60 * 60 * 1000;

// How long a dry run may be acted on: an hour after the time it was made for
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_VALIDITY_MS =
  60 * 60 * 1000;

// The most versions one organization's dry run reads in its one snapshot
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_MAX_VERSIONS = 1_000_000;

// Sources whose versions are read and evaluated together: one source's
// versions are always read whole, never split
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE = 200;

// Why a version nothing protects is still kept by the policy
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_RETAINED = [
  // the first or last capture of its run
  'RUN_BOUNDARY',
  // made at or after olderThan
  'TOO_RECENT',
] as const;

export type ContentStudioSourceVersionRetentionPolicyRetained =
  (typeof CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_RETAINED)[number];

// Why a version is a candidate: between the first and last of its run
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_CANDIDATE_REASON =
  'REPEAT_RUN_INTERIOR';

// Why a source's candidates are all held back. The source is reported, the
// others go on
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_BLOCKERS = [
  // its stored last page change is not the one its versions show
  'PAGE_CHANGE_STATE_STALE',
  // without its candidates, its page change, runs or protections would change
  'RETAINED_SET_INVARIANT_CHANGED',
] as const;

export type ContentStudioSourceVersionRetentionBlocker =
  (typeof CONTENT_STUDIO_SOURCE_VERSION_RETENTION_BLOCKERS)[number];

// Why a whole dry run fails: no report and no hash
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_ERRORS = [
  // stored data a protection depends on could not be verified
  // (ContentStudioSourceRetentionIntegrityError)
  'RETENTION_INTEGRITY_ERROR',
  'RETENTION_POLICY_NOT_ENABLED',
  'RETENTION_POLICY_INVALID',
  'RETENTION_DRY_RUN_SCALE_LIMIT',
  // the snapshot timed out or its connection failed, or a candidate was
  // not there to be measured
  'RETENTION_DRY_RUN_SNAPSHOT_FAILED',
  // a version of the organization is held for a retention plan (P8-R1Q):
  // one plan at a time, so no dry run is made until it is released
  'RETENTION_DRY_RUN_QUARANTINE_ACTIVE',
] as const;

export type ContentStudioSourceVersionRetentionErrorCode =
  (typeof CONTENT_STUDIO_SOURCE_VERSION_RETENTION_ERRORS)[number];

// A fixed message with the code only
export class ContentStudioSourceRetentionDryRunError extends Error {
  constructor(
    readonly code: Exclude<
      ContentStudioSourceVersionRetentionErrorCode,
      'RETENTION_INTEGRITY_ERROR'
    >
  ) {
    super(`The source version retention dry run failed: ${code}`);
    this.name = 'ContentStudioSourceRetentionDryRunError';
  }
}

// The code of a retention failure, or null for anything else
export const contentStudioSourceVersionRetentionErrorCode = (
  err: unknown
): ContentStudioSourceVersionRetentionErrorCode | null =>
  err instanceof ContentStudioSourceRetentionDryRunError
    ? err.code
    : err instanceof ContentStudioSourceRetentionIntegrityError
    ? 'RETENTION_INTEGRITY_ERROR'
    : null;

export interface ContentStudioSourceVersionRetentionPolicy {
  mode: 'compact_repeats';
  olderThan: Date;
}

// The policy as given, checked against the evaluation time: compact_repeats
// only, and olderThan at least the minimum age before it
export function assertContentStudioSourceVersionRetentionPolicy(
  policy: { mode: unknown; olderThan: unknown },
  now: Date
): ContentStudioSourceVersionRetentionPolicy {
  if (policy.mode !== 'compact_repeats') {
    throw new ContentStudioSourceRetentionDryRunError(
      'RETENTION_POLICY_NOT_ENABLED'
    );
  }
  if (
    !isDate(now) ||
    !isDate(policy.olderThan) ||
    policy.olderThan.getTime() >
      now.getTime() - CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS
  ) {
    throw new ContentStudioSourceRetentionDryRunError(
      'RETENTION_POLICY_INVALID'
    );
  }
  return { mode: 'compact_repeats', olderThan: policy.olderThan };
}

// More versions than one snapshot reads: refused before any is read
export function assertContentStudioSourceVersionRetentionScale(
  versionCount: number,
  maxVersions = CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_MAX_VERSIONS
) {
  if (versionCount > maxVersions) {
    throw new ContentStudioSourceRetentionDryRunError(
      'RETENTION_DRY_RUN_SCALE_LIMIT'
    );
  }
}

// One run of the same capture, by version id, oldest first
export interface ContentStudioSourceVersionRun {
  firstVersionId: string;
  lastVersionId: string;
  versionIds: readonly string[];
}

type RunVersion = ContentStudioSourceCaptureIdentity & {
  id: string;
  versionNumber: number;
};

// One source's versions as runs of the same capture, in number order: the
// versions that exist, gaps in the numbers change nothing (v1 A, v2 A, v4 A,
// v9 B, v11 B are two runs). Each version is compared with the one before
// it, as the backfill and the change view compare them
export function groupContentStudioSourceVersionRuns(
  versions: readonly RunVersion[]
): ContentStudioSourceVersionRun[] {
  const ordered = versions
    .slice()
    .sort((a, b) => a.versionNumber - b.versionNumber);
  const runs: { last: RunVersion; versionIds: string[] }[] = [];
  for (const version of ordered) {
    const run = runs[runs.length - 1];
    if (run && isSameContentStudioSourceCapture(run.last, version)) {
      run.last = version;
      run.versionIds.push(version.id);
    } else {
      runs.push({ last: version, versionIds: [version.id] });
    }
  }
  return runs.map((run) => ({
    firstVersionId: run.versionIds[0],
    lastVersionId: run.versionIds[run.versionIds.length - 1],
    versionIds: run.versionIds,
  }));
}

// A version the policy selected, without its content
export interface ContentStudioSourceVersionRetentionCandidate {
  id: string;
  sourceId: string;
  versionNumber: number;
  contentHash: string;
  createdAt: Date;
  fetchedAt: Date;
  candidateReason: typeof CONTENT_STUDIO_SOURCE_VERSION_RETENTION_CANDIDATE_REASON;
}

// One source's versions as the policy sees them. A protected version is
// kept for its protection and is outside the policy; of the others the
// first and last of each run are kept (RUN_BOUNDARY, even when recent), the
// ones made at or after olderThan are kept (TOO_RECENT), and the rest are
// candidates, still to be checked with the whole source
export function classifyContentStudioSourceVersionRetentionCandidates(input: {
  source: { id: string };
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  protections: ContentStudioSourceVersionProtectionMap;
  policy: ContentStudioSourceVersionRetentionPolicy;
  now: Date;
}) {
  const policy = assertContentStudioSourceVersionRetentionPolicy(
    input.policy,
    input.now
  );
  const byId = new Map<string, ContentStudioSourceVersionProtectionVersion>();
  for (const version of input.versions) {
    if (version.sourceId !== input.source.id || byId.has(version.id)) {
      throw new RangeError('Invalid source version for retention');
    }
    byId.set(version.id, version);
  }
  const protectedVersionIds: string[] = [];
  const policyRetained: Record<
    ContentStudioSourceVersionRetentionPolicyRetained,
    string[]
  > = { RUN_BOUNDARY: [], TOO_RECENT: [] };
  const candidates: ContentStudioSourceVersionRetentionCandidate[] = [];
  for (const run of groupContentStudioSourceVersionRuns(input.versions)) {
    run.versionIds.forEach((id, index) => {
      const version = byId.get(id)!;
      if ((input.protections.get(id) ?? []).length > 0) {
        protectedVersionIds.push(id);
      } else if (index === 0 || index === run.versionIds.length - 1) {
        policyRetained.RUN_BOUNDARY.push(id);
      } else if (!(version.createdAt.getTime() < policy.olderThan.getTime())) {
        policyRetained.TOO_RECENT.push(id);
      } else {
        candidates.push({
          id: version.id,
          sourceId: version.sourceId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash,
          createdAt: version.createdAt,
          fetchedAt: version.fetchedAt,
          candidateReason:
            CONTENT_STUDIO_SOURCE_VERSION_RETENTION_CANDIDATE_REASON,
        });
      }
    });
  }
  return { protectedVersionIds, policyRetained, candidates };
}

type PageChange = {
  at: number;
  versionNumber: number;
  kind: ContentStudioSourcePageChange;
  previousCaptureAt: number;
};

// The last page change versions show, as the page-change backfill finds it
// (P8-04B1): every version in number order against the one before it that
// exists; the last content or title change, found against that one
const derivedPageChange = (
  ordered: readonly ContentStudioSourceVersionProtectionVersion[]
) => {
  let previous: ContentStudioSourceVersionProtectionVersion | null = null;
  let pageChange: PageChange | null = null;
  for (const version of ordered) {
    const transition = classifyContentStudioSourceCaptureTransition(
      previous,
      version
    );
    if (previous && isContentStudioSourcePageChange(transition)) {
      pageChange = {
        at: version.fetchedAt.getTime(),
        versionNumber: version.versionNumber,
        kind: transition,
        previousCaptureAt: previous.fetchedAt.getTime(),
      };
    }
    previous = version;
  }
  return pageChange;
};

const samePageChange = (
  stored: ReturnType<typeof storedContentStudioSourcePageChange>,
  derived: PageChange | null
) =>
  stored === undefined
    ? false
    : stored === null
    ? derived === null
    : derived !== null &&
      stored.at.getTime() === derived.at &&
      stored.versionNumber === derived.versionNumber &&
      stored.kind === derived.kind &&
      stored.previousCaptureAt.getTime() === derived.previousCaptureAt;

// What a source's own state protects (LATEST and PAGE_CHANGE), as text;
// null when those versions do not hold together
const stateProtections = (input: {
  source: ContentStudioSourceVersionProtectionSource;
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  now: Date;
  inFlightMs: number;
  pickerWindow: number;
}) => {
  try {
    return deriveContentStudioSourceVersionProtections({
      organizationId: input.source.organizationId,
      sources: [input.source],
      versions: input.versions,
      now: input.now,
      inFlightMs: input.inFlightMs,
      pickerWindow: input.pickerWindow,
    })
      .filter((p) => p.reason === 'LATEST' || p.reason === 'PAGE_CHANGE')
      .map((p) => `${p.sourceVersionId}\n${p.reason}\n${p.role}`)
      .sort(compareText)
      .join('\n\n');
  } catch (err) {
    if (err instanceof ContentStudioSourceRetentionIntegrityError) {
      return null;
    }
    throw err;
  }
};

// Whether one source would read exactly the same without all of its
// candidates together, checked on its versions before and after:
// - its stored last page change is the one all its versions show
//   (otherwise PAGE_CHANGE_STATE_STALE: it is not consistent now)
// - without the candidates its versions show that same change, its runs
//   are as many with the same first and last versions (what every version
//   is compared with and found against), and its latest version and page
//   change protect the same versions
//   (otherwise RETAINED_SET_INVARIANT_CHANGED)
// null when it would. Each version once per check: no pairwise comparison
export function simulateContentStudioSourcePageChangeStateAfterRetention(input: {
  source: ContentStudioSourceVersionProtectionSource;
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  candidateIds: ReadonlySet<string>;
  now: Date;
  inFlightMs: number;
  pickerWindow: number;
}): ContentStudioSourceVersionRetentionBlocker | null {
  const ordered = input.versions
    .slice()
    .sort((a, b) => a.versionNumber - b.versionNumber);
  const ids = new Set(ordered.map((version) => version.id));
  for (const id of input.candidateIds) {
    if (!ids.has(id)) {
      throw new RangeError('Invalid source version for retention');
    }
  }
  const stored = storedContentStudioSourcePageChange(input.source);
  if (!samePageChange(stored, derivedPageChange(ordered))) {
    return 'PAGE_CHANGE_STATE_STALE';
  }
  const retained = ordered.filter(
    (version) => !input.candidateIds.has(version.id)
  );
  if (!samePageChange(stored, derivedPageChange(retained))) {
    return 'RETAINED_SET_INVARIANT_CHANGED';
  }
  const before = groupContentStudioSourceVersionRuns(ordered);
  const after = groupContentStudioSourceVersionRuns(retained);
  if (
    before.length !== after.length ||
    before.some(
      (run, index) =>
        run.firstVersionId !== after[index].firstVersionId ||
        run.lastVersionId !== after[index].lastVersionId
    )
  ) {
    return 'RETAINED_SET_INVARIANT_CHANGED';
  }
  const state = stateProtections({ ...input, versions: ordered });
  if (
    state === null ||
    state !== stateProtections({ ...input, versions: retained })
  ) {
    return 'RETAINED_SET_INVARIANT_CHANGED';
  }
  return null;
}

// One source of a dry run: its counts, and its candidates unless it is
// blocked (then none, and how many were held back)
export interface ContentStudioSourceVersionRetentionSourceResult {
  sourceId: string;
  totalVersions: number;
  protectedVersions: number;
  policyRetainedByRule: Record<
    ContentStudioSourceVersionRetentionPolicyRetained,
    number
  >;
  candidates: ContentStudioSourceVersionRetentionCandidate[];
  blocker: ContentStudioSourceVersionRetentionBlocker | null;
  blockedCandidateVersions: number;
}

// The dry run of some sources of an organization with all their versions
// and the references naming them: the protection map from the one engine
// above, then each source classified and simulated with all its candidates
// together. A source either keeps all its candidates or is blocked with
// none: no subset is tried. Any integrity failure fails it all
export function evaluateContentStudioSourceVersionRetention(input: {
  organizationId: string;
  sources: readonly ContentStudioSourceVersionProtectionSource[];
  versions: readonly ContentStudioSourceVersionProtectionVersion[];
  references: readonly ContentStudioSourceVersionReference[];
  now: Date;
  inFlightMs: number;
  pickerWindow: number;
  policy: ContentStudioSourceVersionRetentionPolicy;
}) {
  const protections = computeContentStudioSourceVersionProtectionMap(input);
  const bySource = new Map<
    string,
    ContentStudioSourceVersionProtectionVersion[]
  >();
  for (const version of input.versions) {
    const list = bySource.get(version.sourceId);
    if (list) {
      list.push(version);
    } else {
      bySource.set(version.sourceId, [version]);
    }
  }
  const sources: ContentStudioSourceVersionRetentionSourceResult[] = [];
  for (const source of input.sources) {
    const versions = bySource.get(source.id) ?? [];
    const classified = classifyContentStudioSourceVersionRetentionCandidates({
      source,
      versions,
      protections,
      policy: input.policy,
      now: input.now,
    });
    const blocker = simulateContentStudioSourcePageChangeStateAfterRetention({
      source,
      versions,
      candidateIds: new Set(classified.candidates.map((c) => c.id)),
      now: input.now,
      inFlightMs: input.inFlightMs,
      pickerWindow: input.pickerWindow,
    });
    const blocked = blocker !== null && classified.candidates.length > 0;
    sources.push({
      sourceId: source.id,
      totalVersions: versions.length,
      protectedVersions: classified.protectedVersionIds.length,
      policyRetainedByRule: {
        RUN_BOUNDARY: classified.policyRetained.RUN_BOUNDARY.length,
        TOO_RECENT: classified.policyRetained.TOO_RECENT.length,
      },
      candidates: blocked ? [] : classified.candidates,
      blocker: blocked ? blocker : null,
      blockedCandidateVersions: blocked ? classified.candidates.length : 0,
    });
  }
  return { protections, sources };
}

// How many versions are protected, and by what: protectedVersions counts
// each version once; edgesByReason counts every protection;
// versionsByReason counts a version once per reason it has, so one version
// may be in several
export interface ContentStudioSourceVersionProtectionSummary {
  protectedVersions: number;
  protectionEdges: number;
  edgesByReason: Record<ContentStudioSourceVersionProtectionReason, number>;
  versionsByReason: Record<ContentStudioSourceVersionProtectionReason, number>;
}

const byReason = () =>
  Object.fromEntries(
    CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS.map((reason) => [
      reason,
      0,
    ])
  ) as Record<ContentStudioSourceVersionProtectionReason, number>;

// The summary of these maps together (of different versions each)
export function summarizeContentStudioSourceVersionProtections(
  maps: readonly ContentStudioSourceVersionProtectionMap[]
): ContentStudioSourceVersionProtectionSummary {
  const summary = {
    protectedVersions: 0,
    protectionEdges: 0,
    edgesByReason: byReason(),
    versionsByReason: byReason(),
  };
  for (const map of maps) {
    for (const protections of map.values()) {
      summary.protectedVersions += 1;
      const reasons = new Set<ContentStudioSourceVersionProtectionReason>();
      for (const protection of protections) {
        summary.protectionEdges += 1;
        summary.edgesByReason[protection.reason] += 1;
        reasons.add(protection.reason);
      }
      for (const reason of reasons) {
        summary.versionsByReason[reason] += 1;
      }
    }
  }
  return summary;
}

const compareCandidates = (
  a: { sourceId: string; versionNumber: number; id: string },
  b: { sourceId: string; versionNumber: number; id: string }
) =>
  compareText(a.sourceId, b.sourceId) ||
  a.versionNumber - b.versionNumber ||
  compareText(a.id, b.id);

// The hash of a dry run: exactly what it selected and held back, for which
// organization, time and policy, by which versions of the rules. Never the
// counts, sizes, times of the candidates, titles or URLs: those may be
// shown, never decided on. The order of the input does not matter. It
// names a plan; it permits nothing
export function contentStudioSourceVersionRetentionDryRunHash(input: {
  organizationId: string;
  evaluationNow: Date;
  validUntil: Date;
  policy: ContentStudioSourceVersionRetentionPolicy;
  candidates: readonly {
    sourceId: string;
    versionNumber: number;
    id: string;
    contentHash: string;
  }[];
  blockedSources: readonly {
    sourceId: string;
    blocker: ContentStudioSourceVersionRetentionBlocker;
    suppressedCandidates: number;
  }[];
  versions?: {
    format: number;
    protection: number;
    policy: number;
  };
}) {
  const versions = input.versions ?? {
    format: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION,
    protection: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION,
    policy: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION,
  };
  return sha256Hex(
    canonicalJson({
      format: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT,
      dryRunFormatVersion: versions.format,
      protectionVersion: versions.protection,
      policyVersion: versions.policy,
      organizationId: input.organizationId,
      evaluationNow: input.evaluationNow.toISOString(),
      validUntil: input.validUntil.toISOString(),
      policy: {
        mode: input.policy.mode,
        olderThan: input.policy.olderThan.toISOString(),
      },
      candidates: input.candidates
        .slice()
        .sort(compareCandidates)
        .map((c) => [c.sourceId, c.versionNumber, c.id, c.contentHash]),
      blockedSources: input.blockedSources
        .slice()
        .sort((a, b) => compareText(a.sourceId, b.sourceId))
        .map((b) => [b.sourceId, b.blocker, b.suppressedCandidates]),
    })
  );
}

// The report of a dry run of one organization: plain JSON (times as ISO
// text, counts as integers), sources, blocked sources and candidates in
// code unit order of the source id, then by number. No content, quote,
// title or URL: a source is named by its id. Every version is counted in
// exactly one of protected, kept by the policy, candidate and held back
export function buildContentStudioSourceVersionRetentionDryRun(input: {
  organizationId: string;
  evaluationNow: Date;
  policy: ContentStudioSourceVersionRetentionPolicy;
  snapshot: { sourceCount: number; versionCount: number };
  protectionSummary: ContentStudioSourceVersionProtectionSummary;
  sources: readonly ContentStudioSourceVersionRetentionSourceResult[];
  logicalContentBytes: ReadonlyMap<string, number>;
}) {
  const validUntil = new Date(
    input.evaluationNow.getTime() +
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_VALIDITY_MS
  );
  const bytes = (id: string) => {
    const value = input.logicalContentBytes.get(id);
    if (!Number.isSafeInteger(value) || value! < 0) {
      throw new RangeError('Missing logical content bytes');
    }
    return value!;
  };
  const sources = input.sources
    .filter((source) => source.totalVersions > 0)
    .slice()
    .sort((a, b) => compareText(a.sourceId, b.sourceId))
    .map((source) => {
      const policyRetainedVersions =
        source.policyRetainedByRule.RUN_BOUNDARY +
        source.policyRetainedByRule.TOO_RECENT;
      if (
        source.totalVersions !==
        source.protectedVersions +
          policyRetainedVersions +
          source.candidates.length +
          source.blockedCandidateVersions
      ) {
        throw new RangeError('Inconsistent source version retention counts');
      }
      return {
        sourceId: source.sourceId,
        totalVersions: source.totalVersions,
        protectedVersions: source.protectedVersions,
        policyRetainedVersions,
        candidateVersions: source.candidates.length,
        blockedCandidateVersions: source.blockedCandidateVersions,
        logicalContentBytes: source.candidates.reduce(
          (sum, candidate) => sum + bytes(candidate.id),
          0
        ),
      };
    });
  const blockedSources = input.sources
    .filter((source) => source.blocker !== null)
    .map((source) => ({
      sourceId: source.sourceId,
      blocker: source.blocker!,
      suppressedCandidates: source.blockedCandidateVersions,
    }))
    .sort((a, b) => compareText(a.sourceId, b.sourceId));
  const candidates = input.sources
    .flatMap((source) => source.candidates)
    .sort(compareCandidates);
  const sum = (key: keyof (typeof sources)[number]) =>
    sources.reduce((total, source) => total + (source[key] as number), 0);
  const totalVersions = sum('totalVersions');
  const protectedVersions = sum('protectedVersions');
  const policyRetainedVersions = sum('policyRetainedVersions');
  const candidateVersions = sum('candidateVersions');
  const blockedCandidateVersions = sum('blockedCandidateVersions');
  // the oldest and newest candidate by when it was made
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const candidate of candidates) {
    if (!oldest || candidate.createdAt.getTime() < oldest.getTime()) {
      oldest = candidate.createdAt;
    }
    if (!newest || candidate.createdAt.getTime() > newest.getTime()) {
      newest = candidate.createdAt;
    }
  }
  if (
    totalVersions !== input.snapshot.versionCount ||
    protectedVersions !== input.protectionSummary.protectedVersions
  ) {
    throw new RangeError('Inconsistent source version retention counts');
  }
  return {
    format: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT,
    dryRunFormatVersion:
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION,
    protectionVersion:
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION,
    policyVersion: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION,
    organizationId: input.organizationId,
    evaluationNow: input.evaluationNow.toISOString(),
    validUntil: validUntil.toISOString(),
    policy: {
      mode: input.policy.mode,
      olderThan: input.policy.olderThan.toISOString(),
    },
    snapshot: {
      isolation: 'repeatable_read' as const,
      sourceCount: input.snapshot.sourceCount,
      versionCount: input.snapshot.versionCount,
    },
    protectionSummary: {
      protectedVersions: input.protectionSummary.protectedVersions,
      protectionEdges: input.protectionSummary.protectionEdges,
      edgesByReason: { ...input.protectionSummary.edgesByReason },
      versionsByReason: { ...input.protectionSummary.versionsByReason },
    },
    candidateSummary: {
      totalVersions,
      protectedVersions,
      technicallyUnprotectedVersions: totalVersions - protectedVersions,
      policyRetainedVersions,
      policyRetainedByRule: {
        RUN_BOUNDARY: input.sources.reduce(
          (total, source) => total + source.policyRetainedByRule.RUN_BOUNDARY,
          0
        ),
        TOO_RECENT: input.sources.reduce(
          (total, source) => total + source.policyRetainedByRule.TOO_RECENT,
          0
        ),
      },
      candidateVersions,
      blockedCandidateVersions,
      blockedSources: blockedSources.length,
      logicalContentBytes: sum('logicalContentBytes'),
      oldestCandidateCreatedAt: oldest ? oldest.toISOString() : null,
      newestCandidateCreatedAt: newest ? newest.toISOString() : null,
    },
    sources,
    blockedSources,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      versionNumber: candidate.versionNumber,
      contentHash: candidate.contentHash,
      createdAt: candidate.createdAt.toISOString(),
      fetchedAt: candidate.fetchedAt.toISOString(),
      candidateReason: candidate.candidateReason,
      logicalContentBytes: bytes(candidate.id),
    })),
    dryRunHash: contentStudioSourceVersionRetentionDryRunHash({
      organizationId: input.organizationId,
      evaluationNow: input.evaluationNow,
      validUntil,
      policy: input.policy,
      candidates,
      blockedSources,
    }),
  };
}

export type ContentStudioSourceVersionRetentionDryRun = ReturnType<
  typeof buildContentStudioSourceVersionRetentionDryRun
>;

// The retention quarantine (P8-R1Q): a version held for one retention plan
// can gain no new reference, so the plan's fresh check later cannot be
// overtaken by a draft, revision or AI operation naming it. Holding a
// version is never removing it, and nothing here removes one. The order a
// plan follows: its dry run made again with the same hash, its candidates
// held, the wait below, a fresh protection check, and only then anything
// else. A version is held by one plan at a time, and an organization's held
// versions all belong to one plan

// The most versions held or released by one call
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE = 500;

// How long a plan waits after holding its versions before its fresh check:
// a writer that verified a version just before it was held commits its
// reference well within this (its check and write share one transaction,
// which Prisma ends after 5 seconds). Nothing here waits
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS = 60_000;

// A plan is named by its dry run hash (dryRunHash), exactly: a sha256 in
// lowercase hex. It names the plan; it authorizes nothing
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_HASH =
  /^[0-9a-f]{64}$/;

// Why holding or releasing versions fails: nothing is held or released
export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_ERRORS = [
  'RETENTION_QUARANTINE_INVALID',
  // a version that is not the organization's, like a missing one
  'RETENTION_QUARANTINE_VERSION_NOT_FOUND',
  // a version of the organization is held for another plan
  'RETENTION_QUARANTINE_PLAN_CONFLICT',
  // concurrent writes went on aborting the transaction
  'RETENTION_QUARANTINE_CONFLICT',
] as const;

export type ContentStudioSourceVersionRetentionQuarantineErrorCode =
  (typeof CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_ERRORS)[number];

// A fixed message with the code only: never a version id or a plan hash
export class ContentStudioSourceVersionQuarantineError extends Error {
  constructor(
    readonly code: ContentStudioSourceVersionRetentionQuarantineErrorCode
  ) {
    super(`The source version retention quarantine failed: ${code}`);
    this.name = 'ContentStudioSourceVersionQuarantineError';
  }
}

// A new draft, revision or AI operation named a held version. A fixed
// message: never which version, the plan or what retention is
export class ContentStudioSourceVersionRetentionPendingError extends Error {
  constructor() {
    super('This source version is temporarily unavailable for new references');
    this.name = 'ContentStudioSourceVersionRetentionPendingError';
  }
}
