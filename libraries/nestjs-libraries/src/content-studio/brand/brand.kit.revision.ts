import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  BRAND_KIT_SCHEMA_VERSION,
  ContentStudioBrandKitContentV1,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';

// What a revision stores for a parsed Brand Kit: its canonical JSON text and
// the SHA-256 of exactly that text. Keys are sorted, arrays keep their order:
// reordering tokens or list entries is another kit with another hash
export function storedContentStudioBrandKitContent(
  content: ContentStudioBrandKitContentV1
) {
  const text = canonicalJson(content);
  return {
    schemaVersion: BRAND_KIT_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioBrandKitIntegrityError extends Error {
  constructor() {
    super('A stored Brand Kit revision failed its integrity check');
    this.name = 'ContentStudioBrandKitIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: a valid kit, in canonical form, matching its hash and schema
// version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioBrandKitRevision(revision: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioBrandKitContentV1 {
  let content: ContentStudioBrandKitContentV1;
  try {
    content = parseContentStudioBrandKitContent(JSON.parse(revision.content));
  } catch {
    throw new ContentStudioBrandKitIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJson(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentStudioBrandKitIntegrityError();
  }
  return content;
}
