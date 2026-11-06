import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import {
  assertComplete,
  contentStudioAIOperationState,
  fromAIError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import {
  ContentStudioAIExecutionService,
  ContentStudioAIStartedOperation,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import {
  getContentStudioAIDefaultModel,
  getContentStudioAIModel,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import { ContentStudioAIProviderGate } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.gate';
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
  SETUP_TAGLINE_MAX,
  SETUP_WEBSITE_MAX,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.prompt';
import {
  ContentStudioAISetupProposalV1,
  parseContentStudioAISetupProposal,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.proposal';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAIProviderErrorCode } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

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
const notFound = () =>
  fail(404, 'CS_NOT_FOUND', 'The Content Studio resource was not found');

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
// Provider answers about the connection or its account rather than this
// request. Recorded on the connection as a failed test, so its status says
// what to fix instead of staying Ready; a busy, slow or unavailable
// provider is no reason to and leaves the status as it is
const CONNECTION_FAILURES: ContentStudioAIProviderErrorCode[] = [
  'AUTH_FAILED',
  'WORKSPACE_REQUIRED',
  'QUOTA_EXCEEDED',
  'MODEL_UNAVAILABLE',
];
// a whole profile set takes a large model well over the 30 seconds a
// writing call may take
export const SETUP_TIMEOUT_MS = 150_000;

// What the user typed, as the controller passes it on
export interface ContentStudioAISetupRequest {
  connectionId: unknown;
  companyName: unknown;
  tagline?: unknown;
  website?: unknown;
  description: unknown;
  goal?: unknown;
  audience?: unknown;
  language?: unknown;
}

// The guided setup's AI draft: one structured suggestion for the
// organization's brand description, writing profile, audiences, expertise
// and editorial policy, from a few facts the user typed. Starting it returns
// the operation at once; the draft is made on the server whatever becomes of
// that request (a phone that puts the browser away drops it) and kept on the
// operation, where the assistant reads it back, however often and from
// wherever, until it is there. It is never saved anywhere else: nothing of a
// profile, the policy or the Brand Kit is read or written, and saving goes
// through their own routes afterwards. The provider is reached only through
// ContentStudioAIExecutionService, with the organization connection the user
// chose and that connection's own model: no fallback, no environment key.
// The operation is recorded for the organization; what the user typed is
// never stored, only the checked draft
@Injectable()
export class ContentStudioAISetupService {
  private _logger = new Logger(ContentStudioAISetupService.name);

  constructor(
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository,
    private _contentStudioAIExecutionService: ContentStudioAIExecutionService,
    private _contentStudioAIOperationRepository: ContentStudioAIOperationRepository,
    private _contentStudioAIProviderGate: ContentStudioAIProviderGate
  ) {}

  // Checks the request and starts the operation. What can be refused without
  // the provider is refused here, as before; done settles when the draft is
  // kept or the failure recorded, and never rejects
  async startSetup(input: {
    organizationId: string;
    userId: string;
    request: ContentStudioAISetupRequest;
  }): Promise<{ operationId: string; done: Promise<void> }> {
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
    if (!this._contentStudioAIProviderGate.isEnabled(connection.provider)) {
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

    let started: ContentStudioAIStartedOperation;
    try {
      started =
        await this._contentStudioAIExecutionService.startForOrganization(
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
              timeoutMs: SETUP_TIMEOUT_MS,
            },
          },
          {
            validateResult: (result) => {
              assertComplete(result);
              return parseContentStudioAISetupProposal(
                result.text,
                setup.language
              );
            },
            keepResult: true,
          }
        );
    } catch (err) {
      throw fromAIError(err);
    }

    const done = started.done.then(
      () => undefined,
      async (err) => {
        // what is needed to tell why a real call failed, and nothing else:
        // no key, prompt, company information or provider message
        if (err instanceof ContentStudioAIProviderError) {
          this._logger.warn(
            `setup proposal failed: provider=${
              connection.provider
            } model=${model} code=${err.code} httpStatus=${
              err.httpStatus ?? '-'
            } providerRequestId=${err.providerRequestId ?? '-'}`
          );
          if (CONNECTION_FAILURES.includes(err.code)) {
            await this._contentStudioAIConnectionRepository
              .setValidationResult({
                organizationId: input.organizationId,
                connectionId,
                validatedAt: new Date(),
                status: 'invalid',
                code: err.code,
              })
              // the answer to the user is the provider failure either way
              .catch(() => undefined);
          }
        } else {
          this._logger.warn('setup proposal failed: not recorded');
        }
      }
    );
    return { operationId: started.operationId, done };
  }

  // A setup draft of the organization as it stands: running, the failure as
  // the start request would have answered it, or the checked draft
  async getSetupProposal(organizationId: string, operationId: string) {
    if (typeof operationId !== 'string' || !UUID.test(operationId)) {
      throw notFound();
    }
    const operation =
      await this._contentStudioAIOperationRepository.getOperationStateForOrganization(
        organizationId,
        operationId
      );
    if (!operation || operation.kind !== 'setup_proposal') {
      throw notFound();
    }
    const state = contentStudioAIOperationState(operation);
    return {
      operationId,
      ...state,
      ...(state.status === 'succeeded'
        ? {
            proposal:
              operation.result as unknown as ContentStudioAISetupProposalV1,
          }
        : {}),
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
      tagline: this.text(request.tagline, SETUP_TAGLINE_MAX, false),
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
