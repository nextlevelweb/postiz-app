import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioAudienceProfileContentV1,
  AUDIENCE_PROFILE_SCHEMA_VERSION,
  parseContentStudioAudienceProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';

// What a revision stores for a parsed audience profile: its canonical JSON
// text and the SHA-256 of exactly that text. Equal content gives equal text
// and hash
export function storedContentStudioAudienceProfileContent(
  content: ContentStudioAudienceProfileContentV1
) {
  const text = canonicalJson(content);
  return {
    schemaVersion: AUDIENCE_PROFILE_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioAudienceProfileIntegrityError extends Error {
  constructor() {
    super('A stored audience profile revision failed its integrity check');
    this.name = 'ContentStudioAudienceProfileIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: a valid profile, in canonical form, matching its hash and schema
// version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioAudienceProfileRevision(revision: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioAudienceProfileContentV1 {
  let content: ContentStudioAudienceProfileContentV1;
  try {
    content = parseContentStudioAudienceProfileContent(
      JSON.parse(revision.content)
    );
  } catch {
    throw new ContentStudioAudienceProfileIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJson(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentStudioAudienceProfileIntegrityError();
  }
  return content;
}
