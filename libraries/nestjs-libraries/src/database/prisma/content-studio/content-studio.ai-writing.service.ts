import { HttpException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import {
  ContentStudioAIExecutionInput,
  ContentStudioAIExecutionService,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import {
  ContentStudioAIExecutionError,
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIProviderErrorCode,
  ContentStudioAITextResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  CONTENT_STUDIO_AI_MAX_SOURCES,
  ContentStudioAIContextProfileKind,
  ContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  AI_WRITING_PROMPT_MAX_BYTES,
  buildContentStudioAIWritingPrompt,
  CONTENT_STUDIO_AI_SOURCE_CONTEXT_MAX_BYTES,
  ContentStudioAIItemOperation,
  ContentStudioAIWritingContext,
  ContentStudioAIWritingSource,
  ContentStudioAIWritingTask,
  contentStudioAISourceBlockRef,
  contentStudioAISourceContextBytes,
  contentStudioAIWritingPromptBytes,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.writing.prompt';
import {
  ContentStudioAIGroundingError,
  ContentStudioAIProposedClaim,
  ContentStudioAIThreadProposalItem,
  parseContentStudioAIGroundedItemProposal,
  parseContentStudioAIGroundedThreadProposal,
  parseContentStudioAIItemProposal,
  parseContentStudioAIThreadProposal,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.writing.proposal';
import {
  ContentPackageClaimV2,
  ContentPackageDraft,
  parseContentPackageDraft,
  replaceContentPackageItemClaims,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { ContentStudioSourceBlock } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { parseVerifiedContentStudioWritingProfileRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile.revision';
import { parseVerifiedContentStudioEditorialPolicyRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';
import { parseVerifiedContentStudioAudienceProfileRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';
import { parseVerifiedContentStudioExpertiseProfileRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile.revision';
import { parseVerifiedContentStudioSourceVersion } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import {
  AI_WRITING_INSTRUCTION_MAX,
  ContentStudioAIWritingItemOperation,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-writing.dto';

// Fixed messages only: never a prompt, an instruction, draft, profile or
// source text, a source name or title, a provider message or an id. Nothing
// here answers 401, 402 or 406, which the app treats as session or billing
// problems
const fail = (status: number, code: string, msg: string) =>
  new HttpException({ msg, code }, status);

const invalidRequest = () =>
  fail(400, 'CS_INVALID_REQUEST', 'The Content Studio request is invalid');
const itemTextRequired = () =>
  fail(
    400,
    'CS_INVALID_REQUEST',
    'This AI action requires existing item text.'
  );
const toneRequired = () =>
  fail(400, 'CS_INVALID_REQUEST', 'Changing the tone needs a tone.');
const packageNotFound = () =>
  fail(404, 'CS_NOT_FOUND', 'Content Studio item not found');
const itemNotFound = () => fail(404, 'CS_NOT_FOUND', 'Content item not found.');
const packageArchived = () =>
  fail(409, 'CS_PACKAGE_ARCHIVED', 'This package is archived');
const draftConflict = () =>
  fail(
    409,
    'CS_DRAFT_VERSION_CONFLICT',
    'This Content Studio draft has changed'
  );
const storedDraftInvalid = () =>
  fail(
    500,
    'CS_STORED_DRAFT_INVALID',
    'Stored Content Studio draft is invalid'
  );
const contextNotFound = () =>
  fail(
    400,
    'CS_AI_CONTEXT_NOT_FOUND',
    'The selected AI context is not available.'
  );
const contextArchived = () =>
  fail(
    409,
    'CS_AI_CONTEXT_ARCHIVED',
    'A selected AI context profile is archived.'
  );
const contextIntegrityError = () =>
  fail(
    500,
    'CS_AI_CONTEXT_INTEGRITY_ERROR',
    'Selected AI context could not be verified.'
  );
const contextTooLarge = () =>
  fail(400, 'CS_AI_CONTEXT_TOO_LARGE', 'The selected AI context is too large.');
// missing and of another organization alike
const sourceNotFound = () =>
  fail(
    400,
    'CS_AI_SOURCE_NOT_FOUND',
    'A selected source is no longer available.'
  );
const sourceNotReady = () =>
  fail(
    400,
    'CS_AI_SOURCE_NOT_READY',
    'A selected source has not been ingested yet.'
  );
const sourceArchived = () =>
  fail(409, 'CS_AI_SOURCE_ARCHIVED', 'A selected source is archived.');
const sourceContextTooLarge = () =>
  fail(
    400,
    'CS_AI_SOURCE_CONTEXT_TOO_LARGE',
    'The selected source context is too large.'
  );
// The suggestion named source material that was not given, or quoted words
// its block does not hold: refused as a whole, never partly kept
const groundingInvalid = () =>
  fail(
    502,
    'CS_AI_GROUNDING_INVALID',
    'The AI suggestion cited source material that does not match the selected sources.'
  );
const sourceIntegrityError = () =>
  fail(
    500,
    'CS_AI_SOURCE_INTEGRITY_ERROR',
    'Selected source context could not be verified.'
  );

const RESOLUTION_FAILURES: Record<
  ContentStudioAIResolutionError['code'],
  () => HttpException
> = {
  // missing, archived or of another organization alike
  NOT_FOUND: () =>
    fail(
      400,
      'CS_AI_CONNECTION_REQUIRED',
      'Select an available AI connection.'
    ),
  DISABLED: () =>
    fail(409, 'CS_AI_CONNECTION_DISABLED', 'This AI connection is disabled.'),
  CREDENTIAL_INVALID: () =>
    fail(
      409,
      'CS_AI_CONNECTION_CREDENTIAL_INVALID',
      'This AI connection credential cannot be read. Replace the credential and try again.'
    ),
  SECRET_STORE_UNAVAILABLE: () =>
    fail(
      503,
      'CS_AI_SECRET_STORE_UNAVAILABLE',
      'AI credential storage is not available.'
    ),
  PROVIDER_UNSUPPORTED: () =>
    fail(
      400,
      'CS_AI_PROVIDER_UNSUPPORTED',
      'This AI provider is not supported.'
    ),
};

const EXECUTION_FAILURES: Record<
  ContentStudioAIExecutionError['code'],
  () => HttpException
> = {
  INVALID_INPUT: invalidRequest,
  PACKAGE_NOT_FOUND: packageNotFound,
  PACKAGE_ARCHIVED: packageArchived,
  DRAFT_VERSION_CONFLICT: draftConflict,
  MODEL_UNSUPPORTED: () =>
    fail(
      400,
      'CS_AI_MODEL_UNSUPPORTED',
      'This AI model is not supported for this connection.'
    ),
  PERSISTENCE_FAILED: () =>
    fail(
      500,
      'CS_AI_OPERATION_FAILED',
      'The AI operation could not be recorded.'
    ),
};

// One Content Studio code per normalized provider code
const PROVIDER_FAILURES: Record<
  ContentStudioAIProviderErrorCode,
  [number, string, string]
> = {
  AUTH_FAILED: [
    502,
    'CS_AI_AUTH_FAILED',
    'The AI provider did not accept the API key of this connection.',
  ],
  QUOTA_EXCEEDED: [
    502,
    'CS_AI_QUOTA_EXCEEDED',
    'The AI provider account has no quota or credit left.',
  ],
  RATE_LIMITED: [
    429,
    'CS_AI_RATE_LIMITED',
    'The AI provider is rate limiting this connection.',
  ],
  PROVIDER_UNAVAILABLE: [
    503,
    'CS_AI_PROVIDER_UNAVAILABLE',
    'The AI provider is not available.',
  ],
  TIMEOUT: [504, 'CS_AI_TIMEOUT', 'The AI provider did not answer in time.'],
  MODEL_UNAVAILABLE: [
    502,
    'CS_AI_MODEL_UNAVAILABLE',
    'The AI model is not available.',
  ],
  REQUEST_REJECTED: [
    502,
    'CS_AI_REQUEST_REJECTED',
    'The AI provider rejected the request.',
  ],
  CONTENT_REJECTED: [
    422,
    'CS_AI_CONTENT_REJECTED',
    'The AI provider refused the content.',
  ],
  INVALID_RESPONSE: [
    502,
    'CS_AI_INVALID_RESPONSE',
    'The AI provider answered with an unexpected response.',
  ],
};

// Shared with Design Creative AI (P6-02), which maps its connection,
// execution and provider failures to the same codes
export const fromAIError = (err: unknown) => {
  if (err instanceof ContentStudioAIGroundingError) {
    return groundingInvalid();
  }
  if (err instanceof ContentStudioAIExecutionError) {
    return EXECUTION_FAILURES[err.code]();
  }
  if (err instanceof ContentStudioAIResolutionError) {
    return RESOLUTION_FAILURES[err.code]();
  }
  if (err instanceof ContentStudioAIProviderError) {
    const [status, code, msg] = PROVIDER_FAILURES[err.code];
    return fail(status, code, msg);
  }
  return err;
};

// Package, connection, profile, revision and source ids are Prisma uuid()
// values
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// draft versions are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
const MODEL_ID_MAX = 128;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ITEM_OPERATIONS: ContentStudioAIWritingItemOperation[] = [
  'generate_item',
  'rewrite_item',
  'shorten_item',
  'expand_item',
  'change_tone',
];
// generate_item may fill an empty item; the others work on its text
const NEEDS_ITEM_TEXT: ContentStudioAIItemOperation[] = [
  'rewrite_item',
  'shorten_item',
  'expand_item',
  'change_tone',
];
// enough for one item of 10000 characters, and for a whole thread up to the
// draft size limit
const ITEM_MAX_OUTPUT_TOKENS = 4096;
const THREAD_MAX_OUTPUT_TOKENS = 16_384;

// What the user chose, as the controller passes it on
export interface ContentStudioAIWritingSelection {
  connectionId: unknown;
  model: unknown;
  baseDraftVersion: unknown;
  writingProfileId?: unknown;
  editorialPolicy?: unknown;
  audienceProfileId?: unknown;
  expertiseProfileId?: unknown;
  sourceIds?: unknown;
  instruction?: unknown;
}

interface Selection {
  connectionId: string;
  model: string;
  baseDraftVersion: number;
  writingProfileId: string | null;
  editorialPolicy: boolean;
  audienceProfileId: string | null;
  expertiseProfileId: string | null;
  sourceIds: string[];
  instruction: string | null;
}

interface StoredRevision {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  content: string;
  contentHash: string;
}

interface ProfileSource {
  getProfileForOrganization(
    organizationId: string,
    id: string
  ): Promise<{
    id: string;
    latestRevisionNumber: number;
    archivedAt: Date | null;
  } | null>;
  getRevisionByNumber(
    organizationId: string,
    profileId: string,
    revisionNumber: number
  ): Promise<StoredRevision | null>;
}

type ProfileRef = NonNullable<
  ContentStudioAIOperationContext['profiles']
>[number];

// A selected source at the version this run uses. Never stored or answered
// as a whole: the operation keeps the ids and contentHash, the proposal adds
// the name and title
interface ResolvedSource extends ContentStudioAIWritingSource {
  sourceId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
}

// Which exact source capture a suggestion was written from. Never the
// blocks, the URLs, the fetch provenance or sourceHash: those stay with the
// source version
const toProposalSource = (source: ResolvedSource) => ({
  sourceId: source.sourceId,
  versionId: source.versionId,
  versionNumber: source.versionNumber,
  contentHash: source.contentHash,
  name: source.name,
  title: source.title,
});

// A verified revision; anything that is not exactly what was stored is an
// integrity error, never repaired and never quoted
const verified = <C>(
  revision: StoredRevision | null,
  verify: (revision: StoredRevision) => C
) => {
  if (!revision) {
    throw contextIntegrityError();
  }
  try {
    return verify(revision);
  } catch {
    throw contextIntegrityError();
  }
};

// The answer may not be cut off or refused, whatever its text says. Shared
// with Design Creative AI (P6-02)
export const assertComplete = (result: ContentStudioAITextResult) => {
  if (result.finishReason === 'content_filter') {
    throw new ContentStudioAIProviderError('CONTENT_REJECTED');
  }
  if (result.finishReason === 'length') {
    throw new ContentStudioAIProviderError('INVALID_RESPONSE');
  }
};

// The draft with the suggested texts in place must still be a valid draft
// (its size limit included), or the suggestion could never be saved. The
// claims of the items it replaces go with their old text; the suggested
// claims take their place, and must fit the draft too
const assertApplicable = (
  draft: ContentPackageDraft,
  texts: ContentStudioAIThreadProposalItem[],
  claims: ContentPackageClaimV2[] = []
) => {
  const withTexts = {
    ...draft,
    copy: {
      global: {
        thread: draft.copy.global.thread.map((item) => {
          const proposed = texts.find((entry) => entry.itemId === item.id);
          return proposed ? { ...item, text: proposed.text } : item;
        }),
      },
    },
  } as ContentPackageDraft;
  try {
    parseContentPackageDraft(withTexts);
  } catch {
    throw new ContentStudioAIProviderError('INVALID_RESPONSE');
  }
  try {
    parseContentPackageDraft(
      replaceContentPackageItemClaims(
        withTexts,
        texts.map((entry) => entry.itemId),
        claims
      )
    );
  } catch {
    throw new ContentStudioAIGroundingError();
  }
};

// A new claim id, c_ and 16 characters from the server's random source
const claimId = () => `c_${randomBytes(12).toString('base64url')}`;

// Every block the prompt showed, by its reference, with the exact version it
// came from. Only these can be evidence
const groundingBlocks = (sources: ResolvedSource[]) =>
  new Map<string, { source: ResolvedSource; block: ContentStudioSourceBlock }>(
    sources.flatMap((source, sourceIndex) =>
      source.content.blocks.map(
        (block, blockIndex) =>
          [
            contentStudioAISourceBlockRef(sourceIndex, blockIndex),
            { source, block },
          ] as const
      )
    )
  );

// The provider's claims for one item as claims of the draft: each reference
// replaced by the exact source, version, hash and block it stands for, each
// quote checked to be words of that block. Anything unknown or not matching
// refuses the whole answer
const toClaims = (
  proposed: ContentStudioAIProposedClaim[],
  threadItemId: string,
  blocks: ReturnType<typeof groundingBlocks>
): ContentPackageClaimV2[] =>
  proposed.map((claim) => ({
    id: claimId(),
    threadItemId,
    text: claim.text,
    evidence: claim.evidence.map((entry) => {
      const found = blocks.get(entry.ref);
      if (
        !found ||
        (entry.quote !== null && !found.block.text.includes(entry.quote))
      ) {
        throw new ContentStudioAIGroundingError();
      }
      return {
        sourceId: found.source.sourceId,
        versionId: found.source.versionId,
        versionNumber: found.source.versionNumber,
        contentHash: found.source.contentHash,
        blockId: found.block.id,
        quote: entry.quote,
      };
    }),
  }));

// AI writing proposals for a package: what one AI action suggests for an
// item or the whole thread, returned for the user to review. Nothing here
// writes the draft, a revision or a handoff: an accepted suggestion is saved
// by the editor like any edit. Any member may use the organization's AI
// connections (managing them is for admins); there is no plan or credit
// check, the connection's own key pays. Every selected profile is used at
// its current revision, and every selected source at its current version,
// resolved once here: the operation records exactly those revisions and
// versions, and the prompt is built from exactly their content. Sources are
// used only when the user selects them, as stored: nothing is fetched,
// refreshed or searched here, and using a source says nothing about whether
// its text is true. With sources, the answer also lists the claims of the
// suggested text with the blocks that support them; they are answered as
// grounding.claims only after every block and quote is matched to exactly the
// versions given, and they enter the draft only when the user accepts the
// suggestion (the draft save checks them again). Selected sources alone never
// become claims. The provider is reached only through
// ContentStudioAIExecutionService, with the connection and model the user
// chose and no fallback
@Injectable()
export class ContentStudioAIWritingService {
  constructor(
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioWritingProfileRepository: ContentStudioWritingProfileRepository,
    private _contentStudioEditorialPolicyRepository: ContentStudioEditorialPolicyRepository,
    private _contentStudioAudienceProfileRepository: ContentStudioAudienceProfileRepository,
    private _contentStudioExpertiseProfileRepository: ContentStudioExpertiseProfileRepository,
    private _contentStudioAIExecutionService: ContentStudioAIExecutionService,
    private _contentStudioSourceRepository: ContentStudioSourceRepository
  ) {}

  async proposeItem(input: {
    organizationId: string;
    userId: string;
    packageId: string;
    operation: unknown;
    itemId: unknown;
    selection: ContentStudioAIWritingSelection;
  }) {
    if (
      !ITEM_OPERATIONS.includes(
        input.operation as ContentStudioAIWritingItemOperation
      ) ||
      typeof input.itemId !== 'string'
    ) {
      throw invalidRequest();
    }
    const kind = input.operation as ContentStudioAIWritingItemOperation;
    const itemId = input.itemId;
    const selection = this.selection(input.selection);
    if (kind === 'change_tone' && !selection.instruction) {
      throw toneRequired();
    }

    const draft = await this.currentDraft(
      input.organizationId,
      input.packageId,
      selection.baseDraftVersion
    );
    const thread = draft.copy.global.thread;
    const itemIndex = thread.findIndex((item) => item.id === itemId);
    if (itemIndex < 0) {
      throw itemNotFound();
    }
    const itemText = thread[itemIndex].text;
    if (NEEDS_ITEM_TEXT.includes(kind) && !itemText.trim()) {
      throw itemTextRequired();
    }

    let text = '';
    let claims: ContentPackageClaimV2[] = [];
    const { operationId, provenance } = await this.run(
      input,
      selection,
      {
        kind,
        itemText,
        itemIndex,
        itemCount: thread.length,
        instruction: selection.instruction,
      },
      { itemId },
      ITEM_MAX_OUTPUT_TOKENS,
      (result, sources) => {
        assertComplete(result);
        if (!sources.length) {
          const proposed = parseContentStudioAIItemProposal(result.text);
          assertApplicable(draft, [{ itemId, text: proposed }]);
          text = proposed;
          return;
        }
        const proposed = parseContentStudioAIGroundedItemProposal(result.text);
        const grounded = toClaims(
          proposed.claims,
          itemId,
          groundingBlocks(sources)
        );
        assertApplicable(draft, [{ itemId, text: proposed.text }], grounded);
        text = proposed.text;
        claims = grounded;
      }
    );
    return {
      operationId,
      baseDraftVersion: selection.baseDraftVersion,
      proposal: { type: 'item' as const, itemId, text },
      grounding: { claims },
      provenance,
    };
  }

  async proposeThread(input: {
    organizationId: string;
    userId: string;
    packageId: string;
    operation: unknown;
    selection: ContentStudioAIWritingSelection;
  }) {
    if (input.operation !== 'generate_thread') {
      throw invalidRequest();
    }
    const selection = this.selection(input.selection);
    const draft = await this.currentDraft(
      input.organizationId,
      input.packageId,
      selection.baseDraftVersion
    );
    // a valid draft has at least one item; empty ones get new text
    const items = draft.copy.global.thread.map((item) => ({
      id: item.id,
      text: item.text,
    }));
    const itemIds = items.map((item) => item.id);

    let proposed: ContentStudioAIThreadProposalItem[] = [];
    let claims: ContentPackageClaimV2[] = [];
    const { operationId, provenance } = await this.run(
      input,
      selection,
      { kind: 'generate_thread', items, instruction: selection.instruction },
      {},
      THREAD_MAX_OUTPUT_TOKENS,
      (result, sources) => {
        assertComplete(result);
        if (!sources.length) {
          const parsed = parseContentStudioAIThreadProposal(
            result.text,
            itemIds
          );
          assertApplicable(draft, parsed);
          proposed = parsed;
          return;
        }
        const parsed = parseContentStudioAIGroundedThreadProposal(
          result.text,
          itemIds
        );
        const blocks = groundingBlocks(sources);
        const grounded = parsed.flatMap((item) =>
          toClaims(item.claims, item.itemId, blocks)
        );
        const texts = parsed.map(({ itemId, text }) => ({ itemId, text }));
        assertApplicable(draft, texts, grounded);
        proposed = texts;
        claims = grounded;
      }
    );
    return {
      operationId,
      baseDraftVersion: selection.baseDraftVersion,
      proposal: { type: 'thread' as const, items: proposed },
      grounding: { claims },
      provenance,
    };
  }

  // Resolves the context, builds the prompt and runs the operation once.
  // The answer is checked by `accept` before the operation succeeds. The
  // source material has its own size limit, checked before the prompt's
  private async run(
    input: { organizationId: string; userId: string; packageId: string },
    selection: Selection,
    task: ContentStudioAIWritingTask,
    target: { itemId?: string },
    maxOutputTokens: number,
    accept: (
      result: ContentStudioAITextResult,
      sources: ResolvedSource[]
    ) => void
  ) {
    const { context, refs, sources } = await this.resolveContext(
      input.organizationId,
      selection
    );
    if (
      contentStudioAISourceContextBytes(sources) >
      CONTENT_STUDIO_AI_SOURCE_CONTEXT_MAX_BYTES
    ) {
      throw sourceContextTooLarge();
    }
    const prompt = buildContentStudioAIWritingPrompt(task, context);
    if (
      contentStudioAIWritingPromptBytes(prompt) > AI_WRITING_PROMPT_MAX_BYTES
    ) {
      throw contextTooLarge();
    }

    const execution: ContentStudioAIExecutionInput = {
      organizationId: input.organizationId,
      userId: input.userId,
      connectionId: selection.connectionId,
      packageId: input.packageId,
      kind: task.kind,
      model: selection.model,
      promptVersion: prompt.promptVersion,
      baseDraftVersion: selection.baseDraftVersion,
      context: { v: 1, ...target, ...refs },
      request: {
        model: selection.model,
        system: prompt.system,
        prompt: prompt.prompt,
        output: { type: 'text' },
        maxOutputTokens,
      },
    };
    try {
      const { operationId } =
        await this._contentStudioAIExecutionService.execute(execution, {
          validateResult: (result) => accept(result, sources),
        });
      return {
        operationId,
        provenance: { sources: sources.map(toProposalSource) },
      };
    } catch (err) {
      throw fromAIError(err);
    }
  }

  // Everything checkable without a lookup
  private selection(input: ContentStudioAIWritingSelection): Selection {
    const profileId = (value: unknown) => {
      if (value === undefined || value === null) {
        return null;
      }
      if (typeof value !== 'string' || !UUID.test(value)) {
        throw invalidRequest();
      }
      return value;
    };
    if (
      typeof input?.connectionId !== 'string' ||
      !UUID.test(input.connectionId) ||
      typeof input.model !== 'string' ||
      !input.model ||
      input.model.length > MODEL_ID_MAX ||
      !Number.isSafeInteger(input.baseDraftVersion) ||
      (input.baseDraftVersion as number) < 1 ||
      (input.baseDraftVersion as number) > INT4_MAX ||
      (input.editorialPolicy !== undefined &&
        input.editorialPolicy !== null &&
        typeof input.editorialPolicy !== 'boolean')
    ) {
      throw invalidRequest();
    }
    return {
      connectionId: input.connectionId,
      model: input.model,
      baseDraftVersion: input.baseDraftVersion as number,
      writingProfileId: profileId(input.writingProfileId),
      editorialPolicy: input.editorialPolicy === true,
      audienceProfileId: profileId(input.audienceProfileId),
      expertiseProfileId: profileId(input.expertiseProfileId),
      sourceIds: this.sourceIds(input.sourceIds),
      instruction: this.instruction(input.instruction),
    };
  }

  // Up to five distinct source ids, in the order chosen; none is none. Too
  // many or a repeat is refused, never cut or merged
  private sourceIds(value: unknown) {
    if (value === undefined || value === null) {
      return [];
    }
    if (
      !Array.isArray(value) ||
      value.length > CONTENT_STUDIO_AI_MAX_SOURCES ||
      !value.every((id) => typeof id === 'string' && UUID.test(id)) ||
      new Set(value).size !== value.length
    ) {
      throw invalidRequest();
    }
    return [...value] as string[];
  }

  // Line endings normalized and outer whitespace trimmed; blank is none.
  // It becomes part of the prompt only, which is stored as a hash
  private instruction(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw invalidRequest();
    }
    const text = value.replace(/\r\n?/g, '\n').trim();
    if (
      text.length > AI_WRITING_INSTRUCTION_MAX ||
      text.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(text)
    ) {
      throw invalidRequest();
    }
    return text || null;
  }

  // The saved draft, at exactly the version the editor saved last
  private async currentDraft(
    organizationId: string,
    packageId: string,
    baseDraftVersion: number
  ) {
    if (typeof packageId !== 'string' || !UUID.test(packageId)) {
      throw packageNotFound();
    }
    const row = await this._contentStudioRepository.getPackageForOrganization(
      organizationId,
      packageId
    );
    if (!row) {
      throw packageNotFound();
    }
    if (row.archivedAt) {
      throw packageArchived();
    }
    if (row.draftVersion !== baseDraftVersion) {
      throw draftConflict();
    }
    try {
      return parseContentPackageDraft(JSON.parse(row.draft));
    } catch {
      throw storedDraftInvalid();
    }
  }

  // The organization context of a Design Creative AI copy suggestion
  // (P6-02): the current revision of every selected profile and of the
  // policy, exactly as for writing, without sources. The ids must already
  // be checked as uuids
  async resolveProfileContext(
    organizationId: string,
    selection: Pick<
      Selection,
      | 'writingProfileId'
      | 'editorialPolicy'
      | 'audienceProfileId'
      | 'expertiseProfileId'
    >
  ) {
    const { context, refs } = await this.resolveContext(organizationId, {
      ...selection,
      sourceIds: [],
    });
    return { context, refs };
  }

  // The current revision of every selected profile and of the policy, in a
  // fixed order, then the current version of every selected source, in the
  // order chosen, each read once. A later revision or version does not
  // change this run
  private async resolveContext(
    organizationId: string,
    selection: Pick<
      Selection,
      | 'writingProfileId'
      | 'editorialPolicy'
      | 'audienceProfileId'
      | 'expertiseProfileId'
      | 'sourceIds'
    >
  ) {
    const writing = await this.profile(
      organizationId,
      'writing',
      selection.writingProfileId,
      this._contentStudioWritingProfileRepository,
      parseVerifiedContentStudioWritingProfileRevision
    );
    const editorialPolicy = selection.editorialPolicy
      ? await this.editorialPolicy(organizationId)
      : null;
    const audience = await this.profile(
      organizationId,
      'audience',
      selection.audienceProfileId,
      this._contentStudioAudienceProfileRepository,
      parseVerifiedContentStudioAudienceProfileRevision
    );
    const expertise = await this.profile(
      organizationId,
      'expertise',
      selection.expertiseProfileId,
      this._contentStudioExpertiseProfileRepository,
      parseVerifiedContentStudioExpertiseProfileRevision
    );

    const sources = await this.sources(organizationId, selection.sourceIds);

    const context: ContentStudioAIWritingContext = {
      writing: writing?.content ?? null,
      editorialPolicy: editorialPolicy?.content ?? null,
      audience: audience?.content ?? null,
      expertise: expertise?.content ?? null,
      sources,
    };
    const profiles = [writing, audience, expertise]
      .filter((profile) => !!profile)
      .map((profile) => (profile as { ref: ProfileRef }).ref);
    return {
      context,
      refs: {
        ...(profiles.length ? { profiles } : {}),
        ...(editorialPolicy ? { editorialPolicy: editorialPolicy.ref } : {}),
        ...(sources.length
          ? {
              sources: sources.map((source) => ({
                sourceId: source.sourceId,
                versionId: source.versionId,
                versionNumber: source.versionNumber,
                contentHash: source.contentHash,
              })),
            }
          : {}),
      },
      sources,
    };
  }

  // Each selected source of this organization only (another organization's
  // reads as missing), live and ingested, at its current version: the blocks
  // are used only once they prove to be exactly what was stored. Who created
  // the source does not matter. A source without its current version is a
  // broken store, never "not ingested". Only a web page has versions: a feed
  // (P8-01) finds pages and is never source material itself, whatever its
  // version count says (P8-03)
  private async sources(organizationId: string, sourceIds: string[]) {
    const sources: ResolvedSource[] = [];
    for (const sourceId of sourceIds) {
      const row =
        await this._contentStudioSourceRepository.getSourceForOrganization(
          organizationId,
          sourceId
        );
      if (!row) {
        throw sourceNotFound();
      }
      if (row.archivedAt) {
        throw sourceArchived();
      }
      if (row.kind !== 'url' || row.latestVersionNumber < 1) {
        throw sourceNotReady();
      }
      const version =
        await this._contentStudioSourceRepository.getVersionDetailByNumber(
          organizationId,
          row.id,
          row.latestVersionNumber
        );
      if (!version || version.versionNumber !== row.latestVersionNumber) {
        throw sourceIntegrityError();
      }
      let content;
      try {
        content = parseVerifiedContentStudioSourceVersion(version);
      } catch {
        throw sourceIntegrityError();
      }
      sources.push({
        sourceId: row.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        name: row.name,
        title: version.title,
        content,
      });
    }
    return sources;
  }

  // A profile of this organization only (another organization's reads as
  // missing), live, at its current revision
  private async profile<C>(
    organizationId: string,
    kind: ContentStudioAIContextProfileKind,
    profileId: string | null,
    source: ProfileSource,
    verify: (revision: StoredRevision) => C
  ) {
    if (!profileId) {
      return null;
    }
    const row = await source.getProfileForOrganization(
      organizationId,
      profileId
    );
    if (!row) {
      throw contextNotFound();
    }
    if (row.archivedAt) {
      throw contextArchived();
    }
    const revision = await source.getRevisionByNumber(
      organizationId,
      row.id,
      row.latestRevisionNumber
    );
    const content = verified(revision, verify);
    const ref: ProfileRef = {
      kind,
      profileId: row.id,
      revisionId: (revision as StoredRevision).id,
      revisionNumber: (revision as StoredRevision).revisionNumber,
    };
    return { content, ref };
  }

  // The organization's one policy, asked for explicitly: no policy is an
  // error, never silently left out
  private async editorialPolicy(organizationId: string) {
    const policy =
      await this._contentStudioEditorialPolicyRepository.getPolicyForOrganization(
        organizationId
      );
    if (!policy) {
      throw contextNotFound();
    }
    const revision =
      await this._contentStudioEditorialPolicyRepository.getRevisionByNumber(
        organizationId,
        policy.id,
        policy.latestRevisionNumber
      );
    const content = verified(
      revision,
      parseVerifiedContentStudioEditorialPolicyRevision
    );
    return {
      content,
      ref: {
        revisionId: (revision as StoredRevision).id,
        revisionNumber: (revision as StoredRevision).revisionNumber,
      },
    };
  }
}
