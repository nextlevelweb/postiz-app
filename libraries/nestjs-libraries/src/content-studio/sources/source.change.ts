import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioSourceBlock,
  ContentStudioSourceBlockType,
  ContentStudioSourceContentV1,
  SOURCE_BLOCKS_MAX,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.content';

// What changed between two captures of a page source (P8-04A). Pure and
// deterministic: no database, network, clock or randomness. It compares what
// was captured, never whether it is true, and it never calls a difference
// more than it is:
// - two captures are the same capture when their blocks (contentHash), title
//   and extraction version are equal. Feed captures use this rule to add no
//   version; a refresh still adds one, so a page's history can hold repeats
// - a capture is compared with the first capture of the newest earlier run
//   that is not the same capture (chosen by the caller), so repeats are
//   skipped
// - another extraction version is never called a change of the page, even
//   when the blocks differ: the extractor may have made the difference
// - redirects, status, type, size, fetch time and the fetched bytes' hash are
//   provenance, never a change
// - what a capture is to the capture just before it (P8-04B1) is decided by
//   the same rules: a version append and the page-change backfill keep the
//   source's last page change with it, and a repeat or another extraction
//   version is never one
// - blocks are matched by type, level and text, in order. Block ids are
//   positions (b1, b2, ...) and say nothing across versions, so a block that
//   was edited is one removed and one added block; there is no "modified"

// The fields of a version that make it the same capture as another
export interface ContentStudioSourceCaptureIdentity {
  contentHash: string;
  title: string | null;
  extractionVersion: string;
}

export const isSameContentStudioSourceCapture = (
  a: ContentStudioSourceCaptureIdentity,
  b: ContentStudioSourceCaptureIdentity
) =>
  a.contentHash === b.contentHash &&
  a.title === b.title &&
  a.extractionVersion === b.extractionVersion;

export const CONTENT_STUDIO_SOURCE_CHANGES = [
  // there is no earlier capture that is not the same capture
  'no_earlier_change',
  // the same extraction, other blocks (the title may have changed too)
  'content_changed',
  // the same extraction and blocks, another title
  'title_changed',
  // another extraction version: differences may come from the extractor
  'extraction_changed',
] as const;

export type ContentStudioSourceChange =
  (typeof CONTENT_STUDIO_SOURCE_CHANGES)[number];

// What a capture is to the capture just before it (P8-04B1): the first one,
// a repeat of it, or one of the changes. The one place the order of the
// changes is decided: another extraction version first, then the blocks,
// then the title
export type ContentStudioSourceCaptureTransition =
  | 'initial'
  | 'repeat'
  | Exclude<ContentStudioSourceChange, 'no_earlier_change'>;

export function classifyContentStudioSourceCaptureTransition(
  previous: ContentStudioSourceCaptureIdentity | null,
  next: ContentStudioSourceCaptureIdentity
): ContentStudioSourceCaptureTransition {
  if (!previous) {
    return 'initial';
  }
  if (isSameContentStudioSourceCapture(previous, next)) {
    return 'repeat';
  }
  return previous.extractionVersion !== next.extractionVersion
    ? 'extraction_changed'
    : previous.contentHash !== next.contentHash
    ? 'content_changed'
    : 'title_changed';
}

// A change of the page itself: its blocks or its title, with the same
// extraction. Another extraction version is never one. Also the check of a
// stored lastPageChangeKind
export const CONTENT_STUDIO_SOURCE_PAGE_CHANGES = [
  'content_changed',
  'title_changed',
] as const;

export type ContentStudioSourcePageChange =
  (typeof CONTENT_STUDIO_SOURCE_PAGE_CHANGES)[number];

export const isContentStudioSourcePageChange = (
  value: unknown
): value is ContentStudioSourcePageChange =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_SOURCE_PAGE_CHANGES as readonly string[]).includes(value);

export type ContentStudioSourceBlockChange =
  | {
      change: 'added' | 'removed';
      type: ContentStudioSourceBlockType;
      level: number | null;
      text: string;
    }
  | { change: 'unchanged'; count: number };

export interface ContentStudioSourceBlockDiff {
  blocks: ContentStudioSourceBlockChange[];
  counts: {
    added: number;
    removed: number;
    unchanged: number;
    beforeBlocks: number;
    afterBlocks: number;
  };
}

// A version as compared: verified content and the fields the rule reads
export interface ContentStudioComparedSourceVersion
  extends ContentStudioSourceCaptureIdentity {
  sourceHash: string | null;
  content: ContentStudioSourceContentV1;
}

// A block without its id: equal only with the same type, level and text
const fingerprint = (block: ContentStudioSourceBlock) =>
  canonicalJson({ type: block.type, level: block.level, text: block.text });

// The blocks of two versions in document order: kept blocks as runs, the
// others added or removed. The common start and end are kept as they are;
// what is left in between is matched by the longest common subsequence, and
// where two choices keep as many blocks, the removed block comes first
export function diffContentStudioSourceBlocks(
  before: ContentStudioSourceBlock[],
  after: ContentStudioSourceBlock[]
): ContentStudioSourceBlockDiff {
  // verified content has at most this many blocks: the table below stays
  // bounded, and its counts fit 16 bits
  if (before.length > SOURCE_BLOCKS_MAX || after.length > SOURCE_BLOCKS_MAX) {
    throw new RangeError('Too many source blocks to compare');
  }
  // each distinct fingerprint as a small number: equal blocks, equal numbers
  const numbers = new Map<string, number>();
  const number = (block: ContentStudioSourceBlock) => {
    const key = fingerprint(block);
    if (!numbers.has(key)) {
      numbers.set(key, numbers.size);
    }
    return numbers.get(key)!;
  };
  const a = before.map(number);
  const b = after.map(number);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  // kept[i * width + j]: blocks kept from a[start + i..] and b[start + j..]
  const rows = endA - start;
  const columns = endB - start;
  const width = columns + 1;
  const kept = new Uint16Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      kept[i * width + j] =
        a[start + i] === b[start + j]
          ? kept[(i + 1) * width + j + 1] + 1
          : Math.max(kept[(i + 1) * width + j], kept[i * width + j + 1]);
    }
  }

  const blocks: ContentStudioSourceBlockChange[] = [];
  const counts = {
    added: 0,
    removed: 0,
    unchanged: 0,
    beforeBlocks: before.length,
    afterBlocks: after.length,
  };
  const keep = (count: number) => {
    if (!count) {
      return;
    }
    counts.unchanged += count;
    const last = blocks[blocks.length - 1];
    if (last && last.change === 'unchanged') {
      last.count += count;
    } else {
      blocks.push({ change: 'unchanged', count });
    }
  };
  const change = (
    kind: 'added' | 'removed',
    block: ContentStudioSourceBlock
  ) => {
    counts[kind]++;
    blocks.push({
      change: kind,
      type: block.type,
      level: block.level,
      text: block.text,
    });
  };

  keep(start);
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && a[start + i] === b[start + j]) {
      keep(1);
      i++;
      j++;
    } else if (
      i < rows &&
      (j === columns || kept[(i + 1) * width + j] >= kept[i * width + j + 1])
    ) {
      change('removed', before[start + i]);
      i++;
    } else {
      change('added', after[start + j]);
      j++;
    }
  }
  keep(a.length - endA);
  return { blocks, counts };
}

// What changed in `after` since `before`, the earlier capture it is compared
// with (null when there is none). A `before` that is the same capture is no
// earlier change either: there is nothing to compare
export function compareContentStudioSourceVersions(
  before: ContentStudioComparedSourceVersion | null,
  after: ContentStudioComparedSourceVersion
): ContentStudioSourceBlockDiff & {
  change: ContentStudioSourceChange;
  titleChanged: boolean;
  sameFetchedBytes: boolean;
} {
  const transition = classifyContentStudioSourceCaptureTransition(
    before,
    after
  );
  // the first capture or a repeat (`before` as well, for the type)
  if (!before || transition === 'initial' || transition === 'repeat') {
    return {
      change: 'no_earlier_change',
      titleChanged: false,
      sameFetchedBytes: false,
      blocks: [],
      counts: {
        added: 0,
        removed: 0,
        unchanged: 0,
        beforeBlocks: 0,
        afterBlocks: after.content.blocks.length,
      },
    };
  }
  return {
    change: transition,
    titleChanged: before.title !== after.title,
    // proven by the hashes of both fetched bodies, never assumed
    sameFetchedBytes:
      before.sourceHash !== null &&
      after.sourceHash !== null &&
      before.sourceHash === after.sourceHash,
    ...diffContentStudioSourceBlocks(
      before.content.blocks,
      after.content.blocks
    ),
  };
}
