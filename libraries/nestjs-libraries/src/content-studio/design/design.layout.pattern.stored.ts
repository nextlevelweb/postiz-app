import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioDesignLayoutPatternContentV1,
  DESIGN_LAYOUT_PATTERN_SCHEMA_VERSION,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';

// What a layout pattern row stores for parsed content: its canonical JSON
// text (geometry is fractional, so finite numbers are allowed) and the
// SHA-256 of exactly that text. Keys are sorted; layers keep their order,
// so another stacking is another pattern with another hash
export function storedContentStudioDesignLayoutPattern(
  content: ContentStudioDesignLayoutPatternContentV1
) {
  const text = canonicalJsonWithFiniteNumbers(content);
  return {
    schemaVersion: DESIGN_LAYOUT_PATTERN_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored layers must never end up in an error
export class ContentStudioDesignLayoutPatternIntegrityError extends Error {
  constructor() {
    super('A stored layout pattern failed its integrity check');
    this.name = 'ContentStudioDesignLayoutPatternIntegrityError';
  }
}

// Reads a stored pattern back and proves it is still exactly what was
// written: valid Layout Pattern v1, in canonical form, matching its hash and
// schema version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentStudioDesignLayoutPattern(row: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioDesignLayoutPatternContentV1 {
  let content: ContentStudioDesignLayoutPatternContentV1;
  try {
    content = parseContentStudioDesignLayoutPatternContent(
      JSON.parse(row.content)
    );
  } catch {
    throw new ContentStudioDesignLayoutPatternIntegrityError();
  }
  if (
    content.schemaVersion !== row.schemaVersion ||
    canonicalJsonWithFiniteNumbers(content) !== row.content ||
    sha256Hex(row.content) !== row.contentHash
  ) {
    throw new ContentStudioDesignLayoutPatternIntegrityError();
  }
  return content;
}
