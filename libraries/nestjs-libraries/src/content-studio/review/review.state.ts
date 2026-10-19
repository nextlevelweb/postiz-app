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

// The one transition each action asks for. CHANGES_REQUESTED carries no
// reason here: the revision request that says why is a later step (P5-02)
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
