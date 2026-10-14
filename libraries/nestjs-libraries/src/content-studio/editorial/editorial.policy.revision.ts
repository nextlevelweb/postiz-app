import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioEditorialPolicyContentV1,
  EDITORIAL_POLICY_SCHEMA_VERSION,
  parseContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';

// What a revision stores for a parsed editorial policy: its canonical JSON
// text and the SHA-256 of exactly that text. Equal content gives equal text
// and hash
export function storedContentStudioEditorialPolicyContent(
  content: ContentStudioEditorialPolicyContentV1
) {
  const text = canonicalJson(content);
  return {
    schemaVersion: EDITORIAL_POLICY_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioEditorialPolicyIntegrityError extends Error {
  constructor() {
    super('A stored editorial policy revision failed its integrity check');
    this.name = 'ContentStudioEditorialPolicyIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: a valid policy, in canonical form, matching its hash and schema
// version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioEditorialPolicyRevision(revision: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioEditorialPolicyContentV1 {
  let content: ContentStudioEditorialPolicyContentV1;
  try {
    content = parseContentStudioEditorialPolicyContent(
      JSON.parse(revision.content)
    );
  } catch {
    throw new ContentStudioEditorialPolicyIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJson(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentStudioEditorialPolicyIntegrityError();
  }
  return content;
}
