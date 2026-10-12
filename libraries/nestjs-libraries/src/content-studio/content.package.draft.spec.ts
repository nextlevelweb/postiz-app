import {
  assertContentPackagePublishable,
  ContentPackageDraftError,
  ContentPackageDraftV1,
  DRAFT_CANONICAL_MAX_BYTES,
  emptyContentPackageDraft,
  ITEM_MEDIA_MAX,
  ITEM_TEXT_MAX,
  PACKAGE_UNIQUE_MEDIA_MAX,
  parseContentPackageDraft,
  THREAD_ITEMS_MAX,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

const UUID = '3f2b1c9e-8a4d-4f7e-9b1a-2c3d4e5f6a7b';

const item = (id: string, text = '', mediaIds: unknown[] = []) => ({
  id,
  text,
  mediaIds,
});
const draft = (thread: unknown[]) => ({
  schemaVersion: 1,
  copy: { global: { thread } },
});
const mediaIds = (count: number, prefix = 'm') =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const items = (count: number) =>
  Array.from({ length: count }, (_, index) => item(`i${index}`));

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContentPackageDraftError);
    return error as ContentPackageDraftError;
  }
  throw new Error('expected a ContentPackageDraftError');
};
const parseFailure = (input: unknown) =>
  failure(() => parseContentPackageDraft(input));
const expectInvalid = (input: unknown) => {
  const error = parseFailure(input);
  expect(error.code).toBe('INVALID_DRAFT');
  return error.issues || [];
};

// A draft whose JSON is exactly `bytes` long, spread over 7 items of ASCII
const draftOfBytes = (bytes: number) => {
  const thread = items(7);
  let remaining =
    bytes - Buffer.byteLength(JSON.stringify(draft(thread)), 'utf8');
  for (const entry of thread) {
    const length = Math.min(remaining, ITEM_TEXT_MAX);
    entry.text = 'x'.repeat(length);
    remaining -= length;
  }
  expect(remaining).toBe(0);
  return draft(thread);
};
// The same draft with every key written in reverse order
const reversedKeys = (value: ReturnType<typeof draftOfBytes>) => ({
  copy: {
    global: {
      thread: (value.copy.global.thread as ReturnType<typeof item>[]).map(
        (entry) => ({
          mediaIds: entry.mediaIds,
          text: entry.text,
          id: entry.id,
        })
      ),
    },
  },
  schemaVersion: value.schemaVersion,
});

describe('ContentPackageDraft v1', () => {
  describe('minimal valid draft', () => {
    it('accepts one empty item and returns the normalized shape', () => {
      const input = draft([item('main')]);
      const parsed = parseContentPackageDraft(input);

      expect(parsed).toEqual({
        schemaVersion: 1,
        copy: { global: { thread: [{ id: 'main', text: '', mediaIds: [] }] } },
      });
      expect(parsed).not.toBe(input);
    });

    it('keeps thread and media order', () => {
      const parsed = parseContentPackageDraft(
        draft([item('b', 'second', [UUID, 'a']), item('a', 'third', ['z'])])
      );
      expect(parsed.copy.global.thread.map((entry) => entry.id)).toEqual([
        'b',
        'a',
      ]);
      expect(parsed.copy.global.thread[0].mediaIds).toEqual([UUID, 'a']);
    });
  });

  describe('limit boundaries', () => {
    it(`accepts ${THREAD_ITEMS_MAX} items and rejects one more`, () => {
      expect(
        parseContentPackageDraft(draft(items(THREAD_ITEMS_MAX))).copy.global
          .thread
      ).toHaveLength(25);
      expect(expectInvalid(draft(items(THREAD_ITEMS_MAX + 1)))).toEqual([
        { path: ['copy', 'global', 'thread'], code: 'too_big' },
      ]);
    });

    it(`accepts ${ITEM_TEXT_MAX} characters of text and rejects one more`, () => {
      expect(
        parseContentPackageDraft(draft([item('a', 'x'.repeat(ITEM_TEXT_MAX))]))
      ).toBeDefined();
      expect(
        expectInvalid(draft([item('a', 'x'.repeat(ITEM_TEXT_MAX + 1))]))
      ).toEqual([
        { path: ['copy', 'global', 'thread', 0, 'text'], code: 'too_big' },
      ]);
    });

    it('counts text after line endings are normalized', () => {
      const parsed = parseContentPackageDraft(
        draft([item('a', 'a\r\n'.repeat(ITEM_TEXT_MAX / 2))])
      );
      expect(parsed.copy.global.thread[0].text).toHaveLength(ITEM_TEXT_MAX);
    });

    it('counts UTF-16 code units, so an emoji counts twice', () => {
      expect(
        parseContentPackageDraft(
          draft([item('a', '😀'.repeat(ITEM_TEXT_MAX / 2))])
        )
      ).toBeDefined();
      expect(
        expectInvalid(draft([item('a', '😀'.repeat(ITEM_TEXT_MAX / 2) + 'x')]))
      ).toEqual([
        { path: ['copy', 'global', 'thread', 0, 'text'], code: 'too_big' },
      ]);
    });

    it(`accepts ${ITEM_MEDIA_MAX} media per item and rejects one more`, () => {
      expect(
        parseContentPackageDraft(
          draft([item('a', '', mediaIds(ITEM_MEDIA_MAX))])
        )
      ).toBeDefined();
      expect(
        expectInvalid(draft([item('a', '', mediaIds(ITEM_MEDIA_MAX + 1))]))
      ).toEqual([
        { path: ['copy', 'global', 'thread', 0, 'mediaIds'], code: 'too_big' },
      ]);
    });

    it(`accepts ${PACKAGE_UNIQUE_MEDIA_MAX} distinct media and rejects one more`, () => {
      const fifty = draft([
        item('a', '', mediaIds(20, 'a')),
        item('b', '', mediaIds(20, 'b')),
        item('c', '', mediaIds(10, 'c')),
        // reused ids do not count again
        item('d', '', ['a0', 'b0', 'c0']),
      ]);
      expect(parseContentPackageDraft(fifty)).toBeDefined();

      const fiftyOne = draft([
        item('a', '', mediaIds(20, 'a')),
        item('b', '', mediaIds(20, 'b')),
        item('c', '', mediaIds(11, 'c')),
      ]);
      expect(expectInvalid(fiftyOne)).toEqual([
        { path: ['copy', 'global', 'thread'], code: 'custom' },
      ]);
    });
  });

  describe('structure', () => {
    it.each([
      ['no thread items', draft([])],
      ['missing schemaVersion', { copy: { global: { thread: [item('a')] } } }],
      ['schemaVersion 0', { ...draft([item('a')]), schemaVersion: 0 }],
      ['schemaVersion 2', { ...draft([item('a')]), schemaVersion: 2 }],
      ['schemaVersion "1"', { ...draft([item('a')]), schemaVersion: '1' }],
      ['missing copy', { schemaVersion: 1 }],
      ['missing global', { schemaVersion: 1, copy: {} }],
      ['missing thread', { schemaVersion: 1, copy: { global: {} } }],
      ['null draft', null],
      ['null copy', { schemaVersion: 1, copy: null }],
      ['null thread item', draft([null])],
      ['string draft', 'draft'],
      ['array draft', [draft([item('a')])]],
      ['text not a string', draft([{ id: 'a', text: 5, mediaIds: [] }])],
      ['missing text', draft([{ id: 'a', mediaIds: [] }])],
      ['missing mediaIds', draft([{ id: 'a', text: '' }])],
    ])('rejects %s', (_name, input) => {
      expect(expectInvalid(input).length).toBeGreaterThan(0);
    });
  });

  describe('unknown fields are rejected, never stripped', () => {
    it.each([
      [
        'top-level organizationId',
        { ...draft([item('a')]), organizationId: 'org' },
        [],
      ],
      [
        'copy.variants',
        {
          schemaVersion: 1,
          copy: { global: { thread: [item('a')] }, variants: {} },
        },
        ['copy'],
      ],
      [
        'global.html',
        {
          schemaVersion: 1,
          copy: { global: { thread: [item('a')], html: '<p>x</p>' } },
        },
        ['copy', 'global'],
      ],
      [
        'item path',
        draft([{ ...item('a'), path: '/uploads/a.png' }]),
        ['copy', 'global', 'thread', 0],
      ],
      [
        'item html',
        draft([{ ...item('a'), html: '<script></script>' }]),
        ['copy', 'global', 'thread', 0],
      ],
      [
        'item aiPrompt',
        draft([{ ...item('a'), aiPrompt: 'write' }]),
        ['copy', 'global', 'thread', 0],
      ],
    ])('rejects %s', (_name, input, path) => {
      expect(expectInvalid(input)).toEqual([
        { path, code: 'unrecognized_keys' },
      ]);
    });

    it('rejects a media object instead of an id', () => {
      expect(
        expectInvalid(
          draft([item('a', '', [{ id: UUID, path: 'https://cdn/x.png' }])])
        )
      ).toEqual([
        {
          path: ['copy', 'global', 'thread', 0, 'mediaIds', 0],
          code: 'invalid_type',
        },
      ]);
    });
  });

  describe('identifiers', () => {
    it.each([['a'], ['Z'], ['A'.repeat(32)], ['_-'], ['item-1_B']])(
      'accepts item id %p',
      (id) => {
        expect(parseContentPackageDraft(draft([item(id)]))).toBeDefined();
      }
    );

    it.each([
      [''],
      ['a'.repeat(33)],
      ['a/b'],
      ['a b'],
      ['a.b'],
      ['a:b'],
      ['ä'],
    ])('rejects item id %p', (id) => {
      expect(expectInvalid(draft([item(id)]))).toEqual([
        { path: ['copy', 'global', 'thread', 0, 'id'], code: 'invalid_string' },
      ]);
    });

    it.each([[UUID], ['a'], ['a'.repeat(64)], ['abc_DEF-123']])(
      'accepts media id %p',
      (id) => {
        expect(
          parseContentPackageDraft(draft([item('a', '', [id])]))
        ).toBeDefined();
      }
    );

    it.each([
      [''],
      ['a'.repeat(65)],
      [' a'],
      ['a b'],
      ['a/b'],
      ['a\\b'],
      ['a:b'],
      ['image.png'],
      ['../uploads'],
      ['https://cdn.example.com/a.png'],
      ['a?b=c'],
      ['a#b'],
    ])('rejects media id %p', (id) => {
      expect(expectInvalid(draft([item('a', '', [id])]))).toEqual([
        {
          path: ['copy', 'global', 'thread', 0, 'mediaIds', 0],
          code: 'invalid_string',
        },
      ]);
    });
  });

  describe('uniqueness', () => {
    it('rejects duplicate item ids', () => {
      expect(expectInvalid(draft([item('a'), item('b'), item('a')]))).toEqual([
        { path: ['copy', 'global', 'thread', 2, 'id'], code: 'custom' },
      ]);
    });

    it('rejects the same media twice in one item', () => {
      expect(expectInvalid(draft([item('a', '', [UUID, 'b', UUID])]))).toEqual([
        {
          path: ['copy', 'global', 'thread', 0, 'mediaIds', 2],
          code: 'custom',
        },
      ]);
    });

    it('allows the same media in separate items', () => {
      expect(
        parseContentPackageDraft(
          draft([item('a', '', [UUID]), item('b', '', [UUID])])
        ).copy.global.thread.map((entry) => entry.mediaIds)
      ).toEqual([[UUID], [UUID]]);
    });
  });

  describe('text', () => {
    const textOf = (text: string) =>
      parseContentPackageDraft(draft([item('a', text)])).copy.global.thread[0]
        .text;

    it.each([
      ['CRLF', 'a\r\nb', 'a\nb'],
      ['lone CR', 'a\rb', 'a\nb'],
      ['mixed endings', 'a\r\n\rb\n\r\n', 'a\n\nb\n\n'],
    ])('normalizes %s to \\n', (_name, input, expected) => {
      expect(textOf(input)).toBe(expected);
    });

    it.each([
      ['spaces', '  two  spaces  '],
      ['leading and trailing newlines', '\n\nbody\n\n'],
      ['tabs', 'a\tb'],
      ['emoji and ZWJ sequences', 'Launch 🎉 👩‍💻 👨‍👩‍👧'],
      ['combining marks, not NFC normalized', 'e\u0301 cafe\u0301'],
      ['right-to-left text', 'שלום עולם'],
      ['HTML-looking text', '<script>alert(1)</script> &lt; &amp; <p>'],
      ['no-break space', 'a\u00a0b'],
    ])('preserves %s exactly', (_name, text) => {
      expect(textOf(text)).toBe(text);
    });

    it('rejects a NUL character', () => {
      expect(expectInvalid(draft([item('a', 'a\u0000b')]))).toEqual([
        { path: ['copy', 'global', 'thread', 0, 'text'], code: 'custom' },
      ]);
    });

    it('accepts a valid surrogate pair', () => {
      expect(textOf('😀')).toBe('😀');
    });

    it.each([
      ['lone high surrogate', 'a\uD83Db'],
      ['high surrogate at the end', 'a\uD83D'],
      ['lone low surrogate', 'a\uDE00b'],
      ['reversed pair', '\uDE00\uD83D'],
    ])('rejects a %s', (_name, text) => {
      expect(expectInvalid(draft([item('a', text)]))).toEqual([
        { path: ['copy', 'global', 'thread', 0, 'text'], code: 'custom' },
      ]);
    });
  });

  describe('size', () => {
    it(`accepts exactly ${DRAFT_CANONICAL_MAX_BYTES} bytes and rejects one more`, () => {
      expect(
        parseContentPackageDraft(draftOfBytes(DRAFT_CANONICAL_MAX_BYTES))
      ).toBeDefined();
      expect(
        parseFailure(draftOfBytes(DRAFT_CANONICAL_MAX_BYTES + 1)).code
      ).toBe('DRAFT_TOO_LARGE');
    });

    it('counts UTF-8 bytes, not characters', () => {
      // 30,000 characters, but 90,000 bytes
      const euros = draft([
        item('a', '€'.repeat(ITEM_TEXT_MAX)),
        item('b', '€'.repeat(ITEM_TEXT_MAX)),
        item('c', '€'.repeat(ITEM_TEXT_MAX)),
      ]);
      expect(parseFailure(euros).code).toBe('DRAFT_TOO_LARGE');
      expect(
        parseContentPackageDraft(
          draft([
            item('a', 'x'.repeat(ITEM_TEXT_MAX)),
            item('b', 'x'.repeat(ITEM_TEXT_MAX)),
            item('c', 'x'.repeat(ITEM_TEXT_MAX)),
          ])
        )
      ).toBeDefined();
    });

    it('is not affected by key order or formatting of the input', () => {
      const atLimit = draftOfBytes(DRAFT_CANONICAL_MAX_BYTES);
      const overLimit = draftOfBytes(DRAFT_CANONICAL_MAX_BYTES + 1);

      expect(parseContentPackageDraft(reversedKeys(atLimit))).toEqual(
        parseContentPackageDraft(atLimit)
      );
      expect(
        parseContentPackageDraft(JSON.parse(JSON.stringify(atLimit, null, 8)))
      ).toBeDefined();
      expect(parseFailure(reversedKeys(overLimit)).code).toBe(
        'DRAFT_TOO_LARGE'
      );
      expect(
        parseFailure(JSON.parse(JSON.stringify(overLimit, null, 8))).code
      ).toBe('DRAFT_TOO_LARGE');
    });
  });

  describe('emptyContentPackageDraft', () => {
    it('returns a valid draft with one empty item using the given id', () => {
      const empty = emptyContentPackageDraft('item-1');
      expect(empty).toEqual({
        schemaVersion: 1,
        copy: {
          global: { thread: [{ id: 'item-1', text: '', mediaIds: [] }] },
        },
      });
      expect(parseContentPackageDraft(empty)).toEqual(empty);
    });

    it('returns a new object every time', () => {
      const first = emptyContentPackageDraft('item-1');
      first.copy.global.thread[0].text = 'changed';
      first.copy.global.thread[0].mediaIds.push(UUID);

      expect(emptyContentPackageDraft('item-1').copy.global.thread[0]).toEqual({
        id: 'item-1',
        text: '',
        mediaIds: [],
      });
    });

    it.each([[''], ['bad id'], ['a/b']])('rejects item id %p', (id) => {
      expect(failure(() => emptyContentPackageDraft(id)).code).toBe(
        'INVALID_DRAFT'
      );
    });
  });

  describe('assertContentPackagePublishable', () => {
    const publishable = (thread: ReturnType<typeof item>[]) =>
      parseContentPackageDraft(draft(thread)) as ContentPackageDraftV1;

    it.each([
      ['empty text and no media', ''],
      ['whitespace and newlines only', '   \n\t \n  '],
    ])('rejects an item with %s', (_name, text) => {
      const error = failure(() =>
        assertContentPackagePublishable(
          publishable([item('a', 'first'), item('b', text)])
        )
      );
      expect(error.code).toBe('EMPTY_ITEM');
      expect(error.itemIndex).toBe(1);
    });

    it.each([
      ['text only', [item('a', 'Hello')]],
      ['media only', [item('a', '', [UUID])]],
      [
        `${THREAD_ITEMS_MAX} filled items`,
        Array.from({ length: THREAD_ITEMS_MAX }, (_, index) =>
          item(
            `i${index}`,
            index % 2 ? `post ${index}` : '',
            index % 2 ? [] : [UUID]
          )
        ),
      ],
    ])('accepts %s', (_name, thread) => {
      expect(() =>
        assertContentPackagePublishable(publishable(thread))
      ).not.toThrow();
    });
  });

  describe('errors never carry user text', () => {
    const exposed = (error: ContentPackageDraftError) =>
      `${error.message} ${JSON.stringify(error)}`;

    it('for an empty item', () => {
      const error = failure(() =>
        assertContentPackagePublishable(
          parseContentPackageDraft(
            draft([item('a', 'Secret launch plan'), item('b', ' ')])
          )
        )
      );
      expect(exposed(error)).not.toContain('Secret');
      expect(error.message).toBe('Every thread item needs text or media');
    });

    it('for an invalid draft, although zod would quote the value', () => {
      const error = parseFailure({
        ...draft([item('a', 'Secret '.repeat(2000))]),
        schemaVersion: 'Secret version',
        organizationId: 'Secret org',
      });
      expect(exposed(error)).not.toContain('Secret');
      expect(error.issues).toEqual(
        expect.arrayContaining([
          { path: ['schemaVersion'], code: 'invalid_literal' },
          { path: [], code: 'unrecognized_keys' },
          { path: ['copy', 'global', 'thread', 0, 'text'], code: 'too_big' },
        ])
      );
    });

    it('for a draft that is too large', () => {
      const error = parseFailure(
        draft([
          item('a', 'Secret'.repeat(1600)),
          item('b', 'Secret'.repeat(1600)),
          item('c', 'Secret'.repeat(1600)),
          item('d', 'Secret'.repeat(1600)),
          item('e', 'Secret'.repeat(1600)),
          item('f', 'Secret'.repeat(1600)),
          item('g', 'Secret'.repeat(1600)),
        ])
      );
      expect(error.code).toBe('DRAFT_TOO_LARGE');
      expect(exposed(error)).not.toContain('Secret');
    });
  });
});
