import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioDesignDocumentV1,
  DESIGN_DOCUMENT_SCHEMA_VERSION,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// What a revision stores for a parsed design document: its canonical JSON
// text (geometry is fractional, so finite numbers are allowed) and the
// SHA-256 of exactly that text. Keys are sorted; pages and layers keep their
// order, so moving a page or a layer is another design with another hash, and
// so is another Brand Kit reference
export function storedContentStudioDesignDocument(
  content: ContentStudioDesignDocumentV1
) {
  const text = canonicalJsonWithFiniteNumbers(content);
  return {
    schemaVersion: DESIGN_DOCUMENT_SCHEMA_VERSION,
    content: text,
    contentHash: sha256Hex(text),
  };
}

// A fixed message only: the stored content must never end up in an error
export class ContentStudioDesignIntegrityError extends Error {
  constructor() {
    super('A stored design revision failed its integrity check');
    this.name = 'ContentStudioDesignIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: a valid document, in canonical form, matching its hash and schema
// version. It does not look at the Brand Kit it names: a design stays
// readable on its own; whoever renders it loads that revision. Anything else
// throws; nothing is normalized or repaired
export function parseVerifiedContentStudioDesignRevision(revision: {
  schemaVersion: number;
  content: string;
  contentHash: string;
}): ContentStudioDesignDocumentV1 {
  let content: ContentStudioDesignDocumentV1;
  try {
    content = parseContentStudioDesignDocument(JSON.parse(revision.content));
  } catch {
    throw new ContentStudioDesignIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJsonWithFiniteNumbers(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentStudioDesignIntegrityError();
  }
  return content;
}
