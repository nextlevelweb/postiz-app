import {
  ContentStudioReviewState,
  isContentStudioReviewText,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';

// Claim review (P5-03B): the human assessment of each grounded claim of the
// exact package revision a review is about. The claims themselves are the
// revision's own grounding (P3-11); an assessment only says whether a
// reviewer found the claim adequately supported by its exact evidence. It
// is not an approval, not a fact check and not a statement that the claim
// is true. Pure and dependency-free: the server checks every assessment
// with it and the editor uses it to count and to offer the matching actions

export const CONTENT_STUDIO_REVIEW_CLAIM_STATUSES = [
  'UNREVIEWED',
  'VERIFIED',
  'NEEDS_REVISION',
] as const;
export type ContentStudioReviewClaimStatus =
  (typeof CONTENT_STUDIO_REVIEW_CLAIM_STATUSES)[number];

// Counted in UTF-16 code units, like the other review texts
export const CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX = 10_000;

// Exact, case-sensitive names only
export const isContentStudioReviewClaimStatus = (
  value: unknown
): value is ContentStudioReviewClaimStatus =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_REVIEW_CLAIM_STATUSES as readonly string[]).includes(value);

// Claims are assessed only while the review is in review: before it starts
// there is nothing to assess yet, and once it has a result its assessments
// are frozen with it
export const isContentStudioReviewClaimAssessable = (
  state: ContentStudioReviewState
) => state === 'IN_REVIEW';

const isFinding = (value: unknown): value is string =>
  isContentStudioReviewText(value, CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX);

// What a reviewer asks for, as it will be stored, or null when it is not a
// valid assessment. UNREVIEWED has no finding. VERIFIED may have one: a
// finding left out, null or blank is none. NEEDS_REVISION must say why.
// A finding is kept exactly as written (spaces and line breaks included)
export const parseContentStudioReviewClaimAssessment = (
  status: unknown,
  finding: unknown
): {
  status: ContentStudioReviewClaimStatus;
  finding: string | null;
} | null => {
  if (!isContentStudioReviewClaimStatus(status)) {
    return null;
  }
  const none =
    finding === undefined ||
    finding === null ||
    (typeof finding === 'string' && !finding.trim());
  switch (status) {
    case 'UNREVIEWED':
      return finding === undefined || finding === null
        ? { status, finding: null }
        : null;
    case 'VERIFIED':
      if (none) {
        return typeof finding === 'string' &&
          (finding.length > CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX ||
            finding.includes('\0'))
          ? null
          : { status, finding: null };
      }
      return isFinding(finding) ? { status, finding } : null;
    case 'NEEDS_REVISION':
      return isFinding(finding) ? { status, finding } : null;
  }
};

// A stored assessment is whole: UNREVIEWED has no finding, reviewer or time;
// VERIFIED and NEEDS_REVISION have both a reviewer and a time, and
// NEEDS_REVISION its finding. Anything else is malformed and never repaired
export const isContentStudioReviewClaimAssessmentIntact = (row: {
  status: unknown;
  finding: unknown;
  reviewedByUserId: unknown;
  reviewedAt: unknown;
}) => {
  if (!isContentStudioReviewClaimStatus(row.status)) {
    return false;
  }
  if (row.status === 'UNREVIEWED') {
    return (
      row.finding === null &&
      row.reviewedByUserId === null &&
      row.reviewedAt === null
    );
  }
  const reviewed =
    typeof row.reviewedByUserId === 'string' &&
    !!row.reviewedByUserId &&
    row.reviewedAt instanceof Date &&
    !Number.isNaN(row.reviewedAt.getTime());
  return row.status === 'VERIFIED'
    ? reviewed && (row.finding === null || isFinding(row.finding))
    : reviewed && isFinding(row.finding);
};

export interface ContentStudioReviewClaimSummary {
  total: number;
  verified: number;
  needsRevision: number;
  unreviewed: number;
  complete: boolean;
}

// The counts of the exact claims of a revision. A claim without an
// assessment is UNREVIEWED. Complete means every claim is VERIFIED, and a
// revision without claims is complete. Assessments of other claims are not
// counted here: the server refuses them as an integrity error first
export const contentStudioReviewClaimSummary = (
  claimIds: readonly string[],
  statuses: ReadonlyMap<string, ContentStudioReviewClaimStatus>
): ContentStudioReviewClaimSummary => {
  const of = (id: string) => statuses.get(id) ?? 'UNREVIEWED';
  const verified = claimIds.filter((id) => of(id) === 'VERIFIED').length;
  const needsRevision = claimIds.filter(
    (id) => of(id) === 'NEEDS_REVISION'
  ).length;
  return {
    total: claimIds.length,
    verified,
    needsRevision,
    unreviewed: claimIds.length - verified - needsRevision,
    complete: verified === claimIds.length,
  };
};
