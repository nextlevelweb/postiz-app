import {
  canonicalJson,
  CanonicalJsonError,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  contentStudioAIRequestDescriptor,
  contentStudioAIResultDescriptor,
  ContentStudioAIRequestProvenance,
  hashContentStudioAIRequest,
  hashContentStudioAIResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.hash';

const SYSTEM = 'SYSTEM_SECRET_MARKER_123 You write social posts.';
const PROMPT = 'PROMPT_SECRET_MARKER_456 Write about spring.';
const RESULT = 'RESULT_SECRET_MARKER_789 Spring is here.';
const HEX = /^[0-9a-f]{64}$/;

const provenance = (
  overrides: Partial<ContentStudioAIRequestProvenance> = {},
  request: Partial<ContentStudioAIRequestProvenance['request']> = {}
): ContentStudioAIRequestProvenance => ({
  kind: 'generate_item',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  promptVersion: 'cs-item-v1',
  packageId: '55555555-5555-4555-8555-555555555555',
  baseDraftVersion: 3,
  context: { v: 1, itemId: 'item-1' },
  ...overrides,
  request: {
    model: 'gpt-6.1-sol',
    system: SYSTEM,
    prompt: PROMPT,
    output: { type: 'text' },
    maxOutputTokens: 500,
    ...request,
  },
});

const result = (overrides: Record<string, unknown> = {}) => ({
  text: RESULT,
  finishReason: 'stop' as const,
  providerRequestId: 'req_1',
  ...overrides,
});

describe('AI operation request hash', () => {
  const base = hashContentStudioAIRequest(provenance());

  it('H1/H12 is deterministic lowercase 64 character hex', () => {
    expect(base).toMatch(HEX);
    expect(hashContentStudioAIRequest(provenance())).toBe(base);
  });

  it('H2 does not depend on property order', () => {
    const { request, ...rest } = provenance();
    const reordered = {
      request: Object.fromEntries(Object.entries(request).reverse()),
      ...Object.fromEntries(Object.entries(rest).reverse()),
    } as unknown as ContentStudioAIRequestProvenance;
    expect(hashContentStudioAIRequest(reordered)).toBe(base);
  });

  it.each([
    ['H3 the prompt', provenance({}, { prompt: `${PROMPT}!` })],
    ['H4 the system prompt', provenance({}, { system: `${SYSTEM}!` })],
    ['H5 the model', provenance({ model: 'gpt-6-luna' })],
    ['the provider', provenance({ provider: 'openrouter' })],
    ['the kind', provenance({ kind: 'rewrite_item' })],
    ['H6 the prompt version', provenance({ promptVersion: 'cs-item-v2' })],
    [
      'H7 the package',
      provenance({ packageId: '66666666-6666-4666-8666-666666666666' }),
    ],
    ['H8 the draft version', provenance({ baseDraftVersion: 4 })],
    ['H9 the context', provenance({ context: { v: 1, itemId: 'item-2' } })],
    ['H9 no item', provenance({ context: { v: 1 } })],
    [
      'H10 the output type',
      provenance(
        {},
        { output: { type: 'json', schemaName: 'post', schema: {} } }
      ),
    ],
    ['the output limit', provenance({}, { maxOutputTokens: 501 })],
    ['a temperature', provenance({}, { temperature: 0.4 })],
  ])('changes with %s', (_name, changed) => {
    expect(hashContentStudioAIRequest(changed)).not.toBe(base);
  });

  it('H11 changes with the JSON schema and its name, not with its key order', () => {
    const json = (schemaName: string, schema: Record<string, unknown>) =>
      hashContentStudioAIRequest(
        provenance({}, { output: { type: 'json', schemaName, schema } })
      );
    const schema = { type: 'object', required: ['title'] };
    expect(json('post', schema)).toBe(
      json('post', { required: ['title'], type: 'object' })
    );
    expect(json('post', schema)).not.toBe(
      json('post', { type: 'object', required: ['body'] })
    );
    expect(json('post', schema)).not.toBe(json('thread', schema));
  });

  it('tells temperatures apart and refuses a schema it cannot hash exactly', () => {
    const at = (temperature: number) =>
      hashContentStudioAIRequest(provenance({}, { temperature }));
    expect(at(0.4)).toBe(at(0.4));
    expect(at(0.4)).not.toBe(at(0.5));
    expect(at(0)).toBe(at(-0));
    expect(() =>
      hashContentStudioAIRequest(
        provenance(
          {},
          {
            output: {
              type: 'json',
              schemaName: 'post',
              schema: { minimum: 0.5 },
            },
          }
        )
      )
    ).toThrow(CanonicalJsonError);
  });

  it('H13/H14 describes the texts by their hashes only', () => {
    const descriptor = contentStudioAIRequestDescriptor(provenance());
    const text = JSON.stringify(descriptor);
    expect(text).not.toMatch(/SECRET_MARKER|social posts|spring/);
    expect(descriptor.request).toEqual({
      systemHash: sha256Hex(canonicalJson(SYSTEM)),
      promptHash: sha256Hex(canonicalJson(PROMPT)),
      output: { type: 'text' },
      maxOutputTokens: 500,
      temperature: null,
    });
    expect(base).toBe(sha256Hex(canonicalJson(descriptor)));
  });

  it('H20 keeps NUL and lone surrogates apart from look-alikes', () => {
    const prompts = ['a\u0000b', 'ab', '\ud800', '\ufffd', '\udc00', ''];
    const hashes = prompts.map((prompt) =>
      hashContentStudioAIRequest(provenance({}, { prompt }))
    );
    expect(new Set(hashes).size).toBe(prompts.length);
    expect(
      hashContentStudioAIRequest(provenance({}, { prompt: '\ud800' }))
    ).toBe(hashes[2]);
  });
});

describe('AI operation result hash', () => {
  const base = hashContentStudioAIResult(result());

  it('H15 is deterministic lowercase 64 character hex', () => {
    expect(base).toMatch(HEX);
    expect(hashContentStudioAIResult(result())).toBe(base);
  });

  it.each([
    ['H16 the text', result({ text: `${RESULT}!` })],
    ['H17 the finish reason', result({ finishReason: 'length' })],
    ['H18 the request id', result({ providerRequestId: 'req_2' })],
    ['no request id', result({ providerRequestId: undefined })],
  ])('changes with %s', (_name, changed) => {
    expect(hashContentStudioAIResult(changed)).not.toBe(base);
  });

  it('leaves token usage out', () => {
    expect(
      hashContentStudioAIResult({
        ...result(),
        ...({ usage: { inputTokens: 1 } } as object),
      })
    ).toBe(base);
  });

  it('H19 describes the result text by its hash only', () => {
    const descriptor = contentStudioAIResultDescriptor(result());
    expect(JSON.stringify(descriptor)).not.toContain('RESULT_SECRET_MARKER');
    expect(descriptor).toEqual({
      v: 1,
      textHash: sha256Hex(canonicalJson(RESULT)),
      finishReason: 'stop',
      providerRequestId: 'req_1',
    });
  });
});
