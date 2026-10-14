import { z } from 'zod';
import {
  distinctList,
  isPlainData,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// Expertise Profile v1: what an organization knows and how it wants that
// expertise presented, as structured, bounded context that later AI generation
// reads from an exact revision. Entered by hand; nothing here is inferred.
// It is organization-provided context, not verified fact: there is no source,
// citation, link or verification field, and evidenceExpectations and
// confidenceBoundaries are plain editorial instructions, not evidence or a
// score. Lengths count UTF-16 code units after line endings are normalized,
// like the Writing DNA. Like that parser this file uses no Node-only module

export const EXPERTISE_PROFILE_SCHEMA_VERSION = 1;

export const EXPERTISE_PROFILE_NAME_MAX = 100;
export const EXPERTISE_SUBJECTS_MAX = 20;
export const EXPERTISE_SUBJECT_MAX = 200;
export const EXPERTISE_DIFFERENTIATORS_MAX = 10;
export const EXPERTISE_DIFFERENTIATOR_MAX = 500;
export const EXPERTISE_STANCES_MAX = 20;
export const EXPERTISE_STANCE_TOPIC_MAX = 200;
export const EXPERTISE_STANCE_POSITION_MAX = 1000;
export const EXPERTISE_FRAMEWORKS_MAX = 10;
export const EXPERTISE_FRAMEWORK_MAX = 300;
export const EXPERTISE_AVOID_TOPICS_MAX = 20;
export const EXPERTISE_AVOID_TOPIC_MAX = 200;
export const EXPERTISE_INSTRUCTION_MAX = 2000;
// UTF-8 bytes of the normalized content as JSON. canonicalJson writes the same
// keys and strings in another order only, so this is its size too
export const EXPERTISE_PROFILE_CONTENT_MAX_BYTES = 32_768;

// A position on a topic, kept in the order entered: the order can matter
const stance = z
  .object({
    topic: trimmedText(EXPERTISE_STANCE_TOPIC_MAX, 1),
    position: trimmedText(EXPERTISE_STANCE_POSITION_MAX, 1),
  })
  .strict();

// One stance per topic: two positions on the same topic are refused, not
// merged
const stances = z
  .array(stance)
  .max(EXPERTISE_STANCES_MAX)
  .superRefine((list, context) => {
    const topics = list.map((entry) => entry.topic);
    topics.forEach((topic, index) => {
      if (topics.indexOf(topic) !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'topic'],
          message: 'Duplicate topic',
        });
      }
    });
  });

// Every key is required. Each list refuses an entry it already has. A subject
// or a stance topic that is also a topic to avoid contradicts itself and is
// refused; any other overlap between lists is allowed. Exact text only, no
// fuzzy matching
const contentSchema = z
  .object({
    schemaVersion: z.literal(EXPERTISE_PROFILE_SCHEMA_VERSION),
    subjects: distinctList(
      trimmedText(EXPERTISE_SUBJECT_MAX, 1),
      EXPERTISE_SUBJECTS_MAX
    ),
    differentiators: distinctList(
      trimmedText(EXPERTISE_DIFFERENTIATOR_MAX, 1),
      EXPERTISE_DIFFERENTIATORS_MAX
    ),
    stances,
    frameworks: distinctList(
      trimmedText(EXPERTISE_FRAMEWORK_MAX, 1),
      EXPERTISE_FRAMEWORKS_MAX
    ),
    // an editorial instruction about evidence, never evidence itself
    evidenceExpectations: trimmedText(EXPERTISE_INSTRUCTION_MAX),
    avoidTopics: distinctList(
      trimmedText(EXPERTISE_AVOID_TOPIC_MAX, 1),
      EXPERTISE_AVOID_TOPICS_MAX
    ),
    // where to use cautious language, never a score
    confidenceBoundaries: trimmedText(EXPERTISE_INSTRUCTION_MAX),
  })
  .strict()
  .superRefine((content, context) => {
    const avoided = new Set<string>(content.avoidTopics);
    content.subjects.forEach((subject: string, index: number) => {
      if (avoided.has(subject)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjects', index],
          message: 'Subject is also a topic to avoid',
        });
      }
    });
    content.stances.forEach((entry, index) => {
      if (avoided.has(entry.topic)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stances', index, 'topic'],
          message: 'Stance topic is also a topic to avoid',
        });
      }
    });
  });

export interface ContentStudioExpertiseProfileContentV1 {
  schemaVersion: 1;
  subjects: string[];
  differentiators: string[];
  stances: Array<{ topic: string; position: string }>;
  frameworks: string[];
  evidenceExpectations: string;
  avoidTopics: string[];
  confidenceBoundaries: string;
}

export type ContentStudioExpertiseProfileErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioExpertiseProfileIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioExpertiseProfileErrorCode, string> = {
  INVALID: 'The expertise profile does not match schema version 1',
  TOO_LARGE: 'The expertise profile is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value
export class ContentStudioExpertiseProfileError extends Error {
  readonly issues?: ContentStudioExpertiseProfileIssue[];

  constructor(
    readonly code: ContentStudioExpertiseProfileErrorCode,
    issues?: ContentStudioExpertiseProfileIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioExpertiseProfileError';
    this.issues = issues;
  }
}

// Validates and normalizes an expertise profile (from a request or read back
// from the database) into a new object: line endings normalized, texts
// trimmed, stance order kept. The input is never changed. Anything else is
// refused, never repaired: no entry is dropped or merged
export function parseContentStudioExpertiseProfileContent(
  input: unknown
): ContentStudioExpertiseProfileContentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioExpertiseProfileError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = contentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioExpertiseProfileError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  if (
    utf8ByteLength(JSON.stringify(result.data)) >
    EXPERTISE_PROFILE_CONTENT_MAX_BYTES
  ) {
    throw new ContentStudioExpertiseProfileError('TOO_LARGE');
  }
  return result.data as ContentStudioExpertiseProfileContentV1;
}

// A profile with nothing described yet
export const emptyContentStudioExpertiseProfileContent =
  (): ContentStudioExpertiseProfileContentV1 =>
    parseContentStudioExpertiseProfileContent({
      schemaVersion: EXPERTISE_PROFILE_SCHEMA_VERSION,
      subjects: [],
      differentiators: [],
      stances: [],
      frameworks: [],
      evidenceExpectations: '',
      avoidTopics: [],
      confidenceBoundaries: '',
    });
