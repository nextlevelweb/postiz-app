import {
  CLAIM_EVIDENCE_MAX,
  contentPackageItemText,
  GROUNDING_CLAIMS_MAX,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';

// What a provider answered for an AI writing action, checked before the
// operation counts as succeeded. Anything that is not exactly the asked shape
// is INVALID_RESPONSE: nothing is repaired, cut or guessed. The texts are
// returned to the caller and never stored. With source material the answer
// also lists claims, which name blocks by the references of the prompt; the
// caller maps them to the exact blocks it gave and refuses any other

export interface ContentStudioAIThreadProposalItem {
  itemId: string;
  text: string;
}

// A claim exactly as the provider wrote it: untrusted until the caller has
// matched every reference and quote to the source material it gave
export interface ContentStudioAIProposedClaim {
  text: string;
  evidence: Array<{ ref: string; quote: string | null }>;
}

export interface ContentStudioAIGroundedThreadProposalItem
  extends ContentStudioAIThreadProposalItem {
  claims: ContentStudioAIProposedClaim[];
}

// An answer whose claims do not match the source material it was given: the
// operation fails as INVALID_RESPONSE, and the caller can tell it apart
export class ContentStudioAIGroundingError extends ContentStudioAIProviderError {
  constructor() {
    super('INVALID_RESPONSE');
    this.name = 'ContentStudioAIGroundingError';
  }
}

const invalidResponse = () =>
  new ContentStudioAIProviderError('INVALID_RESPONSE');
const groundingInvalid = () => new ContentStudioAIGroundingError();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const hasExactly = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

// The suggested text of one item: valid item text of a draft (line endings
// normalized, at most 10000 characters, no NUL or unpaired surrogate; spacing
// kept as it came, like the editor keeps it) with something besides
// whitespace
export function parseContentStudioAIItemProposal(text: unknown): string {
  const result = contentPackageItemText.safeParse(text);
  if (!result.success || !result.data.trim()) {
    throw invalidResponse();
  }
  return result.data;
}

const parseJsonObject = (raw: unknown) => {
  if (typeof raw !== 'string') {
    throw invalidResponse();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidResponse();
  }
  if (!isPlainObject(parsed)) {
    throw invalidResponse();
  }
  return parsed;
};

// The claims list as written: at most 200 claims, each exactly {text,
// evidence}, evidence 1-20 entries of exactly {ref, quote} with a string
// ref and a string or null quote. Their content is checked by the caller
const parseClaims = (value: unknown): ContentStudioAIProposedClaim[] => {
  if (!Array.isArray(value) || value.length > GROUNDING_CLAIMS_MAX) {
    throw groundingInvalid();
  }
  return value.map((claim: unknown) => {
    if (
      !isPlainObject(claim) ||
      !hasExactly(claim, ['text', 'evidence']) ||
      typeof claim.text !== 'string' ||
      !Array.isArray(claim.evidence) ||
      !claim.evidence.length ||
      claim.evidence.length > CLAIM_EVIDENCE_MAX
    ) {
      throw groundingInvalid();
    }
    return {
      text: claim.text,
      evidence: (claim.evidence as unknown[]).map((entry) => {
        if (
          !isPlainObject(entry) ||
          !hasExactly(entry, ['ref', 'quote']) ||
          typeof entry.ref !== 'string' ||
          (entry.quote !== null && typeof entry.quote !== 'string')
        ) {
          throw groundingInvalid();
        }
        return { ref: entry.ref, quote: entry.quote as string | null };
      }),
    };
  });
};

// The answer to an item action with source material: one JSON object,
// nothing around it, {"text","claims"}
export function parseContentStudioAIGroundedItemProposal(raw: unknown): {
  text: string;
  claims: ContentStudioAIProposedClaim[];
} {
  const parsed = parseJsonObject(raw);
  if (!hasExactly(parsed, ['text', 'claims'])) {
    throw invalidResponse();
  }
  return {
    text: parseContentStudioAIItemProposal(parsed.text),
    claims: parseClaims(parsed.claims),
  };
}

// The answer to generate_thread: one JSON object, nothing around it (no
// Markdown fence, no commentary), {"items":[{"itemId","text"}]} with exactly
// the expected item ids, each once. Returned in the draft's own order,
// whatever order the provider used
export function parseContentStudioAIThreadProposal(
  raw: unknown,
  expectedItemIds: readonly string[]
): ContentStudioAIThreadProposalItem[] {
  return parseThread(raw, expectedItemIds, false).map(({ itemId, text }) => ({
    itemId,
    text,
  }));
}

// The same with source material: every item also has its "claims"
export function parseContentStudioAIGroundedThreadProposal(
  raw: unknown,
  expectedItemIds: readonly string[]
): ContentStudioAIGroundedThreadProposalItem[] {
  return parseThread(raw, expectedItemIds, true);
}

function parseThread(
  raw: unknown,
  expectedItemIds: readonly string[],
  grounded: boolean
): ContentStudioAIGroundedThreadProposalItem[] {
  const parsed = parseJsonObject(raw);
  if (
    !hasExactly(parsed, ['items']) ||
    !Array.isArray(parsed.items) ||
    parsed.items.length !== expectedItemIds.length
  ) {
    throw invalidResponse();
  }

  const items = new Map<string, ContentStudioAIGroundedThreadProposalItem>();
  for (const entry of parsed.items as unknown[]) {
    if (
      !isPlainObject(entry) ||
      !hasExactly(
        entry,
        grounded ? ['itemId', 'text', 'claims'] : ['itemId', 'text']
      ) ||
      typeof entry.itemId !== 'string' ||
      !expectedItemIds.includes(entry.itemId) ||
      items.has(entry.itemId)
    ) {
      throw invalidResponse();
    }
    items.set(entry.itemId, {
      itemId: entry.itemId,
      text: parseContentStudioAIItemProposal(entry.text),
      claims: grounded ? parseClaims(entry.claims) : [],
    });
  }
  return expectedItemIds.map(
    (itemId) => items.get(itemId) as ContentStudioAIGroundedThreadProposalItem
  );
}
