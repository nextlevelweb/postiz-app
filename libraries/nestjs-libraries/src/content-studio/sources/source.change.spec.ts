import fs from 'fs';
import path from 'path';
import {
  classifyContentStudioSourceCaptureTransition,
  compareContentStudioSourceVersions,
  ContentStudioComparedSourceVersion,
  CONTENT_STUDIO_SOURCE_CHANGES,
  CONTENT_STUDIO_SOURCE_PAGE_CHANGES,
  diffContentStudioSourceBlocks,
  isContentStudioSourcePageChange,
  isSameContentStudioSourceCapture,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import {
  ContentStudioSourceBlock,
  SOURCE_BLOCKS_MAX,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

// What changed between two captures (P8-04A), on the pure module only: the
// same-capture rule, the block diff and the classification. The service,
// the repository lookups and PostgreSQL have their own specs

const V2 = 'content-studio-source-v2';
const V1 = 'content-studio-source-v1';

const p = (text: string): Omit<ContentStudioSourceBlock, 'id'> => ({
  type: 'paragraph',
  text,
  level: null,
});
// blocks numbered as the extractor numbers them
const blocks = (...items: Array<Omit<ContentStudioSourceBlock, 'id'>>) =>
  items.map((item, index) => ({ id: `b${index + 1}`, ...item }));
const texts = (...items: string[]) => blocks(...items.map(p));

const version = (
  content: ContentStudioSourceBlock[],
  overrides: Partial<ContentStudioComparedSourceVersion> = {}
): ContentStudioComparedSourceVersion => {
  const parsed = { schemaVersion: 1 as const, blocks: content };
  return {
    contentHash: storedContentStudioSourceContent(parsed).contentHash,
    title: 'A title',
    extractionVersion: V2,
    sourceHash: null,
    content: parsed,
    ...overrides,
  };
};

const identity = (overrides: Record<string, unknown> = {}) => ({
  contentHash: 'a'.repeat(64),
  title: 'A title' as string | null,
  extractionVersion: V2,
  ...overrides,
});

describe('the same-capture rule', () => {
  it('SC1 the same blocks hash, title and extraction are the same capture', () => {
    expect(isSameContentStudioSourceCapture(identity(), identity())).toBe(true);
  });

  it('SC2 another blocks hash is another capture', () => {
    expect(
      isSameContentStudioSourceCapture(
        identity(),
        identity({ contentHash: 'b'.repeat(64) })
      )
    ).toBe(false);
  });

  it('SC3 another title is another capture, a missing title included', () => {
    expect(
      isSameContentStudioSourceCapture(identity(), identity({ title: 'B' }))
    ).toBe(false);
    expect(
      isSameContentStudioSourceCapture(identity(), identity({ title: null }))
    ).toBe(false);
    expect(
      isSameContentStudioSourceCapture(identity({ title: null }), identity())
    ).toBe(false);
  });

  it('SC4 another extraction version is another capture', () => {
    expect(
      isSameContentStudioSourceCapture(
        identity(),
        identity({ extractionVersion: V1 })
      )
    ).toBe(false);
  });

  it('SC5 two captures without a title are the same capture', () => {
    expect(
      isSameContentStudioSourceCapture(
        identity({ title: null }),
        identity({ title: null })
      )
    ).toBe(true);
  });

  it('C8/CL6 reads only the blocks hash, title and extraction: provenance is never a difference', () => {
    expect(
      isSameContentStudioSourceCapture(
        {
          ...identity(),
          finalUrl: 'https://a.example/',
          sourceHash: 'c'.repeat(64),
          fetchedAt: new Date(1),
        } as never,
        {
          ...identity(),
          finalUrl: 'https://b.example/',
          sourceHash: 'd'.repeat(64),
          fetchedAt: new Date(2),
        } as never
      )
    ).toBe(true);
  });
});

// What a capture is to the capture just before it (P8-04B1): the one rule a
// version append and the page-change backfill follow
describe('the capture transition', () => {
  const classify = classifyContentStudioSourceCaptureTransition;

  it('T1 no capture before it is the first', () => {
    expect(classify(null, identity())).toBe('initial');
  });

  it('T2 the same blocks hash, title and extraction are a repeat', () => {
    expect(classify(identity(), identity())).toBe('repeat');
    expect(classify(identity({ title: null }), identity({ title: null }))).toBe(
      'repeat'
    );
  });

  it('T3 another extraction version wins over any other difference', () => {
    expect(classify(identity({ extractionVersion: V1 }), identity())).toBe(
      'extraction_changed'
    );
    expect(
      classify(
        identity({ extractionVersion: V1 }),
        identity({ contentHash: 'b'.repeat(64), title: 'Other' })
      )
    ).toBe('extraction_changed');
  });

  it('T4/T5 another blocks hash with the same extraction is a content change, with or without another title', () => {
    expect(
      classify(identity(), identity({ contentHash: 'b'.repeat(64) }))
    ).toBe('content_changed');
    expect(
      classify(
        identity(),
        identity({ contentHash: 'b'.repeat(64), title: 'Other' })
      )
    ).toBe('content_changed');
  });

  it('T6 only another title is a title change', () => {
    expect(classify(identity(), identity({ title: 'Other' }))).toBe(
      'title_changed'
    );
  });

  it('T7 a missing title is a value: compared with a title it is a title change, both ways', () => {
    expect(classify(identity({ title: null }), identity())).toBe(
      'title_changed'
    );
    expect(classify(identity(), identity({ title: null }))).toBe(
      'title_changed'
    );
    expect(classify(identity({ title: '' }), identity({ title: null }))).toBe(
      'title_changed'
    );
    expect(
      classify(
        identity({ title: null }),
        identity({ title: null, contentHash: 'b'.repeat(64) })
      )
    ).toBe('content_changed');
  });

  it('T8 only a content or a title change is a page change', () => {
    expect([...CONTENT_STUDIO_SOURCE_PAGE_CHANGES]).toEqual([
      'content_changed',
      'title_changed',
    ]);
    const results = [
      classify(null, identity()),
      classify(identity(), identity()),
      classify(identity({ extractionVersion: V1 }), identity()),
      classify(identity(), identity({ contentHash: 'b'.repeat(64) })),
      classify(identity(), identity({ title: 'Other' })),
    ];
    expect(results.map(isContentStudioSourcePageChange)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    // the check of a stored kind: exactly those two strings
    for (const value of [
      'no_earlier_change',
      'CONTENT_CHANGED',
      'content_changed ',
      'constructor',
      {},
      [],
      null,
    ]) {
      expect(isContentStudioSourcePageChange(value)).toBe(false);
    }
  });

  it('agrees with the comparison on every class: a first capture and a repeat are no earlier change', () => {
    const before = version(texts('One'));
    const cases: Array<
      [
        ContentStudioComparedSourceVersion | null,
        ContentStudioComparedSourceVersion
      ]
    > = [
      [null, before],
      [before, version(texts('One'))],
      [before, version(texts('One'), { extractionVersion: V1 })],
      [before, version(texts('Two'))],
      [before, version(texts('One'), { title: 'Other' })],
    ];
    expect(
      cases.map(([a, b]) => [
        classify(a, b),
        compareContentStudioSourceVersions(a, b).change,
      ])
    ).toEqual([
      ['initial', 'no_earlier_change'],
      ['repeat', 'no_earlier_change'],
      ['extraction_changed', 'extraction_changed'],
      ['content_changed', 'content_changed'],
      ['title_changed', 'title_changed'],
    ]);
  });
});

describe('the block diff', () => {
  it('C1 identical blocks are one unchanged run', () => {
    expect(
      diffContentStudioSourceBlocks(texts('A', 'B', 'C'), texts('A', 'B', 'C'))
    ).toEqual({
      blocks: [{ change: 'unchanged', count: 3 }],
      counts: {
        added: 0,
        removed: 0,
        unchanged: 3,
        beforeBlocks: 3,
        afterBlocks: 3,
      },
    });
  });

  it('C2 one added block, in its place', () => {
    expect(
      diffContentStudioSourceBlocks(texts('A', 'C'), texts('A', 'B', 'C'))
    ).toEqual({
      blocks: [
        { change: 'unchanged', count: 1 },
        { change: 'added', ...p('B') },
        { change: 'unchanged', count: 1 },
      ],
      counts: {
        added: 1,
        removed: 0,
        unchanged: 2,
        beforeBlocks: 2,
        afterBlocks: 3,
      },
    });
  });

  it('C3 one removed block, in its place', () => {
    expect(
      diffContentStudioSourceBlocks(texts('A', 'B', 'C'), texts('A', 'C'))
        .blocks
    ).toEqual([
      { change: 'unchanged', count: 1 },
      { change: 'removed', ...p('B') },
      { change: 'unchanged', count: 1 },
    ]);
  });

  it('C4 an edited block is the old one removed, then the new one added: there is no modified', () => {
    const diff = diffContentStudioSourceBlocks(
      texts('A', 'Old text.', 'C'),
      texts('A', 'New text.', 'C')
    );
    expect(diff.blocks).toEqual([
      { change: 'unchanged', count: 1 },
      { change: 'removed', ...p('Old text.') },
      { change: 'added', ...p('New text.') },
      { change: 'unchanged', count: 1 },
    ]);
    expect(diff.counts).toMatchObject({ added: 1, removed: 1, unchanged: 2 });
    expect(JSON.stringify(diff)).not.toMatch(/modif/);
  });

  it('C5 reordered blocks: deterministic, document order, the removed block first where both keep as many', () => {
    const diff = () =>
      diffContentStudioSourceBlocks(texts('A', 'B'), texts('B', 'A'));
    expect(diff().blocks).toEqual([
      { change: 'removed', ...p('A') },
      { change: 'unchanged', count: 1 },
      { change: 'added', ...p('A') },
    ]);
    expect(diff()).toEqual(diff());
    // a tie between dropping and adding: removed first
    expect(
      diffContentStudioSourceBlocks(texts('X'), texts('Y')).blocks
    ).toEqual([
      { change: 'removed', ...p('X') },
      { change: 'added', ...p('Y') },
    ]);
  });

  it('C9 several changes in one capture, in document order', () => {
    const diff = diffContentStudioSourceBlocks(
      texts('Intro', 'Gone', 'Keep 1', 'Keep 2', 'Old end'),
      texts('New top', 'Intro', 'Keep 1', 'Keep 2', 'New end', 'Extra')
    );
    expect(diff.blocks).toEqual([
      { change: 'added', ...p('New top') },
      { change: 'unchanged', count: 1 },
      { change: 'removed', ...p('Gone') },
      { change: 'unchanged', count: 2 },
      { change: 'removed', ...p('Old end') },
      { change: 'added', ...p('New end') },
      { change: 'added', ...p('Extra') },
    ]);
    expect(diff.counts).toEqual({
      added: 3,
      removed: 2,
      unchanged: 3,
      beforeBlocks: 5,
      afterBlocks: 6,
    });
  });

  it('C11 another block type is another block', () => {
    expect(
      diffContentStudioSourceBlocks(
        blocks(p('Same words')),
        blocks({ type: 'quote', text: 'Same words', level: null })
      ).blocks
    ).toEqual([
      { change: 'removed', ...p('Same words') },
      { change: 'added', type: 'quote', text: 'Same words', level: null },
    ]);
  });

  it('C12 another level is another block', () => {
    expect(
      diffContentStudioSourceBlocks(
        blocks({ type: 'heading', text: 'Results', level: 2 }),
        blocks({ type: 'heading', text: 'Results', level: 3 })
      ).blocks
    ).toEqual([
      { change: 'removed', type: 'heading', text: 'Results', level: 2 },
      { change: 'added', type: 'heading', text: 'Results', level: 3 },
    ]);
    expect(
      diffContentStudioSourceBlocks(
        blocks({ type: 'list_item', text: 'Item', level: 0 }),
        blocks({ type: 'list_item', text: 'Item', level: 1 })
      ).counts
    ).toMatchObject({ added: 1, removed: 1, unchanged: 0 });
  });

  it('C13/P804A-10 blocks are matched without their ids: ids are positions', () => {
    const before = texts('A', 'B');
    const after = [
      { id: 'x9', ...p('A') },
      { id: 'b1', ...p('B') },
    ];
    expect(diffContentStudioSourceBlocks(before, after).blocks).toEqual([
      { change: 'unchanged', count: 2 },
    ]);
    // one block on top renumbers every block after it; they are kept
    expect(
      diffContentStudioSourceBlocks(texts('A', 'B'), texts('New', 'A', 'B'))
        .blocks
    ).toEqual([
      { change: 'added', ...p('New') },
      { change: 'unchanged', count: 2 },
    ]);
  });

  it('C13 a changed block carries its type, level and text only: no id', () => {
    const diff = diffContentStudioSourceBlocks(texts('A'), texts('B'));
    for (const block of diff.blocks) {
      expect(Object.keys(block).sort()).toEqual(
        ['change', 'level', 'text', 'type'].sort()
      );
    }
  });

  it('C14 2,000 blocks either way stay within bounds, exact and in order', () => {
    const many = (prefix: string) =>
      texts(
        ...Array.from({ length: SOURCE_BLOCKS_MAX }, (_, i) => `${prefix} ${i}`)
      );
    const all = diffContentStudioSourceBlocks(many('a'), many('b'));
    expect(all.counts).toEqual({
      added: SOURCE_BLOCKS_MAX,
      removed: SOURCE_BLOCKS_MAX,
      unchanged: 0,
      beforeBlocks: SOURCE_BLOCKS_MAX,
      afterBlocks: SOURCE_BLOCKS_MAX,
    });
    const top = diffContentStudioSourceBlocks(many('a').slice(1), [
      { id: 'b0', ...p('new') },
      ...many('a').slice(1),
    ]);
    expect(top.blocks).toEqual([
      { change: 'added', ...p('new') },
      { change: 'unchanged', count: SOURCE_BLOCKS_MAX - 1 },
    ]);
    const half = diffContentStudioSourceBlocks(
      many('a'),
      many('a').map((block, i) =>
        i % 2 ? { ...block, text: `c ${i}` } : block
      )
    );
    expect(half.counts).toMatchObject({
      added: SOURCE_BLOCKS_MAX / 2,
      removed: SOURCE_BLOCKS_MAX / 2,
      unchanged: SOURCE_BLOCKS_MAX / 2,
    });
    expect(() =>
      diffContentStudioSourceBlocks(
        texts(...Array.from({ length: SOURCE_BLOCKS_MAX + 1 }, String)),
        []
      )
    ).toThrow(RangeError);
  });

  it('C15 from no blocks to blocks: everything added', () => {
    expect(diffContentStudioSourceBlocks([], texts('A', 'B'))).toEqual({
      blocks: [
        { change: 'added', ...p('A') },
        { change: 'added', ...p('B') },
      ],
      counts: {
        added: 2,
        removed: 0,
        unchanged: 0,
        beforeBlocks: 0,
        afterBlocks: 2,
      },
    });
  });

  it('C16 from blocks to no blocks: everything removed', () => {
    expect(diffContentStudioSourceBlocks(texts('A', 'B'), [])).toEqual({
      blocks: [
        { change: 'removed', ...p('A') },
        { change: 'removed', ...p('B') },
      ],
      counts: {
        added: 0,
        removed: 2,
        unchanged: 0,
        beforeBlocks: 2,
        afterBlocks: 0,
      },
    });
  });

  it('keeps the common start and end as runs around a change in the middle', () => {
    expect(
      diffContentStudioSourceBlocks(
        texts('A', 'B', 'C', 'D', 'E'),
        texts('A', 'B', 'X', 'D', 'E')
      ).blocks
    ).toEqual([
      { change: 'unchanged', count: 2 },
      { change: 'removed', ...p('C') },
      { change: 'added', ...p('X') },
      { change: 'unchanged', count: 2 },
    ]);
    // a repeated block at the edges is kept once on each side
    expect(
      diffContentStudioSourceBlocks(texts('A', 'A'), texts('A', 'A', 'A'))
        .counts
    ).toMatchObject({ added: 1, removed: 0, unchanged: 2 });
  });
});

describe('the classification', () => {
  it('has exactly four kinds of change', () => {
    expect([...CONTENT_STUDIO_SOURCE_CHANGES]).toEqual([
      'no_earlier_change',
      'content_changed',
      'title_changed',
      'extraction_changed',
    ]);
  });

  it('CL1 no earlier different capture: no change, nothing compared', () => {
    expect(
      compareContentStudioSourceVersions(null, version(texts('A', 'B')))
    ).toEqual({
      change: 'no_earlier_change',
      titleChanged: false,
      sameFetchedBytes: false,
      blocks: [],
      counts: {
        added: 0,
        removed: 0,
        unchanged: 0,
        beforeBlocks: 0,
        afterBlocks: 2,
      },
    });
  });

  it('C10 a repeat of the same capture is no earlier change either', () => {
    const before = version(texts('A'), { sourceHash: 'c'.repeat(64) });
    const after = version(texts('A'), {
      sourceHash: 'd'.repeat(64),
    });
    expect(compareContentStudioSourceVersions(before, after)).toMatchObject({
      change: 'no_earlier_change',
      blocks: [],
    });
  });

  it('CL2 other blocks with the same extraction: content changed', () => {
    const result = compareContentStudioSourceVersions(
      version(texts('A')),
      version(texts('A', 'B'))
    );
    expect(result).toMatchObject({
      change: 'content_changed',
      titleChanged: false,
      counts: { added: 1, removed: 0, unchanged: 1 },
    });
  });

  it('C6/CL3 the same blocks with another title: only the title changed', () => {
    const result = compareContentStudioSourceVersions(
      version(texts('A')),
      version(texts('A'), { title: 'Retitled' })
    );
    expect(result).toMatchObject({
      change: 'title_changed',
      titleChanged: true,
      blocks: [{ change: 'unchanged', count: 1 }],
    });
    // a title that appears or disappears is a change of the title
    expect(
      compareContentStudioSourceVersions(
        version(texts('A'), { title: null }),
        version(texts('A'))
      )
    ).toMatchObject({ change: 'title_changed', titleChanged: true });
    expect(
      compareContentStudioSourceVersions(
        version(texts('A')),
        version(texts('A'), { title: null })
      )
    ).toMatchObject({ change: 'title_changed', titleChanged: true });
  });

  it('CL4 other blocks and another title: content changed, with the title flagged', () => {
    expect(
      compareContentStudioSourceVersions(
        version(texts('A')),
        version(texts('B'), { title: 'Retitled' })
      )
    ).toMatchObject({ change: 'content_changed', titleChanged: true });
  });

  it('C7/CL5 another extraction version: extraction changed, whatever the blocks and title, never content changed', () => {
    for (const after of [
      version(texts('A'), { extractionVersion: V1 }),
      version(texts('B'), { extractionVersion: V1 }),
      version(texts('B'), { extractionVersion: V1, title: 'Other' }),
    ]) {
      expect(
        compareContentStudioSourceVersions(version(texts('A')), after).change
      ).toBe('extraction_changed');
    }
    const result = compareContentStudioSourceVersions(
      version(texts('A'), { extractionVersion: V1, title: null }),
      version(texts('A', 'B'))
    );
    // the differences are still shown
    expect(result).toMatchObject({
      change: 'extraction_changed',
      titleChanged: true,
      counts: { added: 1, removed: 0, unchanged: 1 },
    });
  });

  it('C7B the same fetched bytes are reported only when both hashes prove it', () => {
    const before = (sourceHash: string | null) =>
      version(texts('A'), { extractionVersion: V1, sourceHash });
    const after = (sourceHash: string | null) =>
      version(texts('A', 'B'), { sourceHash });
    const same = (a: string | null, b: string | null) =>
      compareContentStudioSourceVersions(before(a), after(b)).sameFetchedBytes;
    expect(same('c'.repeat(64), 'c'.repeat(64))).toBe(true);
    expect(same('c'.repeat(64), 'd'.repeat(64))).toBe(false);
    expect(same(null, 'c'.repeat(64))).toBe(false);
    expect(same('c'.repeat(64), null)).toBe(false);
    expect(same(null, null)).toBe(false);
  });

  it('C8/CL6 the fetched bytes alone are never a change', () => {
    expect(
      compareContentStudioSourceVersions(
        version(texts('A'), { sourceHash: 'c'.repeat(64) }),
        version(texts('A'), { sourceHash: 'd'.repeat(64) })
      ).change
    ).toBe('no_earlier_change');
  });

  it('M2 reads the blocks hash, not how many blocks there are', () => {
    expect(
      compareContentStudioSourceVersions(
        version(texts('A', 'B')),
        version(texts('A', 'C'))
      ).change
    ).toBe('content_changed');
  });
});

describe('the change module boundary', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'source.change.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('P804A-4/P804A-5 is pure: no database, network, AI, clock or randomness', () => {
    expect(
      Array.from(
        text.matchAll(/^import[\s\S]*?from '([^']+)';$/gm),
        (m) => m[1]
      ).sort()
    ).toEqual([
      '@gitroom/nestjs-libraries/content-studio/canonical.json',
      '@gitroom/nestjs-libraries/content-studio/sources/source.content',
    ]);
    expect(text).not.toMatch(
      /\bDate\b|Math\.random|randomUUID|\bfetch\(|safeFetch|prisma|Prisma|AIConnection|AIOperation|AIUsage|openai|anthropic|embedding|vector|similarity|process\.env/
    );
  });

  it('P804A-10 a block fingerprint is its type, level and text', () => {
    expect(text).toMatch(
      /canonicalJson\(\{ type: block\.type, level: block\.level, text: block\.text \}\)/
    );
    expect(text).not.toMatch(/block\.id|\.id\b/);
  });
});
