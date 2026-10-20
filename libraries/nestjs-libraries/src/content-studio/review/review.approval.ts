import {
  CONTENT_STUDIO_REVIEW_STATES,
  ContentStudioReviewState,
  isContentStudioReviewState,
  isContentStudioReviewText,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';

// Approval decisions (P5-04): what was decided about exactly the revision a
// review made ready for approval. Not a review state: the review stays
// READY_FOR_APPROVAL whatever is decided. Every decision is its own row,
// only ever appended: APPROVED or REFUSED, and WITHDRAWN to take back the
// one in force. The current approval state is derived from that history
// alone, never stored. Pure and dependency-free: the server checks every
// decision and every stored history with it and the editor uses it to offer
// the matching actions only

export const CONTENT_STUDIO_APPROVAL_DECISIONS = [
  'APPROVED',
  'REFUSED',
  'WITHDRAWN',
] as const;
export type ContentStudioApprovalDecision =
  (typeof CONTENT_STUDIO_APPROVAL_DECISIONS)[number];

// PENDING is derived: no decision yet, or the last one was withdrawn
export const CONTENT_STUDIO_APPROVAL_STATES = [
  'PENDING',
  'APPROVED',
  'REFUSED',
] as const;
export type ContentStudioApprovalState =
  (typeof CONTENT_STUDIO_APPROVAL_STATES)[number];

// The one decision each action appends
export const CONTENT_STUDIO_APPROVAL_ACTIONS = {
  approve: 'APPROVED',
  refuse: 'REFUSED',
  withdraw: 'WITHDRAWN',
} as const;
export type ContentStudioApprovalAction =
  keyof typeof CONTENT_STUDIO_APPROVAL_ACTIONS;

// Counted in UTF-16 code units, like the review texts
export const CONTENT_STUDIO_APPROVAL_NOTE_MAX = 10_000;

// What may be decided in each state. A decision in force is never replaced
// directly: it is withdrawn first, so the history says so
const DECISIONS: Record<
  ContentStudioApprovalState,
  readonly ContentStudioApprovalDecision[]
> = {
  PENDING: ['APPROVED', 'REFUSED'],
  APPROVED: ['WITHDRAWN'],
  REFUSED: ['WITHDRAWN'],
};

// Exact, case-sensitive names only
export const isContentStudioApprovalDecision = (
  value: unknown
): value is ContentStudioApprovalDecision =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_APPROVAL_DECISIONS as readonly string[]).includes(value);

export const isContentStudioApprovalState = (
  value: unknown
): value is ContentStudioApprovalState =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_APPROVAL_STATES as readonly string[]).includes(value);

export const isContentStudioApprovalAction = (
  value: unknown
): value is ContentStudioApprovalAction =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(CONTENT_STUDIO_APPROVAL_ACTIONS, value);

// Only a review that is ready for approval has an approval: before that
// there is nothing to decide on, and READY_FOR_APPROVAL is final
export const isContentStudioApprovalAvailable = (
  state: ContentStudioReviewState
) => state === 'READY_FOR_APPROVAL';

// Unknown states and decisions never pass
export const canDecideContentStudioApproval = (
  state: unknown,
  decision: unknown
) =>
  isContentStudioApprovalState(state) &&
  isContentStudioApprovalDecision(decision) &&
  DECISIONS[state].includes(decision);

// The state a decision leaves the approval in
export const contentStudioApprovalStateAfter = (
  decision: ContentStudioApprovalDecision
): ContentStudioApprovalState =>
  decision === 'WITHDRAWN' ? 'PENDING' : decision;

// The actions open in a state, in a fixed order
export const contentStudioApprovalActions = (
  state: unknown
): ContentStudioApprovalAction[] =>
  (
    Object.keys(
      CONTENT_STUDIO_APPROVAL_ACTIONS
    ) as ContentStudioApprovalAction[]
  ).filter((action) =>
    canDecideContentStudioApproval(
      state,
      CONTENT_STUDIO_APPROVAL_ACTIONS[action]
    )
  );

export interface ContentStudioApprovalDecisionFacts {
  sequence: number;
  decision: unknown;
}

// The current state and version (the number of decisions) of a history in
// sequence order, or null when it is not intact: sequences 1, 2, 3...
// without a gap, every decision known and possible in the state before it
export const contentStudioApprovalStatus = (
  history: readonly ContentStudioApprovalDecisionFacts[]
): { state: ContentStudioApprovalState; version: number } | null => {
  let state: ContentStudioApprovalState = 'PENDING';
  for (let index = 0; index < history.length; index++) {
    const { sequence, decision } = history[index];
    if (
      sequence !== index + 1 ||
      !isContentStudioApprovalDecision(decision) ||
      !canDecideContentStudioApproval(state, decision)
    ) {
      return null;
    }
    state = contentStudioApprovalStateAfter(decision);
  }
  return { state, version: history.length };
};

const isNote = (value: unknown): value is string =>
  isContentStudioReviewText(value, CONTENT_STUDIO_APPROVAL_NOTE_MAX);

// The note of a decision as it will be stored, or null when it is not
// valid. An approval may have one: a note left out, null or blank is none.
// Refusing and withdrawing must say why. A note is kept exactly as written
// (spaces and line breaks included)
export const parseContentStudioApprovalNote = (
  decision: ContentStudioApprovalDecision,
  note: unknown
): { note: string | null } | null => {
  if (decision !== 'APPROVED') {
    return isNote(note) ? { note } : null;
  }
  if (note === undefined || note === null) {
    return { note: null };
  }
  if (isNote(note)) {
    return { note };
  }
  // blank is none, but never one over the limit or with a NUL
  return typeof note === 'string' &&
    note.length <= CONTENT_STUDIO_APPROVAL_NOTE_MAX &&
    !note.includes('\0')
    ? { note: null }
    : null;
};

// A stored note is whole: none or text for an approval, text for the others
export const isContentStudioApprovalNoteIntact = (
  decision: ContentStudioApprovalDecision,
  note: unknown
) => (decision === 'APPROVED' && note === null) || isNote(note);

// Approval binding (P5-05): where exactly one immutable revision stands, from
// its one review and that review's approval. Never stored: derived each time
// from the review state and the approval state derived from the whole
// history. Only APPROVED is approved: a review that is ready for approval
// with no decision, or whose decision was withdrawn, is pending approval
export const CONTENT_STUDIO_REVISION_APPROVAL_STATES = [
  'NOT_REVIEWED',
  'REVIEW_REQUESTED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'REVIEW_CANCELLED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REFUSED',
] as const;
export type ContentStudioRevisionApprovalState =
  (typeof CONTENT_STUDIO_REVISION_APPROVAL_STATES)[number];

const REVIEW_BINDING: Record<
  Exclude<ContentStudioReviewState, 'READY_FOR_APPROVAL'>,
  ContentStudioRevisionApprovalState
> = {
  REQUESTED: 'REVIEW_REQUESTED',
  IN_REVIEW: 'IN_REVIEW',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  CANCELLED: 'REVIEW_CANCELLED',
};

const APPROVAL_BINDING: Record<
  ContentStudioApprovalState,
  ContentStudioRevisionApprovalState
> = {
  PENDING: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REFUSED: 'REFUSED',
};

// The binding state of a revision from the state of its review (null: it
// has none) and the approval state of that review (null: it has none), or
// null when the two cannot belong together: only a review that is ready for
// approval has an approval state, and it always has one
export const deriveContentStudioRevisionApprovalBindingState = (
  reviewState: unknown,
  approvalState: unknown
): ContentStudioRevisionApprovalState | null => {
  if (reviewState === null) {
    return approvalState === null ? 'NOT_REVIEWED' : null;
  }
  if (!isContentStudioReviewState(reviewState)) {
    return null;
  }
  if (reviewState === 'READY_FOR_APPROVAL') {
    return isContentStudioApprovalState(approvalState)
      ? APPROVAL_BINDING[approvalState]
      : null;
  }
  return approvalState === null ? REVIEW_BINDING[reviewState] : null;
};

export const isContentStudioRevisionApprovalState = (
  value: unknown
): value is ContentStudioRevisionApprovalState =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_REVISION_APPROVAL_STATES as readonly string[]).includes(
    value
  );

// The one answer to "is this revision approved?"
export const isContentStudioRevisionApproved = (state: unknown) =>
  state === 'APPROVED';

// The Review & Approval queue (P5-06): the reviews of an organization by the
// binding state their exact revision derives now, never by a stored status.
// Each queue is a set of binding states; a review's own state decides the
// non-approval ones, and the approval history of a review that is ready for
// approval decides whether it is pending, approved or refused now
export const CONTENT_STUDIO_REVIEW_QUEUES = [
  'NEEDS_REVIEW',
  'CHANGES_REQUESTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REFUSED',
  'CANCELLED',
] as const;
export type ContentStudioReviewQueue =
  (typeof CONTENT_STUDIO_REVIEW_QUEUES)[number];

export const CONTENT_STUDIO_REVIEW_QUEUE_STATES: Record<
  ContentStudioReviewQueue,
  readonly ContentStudioRevisionApprovalState[]
> = {
  NEEDS_REVIEW: ['REVIEW_REQUESTED', 'IN_REVIEW'],
  CHANGES_REQUESTED: ['CHANGES_REQUESTED'],
  PENDING_APPROVAL: ['PENDING_APPROVAL'],
  APPROVED: ['APPROVED'],
  REFUSED: ['REFUSED'],
  CANCELLED: ['REVIEW_CANCELLED'],
};

export const isContentStudioReviewQueue = (
  value: unknown
): value is ContentStudioReviewQueue =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_REVIEW_QUEUES as readonly string[]).includes(value);

// The review states whose reviews can have one of these binding states: the
// ones a database filter may narrow to before anything is derived
export const contentStudioReviewStatesOfBindingStates = (
  states: readonly ContentStudioRevisionApprovalState[]
): ContentStudioReviewState[] =>
  CONTENT_STUDIO_REVIEW_STATES.filter((reviewState) =>
    reviewState === 'READY_FOR_APPROVAL'
      ? CONTENT_STUDIO_APPROVAL_STATES.some((approvalState) =>
          states.includes(APPROVAL_BINDING[approvalState])
        )
      : states.includes(REVIEW_BINDING[reviewState])
  );

// Whether the review state alone cannot tell: some, but not every, approval
// state of a review that is ready for approval belongs to these binding
// states, so its approval history has to be derived first
export const isContentStudioApprovalDerivationNeeded = (
  states: readonly ContentStudioRevisionApprovalState[]
) => {
  const included = CONTENT_STUDIO_APPROVAL_STATES.filter((approvalState) =>
    states.includes(APPROVAL_BINDING[approvalState])
  ).length;
  return included > 0 && included < CONTENT_STUDIO_APPROVAL_STATES.length;
};

// A queue may be narrowed by part of the package or design name
export const CONTENT_STUDIO_REVIEW_QUEUE_SEARCH_MAX = 100;
