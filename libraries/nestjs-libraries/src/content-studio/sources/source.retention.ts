import {
  classifyContentStudioSourceCaptureTransition,
  ContentStudioSourceCaptureIdentity,
  isSameContentStudioSourceCapture,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import {
  ContentStudioSourcePageChangeRow,
  storedContentStudioSourcePageChange,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

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
