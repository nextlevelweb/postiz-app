'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  ContentStudioRequestError,
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// Brand & AI: AI connections and the editorial context of the organization.
// Every cache key below is a fixed path, a page number or a server id. An API
// key is never part of one: it is only ever a parameter of the two calls that
// send it, and no answer contains it

// --- AI connections ---

export interface ContentStudioAIModel {
  id: string;
  label: string;
  capabilities: { text: boolean; structuredOutput: boolean };
}

export interface ContentStudioAIProviderInfo {
  provider: string;
  displayName: string;
  credentialFields: Array<{
    name: string;
    label: string;
    secret: boolean;
    required: boolean;
  }>;
  defaultModel: string;
  models: ContentStudioAIModel[];
}

// What the server says about a connection. There is no field for its key:
// the server never sends one
export interface ContentStudioAIConnection {
  id: string;
  name: string;
  provider: string;
  defaultModel: string | null;
  disabled: boolean;
  credentialPresent: boolean;
  credentialUpdatedAt: string;
  lastValidatedAt: string | null;
  lastValidationStatus: string | null;
  lastValidationCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContentStudioAITestResult =
  | { ok: true }
  | { ok: false; code: string | null };

export const AI_PROVIDERS_PATH = '/content-studio/ai/providers';
export const AI_CONNECTIONS_PATH = '/content-studio/ai/connections';
export const AI_CONNECTION_NAME_MAX = 100;

const connectionPath = (id: string) =>
  `${AI_CONNECTIONS_PATH}/${encodeURIComponent(id)}`;

// The credential as the server takes it: the key, and for an Anthropic key
// that is not scoped to a workspace, the workspace id. A blank id is left out;
// a provider without a key (Codex) gets an empty credential
export const aiCredential = (apiKey: string, workspaceId?: string) =>
  !apiKey
    ? {}
    : workspaceId?.trim()
    ? { apiKey, workspaceId: workspaceId.trim() }
    : { apiKey };

// What the AI connections and the setup assistant show about a connection:
// Ready only after a test of the key and the model succeeded. A connection
// that was never tested is only connected; one whose last test failed needs
// attention
export type ContentStudioAIConnectionHealth =
  | 'ready'
  | 'attention'
  | 'untested';
export const aiConnectionHealth = (
  connection: Pick<ContentStudioAIConnection, 'lastValidationStatus'>
): ContentStudioAIConnectionHealth =>
  connection.lastValidationStatus === 'valid'
    ? 'ready'
    : connection.lastValidationStatus
    ? 'attention'
    : 'untested';

// A model the provider's catalog no longer offers (its calls then use the
// provider's recommended model until another is chosen)
export const isRetiredAIModel = (
  connection: Pick<ContentStudioAIConnection, 'defaultModel'>,
  provider: ContentStudioAIProviderInfo | undefined
) =>
  !!connection.defaultModel &&
  !!provider &&
  !provider.models.some((model) => model.id === connection.defaultModel);

export const useContentStudioAIProviders = () => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioAIProviderInfo[]>(fetch, path),
    [fetch]
  );
  return useSWR(AI_PROVIDERS_PATH, load, swrOptions);
};

export const useContentStudioAIConnections = () => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioAIConnection[]>(fetch, path),
    [fetch]
  );
  return useSWR(AI_CONNECTIONS_PATH, load, swrOptions);
};

// Each write is one request, never retried, and then reloads the list by its
// fixed key. The key of a new or replaced credential goes straight into the
// request body and nowhere else
export const useContentStudioAIConnectionActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  const refresh = useCallback(() => mutate(AI_CONNECTIONS_PATH), [mutate]);

  return useMemo(
    () => ({
      // the new connection, so it can be tested right away
      createConnection: async (
        input: { name: string; provider: string; defaultModel: string },
        apiKey: string,
        workspaceId?: string
      ) => {
        const created = await request<ContentStudioAIConnection>(
          fetch,
          AI_CONNECTIONS_PATH,
          {
            method: 'POST',
            body: JSON.stringify({
              name: input.name,
              provider: input.provider,
              credential: aiCredential(apiKey, workspaceId),
              defaultModel: input.defaultModel,
            }),
          }
        );
        await refresh();
        return created;
      },
      updateConnection: async (
        id: string,
        input: { name: string; defaultModel: string }
      ) => {
        await request<ContentStudioAIConnection>(fetch, connectionPath(id), {
          method: 'PATCH',
          body: JSON.stringify(input),
        });
        await refresh();
      },
      replaceCredential: async (
        id: string,
        apiKey: string,
        workspaceId?: string
      ) => {
        await request<ContentStudioAIConnection>(
          fetch,
          `${connectionPath(id)}/credential`,
          {
            method: 'PUT',
            body: JSON.stringify({
              credential: aiCredential(apiKey, workspaceId),
            }),
          }
        );
        await refresh();
      },
      disableConnection: async (id: string) => {
        await request(fetch, `${connectionPath(id)}/disable`, {
          method: 'POST',
        });
        await refresh();
      },
      enableConnection: async (id: string) => {
        await request(fetch, `${connectionPath(id)}/enable`, {
          method: 'POST',
        });
        await refresh();
      },
      // archiving removes the stored key for good: there is no restore
      removeConnection: async (id: string) => {
        await request(fetch, `${connectionPath(id)}/archive`, {
          method: 'POST',
        });
        await refresh();
      },
      testConnection: async (id: string) => {
        try {
          return await request<ContentStudioAITestResult>(
            fetch,
            `${connectionPath(id)}/test`,
            { method: 'POST' }
          );
        } finally {
          // the last test result is shown on the list
          await refresh();
        }
      },
    }),
    [fetch, refresh]
  );
};

// --- named profiles: writing, audience and expertise ---

export const WRITING_PROFILES_PATH = '/content-studio/writing-profiles';
export const AUDIENCE_PROFILES_PATH = '/content-studio/audience-profiles';
export const EXPERTISE_PROFILES_PATH = '/content-studio/expertise-profiles';
export const EDITORIAL_POLICY_PATH = '/content-studio/editorial-policy';
export const PROFILE_NAME_MAX = 100;

export type ContentStudioProfilesPath =
  | typeof WRITING_PROFILES_PATH
  | typeof AUDIENCE_PROFILES_PATH
  | typeof EXPERTISE_PROFILES_PATH;

export interface ContentStudioProfileSummary {
  id: string;
  name: string;
  latestRevisionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentStudioProfileList {
  pages: number;
  results: ContentStudioProfileSummary[];
}

export interface ContentStudioProfileRevisionSummary {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: string;
}

export interface ContentStudioProfileRevision<T>
  extends ContentStudioProfileRevisionSummary {
  content: T;
}

export interface ContentStudioProfileDetail<T>
  extends ContentStudioProfileSummary {
  currentRevision: ContentStudioProfileRevision<T>;
}

export interface ContentStudioRevisionPage {
  pages: number;
  results: ContentStudioProfileRevisionSummary[];
}

export interface ContentStudioSaveRevisionResult<T> {
  created: boolean;
  revision: ContentStudioProfileRevision<T>;
}

export const profilesListPath = (
  base: ContentStudioProfilesPath,
  archived: boolean,
  page: number
) => `${base}?page=${page}&archived=${archived}`;
export const profilePath = (base: ContentStudioProfilesPath, id: string) =>
  `${base}/${encodeURIComponent(id)}`;

// One summary page: the content is loaded only for the profile opened
export const useContentStudioProfiles = (
  base: ContentStudioProfilesPath,
  archived: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioProfileList>(fetch, path),
    [fetch]
  );
  return useSWR(profilesListPath(base, archived, page), load, swrOptions);
};

export const useContentStudioProfile = <T>(
  base: ContentStudioProfilesPath,
  id: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioProfileDetail<T>>(fetch, path),
    [fetch]
  );
  return useSWR(id ? profilePath(base, id) : null, load, swrOptions);
};

// Revision pages and one revision, of a named profile or (with no id) of
// the editorial policy
const historyBase = (base: string, id?: string) =>
  id ? `${base}/${encodeURIComponent(id)}` : base;

export const useContentStudioRevisionPage = (
  base: string,
  id: string | undefined,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioRevisionPage>(fetch, path),
    [fetch]
  );
  return useSWR(
    `${historyBase(base, id)}/revisions?page=${page}`,
    load,
    swrOptions
  );
};

export const useContentStudioRevisionDetail = <T>(
  base: string,
  id: string | undefined,
  revisionId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioProfileRevision<T>>(fetch, path),
    [fetch]
  );
  return useSWR(
    revisionId
      ? `${historyBase(base, id)}/revisions/${encodeURIComponent(revisionId)}`
      : null,
    load,
    swrOptions
  );
};

// Profile writes: one request each, never retried (a revision request
// repeated after a timeout could save twice), then the lists, the profile and
// its history reload. A conflict is reported, never resolved by saving again
export const useContentStudioProfileActions = (
  base: ContentStudioProfilesPath
) => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  const refresh = useCallback(
    (id?: string) =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith(`${base}?`) ||
            (!!id &&
              (key === profilePath(base, id) ||
                key.startsWith(`${profilePath(base, id)}/revisions?`))))
      ),
    [mutate, base]
  );

  return useMemo(
    () => ({
      createProfile: async <T>(name: string, content: T) => {
        const created = await request<ContentStudioProfileDetail<T>>(
          fetch,
          base,
          { method: 'POST', body: JSON.stringify({ name, content }) }
        );
        await refresh(created.id);
        return created;
      },
      renameProfile: async (id: string, name: string) => {
        await request(fetch, profilePath(base, id), {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        await refresh(id);
      },
      saveRevision: async <T>(
        id: string,
        baseRevisionNumber: number,
        content: T
      ) => {
        const result = await request<ContentStudioSaveRevisionResult<T>>(
          fetch,
          `${profilePath(base, id)}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({ baseRevisionNumber, content }),
          }
        );
        await refresh(id);
        return result;
      },
      archiveProfile: async (id: string) => {
        await request(fetch, `${profilePath(base, id)}/archive`, {
          method: 'POST',
        });
        await refresh(id);
      },
      restoreProfile: async (id: string) => {
        await request(fetch, `${profilePath(base, id)}/restore`, {
          method: 'POST',
        });
        await refresh(id);
      },
    }),
    [fetch, refresh, base]
  );
};

// --- editorial policy: one per organization, no id ---

export interface ContentStudioEditorialPolicyState<T> {
  latestRevisionNumber: number;
  currentRevision: ContentStudioProfileRevision<T> | null;
}

export const useContentStudioEditorialPolicy = <T>() => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) =>
      request<ContentStudioEditorialPolicyState<T>>(fetch, path),
    [fetch]
  );
  return useSWR(EDITORIAL_POLICY_PATH, load, swrOptions);
};

export const useContentStudioEditorialPolicyActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  return useMemo(
    () => ({
      // base 0 is the first save, which creates the policy
      saveRevision: async <T>(baseRevisionNumber: number, content: T) => {
        const result = await request<
          ContentStudioSaveRevisionResult<T> & { latestRevisionNumber: number }
        >(fetch, `${EDITORIAL_POLICY_PATH}/revisions`, {
          method: 'POST',
          body: JSON.stringify({ baseRevisionNumber, content }),
        });
        await mutate(
          (key) =>
            typeof key === 'string' &&
            (key === EDITORIAL_POLICY_PATH ||
              key.startsWith(`${EDITORIAL_POLICY_PATH}/revisions?`))
        );
        return result;
      },
    }),
    [fetch, mutate]
  );
};

// --- messages: fixed text for every outcome, never a server message ---

type Translate = (key: string, fallback: string) => string;

const codeOf = (error: unknown) =>
  error instanceof ContentStudioRequestError ? error.code : undefined;

export const aiConnectionErrorMessage = (t: Translate, error: unknown) => {
  switch (codeOf(error)) {
    case 'CS_AI_ADMIN_REQUIRED':
      return t(
        'content_studio_ai_error_admin_required',
        'You do not have permission to manage AI connections.'
      );
    case 'CS_AI_PROVIDER_UNSUPPORTED':
      return t(
        'content_studio_ai_error_provider_unsupported',
        'This AI provider is not supported.'
      );
    case 'CS_AI_MODEL_UNSUPPORTED':
      return t(
        'content_studio_ai_error_model_unsupported',
        'This AI model is not supported for this provider.'
      );
    case 'CS_AI_CREDENTIAL_INVALID':
      return t('content_studio_ai_error_credential', 'The API key is invalid.');
    case 'CS_AI_SECRET_STORE_UNAVAILABLE':
      return t(
        'content_studio_ai_error_secret_store',
        'Secure credential storage is temporarily unavailable.'
      );
    case 'CS_AI_CONNECTION_DISABLED':
      return t(
        'content_studio_ai_error_disabled',
        'This AI connection is disabled.'
      );
    case 'CS_AI_CONNECTION_CREDENTIAL_INVALID':
      return t(
        'content_studio_ai_error_stored_credential',
        'The stored credential cannot be read. Replace the API key and try again.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_ai_error_not_found', 'AI connection not found.');
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    default:
      return t(
        'content_studio_ai_error',
        'Could not update the AI connection.'
      );
  }
};

// What a test answer means, by its normalized code only
export const aiTestResultMessage = (
  t: Translate,
  result: ContentStudioAITestResult
) => {
  if (result.ok) {
    return t('content_studio_ai_test_ok', 'Connection works.');
  }
  // `in` narrows the union whatever the compiler options
  return aiValidationCodeMessage(t, 'code' in result ? result.code : null);
};

export const aiValidationCodeMessage = (t: Translate, code: string | null) => {
  switch (code) {
    case 'AUTH_FAILED':
      return t(
        'content_studio_ai_test_auth_failed',
        "We couldn't use this API key. Check the key and try again."
      );
    case 'WORKSPACE_REQUIRED':
      return t(
        'content_studio_ai_test_workspace',
        'This Anthropic key is not tied to a workspace. Add the workspace ID (it starts with wrkspc_) with Replace key, or use a key created inside a workspace.'
      );
    case 'RATE_LIMITED':
      return t(
        'content_studio_ai_test_rate_limited',
        'The provider is rate limiting this connection. Try again later.'
      );
    case 'QUOTA_EXCEEDED':
      return t(
        'content_studio_ai_test_quota',
        'The key works, but the provider account has no API credit left, so nothing can be generated. Add credit in your provider account, then test again.'
      );
    case 'PROVIDER_UNAVAILABLE':
      return t(
        'content_studio_ai_test_unavailable',
        'The provider is temporarily unavailable.'
      );
    case 'TIMEOUT':
      return t(
        'content_studio_ai_test_timeout',
        'The provider did not respond in time.'
      );
    case 'MODEL_UNAVAILABLE':
      return t(
        'content_studio_ai_test_model',
        'This model is not available for this connection. Choose another model with Edit.'
      );
    case 'INVALID_RESPONSE':
      return t(
        'content_studio_ai_test_invalid_response',
        'The provider returned an unexpected response.'
      );
    case 'REQUEST_REJECTED':
      return t(
        'content_studio_ai_test_rejected',
        'The provider refused the request. Check the API key and the model, then test again.'
      );
    case 'CONTENT_REJECTED':
      return t(
        'content_studio_ai_test_content_rejected',
        'The provider rejected the request content.'
      );
    default:
      return t(
        'content_studio_ai_test_failed',
        'The connection test did not succeed.'
      );
  }
};

export type ContentStudioProfileKind =
  | 'writing'
  | 'audience'
  | 'expertise'
  | 'editorial';

export const profileErrorMessage = (
  t: Translate,
  kind: ContentStudioProfileKind,
  error: unknown
) => {
  switch (codeOf(error)) {
    case 'CS_EDITORIAL_POLICY_ADMIN_REQUIRED':
      return t(
        'content_studio_policy_require_approval_admin',
        'Only organization administrators can change this.'
      );
    case 'CS_PROFILE_INVALID':
      return t(
        'content_studio_profile_error_invalid',
        'Some values are not valid. Check the fields and try again.'
      );
    case 'CS_PROFILE_TOO_LARGE':
      return t(
        'content_studio_profile_error_too_large',
        'This is too long to save. Shorten some fields and try again.'
      );
    case 'CS_PROFILE_ARCHIVED':
      return t(
        'content_studio_profile_error_archived',
        'This profile is archived. Restore it to edit it.'
      );
    case 'CS_PROFILE_REVISION_CONFLICT':
      return kind === 'editorial'
        ? t(
            'content_studio_policy_conflict',
            'The editorial policy changed elsewhere. Reload the latest version before saving.'
          )
        : t(
            'content_studio_profile_conflict',
            'This profile changed elsewhere. Reload the latest version before saving.'
          );
    case 'CS_PROFILE_INTEGRITY_ERROR':
      return kind === 'editorial'
        ? t(
            'content_studio_policy_integrity',
            'Stored editorial policy data could not be verified. Please contact an administrator.'
          )
        : t(
            'content_studio_profile_integrity',
            'Stored profile data could not be verified. Please contact an administrator.'
          );
    case 'CS_NOT_FOUND':
      return t(
        'content_studio_profile_error_not_found',
        'This profile could not be found.'
      );
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    default:
      return t('content_studio_profile_error', 'Could not save the changes.');
  }
};

export const isRevisionConflict = (error: unknown) =>
  codeOf(error) === 'CS_PROFILE_REVISION_CONFLICT';
