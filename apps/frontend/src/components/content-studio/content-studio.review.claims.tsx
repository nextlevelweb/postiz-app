'use client';

import { FC, FormEvent, useState } from 'react';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX,
  ContentStudioReviewClaimStatus,
  isContentStudioReviewClaimAssessable,
  parseContentStudioReviewClaimAssessment,
} from '@gitroom/nestjs-libraries/content-studio/review/review.claim';
import {
  ContentStudioReview,
  ContentStudioReviewClaim,
  ContentStudioReviewClaimList,
  reviewErrorMessage,
  useContentStudioReviewActions,
} from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Claims & evidence (P5-03B): every grounded claim of exactly the package
// revision under review, with what the reviewer concluded about it and the
// exact source passages it cites, as the server read and verified them. An
// assessment says whether a claim is adequately supported by its evidence:
// not that it is true and not an approval. Claims are assessed only while the
// review is in review; in every other state they are shown read-only. A claim
// that needs revision asks for nothing by itself: Request changes stays the
// review's own explicit step

type Translate = (key: string, fallback: string) => string;

const textareaClass =
  'bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0';
const when = (value: string) => dayjs(value).format('MMM D, YYYY HH:mm');

// Every status in words: never by color alone
export const claimStatusLabel = (
  t: Translate,
  status: ContentStudioReviewClaimStatus
) => {
  switch (status) {
    case 'VERIFIED':
      return t('content_studio_review_claim_verified', 'Verified');
    case 'NEEDS_REVISION':
      return t('content_studio_review_claim_needs_revision', 'Needs revision');
    default:
      return t('content_studio_review_claim_unreviewed', 'Unreviewed');
  }
};

// The exact passages a claim cites, from the stored source versions it names
const ClaimEvidence: FC<{ claim: ContentStudioReviewClaim }> = ({ claim }) => {
  const t = useT();
  return (
    <ul className="flex flex-col gap-[8px]">
      {claim.evidence.map((entry) => (
        <li
          key={`${entry.version.id}/${entry.block.id}`}
          data-review-evidence-version={entry.version.id}
          data-review-evidence-block={entry.block.id}
          className="flex flex-col gap-[4px] border border-newTableBorder rounded-[8px] p-[8px] text-[13px]"
        >
          <div className="font-[600] break-words">
            {[
              entry.source.name,
              entry.version.title,
              `${t('content_studio_ai_source_version', 'Version')} ${
                entry.version.versionNumber
              }`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {entry.quote !== null && (
            <blockquote className="border-s-[3px] border-newTableBorder ps-[8px] whitespace-pre-wrap break-words">
              {entry.quote}
            </blockquote>
          )}
          <div className="whitespace-pre-wrap break-words text-textItemBlur">
            {entry.block.text}
          </div>
        </li>
      ))}
    </ul>
  );
};

// Verified (finding optional) or needs revision (finding required)
const AssessmentForm: FC<{
  review: ContentStudioReview;
  claim: ContentStudioReviewClaim;
  status: 'VERIFIED' | 'NEEDS_REVISION';
  close: () => void;
}> = ({ review, claim, status, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioReviewActions();
  const [finding, setFinding] = useState(
    claim.status === status ? claim.finding ?? '' : ''
  );
  const [busy, setBusy] = useState(false);
  const assessment = parseContentStudioReviewClaimAssessment(
    status,
    finding || null
  );
  const label =
    status === 'VERIFIED'
      ? t('content_studio_review_claim_finding_optional', 'Finding (optional)')
      : t('content_studio_review_claim_finding_required', 'Finding (required)');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!assessment || busy) {
      return;
    }
    setBusy(true);
    try {
      await actions.assessClaim(
        review.id,
        claim.claimId,
        assessment.status,
        assessment.finding
      );
      close();
    } catch (err) {
      toaster.show(reviewErrorMessage(t, err), 'warning');
      await actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label={
        status === 'VERIFIED'
          ? t('content_studio_review_claim_mark_verified', 'Mark verified')
          : t(
              'content_studio_review_claim_mark_needs_revision',
              'Needs revision'
            )
      }
      className="flex flex-col gap-[8px]"
    >
      <label className="flex flex-col gap-[4px] text-[12px]">
        {label}
        <textarea
          className={textareaClass}
          value={finding}
          maxLength={CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX}
          onChange={(e) => setFinding(e.target.value)}
        />
      </label>
      {status === 'NEEDS_REVISION' && !assessment && (
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_review_claim_finding_needed',
            'Say what is wrong with this claim or its evidence.'
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-[8px]">
        <Button type="submit" loading={busy} disabled={!assessment || busy}>
          {status === 'VERIFIED'
            ? t('content_studio_review_claim_save_verified', 'Save as verified')
            : t(
                'content_studio_review_claim_save_needs_revision',
                'Save as needs revision'
              )}
        </Button>
        <Button secondary disabled={busy} onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
};

const ClaimCard: FC<{
  review: ContentStudioReview;
  claim: ContentStudioReviewClaim;
}> = ({ review, claim }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioReviewActions();
  const [open, setOpen] = useState(false);
  const [assessing, setAssessing] = useState<
    'VERIFIED' | 'NEEDS_REVISION' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const editable = isContentStudioReviewClaimAssessable(review.state);

  const reset = async () => {
    setBusy(true);
    try {
      await actions.assessClaim(review.id, claim.claimId, 'UNREVIEWED', null);
    } catch (err) {
      toaster.show(reviewErrorMessage(t, err), 'warning');
      await actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-review-claim={claim.claimId}
      data-review-claim-status={claim.status}
      className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
    >
      <div className="whitespace-pre-wrap break-words">{claim.claimText}</div>
      <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-[12px]">
        <span className="font-[600]">{claimStatusLabel(t, claim.status)}</span>
        <span className="text-textItemBlur">
          {t('content_studio_grounding_evidence_count', 'Evidence')}:{' '}
          {claim.evidence.length}
        </span>
        {claim.reviewedBy && claim.reviewedAt && (
          <span className="text-textItemBlur">
            {[claim.reviewedBy.name, when(claim.reviewedAt)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>
      {claim.finding !== null && (
        <div
          data-review-claim-finding=""
          className="whitespace-pre-wrap break-words text-[13px] border-s-[3px] border-newTableBorder ps-[8px]"
        >
          {claim.finding}
        </div>
      )}
      <div className="flex flex-wrap gap-[8px]">
        <Button
          secondary
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open
            ? t('content_studio_grounding_hide_evidence', 'Hide evidence')
            : t('content_studio_grounding_show_evidence', 'Show evidence')}
        </Button>
        {editable && !assessing && (
          <>
            <Button
              secondary
              disabled={busy}
              onClick={() => setAssessing('VERIFIED')}
            >
              {t('content_studio_review_claim_mark_verified', 'Mark verified')}
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={() => setAssessing('NEEDS_REVISION')}
            >
              {t(
                'content_studio_review_claim_mark_needs_revision',
                'Needs revision'
              )}
            </Button>
            {claim.status !== 'UNREVIEWED' && (
              <Button secondary loading={busy} disabled={busy} onClick={reset}>
                {t('content_studio_review_claim_reset', 'Reset to unreviewed')}
              </Button>
            )}
          </>
        )}
      </div>
      {editable && assessing && (
        <AssessmentForm
          review={review}
          claim={claim}
          status={assessing}
          close={() => setAssessing(null)}
        />
      )}
      {open && <ClaimEvidence claim={claim} />}
    </li>
  );
};

// The section: shown once opened, loaded through the review card's own
// request so the ready check and the list are the same answer
export const ContentStudioReviewClaims: FC<{
  review: ContentStudioReview;
  open: boolean;
  setOpen: (open: boolean) => void;
  claims: {
    data?: ContentStudioReviewClaimList;
    error?: unknown;
  };
}> = ({ review, open, setOpen, claims }) => {
  const t = useT();
  const list = claims.data?.reviewId === review.id ? claims.data : undefined;
  const summary = list?.summary;

  return (
    <section
      aria-label={t('content_studio_review_claims', 'Claims & evidence')}
      data-review-claims=""
      className="flex flex-col gap-[8px]"
    >
      <div className="flex flex-wrap items-center gap-[8px]">
        <h4 className="flex-1 font-[600] text-[14px]">
          {t('content_studio_review_claims', 'Claims & evidence')}
        </h4>
        <Button secondary aria-expanded={open} onClick={() => setOpen(!open)}>
          {open
            ? t('content_studio_review_hide_claims', 'Hide claims')
            : t('content_studio_review_show_claims', 'Show claims')}
        </Button>
      </div>
      {summary && (
        <dl
          data-review-claims-summary=""
          className="grid grid-cols-[auto_auto] gap-x-[12px] gap-y-[2px] text-[13px] w-fit"
        >
          <dt>{t('content_studio_review_claims_total', 'Total')}</dt>
          <dd data-count="total">{summary.total}</dd>
          <dt>{t('content_studio_review_claim_verified', 'Verified')}</dt>
          <dd data-count="verified">{summary.verified}</dd>
          <dt>
            {t('content_studio_review_claim_needs_revision', 'Needs revision')}
          </dt>
          <dd data-count="needsRevision">{summary.needsRevision}</dd>
          <dt>{t('content_studio_review_claim_unreviewed', 'Unreviewed')}</dt>
          <dd data-count="unreviewed">{summary.unreviewed}</dd>
        </dl>
      )}
      {open &&
        (claims.error ? (
          <div className="text-[13px]">
            {designErrorCode(claims.error) === 'CS_REVIEW_INTEGRITY_ERROR'
              ? reviewErrorMessage(t, claims.error)
              : t(
                  'content_studio_review_claims_load_error',
                  'The claims of this review could not be loaded.'
                )}
          </div>
        ) : !list ? (
          <LoadingComponent width={24} height={24} />
        ) : !list.claims.length ? (
          <div className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_grounding_none_revision',
              'No grounded claims were recorded in this revision.'
            )}
          </div>
        ) : (
          <>
            {!!summary?.needsRevision &&
              isContentStudioReviewClaimAssessable(review.state) && (
                <div className="text-[12px] text-textItemBlur">
                  {t(
                    'content_studio_review_claims_request_changes_hint',
                    'Use Request changes to formally send required changes back.'
                  )}
                </div>
              )}
            <ul className="flex flex-col gap-[8px]">
              {list.claims.map((claim) => (
                <ClaimCard key={claim.claimId} review={review} claim={claim} />
              ))}
            </ul>
          </>
        ))}
    </section>
  );
};
