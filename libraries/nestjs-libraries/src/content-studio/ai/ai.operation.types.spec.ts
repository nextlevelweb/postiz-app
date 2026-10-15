import {
  AI_OPERATION_CONTEXT_MAX_BYTES,
  AI_PROMPT_VERSION,
  CONTENT_STUDIO_AI_MAX_SOURCES,
  CONTENT_STUDIO_AI_OPERATION_KINDS,
  isContentStudioAIOperationKind,
  parseContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';

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

describe('Content Studio AI operation context: profile and policy revisions', () => {
  const WRITING = {
    kind: 'writing' as const,
    profileId: '11111111-1111-4111-8111-111111111111',
    revisionId: '22222222-2222-4222-8222-222222222222',
    revisionNumber: 4,
  };
  const AUDIENCE = {
    kind: 'audience' as const,
    profileId: '33333333-3333-4333-8333-333333333333',
    revisionId: '44444444-4444-4444-8444-444444444444',
    revisionNumber: 1,
  };
  const EXPERTISE = {
    kind: 'expertise' as const,
    profileId: '55555555-5555-4555-8555-555555555555',
    revisionId: '66666666-6666-4666-8666-666666666666',
    revisionNumber: 2_147_483_647,
  };
  const POLICY = {
    revisionId: '77777777-7777-4777-8777-777777777777',
    revisionNumber: 9,
  };
  const parse = parseContentStudioAIOperationContext;

  it('OC1/OC2 still reads the contexts stored before the references existed', () => {
    expect(parse({ v: 1 })).toEqual({ v: 1 });
    expect(parse({ v: 1, itemId: 'main' })).toEqual({ v: 1, itemId: 'main' });
  });

  it('OC3 takes one writing profile revision', () => {
    expect(parse({ v: 1, itemId: 'main', profiles: [WRITING] })).toEqual({
      v: 1,
      itemId: 'main',
      profiles: [WRITING],
    });
  });

  it('OC4/OC5 takes all three profiles in their order and the policy revision', () => {
    const context = {
      v: 1,
      profiles: [WRITING, AUDIENCE, EXPERTISE],
      editorialPolicy: POLICY,
    };
    expect(parse(context)).toEqual(context);
    expect(parse({ v: 1, editorialPolicy: POLICY })).toEqual({
      v: 1,
      editorialPolicy: POLICY,
    });
  });

  it.each([
    ['OC6 the same kind twice', { v: 1, profiles: [WRITING, WRITING] }],
    [
      'OC6 the same kind twice with other ids',
      {
        v: 1,
        profiles: [AUDIENCE, { ...AUDIENCE, profileId: WRITING.profileId }],
      },
    ],
    ['kinds out of order', { v: 1, profiles: [AUDIENCE, WRITING] }],
    [
      'four profiles',
      { v: 1, profiles: [WRITING, AUDIENCE, EXPERTISE, EXPERTISE] },
    ],
    ['no profiles', { v: 1, profiles: [] }],
    [
      'OC7 an unknown kind',
      { v: 1, profiles: [{ ...WRITING, kind: 'brand' }] },
    ],
    [
      'OC7 the policy as a profile',
      { v: 1, profiles: [{ ...WRITING, kind: 'editorial' }] },
    ],
    [
      'OC8 a malformed profile id',
      { v: 1, profiles: [{ ...WRITING, profileId: 'writing-1' }] },
    ],
    [
      'OC8 an upper case revision id',
      {
        v: 1,
        profiles: [
          { ...WRITING, revisionId: 'AAAAAAAA-2222-4222-8222-222222222222' },
        ],
      },
    ],
    [
      'OC8 a malformed policy revision id',
      { v: 1, editorialPolicy: { ...POLICY, revisionId: 'rev-1' } },
    ],
    ['OC9 revision 0', { v: 1, profiles: [{ ...WRITING, revisionNumber: 0 }] }],
    [
      'OC9 a fractional revision',
      { v: 1, profiles: [{ ...WRITING, revisionNumber: 1.5 }] },
    ],
    [
      'OC9 a revision past int4',
      { v: 1, profiles: [{ ...WRITING, revisionNumber: 2 ** 31 }] },
    ],
    [
      'OC9 a string revision',
      { v: 1, editorialPolicy: { ...POLICY, revisionNumber: '9' } },
    ],
    [
      'OC9 a policy revision 0',
      { v: 1, editorialPolicy: { ...POLICY, revisionNumber: 0 } },
    ],
    [
      'a reference without revision',
      { v: 1, profiles: [{ kind: 'writing', profileId: WRITING.profileId }] },
    ],
    [
      'a policy without revision id',
      { v: 1, editorialPolicy: { revisionNumber: 9 } },
    ],
    ['OC10 an unknown key', { v: 1, writingProfileId: WRITING.profileId }],
    ['OC10 a policy id', { v: 1, editorialPolicyId: POLICY.revisionId }],
    [
      'OC12 profile content in a reference',
      {
        v: 1,
        profiles: [
          { ...WRITING, content: { voice: 'PROFILE_PRIVATE_MARKER_789' } },
        ],
      },
    ],
    [
      'OC12 a profile name in a reference',
      { v: 1, profiles: [{ ...WRITING, name: 'Brand voice' }] },
    ],
    [
      'OC12 a content hash in a reference',
      { v: 1, profiles: [{ ...WRITING, contentHash: 'a'.repeat(64) }] },
    ],
    [
      'OC12 policy content',
      {
        v: 1,
        editorialPolicy: {
          ...POLICY,
          principles: ['PROFILE_PRIVATE_MARKER_789'],
        },
      },
    ],
    ['profiles that are not a list', { v: 1, profiles: WRITING }],
    [
      'a policy that is not an object',
      { v: 1, editorialPolicy: POLICY.revisionId },
    ],
  ])('refuses %s', (_name, value) => {
    expect(parse(value)).toBeUndefined();
  });

  it('OC11 the largest context stays far below 8 KiB', () => {
    const context = {
      v: 1,
      itemId: 'x'.repeat(32),
      profiles: [WRITING, AUDIENCE, EXPERTISE],
      editorialPolicy: POLICY,
    };
    expect(parse(context)).toEqual(context);
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThan(
      1024
    );
  });
});

describe('Content Studio AI operation context: source versions', () => {
  const source = (n: number, overrides: Record<string, unknown> = {}) => ({
    sourceId: `a${n}111111-1111-4111-8111-111111111111`,
    versionId: `b${n}222222-2222-4222-8222-222222222222`,
    versionNumber: n,
    contentHash: String(n).repeat(64),
    ...overrides,
  });
  const PROFILES = [
    {
      kind: 'writing' as const,
      profileId: '11111111-1111-4111-8111-111111111111',
      revisionId: '22222222-2222-4222-8222-222222222222',
      revisionNumber: 4,
    },
    {
      kind: 'audience' as const,
      profileId: '33333333-3333-4333-8333-333333333333',
      revisionId: '44444444-4444-4444-8444-444444444444',
      revisionNumber: 2_147_483_647,
    },
    {
      kind: 'expertise' as const,
      profileId: '55555555-5555-4555-8555-555555555555',
      revisionId: '66666666-6666-4666-8666-666666666666',
      revisionNumber: 2_147_483_647,
    },
  ];
  const POLICY = {
    revisionId: '77777777-7777-4777-8777-777777777777',
    revisionNumber: 2_147_483_647,
  };
  const parse = parseContentStudioAIOperationContext;

  it('OS1 still reads every context stored before sources existed', () => {
    for (const context of [
      { v: 1 },
      { v: 1, itemId: 'main' },
      { v: 1, itemId: 'main', profiles: [PROFILES[0]] },
      { v: 1, profiles: PROFILES, editorialPolicy: POLICY },
    ]) {
      expect(parse(context)).toEqual(context);
    }
  });

  it('OS2 takes one source version', () => {
    const context = { v: 1, itemId: 'main', sources: [source(1)] };
    expect(parse(context)).toEqual(context);
  });

  it('OS3 takes five, in the order given', () => {
    expect(CONTENT_STUDIO_AI_MAX_SOURCES).toBe(5);
    const sources = [source(5), source(2), source(4), source(1), source(3)];
    expect(parse({ v: 1, sources })?.sources).toEqual(sources);
  });

  it.each([
    ['OS4 six sources', [1, 2, 3, 4, 5, 6].map((n) => source(n))],
    ['OS5 an empty list', []],
    [
      'OS6 the same source twice',
      [source(1), source(2, { sourceId: source(1).sourceId })],
    ],
    [
      'OS7 the same version twice',
      [source(1), source(2, { versionId: source(1).versionId })],
    ],
    ['OS8 a malformed source id', [source(1, { sourceId: 'source-1' })]],
    [
      'OS8 an uppercase source id',
      [source(1, { sourceId: source(1).sourceId.toUpperCase() })],
    ],
    ['OS9 a malformed version id', [source(1, { versionId: 'v1' })]],
    ['OS10 version number 0', [source(1, { versionNumber: 0 })]],
    ['OS10 a negative version number', [source(1, { versionNumber: -1 })]],
    ['a fractional version number', [source(1, { versionNumber: 1.5 })]],
    ['a version number as text', [source(1, { versionNumber: '1' })]],
    [
      'OS11 a version number past int4',
      [source(1, { versionNumber: 2 ** 31 })],
    ],
    ['OS12 a short hash', [source(1, { contentHash: 'a'.repeat(63) })]],
    ['OS12 an uppercase hash', [source(1, { contentHash: 'A'.repeat(64) })]],
    [
      'OS12 a hash that is not hex',
      [source(1, { contentHash: 'g'.repeat(64) })],
    ],
    ['OS12 no hash', [source(1, { contentHash: undefined })]],
    ['OS13 an unknown key', [source(1, { extra: true })]],
    ['OS14 source content', [source(1, { content: '{"blocks":[]}' })]],
    ['OS14 blocks', [source(1, { blocks: [] })]],
    ['OS15 a title', [source(1, { title: 'SOURCE_TITLE_PRIVATE_789' })]],
    ['OS15 a name', [source(1, { name: 'Weekly news' })]],
    ['OS15 a URL', [source(1, { finalUrl: 'https://example.com/a' })]],
    ['OS15 sourceHash', [source(1, { sourceHash: 'c'.repeat(64) })]],
    [
      'OS15 extractionVersion',
      [source(1, { extractionVersion: 'content-studio-source-v2' })],
    ],
    ['sources that are not a list', source(1)],
    ['a source that is not an object', [source(1).sourceId]],
  ])('refuses %s', (_name, sources) => {
    expect(parse({ v: 1, sources })).toBeUndefined();
  });

  it('OS16/OS17 profiles, the policy and five sources together stay valid and far below 8 KiB', () => {
    const context = {
      v: 1,
      itemId: 'x'.repeat(32),
      profiles: PROFILES,
      editorialPolicy: POLICY,
      sources: [1, 2, 3, 4, 5].map((n) =>
        source(n, { versionNumber: 2_147_483_647 })
      ),
    };
    expect(parse(context)).toEqual(context);
    const bytes = Buffer.byteLength(canonicalJson(context), 'utf8');
    expect(bytes).toBeLessThan(AI_OPERATION_CONTEXT_MAX_BYTES / 4);
    expect(AI_OPERATION_CONTEXT_MAX_BYTES).toBe(8192);
  });
});
