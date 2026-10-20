import {
  canDecideContentStudioApproval,
  CONTENT_STUDIO_APPROVAL_ACTIONS,
  CONTENT_STUDIO_APPROVAL_DECISIONS,
  CONTENT_STUDIO_APPROVAL_NOTE_MAX,
  CONTENT_STUDIO_APPROVAL_STATES,
  CONTENT_STUDIO_REVIEW_QUEUE_STATES,
  CONTENT_STUDIO_REVIEW_QUEUES,
  contentStudioApprovalActions,
  contentStudioApprovalStateAfter,
  contentStudioApprovalStatus,
  contentStudioReviewStatesOfBindingStates,
  CONTENT_STUDIO_REVISION_APPROVAL_STATES,
  deriveContentStudioRevisionApprovalBindingState,
  isContentStudioApprovalAction,
  isContentStudioApprovalAvailable,
  isContentStudioApprovalDecision,
  isContentStudioApprovalDerivationNeeded,
  isContentStudioApprovalNoteIntact,
  isContentStudioReviewQueue,
  isContentStudioRevisionApprovalState,
  isContentStudioRevisionApproved,
  parseContentStudioApprovalNote,
} from '@gitroom/nestjs-libraries/content-studio/review/review.approval';
import { CONTENT_STUDIO_REVIEW_STATES } from '@gitroom/nestjs-libraries/content-studio/review/review.state';

const history = (...decisions: string[]) =>
  decisions.map((decision, index) => ({ sequence: index + 1, decision }));

describe('approval decisions and states (P5-04)', () => {
  it('has exactly three decisions and three derived states, matched exactly', () => {
    expect(CONTENT_STUDIO_APPROVAL_DECISIONS).toEqual([
      'APPROVED',
      'REFUSED',
      'WITHDRAWN',
    ]);
    expect(CONTENT_STUDIO_APPROVAL_STATES).toEqual([
      'PENDING',
      'APPROVED',
      'REFUSED',
    ]);
    expect(CONTENT_STUDIO_APPROVAL_ACTIONS).toEqual({
      approve: 'APPROVED',
      refuse: 'REFUSED',
      withdraw: 'WITHDRAWN',
    });
    for (const value of [
      'approved',
      'PENDING',
      'REJECTED',
      'CHANGES_REQUESTED',
      ' APPROVED',
      'constructor',
      '',
      null,
      undefined,
      1,
    ]) {
      expect(isContentStudioApprovalDecision(value)).toBe(false);
    }
    for (const value of ['reject', 'set', 'toString', 'APPROVED', '', null]) {
      expect(isContentStudioApprovalAction(value)).toBe(false);
    }
  });

  it('P504-1 approval is not a review state: only READY_FOR_APPROVAL has one', () => {
    expect(CONTENT_STUDIO_REVIEW_STATES).not.toContain('APPROVED');
    expect(
      CONTENT_STUDIO_REVIEW_STATES.filter(isContentStudioApprovalAvailable)
    ).toEqual(['READY_FOR_APPROVAL']);
  });
});

describe('the current approval state (P5-04)', () => {
  it('AD1 no history is PENDING at version 0', () => {
    expect(contentStudioApprovalStatus([])).toEqual({
      state: 'PENDING',
      version: 0,
    });
  });

  it('AD2 APPROVED is APPROVED', () => {
    expect(contentStudioApprovalStatus(history('APPROVED'))).toEqual({
      state: 'APPROVED',
      version: 1,
    });
  });

  it('AD3 REFUSED is REFUSED', () => {
    expect(contentStudioApprovalStatus(history('REFUSED'))).toEqual({
      state: 'REFUSED',
      version: 1,
    });
  });

  it('AD4 APPROVED then WITHDRAWN is PENDING', () => {
    expect(
      contentStudioApprovalStatus(history('APPROVED', 'WITHDRAWN'))
    ).toEqual({ state: 'PENDING', version: 2 });
  });

  it('AD5 REFUSED then WITHDRAWN is PENDING', () => {
    expect(
      contentStudioApprovalStatus(history('REFUSED', 'WITHDRAWN'))
    ).toEqual({ state: 'PENDING', version: 2 });
  });

  it('the last decision is the current one, whatever came before', () => {
    expect(
      contentStudioApprovalStatus(
        history('APPROVED', 'WITHDRAWN', 'REFUSED', 'WITHDRAWN', 'APPROVED')
      )
    ).toEqual({ state: 'APPROVED', version: 5 });
  });

  it('AD14/M4 a sequence that does not start at 1, has a gap or repeats is not intact', () => {
    for (const rows of [
      [{ sequence: 2, decision: 'APPROVED' }],
      [{ sequence: 0, decision: 'APPROVED' }],
      [
        { sequence: 1, decision: 'APPROVED' },
        { sequence: 3, decision: 'WITHDRAWN' },
      ],
      [
        { sequence: 1, decision: 'APPROVED' },
        { sequence: 1, decision: 'WITHDRAWN' },
      ],
      // out of order is not reordered
      [
        { sequence: 2, decision: 'WITHDRAWN' },
        { sequence: 1, decision: 'APPROVED' },
      ],
    ]) {
      expect(contentStudioApprovalStatus(rows)).toBe(null);
    }
  });

  it('AD15 an unknown decision is not intact', () => {
    for (const decision of ['REJECTED', 'approved', 'PENDING', '', null, 1]) {
      expect(contentStudioApprovalStatus([{ sequence: 1, decision }])).toBe(
        null
      );
    }
  });

  it('a decision that was not possible when it was made is not intact', () => {
    for (const rows of [
      history('WITHDRAWN'),
      history('APPROVED', 'REFUSED'),
      history('APPROVED', 'APPROVED'),
      history('REFUSED', 'APPROVED'),
      history('REFUSED', 'REFUSED'),
      history('APPROVED', 'WITHDRAWN', 'WITHDRAWN'),
    ]) {
      expect(contentStudioApprovalStatus(rows)).toBe(null);
    }
  });
});

describe('legal approval decisions (P5-04)', () => {
  it('AD6 PENDING -> APPROVED', () => {
    expect(canDecideContentStudioApproval('PENDING', 'APPROVED')).toBe(true);
  });

  it('AD7 PENDING -> REFUSED', () => {
    expect(canDecideContentStudioApproval('PENDING', 'REFUSED')).toBe(true);
  });

  it('AD8/M1 PENDING -> WITHDRAWN is not possible', () => {
    expect(canDecideContentStudioApproval('PENDING', 'WITHDRAWN')).toBe(false);
  });

  it('AD9 APPROVED -> WITHDRAWN', () => {
    expect(canDecideContentStudioApproval('APPROVED', 'WITHDRAWN')).toBe(true);
  });

  it('AD10/M2 APPROVED -> REFUSED directly is not possible', () => {
    expect(canDecideContentStudioApproval('APPROVED', 'REFUSED')).toBe(false);
  });

  it('AD11/M3 APPROVED -> APPROVED is not possible', () => {
    expect(canDecideContentStudioApproval('APPROVED', 'APPROVED')).toBe(false);
  });

  it('AD12 REFUSED -> WITHDRAWN', () => {
    expect(canDecideContentStudioApproval('REFUSED', 'WITHDRAWN')).toBe(true);
  });

  it('AD13 REFUSED -> APPROVED and REFUSED -> REFUSED are not possible', () => {
    expect(canDecideContentStudioApproval('REFUSED', 'APPROVED')).toBe(false);
    expect(canDecideContentStudioApproval('REFUSED', 'REFUSED')).toBe(false);
  });

  it('unknown states and decisions are never possible', () => {
    for (const [state, decision] of [
      ['WITHDRAWN', 'APPROVED'],
      ['approved', 'WITHDRAWN'],
      ['PENDING', 'approved'],
      [undefined, 'APPROVED'],
      ['PENDING', null],
      ['toString', 'APPROVED'],
    ]) {
      expect(canDecideContentStudioApproval(state, decision)).toBe(false);
    }
  });

  it('each decision leaves the matching state: a withdrawal is pending again', () => {
    expect(contentStudioApprovalStateAfter('APPROVED')).toBe('APPROVED');
    expect(contentStudioApprovalStateAfter('REFUSED')).toBe('REFUSED');
    expect(contentStudioApprovalStateAfter('WITHDRAWN')).toBe('PENDING');
  });

  it('offers the actions each state allows, in a fixed order', () => {
    expect(contentStudioApprovalActions('PENDING')).toEqual([
      'approve',
      'refuse',
    ]);
    expect(contentStudioApprovalActions('APPROVED')).toEqual(['withdraw']);
    expect(contentStudioApprovalActions('REFUSED')).toEqual(['withdraw']);
    expect(contentStudioApprovalActions('WITHDRAWN')).toEqual([]);
    expect(contentStudioApprovalActions(undefined)).toEqual([]);
  });
});

describe('approval notes (P5-04)', () => {
  const max = 'x'.repeat(CONTENT_STUDIO_APPROVAL_NOTE_MAX);

  it('an approval may have a note: none, null or blank is none; text is kept exactly', () => {
    for (const none of [undefined, null, '', '  \n\t ']) {
      expect(parseContentStudioApprovalNote('APPROVED', none)).toEqual({
        note: null,
      });
    }
    const note = '  Fine.\n\nShip it.  ';
    expect(parseContentStudioApprovalNote('APPROVED', note)).toEqual({ note });
    expect(parseContentStudioApprovalNote('APPROVED', max)).toEqual({
      note: max,
    });
  });

  it('refusing and withdrawing need a note with text', () => {
    for (const decision of ['REFUSED', 'WITHDRAWN'] as const) {
      for (const missing of [undefined, null, '', '   ', '\n']) {
        expect(parseContentStudioApprovalNote(decision, missing)).toBe(null);
      }
      expect(parseContentStudioApprovalNote(decision, ' Why. ')).toEqual({
        note: ' Why. ',
      });
    }
  });

  it('refuses a note over the limit, with NUL or that is not text, for every decision', () => {
    for (const decision of CONTENT_STUDIO_APPROVAL_DECISIONS) {
      for (const note of [
        `${max}x`,
        ' '.repeat(CONTENT_STUDIO_APPROVAL_NOTE_MAX + 1),
        'a\u0000b',
        '\u0000',
        5,
        {},
        ['x'],
      ]) {
        expect(parseContentStudioApprovalNote(decision, note)).toBe(null);
      }
    }
  });

  it('a stored note is whole: none or text for an approval, text for the others', () => {
    expect(isContentStudioApprovalNoteIntact('APPROVED', null)).toBe(true);
    expect(isContentStudioApprovalNoteIntact('APPROVED', 'Fine.')).toBe(true);
    for (const decision of ['REFUSED', 'WITHDRAWN'] as const) {
      expect(isContentStudioApprovalNoteIntact(decision, 'Why.')).toBe(true);
      expect(isContentStudioApprovalNoteIntact(decision, null)).toBe(false);
    }
    for (const decision of CONTENT_STUDIO_APPROVAL_DECISIONS) {
      for (const broken of ['', '  ', 'a\u0000', undefined, 3]) {
        expect(isContentStudioApprovalNoteIntact(decision, broken)).toBe(false);
      }
    }
  });
});

describe('approval binding states (P5-05)', () => {
  it('has exactly eight binding states', () => {
    expect(CONTENT_STUDIO_REVISION_APPROVAL_STATES).toEqual([
      'NOT_REVIEWED',
      'REVIEW_REQUESTED',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
      'REVIEW_CANCELLED',
      'PENDING_APPROVAL',
      'APPROVED',
      'REFUSED',
    ]);
    for (const state of CONTENT_STUDIO_REVISION_APPROVAL_STATES) {
      expect(isContentStudioRevisionApprovalState(state)).toBe(true);
    }
    for (const value of ['approved', 'PENDING', 'READY_FOR_APPROVAL', null]) {
      expect(isContentStudioRevisionApprovalState(value)).toBe(false);
    }
  });

  it('BS1-BS10 maps the review state and the derived approval state', () => {
    expect(deriveContentStudioRevisionApprovalBindingState(null, null)).toBe(
      'NOT_REVIEWED'
    );
    expect(
      deriveContentStudioRevisionApprovalBindingState('REQUESTED', null)
    ).toBe('REVIEW_REQUESTED');
    expect(
      deriveContentStudioRevisionApprovalBindingState('IN_REVIEW', null)
    ).toBe('IN_REVIEW');
    // M11: changes requested is never pending approval
    expect(
      deriveContentStudioRevisionApprovalBindingState('CHANGES_REQUESTED', null)
    ).toBe('CHANGES_REQUESTED');
    expect(
      deriveContentStudioRevisionApprovalBindingState('CANCELLED', null)
    ).toBe('REVIEW_CANCELLED');
    for (const [approval, binding] of [
      ['PENDING', 'PENDING_APPROVAL'],
      ['APPROVED', 'APPROVED'],
      ['REFUSED', 'REFUSED'],
    ]) {
      expect(
        deriveContentStudioRevisionApprovalBindingState(
          'READY_FOR_APPROVAL',
          approval
        )
      ).toBe(binding);
    }
  });

  it('BS9/BS10 a withdrawal is pending again, and a re-approval approved, through the derived state', () => {
    const binding = (...decisions: string[]) =>
      deriveContentStudioRevisionApprovalBindingState(
        'READY_FOR_APPROVAL',
        contentStudioApprovalStatus(history(...decisions))!.state
      );
    expect(binding()).toBe('PENDING_APPROVAL');
    expect(binding('APPROVED', 'WITHDRAWN')).toBe('PENDING_APPROVAL');
    expect(binding('REFUSED', 'WITHDRAWN')).toBe('PENDING_APPROVAL');
    expect(binding('APPROVED', 'WITHDRAWN', 'APPROVED')).toBe('APPROVED');
    expect(binding('APPROVED', 'WITHDRAWN', 'REFUSED')).toBe('REFUSED');
  });

  it('a review state and an approval state that cannot belong together have no binding', () => {
    // only a review ready for approval has an approval, and it always has one
    expect(
      deriveContentStudioRevisionApprovalBindingState(
        'READY_FOR_APPROVAL',
        null
      )
    ).toBe(null);
    for (const state of CONTENT_STUDIO_REVIEW_STATES) {
      if (state === 'READY_FOR_APPROVAL') {
        continue;
      }
      for (const approval of CONTENT_STUDIO_APPROVAL_STATES) {
        expect(
          deriveContentStudioRevisionApprovalBindingState(state, approval)
        ).toBe(null);
      }
    }
    for (const approval of CONTENT_STUDIO_APPROVAL_STATES) {
      expect(
        deriveContentStudioRevisionApprovalBindingState(null, approval)
      ).toBe(null);
    }
    for (const [review, approval] of [
      ['APPROVED', null],
      ['ready_for_approval', 'APPROVED'],
      ['READY_FOR_APPROVAL', 'approved'],
      ['READY_FOR_APPROVAL', 'WITHDRAWN'],
      [undefined, undefined],
      [undefined, null],
    ]) {
      expect(
        deriveContentStudioRevisionApprovalBindingState(review, approval)
      ).toBe(null);
    }
  });

  it('M1-M3 only APPROVED is approved', () => {
    for (const state of CONTENT_STUDIO_REVISION_APPROVAL_STATES) {
      expect(isContentStudioRevisionApproved(state)).toBe(state === 'APPROVED');
    }
    for (const value of [
      'approved',
      'READY_FOR_APPROVAL',
      true,
      null,
      undefined,
    ]) {
      expect(isContentStudioRevisionApproved(value)).toBe(false);
    }
  });
});

describe('Review & Approval queues (P5-06)', () => {
  const binding = (review: string, ...decisions: string[]) =>
    deriveContentStudioRevisionApprovalBindingState(
      review,
      review === 'READY_FOR_APPROVAL'
        ? contentStudioApprovalStatus(history(...decisions))!.state
        : null
    );
  const queuesOf = (state: string) =>
    CONTENT_STUDIO_REVIEW_QUEUES.filter((queue) =>
      (CONTENT_STUDIO_REVIEW_QUEUE_STATES[queue] as readonly string[]).includes(
        state
      )
    );

  it('QF1-QF10 every review lands in exactly the queue of the binding state it derives now', () => {
    expect(queuesOf(binding('REQUESTED'))).toEqual(['NEEDS_REVIEW']);
    expect(queuesOf(binding('IN_REVIEW'))).toEqual(['NEEDS_REVIEW']);
    expect(queuesOf(binding('CHANGES_REQUESTED'))).toEqual([
      'CHANGES_REQUESTED',
    ]);
    expect(queuesOf(binding('CANCELLED'))).toEqual(['CANCELLED']);
    expect(queuesOf(binding('READY_FOR_APPROVAL'))).toEqual([
      'PENDING_APPROVAL',
    ]);
    expect(queuesOf(binding('READY_FOR_APPROVAL', 'APPROVED'))).toEqual([
      'APPROVED',
    ]);
    expect(queuesOf(binding('READY_FOR_APPROVAL', 'REFUSED'))).toEqual([
      'REFUSED',
    ]);
    // M1/M2: a decision taken back is pending again, whatever it was
    expect(
      queuesOf(binding('READY_FOR_APPROVAL', 'APPROVED', 'WITHDRAWN'))
    ).toEqual(['PENDING_APPROVAL']);
    expect(
      queuesOf(binding('READY_FOR_APPROVAL', 'REFUSED', 'WITHDRAWN'))
    ).toEqual(['PENDING_APPROVAL']);
    expect(
      queuesOf(
        binding('READY_FOR_APPROVAL', 'REFUSED', 'WITHDRAWN', 'APPROVED')
      )
    ).toEqual(['APPROVED']);
  });

  it('a review is in one queue at most; a revision without a review is in none', () => {
    for (const state of CONTENT_STUDIO_REVISION_APPROVAL_STATES) {
      expect(queuesOf(state)).toHaveLength(state === 'NOT_REVIEWED' ? 0 : 1);
    }
    expect(CONTENT_STUDIO_REVIEW_QUEUES).toEqual([
      'NEEDS_REVIEW',
      'CHANGES_REQUESTED',
      'PENDING_APPROVAL',
      'APPROVED',
      'REFUSED',
      'CANCELLED',
    ]);
    for (const value of ['OPEN', 'ALL', 'needs_review', 'READY', null, 1]) {
      expect(isContentStudioReviewQueue(value)).toBe(false);
    }
  });

  it('M7 the review states a queue narrows to in the database, never one it does not hold', () => {
    const states = (queue: (typeof CONTENT_STUDIO_REVIEW_QUEUES)[number]) =>
      contentStudioReviewStatesOfBindingStates(
        CONTENT_STUDIO_REVIEW_QUEUE_STATES[queue]
      );
    expect(states('NEEDS_REVIEW')).toEqual(['REQUESTED', 'IN_REVIEW']);
    expect(states('CHANGES_REQUESTED')).toEqual(['CHANGES_REQUESTED']);
    expect(states('CANCELLED')).toEqual(['CANCELLED']);
    for (const queue of ['PENDING_APPROVAL', 'APPROVED', 'REFUSED'] as const) {
      expect(states(queue)).toEqual(['READY_FOR_APPROVAL']);
    }
    expect(
      contentStudioReviewStatesOfBindingStates(
        CONTENT_STUDIO_REVISION_APPROVAL_STATES
      )
    ).toEqual(CONTENT_STUDIO_REVIEW_STATES);
  });

  it('only a queue holding some but not all approval states needs the approval history derived', () => {
    const needs = (queue: (typeof CONTENT_STUDIO_REVIEW_QUEUES)[number]) =>
      isContentStudioApprovalDerivationNeeded(
        CONTENT_STUDIO_REVIEW_QUEUE_STATES[queue]
      );
    expect(CONTENT_STUDIO_REVIEW_QUEUES.filter(needs)).toEqual([
      'PENDING_APPROVAL',
      'APPROVED',
      'REFUSED',
    ]);
    expect(
      isContentStudioApprovalDerivationNeeded([
        'PENDING_APPROVAL',
        'APPROVED',
        'REFUSED',
      ])
    ).toBe(false);
    expect(
      isContentStudioApprovalDerivationNeeded(
        CONTENT_STUDIO_REVISION_APPROVAL_STATES
      )
    ).toBe(false);
  });
});
