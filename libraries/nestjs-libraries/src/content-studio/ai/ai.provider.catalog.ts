import { z } from 'zod';

// The providers a Content Studio AI connection can belong to, and the exact
// credential each one takes. A connection keeps its provider for life. No SDK,
// model or network here: clients are made per call by the provider adapters
export const CONTENT_STUDIO_AI_PROVIDERS = ['openai', 'openrouter'] as const;

export type ContentStudioAIProvider =
  (typeof CONTENT_STUDIO_AI_PROVIDERS)[number];

export const AI_API_KEY_MIN = 8;
export const AI_API_KEY_MAX = 512;

// Printable ASCII without the space (0x21-0x7E): no whitespace, newline or NUL.
// No vendor prefix is assumed and nothing is trimmed: a key is used exactly as
// it was given
const API_KEY = /^[\x21-\x7e]+$/;

const apiKeyCredential = z
  .object({
    apiKey: z.string().min(AI_API_KEY_MIN).max(AI_API_KEY_MAX).regex(API_KEY),
  })
  .strict();

export type ContentStudioAICredential = z.output<typeof apiKeyCredential>;

const CREDENTIAL_SCHEMAS: Record<
  ContentStudioAIProvider,
  typeof apiKeyCredential
> = {
  openai: apiKeyCredential,
  openrouter: apiKeyCredential,
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
  return result.data;
}
