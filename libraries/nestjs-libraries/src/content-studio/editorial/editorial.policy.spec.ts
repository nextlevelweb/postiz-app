import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioEditorialPolicyError,
  EDITORIAL_POLICY_CONTENT_MAX_BYTES,
  emptyContentStudioEditorialPolicyContent,
  isContentStudioApprovalRequiredForHandoff,
  parseContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import {
  ContentStudioEditorialPolicyIntegrityError,
  parseVerifiedContentStudioEditorialPolicyRevision,
  storedContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';

const MARKER = 'EDITORIAL_POLICY_SECRET_MARKER_123';

const empty = () => ({
  schemaVersion: 1,
  principles: [] as unknown[],
  prohibitedTopics: [] as unknown[],
  claimRules: [] as unknown[],
  ctaRules: [] as unknown[],
  formatConventions: [] as unknown[],
  complianceNotes: '' as unknown,
});

const full = () => ({
  schemaVersion: 1,
  principles: ['Be useful before being clever.', 'Respect the reader.'],
  prohibitedTopics: ['Politics', 'Competitor pricing'],
  claimRules: [
    'Every number needs a source.',
    `Never promise results. ${MARKER}`,
  ],
  ctaRules: ['One call to action per post.'],
  formatConventions: ['Sentence case headings.', 'Respect the reader.'],
  complianceNotes: `Financial products: add the risk notice.\n\n  ${MARKER}`,
});

type Policy = ReturnType<typeof full>;
const LIST_KEYS = [
  'principles',
  'prohibitedTopics',
  'claimRules',
  'ctaRules',
  'formatConventions',
] as const;

const refusal = (input: unknown) => {
  try {
    parseContentStudioEditorialPolicyContent(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioEditorialPolicyError);
    expect(
      [
        String(err),
        (err as Error).stack,
        JSON.stringify(err),
        inspect(err, { depth: 6 }),
      ].join('\n')
    ).not.toContain(MARKER);
    return (err as ContentStudioEditorialPolicyError).code;
  }
  throw new Error('expected a refusal');
};

const list = (count: number, make: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => make(i));
const entry = (i: number, length: number, fill = 'x') =>
  `${i} `.padEnd(length, fill);
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

// A policy whose canonical JSON is exactly `size` UTF-8 bytes, filled up with
// compliance notes
const sized = (size: number) => {
  const policy = {
    ...empty(),
    principles: list(20, (i) => entry(i, 500, 'p')),
    claimRules: list(20, (i) => entry(i, 500, 'c')),
    prohibitedTopics: list(30, (i) => entry(i, 200, 't')),
    ctaRules: list(10, (i) => entry(i, 300, 'a')),
  };
  const notes = size - bytes(canonicalJson(policy));
  expect(notes).toBeGreaterThan(0);
  expect(notes).toBeLessThanOrEqual(4000);
  return { ...policy, complianceNotes: 'n'.repeat(notes) };
};

describe('Editorial Policy v1 parser', () => {
  it('EP1 accepts the empty policy as it is', () => {
    expect(parseContentStudioEditorialPolicyContent(empty())).toEqual(empty());
    expect(emptyContentStudioEditorialPolicyContent()).toEqual(empty());
  });

  it('EP2 accepts a full policy, the same text allowed in two lists', () => {
    expect(parseContentStudioEditorialPolicyContent(full())).toEqual(full());
  });

  it.each([[0], [2], ['1'], [null], [undefined], [1.5]])(
    'EP3 refuses schemaVersion %p',
    (schemaVersion) => {
      expect(refusal({ ...full(), schemaVersion })).toBe('INVALID');
    }
  );

  it.each([
    ['a channel rule', { platformRules: { linkedin: 3000 } }],
    ['a brand voice', { brandVoice: MARKER }],
    ['an audience', { audience: 'founders' }],
    ['an id', { id: 'x' }],
    ['an organization', { organizationId: 'org-b' }],
  ])('EP4 refuses %s at the top level', (_name, extra) => {
    expect(refusal({ ...full(), ...extra })).toBe('INVALID');
  });

  it.each(['schemaVersion', ...LIST_KEYS, 'complianceNotes'])(
    'EP5 requires %s',
    (key) => {
      const input: Record<string, unknown> = full();
      delete input[key];
      expect(refusal(input)).toBe('INVALID');
    }
  );

  it.each([
    ['EP6/EP7 principles', 'principles', 20, 500],
    ['EP10/EP11 prohibitedTopics', 'prohibitedTopics', 30, 200],
    ['EP13/EP14 claimRules', 'claimRules', 20, 500],
    ['EP16/EP17 ctaRules', 'ctaRules', 10, 300],
    ['EP19/EP20 formatConventions', 'formatConventions', 20, 300],
  ] as const)(
    '%s: %s takes up to %i entries of up to %i characters',
    (_name, key, count, length) => {
      const at = list(count, (i) => entry(i, length));
      expect(
        parseContentStudioEditorialPolicyContent({ ...empty(), [key]: at })[key]
      ).toEqual(at);
      expect(
        refusal({ ...empty(), [key]: list(count + 1, (i) => entry(i, 10)) })
      ).toBe('INVALID');
      expect(
        refusal({ ...empty(), [key]: [entry(0, length + 1, MARKER[0])] })
      ).toBe('INVALID');
      // the limit counts the trimmed entry
      expect(
        parseContentStudioEditorialPolicyContent({
          ...empty(),
          [key]: [`  ${entry(0, length)}\n`],
        })[key]
      ).toEqual([entry(0, length)]);
    }
  );

  it('EP8 trims every list entry and refuses a blank one', () => {
    const parsed = parseContentStudioEditorialPolicyContent({
      ...empty(),
      principles: ['  Respect the reader. \n', '\tBe brief'],
      prohibitedTopics: [' Politics '],
      claimRules: ['Cite\r\nsources '],
      ctaRules: ['  Ask once'],
      formatConventions: ['No caps  '],
    });
    expect(parsed).toEqual({
      ...empty(),
      principles: ['Respect the reader.', 'Be brief'],
      prohibitedTopics: ['Politics'],
      claimRules: ['Cite\nsources'],
      ctaRules: ['Ask once'],
      formatConventions: ['No caps'],
    });
    for (const key of LIST_KEYS) {
      expect(refusal({ ...empty(), [key]: ['  \n '] })).toBe('INVALID');
      expect(refusal({ ...empty(), [key]: [''] })).toBe('INVALID');
    }
  });

  it.each([
    ['EP9 principles', 'principles'],
    ['EP12 prohibitedTopics', 'prohibitedTopics'],
    ['EP15 claimRules', 'claimRules'],
    ['EP18 ctaRules', 'ctaRules'],
    ['EP21 formatConventions', 'formatConventions'],
  ] as const)(
    '%s refuses an entry twice, also once trimmed, never merging it',
    (_name, key) => {
      expect(refusal({ ...empty(), [key]: [MARKER, MARKER] })).toBe('INVALID');
      expect(refusal({ ...empty(), [key]: ['Rule', ' Rule\n'] })).toBe(
        'INVALID'
      );
      // exact comparison: another case is another entry
      expect(
        parseContentStudioEditorialPolicyContent({
          ...empty(),
          [key]: ['Rule', 'rule'],
        })[key]
      ).toEqual(['Rule', 'rule']);
    }
  );

  it('EP22 takes compliance notes of up to 4000 characters, trimmed outside only', () => {
    expect(
      parseContentStudioEditorialPolicyContent({
        ...empty(),
        complianceNotes: 'n'.repeat(4000),
      }).complianceNotes
    ).toHaveLength(4000);
    expect(refusal({ ...empty(), complianceNotes: 'n'.repeat(4001) })).toBe(
      'INVALID'
    );
    expect(
      parseContentStudioEditorialPolicyContent({
        ...empty(),
        complianceNotes: `  ${'n'.repeat(4000)}  \n`,
      }).complianceNotes
    ).toHaveLength(4000);
    expect(
      parseContentStudioEditorialPolicyContent({
        ...empty(),
        complianceNotes: '\n  Line one\n\n    indented  line\n',
      }).complianceNotes
    ).toBe('Line one\n\n    indented  line');
    expect(
      parseContentStudioEditorialPolicyContent({
        ...empty(),
        complianceNotes: ' \r\n ',
      }).complianceNotes
    ).toBe('');
  });

  it('EP23 normalizes CRLF and CR to LF everywhere', () => {
    const parsed = parseContentStudioEditorialPolicyContent({
      ...empty(),
      principles: ['a\r\nb', 'c\rd'],
      complianceNotes: 'one\r\ntwo\rthree',
    });
    expect(parsed.principles).toEqual(['a\nb', 'c\nd']);
    expect(parsed.complianceNotes).toBe('one\ntwo\nthree');
  });

  it.each([
    ['EP24 NUL in a list entry', { principles: [`a\u0000${MARKER}`] }],
    ['EP24 NUL in the notes', { complianceNotes: `\u0000${MARKER}` }],
    ['EP25 a lone high surrogate', { claimRules: [`a\ud83d ${MARKER}`] }],
    ['EP25 a trailing high surrogate', { complianceNotes: `${MARKER}\ud83d` }],
    ['EP26 a lone low surrogate', { ctaRules: [`\ude00${MARKER}`] }],
    ['EP26 reversed surrogates', { formatConventions: ['\ude00\ud83d'] }],
  ])('refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it('EP27 accepts a valid surrogate pair', () => {
    const parsed = parseContentStudioEditorialPolicyContent({
      ...empty(),
      principles: ['Smile \ud83d\ude00'],
      complianceNotes: '\ud83d\ude00',
    });
    expect(parsed.principles).toEqual(['Smile \ud83d\ude00']);
    expect(parsed.complianceNotes).toBe('\ud83d\ude00');
  });

  it.each([
    ['a list as text', { principles: 'Be brief' }],
    ['a list as an object', { claimRules: { 0: 'x' } }],
    ['a number entry', { ctaRules: [1] }],
    ['a nested list entry', { prohibitedTopics: [['x']] }],
    ['an object entry', { formatConventions: [{ text: 'x' }] }],
    ['numeric notes', { complianceNotes: 5 }],
    ['notes as a list', { complianceNotes: ['x'] }],
  ])('EP28 refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it.each([[null], ['policy'], [[]], [42], [undefined]])(
    'EP28 refuses %p as a policy',
    (input) => {
      expect(refusal(input)).toBe('INVALID');
    }
  );

  it.each([
    ['null notes', { complianceNotes: null }],
    ['a null list', { principles: null }],
    ['a null entry', { prohibitedTopics: [null] }],
  ])('EP29 refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it('EP30 refuses class instances, dates, maps, sets and functions', () => {
    class Policy {
      schemaVersion = 1;
      principles = [];
      prohibitedTopics = [];
      claimRules = [];
      ctaRules = [];
      formatConventions = [];
      complianceNotes = '';
    }
    expect(refusal(new Policy())).toBe('INVALID');
    expect(refusal({ ...empty(), principles: [new Date(0)] })).toBe('INVALID');
    expect(refusal({ ...empty(), claimRules: new Map() })).toBe('INVALID');
    expect(refusal({ ...empty(), ctaRules: new Set(['x']) })).toBe('INVALID');
    expect(refusal({ ...empty(), complianceNotes: () => MARKER })).toBe(
      'INVALID'
    );
  });

  it('EP31 accepts a policy of exactly 32768 bytes', () => {
    const input = sized(EDITORIAL_POLICY_CONTENT_MAX_BYTES);
    const parsed = parseContentStudioEditorialPolicyContent(input);
    expect(bytes(canonicalJson(parsed))).toBe(32_768);
    expect(bytes(JSON.stringify(parsed))).toBe(32_768);
  });

  it('EP32 refuses a policy of 32769 bytes as too large', () => {
    expect(refusal(sized(EDITORIAL_POLICY_CONTENT_MAX_BYTES + 1))).toBe(
      'TOO_LARGE'
    );
  });

  it('EP33 counts UTF-8 bytes, not characters', () => {
    // 3 bytes per character: every field within its character limit, about
    // 14000 characters in all, but over 32 KiB as UTF-8
    const input = {
      ...empty(),
      principles: list(20, (i) => entry(i, 500, '\u20ac')),
      complianceNotes: `${MARKER}${'\u20ac'.repeat(3900)}`,
    };
    expect(JSON.stringify(input).length).toBeLessThan(32_768);
    expect(bytes(JSON.stringify(input))).toBeGreaterThan(32_768);
    expect(refusal(input)).toBe('TOO_LARGE');

    // the same characters in a smaller amount pass
    const small = { ...empty(), complianceNotes: '\u20ac'.repeat(4000) };
    expect(
      parseContentStudioEditorialPolicyContent(small).complianceNotes
    ).toHaveLength(4000);
  });

  it('EP34 never changes the input', () => {
    const input = {
      ...full(),
      principles: ['  Padded\r\n', 'Second'],
      complianceNotes: ' notes\r\n',
    };
    const copy = JSON.parse(JSON.stringify(input));
    parseContentStudioEditorialPolicyContent(input);
    expect(input).toEqual(copy);
  });

  it('EP35 normalizes deterministically, whatever the key order', () => {
    const input = full();
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const a = parseContentStudioEditorialPolicyContent(input);
    const b = parseContentStudioEditorialPolicyContent(reordered);
    expect(a).toEqual(b);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(parseContentStudioEditorialPolicyContent(a)).toEqual(a);
  });

  it('reports issues as paths and kinds only', () => {
    try {
      parseContentStudioEditorialPolicyContent({
        ...full(),
        claimRules: [MARKER, MARKER],
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as ContentStudioEditorialPolicyError).issues).toEqual([
        { path: ['claimRules', 1], code: 'custom' },
      ]);
      expect((err as Error).message).toBe(
        'The editorial policy does not match schema version 1'
      );
    }
  });
});

describe('Editorial Policy revisions: canonical storage and integrity', () => {
  const stored = (input: unknown = full()) =>
    storedContentStudioEditorialPolicyContent(
      parseContentStudioEditorialPolicyContent(input)
    );
  const failsIntegrity = (revision: {
    schemaVersion: number;
    content: string;
    contentHash: string;
  }) => {
    let error: unknown;
    try {
      parseVerifiedContentStudioEditorialPolicyRevision(revision);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContentStudioEditorialPolicyIntegrityError);
    expect(
      [
        String(error),
        (error as Error).stack,
        JSON.stringify(error),
        inspect(error, { depth: 6 }),
      ].join('\n')
    ).not.toContain(MARKER);
  };
  // a stored text that is canonical and correctly hashed, but not a policy
  const hashed = (value: unknown) => {
    const content = canonicalJson(value);
    return { schemaVersion: 1, content, contentHash: sha256Hex(content) };
  };

  it('EH1 gives the same text and hash whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(full()).reverse());
    expect(stored(reordered)).toEqual(stored());
    expect(stored().content.startsWith('{"claimRules":')).toBe(true);
  });

  it('EH2 gives the same hash for CRLF, CR and LF', () => {
    const lf = { ...full(), complianceNotes: 'one\ntwo' };
    expect(stored({ ...lf, complianceNotes: 'one\r\ntwo' })).toEqual(
      stored(lf)
    );
    expect(stored({ ...lf, complianceNotes: 'one\rtwo' })).toEqual(stored(lf));
  });

  it('EH3/EH4 changes the hash with the meaning; a lowercase SHA-256 of the text', () => {
    const a = stored();
    const b = stored({ ...full(), ctaRules: ['Two calls to action at most.'] });
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(sha256Hex(a.content));
    expect(a.schemaVersion).toBe(1);
    // swapping two entries is a different policy too
    const swapped = stored({
      ...full(),
      principles: [...full().principles].reverse(),
    });
    expect(swapped.contentHash).not.toBe(a.contentHash);
  });

  it('EH5 reads a stored revision back as the parsed policy', () => {
    expect(parseVerifiedContentStudioEditorialPolicyRevision(stored())).toEqual(
      full()
    );
    expect(
      parseVerifiedContentStudioEditorialPolicyRevision(stored(empty()))
    ).toEqual(empty());
  });

  it('EH6 fails on text that is not JSON', () => {
    const revision = stored();
    failsIntegrity({ ...revision, content: revision.content.slice(0, -1) });
    failsIntegrity(hashed(MARKER));
  });

  it('EH7 fails on another schema version in the row', () => {
    failsIntegrity({ ...stored(), schemaVersion: 2 });
  });

  it('EH8 fails on another schema version in the content', () => {
    failsIntegrity({ ...hashed({ ...full(), schemaVersion: 2 }) });
    failsIntegrity({
      ...hashed({ ...full(), schemaVersion: 2 }),
      schemaVersion: 2,
    });
  });

  it('EH9 fails on a hash that does not match', () => {
    failsIntegrity({ ...stored(), contentHash: 'f'.repeat(64) });
    failsIntegrity({
      ...stored(),
      contentHash: stored().contentHash.toUpperCase(),
    });
  });

  it('EH10 fails on valid but non-canonical text, even correctly hashed', () => {
    const content = JSON.stringify(full());
    expect(content).not.toBe(stored().content);
    failsIntegrity({
      schemaVersion: 1,
      content,
      contentHash: sha256Hex(content),
    });
    // untrimmed text would be normalized on parse: refused, not repaired
    failsIntegrity(hashed({ ...full(), complianceNotes: ` ${MARKER} ` }));
  });

  it('EH11 fails on a stored field the schema does not know', () => {
    failsIntegrity(hashed({ ...full(), extra: MARKER }));
  });

  it('EH12 never quotes the stored text', () => {
    const revision = stored();
    expect(revision.content).toContain(MARKER);
    failsIntegrity({ ...revision, contentHash: '0'.repeat(64) });
    expect(new ContentStudioEditorialPolicyIntegrityError().message).toBe(
      'A stored editorial policy revision failed its integrity check'
    );
  });
});

describe('Editorial Policy workflow: approval before handoff (P5-07)', () => {
  const withWorkflow = (workflow: unknown) => ({ ...full(), workflow });

  it('POL1 a policy without a workflow requires nothing, and gets none', () => {
    const parsed = parseContentStudioEditorialPolicyContent(full());
    expect(parsed).not.toHaveProperty('workflow');
    expect(isContentStudioApprovalRequiredForHandoff(parsed)).toBe(false);
    expect(isContentStudioApprovalRequiredForHandoff(null)).toBe(false);
  });

  it('POL1 a revision stored before the workflow existed still verifies, and requires nothing', () => {
    const text = canonicalJson(
      parseContentStudioEditorialPolicyContent(full())
    );
    const verified = parseVerifiedContentStudioEditorialPolicyRevision({
      schemaVersion: 1,
      content: text,
      contentHash: sha256Hex(text),
    });
    expect(isContentStudioApprovalRequiredForHandoff(verified)).toBe(false);
  });

  it('POL3 on is kept and required', () => {
    const parsed = parseContentStudioEditorialPolicyContent(
      withWorkflow({ requireApprovalForHandoff: true })
    );
    expect(parsed.workflow).toEqual({ requireApprovalForHandoff: true });
    expect(isContentStudioApprovalRequiredForHandoff(parsed)).toBe(true);
    const stored = storedContentStudioEditorialPolicyContent(parsed);
    expect(
      isContentStudioApprovalRequiredForHandoff(
        parseVerifiedContentStudioEditorialPolicyRevision(stored)
      )
    ).toBe(true);
  });

  it('POL2/M1 off has one form: no workflow, the same text and hash as a policy without it', () => {
    const off = parseContentStudioEditorialPolicyContent(
      withWorkflow({ requireApprovalForHandoff: false })
    );
    expect(off).toEqual(full());
    expect(isContentStudioApprovalRequiredForHandoff(off)).toBe(false);
    expect(storedContentStudioEditorialPolicyContent(off)).toEqual(
      storedContentStudioEditorialPolicyContent(
        parseContentStudioEditorialPolicyContent(full())
      )
    );
    // and a stored "off" written any other way is not canonical
    const text = canonicalJson(
      withWorkflow({ requireApprovalForHandoff: false })
    );
    expect(() =>
      parseVerifiedContentStudioEditorialPolicyRevision({
        schemaVersion: 1,
        content: text,
        contentHash: sha256Hex(text),
      })
    ).toThrow(ContentStudioEditorialPolicyIntegrityError);
  });

  it.each([
    ['a flat flag', { ...full(), requireApprovalForHandoff: true }],
    ['a text', withWorkflow({ requireApprovalForHandoff: 'true' })],
    ['a number', withWorkflow({ requireApprovalForHandoff: 1 })],
    ['null', withWorkflow({ requireApprovalForHandoff: null })],
    ['an empty workflow', withWorkflow({})],
    ['a boolean workflow', withWorkflow(true)],
    ['a null workflow', withWorkflow(null)],
    [
      'a bypass',
      withWorkflow({ requireApprovalForHandoff: true, bypassApproval: true }),
    ],
    ['another rule', withWorkflow({ requireApprovalForPublish: true })],
    [
      'a policy version',
      withWorkflow({ requireApprovalForHandoff: true, policyVersion: 2 }),
    ],
  ])('POL4 refuses %s', (_name, input) => {
    expect(refusal(input)).toBe('INVALID');
  });

  it('the helper requires only an explicit true', () => {
    for (const workflow of [
      undefined,
      {},
      { requireApprovalForHandoff: false },
      { requireApprovalForHandoff: 'true' },
      { requireApprovalForHandoff: 1 },
    ]) {
      expect(
        isContentStudioApprovalRequiredForHandoff({
          workflow,
        } as unknown as Parameters<typeof isContentStudioApprovalRequiredForHandoff>[0])
      ).toBe(false);
    }
  });
});

describe('Editorial Policy source', () => {
  const read = (file: string) =>
    fs
      .readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');

  it('keeps the parser free of Node modules, so a browser could use it', () => {
    expect(read('editorial.policy.ts')).not.toMatch(
      /from '(crypto|fs|path|util|buffer|node:[a-z]+)'|require\(/
    );
  });

  it('has no AI, fetching, checker or logging code', () => {
    for (const file of [
      'editorial.policy.ts',
      'editorial.policy.revision.ts',
    ]) {
      expect(read(file)).not.toMatch(
        /ai\.execution|ai\.provider|AIConnection|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|console\.|Logger|score|compliant|verify(Claim|Fact)/
      );
    }
  });
});

// Activation flow 01: what Content Studio researches for the organization,
// refined by the user, kept with the policy as an optional part
describe('Editorial Policy research preferences (activation flow 01)', () => {
  const research = {
    lookFor: ['AI in het mkb'],
    avoid: ['Generic AI news'],
    freshness: 'week',
    angles: ['practical', 'myth_busting'],
  };

  it('REF2 keeps valid preferences, normalized, and a policy without them stays as it was', () => {
    const parsed = parseContentStudioEditorialPolicyContent({
      ...full(),
      research: { ...research, lookFor: ['  AI in het mkb  '] },
    });
    expect(parsed.research).toEqual(research);
    expect(parseContentStudioEditorialPolicyContent(full())).not.toHaveProperty(
      'research'
    );
  });

  it.each([
    ['an unknown freshness', { ...research, freshness: 'yesterday' }],
    ['an unknown angle', { ...research, angles: ['clickbait'] }],
    ['a repeated angle', { ...research, angles: ['practical', 'practical'] }],
    ['a repeated entry', { ...research, lookFor: ['AI', 'AI'] }],
    [
      'too many entries',
      { ...research, avoid: Array.from({ length: 11 }, (_, i) => `t${i}`) },
    ],
    ['an empty entry', { ...research, lookFor: ['  '] }],
    ['an extra key', { ...research, sources: ['x'] }],
    ['a missing key', { lookFor: [], avoid: [], angles: [] }],
  ])('refuses %s', (_label, value) => {
    expect(() =>
      parseContentStudioEditorialPolicyContent({ ...full(), research: value })
    ).toThrow(ContentStudioEditorialPolicyError);
  });
});
