import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioExpertiseProfileError,
  EXPERTISE_PROFILE_CONTENT_MAX_BYTES,
  emptyContentStudioExpertiseProfileContent,
  parseContentStudioExpertiseProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile';
import {
  ContentStudioExpertiseProfileIntegrityError,
  parseVerifiedContentStudioExpertiseProfileRevision,
  storedContentStudioExpertiseProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile.revision';

const MARKER = 'EXPERTISE_PROFILE_SECRET_MARKER_123';
// built from code points so this file stays ASCII
const EURO = String.fromCharCode(0x20ac);
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const NUL = String.fromCharCode(0);

const minimal = () => ({
  schemaVersion: 1,
  subjects: [] as unknown[],
  differentiators: [] as unknown[],
  stances: [] as unknown[],
  frameworks: [] as unknown[],
  evidenceExpectations: '' as unknown,
  avoidTopics: [] as unknown[],
  confidenceBoundaries: '' as unknown,
});

const full = () => ({
  schemaVersion: 1,
  subjects: ['Payroll', 'Dutch tax law'],
  differentiators: ['Fixed fees', 'Twenty years of practice'],
  stances: [
    {
      topic: 'Crypto payroll',
      position: `Not ready for SMEs yet.\n\n  Revisit yearly. ${MARKER}`,
    },
    { topic: 'Remote work', position: 'Good for most teams.' },
  ],
  frameworks: ['Jobs to be done'],
  evidenceExpectations: `Use primary sources where possible. ${MARKER}`,
  avoidTopics: ['Politics'],
  confidenceBoundaries: 'Label forecasts as assumptions.',
});

const LIST_KEYS = [
  'subjects',
  'differentiators',
  'frameworks',
  'avoidTopics',
] as const;

const refusal = (input: unknown) => {
  try {
    parseContentStudioExpertiseProfileContent(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioExpertiseProfileError);
    expect(
      [
        String(err),
        (err as Error).stack,
        JSON.stringify(err),
        inspect(err, { depth: 6 }),
      ].join('\n')
    ).not.toContain(MARKER);
    return (err as ContentStudioExpertiseProfileError).code;
  }
  throw new Error('expected a refusal');
};
const issues = (input: unknown) => {
  try {
    parseContentStudioExpertiseProfileContent(input);
  } catch (err) {
    return (err as ContentStudioExpertiseProfileError).issues;
  }
  throw new Error('expected a refusal');
};
const parse = (input: unknown) =>
  parseContentStudioExpertiseProfileContent(input);

const list = <T>(count: number, make: (i: number) => T) =>
  Array.from({ length: count }, (_, i) => make(i));
const entry = (i: number, length: number, fill = 'x') =>
  `${i} `.padEnd(length, fill);
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

// A profile whose canonical JSON is exactly `size` UTF-8 bytes: full lists,
// as many full stances as fit, then the two instruction texts
const sized = (size: number) => {
  const profile = {
    ...minimal(),
    subjects: list(20, (i) => entry(i, 200, 's')),
    differentiators: list(10, (i) => entry(i, 500, 'd')),
    stances: [] as Array<{ topic: string; position: string }>,
  };
  while (profile.stances.length < 20) {
    const i = profile.stances.length;
    const next = {
      ...profile,
      stances: [
        ...profile.stances,
        { topic: entry(i, 200, 't'), position: entry(i, 1000, 'p') },
      ],
    };
    if (bytes(canonicalJson(next)) > size - 100) {
      break;
    }
    profile.stances = next.stances;
  }
  const left = size - bytes(canonicalJson(profile));
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThanOrEqual(4000);
  const first = Math.min(left, 2000);
  return {
    ...profile,
    evidenceExpectations: 'e'.repeat(first),
    confidenceBoundaries: 'c'.repeat(left - first),
  };
};

describe('Expertise Profile v1 parser', () => {
  it('XP1 accepts the minimal profile as it is', () => {
    expect(parse(minimal())).toEqual(minimal());
    expect(emptyContentStudioExpertiseProfileContent()).toEqual(minimal());
  });

  it('XP2 accepts a full profile, keeping inner formatting', () => {
    expect(parse(full())).toEqual(full());
  });

  it.each([[0], [2], ['1'], [null], [undefined], [1.5]])(
    'XP3 refuses schemaVersion %p',
    (schemaVersion) => {
      expect(refusal({ ...full(), schemaVersion })).toBe('INVALID');
    }
  );

  it.each([
    ['a verified flag', { verified: true }],
    ['sources', { sources: ['https://example.com'] }],
    ['citations', { citations: [MARKER] }],
    ['a confidence score', { confidenceScore: 0.9 }],
    ['facts', { facts: [] }],
    ['an organization', { organizationId: 'org-b' }],
  ])('XP4 refuses %s at the top level', (_name, extra) => {
    expect(refusal({ ...full(), ...extra })).toBe('INVALID');
  });

  it('XP4 refuses an unknown stance field', () => {
    expect(
      refusal({
        ...full(),
        stances: [{ topic: 'x', position: 'y', source: MARKER }],
      })
    ).toBe('INVALID');
  });

  it.each([
    'schemaVersion',
    ...LIST_KEYS,
    'stances',
    'evidenceExpectations',
    'confidenceBoundaries',
  ])('XP5 requires %s', (key) => {
    const input: Record<string, unknown> = full();
    delete input[key];
    expect(refusal(input)).toBe('INVALID');
  });

  it.each([['topic'], ['position']])('XP5 requires stance %s', (key) => {
    const item: Record<string, unknown> = { topic: 'x', position: 'y' };
    delete item[key];
    expect(refusal({ ...minimal(), stances: [item] })).toBe('INVALID');
  });

  it.each([
    ['XP6/XP7/XP8 subjects', 'subjects', 20, 200],
    ['XP10/XP11 differentiators', 'differentiators', 10, 500],
    ['XP19/XP20 frameworks', 'frameworks', 10, 300],
    ['XP23/XP24 avoidTopics', 'avoidTopics', 20, 200],
  ] as const)(
    '%s: %s takes up to %i entries of %i characters, trimmed',
    (_name, key, count, length) => {
      const at = list(count, (i) => entry(i, length));
      expect(parse({ ...minimal(), [key]: at })[key]).toEqual(at);
      expect(
        refusal({ ...minimal(), [key]: list(count + 1, (i) => `${i}`) })
      ).toBe('INVALID');
      expect(refusal({ ...minimal(), [key]: [entry(0, length + 1)] })).toBe(
        'INVALID'
      );
      expect(
        parse({ ...minimal(), [key]: [`  ${entry(0, length)}\r\n`] })[key]
      ).toEqual([entry(0, length)]);
      expect(refusal({ ...minimal(), [key]: [' \n '] })).toBe('INVALID');
    }
  );

  it.each([
    ['XP9 subjects', 'subjects'],
    ['XP12 differentiators', 'differentiators'],
    ['XP21 frameworks', 'frameworks'],
    ['XP25 avoidTopics', 'avoidTopics'],
  ] as const)(
    '%s refuses an entry twice, also once trimmed, never merging it',
    (_name, key) => {
      expect(refusal({ ...minimal(), [key]: [MARKER, MARKER] })).toBe(
        'INVALID'
      );
      expect(refusal({ ...minimal(), [key]: ['Payroll', ' Payroll\n'] })).toBe(
        'INVALID'
      );
    }
  );

  it('XP13 takes up to 20 stances', () => {
    const at = list(20, (i) => ({ topic: `t${i}`, position: 'p' }));
    expect(parse({ ...minimal(), stances: at }).stances).toEqual(at);
    expect(
      refusal({
        ...minimal(),
        stances: list(21, (i) => ({ topic: `t${i}`, position: 'p' })),
      })
    ).toBe('INVALID');
  });

  it('XP14/XP15 bounds a stance topic to 200 and a position to 1000 characters', () => {
    const at = { topic: 't'.repeat(200), position: 'p'.repeat(1000) };
    expect(parse({ ...minimal(), stances: [at] }).stances).toEqual([at]);
    expect(
      refusal({ ...minimal(), stances: [{ ...at, topic: 't'.repeat(201) }] })
    ).toBe('INVALID');
    expect(
      refusal({
        ...minimal(),
        stances: [{ ...at, position: 'p'.repeat(1001) }],
      })
    ).toBe('INVALID');
    expect(
      refusal({ ...minimal(), stances: [{ topic: ' ', position: 'p' }] })
    ).toBe('INVALID');
    expect(
      refusal({ ...minimal(), stances: [{ topic: 't', position: '\r\n' }] })
    ).toBe('INVALID');
  });

  it('XP16/XP17 trims a topic and normalizes a position, keeping its inner formatting', () => {
    expect(
      parse({
        ...minimal(),
        stances: [
          {
            topic: '  Remote work \n',
            position: '\r\n  First.\r\n\r\n    - indented\r',
          },
        ],
      }).stances
    ).toEqual([{ topic: 'Remote work', position: 'First.\n\n    - indented' }]);
  });

  it('XP18 refuses two stances on the same topic, even with different positions', () => {
    expect(
      refusal({
        ...minimal(),
        stances: [
          { topic: 'Remote work', position: 'Good.' },
          { topic: ' Remote work ', position: `Bad. ${MARKER}` },
        ],
      })
    ).toBe('INVALID');
    expect(
      issues({
        ...minimal(),
        stances: [
          { topic: 'A', position: 'x' },
          { topic: 'A', position: 'y' },
        ],
      })
    ).toEqual([{ path: ['stances', 1, 'topic'], code: 'custom' }]);
  });

  it('XP22/XP26 bounds the two instructions to 2000 characters, trimmed outside, empty allowed', () => {
    for (const key of ['evidenceExpectations', 'confidenceBoundaries']) {
      expect(
        parse({ ...minimal(), [key]: 'i'.repeat(2000) })[
          key as 'evidenceExpectations'
        ]
      ).toHaveLength(2000);
      expect(refusal({ ...minimal(), [key]: 'i'.repeat(2001) })).toBe(
        'INVALID'
      );
      expect(
        parse({ ...minimal(), [key]: ' \r\n Line one\r\n\r\n  two \n' })[
          key as 'evidenceExpectations'
        ]
      ).toBe('Line one\n\n  two');
      // empty stays an empty string, never null
      expect(
        parse({ ...minimal(), [key]: '  ' })[key as 'evidenceExpectations']
      ).toBe('');
    }
  });

  it('XP27 refuses a subject that is also a topic to avoid', () => {
    expect(
      issues({
        ...minimal(),
        subjects: ['Politics'],
        avoidTopics: ['Politics'],
      })
    ).toEqual([{ path: ['subjects', 0], code: 'custom' }]);
    expect(
      refusal({
        ...minimal(),
        subjects: [` ${MARKER} `],
        avoidTopics: [MARKER],
      })
    ).toBe('INVALID');
  });

  it('XP28 refuses a stance topic that is also a topic to avoid', () => {
    expect(
      issues({
        ...minimal(),
        stances: [{ topic: 'Politics', position: 'Neutral.' }],
        avoidTopics: ['Politics'],
      })
    ).toEqual([{ path: ['stances', 0, 'topic'], code: 'custom' }]);
  });

  it('XP29 compares exactly: another casing is another entry', () => {
    const parsed = parse({
      ...minimal(),
      subjects: ['Payroll', 'payroll'],
      stances: [
        { topic: 'AI', position: 'x' },
        { topic: 'ai', position: 'y' },
      ],
      avoidTopics: ['PAYROLL', 'Ai'],
    });
    expect(parsed.subjects).toEqual(['Payroll', 'payroll']);
    expect(parsed.stances.map((s) => s.topic)).toEqual(['AI', 'ai']);
    // other overlaps between lists are allowed
    expect(
      parse({
        ...minimal(),
        differentiators: ['Politics'],
        frameworks: ['Politics'],
        avoidTopics: ['Politics'],
      }).avoidTopics
    ).toEqual(['Politics']);
  });

  it('XP30 normalizes CRLF and CR to LF everywhere', () => {
    const parsed = parse({
      ...minimal(),
      subjects: ['a\r\nb', 'c\rd'],
      evidenceExpectations: 'one\r\ntwo\rthree',
      confidenceBoundaries: 'x\r\ny',
    });
    expect(parsed.subjects).toEqual(['a\nb', 'c\nd']);
    expect(parsed.evidenceExpectations).toBe('one\ntwo\nthree');
    expect(parsed.confidenceBoundaries).toBe('x\ny');
  });

  it.each([
    [
      'XP31 NUL in the evidence text',
      { evidenceExpectations: `a${NUL}${MARKER}` },
    ],
    [
      'XP31 NUL in a position',
      { stances: [{ topic: 't', position: `${NUL}${MARKER}` }] },
    ],
    ['XP32 a lone high surrogate', { subjects: [`a${HIGH} ${MARKER}`] }],
    [
      'XP32 a trailing high surrogate',
      { confidenceBoundaries: `${MARKER}${HIGH}` },
    ],
    ['XP33 a lone low surrogate', { frameworks: [`${LOW}${MARKER}`] }],
    [
      'XP33 reversed surrogates in a topic',
      { stances: [{ topic: `${LOW}${HIGH}`, position: 'p' }] },
    ],
  ])('refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it('XP34 accepts a valid surrogate pair', () => {
    const smile = `Smile ${HIGH}${LOW}`;
    const parsed = parse({
      ...minimal(),
      subjects: [smile],
      stances: [{ topic: smile, position: smile }],
      evidenceExpectations: smile,
    });
    expect([
      parsed.subjects[0],
      parsed.stances[0].topic,
      parsed.stances[0].position,
      parsed.evidenceExpectations,
    ]).toEqual([smile, smile, smile, smile]);
  });

  it.each([
    ['a list as text', { subjects: 'Payroll' }],
    ['a number entry', { differentiators: [1] }],
    ['a stance as text', { stances: ['Remote work: good'] }],
    ['stances as an object', { stances: { topic: 'x', position: 'y' } }],
    ['a numeric position', { stances: [{ topic: 'x', position: 5 }] }],
    ['numeric instructions', { evidenceExpectations: 5 }],
    ['instructions as a list', { confidenceBoundaries: ['x'] }],
  ])('XP35 refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it.each([[null], ['profile'], [[]], [42], [undefined]])(
    'XP35 refuses %p as a profile',
    (input) => {
      expect(refusal(input)).toBe('INVALID');
    }
  );

  it.each([
    ['null evidence expectations', { evidenceExpectations: null }],
    ['null confidence boundaries', { confidenceBoundaries: null }],
    ['a null list', { subjects: null }],
    ['a null entry', { avoidTopics: [null] }],
    ['a null stance', { stances: [null] }],
    ['a null position', { stances: [{ topic: 'x', position: null }] }],
  ])('XP36 refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it('XP37 refuses class instances, dates, maps, sets and functions', () => {
    class Profile {
      schemaVersion = 1;
      subjects = [];
      differentiators = [];
      stances = [];
      frameworks = [];
      evidenceExpectations = '';
      avoidTopics = [];
      confidenceBoundaries = '';
    }
    class Stance {
      topic = 'x';
      position = 'y';
    }
    expect(refusal(new Profile())).toBe('INVALID');
    expect(refusal({ ...minimal(), stances: [new Stance()] })).toBe('INVALID');
    expect(refusal({ ...minimal(), subjects: [new Date(0)] })).toBe('INVALID');
    expect(refusal({ ...minimal(), frameworks: new Map() })).toBe('INVALID');
    expect(refusal({ ...minimal(), avoidTopics: new Set(['x']) })).toBe(
      'INVALID'
    );
    expect(refusal({ ...minimal(), evidenceExpectations: () => MARKER })).toBe(
      'INVALID'
    );
  });

  it('XP38 never changes the input', () => {
    const input = {
      ...full(),
      subjects: ['  Padded\r\n', 'Second'],
      stances: [{ topic: ' t ', position: ' p\r\n' }],
      evidenceExpectations: ' notes\r\n',
    };
    const copy = JSON.parse(JSON.stringify(input));
    parse(input);
    expect(input).toEqual(copy);
  });

  it('XP39 accepts a profile of exactly 32768 bytes', () => {
    const parsed = parse(sized(EXPERTISE_PROFILE_CONTENT_MAX_BYTES));
    expect(bytes(canonicalJson(parsed))).toBe(32_768);
    expect(bytes(JSON.stringify(parsed))).toBe(32_768);
  });

  it('XP40 refuses a profile of 32769 bytes as too large', () => {
    expect(refusal(sized(EXPERTISE_PROFILE_CONTENT_MAX_BYTES + 1))).toBe(
      'TOO_LARGE'
    );
  });

  it('XP41 counts UTF-8 bytes, not characters', () => {
    // 3 bytes per character: every field within its character limit, well
    // under 32768 characters in all, but over 32 KiB as UTF-8
    const input = {
      ...minimal(),
      stances: list(12, (i) => ({
        topic: `t${i}`,
        position: entry(i, 1000, EURO),
      })),
      evidenceExpectations: `${MARKER}${EURO.repeat(1900)}`,
    };
    expect(JSON.stringify(input).length).toBeLessThan(32_768);
    expect(bytes(JSON.stringify(input))).toBeGreaterThan(32_768);
    expect(refusal(input)).toBe('TOO_LARGE');
    expect(
      parse({ ...minimal(), confidenceBoundaries: EURO.repeat(2000) })
        .confidenceBoundaries
    ).toHaveLength(2000);
  });

  it('XP42 normalizes deterministically, whatever the key order, keeping stance order', () => {
    const reordered = Object.fromEntries(Object.entries(full()).reverse());
    const a = parse(full());
    const b = parse(reordered);
    expect(a).toEqual(b);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(parse(a)).toEqual(a);
    expect(a.stances.map((s) => s.topic)).toEqual([
      'Crypto payroll',
      'Remote work',
    ]);
  });

  it('reports issues as paths and kinds only', () => {
    expect(issues({ ...full(), frameworks: [MARKER, MARKER] })).toEqual([
      { path: ['frameworks', 1], code: 'custom' },
    ]);
    try {
      parse({ ...full(), extra: MARKER });
    } catch (err) {
      expect((err as Error).message).toBe(
        'The expertise profile does not match schema version 1'
      );
    }
  });

  it('holds exactly the expertise fields, nothing about verification or sources', () => {
    const parsed = parse(full());
    expect(Object.keys(parsed).sort()).toEqual([
      'avoidTopics',
      'confidenceBoundaries',
      'differentiators',
      'evidenceExpectations',
      'frameworks',
      'schemaVersion',
      'stances',
      'subjects',
    ]);
    expect(Object.keys(parsed.stances[0]).sort()).toEqual([
      'position',
      'topic',
    ]);
  });
});

describe('Expertise Profile revisions: canonical storage and integrity', () => {
  const stored = (input: unknown = full()) =>
    storedContentStudioExpertiseProfileContent(parse(input));
  const failsIntegrity = (revision: {
    schemaVersion: number;
    content: string;
    contentHash: string;
  }) => {
    let error: unknown;
    try {
      parseVerifiedContentStudioExpertiseProfileRevision(revision);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContentStudioExpertiseProfileIntegrityError);
    expect(
      [
        String(error),
        (error as Error).stack,
        JSON.stringify(error),
        inspect(error, { depth: 6 }),
      ].join('\n')
    ).not.toContain(MARKER);
  };
  // a stored text that is canonical and correctly hashed, but not a profile
  const hashed = (value: unknown) => {
    const content = canonicalJson(value);
    return { schemaVersion: 1, content, contentHash: sha256Hex(content) };
  };

  it('XH1 gives the same text and hash whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(full()).reverse());
    const swapped = {
      ...full(),
      stances: full().stances.map((s) => ({
        position: s.position,
        topic: s.topic,
      })),
    };
    expect(stored(reordered)).toEqual(stored());
    expect(stored(swapped)).toEqual(stored());
    expect(stored().content.startsWith('{"avoidTopics":')).toBe(true);
  });

  it('XH2 gives the same hash for CRLF, CR and LF', () => {
    const lf = { ...full(), confidenceBoundaries: 'one\ntwo' };
    expect(stored({ ...lf, confidenceBoundaries: 'one\r\ntwo' })).toEqual(
      stored(lf)
    );
    expect(stored({ ...lf, confidenceBoundaries: 'one\rtwo' })).toEqual(
      stored(lf)
    );
  });

  it('XH3 changes the hash with the meaning', () => {
    const a = stored();
    expect(
      stored({ ...full(), confidenceBoundaries: 'Be careful.' }).contentHash
    ).not.toBe(a.contentHash);
    expect(
      stored({
        ...full(),
        stances: [
          { ...full().stances[0], position: 'Ready.' },
          full().stances[1],
        ],
      }).contentHash
    ).not.toBe(a.contentHash);
  });

  it('XH4 changes the hash when stances or list entries are reordered', () => {
    const a = stored();
    expect(
      stored({ ...full(), stances: [...full().stances].reverse() }).contentHash
    ).not.toBe(a.contentHash);
    expect(
      stored({ ...full(), subjects: [...full().subjects].reverse() })
        .contentHash
    ).not.toBe(a.contentHash);
  });

  it('XH5 is a lowercase SHA-256 of the stored text', () => {
    const a = stored();
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(sha256Hex(a.content));
    expect(a.schemaVersion).toBe(1);
  });

  it('XH6 reads a stored revision back as the parsed profile', () => {
    expect(
      parseVerifiedContentStudioExpertiseProfileRevision(stored())
    ).toEqual(full());
    expect(
      parseVerifiedContentStudioExpertiseProfileRevision(stored(minimal()))
    ).toEqual(minimal());
  });

  it('XH7 fails on text that is not JSON', () => {
    const revision = stored();
    failsIntegrity({ ...revision, content: revision.content.slice(0, -1) });
    failsIntegrity(hashed(MARKER));
  });

  it('XH8 fails on another schema version in the row', () => {
    failsIntegrity({ ...stored(), schemaVersion: 2 });
  });

  it('XH9 fails on another schema version in the content', () => {
    failsIntegrity(hashed({ ...full(), schemaVersion: 2 }));
    failsIntegrity({
      ...hashed({ ...full(), schemaVersion: 2 }),
      schemaVersion: 2,
    });
  });

  it('XH10 fails on a hash that does not match', () => {
    failsIntegrity({ ...stored(), contentHash: 'f'.repeat(64) });
    failsIntegrity({
      ...stored(),
      contentHash: stored().contentHash.toUpperCase(),
    });
  });

  it('XH11 fails on valid but non-canonical text, even correctly hashed', () => {
    const content = JSON.stringify(parse(full()));
    expect(content).not.toBe(stored().content);
    failsIntegrity({
      schemaVersion: 1,
      content,
      contentHash: sha256Hex(content),
    });
    // an untrimmed text would be trimmed on parse: refused, not repaired
    failsIntegrity(hashed({ ...full(), evidenceExpectations: ` ${MARKER} ` }));
  });

  it('XH12 fails on a stored field the schema does not know', () => {
    failsIntegrity(hashed({ ...full(), verified: true }));
    failsIntegrity(
      hashed({
        ...full(),
        stances: [{ topic: 't', position: 'p', sourceIds: [MARKER] }],
      })
    );
  });

  it('XH13 never quotes the stored text', () => {
    const revision = stored();
    expect(revision.content).toContain(MARKER);
    failsIntegrity({ ...revision, contentHash: '0'.repeat(64) });
    expect(new ContentStudioExpertiseProfileIntegrityError().message).toBe(
      'A stored expertise profile revision failed its integrity check'
    );
  });
});

describe('Expertise Profile source', () => {
  const read = (file: string) =>
    fs
      .readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  // Organization-provided context, never verified fact or stored evidence.
  // evidenceExpectations, an instruction, is the one allowed evidence word
  const BOUNDARY =
    /\b(verified|verifiedAt|verify\w*|factCheck\w*|truthScore|confidenceScore|sourceVerified|citationVerified|proof|evidenceVerified|evidence|grounded|grounding|sources?|sourceIds|citations?|urls?|links?|references|documents|attachments|accurate|factual)\b/i;

  it('keeps the parser free of Node modules, so a browser could use it', () => {
    expect(read('expertise.profile.ts')).not.toMatch(
      /from '(crypto|fs|path|util|buffer|node:[a-z]+)'|require\(/
    );
  });

  it('has no verification, source, citation, AI, fetching or logging code', () => {
    for (const file of [
      'expertise.profile.ts',
      'expertise.profile.revision.ts',
    ]) {
      const text = read(file);
      expect(text).not.toMatch(BOUNDARY);
      expect(text).not.toMatch(
        /ai\.execution|ai\.provider|AIConnection|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|console\.|Logger|infer|embedding|vector/i
      );
    }
    expect(read('expertise.profile.ts')).toContain('evidenceExpectations');
  });
});
