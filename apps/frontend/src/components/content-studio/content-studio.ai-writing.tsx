'use client';

import { FC, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import {
  ContentStudioClaim,
  ContentStudioRequestError,
  packageDetailPath,
  request,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  AUDIENCE_PROFILES_PATH,
  ContentStudioAIConnection,
  ContentStudioAIProviderInfo,
  ContentStudioProfilesPath,
  EDITORIAL_POLICY_PATH,
  EXPERTISE_PROFILES_PATH,
  useContentStudioAIConnections,
  useContentStudioAIProviders,
  useContentStudioProfiles,
  useContentStudioRevisionPage,
  WRITING_PROFILES_PATH,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ChoiceField,
  FieldGroup,
  LongTextField,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { ContentStudioSourcePicker } from '@gitroom/frontend/components/content-studio/content-studio.source.picker';

// AI writing in the package workspace: one dialog to choose what to ask, and
// the request that asks it. The server builds the prompt from the saved
// draft, the current revision of each chosen profile and the current version
// of each chosen source, so the dialog loads profile and source names only,
// never their content. Nothing chosen here is kept after the dialog closes:
// there is no default connection, model, profile or source

export const AI_WRITING_INSTRUCTION_MAX = 2000;
export const AI_WRITING_SOURCES_MAX = 5;

export type ContentStudioAIItemOperation =
  | 'generate_item'
  | 'rewrite_item'
  | 'shorten_item'
  | 'expand_item'
  | 'change_tone';

export type ContentStudioAIWritingTarget =
  | { type: 'item'; itemId: string; label: string; hasText: boolean }
  | { type: 'thread' };

// What the user chose. Profiles and sources are ids; the server takes their
// current revision or version. Sources are in the order chosen. There is no
// field for a provider, prompt, key, revision, source version or source text
export interface ContentStudioAIWritingRequest {
  operation: ContentStudioAIItemOperation | 'generate_thread';
  itemId?: string;
  connectionId: string;
  model: string;
  writingProfileId: string | null;
  editorialPolicy: boolean;
  audienceProfileId: string | null;
  expertiseProfileId: string | null;
  sourceIds: string[];
  instruction: string | null;
}

export type ContentStudioAIProposalContent =
  | { type: 'item'; itemId: string; text: string }
  | { type: 'thread'; items: Array<{ itemId: string; text: string }> };

// The exact source capture a suggestion was written from: its version, not
// the source as it is now. Never its text or URLs
export interface ContentStudioAIProposalSource {
  sourceId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  name: string;
  title: string | null;
}

// A suggestion for the draft at baseDraftVersion. It is shown for review and
// never saved by itself. With sources, grounding.claims are the claims of the
// suggested text the server matched to exact blocks of the versions used;
// they enter the draft only when the suggestion is accepted
export interface ContentStudioAIProposal {
  operationId: string;
  baseDraftVersion: number;
  proposal: ContentStudioAIProposalContent;
  grounding?: { claims: ContentStudioClaim[] };
  provenance: { sources: ContentStudioAIProposalSource[] };
}

// One request per action, never retried: a repeated request would be a
// second provider call. Nothing is cached
export const useContentStudioAIWritingApi = () => {
  const fetch = useFetch();
  return useMemo(
    () => ({
      propose: (
        packageId: string,
        baseDraftVersion: number,
        { itemId, ...selection }: ContentStudioAIWritingRequest
      ) =>
        request<ContentStudioAIProposal>(
          fetch,
          `${packageDetailPath(packageId)}/ai/${itemId ? 'item' : 'thread'}`,
          {
            method: 'POST',
            body: JSON.stringify({
              ...selection,
              ...(itemId ? { itemId } : {}),
              baseDraftVersion,
            }),
          }
        ),
    }),
    [fetch]
  );
};

type Translate = (key: string, fallback: string) => string;

// Fixed text for every refusal of an AI writing request, never the server's
// or the provider's message. Undefined for a code the workspace explains
export const aiWritingErrorMessage = (
  t: Translate,
  error: unknown
): string | undefined => {
  const code =
    error instanceof ContentStudioRequestError ? error.code : undefined;
  switch (code) {
    case 'CS_AI_CONNECTION_REQUIRED':
      return t(
        'content_studio_ai_writing_error_connection_required',
        'Connect an AI provider before using AI writing.'
      );
    case 'CS_AI_CONNECTION_DISABLED':
      return t(
        'content_studio_ai_writing_error_disabled',
        'This AI connection is disabled.'
      );
    case 'CS_AI_CONNECTION_CREDENTIAL_INVALID':
      return t(
        'content_studio_ai_writing_error_credential',
        'This AI connection needs a new API key.'
      );
    case 'CS_AI_SECRET_STORE_UNAVAILABLE':
      return t(
        'content_studio_ai_error_secret_store',
        'Secure credential storage is temporarily unavailable.'
      );
    case 'CS_AI_PROVIDER_UNSUPPORTED':
      return t(
        'content_studio_ai_error_provider_unsupported',
        'This AI provider is not supported.'
      );
    case 'CS_AI_MODEL_UNSUPPORTED':
      return t(
        'content_studio_ai_writing_error_model',
        'This model is not available for the selected connection.'
      );
    case 'CS_AI_CONTEXT_NOT_FOUND':
      return t(
        'content_studio_ai_writing_error_context_missing',
        'A selected AI context profile is no longer available.'
      );
    case 'CS_AI_CONTEXT_ARCHIVED':
      return t(
        'content_studio_ai_writing_error_context_archived',
        'A selected AI context profile is archived.'
      );
    case 'CS_AI_CONTEXT_INTEGRITY_ERROR':
      return t(
        'content_studio_ai_writing_error_context_integrity',
        'Selected AI context could not be verified.'
      );
    case 'CS_AI_CONTEXT_TOO_LARGE':
      return t(
        'content_studio_ai_writing_error_context_too_large',
        'The selected AI context is too large.'
      );
    case 'CS_AI_SOURCE_NOT_FOUND':
      return t(
        'content_studio_ai_writing_error_source_missing',
        'A selected source is no longer available.'
      );
    case 'CS_AI_SOURCE_NOT_READY':
      return t(
        'content_studio_ai_writing_error_source_not_ready',
        'A selected source has not been ingested yet.'
      );
    case 'CS_AI_SOURCE_ARCHIVED':
      return t(
        'content_studio_ai_writing_error_source_archived',
        'A selected source is archived.'
      );
    case 'CS_AI_SOURCE_CONTEXT_TOO_LARGE':
      return t(
        'content_studio_ai_writing_error_source_too_large',
        'The selected source context is too large.'
      );
    case 'CS_AI_SOURCE_INTEGRITY_ERROR':
      return t(
        'content_studio_ai_writing_error_source_integrity',
        'Selected source context could not be verified.'
      );
    case 'CS_DRAFT_VERSION_CONFLICT':
      return t(
        'content_studio_ai_writing_error_conflict',
        'The draft changed before AI generation started. Reload and try again.'
      );
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_ai_writing_error_invalid',
        'This AI action cannot be used here. Check the post and the choices and try again.'
      );
    case 'CS_AI_AUTH_FAILED':
      return t(
        'content_studio_ai_test_auth_failed',
        'Authentication failed. Replace the API key and try again.'
      );
    case 'CS_AI_RATE_LIMITED':
      return t(
        'content_studio_ai_test_rate_limited',
        'The provider is rate limiting this connection. Try again later.'
      );
    case 'CS_AI_QUOTA_EXCEEDED':
      return t(
        'content_studio_ai_test_quota',
        'The provider reports that the account has no available quota or credits.'
      );
    case 'CS_AI_PROVIDER_UNAVAILABLE':
      return t(
        'content_studio_ai_test_unavailable',
        'The provider is temporarily unavailable.'
      );
    case 'CS_AI_TIMEOUT':
      return t(
        'content_studio_ai_test_timeout',
        'The provider did not respond in time.'
      );
    case 'CS_AI_MODEL_UNAVAILABLE':
      return t(
        'content_studio_ai_writing_error_model_unavailable',
        'The provider could not use this model.'
      );
    case 'CS_AI_REQUEST_REJECTED':
      return t(
        'content_studio_ai_writing_error_rejected',
        'The provider rejected the request.'
      );
    case 'CS_AI_CONTENT_REJECTED':
      return t(
        'content_studio_ai_test_content_rejected',
        'The provider rejected the request content.'
      );
    case 'CS_AI_GROUNDING_INVALID':
      return t(
        'content_studio_ai_writing_error_grounding_invalid',
        'The AI suggestion cited source material that does not match the selected sources. Try again.'
      );
    case 'CS_AI_INVALID_RESPONSE':
      return t(
        'content_studio_ai_writing_error_invalid_response',
        'The provider returned an unusable suggestion. Try again.'
      );
    case 'CS_AI_OPERATION_FAILED':
      return t(
        'content_studio_ai_writing_error_failed',
        'Could not generate a suggestion.'
      );
    default:
      return undefined;
  }
};

// Usable for writing (and for design suggestions, P6-02): enabled, with a
// stored key, of a provider in the catalog. Anything else is left out, never
// tried
export const usable = (
  connection: ContentStudioAIConnection,
  providers: ContentStudioAIProviderInfo[]
) =>
  !connection.disabled &&
  connection.credentialPresent &&
  providers.some((provider) => provider.provider === connection.provider);

// The connection's own model while its provider still offers it, else the
// provider's default
const initialModel = (
  connection: ContentStudioAIConnection | undefined,
  provider: ContentStudioAIProviderInfo | undefined
) => {
  if (!connection || !provider) {
    return '';
  }
  return provider.models.some((model) => model.id === connection.defaultModel)
    ? (connection.defaultModel as string)
    : provider.defaultModel;
};

export const ProfileChoice: FC<{
  base: ContentStudioProfilesPath;
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}> = ({ base, label, value, onChange, disabled }) => {
  const t = useT();
  // the active profiles, as names only
  const { data } = useContentStudioProfiles(base, false, 1);
  return (
    <ChoiceField
      label={label}
      value={value}
      disabled={disabled}
      options={[
        { value: '', label: t('content_studio_ai_writing_none', 'None') },
        ...(data?.results || []).map((profile) => ({
          value: profile.id,
          label: profile.name,
        })),
      ]}
      onChange={onChange}
    />
  );
};

// The live web pages of the organization with a captured version, by name
// only, found through the Source picker (P8-03): searched by the server and
// paged, so a page beyond the first 20 can be chosen. Checked in the order
// clicked, which is the order the server uses; at most five. A list that
// cannot be loaded leaves AI writing usable without sources
const SourceChoice: FC<{
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}> = ({ value, onChange, disabled }) => {
  const t = useT();
  return (
    <FieldGroup
      label={t('content_studio_ai_sources', 'Sources')}
      hint={t(
        'content_studio_ai_sources_hint',
        'Use selected source material as reference context. Sources are not automatically fact-checked. Up to 5, used in the order you select them.'
      )}
    >
      <ContentStudioSourcePicker
        mode="multiple"
        max={AI_WRITING_SOURCES_MAX}
        value={value}
        onChange={onChange}
        disabled={disabled}
        errorText={t(
          'content_studio_ai_sources_error',
          'Sources could not be loaded. You can still generate without them.'
        )}
        emptyText={t(
          'content_studio_ai_no_sources',
          'No ingested sources yet.'
        )}
      />
    </FieldGroup>
  );
};

// What to ask the AI for one post or the whole thread. onGenerate saves the
// draft first and resolves true once a suggestion is shown. Research sources
// a link named (P8-03) start out chosen; they are ids only, like any choice
export const ContentStudioAIWritingDialog: FC<{
  target: ContentStudioAIWritingTarget;
  onGenerate: (request: ContentStudioAIWritingRequest) => Promise<boolean>;
  close: () => void;
  initialSourceIds?: string[];
}> = ({ target, onGenerate, close, initialSourceIds }) => {
  const t = useT();
  const connections = useContentStudioAIConnections();
  const providers = useContentStudioAIProviders();
  const policy = useContentStudioRevisionPage(
    EDITORIAL_POLICY_PATH,
    undefined,
    1
  );
  const { busy, run } = useSingleFlight();

  const operations = useMemo(() => {
    if (target.type === 'thread') {
      return [];
    }
    const generate = {
      value: 'generate_item',
      label: t('content_studio_ai_generate', 'Generate'),
    };
    // the others work on existing text
    return target.hasText
      ? [
          generate,
          {
            value: 'rewrite_item',
            label: t('content_studio_ai_rewrite', 'Rewrite'),
          },
          {
            value: 'shorten_item',
            label: t('content_studio_ai_shorten', 'Shorten'),
          },
          {
            value: 'expand_item',
            label: t('content_studio_ai_expand', 'Expand'),
          },
          {
            value: 'change_tone',
            label: t('content_studio_ai_change_tone', 'Change tone'),
          },
        ]
      : [generate];
  }, [target, t]);

  const [operation, setOperation] = useState<string>(
    target.type === 'item' && target.hasText ? 'rewrite_item' : 'generate_item'
  );
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [writingProfileId, setWritingProfileId] = useState('');
  const [editorialPolicy, setEditorialPolicy] = useState(false);
  const [audienceProfileId, setAudienceProfileId] = useState('');
  const [expertiseProfileId, setExpertiseProfileId] = useState('');
  const [sourceIds, setSourceIds] = useState<string[]>(() =>
    (initialSourceIds || []).slice(0, AI_WRITING_SOURCES_MAX)
  );
  const [instruction, setInstruction] = useState('');

  if (connections.error || providers.error) {
    return (
      <div className="flex flex-col gap-[16px]">
        <div>
          {t('content_studio_load_error', 'Could not load Content Studio.')}
        </div>
        <div>
          <Button secondary onClick={close}>
            {t('cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    );
  }
  if (!connections.data || !providers.data) {
    return <LoadingComponent />;
  }

  const catalog = providers.data;
  const available = connections.data.filter((connection) =>
    usable(connection, catalog)
  );
  if (!available.length) {
    return (
      <div className="flex flex-col gap-[16px]">
        <div role="status">
          {t(
            'content_studio_ai_writing_connect',
            'Connect an AI provider in Brand & AI.'
          )}
        </div>
        <div className="flex flex-wrap gap-[8px] items-center">
          <Link
            href="/content-studio/intelligence?tab=ai"
            className="underline"
            onClick={close}
          >
            {t('content_studio_brand_ai', 'Brand & AI')}
          </Link>
          <Button secondary onClick={close}>
            {t('cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    );
  }

  const connection =
    available.find((entry) => entry.id === connectionId) || available[0];
  const provider = catalog.find(
    (entry) => entry.provider === connection.provider
  );
  const models = provider?.models || [];
  const chosenModel =
    model && models.some((entry) => entry.id === model)
      ? model
      : initialModel(connection, provider);
  const toneChange = target.type === 'item' && operation === 'change_tone';
  const policyAvailable = !!policy.data?.results.length;
  const trimmed = instruction.trim();
  const ready =
    !!chosenModel &&
    instruction.length <= AI_WRITING_INSTRUCTION_MAX &&
    (!toneChange || !!trimmed);

  const submit = () =>
    run('generate', async () => {
      const generated = await onGenerate({
        operation:
          target.type === 'thread'
            ? 'generate_thread'
            : (operation as ContentStudioAIItemOperation),
        ...(target.type === 'item' ? { itemId: target.itemId } : {}),
        connectionId: connection.id,
        model: chosenModel,
        writingProfileId: writingProfileId || null,
        editorialPolicy: editorialPolicy && policyAvailable,
        audienceProfileId: audienceProfileId || null,
        expertiseProfileId: expertiseProfileId || null,
        sourceIds,
        instruction: trimmed || null,
      });
      if (generated) {
        close();
      }
    });

  const locked = !!busy;
  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <div className="text-textItemBlur">
        {target.type === 'thread'
          ? t(
              'content_studio_ai_thread_hint',
              'Suggests text for every post of the thread. The posts, their order and media stay as they are.'
            )
          : target.label}
      </div>
      {target.type === 'item' && (
        <ChoiceField
          label={t('content_studio_ai_action', 'AI action')}
          value={operation}
          options={operations}
          disabled={locked}
          onChange={setOperation}
        />
      )}
      <ChoiceField
        label={t('content_studio_ai_connection', 'AI connection')}
        value={connection.id}
        disabled={locked}
        options={available.map((entry) => ({
          value: entry.id,
          label: `${entry.name} (${
            catalog.find((info) => info.provider === entry.provider)
              ?.displayName || entry.provider
          })`,
        }))}
        onChange={(next) => {
          setConnectionId(next);
          setModel(null);
        }}
      />
      <ChoiceField
        label={t('content_studio_ai_model', 'Model')}
        value={chosenModel}
        disabled={locked}
        options={models.map((entry) => ({
          value: entry.id,
          label: entry.label,
        }))}
        onChange={setModel}
      />
      <ProfileChoice
        base={WRITING_PROFILES_PATH}
        label={t('content_studio_ai_writing_profile', 'Writing Profile')}
        value={writingProfileId}
        disabled={locked}
        onChange={setWritingProfileId}
      />
      <FieldGroup
        label={t('content_studio_editorial_policy', 'Editorial Policy')}
        hint={
          policyAvailable
            ? undefined
            : t(
                'content_studio_ai_no_policy',
                'No editorial policy has been saved yet.'
              )
        }
      >
        <label className="flex items-center gap-[8px] text-[14px]">
          <input
            type="checkbox"
            checked={editorialPolicy && policyAvailable}
            disabled={locked || !policyAvailable}
            onChange={(e) => setEditorialPolicy(e.target.checked)}
          />
          {t('content_studio_ai_use_policy', 'Use Editorial Policy')}
        </label>
      </FieldGroup>
      <ProfileChoice
        base={AUDIENCE_PROFILES_PATH}
        label={t('content_studio_ai_audience_profile', 'Audience Profile')}
        value={audienceProfileId}
        disabled={locked}
        onChange={setAudienceProfileId}
      />
      <ProfileChoice
        base={EXPERTISE_PROFILES_PATH}
        label={t('content_studio_ai_expertise_profile', 'Expertise Profile')}
        value={expertiseProfileId}
        disabled={locked}
        onChange={setExpertiseProfileId}
      />
      <SourceChoice
        value={sourceIds}
        disabled={locked}
        onChange={setSourceIds}
      />
      <LongTextField
        label={
          toneChange
            ? t('content_studio_ai_tone', 'Tone')
            : t('content_studio_ai_instruction', 'Additional instruction')
        }
        hint={
          toneChange
            ? t(
                'content_studio_ai_tone_hint',
                'Required. Describe the tone, for example "playful" or "formal". Up to 2000 characters.'
              )
            : t(
                'content_studio_ai_instruction_hint',
                'Optional. Up to 2000 characters.'
              )
        }
        value={instruction}
        disabled={locked}
        rows={3}
        onChange={setInstruction}
      />
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_ai_review_hint',
          'The draft is saved first. You review the suggestion before anything changes.'
        )}
      </div>
      <div className="flex flex-wrap gap-[8px]">
        <Button loading={locked} disabled={locked || !ready} onClick={submit}>
          {t('content_studio_ai_generate_suggestion', 'Generate suggestion')}
        </Button>
        <Button secondary disabled={locked} onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  );
};
