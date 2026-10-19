import fs from 'fs';
import path from 'path';
import {
  CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX,
  CONTENT_STUDIO_REVIEW_CLAIM_STATUSES,
  contentStudioReviewClaimSummary,
  isContentStudioReviewClaimAssessmentIntact,
  isContentStudioReviewClaimStatus,
  parseContentStudioReviewClaimAssessment,
} from '@gitroom/nestjs-libraries/content-studio/review/review.claim';

const AT = new Date('2026-10-19T10:00:00.000Z');
const stored = (overrides: Record<string, unknown>) => ({
  status: 'VERIFIED',
  finding: null,
  reviewedByUserId: 'user-1',
  reviewedAt: AT,
  ...overrides,
});

describe('claim review statuses (P5-03B)', () => {
  it('has exactly three, matched exactly', () => {
    expect(CONTENT_STUDIO_REVIEW_CLAIM_STATUSES).toEqual([
      'UNREVIEWED',
      'VERIFIED',
      'NEEDS_REVISION',
    ]);
    for (const value of CONTENT_STUDIO_REVIEW_CLAIM_STATUSES) {
      expect(isContentStudioReviewClaimStatus(value)).toBe(true);
    }
    for (const value of [
      'verified',
      'APPROVED',
      'REJECTED',
      'NOT_APPLICABLE',
      ' VERIFIED',
      'constructor',
      'toString',
      '',
      null,
      undefined,
      1,
    ]) {
      expect(isContentStudioReviewClaimStatus(value)).toBe(false);
    }
  });
});

describe('a requested assessment (P5-03B)', () => {
  it('CD1 UNREVIEWED takes no finding', () => {
    expect(
      parseContentStudioReviewClaimAssessment('UNREVIEWED', undefined)
    ).toEqual({ status: 'UNREVIEWED', finding: null });
    expect(parseContentStudioReviewClaimAssessment('UNREVIEWED', null)).toEqual(
      {
        status: 'UNREVIEWED',
        finding: null,
      }
    );
    for (const finding of ['', ' ', 'x']) {
      expect(
        parseContentStudioReviewClaimAssessment('UNREVIEWED', finding)
      ).toBe(null);
    }
  });

  it('CD3 VERIFIED may have a finding, kept exactly; none, null or blank is none', () => {
    const finding = '  Checked\nagainst the report.  ';
    expect(
      parseContentStudioReviewClaimAssessment('VERIFIED', finding)
    ).toEqual({
      status: 'VERIFIED',
      finding,
    });
    for (const none of [undefined, null, '', '  \n ']) {
      expect(parseContentStudioReviewClaimAssessment('VERIFIED', none)).toEqual(
        {
          status: 'VERIFIED',
          finding: null,
        }
      );
    }
  });

  it('CD4/CD5 NEEDS_REVISION needs a finding with text', () => {
    for (const finding of [undefined, null, '', '   ', '\n\t']) {
      expect(
        parseContentStudioReviewClaimAssessment('NEEDS_REVISION', finding)
      ).toBe(null);
    }
    expect(
      parseContentStudioReviewClaimAssessment('NEEDS_REVISION', 'Wrong figure.')
    ).toEqual({ status: 'NEEDS_REVISION', finding: 'Wrong figure.' });
  });

  it('refuses a finding over the limit, with NUL or that is not text', () => {
    const max = 'x'.repeat(CONTENT_STUDIO_REVIEW_CLAIM_FINDING_MAX);
    expect(
      parseContentStudioReviewClaimAssessment('NEEDS_REVISION', max)?.finding
    ).toBe(max);
    for (const status of ['VERIFIED', 'NEEDS_REVISION']) {
      for (const finding of [`${max}x`, 'a\u0000b', 5, {}, ['x']]) {
        expect(parseContentStudioReviewClaimAssessment(status, finding)).toBe(
          null
        );
      }
    }
  });

  it('CD6 refuses an unknown status', () => {
    for (const status of ['APPROVED', 'verified', undefined, null, 3]) {
      expect(parseContentStudioReviewClaimAssessment(status, null)).toBe(null);
    }
  });
});

describe('a stored assessment (P5-03B)', () => {
  it('CD1 UNREVIEWED is whole with no finding, reviewer or time', () => {
    expect(
      isContentStudioReviewClaimAssessmentIntact(
        stored({
          status: 'UNREVIEWED',
          reviewedByUserId: null,
          reviewedAt: null,
        })
      )
    ).toBe(true);
    for (const extra of [
      { finding: 'x' },
      { reviewedByUserId: 'user-1' },
      { reviewedAt: AT },
    ]) {
      expect(
        isContentStudioReviewClaimAssessmentIntact(
          stored({
            status: 'UNREVIEWED',
            reviewedByUserId: null,
            reviewedAt: null,
            ...extra,
          })
        )
      ).toBe(false);
    }
  });

  it('CD2 VERIFIED needs its reviewer and time; its finding is optional', () => {
    expect(isContentStudioReviewClaimAssessmentIntact(stored({}))).toBe(true);
    expect(
      isContentStudioReviewClaimAssessmentIntact(stored({ finding: 'Fine.' }))
    ).toBe(true);
    for (const broken of [
      { reviewedByUserId: null },
      { reviewedByUserId: '' },
      { reviewedAt: null },
      { reviewedAt: '2026-10-19' },
      { reviewedAt: new Date('nonsense') },
      { finding: '  ' },
    ]) {
      expect(isContentStudioReviewClaimAssessmentIntact(stored(broken))).toBe(
        false
      );
    }
  });

  it('CD4/CD5 NEEDS_REVISION needs reviewer, time and a finding with text', () => {
    expect(
      isContentStudioReviewClaimAssessmentIntact(
        stored({ status: 'NEEDS_REVISION', finding: 'Why.' })
      )
    ).toBe(true);
    for (const finding of [null, '', '  ']) {
      expect(
        isContentStudioReviewClaimAssessmentIntact(
          stored({ status: 'NEEDS_REVISION', finding })
        )
      ).toBe(false);
    }
  });

  it('CD6 an unknown stored status is malformed', () => {
    expect(
      isContentStudioReviewClaimAssessmentIntact(stored({ status: 'APPROVED' }))
    ).toBe(false);
  });
});

describe('the claim summary (P5-03B)', () => {
  const summary = (ids: string[], entries: Array<[string, string]>) =>
    contentStudioReviewClaimSummary(
      ids,
      new Map(entries) as Map<
        string,
        'UNREVIEWED' | 'VERIFIED' | 'NEEDS_REVISION'
      >
    );

  it('CD7 no claims is complete', () => {
    expect(summary([], [])).toEqual({
      total: 0,
      verified: 0,
      needsRevision: 0,
      unreviewed: 0,
      complete: true,
    });
  });

  it('CD8 a claim without an assessment counts as unreviewed', () => {
    expect(summary(['a', 'b'], [['a', 'VERIFIED']])).toEqual({
      total: 2,
      verified: 1,
      needsRevision: 0,
      unreviewed: 1,
      complete: false,
    });
  });

  it('CD9 every claim verified is complete', () => {
    expect(
      summary(
        ['a', 'b'],
        [
          ['a', 'VERIFIED'],
          ['b', 'VERIFIED'],
        ]
      )
    ).toEqual({
      total: 2,
      verified: 2,
      needsRevision: 0,
      unreviewed: 0,
      complete: true,
    });
  });

  it('CD10 one claim that needs revision is incomplete', () => {
    expect(
      summary(
        ['a', 'b', 'c'],
        [
          ['a', 'VERIFIED'],
          ['b', 'NEEDS_REVISION'],
          ['c', 'UNREVIEWED'],
        ]
      )
    ).toEqual({
      total: 3,
      verified: 1,
      needsRevision: 1,
      unreviewed: 1,
      complete: false,
    });
  });

  it('counts only the given claims: an assessment of another claim adds nothing', () => {
    expect(summary(['a'], [['zzz', 'VERIFIED']]).verified).toBe(0);
  });

  it('is pure: no Node, database or browser dependency, and no approval words', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'review.claim.ts'),
      'utf8'
    );
    expect(text.match(/from '[^']+'/g)).toEqual([
      "from '@gitroom/nestjs-libraries/content-studio/review/review.state'",
    ]);
    const code = text.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/approv|fact|true\b|trust/i);
  });
});
