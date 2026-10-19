// Content Studio review states (P5-01). A review is the workflow of looking at
// exactly one immutable revision (a Content Package revision or a Design
// revision) before the approval stage. It is not an approval:
// READY_FOR_APPROVAL only says the review is over and this exact revision
// may enter a later approval step. Nothing here approves, gates a handoff or
// publishes. Pure and dependency-free: the server checks every transition
// with it and the editor uses it to offer the matching actions only

export const CONTENT_STUDIO_REVIEW_STATES = [
  'REQUESTED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'READY_FOR_APPROVAL',
  'CANCELLED',
] as const;
export type ContentStudioReviewState =
  (typeof CONTENT_STUDIO_REVIEW_STATES)[number];

// What a review is about: the exact revision, never a package, a design or
// "the latest"
export const CONTENT_STUDIO_REVIEW_TARGET_TYPES = [
  'PACKAGE_REVISION',
  'DESIGN_REVISION',
] as const;
export type ContentStudioReviewTargetType =
  (typeof CONTENT_STUDIO_REVIEW_TARGET_TYPES)[number];

// The one transition each action asks for. request-changes is only ever
// taken together with the revision request that says what must change
// (P5-02): the server writes both in one transaction
export const CONTENT_STUDIO_REVIEW_ACTIONS = {
  start: 'IN_REVIEW',
  'request-changes': 'CHANGES_REQUESTED',
  'ready-for-approval': 'READY_FOR_APPROVAL',
  cancel: 'CANCELLED',
} as const;
export type ContentStudioReviewAction =
  keyof typeof CONTENT_STUDIO_REVIEW_ACTIONS;

// Every state a review may move to from each state. CHANGES_REQUESTED,
// READY_FOR_APPROVAL and CANCELLED are final: a new revision gets a review
// of its own instead
const TRANSITIONS: Record<
  ContentStudioReviewState,
  readonly ContentStudioReviewState[]
> = {
  REQUESTED: ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW: ['CHANGES_REQUESTED', 'READY_FOR_APPROVAL', 'CANCELLED'],
  CHANGES_REQUESTED: [],
  READY_FOR_APPROVAL: [],
  CANCELLED: [],
};

// A fixed message only
export class ContentStudioReviewTransitionError extends Error {
  constructor() {
    super('This Content Studio review cannot make that transition');
    this.name = 'ContentStudioReviewTransitionError';
  }
}

export const isContentStudioReviewState = (
  value: unknown
): value is ContentStudioReviewState =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_REVIEW_STATES as readonly string[]).includes(value);

export const isContentStudioReviewTargetType = (
  value: unknown
): value is ContentStudioReviewTargetType =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_REVIEW_TARGET_TYPES as readonly string[]).includes(value);

export const isContentStudioReviewAction = (
  value: unknown
): value is ContentStudioReviewAction =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(CONTENT_STUDIO_REVIEW_ACTIONS, value);

// Unknown states never transition
export const canTransitionContentStudioReview = (from: unknown, to: unknown) =>
  isContentStudioReviewState(from) &&
  isContentStudioReviewState(to) &&
  TRANSITIONS[from].includes(to);

// The state an action leads to from this state, or a
// ContentStudioReviewTransitionError
export const transitionContentStudioReviewState = (
  from: unknown,
  action: unknown
): ContentStudioReviewState => {
  if (!isContentStudioReviewAction(action)) {
    throw new ContentStudioReviewTransitionError();
  }
  const to = CONTENT_STUDIO_REVIEW_ACTIONS[action];
  if (!canTransitionContentStudioReview(from, to)) {
    throw new ContentStudioReviewTransitionError();
  }
  return to;
};

// The actions open in a state, in a fixed order; none for a final state
export const contentStudioReviewActions = (
  state: unknown
): ContentStudioReviewAction[] =>
  (
    Object.keys(CONTENT_STUDIO_REVIEW_ACTIONS) as ContentStudioReviewAction[]
  ).filter((action) =>
    canTransitionContentStudioReview(
      state,
      CONTENT_STUDIO_REVIEW_ACTIONS[action]
    )
  );

export interface ContentStudioReviewStateEventFacts {
  sequence: number;
  fromState: string | null;
  toState: string;
}

// The state history of a review is intact when its events, in sequence
// order, are 1, 2, 3... without a gap, the first one REQUESTED from nothing,
// every later one a legal transition from the state before it, and the last
// one is the review's current state and version
export const isContentStudioReviewHistoryIntact = (
  review: { state: unknown; version: unknown },
  events: readonly ContentStudioReviewStateEventFacts[]
) => {
  if (!events.length || events.length !== review.version) {
    return false;
  }
  let previous: string | null = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.sequence !== index + 1 || event.fromState !== previous) {
      return false;
    }
    if (
      index === 0
        ? event.toState !== 'REQUESTED'
        : !canTransitionContentStudioReview(previous, event.toState)
    ) {
      return false;
    }
    previous = event.toState;
  }
  return previous === review.state;
};

// The discussion of a review (P5-02): plain-text comments and the one formal
// revision request, both bound to the review and so to its exact revision.
// A cancelled review is frozen: nothing new is posted, edited, requested or
// resolved. Every other state stays open for discussion, the final ones
// included, and no comment ever moves the state
export const CONTENT_STUDIO_REVIEW_COMMENT_MAX = 10_000;
export const CONTENT_STUDIO_REVISION_REQUEST_MAX = 20_000;

// OPEN until a newer saved revision of the same package or design is named
// as the one that made the changes; then RESOLVED, for good
export const CONTENT_STUDIO_REVISION_REQUEST_STATUSES = [
  'OPEN',
  'RESOLVED',
] as const;
export type ContentStudioRevisionRequestStatus =
  (typeof CONTENT_STUDIO_REVISION_REQUEST_STATUSES)[number];

export const isContentStudioRevisionRequestStatus = (
  value: unknown
): value is ContentStudioRevisionRequestStatus =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_REVISION_REQUEST_STATUSES as readonly string[]).includes(
    value
  );

export const isContentStudioReviewDiscussionOpen = (state: unknown) =>
  isContentStudioReviewState(state) && state !== 'CANCELLED';

// Plain text as written: kept exactly, inner spaces and line breaks
// included, but never empty once trimmed, never longer than max and never
// with a NUL character
export const isContentStudioReviewText = (
  value: unknown,
  max: number
): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  value.trim().length > 0 &&
  !value.includes('\0');
