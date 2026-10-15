import { z } from 'zod';
import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  isPlainData,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// Source Content v1: the text of one captured source as an ordered list of
// plain text blocks. Source text is untrusted external content: it is kept as
// text only (a `<script>` in it is just characters), never as HTML or
// Markdown, and it carries no links, images or attributes. Storing it does
// not make any statement in it true. Lengths count UTF-16 code units after
// line endings are normalized, like the other Content Studio texts; the total
// counts UTF-8 bytes of the canonical JSON that is stored

export const SOURCE_CONTENT_SCHEMA_VERSION = 1;

export const SOURCE_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'list_item',
  'quote',
] as const;
export const SOURCE_BLOCK_TEXT_MAX = {
  heading: 1000,
  paragraph: 10_000,
  list_item: 5000,
  quote: 10_000,
} as const;
export const SOURCE_BLOCKS_MAX = 2000;
export const SOURCE_CONTENT_MAX_BYTES = 1_048_576;

// Ingestion makes block ids; they only need to be stable and unique within
// one version, not database ids
const BLOCK_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const blockText = (type: (typeof SOURCE_BLOCK_TYPES)[number]) =>
  trimmedText(SOURCE_BLOCK_TEXT_MAX[type], 1);

// Every block has exactly id, type, text and level. A heading has its level
// 1-6, a list item its nesting depth 0-8; paragraphs and quotes have an
// explicit null
const blockSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: BLOCK_ID,
      type: z.literal('heading'),
      text: blockText('heading'),
      level: z.number().int().min(1).max(6),
    })
    .strict(),
  z
    .object({
      id: BLOCK_ID,
      type: z.literal('paragraph'),
      text: blockText('paragraph'),
      level: z.null(),
    })
    .strict(),
  z
    .object({
      id: BLOCK_ID,
      type: z.literal('list_item'),
      text: blockText('list_item'),
      level: z.number().int().min(0).max(8),
    })
    .strict(),
  z
    .object({
      id: BLOCK_ID,
      type: z.literal('quote'),
      text: blockText('quote'),
      level: z.null(),
    })
    .strict(),
]);

// No blocks is valid: a page can be captured without any extractable text.
// Whether ingestion keeps such a capture is its own decision
const contentSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_CONTENT_SCHEMA_VERSION),
    blocks: z
      .array(blockSchema)
      .superRefine((blocks: Array<{ id?: string }>, context) => {
        const seen = new Set<string | undefined>();
        blocks.forEach((block, index) => {
          if (seen.has(block.id)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'id'],
              message: 'Duplicate block id',
            });
          }
          seen.add(block.id);
        });
      }),
  })
  .strict();

export type ContentStudioSourceBlockType = (typeof SOURCE_BLOCK_TYPES)[number];

export interface ContentStudioSourceBlock {
  id: string;
  type: ContentStudioSourceBlockType;
  text: string;
  level: number | null;
}

export interface ContentStudioSourceContentV1 {
  schemaVersion: 1;
  blocks: ContentStudioSourceBlock[];
}

export type ContentStudioSourceContentErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioSourceContentIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioSourceContentErrorCode, string> = {
  INVALID: 'The source content does not match schema version 1',
  TOO_LARGE: 'The source content is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value, which is external text
export class ContentStudioSourceContentError extends Error {
  readonly issues?: ContentStudioSourceContentIssue[];

  constructor(
    readonly code: ContentStudioSourceContentErrorCode,
    issues?: ContentStudioSourceContentIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioSourceContentError';
    this.issues = issues;
  }
}

// Validates and normalizes source content (from ingestion or read back from
// the database) into a new object: line endings normalized, block texts
// trimmed. The input is never changed. Anything else is refused, never
// repaired: no block is dropped, merged, cut or renumbered
export function parseContentStudioSourceContent(
  input: unknown
): ContentStudioSourceContentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioSourceContentError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  // counted before the blocks are parsed, so an oversized capture costs no
  // validation work
  const blocks = (input as { blocks?: unknown } | null)?.blocks;
  if (Array.isArray(blocks) && blocks.length > SOURCE_BLOCKS_MAX) {
    throw new ContentStudioSourceContentError('TOO_LARGE');
  }
  const result = contentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioSourceContentError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  if (utf8ByteLength(canonicalJson(result.data)) > SOURCE_CONTENT_MAX_BYTES) {
    throw new ContentStudioSourceContentError('TOO_LARGE');
  }
  return result.data as ContentStudioSourceContentV1;
}
