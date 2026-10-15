import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioSourceContentError,
  parseContentStudioSourceContent,
  SOURCE_BLOCK_TYPES,
  SOURCE_BLOCKS_MAX,
  SOURCE_CONTENT_MAX_BYTES,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import {
  ContentStudioSourceIntegrityError,
  parseVerifiedContentStudioSourceVersion,
  storedContentStudioSourceContent,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

const MARKER = 'SOURCE_CONTENT_SECRET_MARKER_123';

type Block = { id: string; type: string; text: string; level: number | null };
const block = (overrides: Partial<Block> = {}): Block => ({
  id: 'b1',
  type: 'paragraph',
  text: 'A paragraph.',
  level: null,
  ...overrides,
});
const doc = (blocks: unknown[] = [block()]) => ({ schemaVersion: 1, blocks });
const full = () =>
  doc([
    block({ id: 'h1', type: 'heading', text: 'Title', level: 1 }),
    block({ id: 'p1', type: 'paragraph', text: 'Intro.', level: null }),
    block({ id: 'l1', type: 'list_item', text: 'First', level: 0 }),
    block({ id: 'l2', type: 'list_item', text: 'Nested', level: 1 }),
    block({ id: 'q1', type: 'quote', text: '“Quoted.”', level: null }),
  ]);

const parse = parseContentStudioSourceContent;
const refused = (input: unknown, code: 'INVALID' | 'TOO_LARGE' = 'INVALID') => {
  let error: unknown;
  try {
    parse(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioSourceContentError);
  expect((error as ContentStudioSourceContentError).code).toBe(code);
  // fixed message; issues carry a path and a kind only, never the value
  const text = JSON.stringify({
    message: (error as Error).message,
    issues: (error as ContentStudioSourceContentError).issues,
  });
  expect(text).not.toContain(MARKER);
  return error as ContentStudioSourceContentError;
};

describe('Source Content v1 parser', () => {
  it('SC1 accepts no blocks: a capture can have no extractable text', () => {
    expect(parse({ schemaVersion: 1, blocks: [] })).toEqual({
      schemaVersion: 1,
      blocks: [],
    });
  });

  it('SC2 accepts a full document and keeps the block order', () => {
    expect(parse(full())).toEqual(full());
  });

  it('SC3 needs schemaVersion exactly 1', () => {
    for (const schemaVersion of [0, 2, '1', null, undefined, 1.5]) {
      refused({ schemaVersion, blocks: [] });
    }
    refused({ blocks: [] });
  });

  it('SC4 refuses an unknown top-level field', () => {
    refused({ ...doc(), metadata: { a: 1 } });
    refused({ ...doc(), verified: true });
    refused({ ...doc(), links: [] });
  });

  it('SC5/SC35 refuses any block field besides id, type, text and level', () => {
    for (const extra of [
      'html',
      'rawHtml',
      'url',
      'href',
      'attributes',
      'style',
      'class',
      'markdown',
      'verified',
    ]) {
      const error = refused(doc([{ ...block(), [extra]: MARKER }]));
      expect(error.issues).toEqual([
        { path: ['blocks', 0], code: 'unrecognized_keys' },
      ]);
    }
  });

  it('SC6 allows 1-64 letters, digits, - and _ as block id', () => {
    for (const id of ['a', 'A-1_b', 'x'.repeat(64), '0']) {
      expect(parse(doc([block({ id })])).blocks[0].id).toBe(id);
    }
    for (const id of [
      '',
      'x'.repeat(65),
      'a b',
      'a.b',
      'a/b',
      'é',
      ' a',
      'a\u0000',
    ]) {
      refused(doc([block({ id })]));
    }
    refused(doc([{ ...block(), id: 1 }]));
    refused(doc([{ type: 'paragraph', text: 'x', level: null }]));
  });

  it('SC7 refuses the same block id twice', () => {
    const error = refused(
      doc([block({ id: 'a' }), block({ id: 'b' }), block({ id: 'a' })])
    );
    expect(error.issues).toEqual([
      { path: ['blocks', 2, 'id'], code: 'custom' },
    ]);
  });

  it('SC8/SC9 knows exactly heading, paragraph, list_item and quote', () => {
    expect(SOURCE_BLOCK_TYPES).toEqual([
      'heading',
      'paragraph',
      'list_item',
      'quote',
    ]);
    for (const type of [
      'image',
      'link',
      'html',
      'code',
      'table',
      'Paragraph',
      'list-item',
      'constructor',
      'toString',
      '__proto__',
      '',
    ]) {
      refused(doc([block({ type })]));
    }
    refused(doc([{ id: 'a', text: 'x', level: null }]));
  });

  it('SC10/SC11 needs a heading level 1-6', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(parse(doc([block({ type: 'heading', level })])).blocks[0]).toEqual(
        block({ type: 'heading', level })
      );
    }
    for (const level of [0, 7, -1, 1.5, null]) {
      refused(doc([block({ type: 'heading', level })]));
    }
    refused(doc([{ id: 'a', type: 'heading', text: 'x', level: '1' }]));
    refused(doc([{ id: 'a', type: 'heading', text: 'x' }]));
  });

  it('SC12/SC13 needs an explicit null level for paragraphs and quotes', () => {
    for (const type of ['paragraph', 'quote']) {
      expect(parse(doc([block({ type, level: null })])).blocks[0].level).toBe(
        null
      );
      for (const level of [0, 1]) {
        refused(doc([block({ type, level })]));
      }
      // left out is not null
      refused(doc([{ id: 'a', type, text: 'x' }]));
    }
  });

  it('SC14 takes a list item depth 0-8', () => {
    for (const level of [0, 4, 8]) {
      expect(
        parse(doc([block({ type: 'list_item', level })])).blocks[0].level
      ).toBe(level);
    }
    for (const level of [-1, 9, 0.5, null]) {
      refused(doc([block({ type: 'list_item', level })]));
    }
  });

  it('SC15/SC20 normalizes line endings, trims, and refuses empty text', () => {
    expect(
      parse(doc([block({ text: '  Line one\r\nLine two\rLine three \n' })]))
        .blocks[0].text
    ).toBe('Line one\nLine two\nLine three');
    for (const text of ['', ' ', '\r\n\t ', '\n\n']) {
      refused(doc([block({ text })]));
    }
    refused(doc([{ ...block(), text: null }]));
    refused(doc([{ ...block(), text: 42 }]));
  });

  it.each([
    ['SC16 heading', 'heading', 1, 1000],
    ['SC17 paragraph', 'paragraph', null, 10_000],
    ['SC18 list_item', 'list_item', 0, 5000],
    ['SC19 quote', 'quote', null, 10_000],
  ] as const)('%s text has at most its maximum', (_name, type, level, max) => {
    expect(
      parse(doc([block({ type, level, text: 'x'.repeat(max) })])).blocks[0].text
    ).toHaveLength(max);
    refused(doc([block({ type, level, text: 'x'.repeat(max + 1) })]));
    // trimmed before it is counted
    expect(
      parse(doc([block({ type, level, text: ` ${'x'.repeat(max)} ` })]))
        .blocks[0].text
    ).toHaveLength(max);
  });

  it('SC21-SC24 refuses NUL and unpaired surrogates, accepts a pair', () => {
    refused(doc([block({ text: `a\u0000b ${MARKER}` })]));
    refused(doc([block({ text: `a\uD800b ${MARKER}` })]));
    refused(doc([block({ text: `a\uDC00b ${MARKER}` })]));
    refused(doc([block({ text: `end\uD83D` })]));
    expect(parse(doc([block({ text: 'smile 😀' })])).blocks[0].text).toBe(
      'smile 😀'
    );
  });

  it('SC25 refuses class instances and other non-plain data', () => {
    class Doc {
      schemaVersion = 1;
      blocks = [];
    }
    refused(new Doc());
    refused(doc([Object.assign(new (class Block {})(), block())]));
    refused({ schemaVersion: 1, blocks: [new Date()] });
    refused(new Map());
  });

  it('SC26 refuses the wrong shapes', () => {
    for (const input of [
      null,
      undefined,
      'text',
      42,
      [],
      { schemaVersion: 1 },
      { schemaVersion: 1, blocks: {} },
      { schemaVersion: 1, blocks: 'x' },
      { schemaVersion: 1, blocks: [null] },
      { schemaVersion: 1, blocks: [[]] },
      { schemaVersion: 1, blocks: ['text'] },
    ]) {
      refused(input);
    }
  });

  it('SC27/SC28 takes at most 2000 blocks; more is too large, before any block is parsed', () => {
    const blocks = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        block({ id: `b${i}`, text: 'x' })
      );
    expect(SOURCE_BLOCKS_MAX).toBe(2000);
    expect(parse(doc(blocks(2000))).blocks).toHaveLength(2000);
    refused(doc(blocks(2001)), 'TOO_LARGE');
    // invalid blocks past the limit are not even looked at
    refused(doc(Array.from({ length: 2001 }, () => 'junk')), 'TOO_LARGE');
  });

  it('SC29/SC30 allows exactly 1 MiB of canonical JSON and refuses one byte more', () => {
    expect(SOURCE_CONTENT_MAX_BYTES).toBe(1_048_576);
    // 104 paragraphs of 10000 ASCII characters, the last one sized so the
    // canonical JSON is exactly 1 MiB
    const build = (lastLength: number) =>
      doc(
        Array.from({ length: 105 }, (_, i) =>
          block({
            id: `p${String(i).padStart(3, '0')}`,
            text: 'x'.repeat(i === 104 ? lastLength : 10_000),
          })
        )
      );
    const overhead = Buffer.byteLength(canonicalJson(build(1))) - 1;
    const last = SOURCE_CONTENT_MAX_BYTES - overhead;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(10_000);
    const exact = build(last);
    expect(Buffer.byteLength(canonicalJson(exact))).toBe(1_048_576);
    expect(parse(exact).blocks).toHaveLength(105);
    refused(build(last + 1), 'TOO_LARGE');
  });

  it('SC31 counts UTF-8 bytes, not characters', () => {
    // 4-byte characters: within the 10000 UTF-16 unit limit per block, but
    // 2 units each, so 5000 per block; 54 such blocks are over 1 MiB
    const emoji = '😀'.repeat(5000);
    expect(emoji).toHaveLength(10_000);
    const blocks = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        block({ id: `e${i}`, text: emoji })
      );
    expect(parse(doc(blocks(52))).blocks).toHaveLength(52);
    // 54 * 20000 bytes = 1.08 MB, while 54 * 10000 characters is ~0.54 M
    expect(canonicalJson(doc(blocks(54))).length).toBeLessThan(
      SOURCE_CONTENT_MAX_BYTES
    );
    refused(doc(blocks(54)), 'TOO_LARGE');
  });

  it('SC32 never changes the caller object', () => {
    const input = doc([
      block({ text: '  Spaced\r\n ' }),
      block({ id: 'b2', type: 'heading', text: 'H', level: 2 }),
    ]);
    const copy = JSON.parse(JSON.stringify(input));
    const result = parse(input);
    expect(input).toEqual(copy);
    expect(result).not.toBe(input);
    expect(result.blocks[0]).not.toBe(input.blocks[0]);
    expect(result.blocks[0].text).toBe('Spaced');
  });

  it('SC33 gives the same output for the same input', () => {
    expect(canonicalJson(parse(full()))).toBe(canonicalJson(parse(full())));
    expect(parse(parse(full()))).toEqual(parse(full()));
  });

  it('SC34 keeps HTML-looking text as plain, inert characters', () => {
    const text = '<script>alert(1)</script><b onclick="x()">bold</b> &amp;';
    const result = parse(doc([block({ text })]));
    expect(result.blocks[0].text).toBe(text);
    expect(typeof result.blocks[0].text).toBe('string');
    expect(Object.keys(result.blocks[0]).sort()).toEqual([
      'id',
      'level',
      'text',
      'type',
    ]);
  });
});

describe('Source content integrity', () => {
  const stored = (input: unknown = full()) =>
    storedContentStudioSourceContent(parse(input));
  const failsIntegrity = (version: {
    schemaVersion: number;
    content: string;
    contentHash: string;
  }) => {
    let error: unknown;
    try {
      parseVerifiedContentStudioSourceVersion(version);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContentStudioSourceIntegrityError);
    expect((error as Error).message).toBe(
      'A stored source version failed its integrity check'
    );
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(String(error)).not.toContain(MARKER);
    expect((error as Error).stack).not.toContain(MARKER);
  };

  it('SH1 hashes the same content the same, whatever the key order', () => {
    const reordered = {
      blocks: (full().blocks as Block[]).map(({ level, text, type, id }) => ({
        level,
        text,
        type,
        id,
      })),
      schemaVersion: 1,
    };
    expect(stored(reordered)).toEqual(stored());
  });

  it('SH2 hashes line-ending variants the same', () => {
    expect(stored(doc([block({ text: 'a\r\nb' })]))).toEqual(
      stored(doc([block({ text: 'a\nb' })]))
    );
    expect(stored(doc([block({ text: ' a\rb ' })]))).toEqual(
      stored(doc([block({ text: 'a\nb' })]))
    );
  });

  it('SH3/SH4 changes the hash when the text or the block order changes', () => {
    const base = stored();
    expect(stored(doc([block({ text: 'A paragraph!' })])).contentHash).not.toBe(
      stored(doc([block()])).contentHash
    );
    const reversed = doc([...full().blocks].reverse());
    expect(stored(reversed).contentHash).not.toBe(base.contentHash);
  });

  it('SH5 stores canonical JSON with a lowercase 64-hex SHA-256 of exactly it', () => {
    const result = stored();
    expect(result.schemaVersion).toBe(1);
    expect(result.content).toBe(canonicalJson(parse(full())));
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.contentHash).toBe(sha256Hex(result.content));
  });

  it('SH6 reads back a stored version unchanged', () => {
    expect(parseVerifiedContentStudioSourceVersion(stored())).toEqual(full());
    expect(
      parseVerifiedContentStudioSourceVersion(
        stored({ schemaVersion: 1, blocks: [] })
      )
    ).toEqual({ schemaVersion: 1, blocks: [] });
  });

  it('SH7 fails on JSON that does not parse', () => {
    const text = `{"blocks":[${MARKER}`;
    failsIntegrity({
      schemaVersion: 1,
      content: text,
      contentHash: sha256Hex(text),
    });
  });

  it('SH8 fails when the row schema version differs', () => {
    failsIntegrity({ ...stored(), schemaVersion: 2 });
  });

  it('SH9 fails when the embedded schema version differs', () => {
    const text = canonicalJson({ ...full(), schemaVersion: 2 });
    failsIntegrity({
      schemaVersion: 1,
      content: text,
      contentHash: sha256Hex(text),
    });
  });

  it('SH10 fails when the hash does not match', () => {
    failsIntegrity({ ...stored(), contentHash: 'f'.repeat(64) });
    failsIntegrity({
      ...stored(),
      contentHash: stored().contentHash.toUpperCase(),
    });
  });

  it('SH11 fails on valid but non-canonical JSON, even with its own hash', () => {
    for (const text of [
      JSON.stringify(full(), null, 2),
      JSON.stringify(full()),
      canonicalJson(doc([block({ text: ' padded ' })])),
      canonicalJson(doc([block({ text: 'a\r\nb' })])),
    ]) {
      expect(text).not.toBe(stored().content);
      failsIntegrity({
        schemaVersion: 1,
        content: text,
        contentHash: sha256Hex(text),
      });
    }
  });

  it('SH12 fails on an unknown stored field', () => {
    const withHtml = canonicalJson(
      doc([{ ...block(), html: `<p>${MARKER}</p>` }])
    );
    failsIntegrity({
      schemaVersion: 1,
      content: withHtml,
      contentHash: sha256Hex(withHtml),
    });
  });

  it('SH13 never puts the corrupted content in the error', () => {
    const text = canonicalJson(doc([block({ text: `${MARKER}\u0000` })]));
    failsIntegrity({
      schemaVersion: 1,
      content: text,
      contentHash: sha256Hex(text),
    });
    failsIntegrity({
      ...stored(doc([block({ text: MARKER })])),
      contentHash: '0'.repeat(64),
    });
  });
});
