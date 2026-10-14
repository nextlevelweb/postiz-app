import { z } from 'zod';
import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// The AI operations Content Studio runs on a package. kind is stored as a
// string and checked here, so a new kind needs no migration. A connection
// test is not an operation: it generates nothing
export const CONTENT_STUDIO_AI_OPERATION_KINDS = [
  'generate_item',
  'rewrite_item',
  'shorten_item',
  'expand_item',
  'change_tone',
  'generate_thread',
] as const;

export type ContentStudioAIOperationKind =
  (typeof CONTENT_STUDIO_AI_OPERATION_KINDS)[number];

export const isContentStudioAIOperationKind = (
  value: unknown
): value is ContentStudioAIOperationKind =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_AI_OPERATION_KINDS as readonly string[]).includes(value);

// Execution is synchronous: an operation is running until its single provider
// attempt is recorded
export type ContentStudioAIOperationStatus = 'running' | 'succeeded' | 'failed';
export type ContentStudioAIUsageOutcome = 'succeeded' | 'failed';
// provider: the provider reported usage; none: it did not (or the call failed)
export type ContentStudioAIUsageSource = 'provider' | 'none';

// A stable template version chosen by the caller, e.g. cs-item-v1
export const AI_PROMPT_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// The same rule as a draft item id (content.package.draft.ts)
const ITEM_ID = /^[A-Za-z0-9_-]{1,32}$/;

export const AI_OPERATION_CONTEXT_MAX_BYTES = 8192;

// Profile, policy and revision ids are Prisma uuid() values
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;

// The named profiles an operation can use, in the order they are recorded
export const CONTENT_STUDIO_AI_CONTEXT_PROFILE_KINDS = [
  'writing',
  'audience',
  'expertise',
] as const;
export type ContentStudioAIContextProfileKind =
  (typeof CONTENT_STUDIO_AI_CONTEXT_PROFILE_KINDS)[number];

const revisionNumber = z.number().int().min(1).max(INT4_MAX);

// The exact immutable revision a profile was used at; a later revision of
// the profile never changes what an operation used
const profileRef = z
  .object({
    kind: z.enum(CONTENT_STUDIO_AI_CONTEXT_PROFILE_KINDS),
    profileId: z.string().regex(UUID),
    revisionId: z.string().regex(UUID),
    revisionNumber,
  })
  .strict();

// The organization has one policy, so its revision is enough
const editorialPolicyRef = z
  .object({
    revisionId: z.string().regex(UUID),
    revisionNumber,
  })
  .strict();

// What an operation was about, as ids only: never user text, a prompt, a
// generated result, profile content or a credential. Built by the server,
// never taken from a request as it is. The profile and policy references
// were added after the first operations: a context without them is still v1
const contextV1 = z
  .object({
    v: z.literal(1),
    itemId: z.string().regex(ITEM_ID).optional(),
    // at most one per kind, in the order of the kinds above; left out when
    // none was used, never empty
    profiles: z
      .array(profileRef)
      .min(1)
      .max(CONTENT_STUDIO_AI_CONTEXT_PROFILE_KINDS.length)
      .refine(
        (profiles) =>
          profiles.every(
            (profile, index) =>
              index === 0 ||
              CONTENT_STUDIO_AI_CONTEXT_PROFILE_KINDS.indexOf(profile.kind) >
                CONTENT_STUDIO_AI_CONTEXT_PROFILE_KINDS.indexOf(
                  profiles[index - 1].kind
                )
          ),
        'Profiles out of order or repeated'
      )
      .optional(),
    editorialPolicy: editorialPolicyRef.optional(),
  })
  .strict();

export type ContentStudioAIOperationContext = z.output<typeof contextV1>;

// The context as it is stored, or undefined when it is not exactly a v1
// context of plain JSON data (no class instance, function or fraction) and at
// most 8 KiB canonical JSON
export function parseContentStudioAIOperationContext(
  value: unknown
): ContentStudioAIOperationContext | undefined {
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(canonical, 'utf8') > AI_OPERATION_CONTEXT_MAX_BYTES) {
    return undefined;
  }
  const result = contextV1.safeParse(value);
  return result.success ? result.data : undefined;
}
