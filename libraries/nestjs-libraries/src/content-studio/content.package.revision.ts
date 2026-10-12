import {
  ContentPackageDraftV1,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// A fixed message only: the stored content must never end up in an error
export class ContentPackageRevisionIntegrityError extends Error {
  constructor() {
    super('A stored content package revision failed its integrity check');
    this.name = 'ContentPackageRevisionIntegrityError';
  }
}

// Reads a stored revision back and proves it is still exactly what was
// written: a valid draft, in canonical form, matching its hash and schema
// version. Anything else throws; nothing is normalized or repaired
export function parseVerifiedContentPackageRevision(revision: {
  content: string;
  contentHash: string;
  schemaVersion: number;
}): ContentPackageDraftV1 {
  let content: ContentPackageDraftV1;
  try {
    content = parseContentPackageDraft(JSON.parse(revision.content));
  } catch {
    throw new ContentPackageRevisionIntegrityError();
  }
  if (
    content.schemaVersion !== revision.schemaVersion ||
    canonicalJson(content) !== revision.content ||
    sha256Hex(revision.content) !== revision.contentHash
  ) {
    throw new ContentPackageRevisionIntegrityError();
  }
  return content;
}
