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

// What an operation was about, as ids only: never user text, a prompt, a
// generated result or a credential. Built by the server, never taken from a
// request as it is
const contextV1 = z
  .object({
    v: z.literal(1),
    itemId: z.string().regex(ITEM_ID).optional(),
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
