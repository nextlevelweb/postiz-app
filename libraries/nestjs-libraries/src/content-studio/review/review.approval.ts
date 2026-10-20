import {
  ContentStudioReviewState,
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
