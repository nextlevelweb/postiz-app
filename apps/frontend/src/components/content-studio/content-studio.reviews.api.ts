'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type {
  ContentStudioReviewAction,
  ContentStudioReviewState,
  ContentStudioReviewTargetType,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';
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
// state: the server reads all of them itself. A review is not an approval

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

export const REVIEWS_PATH = '/content-studio/reviews';
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

// Review writes: one request each, never retried; each reloads the reviews
// shown. Nothing is edited in the cache by hand
export const useContentStudioReviewActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the review stays shown while it reloads
  const refresh = useCallback(
    () =>
      mutate(
        (key) => typeof key === 'string' && key.startsWith(`${REVIEWS_PATH}?`)
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
      // the route is the action; there is no body
      transitionReview: async (
        id: string,
        action: ContentStudioReviewAction
      ) => {
        const review = await request<ContentStudioReview>(
          fetch,
          `${REVIEWS_PATH}/${encodeURIComponent(id)}/${action}`,
          { method: 'POST' }
        );
        await refresh();
        return review;
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
    case 'CS_REVIEW_TARGET_NOT_FOUND':
      return t(
        'content_studio_review_error_target',
        'The revision to review is no longer available.'
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
