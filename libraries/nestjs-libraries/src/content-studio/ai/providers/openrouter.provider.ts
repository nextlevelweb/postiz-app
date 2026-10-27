import OpenAI from 'openai';
import { ContentStudioAICredential } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  ContentStudioOpenAISdk,
  createContentStudioChatCompletion,
  toValidationFailure,
} from '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider';
import { ContentStudioAIProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// OpenRouter's OpenAI compatible API. Fixed, never configurable and never read
// from the environment. No attribution headers: they are optional
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// The current API key's own record: answers only to a valid key. The model
// list is public and proves nothing about the key
const OPENROUTER_KEY_PATH = '/key';
// One attempt per request, at most 30 seconds
const OPENROUTER_TIMEOUT_MS = 30_000;

const SDK: ContentStudioOpenAISdk = { OpenAI };

// A new client for each call, with every environment backed option of the
// OpenAI SDK given explicitly; the architecture guard holds every OpenAI
// client to this literal
const openRouterClient = (
  credential: ContentStudioAICredential,
  sdk: ContentStudioOpenAISdk
) =>
  new sdk.OpenAI({
    apiKey: credential.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: 'off',
    maxRetries: 0,
    timeout: OPENROUTER_TIMEOUT_MS,
  });

// The key endpoint answers { data: { ...key metadata } } (a list, such as
// the model list's data, is not a key record); nothing of it is kept or
// returned
const isKeyRecord = (value: unknown) => {
  const data =
    typeof value === 'object' && value !== null
      ? (value as { data?: unknown }).data
      : undefined;
  return typeof data === 'object' && data !== null && !Array.isArray(data);
};

// An OpenRouter connection. The key stays in this closure; each call makes
// its own client and nothing is kept between calls
export function createOpenRouterProviderAdapter(
  credential: ContentStudioAICredential,
  sdk: ContentStudioOpenAISdk = SDK
): ContentStudioAIProviderAdapter {
  return {
    provider: 'openrouter',
    // the model list is public, so only the key is checked
    async validateConnection() {
      try {
        const record = await openRouterClient(credential, sdk).get<unknown>(
          OPENROUTER_KEY_PATH
        );
        return isKeyRecord(record)
          ? { ok: true }
          : { ok: false, code: 'INVALID_RESPONSE' };
      } catch (err) {
        return toValidationFailure(err);
      }
    },
    async generateText(request) {
      return createContentStudioChatCompletion(
        () => openRouterClient(credential, sdk),
        'openrouter',
        request
      );
    },
  };
}
