import { Injectable } from '@nestjs/common';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import {
  ContentPackageClaimEvidenceV2,
  ContentPackageDraft,
  contentPackageClaims,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  ContentStudioSourceBlock,
  ContentStudioSourceContentV1,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { parseVerifiedContentStudioSourceVersion } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

export type ContentStudioGroundingErrorCode = 'INVALID' | 'INTEGRITY';

// INVALID: a piece of evidence names no version of this organization, or
// another source, number or hash than the version has, or a block or quote
// the version does not hold. A version of another organization is the same
// INVALID as a missing one. INTEGRITY: a version that was found is not
// exactly what was stored. Never an id, a quote or source text
export class ContentStudioGroundingError extends Error {
  constructor(readonly code: ContentStudioGroundingErrorCode) {
    super(
      code === 'INVALID'
        ? 'Content Studio grounding evidence does not match its source version'
        : 'A source version used as evidence failed its integrity check'
    );
    this.name = 'ContentStudioGroundingError';
  }
}

// One piece of evidence with what it points at: its source by name, the
// exact version it names (never the source's current one) and the block
// itself
export interface ContentStudioResolvedEvidence {
  evidence: ContentPackageClaimEvidenceV2;
  source: {
    id: string;
    name: string;
  };
  version: {
    id: string;
    sourceId: string;
    versionNumber: number;
    contentHash: string;
    title: string | null;
    fetchedAt: Date;
  };
  block: ContentStudioSourceBlock;
}

// Checks grounding evidence against the source versions it names, through
// the organization-scoped lookup only, and never changes anything: no
// source is fetched, refreshed or re-extracted, and a version that moved on
// is never replaced by the newer one. Each distinct version is read and
// verified once per call. An archived source keeps its versions, so its
// evidence stays valid
@Injectable()
export class ContentStudioGroundingService {
  constructor(
    private _contentStudioSourceRepository: ContentStudioSourceRepository
  ) {}

  // Every piece of evidence of every claim of the draft, or nothing for a
  // draft without claims. Throws ContentStudioGroundingError
  async verifyDraftGrounding(
    organizationId: string,
    draft: ContentPackageDraft
  ) {
    const evidence = contentPackageClaims(draft).flatMap(
      (claim) => claim.evidence
    );
    if (evidence.length) {
      await this.resolveEvidence(organizationId, evidence);
    }
  }

  // Each piece of evidence, in order, with its exact version and block.
  // Throws ContentStudioGroundingError
  async resolveEvidence(
    organizationId: string,
    evidence: readonly ContentPackageClaimEvidenceV2[]
  ): Promise<ContentStudioResolvedEvidence[]> {
    const ids = [...new Set(evidence.map((entry) => entry.versionId))];
    const rows = ids.length
      ? await this._contentStudioSourceRepository.getVersionsByIdsForOrganization(
          organizationId,
          ids
        )
      : [];
    const versions = new Map(rows.map((row) => [row.id, row]));
    const contents = new Map<string, ContentStudioSourceContentV1>();

    return evidence.map((entry) => {
      const row = versions.get(entry.versionId);
      if (
        !row ||
        row.sourceId !== entry.sourceId ||
        row.versionNumber !== entry.versionNumber ||
        row.contentHash !== entry.contentHash
      ) {
        throw new ContentStudioGroundingError('INVALID');
      }
      let content = contents.get(row.id);
      if (!content) {
        try {
          content = parseVerifiedContentStudioSourceVersion(row);
        } catch {
          throw new ContentStudioGroundingError('INTEGRITY');
        }
        contents.set(row.id, content);
      }
      const block = content.blocks.find((item) => item.id === entry.blockId);
      if (
        !block ||
        (entry.quote !== null && !block.text.includes(entry.quote))
      ) {
        throw new ContentStudioGroundingError('INVALID');
      }
      return {
        evidence: { ...entry },
        source: {
          id: row.sourceId,
          name: row.source.name,
        },
        version: {
          id: row.id,
          sourceId: row.sourceId,
          versionNumber: row.versionNumber,
          contentHash: row.contentHash,
          title: row.title,
          fetchedAt: row.fetchedAt,
        },
        block: { ...block },
      };
    });
  }
}
