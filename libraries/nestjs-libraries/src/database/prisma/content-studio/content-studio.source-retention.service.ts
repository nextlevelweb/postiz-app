import { HttpException, Injectable } from '@nestjs/common';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioReviewRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
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
  computeContentStudioSourceVersionProtectionMap,
  CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
  CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionProtectionReferenceType,
  ContentStudioSourceVersionReference,
  explainContentStudioSourceVersionProtection,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// A fixed message only, like any source version of another organization
const notFound = () =>
  new HttpException(
    { msg: 'Source version not found.', code: 'CS_NOT_FOUND' },
    404
  );

// Rows per read: small rows (sources, versions, reviews) and documents (a
// draft or revision is at most 64 KiB, an AI context 8 KiB)
const ROWS_PAGE_SIZE = 10_000;
const DOCUMENTS_PAGE_SIZE = 500;

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

// Source version protection (P8-R1A): which captured versions of one
// organization stored data still needs, and why. Internal only: no route,
// command, activity or schedule reaches it, and it never writes or removes
// anything. Every protection is decided by source.retention.ts from the
// organization's rows, read here in bounded pages by organization, one read
// per kind of record and page, never per version: its sources, versions,
// package drafts (archived too), reviews of package revisions, revisions and
// AI operations. The JSON is read with the parsers that wrote it; anything
// that does not parse, belongs to another organization or names a version
// that is not exactly there throws ContentStudioSourceRetentionIntegrityError
// for the whole organization. The reads are not one snapshot: a capture or
// save that runs meanwhile can only make an evaluation fail, never leave a
// version unprotected that the rows read protect. A version with no
// protection is eligible in principle only: whether history may be shortened
// at all is still a product decision (PD1)
@Injectable()
export class ContentStudioSourceRetentionService {
  constructor(
    private _contentStudioSourceRepository: ContentStudioSourceRepository,
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioReviewRepository: ContentStudioReviewRepository,
    private _contentStudioAIOperationRepository: ContentStudioAIOperationRepository
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
    const { protections, versionIds } = await this.protect(input);
    if (!versionIds.has(input.sourceVersionId)) {
      throw notFound();
    }
    return explainContentStudioSourceVersionProtection(
      protections,
      input.sourceVersionId
    );
  }

  private async protect(input: { organizationId: string; now: Date }) {
    const organizationId = input.organizationId;
    const scoped =
      (type: ContentStudioSourceVersionProtectionReferenceType) =>
      (row: { id: string; organizationId: string }) => {
        if (row.organizationId !== organizationId) {
          throw integrity(type, row.id);
        }
      };

    const sources: Awaited<
      ReturnType<
        ContentStudioSourceRepository['listSourcesForVersionProtection']
      >
    > = [];
    await eachPage(
      (afterId, take) =>
        this._contentStudioSourceRepository.listSourcesForVersionProtection({
          organizationId,
          afterId,
          take,
        }),
      ROWS_PAGE_SIZE,
      (rows) => {
        for (const row of rows) {
          sources.push(row);
        }
      }
    );

    const versions: Awaited<
      ReturnType<ContentStudioSourceRepository['listVersionsForProtection']>
    > = [];
    await eachPage(
      (afterId, take) =>
        this._contentStudioSourceRepository.listVersionsForProtection({
          organizationId,
          afterId,
          take,
        }),
      ROWS_PAGE_SIZE,
      (rows) => {
        for (const row of rows) {
          versions.push(row);
        }
      }
    );

    const references: ContentStudioSourceVersionReference[] = [];
    const refer = (
      reason: ContentStudioSourceVersionReference['reason'],
      referenceType: ContentStudioSourceVersionProtectionReferenceType,
      referenceId: string,
      refs: ReturnType<typeof distinctEvidence>
    ) => {
      for (const ref of refs) {
        references.push({ reason, referenceType, referenceId, ...ref });
      }
    };

    // the current draft of every package, archived ones too
    const draftScope = scoped('ContentPackage');
    await eachPage(
      (afterId, take) =>
        this._contentStudioRepository.listPackageDraftsForVersionProtection({
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
        this._contentStudioReviewRepository.listPackageReviewsForVersionProtection(
          { organizationId, afterId, take }
        ),
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
        this._contentStudioRepository.listPackageRevisionsForVersionProtection({
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
        this._contentStudioAIOperationRepository.listOperationContextsForVersionProtection(
          { organizationId, afterId, take }
        ),
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

    return {
      protections: computeContentStudioSourceVersionProtectionMap({
        organizationId,
        sources,
        versions,
        references,
        now: input.now,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
      }),
      versionIds: new Set(versions.map((version) => version.id)),
    };
  }
}
