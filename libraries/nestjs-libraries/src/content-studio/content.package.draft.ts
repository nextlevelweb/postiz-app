import { z } from 'zod';

// ContentPackageDraft, the mutable working copy of a Content Studio package.
// Copy is plain text (never HTML) and media are referenced by id only: the
// server resolves paths and builds the composer HTML at handoff.
// v1 is the copy alone. v2 (P3-11) adds grounding: claims the package makes,
// each tied to one thread item and supported by exact blocks of exact,
// immutable source versions. Grounding never changes the copy or what the
// composer gets. Every v1 draft and revision stays v1 and keeps its bytes and
// hash; a draft becomes v2 only when grounding is added to it, and removing
// its claims leaves it v2 (restoring a v1 revision restores v1). The frontend
// imports this file too, so it must not use Node-only modules

// The version a new package starts with
export const CONTENT_PACKAGE_SCHEMA_VERSION = 1;
export const CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION = 2;

export const PACKAGE_NAME_MAX = 200;
export const PROJECT_NAME_MAX = 100;

export const THREAD_ITEMS_MIN = 1;
export const THREAD_ITEMS_MAX = 25;

// Counted in UTF-16 code units (String.length), after line endings are
// normalized, the same way the textarea counts them
export const ITEM_TEXT_MAX = 10_000;
export const ITEM_MEDIA_MAX = 20;

export const PACKAGE_UNIQUE_MEDIA_MAX = 50;
// UTF-8 bytes of the validated draft serialized as JSON, so formatting and
// key order of the request body don't count
export const DRAFT_CANONICAL_MAX_BYTES = 65_536;

const ITEM_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Media ids are uuids today; any safe token up to 64 characters is accepted
// so the shape doesn't need a new version if that changes, while a path, URL
// or anything with dots, slashes or spaces can never pass
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Grounding limits. The draft size limit above still holds for the whole
// draft, grounding included. A claim needs at least one piece of evidence:
// a claim without any is not grounded
export const GROUNDING_CLAIMS_MAX = 200;
export const CLAIM_TEXT_MAX = 2000;
export const CLAIM_EVIDENCE_MAX = 20;
export const EVIDENCE_QUOTE_MAX = 1000;
// distinct source versions in one draft, so checking the evidence reads a
// bounded number of captures
export const GROUNDING_SOURCE_VERSIONS_MAX = 20;

// c_ and a random token, made where the claim is made (the server for AI
// suggestions, the browser for a claim written by hand). Never a position
const CLAIM_ID = /^c_[A-Za-z0-9_-]{8,40}$/;
// source and version ids are Prisma uuid() values
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// the block id rule of Source Content v1 (source.content.ts)
const SOURCE_BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
// version numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;

const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

// A UTF-8 encoder turns an unpaired surrogate into U+FFFD, so stored text,
// byte counts and hashes could silently disagree
const hasLoneSurrogate = (text: string) => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

// The text of one item, as a draft holds it. AI proposals are checked with
// it too, so a suggestion is exactly what the editor could save
export const contentPackageItemText = z
  .string()
  .transform(normalizeLineEndings)
  .pipe(
    z
      .string()
      .max(ITEM_TEXT_MAX)
      .refine((text) => !text.includes('\u0000'), 'NUL character')
      .refine((text) => !hasLoneSurrogate(text), 'Unpaired surrogate')
  );

// Claim text and quotes: the same text rules as an item, never blank
const groundingText = (max: number) =>
  contentPackageItemText.pipe(
    z
      .string()
      .max(max)
      .refine((text) => !!text.trim(), 'Blank text')
  );

// One piece of evidence: one block of one exact source version, named by the
// source, the version (id and number) and the contentHash of its blocks, the
// way an AI operation names the versions it used, plus the block id the
// capture gave it. quote, when there is one, is words of that block exactly.
// No URL, title or source text beyond the quote: the version holds those
const evidenceSchema = z
  .object({
    sourceId: z.string().regex(UUID),
    versionId: z.string().regex(UUID),
    versionNumber: z.number().int().min(1).max(INT4_MAX),
    contentHash: z.string().regex(SHA256_HEX),
    blockId: z.string().regex(SOURCE_BLOCK_ID),
    quote: groundingText(EVIDENCE_QUOTE_MAX).nullable(),
  })
  .strict();

// One claim of one thread item, in the author's words, with its evidence in
// the order given. Line endings are normalized and outer whitespace trimmed
const claimSchema = z
  .object({
    id: z.string().regex(CLAIM_ID),
    threadItemId: z.string().regex(ITEM_ID),
    text: contentPackageItemText.pipe(
      z
        .string()
        .transform((text) => text.trim())
        .pipe(z.string().min(1).max(CLAIM_TEXT_MAX))
    ),
    evidence: z.array(evidenceSchema).min(1).max(CLAIM_EVIDENCE_MAX),
  })
  .strict()
  .superRefine((claim, context) => {
    const blocks = claim.evidence.map(
      (entry) => `${entry.versionId}/${entry.blockId}`
    );
    blocks.forEach((block, index) => {
      if (blocks.indexOf(block) !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index],
          message: 'Duplicate evidence block',
        });
      }
    });
  });

const threadItem = z
  .object({
    id: z.string().regex(ITEM_ID),
    text: contentPackageItemText,
    mediaIds: z.array(z.string().regex(MEDIA_ID)).max(ITEM_MEDIA_MAX),
  })
  .strict()
  .superRefine((item, context) => {
    item.mediaIds.forEach((id, index) => {
      if (item.mediaIds.indexOf(id) !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mediaIds', index],
          message: 'Duplicate media id in item',
        });
      }
    });
  });

const copySchema = z
  .object({
    global: z
      .object({
        thread: z.array(threadItem).min(THREAD_ITEMS_MIN).max(THREAD_ITEMS_MAX),
      })
      .strict(),
  })
  .strict();

// The thread rules every version shares
const refineThread = (
  thread: Array<z.output<typeof threadItem>>,
  context: z.RefinementCtx
) => {
  const ids = thread.map((item) => item.id);
  ids.forEach((id, index) => {
    if (ids.indexOf(id) !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['copy', 'global', 'thread', index, 'id'],
        message: 'Duplicate item id',
      });
    }
  });
  // the same media may be reused in several items
  if (
    new Set(thread.flatMap((item) => item.mediaIds)).size >
    PACKAGE_UNIQUE_MEDIA_MAX
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['copy', 'global', 'thread'],
      message: 'Too many distinct media',
    });
  }
};

const draftSchemaV1 = z
  .object({
    schemaVersion: z.literal(CONTENT_PACKAGE_SCHEMA_VERSION),
    copy: copySchema,
  })
  .strict()
  .superRefine((draft, context) =>
    refineThread(draft.copy.global.thread, context)
  );

// Claims in the author's order. Every claim belongs to an item of this
// draft, ids are unique, and one version is always named the same way
const draftSchemaV2 = z
  .object({
    schemaVersion: z.literal(CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION),
    copy: copySchema,
    grounding: z
      .object({
        claims: z.array(claimSchema).max(GROUNDING_CLAIMS_MAX),
      })
      .strict(),
  })
  .strict()
  .superRefine((draft, context) => {
    refineThread(draft.copy.global.thread, context);
    const itemIds = new Set(draft.copy.global.thread.map((item) => item.id));
    const claimIds = new Set<string>();
    const versions = new Map<string, string>();
    draft.grounding.claims.forEach((claim, index) => {
      const path = ['grounding', 'claims', index];
      if (claimIds.has(claim.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'id'],
          message: 'Duplicate claim id',
        });
      }
      claimIds.add(claim.id);
      if (!itemIds.has(claim.threadItemId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'threadItemId'],
          message: 'Unknown thread item',
        });
      }
      claim.evidence.forEach((entry, evidenceIndex) => {
        const identity = `${entry.sourceId}/${entry.versionNumber}/${entry.contentHash}`;
        if ((versions.get(entry.versionId) ?? identity) !== identity) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'evidence', evidenceIndex],
            message: 'Source version named two ways',
          });
        }
        versions.set(entry.versionId, identity);
      });
    });
    if (versions.size > GROUNDING_SOURCE_VERSIONS_MAX) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grounding', 'claims'],
        message: 'Too many distinct source versions',
      });
    }
  });

export type ContentPackageDraftV1 = z.output<typeof draftSchemaV1>;
export type ContentPackageDraftV2 = z.output<typeof draftSchemaV2>;
export type ContentPackageDraft = ContentPackageDraftV1 | ContentPackageDraftV2;
export type ContentPackageThreadItemV1 =
  ContentPackageDraftV1['copy']['global']['thread'][number];
export type ContentPackageClaimV2 =
  ContentPackageDraftV2['grounding']['claims'][number];
export type ContentPackageClaimEvidenceV2 =
  ContentPackageClaimV2['evidence'][number];

export type ContentPackageDraftErrorCode =
  | 'INVALID_DRAFT'
  | 'DRAFT_TOO_LARGE'
  | 'EMPTY_ITEM';

export interface ContentPackageDraftIssue {
  path: Array<string | number>;
  code: string;
}

const DRAFT_ERROR_MESSAGES: Record<ContentPackageDraftErrorCode, string> = {
  INVALID_DRAFT: 'The content package draft does not match schema version 1',
  DRAFT_TOO_LARGE: 'The content package draft is larger than allowed',
  EMPTY_ITEM: 'Every thread item needs text or media',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value, which may be user text
export class ContentPackageDraftError extends Error {
  readonly code: ContentPackageDraftErrorCode;
  readonly itemIndex?: number;
  readonly issues?: ContentPackageDraftIssue[];

  constructor(
    code: ContentPackageDraftErrorCode,
    details: { itemIndex?: number; issues?: ContentPackageDraftIssue[] } = {}
  ) {
    super(DRAFT_ERROR_MESSAGES[code]);
    this.name = 'ContentPackageDraftError';
    this.code = code;
    this.itemIndex = details.itemIndex;
    this.issues = details.issues;
  }
}

const utf8ByteLength = (text: string) => new TextEncoder().encode(text).length;

// Validates and normalizes a draft (from a request or read back from the
// database) of either version, as that version: a v1 draft is never turned
// into v2 here. The result has the schema's key order and no unknown keys, so
// its JSON size is the same however the input was written
export function parseContentPackageDraft(input: unknown): ContentPackageDraft {
  const version = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
  const result = (
    version === CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION
      ? draftSchemaV2
      : draftSchemaV1
  ).safeParse(input);
  if (!result.success) {
    throw new ContentPackageDraftError('INVALID_DRAFT', {
      issues: result.error.issues.map(({ path, code }) => ({ path, code })),
    });
  }
  if (utf8ByteLength(JSON.stringify(result.data)) > DRAFT_CANONICAL_MAX_BYTES) {
    throw new ContentPackageDraftError('DRAFT_TOO_LARGE');
  }
  return result.data;
}

// The draft of a new package: one empty main item. The id is passed in so the
// server can make it with a secure random source
export const emptyContentPackageDraft = (itemId: string) =>
  parseContentPackageDraft({
    schemaVersion: CONTENT_PACKAGE_SCHEMA_VERSION,
    copy: { global: { thread: [{ id: itemId, text: '', mediaIds: [] }] } },
  });

// Stricter than a valid draft: what becomes a revision or goes to the
// composer must have something in every item. Provider limits are left to the
// composer and publishing
export function assertContentPackagePublishable(draft: ContentPackageDraft) {
  draft.copy.global.thread.forEach((item, itemIndex) => {
    if (!item.text.trim() && !item.mediaIds.length) {
      throw new ContentPackageDraftError('EMPTY_ITEM', { itemIndex });
    }
  });
}

// The claims of a draft or revision: none for v1, which never had any
export const contentPackageClaims = (
  draft: ContentPackageDraft
): readonly ContentPackageClaimV2[] =>
  draft.schemaVersion === CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION
    ? draft.grounding.claims
    : [];

const copyOf = (draft: ContentPackageDraft) => ({
  global: {
    thread: draft.copy.global.thread.map((item) => ({
      id: item.id,
      text: item.text,
      mediaIds: [...item.mediaIds],
    })),
  },
});

const claimCopy = (claim: ContentPackageClaimV2): ContentPackageClaimV2 => ({
  id: claim.id,
  threadItemId: claim.threadItemId,
  text: claim.text,
  evidence: claim.evidence.map((entry) => ({
    sourceId: entry.sourceId,
    versionId: entry.versionId,
    versionNumber: entry.versionNumber,
    contentHash: entry.contentHash,
    blockId: entry.blockId,
    quote: entry.quote,
  })),
});

// The one upgrade: a v1 draft becomes v2 with exactly its copy and no
// claims; a v2 draft is copied as it is. A new object either way, sharing
// nothing with the input, in the schema's key order. Used where grounding is
// added, never when a draft or revision is only read
export const upgradeContentPackageDraftToV2 = (
  draft: ContentPackageDraft
): ContentPackageDraftV2 => ({
  schemaVersion: CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION,
  copy: copyOf(draft),
  grounding: { claims: contentPackageClaims(draft).map(claimCopy) },
});

// The draft without the claims of these items: what an edit, a replaced
// text or a removed item leaves. A v1 draft has none and is returned as it is
export const withoutContentPackageItemClaims = (
  draft: ContentPackageDraft,
  itemIds: readonly string[]
): ContentPackageDraft => {
  if (draft.schemaVersion !== CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION) {
    return draft;
  }
  const scope = new Set(itemIds);
  if (!draft.grounding.claims.some((claim) => scope.has(claim.threadItemId))) {
    return draft;
  }
  return {
    ...draft,
    grounding: {
      claims: draft.grounding.claims.filter(
        (claim) => !scope.has(claim.threadItemId)
      ),
    },
  };
};

// Replaces the claims of these items with the given ones (after the claims
// of the other items, which are kept as they are). Without new claims a v1
// draft stays v1; with them it becomes v2
export const replaceContentPackageItemClaims = (
  draft: ContentPackageDraft,
  itemIds: readonly string[],
  claims: readonly ContentPackageClaimV2[]
): ContentPackageDraft => {
  const kept = withoutContentPackageItemClaims(draft, itemIds);
  if (!claims.length) {
    return kept;
  }
  const upgraded = upgradeContentPackageDraftToV2(kept);
  return {
    ...upgraded,
    grounding: {
      claims: [...upgraded.grounding.claims, ...claims.map(claimCopy)],
    },
  };
};

// One claim written or edited by hand: replaces the claim with its id where
// it is, or comes after the others. The draft becomes v2 if it was not
export const withContentPackageClaim = (
  draft: ContentPackageDraft,
  claim: ContentPackageClaimV2
): ContentPackageDraftV2 => {
  const upgraded = upgradeContentPackageDraftToV2(draft);
  const claims = upgraded.grounding.claims;
  const index = claims.findIndex((entry) => entry.id === claim.id);
  return {
    ...upgraded,
    grounding: {
      claims:
        index < 0
          ? [...claims, claimCopy(claim)]
          : claims.map((entry, at) =>
              at === index ? claimCopy(claim) : entry
            ),
    },
  };
};

export const withoutContentPackageClaim = (
  draft: ContentPackageDraft,
  claimId: string
): ContentPackageDraft =>
  draft.schemaVersion === CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION &&
  draft.grounding.claims.some((claim) => claim.id === claimId)
    ? {
        ...draft,
        grounding: {
          claims: draft.grounding.claims.filter(
            (claim) => claim.id !== claimId
          ),
        },
      }
    : draft;

// The claims of `next` that come from `saved` (the same id) although their
// item is another one or its text changed: evidence found for one text
// never carries over to a different text. Only a new claim (a new id) can
// ground changed text
export const staleContentPackageClaimIds = (
  saved: ContentPackageDraft,
  next: ContentPackageDraft
) => {
  const savedClaims = new Map(
    contentPackageClaims(saved).map((claim) => [claim.id, claim])
  );
  const textOf = (draft: ContentPackageDraft, itemId: string) =>
    draft.copy.global.thread.find((item) => item.id === itemId)?.text;
  return contentPackageClaims(next)
    .filter((claim) => {
      const before = savedClaims.get(claim.id);
      return (
        !!before &&
        (before.threadItemId !== claim.threadItemId ||
          textOf(saved, before.threadItemId) !==
            textOf(next, claim.threadItemId))
      );
    })
    .map((claim) => claim.id);
};
