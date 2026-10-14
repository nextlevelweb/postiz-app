import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioWritingProfileContentV1,
  parseContentStudioWritingProfileContent,
  WRITING_PROFILE_SCHEMA_VERSION,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// What a revision stores for parsed Writing DNA: its canonical JSON text and
// the SHA-256 of exactly that text. Equal content gives equal text and hash
export function storedContentStudioWritingProfileContent(
  content: ContentStudioWritingProfileContentV1
) {
  const text = canonicalJson(content);
  return {
    schemaVersion: WRITING_PROFILE_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioWritingProfileIntegrityError extends Error {
  constructor() {
    super('A stored writing profile revision failed its integrity check');
    this.name = 'ContentStudioWritingProfileIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: valid Writing DNA, in canonical form, matching its hash and schema
// version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioWritingProfileRevision(revision: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioWritingProfileContentV1 {
  let content: ContentStudioWritingProfileContentV1;
  try {
    content = parseContentStudioWritingProfileContent(
      JSON.parse(revision.content)
    );
  } catch {
    throw new ContentStudioWritingProfileIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJson(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentStudioWritingProfileIntegrityError();
  }
  return content;
}
