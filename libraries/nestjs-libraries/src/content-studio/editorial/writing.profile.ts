import { z } from 'zod';

// Writing DNA v1: how an organization writes, as structured, bounded data that
// later AI generation reads from an exact revision. Entered by hand; nothing
// here is inferred. Lengths count UTF-16 code units (String.length) after
// line endings are normalized, like the draft. Like the draft parser this file
// uses no Node-only module

export const WRITING_PROFILE_SCHEMA_VERSION = 1;

export const WRITING_PROFILE_NAME_MAX = 100;
export const WRITING_VOICE_MAX = 1000;
export const WRITING_TONE_TAGS_MAX = 10;
export const WRITING_TONE_TAG_MAX = 60;
export const WRITING_NOTES_MAX = 500;
export const WRITING_VOCABULARY_MAX = 30;
export const WRITING_TERM_MAX = 60;
export const WRITING_RULES_MAX = 20;
export const WRITING_RULE_MAX = 300;
export const WRITING_EXAMPLES_MAX = 5;
export const WRITING_EXAMPLE_TEXT_MAX = 5000;
export const WRITING_EXAMPLE_NOTE_MAX = 300;
// UTF-8 bytes of the normalized content as JSON. canonicalJson writes the same
// keys and strings in another order only, so this is its size too
export const WRITING_PROFILE_CONTENT_MAX_BYTES = 32_768;

export const WRITING_PERSPECTIVES = [
  'first_singular',
  'first_plural',
  'second',
  'third',
  'mixed',
] as const;
export const WRITING_EMOJI_USE = ['none', 'sparing', 'free'] as const;
export const WRITING_HASHTAG_USE = ['none', 'few', 'many'] as const;

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

const isSafeText = (text: string) =>
  !text.includes('\u0000') && !hasLoneSurrogate(text);

// Labels, rules and notes: line endings normalized, outer whitespace trimmed.
// The text helpers below are shared with the editorial policy
export const trimmedText = (max: number, min = 0) =>
  z
    .string()
    .transform((text) => normalizeLineEndings(text).trim())
    .pipe(z.string().min(min).max(max).refine(isSafeText, 'Unsafe text'));

// A note left out, null or blank is stored as null
export const optionalNote = (max: number) =>
  trimmedText(max)
    .nullable()
    .optional()
    .transform((note) => (note ? note : null));

// A list of distinct entries: the same entry twice is refused, not merged
export const distinctList = (entry: z.ZodTypeAny, max: number) =>
  z
    .array(entry)
    .max(max)
    .superRefine((list: string[], context) => {
      list.forEach((value, index) => {
        if (list.indexOf(value) !== index) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: 'Duplicate entry',
          });
        }
      });
    });

// An example is kept as written apart from its line endings: indentation and
// spacing can be part of a style. It needs something besides whitespace
const exampleText = z
  .string()
  .transform(normalizeLineEndings)
  .pipe(
    z
      .string()
      .max(WRITING_EXAMPLE_TEXT_MAX)
      .refine((text) => text.trim().length > 0, 'Empty example')
      .refine(isSafeText, 'Unsafe text')
  );

const contentSchema = z
  .object({
    schemaVersion: z.literal(WRITING_PROFILE_SCHEMA_VERSION),
    voice: trimmedText(WRITING_VOICE_MAX),
    toneTags: distinctList(
      trimmedText(WRITING_TONE_TAG_MAX, 1),
      WRITING_TONE_TAGS_MAX
    ),
    perspective: z
      .enum(WRITING_PERSPECTIVES)
      .nullable()
      .optional()
      .transform((perspective) => perspective ?? null),
    formatting: z
      .object({
        emoji: z.enum(WRITING_EMOJI_USE),
        hashtags: z.enum(WRITING_HASHTAG_USE),
        notes: optionalNote(WRITING_NOTES_MAX),
      })
      .strict(),
    vocabulary: z
      .object({
        prefer: distinctList(
          trimmedText(WRITING_TERM_MAX, 1),
          WRITING_VOCABULARY_MAX
        ),
        avoid: distinctList(
          trimmedText(WRITING_TERM_MAX, 1),
          WRITING_VOCABULARY_MAX
        ),
      })
      .strict()
      .superRefine((vocabulary, context) => {
        // a term cannot be both preferred and avoided
        vocabulary.avoid.forEach((term: string, index: number) => {
          if (vocabulary.prefer.includes(term)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['avoid', index],
              message: 'Term is also preferred',
            });
          }
        });
      }),
    dos: distinctList(trimmedText(WRITING_RULE_MAX, 1), WRITING_RULES_MAX),
    donts: distinctList(trimmedText(WRITING_RULE_MAX, 1), WRITING_RULES_MAX),
    examples: z
      .array(
        z
          .object({
            text: exampleText,
            note: optionalNote(WRITING_EXAMPLE_NOTE_MAX),
          })
          .strict()
      )
      .max(WRITING_EXAMPLES_MAX),
  })
  .strict();

export interface ContentStudioWritingProfileContentV1 {
  schemaVersion: 1;
  voice: string;
  toneTags: string[];
  perspective: (typeof WRITING_PERSPECTIVES)[number] | null;
  formatting: {
    emoji: (typeof WRITING_EMOJI_USE)[number];
    hashtags: (typeof WRITING_HASHTAG_USE)[number];
    notes: string | null;
  };
  vocabulary: { prefer: string[]; avoid: string[] };
  dos: string[];
  donts: string[];
  examples: Array<{ text: string; note: string | null }>;
}

export type ContentStudioWritingProfileErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioWritingProfileIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioWritingProfileErrorCode, string> = {
  INVALID: 'The writing profile does not match schema version 1',
  TOO_LARGE: 'The writing profile is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value, which may be brand text
export class ContentStudioWritingProfileError extends Error {
  readonly issues?: ContentStudioWritingProfileIssue[];

  constructor(
    readonly code: ContentStudioWritingProfileErrorCode,
    issues?: ContentStudioWritingProfileIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioWritingProfileError';
    this.issues = issues;
  }
}

export const isPlainData = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isPlainData);
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isPlainData)
  );
};

export const utf8ByteLength = (text: string) =>
  new TextEncoder().encode(text).length;

// Validates and normalizes Writing DNA (from a request or read back from the
// database) into a new object: line endings normalized, labels and rules
// trimmed, notes left out stored as null. The input is never changed.
// Anything else is refused, never repaired: no entry is dropped or merged
export function parseContentStudioWritingProfileContent(
  input: unknown
): ContentStudioWritingProfileContentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioWritingProfileError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = contentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioWritingProfileError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  if (
    utf8ByteLength(JSON.stringify(result.data)) >
    WRITING_PROFILE_CONTENT_MAX_BYTES
  ) {
    throw new ContentStudioWritingProfileError('TOO_LARGE');
  }
  return result.data as ContentStudioWritingProfileContentV1;
}

// A profile with nothing defined yet: no voice, no emoji, no hashtags
export const emptyContentStudioWritingProfileContent =
  (): ContentStudioWritingProfileContentV1 =>
    parseContentStudioWritingProfileContent({
      schemaVersion: WRITING_PROFILE_SCHEMA_VERSION,
      voice: '',
      toneTags: [],
      perspective: null,
      formatting: { emoji: 'none', hashtags: 'none', notes: null },
      vocabulary: { prefer: [], avoid: [] },
      dos: [],
      donts: [],
      examples: [],
    });
