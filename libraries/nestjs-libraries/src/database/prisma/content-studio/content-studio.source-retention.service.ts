import { HttpException, Injectable } from '@nestjs/common';
import {
  ContentStudioSourceRetentionRepository,
  ContentStudioSourceRetentionSnapshotReads,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository';
import {
  ContentPackageClaimEvidenceV2,
  contentPackageClaims,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { parseVerifiedContentPackageRevision } from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import {
  ContentStudioAIOperationContext,
  parseContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  assertContentStudioSourceVersionRetentionPolicy,
  assertContentStudioSourceVersionRetentionScale,
  buildContentStudioSourceVersionProtectionMap,
  buildContentStudioSourceVersionRetentionDryRun,
  computeContentStudioSourceVersionProtectionMap,
  CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
  CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_HASH,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE,
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceVersionQuarantineError,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionProtection,
  ContentStudioSourceVersionProtectionMap,
  ContentStudioSourceVersionProtectionReferenceType,
  ContentStudioSourceVersionReference,
  ContentStudioSourceVersionRetentionSourceResult,
  evaluateContentStudioSourceVersionRetention,
  explainContentStudioSourceVersionProtection,
  summarizeContentStudioSourceVersionProtections,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// A fixed message only, like any source version of another organization
const notFound = () =>
  new HttpException(
    { msg: 'Source version not found.', code: 'CS_NOT_FOUND' },
    404
  );

// Ids of organizations and versions are Prisma uuid()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const quarantineInvalid = () =>
  new ContentStudioSourceVersionQuarantineError('RETENTION_QUARANTINE_INVALID');

// What a quarantine call is about: the organization and the plan, checked
// before anything is read
const quarantineScope = (input: {
  organizationId: unknown;
  planHash: unknown;
}) => {
  if (
    typeof input.organizationId !== 'string' ||
    !UUID.test(input.organizationId) ||
    typeof input.planHash !== 'string' ||
    !CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_HASH.test(input.planHash)
  ) {
    throw quarantineInvalid();
  }
  return { organizationId: input.organizationId, planHash: input.planHash };
};

// One to CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE
// version ids, each once, in the order given
const quarantineVersionIds = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === 'string' && UUID.test(id))
  ) {
    throw quarantineInvalid();
  }
  const ids = [...new Set(value as string[])];
  if (
    !ids.length ||
    ids.length > CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE
  ) {
    throw quarantineInvalid();
  }
  return ids;
};

// Rows per read: small rows (sources, reviews) and documents (a draft or
// revision is at most 64 KiB, an AI context 8 KiB). Versions are read by
// source batch (CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE)
const ROWS_PAGE_SIZE = 10_000;
const DOCUMENTS_PAGE_SIZE = 500;
// Candidates measured per read, after the snapshot
const CONTENTS_PAGE_SIZE = 500;

type Page<T> = (afterId: string | null, take: number) => Promise<T[]>;

// Every row of an organization-scoped read, one bounded page after the other
// in id order, handed over a page at a time
const eachPage = async <T extends { id: string }>(
  read: Page<T>,
  take: number,
  use: (rows: T[]) => void
) => {
  for (let afterId: string | null = null; ; ) {
    const rows = await read(afterId, take);
    use(rows);
    if (rows.length < take) {
      return;
    }
    afterId = rows[rows.length - 1].id;
  }
};

// One stored record of another organization, or that does not parse: the
// whole organization fails, nothing of it is skipped
const integrity = (
  type: ContentStudioSourceVersionProtectionReferenceType,
  id: string
) => new ContentStudioSourceRetentionIntegrityError({ type, id });

// The versions grounding or an AI operation names, once each as it names
// them
const distinctEvidence = (
  evidence:
    | readonly ContentPackageClaimEvidenceV2[]
    | NonNullable<ContentStudioAIOperationContext['sources']>
) => {
  const refs = new Map<
    string,
    {
      sourceId: string;
      versionId: string;
      versionNumber: number;
      contentHash: string;
    }
  >();
  for (const entry of evidence) {
    const ref = {
      sourceId: entry.sourceId,
      versionId: entry.versionId,
      versionNumber: entry.versionNumber,
      contentHash: entry.contentHash,
    };
    refs.set(
      [ref.sourceId, ref.versionId, ref.versionNumber, ref.contentHash].join(
        '\n'
      ),
      ref
    );
  }
  return [...refs.values()];
};

type Reads = ContentStudioSourceRetentionSnapshotReads;
type Sources = Awaited<ReturnType<Reads['listSources']>>;
type Versions = Awaited<ReturnType<Reads['listVersionsOfSources']>>;

// Some sources of the organization with all their versions and every
// reference naming one of them
interface Batch {
  sources: Sources;
  versions: Versions;
  references: ContentStudioSourceVersionReference[];
}

// Source version protection (P8-R1A) and the retention dry run (P8-R1B):
// which captured versions of one organization stored data still needs, and
// why, and which ones the one retention policy would select. Internal only:
// no route, activity or schedule reaches it; the dry run has one read-only
// operator command. It never writes or removes anything. Every protection
// is decided by source.retention.ts from the organization's rows, all read
// in one RepeatableRead snapshot (the organization as it was at one moment,
// whatever is captured or saved meanwhile): first how many versions it has,
// then its sources, package drafts (archived too), reviews of package
// revisions, revisions and AI operations in bounded pages, and then the
// versions of its sources a batch of sources at a time, each source's
// versions whole, evaluated with the references naming them. One read per
// kind of record and page, or per batch of sources: never per version. The
// JSON is read with the parsers that wrote it; anything that does not parse,
// belongs to another organization or names a version that is not exactly
// there throws ContentStudioSourceRetentionIntegrityError for the whole
// organization. A version with no protection is eligible in principle only,
// and a dry-run candidate only a candidate: whether history may be shortened
// is still a product decision (PD1). The retention quarantine (P8-R1Q) holds
// versions for one plan, internally only: no route, command or schedule
// reaches it yet. While an organization has a held version no dry run is
// made for it
@Injectable()
export class ContentStudioSourceRetentionService {
  constructor(
    private _contentStudioSourceRetentionRepository: ContentStudioSourceRetentionRepository
  ) {}

  // Every protected version of the organization at `now`, by version
  async computeProtectionMap(input: { organizationId: string; now: Date }) {
    return (await this.protect(input)).protections;
  }

  // Why one version of the organization is protected, from the same map:
  // the whole organization is evaluated, so corrupt data anywhere in it
  // fails this too. A version that is not the organization's is not found
  async explainRetentionEligibility(input: {
    organizationId: string;
    sourceVersionId: string;
    now: Date;
  }) {
    const { protections, found } = await this.protect(
      input,
      input.sourceVersionId
    );
    if (!found) {
      throw notFound();
    }
    return explainContentStudioSourceVersionProtection(
      protections,
      input.sourceVersionId
    );
  }

  // The retention dry run of one organization at `now` (P8-R1B): what the
  // policy would select and hold back, with its hash. Reads only. More than
  // CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_MAX_VERSIONS versions is
  // refused before any is read. After the snapshot, the candidates' blocks
  // are measured (their logical size, never what they would free on disk);
  // versions are never changed, so one that is not there fails the run
  async computeRetentionDryRun(input: {
    organizationId: string;
    now: Date;
    policy: { mode: unknown; olderThan: unknown };
  }) {
    const policy = assertContentStudioSourceVersionRetentionPolicy(
      input.policy,
      input.now
    );
    const maps: ContentStudioSourceVersionProtectionMap[] = [];
    const sources: ContentStudioSourceVersionRetentionSourceResult[] = [];
    const snapshot = await this.evaluate(input, true, (batch) => {
      const evaluated = evaluateContentStudioSourceVersionRetention({
        organizationId: input.organizationId,
        ...batch,
        now: input.now,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
        policy,
      });
      maps.push(evaluated.protections);
      sources.push(...evaluated.sources);
    });

    const ids = sources.flatMap((source) =>
      source.candidates.map((candidate) => candidate.id)
    );
    const logicalContentBytes = new Map<string, number>();
    for (let i = 0; i < ids.length; i += CONTENTS_PAGE_SIZE) {
      const rows =
        await this._contentStudioSourceRetentionRepository.listVersionContents({
          organizationId: input.organizationId,
          ids: ids.slice(i, i + CONTENTS_PAGE_SIZE),
        });
      for (const row of rows) {
        logicalContentBytes.set(row.id, Buffer.byteLength(row.content, 'utf8'));
      }
    }
    if (logicalContentBytes.size !== ids.length) {
      throw new ContentStudioSourceRetentionDryRunError(
        'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
      );
    }

    return buildContentStudioSourceVersionRetentionDryRun({
      organizationId: input.organizationId,
      evaluationNow: input.now,
      policy,
      snapshot,
      protectionSummary: summarizeContentStudioSourceVersionProtections(maps),
      sources,
      logicalContentBytes,
    });
  }

  // Holds versions of the organization for one plan (P8-R1Q), all or none:
  // see ContentStudioSourceRetentionRepository.quarantineVersions. Throws
  // ContentStudioSourceVersionQuarantineError
  async quarantineSourceVersions(input: {
    organizationId: string;
    sourceVersionIds: readonly string[];
    planHash: string;
    now: Date;
  }) {
    const scope = quarantineScope(input);
    const sourceVersionIds = quarantineVersionIds(input.sourceVersionIds);
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      throw quarantineInvalid();
    }
    return this._contentStudioSourceRetentionRepository.quarantineVersions({
      ...scope,
      sourceVersionIds,
      now: input.now,
    });
  }

  // Releases the plan's held versions of the organization: these ones, or
  // all of them. Never another plan's or organization's, never a version
  async releaseSourceVersionQuarantine(input: {
    organizationId: string;
    planHash: string;
    sourceVersionIds?: readonly string[];
  }) {
    const scope = quarantineScope(input);
    const { count } =
      await this._contentStudioSourceRetentionRepository.releaseQuarantine({
        ...scope,
        ...(input.sourceVersionIds === undefined
          ? {}
          : { sourceVersionIds: quarantineVersionIds(input.sourceVersionIds) }),
      });
    return { released: count };
  }

  // The plan's held versions of the organization, by version id, with when
  // each was held
  listSourceVersionQuarantine(input: {
    organizationId: string;
    planHash: string;
  }) {
    return this._contentStudioSourceRetentionRepository.listPendingForPlan(
      quarantineScope(input)
    );
  }

  // The protection map, batch by batch, merged: the same map as one of the
  // whole organization, each version being in exactly one batch
  private async protect(
    input: { organizationId: string; now: Date },
    sourceVersionId?: string
  ) {
    const protections: ContentStudioSourceVersionProtection[] = [];
    let found = false;
    await this.evaluate(input, false, (batch) => {
      const map = computeContentStudioSourceVersionProtectionMap({
        organizationId: input.organizationId,
        ...batch,
        now: input.now,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
      });
      for (const list of map.values()) {
        for (const protection of list) {
          protections.push(protection);
        }
      }
      if (batch.versions.some((version) => version.id === sourceVersionId)) {
        found = true;
      }
    });
    return {
      protections: buildContentStudioSourceVersionProtectionMap(protections),
      found,
    };
  }

  // The organization in one snapshot, handed over a batch of sources at a
  // time with all their versions and the references naming them. Every
  // reference must name a source of the organization, and the batches must
  // hold every version it has, or the whole organization fails. A dry run
  // is refused in the same snapshot when a version of the organization is
  // held for a plan, or it has too many versions, before any is read
  private evaluate(
    input: { organizationId: string },
    dryRun: boolean,
    use: (batch: Batch) => void
  ) {
    const organizationId = input.organizationId;
    return this._contentStudioSourceRetentionRepository.readSnapshot(
      async (reads) => {
        if (dryRun && (await reads.findPending(organizationId))) {
          throw new ContentStudioSourceRetentionDryRunError(
            'RETENTION_DRY_RUN_QUARANTINE_ACTIVE'
          );
        }
        const versionCount = await reads.countVersions(organizationId);
        if (dryRun) {
          assertContentStudioSourceVersionRetentionScale(versionCount);
        }

        const sources: Sources = [];
        await eachPage(
          (afterId, take) =>
            reads.listSources({ organizationId, afterId, take }),
          ROWS_PAGE_SIZE,
          (rows) => {
            for (const row of rows) {
              sources.push(row);
            }
          }
        );
        const sourceIds = new Set(sources.map((source) => source.id));

        const references = await this.references(
          reads,
          organizationId,
          sourceIds
        );

        let read = 0;
        for (
          let i = 0;
          i < sources.length;
          i += CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE
        ) {
          const batch = sources.slice(
            i,
            i + CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE
          );
          const versions = await reads.listVersionsOfSources({
            organizationId,
            sourceIds: batch.map((source) => source.id),
          });
          read += versions.length;
          use({
            sources: batch,
            versions,
            references: batch.flatMap(
              (source) => references.get(source.id) ?? []
            ),
          });
        }

        // a version not reached through a source of the organization: in
        // one snapshot only one whose source is another organization's.
        // Named by its id; were none found, by the organization's
        if (read !== versionCount) {
          const version = await reads.findVersionOfOtherOrganizationSource(
            organizationId
          );
          throw integrity(
            'ContentStudioSourceVersion',
            version ? version.id : organizationId
          );
        }
        return { sourceCount: sources.length, versionCount };
      }
    );
  }

  // Every reference of the organization's stored records, by the source it
  // names
  private async references(
    reads: Reads,
    organizationId: string,
    sourceIds: ReadonlySet<string>
  ) {
    const scoped =
      (type: ContentStudioSourceVersionProtectionReferenceType) =>
      (row: { id: string; organizationId: string }) => {
        if (row.organizationId !== organizationId) {
          throw integrity(type, row.id);
        }
      };

    const references = new Map<string, ContentStudioSourceVersionReference[]>();
    const refer = (
      reason: ContentStudioSourceVersionReference['reason'],
      referenceType: ContentStudioSourceVersionProtectionReferenceType,
      referenceId: string,
      refs: ReturnType<typeof distinctEvidence>
    ) => {
      for (const ref of refs) {
        // a source that is not the organization's: no version of it is
        if (!sourceIds.has(ref.sourceId)) {
          throw integrity(referenceType, referenceId);
        }
        const reference = { reason, referenceType, referenceId, ...ref };
        const list = references.get(ref.sourceId);
        if (list) {
          list.push(reference);
        } else {
          references.set(ref.sourceId, [reference]);
        }
      }
    };

    // the current draft of every package, archived ones too
    const draftScope = scoped('ContentPackage');
    await eachPage(
      (afterId, take) =>
        reads.listPackageDrafts({
          organizationId,
          afterId,
          take,
        }),
      DOCUMENTS_PAGE_SIZE,
      (rows) => {
        for (const row of rows) {
          draftScope(row);
          let evidence: ContentPackageClaimEvidenceV2[];
          try {
            evidence = contentPackageClaims(
              parseContentPackageDraft(JSON.parse(row.draft))
            ).flatMap((claim) => claim.evidence);
          } catch {
            throw integrity('ContentPackage', row.id);
          }
          refer(
            'DRAFT_EVIDENCE',
            'ContentPackage',
            row.id,
            distinctEvidence(evidence)
          );
        }
      }
    );

    // the reviews first, the revisions they review after: a revision is
    // never removed, so one a review names is always read
    const reviews: { id: string; packageRevisionId: string }[] = [];
    const reviewScope = scoped('ContentStudioReview');
    await eachPage(
      (afterId, take) =>
        reads.listPackageReviews({ organizationId, afterId, take }),
      ROWS_PAGE_SIZE,
      (rows) => {
        for (const row of rows) {
          reviewScope(row);
          if (!row.packageRevisionId) {
            throw integrity('ContentStudioReview', row.id);
          }
          reviews.push({
            id: row.id,
            packageRevisionId: row.packageRevisionId,
          });
        }
      }
    );

    // every revision of every package, each parsed once; a review's
    // evidence is its revision's
    const revisionEvidence = new Map<
      string,
      ReturnType<typeof distinctEvidence>
    >();
    const revisionScope = scoped('ContentPackageRevision');
    await eachPage(
      (afterId, take) =>
        reads.listPackageRevisions({
          organizationId,
          afterId,
          take,
        }),
      DOCUMENTS_PAGE_SIZE,
      (rows) => {
        for (const row of rows) {
          revisionScope(row);
          let evidence: ContentPackageClaimEvidenceV2[];
          try {
            evidence = contentPackageClaims(
              parseVerifiedContentPackageRevision(row)
            ).flatMap((claim) => claim.evidence);
          } catch {
            throw integrity('ContentPackageRevision', row.id);
          }
          const refs = distinctEvidence(evidence);
          revisionEvidence.set(row.id, refs);
          refer('REVISION_EVIDENCE', 'ContentPackageRevision', row.id, refs);
        }
      }
    );
    for (const review of reviews) {
      const refs = revisionEvidence.get(review.packageRevisionId);
      if (!refs) {
        throw integrity('ContentStudioReview', review.id);
      }
      refer('REVIEW_EVIDENCE', 'ContentStudioReview', review.id, refs);
    }

    // every AI operation, running, succeeded or failed: the sources its
    // prompt held. A design operation has none
    const operationScope = scoped('ContentStudioAIOperation');
    await eachPage(
      (afterId, take) =>
        reads.listOperationContexts({ organizationId, afterId, take }),
      DOCUMENTS_PAGE_SIZE,
      (rows) => {
        for (const row of rows) {
          operationScope(row);
          const context = parseContentStudioAIOperationContext(row.context);
          if (!context) {
            throw integrity('ContentStudioAIOperation', row.id);
          }
          refer(
            'AI_OPERATION',
            'ContentStudioAIOperation',
            row.id,
            distinctEvidence(context.sources ?? [])
          );
        }
      }
    );
    return references;
  }
}
