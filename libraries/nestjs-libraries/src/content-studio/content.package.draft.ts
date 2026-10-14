import { z } from 'zod';

// ContentPackageDraft v1, the mutable working copy of a Content Studio
// package. Copy is plain text (never HTML) and media are referenced by id
// only: the server resolves paths and builds the composer HTML at handoff.
// The frontend imports this file too, so it must not use Node-only modules

export const CONTENT_PACKAGE_SCHEMA_VERSION = 1;

export const PACKAGE_NAME_MAX = 200;
export const PROJECT_NAME_MAX = 100;

export const THREAD_ITEMS_MIN = 1;
export const THREAD_ITEMS_MAX = 25;

// Counted in UTF-16 code units (String.length), after line endings are
// normalized, the same way the textarea counts them
export const ITEM_TEXT_MAX = 10_000;
export const ITEM_MEDIA_MAX = 20;

export const PACKAGE_UNIQUE_MEDIA_MAX = 50;
// UTF-8 bytes of the validated draft serialized as JSON, so formatting and
// key order of the request body don't count
export const DRAFT_CANONICAL_MAX_BYTES = 65_536;

const ITEM_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Media ids are uuids today; any safe token up to 64 characters is accepted
// so the shape doesn't need a new version if that changes, while a path, URL
// or anything with dots, slashes or spaces can never pass
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

// A UTF-8 encoder turns an unpaired surrogate into U+FFFD, so stored text,
// byte counts and hashes could silently disagree
const hasLoneSurrogate = (text: string) => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

// The text of one item, as a draft holds it. AI proposals are checked with
// it too, so a suggestion is exactly what the editor could save
export const contentPackageItemText = z
  .string()
  .transform(normalizeLineEndings)
  .pipe(
    z
      .string()
      .max(ITEM_TEXT_MAX)
      .refine((text) => !text.includes('\u0000'), 'NUL character')
      .refine((text) => !hasLoneSurrogate(text), 'Unpaired surrogate')
  );

const threadItem = z
  .object({
    id: z.string().regex(ITEM_ID),
    text: contentPackageItemText,
    mediaIds: z.array(z.string().regex(MEDIA_ID)).max(ITEM_MEDIA_MAX),
  })
  .strict()
  .superRefine((item, context) => {
    item.mediaIds.forEach((id, index) => {
      if (item.mediaIds.indexOf(id) !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mediaIds', index],
          message: 'Duplicate media id in item',
        });
      }
    });
  });

const draftSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_PACKAGE_SCHEMA_VERSION),
    copy: z
      .object({
        global: z
          .object({
            thread: z
              .array(threadItem)
              .min(THREAD_ITEMS_MIN)
              .max(THREAD_ITEMS_MAX),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((draft, context) => {
    const thread = draft.copy.global.thread;
    const ids = thread.map((item) => item.id);
    ids.forEach((id, index) => {
      if (ids.indexOf(id) !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['copy', 'global', 'thread', index, 'id'],
          message: 'Duplicate item id',
        });
      }
    });
    // the same media may be reused in several items
    if (
      new Set(thread.flatMap((item) => item.mediaIds)).size >
      PACKAGE_UNIQUE_MEDIA_MAX
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['copy', 'global', 'thread'],
        message: 'Too many distinct media',
      });
    }
  });

export type ContentPackageDraftV1 = z.output<typeof draftSchema>;
export type ContentPackageThreadItemV1 =
  ContentPackageDraftV1['copy']['global']['thread'][number];

export type ContentPackageDraftErrorCode =
  | 'INVALID_DRAFT'
  | 'DRAFT_TOO_LARGE'
  | 'EMPTY_ITEM';

export interface ContentPackageDraftIssue {
  path: Array<string | number>;
  code: string;
}

const DRAFT_ERROR_MESSAGES: Record<ContentPackageDraftErrorCode, string> = {
  INVALID_DRAFT: 'The content package draft does not match schema version 1',
  DRAFT_TOO_LARGE: 'The content package draft is larger than allowed',
  EMPTY_ITEM: 'Every thread item needs text or media',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value, which may be user text
export class ContentPackageDraftError extends Error {
  readonly code: ContentPackageDraftErrorCode;
  readonly itemIndex?: number;
  readonly issues?: ContentPackageDraftIssue[];

  constructor(
    code: ContentPackageDraftErrorCode,
    details: { itemIndex?: number; issues?: ContentPackageDraftIssue[] } = {}
  ) {
    super(DRAFT_ERROR_MESSAGES[code]);
    this.name = 'ContentPackageDraftError';
    this.code = code;
    this.itemIndex = details.itemIndex;
    this.issues = details.issues;
  }
}

const utf8ByteLength = (text: string) => new TextEncoder().encode(text).length;

// Validates and normalizes a draft (from a request or read back from the
// database). The result has the schema's key order and no unknown keys, so
// its JSON size is the same however the input was written
export function parseContentPackageDraft(
  input: unknown
): ContentPackageDraftV1 {
  const result = draftSchema.safeParse(input);
  if (!result.success) {
    throw new ContentPackageDraftError('INVALID_DRAFT', {
      issues: result.error.issues.map(({ path, code }) => ({ path, code })),
    });
  }
  if (utf8ByteLength(JSON.stringify(result.data)) > DRAFT_CANONICAL_MAX_BYTES) {
    throw new ContentPackageDraftError('DRAFT_TOO_LARGE');
  }
  return result.data;
}

// The draft of a new package: one empty main item. The id is passed in so the
// server can make it with a secure random source
export const emptyContentPackageDraft = (itemId: string) =>
  parseContentPackageDraft({
    schemaVersion: CONTENT_PACKAGE_SCHEMA_VERSION,
    copy: { global: { thread: [{ id: itemId, text: '', mediaIds: [] }] } },
  });

// Stricter than a valid draft: what becomes a revision or goes to the
// composer must have something in every item. Provider limits are left to the
// composer and publishing
export function assertContentPackagePublishable(draft: ContentPackageDraftV1) {
  draft.copy.global.thread.forEach((item, itemIndex) => {
    if (!item.text.trim() && !item.mediaIds.length) {
      throw new ContentPackageDraftError('EMPTY_ITEM', { itemIndex });
    }
  });
}
