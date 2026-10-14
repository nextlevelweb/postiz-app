import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioExpertiseProfileContentV1,
  EXPERTISE_PROFILE_SCHEMA_VERSION,
  parseContentStudioExpertiseProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile';

// What a revision stores for a parsed expertise profile: its canonical JSON
// text and the SHA-256 of exactly that text. Equal content gives equal text
// and hash
export function storedContentStudioExpertiseProfileContent(
  content: ContentStudioExpertiseProfileContentV1
) {
  const text = canonicalJson(content);
  return {
    schemaVersion: EXPERTISE_PROFILE_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioExpertiseProfileIntegrityError extends Error {
  constructor() {
    super('A stored expertise profile revision failed its integrity check');
    this.name = 'ContentStudioExpertiseProfileIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: a valid profile, in canonical form, matching its hash and schema
// version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioExpertiseProfileRevision(revision: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioExpertiseProfileContentV1 {
  let content: ContentStudioExpertiseProfileContentV1;
  try {
    content = parseContentStudioExpertiseProfileContent(
      JSON.parse(revision.content)
    );
  } catch {
    throw new ContentStudioExpertiseProfileIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJson(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentStudioExpertiseProfileIntegrityError();
  }
  return content;
}
