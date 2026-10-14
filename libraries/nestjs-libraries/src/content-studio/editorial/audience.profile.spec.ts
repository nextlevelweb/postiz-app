import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  AUDIENCE_PROFILE_CONTENT_MAX_BYTES,
  ContentStudioAudienceProfileError,
  emptyContentStudioAudienceProfileContent,
  parseContentStudioAudienceProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';
import {
  ContentStudioAudienceProfileIntegrityError,
  parseVerifiedContentStudioAudienceProfileRevision,
  storedContentStudioAudienceProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';

const MARKER = 'AUDIENCE_PROFILE_SECRET_MARKER_123';
// built from code points so this file stays ASCII
const EURO = String.fromCharCode(0x20ac);
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const NUL = String.fromCharCode(0);

const minimal = () => ({
  schemaVersion: 1,
  description: '',
  role: '',
  knowledgeLevel: 'mixed' as unknown,
  goals: [] as unknown[],
  painPoints: [] as unknown[],
  objections: [] as unknown[],
  preferredTone: null as unknown,
  locale: null as unknown,
});

const full = () => ({
  schemaVersion: 1,
  description: `Owners of Dutch SMEs.\n\n  They read on mobile. ${MARKER}`,
  role: 'Owner or managing director',
  knowledgeLevel: 'intermediate' as unknown,
  goals: ['Save time', 'Grow revenue'],
  painPoints: ['No time for marketing', 'Save time'],
  objections: [`Too expensive. ${MARKER}`, 'We tried AI before'],
  preferredTone: 'Direct and friendly',
  locale: 'nl-NL' as unknown,
});

const LIST_KEYS = ['goals', 'painPoints', 'objections'] as const;

const refusal = (input: unknown) => {
  try {
    parseContentStudioAudienceProfileContent(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioAudienceProfileError);
    expect(
      [
        String(err),
        (err as Error).stack,
        JSON.stringify(err),
        inspect(err, { depth: 6 }),
      ].join('\n')
    ).not.toContain(MARKER);
    return (err as ContentStudioAudienceProfileError).code;
  }
  throw new Error('expected a refusal');
};
const parse = (input: unknown) =>
  parseContentStudioAudienceProfileContent(input);

const list = (count: number, make: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => make(i));
const entry = (i: number, length: number, fill = 'x') =>
  `${i} `.padEnd(length, fill);
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

// A profile whose canonical JSON is exactly `size` UTF-8 bytes: ASCII lists,
// a 3-byte role and tone, and a description of 3-byte and 1-byte characters
const sized = (size: number) => {
  const profile = {
    ...minimal(),
    role: EURO.repeat(300),
    preferredTone: EURO.repeat(300),
    locale: 'zh-Hant-TW',
    goals: list(10, (i) => entry(i, 300, 'g')),
    painPoints: list(10, (i) => entry(i, 300, 'p')),
    objections: list(10, (i) => entry(i, 300, 'o')),
  };
  const left = size - bytes(canonicalJson(profile));
  const euros = Math.floor(left / 3);
  const description = EURO.repeat(euros) + 'd'.repeat(left - euros * 3);
  expect(description.length).toBeLessThanOrEqual(2000);
  return { ...profile, description };
};

describe('Audience Profile v1 parser', () => {
  it('AP1 accepts the minimal profile as it is', () => {
    expect(parse(minimal())).toEqual(minimal());
    expect(emptyContentStudioAudienceProfileContent()).toEqual(minimal());
  });

  it('AP2 accepts a full profile, the same text allowed in two lists', () => {
    expect(parse(full())).toEqual(full());
  });

  it.each([[0], [2], ['1'], [null], [undefined], [1.5]])(
    'AP3 refuses schemaVersion %p',
    (schemaVersion) => {
      expect(refusal({ ...full(), schemaVersion })).toBe('INVALID');
    }
  );

  it.each([
    ['an age range', { ageRange: '35-44' }],
    ['a gender', { gender: MARKER }],
    ['ad interests', { adInterests: ['golf'] }],
    ['an audience id', { metaAudienceId: '123' }],
    ['emails', { emails: ['a@example.com'] }],
    ['an organization', { organizationId: 'org-b' }],
    ['metadata', { metadata: {} }],
  ])('AP4/AP5 refuses %s', (_name, extra) => {
    expect(refusal({ ...full(), ...extra })).toBe('INVALID');
  });

  it.each([
    'schemaVersion',
    'description',
    'role',
    'knowledgeLevel',
    ...LIST_KEYS,
  ])('requires %s', (key) => {
    const input: Record<string, unknown> = full();
    delete input[key];
    expect(refusal(input)).toBe('INVALID');
  });

  it('AP6/AP7 takes a description of up to 2000 characters, trimmed outside only', () => {
    expect(
      parse({ ...minimal(), description: 'd'.repeat(2000) }).description
    ).toHaveLength(2000);
    expect(refusal({ ...minimal(), description: 'd'.repeat(2001) })).toBe(
      'INVALID'
    );
    expect(
      parse({ ...minimal(), description: `  ${'d'.repeat(2000)} \r\n` })
        .description
    ).toHaveLength(2000);
    expect(
      parse({ ...minimal(), description: '\r\n Line one\r\n\r\n   indented\r' })
        .description
    ).toBe('Line one\n\n   indented');
  });

  it('AP8 takes a role of up to 300 characters, trimmed', () => {
    expect(parse({ ...minimal(), role: ' CTO \n' }).role).toBe('CTO');
    expect(parse({ ...minimal(), role: 'r'.repeat(300) }).role).toHaveLength(
      300
    );
    expect(refusal({ ...minimal(), role: 'r'.repeat(301) })).toBe('INVALID');
  });

  it.each([
    ['AP9', 'beginner'],
    ['AP10', 'intermediate'],
    ['AP11', 'expert'],
    ['AP12', 'mixed'],
  ])('%s accepts knowledge level %s', (_id, knowledgeLevel) => {
    expect(parse({ ...minimal(), knowledgeLevel }).knowledgeLevel).toBe(
      knowledgeLevel
    );
  });

  it.each([['Expert'], ['advanced'], [''], [null], [undefined], [3]])(
    'AP13 refuses knowledge level %p',
    (knowledgeLevel) => {
      expect(refusal({ ...minimal(), knowledgeLevel })).toBe('INVALID');
    }
  );

  it.each([
    ['AP14/AP15 goals', 'goals'],
    ['AP17/AP18 painPoints', 'painPoints'],
    ['AP20/AP21 objections', 'objections'],
  ] as const)(
    '%s: up to 10 entries of 1-300 characters, trimmed',
    (_name, key) => {
      const at = list(10, (i) => entry(i, 300));
      expect(parse({ ...minimal(), [key]: at })[key]).toEqual(at);
      expect(refusal({ ...minimal(), [key]: list(11, (i) => `${i}`) })).toBe(
        'INVALID'
      );
      expect(refusal({ ...minimal(), [key]: [entry(0, 301)] })).toBe('INVALID');
      expect(
        parse({ ...minimal(), [key]: [`  ${entry(0, 300)}\r\n`] })[key]
      ).toEqual([entry(0, 300)]);
      expect(refusal({ ...minimal(), [key]: [' \n '] })).toBe('INVALID');
    }
  );

  it.each([
    ['AP16 goals', 'goals'],
    ['AP19 painPoints', 'painPoints'],
    ['AP22 objections', 'objections'],
  ] as const)(
    '%s refuses an entry twice, also once trimmed, never merging it',
    (_name, key) => {
      expect(refusal({ ...minimal(), [key]: [MARKER, MARKER] })).toBe(
        'INVALID'
      );
      expect(
        refusal({ ...minimal(), [key]: ['Save time', ' Save time\n'] })
      ).toBe('INVALID');
      expect(
        parse({ ...minimal(), [key]: ['Save time', 'save time'] })[key]
      ).toEqual(['Save time', 'save time']);
    }
  );

  it('AP23/AP24 stores a tone left out, null or blank as null; at most 300 characters', () => {
    const omitted: Record<string, unknown> = minimal();
    delete omitted.preferredTone;
    expect(parse(omitted).preferredTone).toBeNull();
    expect(parse({ ...minimal(), preferredTone: null }).preferredTone).toBe(
      null
    );
    expect(parse({ ...minimal(), preferredTone: ' \r\n ' }).preferredTone).toBe(
      null
    );
    expect(
      parse({ ...minimal(), preferredTone: ' Calm\r\nand clear ' })
        .preferredTone
    ).toBe('Calm\nand clear');
    expect(
      parse({ ...minimal(), preferredTone: 't'.repeat(300) }).preferredTone
    ).toHaveLength(300);
    expect(refusal({ ...minimal(), preferredTone: 't'.repeat(301) })).toBe(
      'INVALID'
    );
    expect(refusal({ ...minimal(), preferredTone: 5 })).toBe('INVALID');
  });

  it('AP25 stores a locale left out, null or blank as null', () => {
    const omitted: Record<string, unknown> = minimal();
    delete omitted.locale;
    expect(parse(omitted).locale).toBeNull();
    expect(parse({ ...minimal(), locale: null }).locale).toBeNull();
    expect(parse({ ...minimal(), locale: '' }).locale).toBeNull();
    expect(parse({ ...minimal(), locale: '  \t ' }).locale).toBeNull();
  });

  it('AP26 takes a locale of up to 35 characters', () => {
    const at = `en-${'a1b2c3d4-'.repeat(3)}abcde`;
    expect(at).toHaveLength(35);
    expect(parse({ ...minimal(), locale: at }).locale).toBe(at);
    expect(refusal({ ...minimal(), locale: `${at}e` })).toBe('INVALID');
  });

  it.each([
    ['nl'],
    ['nl-NL'],
    ['en'],
    ['en-US'],
    ['en-GB'],
    ['de-DE'],
    ['fr-BE'],
    ['pt-BR'],
    ['zh-Hans'],
    ['zh-Hant-TW'],
    ['es-419'],
  ])('AP27 accepts the locale %s', (locale) => {
    expect(parse({ ...minimal(), locale }).locale).toBe(locale);
  });

  it.each([
    ['en_US'],
    ['-nl'],
    ['nl-'],
    ['nl--NL'],
    ['x'],
    ['n'],
    ['en US'],
    ['nl-NL nl'],
    ['https://example.com'],
    ['nl/NL'],
    ['nl.NL'],
    [`nl${NUL}`],
    ['nl-\nNL'],
    ['toolonglang'],
    ['en-toolongsubtag'],
    [`nl-${EURO}`],
    [MARKER],
    [42],
    [['nl']],
  ])('AP28 refuses the locale %p', (locale) => {
    expect(refusal({ ...minimal(), locale })).toBe('INVALID');
  });

  it('AP29 keeps the locale casing as typed, trimmed only', () => {
    expect(parse({ ...minimal(), locale: ' NL-nl ' }).locale).toBe('NL-nl');
    expect(parse({ ...minimal(), locale: 'zh-hant-tw' }).locale).toBe(
      'zh-hant-tw'
    );
    expect(parse({ ...minimal(), locale: 'EN' }).locale).toBe('EN');
  });

  it.each([
    ['AP30 NUL in the description', { description: `a${NUL}${MARKER}` }],
    ['AP30 NUL in an objection', { objections: [`${NUL}${MARKER}`] }],
    ['AP31 a lone high surrogate', { role: `a${HIGH} ${MARKER}` }],
    ['AP31 a trailing high surrogate', { preferredTone: `${MARKER}${HIGH}` }],
    ['AP32 a lone low surrogate', { goals: [`${LOW}${MARKER}`] }],
    ['AP32 reversed surrogates', { painPoints: [`${LOW}${HIGH}`] }],
  ])('refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it('AP33 accepts a valid surrogate pair', () => {
    const smile = `Smile ${HIGH}${LOW}`;
    const parsed = parse({
      ...minimal(),
      description: smile,
      goals: [smile],
      preferredTone: smile,
    });
    expect([parsed.description, parsed.goals[0], parsed.preferredTone]).toEqual(
      [smile, smile, smile]
    );
  });

  it('AP34 refuses class instances, dates, maps, sets and functions', () => {
    class Profile {
      schemaVersion = 1;
      description = '';
      role = '';
      knowledgeLevel = 'mixed';
      goals = [];
      painPoints = [];
      objections = [];
      preferredTone = null;
      locale = null;
    }
    expect(refusal(new Profile())).toBe('INVALID');
    expect(refusal({ ...minimal(), goals: [new Date(0)] })).toBe('INVALID');
    expect(refusal({ ...minimal(), painPoints: new Map() })).toBe('INVALID');
    expect(refusal({ ...minimal(), objections: new Set(['x']) })).toBe(
      'INVALID'
    );
    expect(refusal({ ...minimal(), description: () => MARKER })).toBe(
      'INVALID'
    );
  });

  it.each([
    ['a list as text', { goals: 'Save time' }],
    ['a number entry', { painPoints: [1] }],
    ['an object entry', { objections: [{ text: 'x' }] }],
    ['a numeric description', { description: 5 }],
    ['a null description', { description: null }],
    ['a null role', { role: null }],
    ['a null list', { goals: null }],
    ['a null entry', { objections: [null] }],
  ])('AP35 refuses %s', (_name, change) => {
    expect(refusal({ ...full(), ...change })).toBe('INVALID');
  });

  it.each([[null], ['profile'], [[]], [42], [undefined]])(
    'AP35 refuses %p as a profile',
    (input) => {
      expect(refusal(input)).toBe('INVALID');
    }
  );

  it('AP36 never changes the input', () => {
    const input = {
      ...full(),
      goals: ['  Padded\r\n', 'Second'],
      preferredTone: ' ',
      locale: ' nl ',
    };
    const copy = JSON.parse(JSON.stringify(input));
    parse(input);
    expect(input).toEqual(copy);
  });

  it('AP37 accepts a profile of exactly 16384 bytes', () => {
    const parsed = parse(sized(AUDIENCE_PROFILE_CONTENT_MAX_BYTES));
    expect(bytes(canonicalJson(parsed))).toBe(16_384);
    expect(bytes(JSON.stringify(parsed))).toBe(16_384);
  });

  it('AP38 refuses a profile of 16385 bytes as too large', () => {
    expect(refusal(sized(AUDIENCE_PROFILE_CONTENT_MAX_BYTES + 1))).toBe(
      'TOO_LARGE'
    );
  });

  it('AP39 counts UTF-8 bytes, not characters', () => {
    // 3 bytes per character: every field within its character limit, well
    // under 16384 characters in all, but over 16 KiB as UTF-8
    const input = {
      ...minimal(),
      description: `${MARKER}${EURO.repeat(1900)}`,
      goals: list(10, (i) => entry(i, 300, EURO)),
      painPoints: list(10, (i) => entry(i, 300, EURO)),
    };
    expect(JSON.stringify(input).length).toBeLessThan(16_384);
    expect(bytes(JSON.stringify(input))).toBeGreaterThan(16_384);
    expect(refusal(input)).toBe('TOO_LARGE');
    expect(
      parse({ ...minimal(), description: EURO.repeat(2000) }).description
    ).toHaveLength(2000);
  });

  it('AP40 normalizes deterministically, whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(full()).reverse());
    const a = parse(full());
    const b = parse(reordered);
    expect(a).toEqual(b);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(parse(a)).toEqual(a);
  });

  it('reports issues as paths and kinds only', () => {
    try {
      parse({ ...full(), objections: [MARKER, MARKER] });
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as ContentStudioAudienceProfileError).issues).toEqual([
        { path: ['objections', 1], code: 'custom' },
      ]);
      expect((err as Error).message).toBe(
        'The audience profile does not match schema version 1'
      );
    }
  });

  it('holds exactly the editorial fields, nothing about people or targeting', () => {
    expect(Object.keys(parse(full())).sort()).toEqual([
      'description',
      'goals',
      'knowledgeLevel',
      'locale',
      'objections',
      'painPoints',
      'preferredTone',
      'role',
      'schemaVersion',
    ]);
  });
});

describe('Audience Profile revisions: canonical storage and integrity', () => {
  const stored = (input: unknown = full()) =>
    storedContentStudioAudienceProfileContent(parse(input));
  const failsIntegrity = (revision: {
    schemaVersion: number;
    content: string;
    contentHash: string;
  }) => {
    let error: unknown;
    try {
      parseVerifiedContentStudioAudienceProfileRevision(revision);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContentStudioAudienceProfileIntegrityError);
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

  it('AH1 gives the same text and hash whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(full()).reverse());
    expect(stored(reordered)).toEqual(stored());
    expect(stored().content.startsWith('{"description":')).toBe(true);
  });

  it('AH2 gives the same hash for CRLF, CR and LF', () => {
    const lf = { ...full(), description: 'one\ntwo' };
    expect(stored({ ...lf, description: 'one\r\ntwo' })).toEqual(stored(lf));
    expect(stored({ ...lf, description: 'one\rtwo' })).toEqual(stored(lf));
  });

  it('AH3/AH4 changes the hash with the meaning; a lowercase SHA-256 of the text', () => {
    const a = stored();
    expect(
      stored({ ...full(), knowledgeLevel: 'expert' }).contentHash
    ).not.toBe(a.contentHash);
    expect(stored({ ...full(), locale: 'nl' }).contentHash).not.toBe(
      a.contentHash
    );
    expect(
      stored({ ...full(), goals: [...full().goals].reverse() }).contentHash
    ).not.toBe(a.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(sha256Hex(a.content));
    expect(a.schemaVersion).toBe(1);
  });

  it('AH5 reads a stored revision back as the parsed profile', () => {
    expect(parseVerifiedContentStudioAudienceProfileRevision(stored())).toEqual(
      parse(full())
    );
    expect(
      parseVerifiedContentStudioAudienceProfileRevision(stored(minimal()))
    ).toEqual(minimal());
  });

  it('AH6 fails on text that is not JSON', () => {
    const revision = stored();
    failsIntegrity({ ...revision, content: revision.content.slice(0, -1) });
    failsIntegrity(hashed(MARKER));
  });

  it('AH7 fails on another schema version in the row', () => {
    failsIntegrity({ ...stored(), schemaVersion: 2 });
  });

  it('AH8 fails on another schema version in the content', () => {
    failsIntegrity(hashed({ ...full(), schemaVersion: 2 }));
    failsIntegrity({
      ...hashed({ ...full(), schemaVersion: 2 }),
      schemaVersion: 2,
    });
  });

  it('AH9 fails on a hash that does not match', () => {
    failsIntegrity({ ...stored(), contentHash: 'f'.repeat(64) });
    failsIntegrity({
      ...stored(),
      contentHash: stored().contentHash.toUpperCase(),
    });
  });

  it('AH10 fails on valid but non-canonical text, even correctly hashed', () => {
    const content = JSON.stringify(parse(full()));
    expect(content).not.toBe(stored().content);
    failsIntegrity({
      schemaVersion: 1,
      content,
      contentHash: sha256Hex(content),
    });
    // an untrimmed tone would be trimmed on parse: refused, not repaired
    failsIntegrity(hashed({ ...parse(full()), preferredTone: ` ${MARKER} ` }));
  });

  it('AH11 fails on a stored field the schema does not know', () => {
    failsIntegrity(hashed({ ...parse(full()), ageRange: MARKER }));
  });

  it('AH12 never quotes the stored text', () => {
    const revision = stored();
    expect(revision.content).toContain(MARKER);
    failsIntegrity({ ...revision, contentHash: '0'.repeat(64) });
    expect(new ContentStudioAudienceProfileIntegrityError().message).toBe(
      'A stored audience profile revision failed its integrity check'
    );
  });
});

// Editorial context only: no field, method or route models people, their
// traits or ad targeting. Code only (comments are stripped), whole words only
const AUDIENCE_TARGETING_TERMS =
  /\b(age|ageRange|gender|income|ethnicity|religion|politics|political|interests?|interestIds|adInterests|lookalike|device|cookie|trackingId|facebookAudienceId|metaAudienceId|googleAudienceId|locationRadius|radius|zipCodes?|postalCodes?|emails?|phoneNumbers?|contacts?|customerList|crm|segmentSize|health|sexualOrientation)\b/i;

describe('Audience Profile source', () => {
  const read = (file: string) =>
    fs
      .readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('keeps the parser free of Node modules, so a browser could use it', () => {
    expect(read('audience.profile.ts')).not.toMatch(
      /from '(crypto|fs|path|util|buffer|node:[a-z]+)'|require\(/
    );
  });

  it('has no targeting, personal-data, AI, fetching or logging code', () => {
    for (const file of [
      'audience.profile.ts',
      'audience.profile.revision.ts',
    ]) {
      const text = read(file);
      expect(text).not.toMatch(AUDIENCE_TARGETING_TERMS);
      expect(text).not.toMatch(
        /ai\.execution|ai\.provider|AIConnection|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|Intl\.|console\.|Logger|infer/
      );
    }
  });
});
