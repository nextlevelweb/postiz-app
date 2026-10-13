import {
  AI_PROMPT_VERSION,
  CONTENT_STUDIO_AI_OPERATION_KINDS,
  isContentStudioAIOperationKind,
  parseContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

describe('Content Studio AI operation kinds', () => {
  it('OK1 lists exactly the package operations, and no connection test', () => {
    expect([...CONTENT_STUDIO_AI_OPERATION_KINDS]).toEqual([
      'generate_item',
      'rewrite_item',
      'shorten_item',
      'expand_item',
      'change_tone',
      'generate_thread',
    ]);
    for (const kind of CONTENT_STUDIO_AI_OPERATION_KINDS) {
      expect(isContentStudioAIOperationKind(kind)).toBe(true);
    }
  });

  it.each([
    ['connection_test'],
    ['research'],
    ['generate_image'],
    ['delete_package'],
    ['Generate_Item'],
    ['GENERATE_ITEM'],
    [' generate_item'],
    ['generate_item '],
    ['generate-item'],
    [''],
    ['constructor'],
    ['__proto__'],
    ['toString'],
    [null],
    [undefined],
    [1],
    [['generate_item']],
    [{ kind: 'generate_item' }],
  ])('OK2-OK4 refuses %p', (kind) => {
    expect(isContentStudioAIOperationKind(kind)).toBe(false);
  });

  it('OK5 is a readonly tuple that the guard reads, not a mutable registry', () => {
    const copy = [...CONTENT_STUDIO_AI_OPERATION_KINDS] as string[];
    copy.push('connection_test');
    expect(isContentStudioAIOperationKind('connection_test')).toBe(false);
    expect(CONTENT_STUDIO_AI_OPERATION_KINDS).toHaveLength(6);
  });
});

describe('Content Studio AI prompt version', () => {
  it.each([
    ['cs-item-v1'],
    ['cs-thread-v1'],
    ['v2.1'],
    ['a'],
    ['a'.repeat(64)],
  ])('accepts %s', (version) => {
    expect(AI_PROMPT_VERSION.test(version)).toBe(true);
  });

  it.each([
    [''],
    ['a'.repeat(65)],
    ['CS-ITEM-V1'],
    ['cs item v1'],
    ['cs/item/v1'],
    ['-cs-item'],
    ['.cs'],
    ['cs-item-v1\n'],
    ['cs\u0000item'],
  ])('refuses %p', (version) => {
    expect(AI_PROMPT_VERSION.test(version)).toBe(false);
  });
});

describe('Content Studio AI operation context', () => {
  it('accepts v1 with or without an item id', () => {
    expect(parseContentStudioAIOperationContext({ v: 1 })).toEqual({ v: 1 });
    expect(
      parseContentStudioAIOperationContext({ v: 1, itemId: 'item_A-1' })
    ).toEqual({ v: 1, itemId: 'item_A-1' });
  });

  it('uses exactly the draft item id rule', () => {
    for (const itemId of ['a', 'A_b-9', 'x'.repeat(32)]) {
      expect(parseContentStudioAIOperationContext({ v: 1, itemId })).toEqual({
        v: 1,
        itemId,
      });
      const draft = {
        schemaVersion: 1,
        copy: { global: { thread: [{ id: itemId, text: '', mediaIds: [] }] } },
      };
      expect(() => parseContentPackageDraft(draft)).not.toThrow();
    }
    for (const itemId of ['', 'x'.repeat(33), 'a b', 'a/b', '\u00e9']) {
      expect(
        parseContentStudioAIOperationContext({ v: 1, itemId })
      ).toBeUndefined();
    }
  });

  it.each([
    ['no version', {}],
    ['another version', { v: 2 }],
    ['a text field', { v: 1, prompt: 'Write about spring' }],
    ['an instruction', { v: 1, instruction: 'Make it shorter' }],
    ['a generated text', { v: 1, output: 'Spring is here' }],
    ['a credential', { v: 1, apiKey: 'sk-content-studio-test-secret-123' }],
    ['profiles', { v: 1, profiles: [] }],
    ['a non-string item id', { v: 1, itemId: 7 }],
    ['an array', [{ v: 1 }]],
    ['null', null],
    ['a string', '{"v":1}'],
    [
      'a class instance',
      new (class Context {
        v = 1;
      })(),
    ],
    ['a date', new Date()],
  ])('refuses %s', (_name, value) => {
    expect(parseContentStudioAIOperationContext(value)).toBeUndefined();
  });

  it('returns a new object: what is stored is the parsed context only', () => {
    const input = { v: 1 as const, itemId: 'item-1' };
    const parsed = parseContentStudioAIOperationContext(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });
});
