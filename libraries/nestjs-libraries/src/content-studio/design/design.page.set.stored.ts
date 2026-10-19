import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioDesignPageSetContentV1,
  DESIGN_PAGE_SET_SCHEMA_VERSION,
  parseContentStudioDesignPageSetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';

// What a page set row stores for parsed content: its canonical JSON
// text and the SHA-256 of exactly that text. Keys are sorted; pages keep
// their order, so another order is another page set with another hash
export function storedContentStudioDesignPageSet(
  content: ContentStudioDesignPageSetContentV1
) {
  const text = canonicalJsonWithFiniteNumbers(content);
  return {
    schemaVersion: DESIGN_PAGE_SET_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored pages must never end up in an error
export class ContentStudioDesignPageSetIntegrityError extends Error {
  constructor() {
    super('A stored page set failed its integrity check');
    this.name = 'ContentStudioDesignPageSetIntegrityError';
  }
}

// Reads a stored pattern back and proves it is still exactly what was
// written: valid Page Set v1, in canonical form, matching its hash and
// schema version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioDesignPageSet(row: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioDesignPageSetContentV1 {
  let content: ContentStudioDesignPageSetContentV1;
  try {
    content = parseContentStudioDesignPageSetContent(JSON.parse(row.content));
  } catch {
    throw new ContentStudioDesignPageSetIntegrityError();
  }
  if (
    content.schemaVersion !== row.schemaVersion ||
    canonicalJsonWithFiniteNumbers(content) !== row.content ||
    sha256Hex(row.content) !== row.contentHash
  ) {
    throw new ContentStudioDesignPageSetIntegrityError();
  }
  return content;
}
