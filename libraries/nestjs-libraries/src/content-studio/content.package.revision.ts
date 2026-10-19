import {
  ContentPackageClaimV2,
  ContentPackageDraft,
  contentPackageClaims,
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
}): ContentPackageDraft {
  let content: ContentPackageDraft;
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

// What a later review of a revision reads as its claims: exactly the claims
// stored in that verified revision, in their order, as copies. A v1 revision
// has none. Nothing else is consulted: not the draft, a newer revision, an AI
// operation or the current state of a source. Throws
// ContentPackageRevisionIntegrityError like the parse above
export function getReviewableClaimsFromContentPackageRevision(revision: {
  content: string;
  contentHash: string;
  schemaVersion: number;
}): ContentPackageClaimV2[] {
  return contentPackageClaims(
    parseVerifiedContentPackageRevision(revision)
  ).map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((entry) => ({ ...entry })),
  }));
}

// The SHA-256 of one claim's canonical JSON: id, item, text and evidence.
// A claim that changed in any of them hashes differently
export const hashContentPackageClaim = (claim: ContentPackageClaimV2) =>
  sha256Hex(canonicalJson(claim));
