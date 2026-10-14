import { inspect } from 'util';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioWritingProfileContentV1,
  ContentStudioWritingProfileError,
  emptyContentStudioWritingProfileContent,
  parseContentStudioWritingProfileContent,
  WRITING_PROFILE_CONTENT_MAX_BYTES,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  ContentStudioWritingProfileIntegrityError,
  parseVerifiedContentStudioWritingProfileRevision,
  storedContentStudioWritingProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile.revision';

const MARKER = 'WRITING_PROFILE_SECRET_MARKER_123';

const minimal = () => ({
  schemaVersion: 1,
  voice: '',
  toneTags: [] as unknown[],
  perspective: null as unknown,
  formatting: { emoji: 'none', hashtags: 'none', notes: null } as Record<
    string,
    unknown
  >,
  vocabulary: { prefer: [] as unknown[], avoid: [] as unknown[] },
  dos: [] as unknown[],
  donts: [] as unknown[],
  examples: [] as unknown[],
});

const full = () => ({
  schemaVersion: 1,
  voice: `Warm, direct and practical. ${MARKER}`,
  toneTags: ['warm', 'direct', 'Practical'],
  perspective: 'first_plural',
  formatting: { emoji: 'sparing', hashtags: 'few', notes: 'One emoji max.' },
  vocabulary: { prefer: ['customers', 'team'], avoid: ['synergy'] },
  dos: ['Lead with the benefit.', 'Use short sentences.'],
  donts: ['No jargon.'],
  examples: [
    { text: `  - We shipped it.\n  - It works.\n${MARKER}`, note: 'A list' },
    { text: 'Plain example', note: null },
  ],
});

const refusal = (input: unknown) => {
  try {
    parseContentStudioWritingProfileContent(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioWritingProfileError);
    expect(
      [
        String(err),
        (err as Error).stack,
        JSON.stringify(err),
        inspect(err, { depth: 6 }),
      ].join('\n')
    ).not.toContain(MARKER);
    return (err as ContentStudioWritingProfileError).code;
  }
  throw new Error('expected a refusal');
};

const withPath = (path: string[], value: unknown) => {
  const input = full() as Record<string, unknown>;
  let target = input;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1]] = value;
  return input;
};

const list = (count: number, make: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => make(i));

describe('Writing DNA v1 parser', () => {
  it('WP1 accepts a minimal profile as it is', () => {
    expect(parseContentStudioWritingProfileContent(minimal())).toEqual(
      minimal()
    );
  });

  it('WP2 accepts a full profile', () => {
    const parsed = parseContentStudioWritingProfileContent(full());
    expect(parsed).toEqual(full());
  });

  it.each([[0], [2], ['1'], [null], [undefined]])(
    'WP3 refuses schemaVersion %p',
    (schemaVersion) => {
      expect(refusal({ ...full(), schemaVersion })).toBe('INVALID');
    }
  );

  it.each([
    ['WP4 a top-level field', { ...full(), audience: 'founders' }],
    ['WP4 an id', { ...full(), id: 'x' }],
    ['WP5 a formatting field', withPath(['formatting', 'font'], 'serif')],
    ['WP5 a vocabulary field', withPath(['vocabulary', 'maybe'], [])],
    [
      'WP5 an example field',
      { ...full(), examples: [{ text: 'x', note: null, url: 'https://x' }] },
    ],
  ])('refuses %s', (_name, input) => {
    expect(refusal(input)).toBe('INVALID');
  });

  it('WP6/WP7 takes a voice of up to 1000 characters', () => {
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['voice'], 'v'.repeat(1000))
      ).voice
    ).toHaveLength(1000);
    expect(refusal(withPath(['voice'], 'v'.repeat(1001)))).toBe('INVALID');
  });

  it('WP8/WP9 takes up to 10 tone tags of up to 60 characters', () => {
    expect(
      parseContentStudioWritingProfileContent(
        withPath(
          ['toneTags'],
          list(10, (i) => `tag ${i}`)
        )
      ).toneTags
    ).toHaveLength(10);
    expect(
      refusal(
        withPath(
          ['toneTags'],
          list(11, (i) => `tag ${i}`)
        )
      )
    ).toBe('INVALID');
    expect(refusal(withPath(['toneTags'], ['t'.repeat(61)]))).toBe('INVALID');
    expect(refusal(withPath(['toneTags'], ['   ']))).toBe('INVALID');
  });

  it('WP10 trims tone tags and keeps their case', () => {
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['toneTags'], ['  Warm ', '\tdirect\n'])
      ).toneTags
    ).toEqual(['Warm', 'direct']);
  });

  it('WP11 refuses a duplicate tone tag, also after trimming', () => {
    expect(refusal(withPath(['toneTags'], ['warm', ' warm ']))).toBe('INVALID');
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['toneTags'], ['warm', 'Warm'])
      ).toneTags
    ).toEqual(['warm', 'Warm']);
  });

  it('WP12 takes exactly the listed perspectives, or none', () => {
    for (const perspective of [
      'first_singular',
      'first_plural',
      'second',
      'third',
      'mixed',
      null,
    ]) {
      expect(
        parseContentStudioWritingProfileContent(
          withPath(['perspective'], perspective)
        ).perspective
      ).toBe(perspective);
    }
    for (const perspective of ['first', 'Third', '', 3]) {
      expect(refusal(withPath(['perspective'], perspective))).toBe('INVALID');
    }
  });

  it('WP13/WP14 takes exactly the listed emoji and hashtag uses', () => {
    for (const emoji of ['none', 'sparing', 'free']) {
      expect(
        parseContentStudioWritingProfileContent(
          withPath(['formatting', 'emoji'], emoji)
        ).formatting.emoji
      ).toBe(emoji);
    }
    for (const hashtags of ['none', 'few', 'many']) {
      expect(
        parseContentStudioWritingProfileContent(
          withPath(['formatting', 'hashtags'], hashtags)
        ).formatting.hashtags
      ).toBe(hashtags);
    }
    for (const [key, value] of [
      ['emoji', 'lots'],
      ['emoji', null],
      ['hashtags', 'some'],
      ['hashtags', 'None'],
    ]) {
      expect(refusal(withPath(['formatting', key], value))).toBe('INVALID');
    }
  });

  it('WP15 takes formatting notes of up to 500 characters', () => {
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['formatting', 'notes'], 'n'.repeat(500))
      ).formatting.notes
    ).toHaveLength(500);
    expect(refusal(withPath(['formatting', 'notes'], 'n'.repeat(501)))).toBe(
      'INVALID'
    );
  });

  it.each([['prefer'], ['avoid']])(
    'WP16-WP19 takes up to 30 distinct %s terms of up to 60 characters',
    (key) => {
      const terms = list(30, (i) => `${key} term ${i}`);
      const other = key === 'prefer' ? 'avoid' : 'prefer';
      const input = withPath(['vocabulary', key], terms);
      (input.vocabulary as Record<string, unknown>)[other] = [];
      expect(
        (
          parseContentStudioWritingProfileContent(input).vocabulary as Record<
            string,
            string[]
          >
        )[key]
      ).toHaveLength(30);
      expect(
        refusal(withPath(['vocabulary', key], [...terms, 'one more']))
      ).toBe('INVALID');
      expect(refusal(withPath(['vocabulary', key], ['t'.repeat(61)]))).toBe(
        'INVALID'
      );
      expect(refusal(withPath(['vocabulary', key], ['same', ' same']))).toBe(
        'INVALID'
      );
    }
  );

  it('WP20 refuses a term that is both preferred and avoided', () => {
    expect(
      refusal(
        withPath(['vocabulary'], { prefer: ['growth'], avoid: [' growth '] })
      )
    ).toBe('INVALID');
  });

  it.each([['dos'], ['donts']])(
    'WP21/WP22 takes up to 20 distinct %s of up to 300 characters',
    (key) => {
      const rules = list(20, (i) => `Rule ${i}.`);
      expect(
        (
          parseContentStudioWritingProfileContent(
            withPath([key], rules)
          ) as unknown as Record<string, string[]>
        )[key]
      ).toHaveLength(20);
      expect(refusal(withPath([key], [...rules, 'Rule 20.']))).toBe('INVALID');
      expect(refusal(withPath([key], ['r'.repeat(301)]))).toBe('INVALID');
      expect(refusal(withPath([key], ['Rule.', 'Rule.']))).toBe('INVALID');
      expect(refusal(withPath([key], ['']))).toBe('INVALID');
    }
  );

  it('WP23 takes up to 5 examples', () => {
    const examples = list(5, (i) => `Example ${i}`).map((text) => ({
      text,
      note: null,
    }));
    expect(
      parseContentStudioWritingProfileContent(withPath(['examples'], examples))
        .examples
    ).toHaveLength(5);
    expect(
      refusal(withPath(['examples'], [...examples, { text: 'x', note: null }]))
    ).toBe('INVALID');
  });

  it('WP24/WP25 needs example text with something besides whitespace, up to 5000 characters', () => {
    for (const text of ['', '   ', '\n\n', undefined, 5]) {
      expect(refusal(withPath(['examples'], [{ text, note: null }]))).toBe(
        'INVALID'
      );
    }
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['examples'], [{ text: 'e'.repeat(5000), note: null }])
      ).examples[0].text
    ).toHaveLength(5000);
    expect(
      refusal(withPath(['examples'], [{ text: 'e'.repeat(5001), note: null }]))
    ).toBe('INVALID');
  });

  it('WP26 takes an example note of up to 300 characters; blank or left out is null', () => {
    const note = (value: unknown) =>
      parseContentStudioWritingProfileContent(
        withPath(['examples'], [{ text: 'x', note: value }])
      ).examples[0].note;
    expect(note('n'.repeat(300))).toHaveLength(300);
    expect(note('   ')).toBeNull();
    expect(note(null)).toBeNull();
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['examples'], [{ text: 'x' }])
      ).examples[0].note
    ).toBeNull();
    expect(
      refusal(withPath(['examples'], [{ text: 'x', note: 'n'.repeat(301) }]))
    ).toBe('INVALID');
  });

  it('WP27 normalizes CRLF and CR to LF, and keeps example text as written otherwise', () => {
    const parsed = parseContentStudioWritingProfileContent({
      ...full(),
      voice: ' Line one\r\nline two\rline three ',
      examples: [{ text: '  indented\r\n    deeper\r\n', note: ' n\r\n ' }],
    });
    expect(parsed.voice).toBe('Line one\nline two\nline three');
    expect(parsed.examples[0]).toEqual({
      text: '  indented\n    deeper\n',
      note: 'n',
    });
  });

  it.each([
    ['WP28 NUL in the voice', ['voice'], 'a\u0000b'],
    ['WP28 NUL in a tag', ['toneTags'], ['a\u0000b']],
    ['WP29 a lone high surrogate', ['voice'], 'a\ud83d b'],
    ['WP30 a lone low surrogate', ['dos'], ['a\ude00 b']],
    ['WP28 NUL in an example', ['examples'], [{ text: 'a\u0000', note: null }]],
    ['WP29 a lone surrogate in a note', ['formatting', 'notes'], '\ud800'],
  ])('refuses %s', (_name, path, value) => {
    expect(refusal(withPath(path as string[], value))).toBe('INVALID');
  });

  it('WP31 accepts a surrogate pair', () => {
    expect(
      parseContentStudioWritingProfileContent(
        withPath(['voice'], 'Launch \ud83d\ude80')
      ).voice
    ).toBe('Launch \ud83d\ude80');
  });

  // full rule lists plus examples, padded to exactly byteTarget bytes of JSON
  const sized = (byteTarget: number) => {
    const content = {
      ...minimal(),
      dos: list(20, (i) => `${i}`.padEnd(300, 'd')),
      donts: list(20, (i) => `${i}`.padEnd(300, 'n')),
      examples: [0, 1, 2, 3, 4].map((i) => ({ text: `${i}`, note: null })),
    };
    let remaining = byteTarget - Buffer.byteLength(JSON.stringify(content));
    for (const example of content.examples) {
      const add = Math.min(remaining, 4999);
      example.text += 'a'.repeat(add);
      remaining -= add;
    }
    if (remaining !== 0) {
      throw new Error('fixture cannot reach the target size');
    }
    return content;
  };

  it('WP32/WP33 caps canonical content at 32768 UTF-8 bytes', () => {
    const size = Buffer.byteLength(
      canonicalJson(
        parseContentStudioWritingProfileContent(
          sized(WRITING_PROFILE_CONTENT_MAX_BYTES)
        )
      ),
      'utf8'
    );
    expect(size).toBe(WRITING_PROFILE_CONTENT_MAX_BYTES);
    expect(refusal(sized(WRITING_PROFILE_CONTENT_MAX_BYTES + 1))).toBe(
      'TOO_LARGE'
    );
  });

  it('WP34 counts bytes, not characters', () => {
    // 4500 characters of a 2-byte letter: each example is in its character
    // limit, together they are 45000 bytes
    const examples = [0, 1, 2, 3, 4].map(() => ({
      text: '\u00e9'.repeat(4500),
      note: null,
    }));
    const input = { ...minimal(), examples };
    expect(JSON.stringify(input).length).toBeLessThan(
      WRITING_PROFILE_CONTENT_MAX_BYTES
    );
    expect(refusal(input)).toBe('TOO_LARGE');
  });

  it('WP35 normalizes to the same canonical text however it was written', () => {
    const reordered = Object.fromEntries(Object.entries(full()).reverse());
    expect(
      canonicalJson(parseContentStudioWritingProfileContent(reordered))
    ).toBe(canonicalJson(parseContentStudioWritingProfileContent(full())));
  });

  it('WP36 leaves the input untouched', () => {
    const input = {
      ...full(),
      voice: ' padded\r\n ',
      toneTags: [' warm '],
    };
    const before = JSON.stringify(input);
    parseContentStudioWritingProfileContent(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    [
      'WP37 a class instance',
      new (class Profile {
        schemaVersion = 1;
      })(),
    ],
    ['WP37 a nested class instance', withPath(['formatting'], new Date())],
    ['WP37 a nested map', withPath(['vocabulary'], new Map())],
    ['WP38 an array as content', [full()]],
    ['WP38 an object as toneTags', withPath(['toneTags'], { warm: true })],
    ['WP38 an array as formatting', withPath(['formatting'], ['none'])],
    ['WP38 a string as examples', withPath(['examples'], 'Hello')],
    ['null', null],
    ['a string', JSON.stringify(full())],
  ])('refuses %s', (_name, input) => {
    expect(refusal(input)).toBe('INVALID');
  });

  it('WP39 stores perspective and notes as explicit null when left out', () => {
    const input = minimal() as Record<string, unknown>;
    delete input.perspective;
    delete (input.formatting as Record<string, unknown>).notes;
    const parsed = parseContentStudioWritingProfileContent(input);
    expect(parsed.perspective).toBeNull();
    expect(parsed.formatting.notes).toBeNull();
    expect(Object.keys(parsed)).toContain('perspective');
    for (const key of [
      'voice',
      'toneTags',
      'formatting',
      'vocabulary',
      'dos',
      'donts',
      'examples',
    ]) {
      const missing = minimal() as Record<string, unknown>;
      delete missing[key];
      expect(refusal(missing)).toBe('INVALID');
    }
  });

  it('WP40 has an empty profile with no voice, emoji or hashtags', () => {
    expect(emptyContentStudioWritingProfileContent()).toEqual(minimal());
    expect(emptyContentStudioWritingProfileContent()).not.toBe(
      emptyContentStudioWritingProfileContent()
    );
  });

  it('reports issues as paths and kinds only', () => {
    try {
      parseContentStudioWritingProfileContent(
        withPath(['voice'], `${MARKER}${'x'.repeat(1000)}`)
      );
      throw new Error('expected a refusal');
    } catch (err) {
      const error = err as ContentStudioWritingProfileError;
      expect(error.message).toBe(
        'The writing profile does not match schema version 1'
      );
      expect(error.issues).toEqual([{ path: ['voice'], code: 'too_big' }]);
      expect(inspect(error, { depth: 6 })).not.toContain(MARKER);
    }
  });
});

describe('Writing DNA canonical storage and integrity', () => {
  const stored = (input: unknown) =>
    storedContentStudioWritingProfileContent(
      parseContentStudioWritingProfileContent(input)
    );

  it('WH1/WH3/WH4 gives equal content one canonical text and hash', () => {
    const a = stored(full());
    const b = stored({
      ...Object.fromEntries(Object.entries(full()).reverse()),
      voice: `Warm, direct and practical. ${MARKER}\r\n`,
      toneTags: [' warm', 'direct ', 'Practical'],
    });
    expect(b).toEqual(a);
    expect(a.schemaVersion).toBe(1);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(sha256Hex(a.content));
    expect(a.content).toBe(canonicalJson(JSON.parse(a.content)));
  });

  it('WH2 changes the hash with the meaning', () => {
    expect(
      stored(withPath(['dos'], ['Lead with the benefit.'])).contentHash
    ).not.toBe(stored(full()).contentHash);
  });

  it('WH5 reads a stored revision back', () => {
    const revision = stored(full());
    expect(parseVerifiedContentStudioWritingProfileRevision(revision)).toEqual(
      parseContentStudioWritingProfileContent(full())
    );
  });

  const corrupt = (change: (revision: ReturnType<typeof stored>) => object) => {
    const revision = stored(full());
    try {
      parseVerifiedContentStudioWritingProfileRevision({
        ...revision,
        ...change(revision),
      } as never);
    } catch (err) {
      expect(err).toBeInstanceOf(ContentStudioWritingProfileIntegrityError);
      expect(
        [String(err), (err as Error).stack, inspect(err, { depth: 6 })].join(
          '\n'
        )
      ).not.toContain(MARKER);
      return (err as Error).message;
    }
    throw new Error('expected an integrity failure');
  };

  it.each([
    [
      'WH6 malformed JSON',
      (r: { content: string }) => ({ content: r.content.slice(1) }),
    ],
    ['WH7 another schema version', () => ({ schemaVersion: 2 })],
    ['WH8 another hash', () => ({ contentHash: 'f'.repeat(64) })],
    [
      'WH9 non-canonical JSON',
      (r: { content: string }) => {
        const content = JSON.stringify(JSON.parse(r.content), null, 1);
        return { content, contentHash: sha256Hex(content) };
      },
    ],
    [
      'WH9 content that needs normalizing',
      (r: { content: string }) => {
        const parsed = JSON.parse(r.content);
        parsed.voice = ` ${parsed.voice}`;
        const content = canonicalJson(parsed);
        return { content, contentHash: sha256Hex(content) };
      },
    ],
    [
      'WH10 an unknown stored field',
      (r: { content: string }) => {
        const content = canonicalJson({ ...JSON.parse(r.content), extra: 1 });
        return { content, contentHash: sha256Hex(content) };
      },
    ],
  ])('WH11 refuses %s with a fixed message', (_name, change) => {
    expect(corrupt(change as never)).toBe(
      'A stored writing profile revision failed its integrity check'
    );
  });

  it('keeps the content out of the stored values it does not own', () => {
    const value: ContentStudioWritingProfileContentV1 =
      parseContentStudioWritingProfileContent(full());
    expect(
      Object.keys(storedContentStudioWritingProfileContent(value)).sort()
    ).toEqual(['content', 'contentHash', 'schemaVersion']);
  });
});

describe('Writing DNA source', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const path = jest.requireActual<typeof import('path')>('path');

  it('uses no Node-only module in the parser and logs nothing', () => {
    const parser = fs.readFileSync(
      path.join(__dirname, 'writing.profile.ts'),
      'utf8'
    );
    expect(parser).not.toMatch(
      /from 'crypto'|from 'fs'|canonical\.json|console\.|Logger/
    );
    const revision = fs.readFileSync(
      path.join(__dirname, 'writing.profile.revision.ts'),
      'utf8'
    );
    expect(revision).not.toMatch(/console\.|Logger|process\.env/);
  });
});
