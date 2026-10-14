import { z } from 'zod';
import {
  distinctList,
  isPlainData,
  optionalNote,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// Audience Profile v1: who an organization's content is written for, as
// structured, bounded editorial context that later AI generation reads from an
// exact revision. Entered by hand; nothing here is inferred. It describes a
// kind of reader, never people: there are no demographic, sensitive,
// contact, tracking or ad-platform fields, and the locale is the language to
// write in, not a place to target. Lengths count UTF-16 code units after line
// endings are normalized, like the Writing DNA. Like that parser this file
// uses no Node-only module

export const AUDIENCE_PROFILE_SCHEMA_VERSION = 1;

export const AUDIENCE_PROFILE_NAME_MAX = 100;
export const AUDIENCE_DESCRIPTION_MAX = 2000;
export const AUDIENCE_ROLE_MAX = 300;
export const AUDIENCE_LIST_MAX = 10;
export const AUDIENCE_LIST_ENTRY_MAX = 300;
export const AUDIENCE_TONE_MAX = 300;
export const AUDIENCE_LOCALE_MAX = 35;
// UTF-8 bytes of the normalized content as JSON. canonicalJson writes the same
// keys and strings in another order only, so this is its size too
export const AUDIENCE_PROFILE_CONTENT_MAX_BYTES = 16_384;

export const AUDIENCE_KNOWLEDGE_LEVELS = [
  'beginner',
  'intermediate',
  'expert',
  'mixed',
] as const;

// A language tag in the usual BCP 47 shape (nl, nl-NL, zh-Hant-TW): a 2-8
// letter language, then 1-8 letter or digit subtags joined by single hyphens.
// Deliberately conservative, not a full BCP 47 parser, and kept exactly as
// typed (trimmed only): casing is not canonicalized
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

// A locale left out, null or blank is stored as null
const locale = z
  .string()
  .nullable()
  .optional()
  .transform((value) => (value ? value.trim() : '') || null)
  .pipe(z.string().max(AUDIENCE_LOCALE_MAX).regex(LOCALE).nullable());

const listOf = () =>
  distinctList(trimmedText(AUDIENCE_LIST_ENTRY_MAX, 1), AUDIENCE_LIST_MAX);

// Every key but preferredTone and locale is required. Each list refuses an
// entry it already has; the same text in two different lists is allowed
const contentSchema = z
  .object({
    schemaVersion: z.literal(AUDIENCE_PROFILE_SCHEMA_VERSION),
    description: trimmedText(AUDIENCE_DESCRIPTION_MAX),
    role: trimmedText(AUDIENCE_ROLE_MAX),
    knowledgeLevel: z.enum(AUDIENCE_KNOWLEDGE_LEVELS),
    goals: listOf(),
    painPoints: listOf(),
    objections: listOf(),
    preferredTone: optionalNote(AUDIENCE_TONE_MAX),
    locale,
  })
  .strict();

export interface ContentStudioAudienceProfileContentV1 {
  schemaVersion: 1;
  description: string;
  role: string;
  knowledgeLevel: (typeof AUDIENCE_KNOWLEDGE_LEVELS)[number];
  goals: string[];
  painPoints: string[];
  objections: string[];
  preferredTone: string | null;
  locale: string | null;
}

export type ContentStudioAudienceProfileErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioAudienceProfileIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioAudienceProfileErrorCode, string> = {
  INVALID: 'The audience profile does not match schema version 1',
  TOO_LARGE: 'The audience profile is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value
export class ContentStudioAudienceProfileError extends Error {
  readonly issues?: ContentStudioAudienceProfileIssue[];

  constructor(
    readonly code: ContentStudioAudienceProfileErrorCode,
    issues?: ContentStudioAudienceProfileIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioAudienceProfileError';
    this.issues = issues;
  }
}

// Validates and normalizes an audience profile (from a request or read back
// from the database) into a new object: line endings normalized, texts
// trimmed, a tone or locale left out stored as null. The input is never
// changed. Anything else is refused, never repaired: no entry is dropped or
// merged
export function parseContentStudioAudienceProfileContent(
  input: unknown
): ContentStudioAudienceProfileContentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioAudienceProfileError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = contentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioAudienceProfileError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  if (
    utf8ByteLength(JSON.stringify(result.data)) >
    AUDIENCE_PROFILE_CONTENT_MAX_BYTES
  ) {
    throw new ContentStudioAudienceProfileError('TOO_LARGE');
  }
  return result.data as ContentStudioAudienceProfileContentV1;
}

// A profile with nothing described yet, for a mixed audience
export const emptyContentStudioAudienceProfileContent =
  (): ContentStudioAudienceProfileContentV1 =>
    parseContentStudioAudienceProfileContent({
      schemaVersion: AUDIENCE_PROFILE_SCHEMA_VERSION,
      description: '',
      role: '',
      knowledgeLevel: 'mixed',
      goals: [],
      painPoints: [],
      objections: [],
      preferredTone: null,
      locale: null,
    });
