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

// The AI operations Content Studio runs on one saved design revision
// (P6-02): one kind per Design Creative AI intent. They are recorded like the
// package operations, but never on a package
export const CONTENT_STUDIO_AI_DESIGN_OPERATION_KINDS = [
  'design_improve_copy',
  'design_tighten_copy',
  'design_adapt_tone',
  'design_improve_hierarchy',
  'design_restyle',
  'design_rebalance_layout',
] as const;

export type ContentStudioAIDesignOperationKind =
  (typeof CONTENT_STUDIO_AI_DESIGN_OPERATION_KINDS)[number];

export const isContentStudioAIDesignOperationKind = (
  value: unknown
): value is ContentStudioAIDesignOperationKind =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_AI_DESIGN_OPERATION_KINDS as readonly string[]).includes(
    value
  );

// The AI operations Content Studio runs for the organization itself, on no
// package and no design: the guided setup's first draft of the brand,
// writing, audience, expertise and editorial context. The draft is returned
// for the user to review and is never stored by the operation
export const CONTENT_STUDIO_AI_SETUP_OPERATION_KINDS = [
  'setup_proposal',
] as const;

export type ContentStudioAISetupOperationKind =
  (typeof CONTENT_STUDIO_AI_SETUP_OPERATION_KINDS)[number];

export const isContentStudioAISetupOperationKind = (
  value: unknown
): value is ContentStudioAISetupOperationKind =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_AI_SETUP_OPERATION_KINDS as readonly string[]).includes(
    value
  );

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

// Profile, policy, source, revision and version ids are Prisma uuid() values
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// revision and version numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// The most sources one AI operation can use. Each is chosen by the user for
// that request; nothing is retrieved or added by the server
export const CONTENT_STUDIO_AI_MAX_SOURCES = 5;

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

// The exact immutable source version whose blocks were in the prompt, with
// the hash of those blocks, so the operation identifies the text it used
// without storing it. Nothing else of the source: no name, title, URL or
// fetch provenance (that stays on the version)
const sourceRef = z
  .object({
    sourceId: z.string().regex(UUID),
    versionId: z.string().regex(UUID),
    versionNumber: revisionNumber,
    contentHash: z.string().regex(SHA256_HEX),
  })
  .strict();

// The exact design revision a design operation was asked for: the design,
// the revision with its number and the hash of its stored document. Never
// the document itself
const designRef = z
  .object({
    designId: z.string().regex(UUID),
    revisionId: z.string().regex(UUID),
    revisionNumber,
    contentHash: z.string().regex(SHA256_HEX),
  })
  .strict();

// What an operation was about, as ids only: never user text, a prompt, a
// generated result, profile or source content or a credential. Built by the
// server, never taken from a request as it is. The profile, policy, source
// and design references were added after the first operations: a context
// without them is still v1
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
    // in the order the user chose them, which is the order of the prompt;
    // left out when none was used, never empty
    sources: z
      .array(sourceRef)
      .min(1)
      .max(CONTENT_STUDIO_AI_MAX_SOURCES)
      .refine(
        (sources) =>
          new Set(sources.map((source) => source.sourceId)).size ===
            sources.length &&
          new Set(sources.map((source) => source.versionId)).size ===
            sources.length,
        'Source repeated'
      )
      .optional(),
    // a design operation's base revision (P6-02); never with an item or a
    // source
    design: designRef.optional(),
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
