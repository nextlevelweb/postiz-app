'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type {
  ContentStudioReviewAction,
  ContentStudioReviewState,
  ContentStudioReviewTargetType,
  ContentStudioRevisionRequestStatus,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';
import type {
  ContentStudioReviewClaimStatus,
  ContentStudioReviewClaimSummary,
} from '@gitroom/nestjs-libraries/content-studio/review/review.claim';
import {
  ContentStudioRequestError,
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Reviews (P5-01): the review of exactly one saved, immutable revision of a
// package or a design. The browser loads the review of the revision it shows
// (by its type and id, never "the latest"), requests one, and moves it on
// with a fixed action. It never sends an organization, a user, a hash or a
// state: the server reads all of them itself. A review is not an approval.
// Its discussion (P5-02) is the review's own: comments, loaded only for a
// review that exists, and the formal revision request, loaded only once the
// review asked for changes. A request is resolved by the id of a saved newer
// revision, nothing else. Claim review (P5-03B) is a package review's own:
// the claims of exactly its revision with their assessments and evidence,
// all as the server read and verified them (the browser never looks a
// source version up for it), and an assessment sends a status and a
// finding only

interface ContentStudioReviewPerson {
  id: string;
  name: string | null;
}

export interface ContentStudioReview {
  id: string;
  targetType: ContentStudioReviewTargetType;
  targetRevisionId: string;
  targetRevisionNumber: number;
  targetContentHash: string;
  state: ContentStudioReviewState;
  version: number;
  requestedBy: ContentStudioReviewPerson;
  createdAt: string;
  updatedAt: string;
  events: {
    sequence: number;
    fromState: ContentStudioReviewState | null;
    toState: ContentStudioReviewState;
    actor: ContentStudioReviewPerson;
    createdAt: string;
  }[];
}

export interface ContentStudioReviewComment {
  id: string;
  body: string;
  author: ContentStudioReviewPerson;
  createdAt: string;
  editedAt: string | null;
}

export interface ContentStudioRevisionRequest {
  id: string;
  body: string;
  status: ContentStudioRevisionRequestStatus;
  requestedBy: ContentStudioReviewPerson;
  createdAt: string;
  resolution: null | {
    revisionId: string;
    revisionNumber: number;
    contentHash: string;
    resolvedBy: ContentStudioReviewPerson;
    resolvedAt: string;
  };
}

// One grounded claim of the reviewed revision, its assessment and its exact
// evidence, as the server verified them
export interface ContentStudioReviewClaim {
  claimId: string;
  threadItemId: string;
  claimText: string;
  claimContentHash: string;
  status: ContentStudioReviewClaimStatus;
  finding: string | null;
  reviewedBy: ContentStudioReviewPerson | null;
  reviewedAt: string | null;
  evidence: {
    source: { id: string; name: string };
    version: {
      id: string;
      versionNumber: number;
      title: string | null;
      contentHash: string;
      fetchedAt: string;
    };
    block: { id: string; type: string; text: string };
    quote: string | null;
  }[];
}

export interface ContentStudioReviewClaimList {
  reviewId: string;
  reviewState: ContentStudioReviewState;
  reviewVersion: number;
  summary: ContentStudioReviewClaimSummary;
  claims: ContentStudioReviewClaim[];
}

export const REVIEWS_PATH = '/content-studio/reviews';
const reviewPath = (id: string) => `${REVIEWS_PATH}/${encodeURIComponent(id)}`;
export const reviewCommentsPath = (id: string, page: number) =>
  `${reviewPath(id)}/comments?page=${page}`;
export const reviewRevisionRequestPath = (id: string) =>
  `${reviewPath(id)}/revision-request`;
export const reviewClaimsPath = (id: string) => `${reviewPath(id)}/claims`;
export const reviewForRevisionPath = (
  targetType: ContentStudioReviewTargetType,
  revisionId: string
) =>
  `${REVIEWS_PATH}?targetType=${targetType}&targetRevisionId=${encodeURIComponent(
    revisionId
  )}`;

// The review of exactly this revision, or null when it has none. A revision
// has at most one; anything that is not about this very revision is refused
export const useContentStudioReviewForRevision = (
  targetType: ContentStudioReviewTargetType,
  revisionId: string
) => {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string) => {
      const list = await request<{
        pages: number;
        results: ContentStudioReview[];
      }>(fetch, path);
      const review = list.results[0] ?? null;
      if (
        list.results.length > 1 ||
        (review &&
          (review.targetType !== targetType ||
            review.targetRevisionId !== revisionId))
      ) {
        throw new ContentStudioRequestError(500, 'CS_REVIEW_INTEGRITY_ERROR');
      }
      return review;
    },
    [fetch, targetType, revisionId]
  );
  return useSWR(
    reviewForRevisionPath(targetType, revisionId),
    load,
    swrOptions
  );
};

// One page of the review's comments, oldest first; nothing without a review
export const useContentStudioReviewComments = (
  reviewId: string | null,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) =>
      request<{ pages: number; results: ContentStudioReviewComment[] }>(
        fetch,
        path
      ),
    [fetch]
  );
  return useSWR(
    reviewId ? reviewCommentsPath(reviewId, page) : null,
    load,
    swrOptions
  );
};

// The formal revision request of a review that asked for changes, or null
// when that review has none (one from before revision requests existed)
export const useContentStudioReviewRevisionRequest = (
  reviewId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string) => {
      try {
        return await request<ContentStudioRevisionRequest>(fetch, path);
      } catch (err) {
        if (designErrorCode(err) === 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND') {
          return null;
        }
        throw err;
      }
    },
    [fetch]
  );
  return useSWR(
    reviewId ? reviewRevisionRequestPath(reviewId) : null,
    load,
    swrOptions
  );
};

// The claims of a package review, or nothing without one. An answer about
// another review is refused
export const useContentStudioReviewClaims = (reviewId: string | null) => {
  const fetch = useFetch();
  const load = useCallback(
    async (path: string) => {
      const list = await request<ContentStudioReviewClaimList>(fetch, path);
      if (list.reviewId !== reviewId) {
        throw new ContentStudioRequestError(500, 'CS_REVIEW_INTEGRITY_ERROR');
      }
      return list;
    },
    [fetch, reviewId]
  );
  return useSWR(reviewId ? reviewClaimsPath(reviewId) : null, load, swrOptions);
};

// Review writes: one request each, never retried; each reloads the reviews
// shown and their discussion. Nothing is edited in the cache by hand
export const useContentStudioReviewActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the review stays shown while it reloads
  const refresh = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith(`${REVIEWS_PATH}?`) ||
            key.startsWith(`${REVIEWS_PATH}/`))
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      refresh,
      // the exact saved revision, by its type and id only
      requestReview: async (
        targetType: ContentStudioReviewTargetType,
        revisionId: string
      ) => {
        const review = await request<ContentStudioReview>(fetch, REVIEWS_PATH, {
          method: 'POST',
          body: JSON.stringify({
            targetType,
            targetRevisionId: revisionId,
          }),
        });
        await refresh();
        return review;
      },
      // the route is the action; there is no body. Request changes is not
      // one of these: it always sends its revision request
      transitionReview: async (
        id: string,
        action: Exclude<ContentStudioReviewAction, 'request-changes'>
      ) => {
        const review = await request<ContentStudioReview>(
          fetch,
          `${reviewPath(id)}/${action}`,
          { method: 'POST' }
        );
        await refresh();
        return review;
      },
      // what must change, as plain text only
      requestChanges: async (id: string, body: string) => {
        const review = await request<ContentStudioReview>(
          fetch,
          `${reviewPath(id)}/request-changes`,
          { method: 'POST', body: JSON.stringify({ body }) }
        );
        await refresh();
        return review;
      },
      postComment: async (reviewId: string, body: string) => {
        const comment = await request<ContentStudioReviewComment>(
          fetch,
          `${reviewPath(reviewId)}/comments`,
          { method: 'POST', body: JSON.stringify({ body }) }
        );
        await refresh();
        return comment;
      },
      editComment: async (
        reviewId: string,
        commentId: string,
        body: string
      ) => {
        const comment = await request<ContentStudioReviewComment>(
          fetch,
          `${reviewPath(reviewId)}/comments/${encodeURIComponent(commentId)}`,
          { method: 'PATCH', body: JSON.stringify({ body }) }
        );
        await refresh();
        return comment;
      },
      // the whole assessment of one claim: its status and finding only. The
      // reviewer, time and claim hash are the server's
      assessClaim: async (
        reviewId: string,
        claimId: string,
        status: ContentStudioReviewClaimStatus,
        finding: string | null
      ) => {
        const list = await request<ContentStudioReviewClaimList>(
          fetch,
          `${reviewClaimsPath(reviewId)}/${encodeURIComponent(claimId)}`,
          { method: 'PUT', body: JSON.stringify({ status, finding }) }
        );
        await refresh();
        return list;
      },
      // the exact saved revision, by its id only: the server knows its type
      resolveRevisionRequest: async (
        reviewId: string,
        resolutionRevisionId: string
      ) => {
        const revisionRequest = await request<ContentStudioRevisionRequest>(
          fetch,
          `${reviewRevisionRequestPath(reviewId)}/resolve`,
          {
            method: 'POST',
            body: JSON.stringify({ resolutionRevisionId }),
          }
        );
        await refresh();
        return revisionRequest;
      },
    }),
    [fetch, refresh]
  );
};

// --- messages: fixed text for every outcome, never a server message ---

type Translate = (key: string, fallback: string) => string;

export const reviewErrorMessage = (t: Translate, error: unknown) => {
  switch (designErrorCode(error)) {
    case 'CS_REVIEW_ALREADY_EXISTS':
      return t(
        'content_studio_review_error_exists',
        'This revision already has a review.'
      );
    case 'CS_REVIEW_INVALID_TRANSITION':
    case 'CS_REVIEW_CONFLICT':
      return t(
        'content_studio_review_error_state',
        'This review has changed. Check its current state and try again.'
      );
    case 'CS_REVIEW_CANCELLED':
      return t(
        'content_studio_review_error_cancelled',
        'This review was cancelled: its discussion is closed.'
      );
    case 'CS_REVIEW_COMMENT_INVALID':
      return t(
        'content_studio_review_error_comment_invalid',
        'Write a comment of at most 10,000 characters.'
      );
    case 'CS_REVIEW_COMMENT_FORBIDDEN':
      return t(
        'content_studio_review_error_comment_forbidden',
        'Only its author can edit a comment.'
      );
    case 'CS_REVIEW_COMMENT_NOT_FOUND':
      return t(
        'content_studio_review_error_comment_missing',
        'This comment is no longer available.'
      );
    case 'CS_REVIEW_REVISION_REQUEST_INVALID':
      return t(
        'content_studio_review_error_request_invalid',
        'Describe what needs to change, in at most 20,000 characters.'
      );
    case 'CS_REVIEW_REVISION_REQUEST_INVALID_RESOLUTION':
      return t(
        'content_studio_review_error_resolution',
        'Choose a newer saved revision of the same package or design.'
      );
    case 'CS_REVIEW_REVISION_REQUEST_CONFLICT':
    case 'CS_REVIEW_REVISION_REQUEST_ALREADY_EXISTS':
    case 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND':
      return t(
        'content_studio_review_error_request_state',
        'This revision request has changed. Check its current state and try again.'
      );
    case 'CS_REVIEW_TARGET_NOT_FOUND':
      return t(
        'content_studio_review_error_target',
        'The revision to review is no longer available.'
      );
    case 'CS_REVIEW_CLAIMS_UNAVAILABLE':
      return t(
        'content_studio_review_error_claims_unavailable',
        'Claim review is only available for content package reviews.'
      );
    case 'CS_REVIEW_CLAIM_NOT_FOUND':
      return t(
        'content_studio_review_error_claim_missing',
        'This claim is not part of the reviewed version.'
      );
    case 'CS_REVIEW_CLAIM_INVALID':
      return t(
        'content_studio_review_error_claim_invalid',
        'A claim that needs revision needs a finding of at most 10,000 characters.'
      );
    case 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN':
      return t(
        'content_studio_review_error_claim_frozen',
        'Claims can only be assessed while the review is in review.'
      );
    case 'CS_REVIEW_CLAIMS_INCOMPLETE':
      return t(
        'content_studio_review_claims_incomplete',
        'Review every grounded claim before marking this revision ready for approval.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_review_not_found', 'Review not found.');
    case 'CS_REVIEW_INTEGRITY_ERROR':
      return t(
        'content_studio_review_error_integrity',
        'Stored review data could not be read safely.'
      );
    default:
      return t(
        'content_studio_review_error',
        'The review action could not be completed.'
      );
  }
};
