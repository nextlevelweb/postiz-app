import { HttpException, Injectable } from '@nestjs/common';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import {
  assertComplete,
  ContentStudioAIWritingService,
  fromAIError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  getContentStudioAIDefaultModel,
  getContentStudioAIModel,
  isContentStudioAIProvider,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  AI_DESIGN_PROMPT_MAX_BYTES,
  buildContentStudioAIDesignPrompt,
  contentStudioAIDesignPromptBytes,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.design.prompt';
import { ContentStudioAIDesignOperationKind } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  ContentStudioDesignAIIntent,
  ContentStudioDesignAIProposalError,
  ContentStudioDesignAIProposalV1,
  describeContentStudioDesignAIProposal,
  DESIGN_AI_COPY_INTENTS,
  isContentStudioDesignAIIntent,
  resolveContentStudioDesignAIProposal,
} from '@gitroom/nestjs-libraries/content-studio/design/design.ai.proposal';
import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { AI_WRITING_INSTRUCTION_MAX } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-writing.dto';

// Fixed messages only: never a prompt, an instruction, design text, a layer
// or page name, a token, a provider message or an id
const fail = (status: number, code: string, msg: string) =>
  new HttpException({ msg, code }, status);

const invalidRequest = () =>
  fail(400, 'CS_INVALID_REQUEST', 'The Content Studio request is invalid');
const intentInvalid = () =>
  fail(
    400,
    'CS_AI_DESIGN_INTENT_INVALID',
    'This kind of design suggestion is not available.'
  );
const toneRequired = () =>
  fail(400, 'CS_INVALID_REQUEST', 'Changing the tone needs a tone.');
// missing, archived or of another organization alike, as for AI writing
const connectionRequired = () =>
  fail(400, 'CS_AI_CONNECTION_REQUIRED', 'Select an available AI connection.');
const providerUnsupported = () =>
  fail(400, 'CS_AI_PROVIDER_UNSUPPORTED', 'This AI provider is not supported.');
const contextTooLarge = () =>
  fail(400, 'CS_AI_CONTEXT_TOO_LARGE', 'The selected AI context is too large.');
// Any operation of the answer that is not exactly allowed for this design
// refuses the whole answer, never partly kept
const proposalInvalid = () =>
  fail(
    502,
    'CS_AI_DESIGN_PROPOSAL_INVALID',
    'The AI suggestion does not fit this design.'
  );

// An answer that parses as JSON but is not a valid proposal for this exact
// design: the operation fails as INVALID_RESPONSE, and it can be told apart
class ContentStudioAIDesignProposalInvalidError extends ContentStudioAIProviderError {
  constructor() {
    super('INVALID_RESPONSE');
    this.name = 'ContentStudioAIDesignProposalInvalidError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// 50 operations, some with a full text layer
const DESIGN_MAX_OUTPUT_TOKENS = 16_384;

const OPERATION_KINDS: Record<
  ContentStudioDesignAIIntent,
  ContentStudioAIDesignOperationKind
> = {
  improve_copy: 'design_improve_copy',
  tighten_copy: 'design_tighten_copy',
  adapt_tone: 'design_adapt_tone',
  improve_hierarchy: 'design_improve_hierarchy',
  restyle: 'design_restyle',
  rebalance_layout: 'design_rebalance_layout',
};

// What the user chose, as the controller passes it on
export interface ContentStudioDesignAISelection {
  connectionId: unknown;
  writingProfileId?: unknown;
  editorialPolicy?: unknown;
  audienceProfileId?: unknown;
  expertiseProfileId?: unknown;
  instruction?: unknown;
}

// Design Creative AI (P6-02): one suggestion for exactly one saved design
// revision, returned for the user to look at, never applied here. Nothing
// here writes the design, a revision, a render, Media, a review or an
// approval: an accepted suggestion lands in the editor's draft and is saved
// as the next revision like any edit. The revision must be the design's
// current one; the Brand Kit revision it names is used exactly, and the
// design's package origin (P6-01) only by name and version. The provider is
// reached only through ContentStudioAIExecutionService, with the
// organization connection the user chose and that connection's own model:
// no fallback, no environment key. The operation is recorded on the
// revision, with hashes only. The model's answer names pages and layers by
// tokens; it is accepted only once every operation maps to exactly this
// document and the result is a valid design
@Injectable()
export class ContentStudioDesignAIService {
  constructor(
    private _contentStudioDesignService: ContentStudioDesignService,
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository,
    private _contentStudioAIWritingService: ContentStudioAIWritingService,
    private _contentStudioAIExecutionService: ContentStudioAIExecutionService
  ) {}

  async proposeDesign(input: {
    organizationId: string;
    userId: string;
    designId: string;
    revisionId: string;
    intent: unknown;
    selection: ContentStudioDesignAISelection;
  }) {
    if (!isContentStudioDesignAIIntent(input.intent)) {
      throw intentInvalid();
    }
    const intent = input.intent;
    const copy = DESIGN_AI_COPY_INTENTS.includes(intent);
    const selection = this.selection(input.selection, copy);
    if (intent === 'adapt_tone' && !selection.instruction) {
      throw toneRequired();
    }

    // exactly the revision asked for, still current, with its exact kit
    const base = await this._contentStudioDesignService.getDesignAIBase({
      organizationId: input.organizationId,
      designId: input.designId,
      revisionId: input.revisionId,
    });

    const connection =
      await this._contentStudioAIConnectionRepository.getConnectionForOrganization(
        input.organizationId,
        selection.connectionId
      );
    if (!connection) {
      throw connectionRequired();
    }
    if (!isContentStudioAIProvider(connection.provider)) {
      throw providerUnsupported();
    }
    // the connection's own model while its provider offers it, else the
    // provider's default: never a model from the request
    const model = getContentStudioAIModel(
      connection.provider,
      connection.defaultModel
    )
      ? (connection.defaultModel as string)
      : getContentStudioAIDefaultModel(connection.provider);

    const profiles = copy
      ? await this._contentStudioAIWritingService.resolveProfileContext(
          input.organizationId,
          selection
        )
      : null;

    const prompt = buildContentStudioAIDesignPrompt(
      { intent, instruction: selection.instruction },
      {
        document: base.document,
        brand: base.brand,
        source: base.source
          ? {
              packageName: base.source.packageName,
              packageRevisionNumber: base.source.packageRevisionNumber,
            }
          : null,
        organization: profiles?.context ?? null,
      }
    );
    if (contentStudioAIDesignPromptBytes(prompt) > AI_DESIGN_PROMPT_MAX_BYTES) {
      throw contextTooLarge();
    }

    let proposal: ContentStudioDesignAIProposalV1 | null = null;
    let operationId: string;
    try {
      ({ operationId } =
        await this._contentStudioAIExecutionService.executeForDesign(
          {
            organizationId: input.organizationId,
            userId: input.userId,
            connectionId: selection.connectionId,
            designRevisionId: base.revision.id,
            kind: OPERATION_KINDS[intent],
            model,
            promptVersion: prompt.promptVersion,
            context: {
              v: 1,
              ...(profiles?.refs ?? {}),
              design: {
                designId: base.designId,
                revisionId: base.revision.id,
                revisionNumber: base.revision.revisionNumber,
                contentHash: base.revision.contentHash,
              },
            },
            request: {
              model,
              system: prompt.system,
              prompt: prompt.prompt,
              output: { type: 'text' },
              maxOutputTokens: DESIGN_MAX_OUTPUT_TOKENS,
            },
          },
          {
            validateResult: (result) => {
              assertComplete(result);
              try {
                proposal = resolveContentStudioDesignAIProposal({
                  document: base.document,
                  brand: base.brand,
                  intent,
                  raw: result.text,
                });
              } catch (err) {
                if (err instanceof ContentStudioDesignAIProposalError) {
                  throw new ContentStudioAIDesignProposalInvalidError();
                }
                throw err;
              }
            },
          }
        ));
    } catch (err) {
      if (err instanceof ContentStudioAIDesignProposalInvalidError) {
        throw proposalInvalid();
      }
      throw fromAIError(err);
    }

    const accepted = proposal as unknown as ContentStudioDesignAIProposalV1;
    return {
      operationId,
      base: {
        designId: base.designId,
        revisionId: base.revision.id,
        revisionNumber: base.revision.revisionNumber,
        contentHash: base.revision.contentHash,
      },
      proposal: accepted,
      // over the canonical JSON of exactly the proposal answered
      proposalHash: sha256Hex(canonicalJsonWithFiniteNumbers(accepted)),
      // what applying it changes, from the documents: not the summary
      changes: describeContentStudioDesignAIProposal(
        base.document,
        accepted,
        base.brand
      ),
      ai: {
        provider: connection.provider,
        model,
        promptVersion: prompt.promptVersion,
      },
    };
  }

  // Everything checkable without a lookup. Profiles belong to copy
  // suggestions only
  private selection(input: ContentStudioDesignAISelection, copy: boolean) {
    const profileId = (value: unknown) => {
      if (value === undefined || value === null) {
        return null;
      }
      if (typeof value !== 'string' || !UUID.test(value) || !copy) {
        throw invalidRequest();
      }
      return value;
    };
    if (
      typeof input?.connectionId !== 'string' ||
      !UUID.test(input.connectionId) ||
      (input.editorialPolicy !== undefined &&
        input.editorialPolicy !== null &&
        typeof input.editorialPolicy !== 'boolean') ||
      (input.editorialPolicy === true && !copy)
    ) {
      throw invalidRequest();
    }
    return {
      connectionId: input.connectionId,
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
}
