import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { ContentStudioAIOperationContext } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  ContentStudioAITextRequest,
  ContentStudioAITextResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// Provenance of an AI operation without its text. Every text (system prompt,
// prompt, generated result) is reduced to the SHA-256 of its canonical JSON
// string: JSON.stringify escapes a lone surrogate, so two different texts can
// never hash alike the way their UTF-8 bytes could. The descriptors hold
// hashes and ids only and are hashed once more; neither they nor any text
// are stored

const textHash = (text: string) => sha256Hex(canonicalJson(text));

// What an operation ran on: a package draft at a version, one saved design
// revision (P6-02), or the organization itself (the guided setup)
export type ContentStudioAIRequestTarget =
  | { packageId: string; baseDraftVersion: number }
  | { designRevisionId: string }
  | { scope: 'organization' };

export type ContentStudioAIRequestProvenance = {
  kind: string;
  provider: string;
  model: string;
  promptVersion: string;
  context: ContentStudioAIOperationContext;
  request: ContentStudioAITextRequest;
} & ContentStudioAIRequestTarget;

// Throws CanonicalJsonError for what cannot be hashed deterministically (a
// JSON schema with fractions or non-plain values); the caller refuses it.
// canonicalJson takes safe integers only, so a temperature is written as its
// shortest round-trip decimal text
export function contentStudioAIRequestDescriptor(
  input: ContentStudioAIRequestProvenance
) {
  const { request } = input;
  return {
    v: 1,
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    // a package operation's descriptor is exactly what it was before design
    // operations existed
    ...('designRevisionId' in input
      ? { designRevisionId: input.designRevisionId }
      : 'scope' in input
      ? { scope: input.scope }
      : {
          packageId: input.packageId,
          baseDraftVersion: input.baseDraftVersion,
        }),
    context: input.context,
    request: {
      systemHash: textHash(request.system),
      promptHash: textHash(request.prompt),
      output:
        request.output.type === 'json'
          ? {
              type: 'json',
              schemaName: request.output.schemaName,
              schemaHash: sha256Hex(canonicalJson(request.output.schema)),
            }
          : { type: 'text' },
      maxOutputTokens: request.maxOutputTokens,
      temperature:
        request.temperature === undefined ? null : String(request.temperature),
    },
  };
}

export const hashContentStudioAIRequest = (
  input: ContentStudioAIRequestProvenance
) => sha256Hex(canonicalJson(contentStudioAIRequestDescriptor(input)));

// Token usage is left out: it has its own usage row
export function contentStudioAIResultDescriptor(
  result: Pick<
    ContentStudioAITextResult,
    'text' | 'finishReason' | 'providerRequestId'
  >
) {
  return {
    v: 1,
    textHash: textHash(result.text),
    finishReason: result.finishReason,
    providerRequestId: result.providerRequestId ?? null,
  };
}

export const hashContentStudioAIResult = (
  result: Pick<
    ContentStudioAITextResult,
    'text' | 'finishReason' | 'providerRequestId'
  >
) => sha256Hex(canonicalJson(contentStudioAIResultDescriptor(result)));
