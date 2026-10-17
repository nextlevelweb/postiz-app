import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { ContentStudioDesignDocumentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { ContentStudioDesignIntegrityError } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import {
  ContentStudioDesignTemplateGuidanceV1,
  DESIGN_TEMPLATE_GUIDANCE_SCHEMA_VERSION,
  parseContentStudioDesignTemplateGuidance,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';

// What a template revision stores for parsed guidance: its canonical JSON
// text (whole numbers only) and the SHA-256 of exactly that text, apart from
// the document's own content and hash. Keys are sorted; slots keep their
// order, so reordering the fields is other guidance with another hash. No
// guidance is three nulls
export function storedContentStudioDesignTemplateGuidance(
  guidance: ContentStudioDesignTemplateGuidanceV1 | null
) {
  if (!guidance) {
    return { guidanceSchemaVersion: null, guidance: null, guidanceHash: null };
  }
  const text = canonicalJson(guidance);
  return {
    guidanceSchemaVersion: DESIGN_TEMPLATE_GUIDANCE_SCHEMA_VERSION,
    guidance: text,
    guidanceHash: sha256Hex(text),
  };
}

// Reads stored guidance back and proves it is still exactly what was written
// for this document: all three columns or none, valid for the document, in
// canonical form, matching its hash and schema version. Anything else throws
// the design integrity error; nothing is normalized or repaired
export function parseVerifiedContentStudioDesignTemplateGuidance(
  revision: {
    guidanceSchemaVersion: number | null;
    guidance: string | null;
    guidanceHash: string | null;
  },
  document: ContentStudioDesignDocumentV1
): ContentStudioDesignTemplateGuidanceV1 | null {
  const stored = [
    revision.guidanceSchemaVersion,
    revision.guidance,
    revision.guidanceHash,
  ];
  if (stored.every((value) => value === null)) {
    return null;
  }
  if (stored.some((value) => value === null)) {
    throw new ContentStudioDesignIntegrityError();
  }
  let guidance: ContentStudioDesignTemplateGuidanceV1;
  try {
    guidance = parseContentStudioDesignTemplateGuidance(
      JSON.parse(revision.guidance as string),
      document
    );
  } catch {
    throw new ContentStudioDesignIntegrityError();
  }
  if (
    guidance.schemaVersion !== revision.guidanceSchemaVersion ||
    canonicalJson(guidance) !== revision.guidance ||
    sha256Hex(revision.guidance as string) !== revision.guidanceHash
  ) {
    throw new ContentStudioDesignIntegrityError();
  }
  return guidance;
}
