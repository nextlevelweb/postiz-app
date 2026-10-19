import {
  assertContentPackagePublishable,
  CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION,
  CONTENT_PACKAGE_SCHEMA_VERSION,
  ContentPackageClaimV2,
  ContentPackageDraft,
  ContentPackageDraftError,
  ContentPackageDraftV1,
  ContentPackageDraftV2,
  contentPackageClaims,
  replaceContentPackageItemClaims,
  staleContentPackageClaimIds,
  upgradeContentPackageDraftToV2,
  withContentPackageClaim,
  withoutContentPackageClaim,
  withoutContentPackageItemClaims,
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

// P3-11: schema v2, grounding. v1 is unchanged; v2 adds claims, each tied to
// one item and to exact blocks of exact source versions
const SOURCE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const VERSION = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_VERSION = '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const HASH = 'a'.repeat(64);
const evidence = (overrides: Record<string, unknown> = {}) => ({
  sourceId: SOURCE,
  versionId: VERSION,
  versionNumber: 3,
  contentHash: HASH,
  blockId: 'b1',
  quote: 'exact words',
  ...overrides,
});
const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'c_claim0001',
  threadItemId: 'a',
  text: 'Sales grew in spring.',
  evidence: [evidence()],
  ...overrides,
});
const v2 = (claims: unknown[] = [claim()], thread = [item('a', 'Hello')]) => ({
  schemaVersion: 2,
  copy: { global: { thread } },
  grounding: { claims },
});
const versionEvidence = (index: number) =>
  evidence({
    versionId: `${String(index).padStart(8, '0')}-4e5f-4a6b-8c7d-9e0f1a2b3c4d`,
  });

describe('ContentPackageDraft v2 (P3-11)', () => {
  it('VS1 a v2 draft without claims is valid and stays v2', () => {
    expect(parseContentPackageDraft(v2([]))).toEqual(v2([]));
  });

  it('VS2/VS3 keeps claims and their evidence exactly, in the order given', () => {
    const input = v2(
      [
        claim(),
        claim({
          id: 'c_claim0002',
          threadItemId: 'b',
          text: 'Second.',
          evidence: [
            evidence({ blockId: 'b9', quote: null }),
            evidence({ blockId: 'b2' }),
          ],
        }),
      ],
      [item('a', 'Hello'), item('b', 'World')]
    );
    expect(parseContentPackageDraft(input)).toEqual(input);
  });

  it('VS4 the claim id is the given id, never a position', () => {
    const parsed = parseContentPackageDraft(
      v2([claim({ id: 'c_second00' }), claim({ id: 'c_first000' })])
    ) as ContentPackageDraftV2;
    expect(parsed.grounding.claims.map((entry) => entry.id)).toEqual([
      'c_second00',
      'c_first000',
    ]);
    for (const id of ['0', '1', 'claim1', 'c_', 'c_short', 'c_has space!']) {
      expect(parseFailure(v2([claim({ id })])).code).toBe('INVALID_DRAFT');
    }
  });

  it('trims a claim text and normalizes its line endings; a quote is kept as written', () => {
    const parsed = parseContentPackageDraft(
      v2([
        claim({
          text: '  Line one\r\nLine two  ',
          evidence: [evidence({ quote: ' spaced\r\nquote ' })],
        }),
      ])
    ) as ContentPackageDraftV2;
    expect(parsed.grounding.claims[0].text).toBe('Line one\nLine two');
    expect(parsed.grounding.claims[0].evidence[0].quote).toBe(
      ' spaced\nquote '
    );
  });

  it.each([
    ['VS5 an unknown key on the draft', { ...v2(), extra: 1 }],
    [
      'VS5 an unknown key on grounding',
      { ...v2(), grounding: { claims: [], x: 1 } },
    ],
    ['VS5 an unknown key on a claim', v2([{ ...claim(), score: 1 }])],
    [
      'VS5 an unknown key on evidence',
      v2([claim({ evidence: [{ ...evidence(), title: 'x' }] })]),
    ],
    [
      'VS5 grounding left out',
      { ...draft([item('a', 'Hi')]), schemaVersion: 2 },
    ],
    [
      'grounding on a v1 draft',
      { ...draft([item('a', 'Hi')]), grounding: { claims: [] } },
    ],
    ['VS6 a repeated claim id', v2([claim(), claim()])],
    ['VS7 an empty claim text', v2([claim({ text: '' })])],
    ['VS7 a blank claim text', v2([claim({ text: ' \n\t ' })])],
    [
      'VS8 a claim text over 2000 characters',
      v2([claim({ text: 'x'.repeat(2001) })]),
    ],
    ['a NUL in a claim', v2([claim({ text: 'a\u0000b' })])],
    ['a lone surrogate in a claim', v2([claim({ text: 'a\uD800b' })])],
    [
      'VS9 more than 200 claims',
      v2(
        Array.from({ length: 201 }, (_, i) =>
          claim({
            id: `c_claim${String(i).padStart(4, '0')}`,
            text: 'x',
            evidence: [evidence({ quote: null })],
          })
        )
      ),
    ],
    ['a claim without evidence', v2([claim({ evidence: [] })])],
    [
      'VS10 more than 20 pieces of evidence',
      v2([
        claim({
          evidence: Array.from({ length: 21 }, (_, i) =>
            evidence({ blockId: `b${i}` })
          ),
        }),
      ]),
    ],
    [
      'the same block twice in one claim',
      v2([claim({ evidence: [evidence(), evidence({ quote: null })] })]),
    ],
    [
      'VS11 a source id that is not a uuid',
      v2([claim({ evidence: [evidence({ sourceId: 'source-1' })] })]),
    ],
    [
      'VS11 a version id that is not a uuid',
      v2([claim({ evidence: [evidence({ versionId: 'latest' })] })]),
    ],
    [
      'VS11 version number 0',
      v2([claim({ evidence: [evidence({ versionNumber: 0 })] })]),
    ],
    [
      'VS11 a fractional version number',
      v2([claim({ evidence: [evidence({ versionNumber: 1.5 })] })]),
    ],
    [
      'VS11 a short hash',
      v2([claim({ evidence: [evidence({ contentHash: 'abc' })] })]),
    ],
    [
      'VS11 an upper-case hash',
      v2([claim({ evidence: [evidence({ contentHash: 'A'.repeat(64) })] })]),
    ],
    [
      'VS11 a block id with a slash',
      v2([claim({ evidence: [evidence({ blockId: 'b/1' })] })]),
    ],
    [
      'VS11 the quote left out',
      v2([claim({ evidence: [{ ...evidence(), quote: undefined }] })]),
    ],
    ['a blank quote', v2([claim({ evidence: [evidence({ quote: '  ' })] })])],
    [
      'a quote over 1000 characters',
      v2([claim({ evidence: [evidence({ quote: 'q'.repeat(1001) })] })]),
    ],
    [
      'VS12 a URL as evidence',
      v2([claim({ evidence: [{ url: 'https://example.com/a' }] })]),
    ],
    [
      'VS12 a URL in place of the source',
      v2([
        claim({ evidence: [evidence({ sourceId: 'https://example.com/a' })] }),
      ]),
    ],
    [
      'VS12 an organization id on evidence',
      v2([claim({ evidence: [{ ...evidence(), organizationId: UUID }] })]),
    ],
    [
      'VS13 a claim of an item that does not exist',
      v2([claim({ threadItemId: 'missing' })]),
    ],
    [
      'VS13 a claim without an item',
      v2([{ ...claim(), threadItemId: undefined }]),
    ],
    [
      'one version named with two numbers',
      v2([
        claim({
          evidence: [evidence(), evidence({ blockId: 'b2', versionNumber: 4 })],
        }),
      ]),
    ],
    [
      'one version named with two hashes',
      v2([
        claim(),
        claim({
          id: 'c_claim0002',
          evidence: [evidence({ contentHash: 'b'.repeat(64) })],
        }),
      ]),
    ],
    [
      'one version named under two sources',
      v2([
        claim(),
        claim({
          id: 'c_claim0002',
          evidence: [evidence({ sourceId: OTHER_VERSION })],
        }),
      ]),
    ],
    [
      'more than 20 distinct source versions',
      v2(
        Array.from({ length: 21 }, (_, i) =>
          claim({
            id: `c_claim${String(i).padStart(4, '0')}`,
            evidence: [versionEvidence(i)],
          })
        )
      ),
    ],
    ['schema version 3', { ...v2(), schemaVersion: 3 }],
  ])('refuses %s', (_label, input) => {
    expect(parseFailure(input).code).toBe('INVALID_DRAFT');
  });

  it('accepts exactly the limits: 200 claims, 20 pieces of evidence, 2000 and 1000 characters, 20 versions', () => {
    expect(() =>
      parseContentPackageDraft(
        v2(
          Array.from({ length: 200 }, (_, i) =>
            claim({
              id: `c_claim${String(i).padStart(4, '0')}`,
              text: 'x',
              evidence: [evidence({ quote: null })],
            })
          )
        )
      )
    ).not.toThrow();
    expect(() =>
      parseContentPackageDraft(
        v2([
          claim({
            text: 'x'.repeat(2000),
            evidence: Array.from({ length: 20 }, (_, i) =>
              evidence({ blockId: `b${i}`, quote: i ? null : 'q'.repeat(1000) })
            ),
          }),
        ])
      )
    ).not.toThrow();
    expect(() =>
      parseContentPackageDraft(
        v2(
          Array.from({ length: 20 }, (_, i) =>
            claim({
              id: `c_claim${String(i).padStart(4, '0')}`,
              evidence: [versionEvidence(i)],
            })
          )
        )
      )
    ).not.toThrow();
  });

  it('grounding counts toward the draft size limit', () => {
    const big = v2(
      Array.from({ length: 40 }, (_, i) =>
        claim({
          id: `c_claim${String(i).padStart(4, '0')}`,
          text: 'y'.repeat(2000),
        })
      )
    );
    expect(parseFailure(big).code).toBe('DRAFT_TOO_LARGE');
  });

  it('keeps the thread rules for v2: ids, media and publishability', () => {
    expect(parseFailure(v2([], [item('a', 'x'), item('a', 'y')])).code).toBe(
      'INVALID_DRAFT'
    );
    const parsed = parseContentPackageDraft(v2([], [item('a')]));
    expect(failure(() => assertContentPackagePublishable(parsed)).code).toBe(
      'EMPTY_ITEM'
    );
  });
});

describe('v1 compatibility and the one upgrade (P3-11)', () => {
  const V1 = draft([item('a', 'Hello', ['m1']), item('b', 'World')]);

  it('V2-1/V2-3 a v1 draft parses as v1, exactly, and is not changed', () => {
    const input = JSON.parse(JSON.stringify(V1));
    const parsed = parseContentPackageDraft(input);
    expect(parsed).toEqual(V1);
    expect(parsed.schemaVersion).toBe(1);
    expect('grounding' in parsed).toBe(false);
    expect(input).toEqual(V1);
    expect(contentPackageClaims(parsed)).toEqual([]);
  });

  it('a new package still starts as v1', () => {
    expect(emptyContentPackageDraft('main').schemaVersion).toBe(1);
    expect(CONTENT_PACKAGE_SCHEMA_VERSION).toBe(1);
    expect(CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION).toBe(2);
  });

  it('V2-2 upgrading v1 keeps the copy exactly and adds no claims', () => {
    const parsed = parseContentPackageDraft(V1) as ContentPackageDraftV1;
    const upgraded = upgradeContentPackageDraftToV2(parsed);
    expect(upgraded).toEqual({
      schemaVersion: 2,
      copy: V1.copy,
      grounding: { claims: [] },
    });
    expect(parseContentPackageDraft(upgraded)).toEqual(upgraded);
    // a copy: nothing is shared with the v1 draft
    upgraded.copy.global.thread[0].mediaIds.push('m9');
    expect(parsed.copy.global.thread[0].mediaIds).toEqual(['m1']);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('upgrading v2 is a deep copy that parses to the same draft', () => {
    const parsed = parseContentPackageDraft(
      v2([claim()])
    ) as ContentPackageDraftV2;
    const upgraded = upgradeContentPackageDraftToV2(parsed);
    expect(upgraded).toEqual(parsed);
    upgraded.grounding.claims[0].evidence[0].blockId = 'b9';
    expect(parsed.grounding.claims[0].evidence[0].blockId).toBe('b1');
  });
});

describe('claim scope helpers (P3-11)', () => {
  const draftV2 = parseContentPackageDraft(
    v2(
      [
        claim({ id: 'c_claimA001', threadItemId: 'a' }),
        claim({ id: 'c_claimB001', threadItemId: 'b' }),
        claim({ id: 'c_claimA002', threadItemId: 'a' }),
      ],
      [item('a', 'Hello'), item('b', 'World')]
    )
  ) as ContentPackageDraftV2;
  const ids = (value: ContentPackageDraft) =>
    contentPackageClaims(value).map((entry) => entry.id);

  it('AP6/AP7 removes the claims of the given items only', () => {
    expect(ids(withoutContentPackageItemClaims(draftV2, ['a']))).toEqual([
      'c_claimB001',
    ]);
    expect(withoutContentPackageItemClaims(draftV2, ['zzz'])).toBe(draftV2);
    const v1 = parseContentPackageDraft(draft([item('a', 'x')]));
    expect(withoutContentPackageItemClaims(v1, ['a'])).toBe(v1);
  });

  it('AP3/AP4 replaces the claims of the affected items and keeps the others', () => {
    const fresh = claim({ id: 'c_claimNEW1', threadItemId: 'a' });
    const next = replaceContentPackageItemClaims(draftV2, ['a'], [
      fresh,
    ] as ContentPackageClaimV2[]);
    expect(ids(next)).toEqual(['c_claimB001', 'c_claimNEW1']);
    expect(parseContentPackageDraft(next)).toEqual(next);
  });

  it('AP7 replacing with no claims leaves none of the affected items behind', () => {
    expect(
      ids(replaceContentPackageItemClaims(draftV2, ['a', 'b'], []))
    ).toEqual([]);
  });

  it('a v1 draft stays v1 without new claims and becomes v2 with them', () => {
    const v1 = parseContentPackageDraft(draft([item('a', 'x')]));
    expect(replaceContentPackageItemClaims(v1, ['a'], [])).toBe(v1);
    const grounded = replaceContentPackageItemClaims(v1, ['a'], [
      claim(),
    ] as ContentPackageClaimV2[]);
    expect(grounded.schemaVersion).toBe(2);
    expect(grounded.copy).toEqual(v1.copy);
  });

  it('AP5 a claim kept for changed text is stale; a new claim for it is not', () => {
    const edited = {
      ...draftV2,
      copy: {
        global: {
          thread: [item('a', 'Hello, edited'), item('b', 'World')],
        },
      },
    } as ContentPackageDraftV2;
    expect(staleContentPackageClaimIds(draftV2, edited)).toEqual([
      'c_claimA001',
      'c_claimA002',
    ]);
    const regrounded = replaceContentPackageItemClaims(edited, ['a'], [
      claim({ id: 'c_claimNEW1' }),
    ] as ContentPackageClaimV2[]);
    expect(staleContentPackageClaimIds(draftV2, regrounded)).toEqual([]);
  });

  it('a claim may change its own text or evidence while its item text stays', () => {
    const next = {
      ...draftV2,
      grounding: {
        claims: draftV2.grounding.claims.map((entry) => ({
          ...entry,
          text: `${entry.text} (reworded)`,
          evidence: [{ ...entry.evidence[0], blockId: 'b7' }],
        })),
      },
    };
    expect(staleContentPackageClaimIds(draftV2, next)).toEqual([]);
  });

  it('a claim moved to another item is stale', () => {
    const moved = {
      ...draftV2,
      grounding: {
        claims: [{ ...draftV2.grounding.claims[0], threadItemId: 'b' }],
      },
    };
    expect(staleContentPackageClaimIds(draftV2, moved)).toEqual([
      'c_claimA001',
    ]);
  });

  it('nothing is stale against a v1 draft or after only removing claims', () => {
    const v1 = parseContentPackageDraft(draft([item('a', 'other')]));
    expect(staleContentPackageClaimIds(v1, draftV2)).toEqual([]);
    expect(
      staleContentPackageClaimIds(
        draftV2,
        withoutContentPackageItemClaims(draftV2, ['b'])
      )
    ).toEqual([]);
  });
});

describe('claims written by hand (P3-11)', () => {
  it('adds a claim after the others and makes a v1 draft v2 with the same copy', () => {
    const v1 = parseContentPackageDraft(draft([item('a', 'Hello')]));
    const next = withContentPackageClaim(v1, claim() as ContentPackageClaimV2);
    expect(next).toEqual(v2([claim()]));
    expect(v1.schemaVersion).toBe(1);
    expect(parseContentPackageDraft(next)).toEqual(next);
  });

  it('replaces a claim with its id in place, keeping the order', () => {
    const start = parseContentPackageDraft(
      v2([claim({ id: 'c_claimA001' }), claim({ id: 'c_claimB001' })])
    );
    const next = withContentPackageClaim(start, {
      ...claim({ id: 'c_claimA001' }),
      text: 'Edited.',
    } as ContentPackageClaimV2);
    expect(
      next.grounding.claims.map((entry) => [entry.id, entry.text])
    ).toEqual([
      ['c_claimA001', 'Edited.'],
      ['c_claimB001', 'Sales grew in spring.'],
    ]);
  });

  it('removes one claim by id; an unknown id or a v1 draft is returned as it is', () => {
    const start = parseContentPackageDraft(
      v2([claim({ id: 'c_claimA001' }), claim({ id: 'c_claimB001' })])
    );
    expect(
      contentPackageClaims(
        withoutContentPackageClaim(start, 'c_claimA001')
      ).map((entry) => entry.id)
    ).toEqual(['c_claimB001']);
    expect(withoutContentPackageClaim(start, 'c_nothere00')).toBe(start);
    const v1 = parseContentPackageDraft(draft([item('a', 'Hello')]));
    expect(withoutContentPackageClaim(v1, 'c_claimA001')).toBe(v1);
    // removing the last claim keeps the draft v2
    const last = withoutContentPackageClaim(
      parseContentPackageDraft(v2([claim()])),
      'c_claim0001'
    );
    expect(last).toEqual(v2([]));
  });
});
