import { HttpException, Injectable } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
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
  ContentStudioAIContextProfileKind,
  ContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  AI_WRITING_PROMPT_MAX_BYTES,
  buildContentStudioAIWritingPrompt,
  ContentStudioAIItemOperation,
  ContentStudioAIWritingContext,
  ContentStudioAIWritingTask,
  contentStudioAIWritingPromptBytes,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.writing.prompt';
import {
  ContentStudioAIThreadProposalItem,
  parseContentStudioAIItemProposal,
  parseContentStudioAIThreadProposal,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.writing.proposal';
import {
  ContentPackageDraftV1,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { parseVerifiedContentStudioWritingProfileRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile.revision';
import { parseVerifiedContentStudioEditorialPolicyRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';
import { parseVerifiedContentStudioAudienceProfileRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';
import { parseVerifiedContentStudioExpertiseProfileRevision } from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile.revision';
import {
  AI_WRITING_INSTRUCTION_MAX,
  ContentStudioAIWritingItemOperation,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-writing.dto';

// Fixed messages only: never a prompt, an instruction, draft or profile
// text, a provider message or an id. Nothing here answers 401, 402 or 406,
// which the app treats as session or billing problems
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

const fromAIError = (err: unknown) => {
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

// Package, connection, profile and revision ids are Prisma uuid() values
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

// The answer may not be cut off or refused, whatever its text says
const assertComplete = (result: ContentStudioAITextResult) => {
  if (result.finishReason === 'content_filter') {
    throw new ContentStudioAIProviderError('CONTENT_REJECTED');
  }
  if (result.finishReason === 'length') {
    throw new ContentStudioAIProviderError('INVALID_RESPONSE');
  }
};

// The draft with the suggested texts in place must still be a valid draft
// (its size limit included), or the suggestion could never be saved
const assertApplicable = (
  draft: ContentPackageDraftV1,
  texts: ContentStudioAIThreadProposalItem[]
) => {
  try {
    parseContentPackageDraft({
      ...draft,
      copy: {
        global: {
          thread: draft.copy.global.thread.map((item) => {
            const proposed = texts.find((entry) => entry.itemId === item.id);
            return proposed ? { ...item, text: proposed.text } : item;
          }),
        },
      },
    });
  } catch {
    throw new ContentStudioAIProviderError('INVALID_RESPONSE');
  }
};

// AI writing proposals for a package: what one AI action suggests for an
// item or the whole thread, returned for the user to review. Nothing here
// writes the draft, a revision or a handoff: an accepted suggestion is saved
// by the editor like any edit. Any member may use the organization's AI
// connections (managing them is for admins); there is no plan or credit
// check, the connection's own key pays. Every selected profile is used at
// its current revision, resolved once here: the operation records exactly
// those revisions, and the prompt is built from exactly their content. The
// provider is reached only through ContentStudioAIExecutionService, with
// the connection and model the user chose and no fallback
@Injectable()
export class ContentStudioAIWritingService {
  constructor(
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioWritingProfileRepository: ContentStudioWritingProfileRepository,
    private _contentStudioEditorialPolicyRepository: ContentStudioEditorialPolicyRepository,
    private _contentStudioAudienceProfileRepository: ContentStudioAudienceProfileRepository,
    private _contentStudioExpertiseProfileRepository: ContentStudioExpertiseProfileRepository,
    private _contentStudioAIExecutionService: ContentStudioAIExecutionService
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
    const operationId = await this.run(
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
      (result) => {
        assertComplete(result);
        const proposed = parseContentStudioAIItemProposal(result.text);
        assertApplicable(draft, [{ itemId, text: proposed }]);
        text = proposed;
      }
    );
    return {
      operationId,
      baseDraftVersion: selection.baseDraftVersion,
      proposal: { type: 'item' as const, itemId, text },
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
    const operationId = await this.run(
      input,
      selection,
      { kind: 'generate_thread', items, instruction: selection.instruction },
      {},
      THREAD_MAX_OUTPUT_TOKENS,
      (result) => {
        assertComplete(result);
        const parsed = parseContentStudioAIThreadProposal(result.text, itemIds);
        assertApplicable(draft, parsed);
        proposed = parsed;
      }
    );
    return {
      operationId,
      baseDraftVersion: selection.baseDraftVersion,
      proposal: { type: 'thread' as const, items: proposed },
    };
  }

  // Resolves the context, builds the prompt and runs the operation once.
  // The answer is checked by `accept` before the operation succeeds
  private async run(
    input: { organizationId: string; userId: string; packageId: string },
    selection: Selection,
    task: ContentStudioAIWritingTask,
    target: { itemId?: string },
    maxOutputTokens: number,
    accept: (result: ContentStudioAITextResult) => void
  ) {
    const { context, refs } = await this.resolveContext(
      input.organizationId,
      selection
    );
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
          validateResult: accept,
        });
      return operationId;
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
      instruction: this.instruction(input.instruction),
    };
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

  // The current revision of every selected profile and of the policy, in a
  // fixed order, each read once. A later revision does not change this run
  private async resolveContext(organizationId: string, selection: Selection) {
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

    const context: ContentStudioAIWritingContext = {
      writing: writing?.content ?? null,
      editorialPolicy: editorialPolicy?.content ?? null,
      audience: audience?.content ?? null,
      expertise: expertise?.content ?? null,
    };
    const profiles = [writing, audience, expertise]
      .filter((profile) => !!profile)
      .map((profile) => (profile as { ref: ProfileRef }).ref);
    return {
      context,
      refs: {
        ...(profiles.length ? { profiles } : {}),
        ...(editorialPolicy ? { editorialPolicy: editorialPolicy.ref } : {}),
      },
    };
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
