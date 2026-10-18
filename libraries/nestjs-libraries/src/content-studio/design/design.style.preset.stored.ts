import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioDesignStylePresetContentV1,
  DESIGN_STYLE_PRESET_SCHEMA_VERSION,
  parseContentStudioDesignStylePresetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';

// What a style preset row stores for parsed content: its canonical JSON text
// (line heights and opacity are fractional, so finite numbers are allowed)
// and the SHA-256 of exactly that text. Keys are sorted, so the same style
// sent in another key order is the same text and hash
export function storedContentStudioDesignStylePreset(
  content: ContentStudioDesignStylePresetContentV1
) {
  const text = canonicalJsonWithFiniteNumbers(content);
  return {
    schemaVersion: DESIGN_STYLE_PRESET_SCHEMA_VERSION,
    kind: content.kind,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored style must never end up in an error
export class ContentStudioDesignStylePresetIntegrityError extends Error {
  constructor() {
    super('A stored style preset failed its integrity check');
    this.name = 'ContentStudioDesignStylePresetIntegrityError';
  }
}

// Reads a stored preset back and proves it is still exactly what was
// written: valid Style Preset v1 of its row's kind, in canonical form,
// matching its hash and schema version. Anything else throws; nothing is
// normalized or repaired
export function parseVerifiedContentStudioDesignStylePreset(row: {
  kind: string;
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioDesignStylePresetContentV1 {
  let content: ContentStudioDesignStylePresetContentV1;
  try {
    content = parseContentStudioDesignStylePresetContent(
      JSON.parse(row.content)
    );
  } catch {
    throw new ContentStudioDesignStylePresetIntegrityError();
  }
  if (
    content.schemaVersion !== row.schemaVersion ||
    content.kind !== row.kind ||
    canonicalJsonWithFiniteNumbers(content) !== row.content ||
    sha256Hex(row.content) !== row.contentHash
  ) {
    throw new ContentStudioDesignStylePresetIntegrityError();
  }
  return content;
}
