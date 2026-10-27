import { z } from 'zod';

// The providers a Content Studio AI connection can belong to, and the exact
// credential and models each one takes. A connection keeps its provider for
// life. No SDK or network here: clients are made per call by the provider
// adapters
export const CONTENT_STUDIO_AI_PROVIDERS = [
  'openai',
  'openrouter',
  'anthropic',
] as const;

export type ContentStudioAIProvider =
  (typeof CONTENT_STUDIO_AI_PROVIDERS)[number];

export const AI_API_KEY_MIN = 8;
export const AI_API_KEY_MAX = 512;

// Printable ASCII without the space (0x21-0x7E): no whitespace, newline or NUL.
// No vendor prefix is assumed and nothing is trimmed: a key is used exactly as
// it was given
const API_KEY = /^[\x21-\x7e]+$/;

const apiKey = z
  .string()
  .min(AI_API_KEY_MIN)
  .max(AI_API_KEY_MAX)
  .regex(API_KEY);

const apiKeyCredential = z.object({ apiKey }).strict();

// An Anthropic key that is not scoped to a workspace (a personal or service
// account key) must name the workspace on every request, in the
// anthropic-workspace-id header. The id is the Console's workspace id
// (wrkspc_...); it is not secret, but it is kept sealed with the key it
// belongs to
export const AI_WORKSPACE_ID_MAX = 128;
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9_-]+$/;
const anthropicCredential = z
  .object({
    apiKey,
    workspaceId: z
      .string()
      .max(AI_WORKSPACE_ID_MAX)
      .regex(WORKSPACE_ID)
      .optional(),
  })
  .strict();

export interface ContentStudioAICredential {
  apiKey: string;
  // Anthropic only
  workspaceId?: string;
}

const CREDENTIAL_SCHEMAS: Record<
  ContentStudioAIProvider,
  typeof apiKeyCredential | typeof anthropicCredential
> = {
  openai: apiKeyCredential,
  openrouter: apiKeyCredential,
  anthropic: anthropicCredential,
};

export type ContentStudioAICredentialErrorCode =
  | 'INVALID'
  | 'UNREADABLE'
  | 'UNAVAILABLE'
  | 'INVALID_CONTEXT';

const ERROR_MESSAGES: Record<ContentStudioAICredentialErrorCode, string> = {
  INVALID: 'The AI connection credential is invalid',
  UNREADABLE: 'The stored AI connection credential cannot be read',
  UNAVAILABLE: 'AI connection credentials are not available',
  INVALID_CONTEXT: 'The AI connection credential context is invalid',
};

// Fixed messages and no `cause`: never the key, part of it, its length or
// the sealed envelope
export class ContentStudioAICredentialError extends Error {
  constructor(readonly code: ContentStudioAICredentialErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioAICredentialError';
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

// What a model can do. text is always true; structuredOutput says whether
// the provider documents JSON schema output for it
export interface ContentStudioAIModelInfo {
  id: string;
  label: string;
  capabilities: {
    text: true;
    structuredOutput: boolean;
  };
}

export type ContentStudioAICredentialField =
  | { name: 'apiKey'; label: string; secret: true; required: true }
  | { name: 'workspaceId'; label: string; secret: false; required: false };

// What the settings screen may know about a provider: names, the fields to
// ask for and the curated models. No endpoint, SDK option, environment name,
// example key or price
export interface ContentStudioAIProviderInfo {
  provider: ContentStudioAIProvider;
  displayName: string;
  credentialFields: ContentStudioAICredentialField[];
  defaultModel: string;
  models: ContentStudioAIModelInfo[];
}

const DISPLAY_NAMES: Record<ContentStudioAIProvider, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};

// The only models a connection may use, by the exact id of their provider,
// as documented by OpenAI, OpenRouter and Anthropic (checked 2026-10-27). A model belongs to
// the provider it is listed under: an OpenAI id is not an OpenRouter id. No
// discovery and no user supplied ids
const MODELS: Record<
  ContentStudioAIProvider,
  readonly ContentStudioAIModelInfo[]
> = {
  openai: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      capabilities: { text: true, structuredOutput: true },
    },
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      capabilities: { text: true, structuredOutput: true },
    },
  ],
  openrouter: [
    {
      id: 'openai/gpt-6.1-sol',
      label: 'GPT-6.1 Sol (OpenAI)',
      capabilities: { text: true, structuredOutput: true },
    },
    {
      id: 'google/gemini-3.8-flash',
      label: 'Gemini 3.8 Flash (Google)',
      capabilities: { text: true, structuredOutput: true },
    },
    // OpenRouter does not list response_format for it
    {
      id: 'openai/gpt-6-luna',
      label: 'GPT-6 Luna (OpenAI)',
      capabilities: { text: true, structuredOutput: false },
    },
  ],
  // The Claude API has structured outputs (output_config.format), but the
  // pinned Anthropic SDK (0.57.0) does not type it yet, so the adapter does
  // not offer JSON output for these models
  anthropic: [
    {
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      capabilities: { text: true, structuredOutput: false },
    },
    {
      id: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5',
      capabilities: { text: true, structuredOutput: false },
    },
    // there is no Haiku 5.5: Haiku 4.5 is the current small model
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      capabilities: { text: true, structuredOutput: false },
    },
  ],
};

// The model a new connection gets when none is chosen
const DEFAULT_MODELS: Record<ContentStudioAIProvider, string> = {
  openai: 'gpt-6.1-sol',
  openrouter: 'openai/gpt-6.1-sol',
  anthropic: 'claude-opus-5-5',
};

const copyModel = (model: ContentStudioAIModelInfo) => ({
  id: model.id,
  label: model.label,
  capabilities: {
    text: model.capabilities.text,
    structuredOutput: model.capabilities.structuredOutput,
  },
});

const credentialFields = (
  provider: ContentStudioAIProvider
): ContentStudioAICredentialField[] => [
  { name: 'apiKey', label: 'API key', secret: true, required: true },
  ...(provider === 'anthropic'
    ? [
        {
          name: 'workspaceId' as const,
          label: 'Workspace ID',
          secret: false as const,
          required: false as const,
        },
      ]
    : []),
];

const providerInfo = (
  provider: ContentStudioAIProvider
): ContentStudioAIProviderInfo => ({
  provider,
  displayName: DISPLAY_NAMES[provider],
  credentialFields: credentialFields(provider),
  defaultModel: DEFAULT_MODELS[provider],
  models: MODELS[provider].map(copyModel),
});

// A new copy on every call, in catalog order
export const listContentStudioAIProviders = (): ContentStudioAIProviderInfo[] =>
  CONTENT_STUDIO_AI_PROVIDERS.map(providerInfo);

export const isContentStudioAIProvider = (
  value: unknown
): value is ContentStudioAIProvider =>
  typeof value === 'string' &&
  (CONTENT_STUDIO_AI_PROVIDERS as readonly string[]).includes(value);

// A credential as given for a new or replaced connection; anything else
// (another provider, extra fields, a malformed key) is INVALID
export function parseContentStudioAICredential(
  provider: unknown,
  input: unknown
): ContentStudioAICredential {
  if (!isContentStudioAIProvider(provider)) {
    throw new ContentStudioAICredentialError('INVALID');
  }
  const result = CREDENTIAL_SCHEMAS[provider].safeParse(input);
  if (!result.success) {
    throw new ContentStudioAICredentialError('INVALID');
  }
  return result.data as ContentStudioAICredential;
}

export const getContentStudioAIProvider = (
  provider: unknown
): ContentStudioAIProviderInfo | undefined =>
  isContentStudioAIProvider(provider) ? providerInfo(provider) : undefined;

export const getContentStudioAIDefaultModel = (
  provider: ContentStudioAIProvider
) => DEFAULT_MODELS[provider];

// The model with exactly this id in this provider's list, as a copy
export const getContentStudioAIModel = (
  provider: unknown,
  model: unknown
): ContentStudioAIModelInfo | undefined => {
  if (!isContentStudioAIProvider(provider) || typeof model !== 'string') {
    return undefined;
  }
  const found = MODELS[provider].find((entry) => entry.id === model);
  return found ? copyModel(found) : undefined;
};

export const isContentStudioAIModelSupported = (
  provider: unknown,
  model: unknown
) => getContentStudioAIModel(provider, model) !== undefined;
