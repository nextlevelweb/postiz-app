import { HttpException, Injectable } from '@nestjs/common';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import {
  assertComplete,
  fromAIError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import {
  getContentStudioAIDefaultModel,
  getContentStudioAIModel,
  isContentStudioAIProvider,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  AI_SETUP_PROMPT_MAX_BYTES,
  buildContentStudioAISetupPrompt,
  contentStudioAISetupPromptBytes,
  CONTENT_STUDIO_AI_SETUP_SCHEMA,
  CONTENT_STUDIO_AI_SETUP_SCHEMA_NAME,
  ContentStudioAISetupInput,
  SETUP_COMPANY_NAME_MAX,
  SETUP_DESCRIPTION_MAX,
  SETUP_NOTE_MAX,
  SETUP_WEBSITE_MAX,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.prompt';
import {
  ContentStudioAISetupProposalV1,
  parseContentStudioAISetupProposal,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.proposal';

// Fixed messages only: never the company information, a prompt, a provider
// message or an id
const fail = (status: number, code: string, msg: string) =>
  new HttpException({ msg, code }, status);

const invalidRequest = () =>
  fail(400, 'CS_INVALID_REQUEST', 'The Content Studio request is invalid');
// missing, archived or of another organization alike, as for AI writing
const connectionRequired = () =>
  fail(400, 'CS_AI_CONNECTION_REQUIRED', 'Select an available AI connection.');
const providerUnsupported = () =>
  fail(400, 'CS_AI_PROVIDER_UNSUPPORTED', 'This AI provider is not supported.');
const contextTooLarge = () =>
  fail(400, 'CS_AI_CONTEXT_TOO_LARGE', 'The selected AI context is too large.');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// The same shape as an audience locale (audience.profile.ts)
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const LANGUAGE_MAX = 35;
// http or https, as typed: the address is passed on as text, never fetched
const WEBSITE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
// a whole profile set in one answer
const SETUP_MAX_OUTPUT_TOKENS = 8192;

// What the user typed, as the controller passes it on
export interface ContentStudioAISetupRequest {
  connectionId: unknown;
  companyName: unknown;
  website?: unknown;
  description: unknown;
  goal?: unknown;
  audience?: unknown;
  language?: unknown;
}

// The guided setup's AI draft: one structured suggestion for the
// organization's brand description, writing profile, audiences, expertise
// and editorial policy, from a few facts the user typed. It is returned for
// the user to review and edit and is never saved here: nothing of a profile,
// the policy or the Brand Kit is read or written, and saving goes through
// their own routes afterwards. The provider is reached only through
// ContentStudioAIExecutionService, with the organization connection the user
// chose and that connection's own model: no fallback, no environment key.
// The operation is recorded for the organization, with hashes only
@Injectable()
export class ContentStudioAISetupService {
  constructor(
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository,
    private _contentStudioAIExecutionService: ContentStudioAIExecutionService
  ) {}

  async proposeSetup(input: {
    organizationId: string;
    userId: string;
    request: ContentStudioAISetupRequest;
  }) {
    const connectionId = input.request?.connectionId;
    if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
      throw invalidRequest();
    }
    const setup = this.setupInput(input.request);

    const connection =
      await this._contentStudioAIConnectionRepository.getConnectionForOrganization(
        input.organizationId,
        connectionId
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

    // structured output where the model takes it; the same strict parser
    // either way
    const structured = !!getContentStudioAIModel(connection.provider, model)
      ?.capabilities.structuredOutput;
    const prompt = buildContentStudioAISetupPrompt(setup);
    if (contentStudioAISetupPromptBytes(prompt) > AI_SETUP_PROMPT_MAX_BYTES) {
      throw contextTooLarge();
    }

    let proposal: ContentStudioAISetupProposalV1 | null = null;
    let operationId: string;
    try {
      ({ operationId } =
        await this._contentStudioAIExecutionService.executeForOrganization(
          {
            organizationId: input.organizationId,
            userId: input.userId,
            connectionId,
            kind: 'setup_proposal',
            model,
            promptVersion: prompt.promptVersion,
            context: { v: 1 },
            request: {
              model,
              system: prompt.system,
              prompt: prompt.prompt,
              output: structured
                ? {
                    type: 'json',
                    schemaName: CONTENT_STUDIO_AI_SETUP_SCHEMA_NAME,
                    schema: CONTENT_STUDIO_AI_SETUP_SCHEMA,
                  }
                : { type: 'text' },
              maxOutputTokens: SETUP_MAX_OUTPUT_TOKENS,
            },
          },
          {
            validateResult: (result) => {
              assertComplete(result);
              proposal = parseContentStudioAISetupProposal(
                result.text,
                setup.language
              );
            },
          }
        ));
    } catch (err) {
      throw fromAIError(err);
    }

    return {
      operationId,
      proposal: proposal as unknown as ContentStudioAISetupProposalV1,
      ai: {
        provider: connection.provider,
        model,
        promptVersion: prompt.promptVersion,
      },
    };
  }

  // Line endings normalized and outer whitespace trimmed. A required text
  // must not be blank; an optional blank one is none
  private text(value: unknown, max: number, required: boolean) {
    if (value === undefined || value === null) {
      if (required) {
        throw invalidRequest();
      }
      return null;
    }
    if (typeof value !== 'string') {
      throw invalidRequest();
    }
    const text = value.replace(/\r\n?/g, '\n').trim();
    if (
      text.length > max ||
      text.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(text) ||
      (required && !text)
    ) {
      throw invalidRequest();
    }
    return text || null;
  }

  private setupInput(
    request: ContentStudioAISetupRequest
  ): ContentStudioAISetupInput {
    const website = this.text(request.website, SETUP_WEBSITE_MAX, false);
    if (website && !WEBSITE.test(website)) {
      throw invalidRequest();
    }
    const language = this.text(request.language, LANGUAGE_MAX, false) ?? 'en';
    if (!LANGUAGE.test(language)) {
      throw invalidRequest();
    }
    return {
      companyName: this.text(
        request.companyName,
        SETUP_COMPANY_NAME_MAX,
        true
      ) as string,
      website,
      description: this.text(
        request.description,
        SETUP_DESCRIPTION_MAX,
        true
      ) as string,
      goal: this.text(request.goal, SETUP_NOTE_MAX, false),
      audience: this.text(request.audience, SETUP_NOTE_MAX, false),
      language,
    };
  }
}
