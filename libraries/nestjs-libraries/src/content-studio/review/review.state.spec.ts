import { readFileSync } from 'fs';
import { join } from 'path';
import {
  canTransitionContentStudioReview,
  CONTENT_STUDIO_REVIEW_ACTIONS,
  CONTENT_STUDIO_REVIEW_COMMENT_MAX,
  CONTENT_STUDIO_REVIEW_STATES,
  CONTENT_STUDIO_REVIEW_TARGET_TYPES,
  CONTENT_STUDIO_REVISION_REQUEST_MAX,
  CONTENT_STUDIO_REVISION_REQUEST_STATUSES,
  contentStudioReviewActions,
  ContentStudioReviewTransitionError,
  isContentStudioReviewDiscussionOpen,
  isContentStudioReviewHistoryIntact,
  isContentStudioReviewState,
  isContentStudioReviewText,
  isContentStudioRevisionRequestStatus,
  transitionContentStudioReviewState,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';

// The review state machine (P5-01): five states, the only legal
// transitions, three final states, and the state history check. Pure: no
// database, no clock, no request
const ALL = CONTENT_STUDIO_REVIEW_STATES;
const legal = (from: string) =>
  ALL.filter((to) => canTransitionContentStudioReview(from, to));

describe('Content Studio review states', () => {
  it('has exactly these states, target types and actions', () => {
    expect(ALL).toEqual([
      'REQUESTED',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
      'READY_FOR_APPROVAL',
      'CANCELLED',
    ]);
    expect(CONTENT_STUDIO_REVIEW_TARGET_TYPES).toEqual([
      'PACKAGE_REVISION',
      'DESIGN_REVISION',
    ]);
    expect(CONTENT_STUDIO_REVIEW_ACTIONS).toEqual({
      start: 'IN_REVIEW',
      'request-changes': 'CHANGES_REQUESTED',
      'ready-for-approval': 'READY_FOR_APPROVAL',
      cancel: 'CANCELLED',
    });
    // a review is not an approval
    expect(ALL).not.toContain('APPROVED');
    expect(ALL).not.toContain('REJECTED');
  });

  it('RS1 REQUESTED -> IN_REVIEW is allowed', () => {
    expect(canTransitionContentStudioReview('REQUESTED', 'IN_REVIEW')).toBe(
      true
    );
    expect(transitionContentStudioReviewState('REQUESTED', 'start')).toBe(
      'IN_REVIEW'
    );
  });

  it('RS2 REQUESTED -> CANCELLED is allowed', () => {
    expect(transitionContentStudioReviewState('REQUESTED', 'cancel')).toBe(
      'CANCELLED'
    );
    expect(legal('REQUESTED')).toEqual(['IN_REVIEW', 'CANCELLED']);
  });

  it('RS3 REQUESTED -> READY_FOR_APPROVAL is refused', () => {
    expect(
      canTransitionContentStudioReview('REQUESTED', 'READY_FOR_APPROVAL')
    ).toBe(false);
    expect(() =>
      transitionContentStudioReviewState('REQUESTED', 'ready-for-approval')
    ).toThrow(ContentStudioReviewTransitionError);
  });

  it('RS4 REQUESTED -> CHANGES_REQUESTED is refused', () => {
    expect(
      canTransitionContentStudioReview('REQUESTED', 'CHANGES_REQUESTED')
    ).toBe(false);
    expect(() =>
      transitionContentStudioReviewState('REQUESTED', 'request-changes')
    ).toThrow(ContentStudioReviewTransitionError);
  });

  it('RS5 IN_REVIEW -> CHANGES_REQUESTED is allowed', () => {
    expect(
      transitionContentStudioReviewState('IN_REVIEW', 'request-changes')
    ).toBe('CHANGES_REQUESTED');
  });

  it('RS6 IN_REVIEW -> READY_FOR_APPROVAL is allowed', () => {
    expect(
      transitionContentStudioReviewState('IN_REVIEW', 'ready-for-approval')
    ).toBe('READY_FOR_APPROVAL');
  });

  it('RS7 IN_REVIEW -> CANCELLED is allowed, and nothing else (not back to REQUESTED)', () => {
    expect(transitionContentStudioReviewState('IN_REVIEW', 'cancel')).toBe(
      'CANCELLED'
    );
    expect(legal('IN_REVIEW')).toEqual([
      'CHANGES_REQUESTED',
      'READY_FOR_APPROVAL',
      'CANCELLED',
    ]);
    expect(() =>
      transitionContentStudioReviewState('IN_REVIEW', 'start')
    ).toThrow(ContentStudioReviewTransitionError);
  });

  it.each([
    ['RS8', 'CHANGES_REQUESTED'],
    ['RS9', 'READY_FOR_APPROVAL'],
    ['RS10', 'CANCELLED'],
  ])('%s %s is final: no transition and no action', (_, state) => {
    expect(legal(state)).toEqual([]);
    expect(contentStudioReviewActions(state)).toEqual([]);
    for (const action of Object.keys(CONTENT_STUDIO_REVIEW_ACTIONS)) {
      expect(() => transitionContentStudioReviewState(state, action)).toThrow(
        ContentStudioReviewTransitionError
      );
    }
  });

  it('RS11 an unknown state, action or value never transitions', () => {
    for (const from of [
      'APPROVED',
      'requested',
      '',
      null,
      undefined,
      1,
      {},
      'constructor',
      '__proto__',
    ]) {
      expect(isContentStudioReviewState(from)).toBe(false);
      expect(contentStudioReviewActions(from)).toEqual([]);
      for (const to of ALL) {
        expect(canTransitionContentStudioReview(from, to)).toBe(false);
      }
      expect(() => transitionContentStudioReviewState(from, 'start')).toThrow(
        ContentStudioReviewTransitionError
      );
    }
    // an arbitrary target state is not an action
    for (const action of [
      'IN_REVIEW',
      'approve',
      'reopen',
      'toString',
      '__proto__',
      undefined,
    ]) {
      expect(() =>
        transitionContentStudioReviewState('REQUESTED', action)
      ).toThrow(ContentStudioReviewTransitionError);
    }
    expect(canTransitionContentStudioReview('REQUESTED', 'APPROVED')).toBe(
      false
    );
    // the error never repeats what it was given
    try {
      transitionContentStudioReviewState('SECRET_STATE_123', 'start');
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/SECRET/);
    }
  });

  it('offers exactly the actions of each state, in a fixed order', () => {
    expect(contentStudioReviewActions('REQUESTED')).toEqual([
      'start',
      'cancel',
    ]);
    expect(contentStudioReviewActions('IN_REVIEW')).toEqual([
      'request-changes',
      'ready-for-approval',
      'cancel',
    ]);
  });
});

// RE: the state history: 1, 2, 3... from nothing to REQUESTED, every step a
// legal transition, ending at the review's state and version
describe('Content Studio review state history', () => {
  const ev = (sequence: number, fromState: string | null, toState: string) => ({
    sequence,
    fromState,
    toState,
  });
  const requested = ev(1, null, 'REQUESTED');
  const started = ev(2, 'REQUESTED', 'IN_REVIEW');
  const ready = ev(3, 'IN_REVIEW', 'READY_FOR_APPROVAL');

  it('RE1/RE2/RE4/RE6/RE7 accepts a contiguous history ending at the state and version', () => {
    expect(
      isContentStudioReviewHistoryIntact({ state: 'REQUESTED', version: 1 }, [
        requested,
      ])
    ).toBe(true);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 2 }, [
        requested,
        started,
      ])
    ).toBe(true);
    expect(
      isContentStudioReviewHistoryIntact(
        { state: 'READY_FOR_APPROVAL', version: 3 },
        [requested, started, ready]
      )
    ).toBe(true);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'CANCELLED', version: 2 }, [
        requested,
        ev(2, 'REQUESTED', 'CANCELLED'),
      ])
    ).toBe(true);
  });

  it('refuses an empty history, a first event that is not nothing -> REQUESTED, or a gap', () => {
    expect(
      isContentStudioReviewHistoryIntact({ state: 'REQUESTED', version: 0 }, [])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'REQUESTED', version: 1 }, [
        ev(1, 'REQUESTED', 'REQUESTED'),
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 1 }, [
        ev(1, null, 'IN_REVIEW'),
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 2 }, [
        ev(2, null, 'REQUESTED'),
        ev(3, 'REQUESTED', 'IN_REVIEW'),
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact(
        { state: 'READY_FOR_APPROVAL', version: 3 },
        [requested, started, ev(4, 'IN_REVIEW', 'READY_FOR_APPROVAL')]
      )
    ).toBe(false);
  });

  it('refuses a history that disagrees with the state or the version', () => {
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 1 }, [
        requested,
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 3 }, [
        requested,
        started,
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: '2' }, [
        requested,
        started,
      ])
    ).toBe(false);
  });

  it('refuses an illegal step, a wrong fromState or an unknown state', () => {
    expect(
      isContentStudioReviewHistoryIntact(
        { state: 'READY_FOR_APPROVAL', version: 2 },
        [requested, ev(2, 'REQUESTED', 'READY_FOR_APPROVAL')]
      )
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 2 }, [
        requested,
        ev(2, 'CANCELLED', 'IN_REVIEW'),
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'APPROVED', version: 3 }, [
        requested,
        started,
        ev(3, 'IN_REVIEW', 'APPROVED'),
      ])
    ).toBe(false);
    expect(
      isContentStudioReviewHistoryIntact({ state: 'IN_REVIEW', version: 4 }, [
        requested,
        started,
        ev(3, 'IN_REVIEW', 'CHANGES_REQUESTED'),
        ev(4, 'CHANGES_REQUESTED', 'IN_REVIEW'),
      ])
    ).toBe(false);
  });
});

// The discussion (P5-02): which states take comments, the two revision
// request statuses and the plain-text rule
describe('Content Studio review discussion rules', () => {
  it('C1-C5/40 every state but CANCELLED is open for discussion; nothing unknown is', () => {
    expect(ALL.filter(isContentStudioReviewDiscussionOpen)).toEqual([
      'REQUESTED',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
      'READY_FOR_APPROVAL',
    ]);
    for (const state of ['CANCELLED', 'cancelled', 'APPROVED', '', null, 1]) {
      expect(isContentStudioReviewDiscussionOpen(state)).toBe(false);
    }
  });

  it('a revision request is OPEN or RESOLVED, nothing else', () => {
    expect(CONTENT_STUDIO_REVISION_REQUEST_STATUSES).toEqual([
      'OPEN',
      'RESOLVED',
    ]);
    for (const status of [
      'REJECTED',
      'APPROVED',
      'CANCELLED',
      'open',
      '',
      null,
      'constructor',
    ]) {
      expect(isContentStudioRevisionRequestStatus(status)).toBe(false);
    }
  });

  it('C6/C7/C8/RR2/RR3 text is kept as written, never empty once trimmed, never over its limit', () => {
    expect(CONTENT_STUDIO_REVIEW_COMMENT_MAX).toBe(10_000);
    expect(CONTENT_STUDIO_REVISION_REQUEST_MAX).toBe(20_000);
    expect(isContentStudioReviewText('  a\n\n  b  ', 10)).toBe(true);
    expect(isContentStudioReviewText('x'.repeat(10), 10)).toBe(true);
    for (const value of [
      '',
      '   ',
      '\n\t\r ',
      'x'.repeat(11),
      'a\0b',
      null,
      undefined,
      5,
      ['a'],
    ]) {
      expect(isContentStudioReviewText(value, 10)).toBe(false);
    }
  });
});

describe('Content Studio review state module boundary', () => {
  const source = readFileSync(join(__dirname, 'review.state.ts'), 'utf8');

  it('is pure: no import, no clock, no randomness, no I/O', () => {
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/require\(|Date|Math\.random|process\.|fetch/);
  });

  it('P501-4/P501-5/P502-1 names no approval, reason, mention or attachment', () => {
    const code = source.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /approved|approval[A-Z]|reason|mention|attachment|REJECTED/i
    );
  });
});
