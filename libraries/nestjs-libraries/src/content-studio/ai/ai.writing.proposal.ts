import { contentPackageItemText } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';

// What a provider answered for an AI writing action, checked before the
// operation counts as succeeded. Anything that is not exactly the asked shape
// is INVALID_RESPONSE: nothing is repaired, cut or guessed. The texts are
// returned to the caller and never stored

export interface ContentStudioAIThreadProposalItem {
  itemId: string;
  text: string;
}

const invalidResponse = () =>
  new ContentStudioAIProviderError('INVALID_RESPONSE');

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

// The answer to generate_thread: one JSON object, nothing around it (no
// Markdown fence, no commentary), {"items":[{"itemId","text"}]} with exactly
// the expected item ids, each once. Returned in the draft's own order,
// whatever order the provider used
export function parseContentStudioAIThreadProposal(
  raw: unknown,
  expectedItemIds: readonly string[]
): ContentStudioAIThreadProposalItem[] {
  if (typeof raw !== 'string') {
    throw invalidResponse();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidResponse();
  }
  if (
    !isPlainObject(parsed) ||
    !hasExactly(parsed, ['items']) ||
    !Array.isArray(parsed.items) ||
    parsed.items.length !== expectedItemIds.length
  ) {
    throw invalidResponse();
  }

  const texts = new Map<string, string>();
  for (const entry of parsed.items as unknown[]) {
    if (
      !isPlainObject(entry) ||
      !hasExactly(entry, ['itemId', 'text']) ||
      typeof entry.itemId !== 'string' ||
      !expectedItemIds.includes(entry.itemId) ||
      texts.has(entry.itemId)
    ) {
      throw invalidResponse();
    }
    texts.set(entry.itemId, parseContentStudioAIItemProposal(entry.text));
  }
  return expectedItemIds.map((itemId) => ({
    itemId,
    text: texts.get(itemId) as string,
  }));
}
