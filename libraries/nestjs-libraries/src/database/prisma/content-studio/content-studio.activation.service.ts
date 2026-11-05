import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioActivationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.activation.repository';
import {
  assertComplete,
  ContentStudioAIWritingService,
  contentStudioAIOperationState,
  fromAIError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioBrandKitService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import {
  ContentStudioAIExecutionService,
  ContentStudioAIStartedOperation,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import {
  getContentStudioAIDefaultModel,
  getContentStudioAIModel,
  isContentStudioAIProvider,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  AI_REQUEST_TIMEOUT_MAX_MS,
  ContentStudioAITextRequest,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  CONTENT_STUDIO_AI_FIRST_POST_OPERATION_KINDS,
  ContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  AI_FIRST_POST_PROMPT_MAX_BYTES,
  CONTENT_STUDIO_FIRST_POST_MODES,
  ContentStudioFirstPostMode,
  buildContentStudioAIFirstPostDraftPrompt,
  buildContentStudioAIFirstPostResearchPrompt,
  CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA,
  CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA_NAME,
  CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA,
  CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA_NAME,
  ContentStudioFirstPostBrand,
  ContentStudioFirstPostDraft,
  ContentStudioFirstPostFinding,
  ContentStudioFirstPostPrompt,
  ContentStudioFirstPostResearch,
  contentStudioAIFirstPostPromptBytes,
  FIRST_POST_FINDINGS_MAX,
  FIRST_POST_PREVIOUS_TOPICS_MAX,
  parseContentStudioFirstPostDraft,
  parseContentStudioFirstPostResearch,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.activation.prompt';
import { ContentStudioEditorialPolicyContentV1 } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import {
  ContentPackageDraft,
  replaceContentPackageItemClaims,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

// Fixed messages only: never a profile, a prompt, a provider message or an id
const fail = (status: number, code: string, msg: string) =>
  new HttpException({ msg, code }, status);
const invalidRequest = () =>
  fail(400, 'CS_INVALID_REQUEST', 'The Content Studio request is invalid');
const connectionRequired = () =>
  fail(400, 'CS_AI_CONNECTION_REQUIRED', 'Select an available AI connection.');
const providerUnsupported = () =>
  fail(400, 'CS_AI_PROVIDER_UNSUPPORTED', 'This AI provider is not supported.');
const contextTooLarge = () =>
  fail(400, 'CS_AI_CONTEXT_TOO_LARGE', 'The selected AI context is too large.');
const alreadyStarting = () =>
  fail(
    409,
    'CS_FIRST_POST_STARTING',
    'The first post is already being started.'
  );
const notStarted = () =>
  fail(
    409,
    'CS_FIRST_POST_NOT_STARTED',
    'The first post has no research to continue from yet.'
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The same shape as an audience locale (audience.profile.ts)
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const LANGUAGE_MAX = 35;
const NAME_MAX = 200;
const DEFAULT_NAME = 'First post';

const RESEARCH_MAX_OUTPUT_TOKENS = 4096;
const DRAFT_MAX_OUTPUT_TOKENS = 2048;
// research with web search reads pages first: the longest wait allowed
const FIRST_POST_TIMEOUT_MS = AI_REQUEST_TIMEOUT_MAX_MS;
// what the feeds found this long ago is still worth looking at
const FINDINGS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STATES_READ = 20;
// the drafts the user can go back to: every one made from the operations
// read, newest first
const ALTERNATIVES_MAX = 10;

export interface ContentStudioFirstPostRequest {
  connectionId: unknown;
  mode: unknown;
  language?: unknown;
  name?: unknown;
  // apply only: an earlier draft to put back into the post
  draftOperationId?: unknown;
}

// One draft of the first post, kept on its operation: what "Try another
// angle" or refined research made never replaces it, and it can be put back
export interface ContentStudioFirstPostAlternative {
  operationId: string;
  completedAt: Date | null;
  text: string;
  // the research it was written from
  research: ContentStudioFirstPostResearch | null;
  // its text is the text of the post now
  current: boolean;
}

interface Prepared {
  organizationId: string;
  userId: string;
  connectionId: string;
  model: string;
  structured: boolean;
  webSearch: boolean;
  language: string;
  brand: ContentStudioFirstPostBrand | null;
  context: Awaited<
    ReturnType<ContentStudioAIWritingService['resolveProfileContext']>
  >['context'];
  refs: Omit<ContentStudioAIOperationContext, 'v'>;
}

const today = () => new Date().toISOString().slice(0, 10);
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

// The first post (activation flow 01): right after the guided setup,
// Content Studio researches what the organization should post about now and
// drafts that post, so the user starts from a real post instead of an empty
// editor. Research and draft are two AI operations on one Content Studio
// package that holds the first post. Starting answers at once; the research,
// the draft that follows it and putting that draft into the package all run
// on the server, whatever becomes of the request, and the state is read back
// from the operations and the package. Nothing is published, scheduled or
// handed off here: the user takes the post to the composer. The first post
// counts as done (activation) only once a post was scheduled or published
// after it was first handed off
@Injectable()
export class ContentStudioActivationService {
  private _logger = new Logger(ContentStudioActivationService.name);
  // organizations whose first post is being started right now: a second
  // start in between (a double click, two tabs) would research twice
  private _starting = new Set<string>();

  constructor(
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository,
    private _contentStudioAIExecutionService: ContentStudioAIExecutionService,
    private _contentStudioAIOperationRepository: ContentStudioAIOperationRepository,
    private _contentStudioAIWritingService: ContentStudioAIWritingService,
    private _contentStudioWritingProfileRepository: ContentStudioWritingProfileRepository,
    private _contentStudioAudienceProfileRepository: ContentStudioAudienceProfileRepository,
    private _contentStudioExpertiseProfileRepository: ContentStudioExpertiseProfileRepository,
    private _contentStudioBrandKitService: ContentStudioBrandKitService,
    private _contentStudioEditorialPolicyService: ContentStudioEditorialPolicyService,
    private _contentStudioSourceDiscoveryRepository: ContentStudioSourceDiscoveryRepository,
    private _contentStudioService: ContentStudioService,
    private _contentStudioActivationRepository: ContentStudioActivationRepository
  ) {}

  // Starts what the mode asks for and answers at once with the package. A
  // first post that is already being researched or drafted is not started
  // twice. done settles when everything the start set going has ended, and
  // never rejects
  async startFirstPost(input: {
    organizationId: string;
    userId: string;
    request: ContentStudioFirstPostRequest;
  }): Promise<{ packageId: string; done: Promise<void> }> {
    const { request } = input;
    if (
      !request ||
      typeof request.connectionId !== 'string' ||
      !UUID.test(request.connectionId) ||
      !(CONTENT_STUDIO_FIRST_POST_MODES as readonly unknown[]).includes(
        request.mode
      )
    ) {
      throw invalidRequest();
    }
    const mode = request.mode as ContentStudioFirstPostMode;
    // left out (another angle, refined research): the audience's language
    const language = this.text(request.language, LANGUAGE_MAX);
    if (language !== null && !LANGUAGE.test(language)) {
      throw invalidRequest();
    }
    const name = this.text(request.name, NAME_MAX) ?? DEFAULT_NAME;
    if (
      request.draftOperationId !== undefined &&
      request.draftOperationId !== null &&
      (mode !== 'apply' ||
        typeof request.draftOperationId !== 'string' ||
        !UUID.test(request.draftOperationId))
    ) {
      throw invalidRequest();
    }

    if (this._starting.has(input.organizationId)) {
      throw alreadyStarting();
    }
    this._starting.add(input.organizationId);
    try {
      return await this.start(input, request, mode, language, name);
    } finally {
      this._starting.delete(input.organizationId);
    }
  }

  private async start(
    input: { organizationId: string; userId: string },
    request: ContentStudioFirstPostRequest,
    mode: ContentStudioFirstPostMode,
    language: string | null,
    name: string
  ): Promise<{ packageId: string; done: Promise<void> }> {
    const operations = await this.operations(input.organizationId);
    const research = operations.find(
      (operation) => operation.kind === 'first_post_research'
    );
    // one thing at a time: a start while research or a draft runs answers
    // with what runs
    const running = operations.find(
      (operation) =>
        operation.packageId === research?.packageId &&
        contentStudioAIOperationState(operation).status === 'running'
    );
    if (research?.packageId && running) {
      return { packageId: research.packageId, done: Promise.resolve() };
    }

    const existing = research?.packageId
      ? await this._contentStudioService
          .getPackage(input.organizationId, research.packageId)
          .catch((err) => {
            // only a package that is gone starts again. Anything else (the
            // database, a stored draft that no longer reads) is said, never
            // turned into a second package and paid research
            if (err instanceof HttpException && err.getStatus() === 404) {
              return null;
            }
            throw err;
          })
      : null;
    const usable = existing && !existing.archivedAt ? existing : null;

    if (mode === 'apply' || mode === 'draft') {
      const researched =
        research?.status === 'succeeded'
          ? (research.result as unknown as ContentStudioFirstPostResearch)
          : null;
      if (!usable || !researched) {
        throw notStarted();
      }
      if (mode === 'apply') {
        // the newest draft, or the earlier one asked for
        const draft = operations.find(
          (operation) =>
            operation.kind === 'first_post_draft' &&
            operation.packageId === usable.id &&
            operation.status === 'succeeded' &&
            (typeof request.draftOperationId !== 'string' ||
              operation.id === request.draftOperationId)
        );
        if (!draft) {
          throw notStarted();
        }
        // no AI: put in before answering, so the answer is the outcome
        await this.write(
          input.organizationId,
          usable.id,
          draft.result as unknown as ContentStudioFirstPostDraft
        );
        return { packageId: usable.id, done: Promise.resolve() };
      }
      const prepared = await this.prepare(input, request, language);
      const { done } = await this.startDraft(prepared, usable.id, researched);
      return { packageId: usable.id, done };
    }

    // The first post exists: coming back to it (the setup assistant opened
    // again, a second tab) never researches again. Another angle and refined
    // research are asked for by name
    if (mode === 'first' && usable && research) {
      return { packageId: usable.id, done: Promise.resolve() };
    }

    const prepared = await this.prepare(input, request, language);
    const packageId =
      usable?.id ??
      (
        await this._contentStudioService.createPackage({
          organizationId: input.organizationId,
          userId: input.userId,
          name,
        })
      ).id;
    // another angle and refined research steer away from what was chosen
    const previousTopics =
      mode === 'first'
        ? []
        : operations
            .filter(
              (operation) =>
                operation.kind === 'first_post_research' &&
                operation.packageId === packageId &&
                operation.status === 'succeeded'
            )
            .map(
              (operation) =>
                (operation.result as unknown as ContentStudioFirstPostResearch)
                  .topic
            )
            .slice(0, FIRST_POST_PREVIOUS_TOPICS_MAX);
    const { done } = await this.research(prepared, packageId, previousTopics);
    return { packageId, done };
  }

  // Where the first post stands: its package and text, its latest research
  // (with what it found) and draft, and whether a post was scheduled or
  // published since it was first handed off (scheduled: for when), or only
  // saved as a draft
  async getFirstPost(organizationId: string) {
    const operations = await this.operations(organizationId);
    const research = operations.find(
      (operation) => operation.kind === 'first_post_research'
    );
    if (!research?.packageId) {
      return {
        packageId: null,
        research: null,
        draft: null,
        alternatives: [],
        firstPost: {
          scheduled: false,
          published: false,
          scheduledFor: null,
          savedAsDraft: null,
        },
        activated: false,
      };
    }
    const packageId = research.packageId;
    const draft = operations.find(
      (operation) =>
        operation.kind === 'first_post_draft' &&
        operation.packageId === packageId &&
        operation.startedAt >= research.startedAt
    );
    const content = await this._contentStudioService
      .getPackage(organizationId, packageId)
      .catch(() => null);
    const text = content?.draft.copy.global.thread[0]?.text ?? '';
    const researchState = contentStudioAIOperationState(research);
    const draftState = draft ? contentStudioAIOperationState(draft) : null;
    const handoff =
      await this._contentStudioActivationRepository.getFirstHandoffOfPackage(
        organizationId,
        packageId
      );
    // one row at most for each: a post published, and the first one still
    // scheduled (its date is said on the success)
    const [publishedPost, scheduledPost] = handoff
      ? await Promise.all([
          this._contentStudioActivationRepository.getFirstPublishedSince(
            organizationId,
            handoff.createdAt
          ),
          this._contentStudioActivationRepository.getFirstScheduledSince(
            organizationId,
            handoff.createdAt
          ),
        ])
      : [null, null];
    const scheduled = !!scheduledPost;
    const published = !!publishedPost;
    // scheduled and not published yet: when it goes out, said on the success
    const scheduledFor = scheduled && !published ? scheduledPost : null;
    // saved in the composer as a draft only: progress, not activation. Its
    // group opens the same post in the composer again
    const savedAsDraft =
      handoff && !scheduled && !published
        ? await this._contentStudioActivationRepository.getLatestDraftSince(
            organizationId,
            handoff.createdAt
          )
        : null;
    return {
      packageId,
      package: content
        ? {
            name: content.name,
            draftVersion: content.draftVersion,
            archived: !!content.archivedAt,
            text,
          }
        : null,
      research: {
        operationId: research.id,
        // the draft starts right after: a moment without one is no failure
        completedAt: research.completedAt,
        ...researchState,
        ...(researchState.status === 'succeeded'
          ? { result: research.result }
          : {}),
      },
      draft:
        draft && draftState
          ? {
              operationId: draft.id,
              ...draftState,
              // the draft is in the package as it was made
              ...(draftState.status === 'succeeded'
                ? {
                    applied:
                      (draft.result as unknown as ContentStudioFirstPostDraft)
                        ?.text === text,
                  }
                : {}),
            }
          : null,
      alternatives: this.alternatives(operations, packageId, text),
      firstPost: {
        scheduled,
        published,
        scheduledFor: scheduledFor
          ? { publishDate: scheduledFor.publishDate }
          : null,
        savedAsDraft: savedAsDraft
          ? {
              publishDate: savedAsDraft.publishDate,
              group: savedAsDraft.group,
              createdAt: savedAsDraft.createdAt,
            }
          : null,
      },
      activated: scheduled || published,
    };
  }

  // Every draft made for the package, newest first, each with the research
  // it was written from: the research read next in that order, the one that
  // started last before it
  private alternatives(
    operations: Awaited<
      ReturnType<ContentStudioActivationService['operations']>
    >,
    packageId: string,
    text: string
  ): ContentStudioFirstPostAlternative[] {
    const mine = operations.filter(
      (operation) =>
        operation.packageId === packageId && operation.status === 'succeeded'
    );
    return mine
      .flatMap((draft, index) => {
        if (draft.kind !== 'first_post_draft') {
          return [];
        }
        const draftText =
          (draft.result as unknown as ContentStudioFirstPostDraft | null)
            ?.text ?? '';
        const research = mine
          .slice(index + 1)
          .find((operation) => operation.kind === 'first_post_research');
        return [
          {
            operationId: draft.id,
            completedAt: draft.completedAt,
            text: draftText,
            research: research
              ? (research.result as unknown as ContentStudioFirstPostResearch)
              : null,
            current: !!draftText && draftText === text,
          },
        ];
      })
      .filter((alternative) => !!alternative.text)
      .slice(0, ALTERNATIVES_MAX);
  }

  private operations(organizationId: string) {
    return this._contentStudioAIOperationRepository.listOperationStatesForOrganization(
      {
        organizationId,
        kinds: CONTENT_STUDIO_AI_FIRST_POST_OPERATION_KINDS,
        take: STATES_READ,
      }
    );
  }

  // The connection and its model, and the organization context the prompts
  // use: its brand, its latest writing, audience and expertise profiles and
  // its editorial policy, each at its current revision
  private async prepare(
    input: { organizationId: string; userId: string },
    request: ContentStudioFirstPostRequest,
    language: string | null
  ): Promise<Prepared> {
    const connectionId = request.connectionId as string;
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
    const model = getContentStudioAIModel(
      connection.provider,
      connection.defaultModel
    )
      ? (connection.defaultModel as string)
      : getContentStudioAIDefaultModel(connection.provider);
    const capabilities = getContentStudioAIModel(
      connection.provider,
      model
    )?.capabilities;

    const latest = async (repository: {
      listProfilesForOrganization: (input: {
        organizationId: string;
        archived: boolean;
        skip: number;
        take: number;
      }) => Promise<Array<{ id: string }>>;
    }) =>
      (
        await repository.listProfilesForOrganization({
          organizationId: input.organizationId,
          archived: false,
          skip: 0,
          take: 1,
        })
      )[0]?.id;
    const [writingProfileId, audienceProfileId, expertiseProfileId, policy] =
      await Promise.all([
        latest(this._contentStudioWritingProfileRepository),
        latest(this._contentStudioAudienceProfileRepository),
        latest(this._contentStudioExpertiseProfileRepository),
        this._contentStudioEditorialPolicyService.getPolicy(
          input.organizationId
        ),
      ]);
    let resolved: Awaited<
      ReturnType<ContentStudioAIWritingService['resolveProfileContext']>
    >;
    try {
      resolved =
        await this._contentStudioAIWritingService.resolveProfileContext(
          input.organizationId,
          {
            writingProfileId,
            audienceProfileId,
            expertiseProfileId,
            editorialPolicy: !!policy.currentRevision,
          }
        );
    } catch (err) {
      throw fromAIError(err);
    }
    const kit = await this._contentStudioBrandKitService.getBrandKit(
      input.organizationId
    );
    const identity = (
      kit.currentRevision?.content as
        | {
            identity?: {
              brandName: string;
              tagline: string;
              description: string;
            };
          }
        | undefined
    )?.identity;
    return {
      organizationId: input.organizationId,
      userId: input.userId,
      connectionId,
      model,
      structured: !!capabilities?.structuredOutput,
      webSearch: !!capabilities?.webSearch,
      language: language ?? resolved.context.audience?.locale ?? 'en',
      brand: identity
        ? {
            name: identity.brandName,
            tagline: identity.tagline,
            description: identity.description,
          }
        : null,
      context: resolved.context,
      refs: resolved.refs,
    };
  }

  private request(
    prepared: Prepared,
    prompt: ContentStudioFirstPostPrompt,
    schema: { name: string; schema: Record<string, unknown> },
    extra: Pick<ContentStudioAITextRequest, 'maxOutputTokens' | 'webSearch'>
  ): ContentStudioAITextRequest {
    if (
      contentStudioAIFirstPostPromptBytes(prompt) >
      AI_FIRST_POST_PROMPT_MAX_BYTES
    ) {
      throw contextTooLarge();
    }
    return {
      model: prepared.model,
      system: prompt.system,
      prompt: prompt.prompt,
      output: prepared.structured
        ? { type: 'json', schemaName: schema.name, schema: schema.schema }
        : { type: 'text' },
      timeoutMs: FIRST_POST_TIMEOUT_MS,
      ...extra,
    };
  }

  // Starts the research; when it succeeds the draft follows on the server.
  // Answers once the research operation exists, with what settles when both
  // are done (in an object: an async function would wait for a promise it
  // returns)
  private async research(
    prepared: Prepared,
    packageId: string,
    previousTopics: string[]
  ): Promise<{ done: Promise<void> }> {
    const policy = prepared.context
      .editorialPolicy as ContentStudioEditorialPolicyContentV1 | null;
    const findings = await this.findings(prepared.organizationId);
    const input = {
      language: prepared.language,
      today: today(),
      brand: prepared.brand,
      context: prepared.context,
      preferences: policy?.research ?? null,
      findings,
      previousTopics,
      webSearch: prepared.webSearch,
    };
    const prompt = buildContentStudioAIFirstPostResearchPrompt(input);
    const request = this.request(
      prepared,
      prompt,
      {
        name: CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA_NAME,
        schema: CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA,
      },
      {
        maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
        ...(prepared.webSearch ? { webSearch: true } : {}),
      }
    );
    const contentPackage = await this._contentStudioService.getPackage(
      prepared.organizationId,
      packageId
    );
    let started: ContentStudioAIStartedOperation;
    try {
      started = await this._contentStudioAIExecutionService.startForPackage(
        {
          organizationId: prepared.organizationId,
          userId: prepared.userId,
          connectionId: prepared.connectionId,
          packageId,
          kind: 'first_post_research',
          model: prepared.model,
          promptVersion: prompt.promptVersion,
          baseDraftVersion: contentPackage.draftVersion,
          context: { v: 1, ...prepared.refs },
          request,
        },
        {
          validateResult: (result) => {
            assertComplete(result);
            return parseContentStudioFirstPostResearch(result.text, input);
          },
          keepResult: true,
        }
      );
    } catch (err) {
      throw fromAIError(err);
    }
    const done = started.done
      .then(
        (result) =>
          this.draft(
            prepared,
            packageId,
            parseContentStudioFirstPostResearch(result.text, input)
          ),
        (err) => this.failed('research', prepared, err)
      )
      .catch((err) => this.failed('draft', prepared, err));
    return { done };
  }

  // Starts the draft of the research: answers once its operation exists,
  // with what settles when the draft is made and put into the package
  private async startDraft(
    prepared: Prepared,
    packageId: string,
    research: ContentStudioFirstPostResearch
  ): Promise<{ done: Promise<void> }> {
    const prompt = buildContentStudioAIFirstPostDraftPrompt({
      language: prepared.language,
      brand: prepared.brand,
      context: prepared.context,
      research,
    });
    const request = this.request(
      prepared,
      prompt,
      {
        name: CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA_NAME,
        schema: CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA,
      },
      { maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS }
    );
    const contentPackage = await this._contentStudioService.getPackage(
      prepared.organizationId,
      packageId
    );
    let started: ContentStudioAIStartedOperation;
    try {
      started = await this._contentStudioAIExecutionService.startForPackage(
        {
          organizationId: prepared.organizationId,
          userId: prepared.userId,
          connectionId: prepared.connectionId,
          packageId,
          kind: 'first_post_draft',
          model: prepared.model,
          promptVersion: prompt.promptVersion,
          baseDraftVersion: contentPackage.draftVersion,
          context: { v: 1, ...prepared.refs },
          request,
        },
        {
          validateResult: (result) => {
            assertComplete(result);
            return parseContentStudioFirstPostDraft(result.text, research);
          },
          keepResult: true,
        }
      );
    } catch (err) {
      throw fromAIError(err);
    }
    const done = started.done
      .then((result) =>
        this.write(
          prepared.organizationId,
          packageId,
          parseContentStudioFirstPostDraft(result.text, research),
          contentPackage.draftVersion
        )
      )
      .catch((err) => this.failed('draft', prepared, err));
    return { done };
  }

  // The draft that follows research on the server. Never rejects
  private async draft(
    prepared: Prepared,
    packageId: string,
    research: ContentStudioFirstPostResearch
  ): Promise<void> {
    try {
      const { done } = await this.startDraft(prepared, packageId, research);
      await done;
    } catch (err) {
      await this.failed('draft', prepared, err);
    }
  }

  // The draft into the package: the text of its first item, its media and
  // any other item kept. Over the package exactly as it was when the draft
  // started (baseDraftVersion): text someone saved since is theirs, and the
  // draft then waits on its operation for "Use the new draft". Without a
  // base (that request), over the package as it is now
  private async write(
    organizationId: string,
    packageId: string,
    draft: ContentStudioFirstPostDraft,
    baseDraftVersion?: number
  ) {
    const current = await this._contentStudioService.getPackage(
      organizationId,
      packageId
    );
    if (
      baseDraftVersion !== undefined &&
      current.draftVersion !== baseDraftVersion
    ) {
      return;
    }
    const [first, ...rest] = current.draft.copy.global.thread;
    const itemId = first?.id ?? randomBytes(8).toString('base64url');
    // a claim of the old text does not hold for the new one
    const base = (
      first
        ? replaceContentPackageItemClaims(current.draft, [itemId], [])
        : current.draft
    ) as ContentPackageDraft;
    await this._contentStudioService.saveDraft({
      organizationId,
      packageId,
      baseDraftVersion: current.draftVersion,
      draft: {
        ...base,
        copy: {
          global: {
            thread: [
              { id: itemId, text: draft.text, mediaIds: first?.mediaIds ?? [] },
              ...rest,
            ],
          },
        },
      },
    });
  }

  // what is needed to tell why a step failed, and nothing else
  private async failed(
    step: 'research' | 'draft',
    prepared: Prepared,
    err: unknown
  ) {
    this._logger.warn(
      `first post ${step} failed: model=${prepared.model} code=${
        err instanceof ContentStudioAIProviderError ? err.code : 'other'
      }`
    );
  }

  // What the organization's feeds found in the last 30 days, newest first:
  // titles and addresses only, never page text
  private async findings(
    organizationId: string
  ): Promise<ContentStudioFirstPostFinding[]> {
    const found =
      await this._contentStudioSourceDiscoveryRepository.listDiscoveriesForOrganization(
        {
          organizationId,
          seenSince: new Date(Date.now() - FINDINGS_WINDOW_MS),
          feedSourceId: null,
          captureState: null,
          skip: 0,
          take: FIRST_POST_FINDINGS_MAX,
        }
      );
    return found
      .filter((entry) => !!entry.discoveredSource.canonicalUrl)
      .map((entry) => ({
        title: entry.entryTitle || entry.discoveredSource.name,
        url: entry.discoveredSource.canonicalUrl as string,
        feed: entry.feedSource.name,
        publishedAt: day(entry.publishedAt),
      }));
  }

  private text(value: unknown, max: number) {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw invalidRequest();
    }
    const text = value.trim();
    if (text.length > max || text.includes('\u0000')) {
      throw invalidRequest();
    }
    return text || null;
  }
}
