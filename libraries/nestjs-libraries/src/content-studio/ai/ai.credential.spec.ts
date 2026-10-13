import { inspect } from 'util';
import {
  createSecretBox,
  SecretBox,
  SecretBoxError,
} from '@gitroom/nestjs-libraries/services/secret.box';
import {
  aiConnectionSecretContext,
  openContentStudioAICredential,
  sealContentStudioAICredential,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import { ContentStudioAICredentialError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

// The production `secretBox` reads its keyring from the environment. Here it
// forwards to a test keyring instead (null: not configured), so the wrapper
// runs unchanged against real AES-GCM
const mockKeyring: { box: SecretBox | null } = { box: null };
jest.mock('@gitroom/nestjs-libraries/services/secret.box', () => {
  const actual = jest.requireActual(
    '@gitroom/nestjs-libraries/services/secret.box'
  );
  const current = (): SecretBox => {
    if (!mockKeyring.box) {
      throw new actual.SecretBoxError('NOT_CONFIGURED');
    }
    return mockKeyring.box;
  };
  return {
    ...actual,
    secretBox: {
      seal: (plaintext: string, context: string) =>
        current().seal(plaintext, context),
      open: (envelope: string, context: string) =>
        current().open(envelope, context),
      needsRotation: (envelope: string) => current().needsRotation(envelope),
    },
  };
});

const MARKER = 'sk-content-studio-test-secret-123';
const KEY_1 = Buffer.alloc(32, 1).toString('base64');
const KEY_2 = Buffer.alloc(32, 2).toString('base64');
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CONN_A = '33333333-3333-4333-8333-333333333333';
const CONN_B = '44444444-4444-4444-8444-444444444444';

const box = (keys = `k1:${KEY_1}`, activeKey = 'k1') =>
  createSecretBox({ keys, activeKey });

const seal = (
  organizationId = ORG_A,
  connectionId = CONN_A,
  provider = 'openai',
  credential: unknown = { apiKey: MARKER }
) =>
  sealContentStudioAICredential({
    organizationId,
    connectionId,
    provider,
    credential,
  });

const open = (
  envelope: string,
  organizationId = ORG_A,
  connectionId = CONN_A,
  provider = 'openai'
) =>
  openContentStudioAICredential({
    organizationId,
    connectionId,
    provider,
    envelope,
  });

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    return err as ContentStudioAICredentialError;
  }
  throw new Error('expected a failure');
};

const rendered = (err: unknown) =>
  [
    String(err),
    (err as Error).message,
    (err as Error).stack,
    JSON.stringify(err),
    inspect(err),
  ].join('\n');

beforeEach(() => {
  mockKeyring.box = box();
});

describe('AI connection secret context', () => {
  it('binds the organization and the connection', () => {
    expect(aiConnectionSecretContext(ORG_A, CONN_A)).toBe(
      `ai-connection|${ORG_A}|${CONN_A}`
    );
  });

  it.each([
    ['C10 an organization that is not a uuid', 'org-a', CONN_A],
    ['C11 a connection that is not a uuid', ORG_A, 'connection-a'],
    ['a separator in the organization', `${ORG_A}|x`, CONN_A],
    ['a separator in the connection', ORG_A, `x|${CONN_A}`],
    ['an upper case uuid', ORG_A.toUpperCase().replace(/1/g, 'A'), CONN_A],
    ['an empty id', '', CONN_A],
    ['a uuid with spaces', ` ${ORG_A}`, CONN_A],
  ])('refuses %s', (_name, organizationId, connectionId) => {
    for (const run of [
      () => aiConnectionSecretContext(organizationId, connectionId),
      () => seal(organizationId, connectionId),
      () => open('sb1.k1.x.y.z', organizationId, connectionId),
    ]) {
      const err = failure(run);
      expect(err).toBeInstanceOf(ContentStudioAICredentialError);
      expect(err.code).toBe('INVALID_CONTEXT');
    }
  });

  it('refuses ids that are not strings', () => {
    const err = failure(() =>
      aiConnectionSecretContext(null as unknown as string, CONN_A)
    );
    expect(err.code).toBe('INVALID_CONTEXT');
  });
});

describe('sealing and opening AI connection credentials', () => {
  it.each([['openai'], ['openrouter']])(
    'C1/C2 seals and opens a %s credential',
    (provider) => {
      const envelope = seal(ORG_A, CONN_A, provider);
      expect(open(envelope, ORG_A, CONN_A, provider)).toEqual({
        apiKey: MARKER,
      });
    }
  );

  it('C3 stores a SecretBox envelope of the v1 payload, never the key', () => {
    const envelope = seal();
    expect(envelope.split('.')).toHaveLength(5);
    expect(envelope.startsWith('sb1.k1.')).toBe(true);
    expect(envelope).not.toContain(MARKER);
    expect(envelope).not.toContain('content-studio');
    // the plaintext is canonical JSON with a version, nothing else
    expect(
      mockKeyring.box?.open(envelope, aiConnectionSecretContext(ORG_A, CONN_A))
    ).toBe(`{"apiKey":${JSON.stringify(MARKER)},"v":1}`);
  });

  it('C4/C5 seals the same credential differently every time; both open', () => {
    const first = seal();
    const second = seal();
    expect(first).not.toBe(second);
    expect(open(first)).toEqual({ apiKey: MARKER });
    expect(open(second)).toEqual({ apiKey: MARKER });
  });

  it('C6-C9 opens only for its own organization and connection', () => {
    const envelope = seal(ORG_A, CONN_A);
    expect(open(envelope, ORG_A, CONN_A)).toEqual({ apiKey: MARKER });
    for (const [organizationId, connectionId] of [
      [ORG_B, CONN_A],
      [ORG_A, CONN_B],
      [ORG_B, CONN_B],
    ]) {
      const err = failure(() => open(envelope, organizationId, connectionId));
      expect(err).toBeInstanceOf(ContentStudioAICredentialError);
      expect(err.code).toBe('UNREADABLE');
    }
  });

  it('refuses to seal an invalid credential or provider (INVALID)', () => {
    for (const [provider, credential] of [
      ['openai', { apiKey: `${MARKER} ` }],
      ['openai', { apiKey: MARKER, baseURL: 'https://x.test' }],
      ['mistral', { apiKey: MARKER }],
      ['anthropic', { apiKey: MARKER, authToken: MARKER }],
      ['openrouter', {}],
    ] as const) {
      const err = failure(() => seal(ORG_A, CONN_A, provider, credential));
      expect(err.code).toBe('INVALID');
      expect(rendered(err)).not.toContain(MARKER);
    }
  });

  it('opens with the provider of the row; an unknown one is UNREADABLE', () => {
    const envelope = seal(ORG_A, CONN_A, 'openai');
    expect(open(envelope, ORG_A, CONN_A, 'openrouter')).toEqual({
      apiKey: MARKER,
    });
    expect(failure(() => open(envelope, ORG_A, CONN_A, 'mistral')).code).toBe(
      'UNREADABLE'
    );
  });

  // The provider is not part of the SecretBox context (P2-01): it is the
  // row's own, immutable column, so the same key rules apply to every provider
  describe('Anthropic', () => {
    it('CR1/CR2 seals and opens an Anthropic API key for its connection', () => {
      const envelope = seal(ORG_A, CONN_A, 'anthropic');
      expect(envelope.startsWith('sb1.k1.')).toBe(true);
      expect(envelope).not.toContain(MARKER);
      expect(open(envelope, ORG_A, CONN_A, 'anthropic')).toEqual({
        apiKey: MARKER,
      });
    });

    it('CR3 does not open for another organization or connection', () => {
      const envelope = seal(ORG_A, CONN_A, 'anthropic');
      for (const [organizationId, connectionId] of [
        [ORG_B, CONN_A],
        [ORG_A, CONN_B],
      ]) {
        const err = failure(() =>
          open(envelope, organizationId, connectionId, 'anthropic')
        );
        expect(err.code).toBe('UNREADABLE');
        expect(rendered(err)).not.toContain(MARKER);
      }
    });

    it.each([
      ['CR4 an unknown field', { apiKey: MARKER, baseURL: 'https://x.test' }],
      ['CR4 an auth token', { apiKey: MARKER, authToken: MARKER }],
      ['CR5 a trailing space', { apiKey: `${MARKER} ` }],
      ['CR5 a newline', { apiKey: `${MARKER}\n` }],
      ['CR5 a tab', { apiKey: `\t${MARKER}` }],
    ])('%s is refused without repeating the key (CR6)', (_name, credential) => {
      const err = failure(() => seal(ORG_A, CONN_A, 'anthropic', credential));
      expect(err.code).toBe('INVALID');
      expect(rendered(err)).not.toContain(MARKER);
    });
  });

  it.each([
    ['C12 not an envelope', 'not an envelope'],
    ['C12 an empty string', ''],
    ['C12 a cut envelope', () => seal().split('.').slice(0, 4).join('.')],
    [
      'C12 a changed tag',
      () => seal().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
    ],
    ['C12 the marker appended', () => `${seal()}${MARKER}`],
    ['C12 another version', () => seal().replace(/^sb1/, 'sb2')],
  ])('maps %s to UNREADABLE', (_name, make) => {
    const envelope = typeof make === 'function' ? make() : make;
    const err = failure(() => open(envelope));
    expect(err.code).toBe('UNREADABLE');
    expect(rendered(err)).not.toContain(MARKER);
  });

  it('C13 maps a key that is not in the keyring to UNREADABLE', () => {
    const envelope = seal();
    mockKeyring.box = box(`k2:${KEY_2}`, 'k2');
    expect(failure(() => open(envelope)).code).toBe('UNREADABLE');
  });

  it('C14 maps a SecretBox without keyring to UNAVAILABLE, both ways', () => {
    const envelope = seal();
    mockKeyring.box = null;
    for (const run of [() => seal(), () => open(envelope)]) {
      const err = failure(run);
      expect(err).toBeInstanceOf(ContentStudioAICredentialError);
      expect(err.code).toBe('UNAVAILABLE');
      expect(err).not.toBeInstanceOf(SecretBoxError);
    }
  });

  it.each([
    ['C15 text that is not JSON', 'not json'],
    ['C15 truncated JSON', `{"apiKey":"${MARKER}"`],
    ['C16 version 2', JSON.stringify({ v: 2, apiKey: MARKER })],
    ['C16 no version', JSON.stringify({ apiKey: MARKER })],
    ['C16 a string version', JSON.stringify({ v: '1', apiKey: MARKER })],
    ['C17 a key with a space', JSON.stringify({ v: 1, apiKey: `${MARKER} x` })],
    ['C17 an extra field', JSON.stringify({ v: 1, apiKey: MARKER, extra: 1 })],
    ['C17 no key', JSON.stringify({ v: 1 })],
    ['C17 an array', JSON.stringify([1, MARKER])],
    ['C17 null', 'null'],
    ['C17 a bare string', JSON.stringify(MARKER)],
  ])('maps a sealed payload with %s to UNREADABLE', (_name, plaintext) => {
    // sealed correctly for this very connection: only the payload is wrong
    const envelope = (mockKeyring.box as SecretBox).seal(
      plaintext,
      aiConnectionSecretContext(ORG_A, CONN_A)
    );
    const err = failure(() => open(envelope));
    expect(err.code).toBe('UNREADABLE');
    expect(rendered(err)).not.toContain(MARKER);
  });

  it('C18 keeps the key and the envelope out of every error', () => {
    const envelope = seal();
    const errors = [
      failure(() => seal(ORG_A, CONN_A, 'openai', { apiKey: `${MARKER}\n` })),
      failure(() => open(envelope, ORG_B, CONN_A)),
      failure(() => open(`${envelope}x`)),
      failure(() => open(envelope, ORG_A, CONN_A, 'unknown')),
    ];
    mockKeyring.box = null;
    errors.push(failure(() => open(envelope)));
    for (const err of errors) {
      const text = rendered(err);
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain(envelope);
      expect(text).not.toContain(envelope.split('.')[3]);
      expect('cause' in err).toBe(false);
    }
  });

  it('C19/C20 opens an envelope of a retired key while it stays in the keyring', () => {
    const envelope = seal();
    mockKeyring.box = box(`k1:${KEY_1},k2:${KEY_2}`, 'k2');
    expect(open(envelope)).toEqual({ apiKey: MARKER });
    // rotation is SecretBox's own concern; the wrapper adds nothing to it
    expect(mockKeyring.box.needsRotation(envelope)).toBe(true);
    const resealed = seal();
    expect(resealed.startsWith('sb1.k2.')).toBe(true);
    expect(mockKeyring.box.needsRotation(resealed)).toBe(false);
  });
});

describe('credential module source', () => {
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const path = jest.requireActual<typeof import('path')>('path');
  const read = (file: string) =>
    fs.readFileSync(path.join(__dirname, file), 'utf8');

  it('uses the production secretBox and reads no configuration itself', () => {
    for (const file of ['ai.credential.ts', 'ai.provider.catalog.ts']) {
      const text = read(file);
      expect(text).not.toMatch(/process\.env|SECRET_BOX_|createSecretBox/);
      expect(text).not.toMatch(/from 'openai'|@anthropic-ai|@ai-sdk|from 'ai'/);
      expect(text).not.toMatch(/\bfetch\(|https?:\/\//);
    }
    expect(read('ai.credential.ts')).toMatch(
      /import \{[^}]*\bsecretBox\b[^}]*\} from '@gitroom\/nestjs-libraries\/services\/secret\.box'/
    );
  });
});
