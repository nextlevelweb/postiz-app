import { randomBytes } from 'crypto';
import util from 'node:util';
import {
  createSecretBox,
  SecretBox,
  SecretBoxConfig,
  SecretBoxError,
} from './secret.box';

// Keys are generated per run and never printed or committed
const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const CONTEXT = 'ai-connection|org-a|conn-1';

const box = (keys: string, activeKey: string) =>
  createSecretBox({ keys, activeKey });
const k1Only = () => box(`k1:${KEY_1}`, 'k1');
const rotated = () => box(`k1:${KEY_1},k2:${KEY_2}`, 'k2');

const failure = (
  action: () => unknown,
  errorClass: typeof SecretBoxError = SecretBoxError
) => {
  try {
    action();
  } catch (err) {
    if (err instanceof errorClass) {
      return err;
    }
    throw err;
  }
  throw new Error('action did not fail');
};

// Every way an error can end up in a log
const rendered = (err: SecretBoxError) =>
  [
    err.message,
    String(err),
    JSON.stringify(err),
    util.inspect(err),
    err.stack,
  ].join('\n');

const parts = (envelope: string) => envelope.split('.');
const withPart = (envelope: string, index: number, value: string) =>
  parts(envelope)
    .map((part, i) => (i === index ? value : part))
    .join('.');
// Flips one bit of a base64url part, keeping its length and shape valid
const flipped = (part: string) => {
  const bytes = Buffer.from(part, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
};

describe('SecretBox', () => {
  describe('round trip', () => {
    it.each([
      ['ascii', 'sk-test-0123456789'],
      ['unicode', 'Ünïcødé 🔐 日本語 مرحبا'],
      ['empty', ''],
    ])('opens a sealed %s secret', (_name, plaintext) => {
      const secrets = k1Only();
      const envelope = secrets.seal(plaintext, CONTEXT);

      expect(secrets.open(envelope, CONTEXT)).toBe(plaintext);
      expect(envelope).not.toContain(plaintext || 'never');
    });

    it('produces the documented envelope shape', () => {
      const [version, keyId, iv, ciphertext, tag] = parts(
        k1Only().seal('abc', CONTEXT)
      );

      expect(version).toBe('sb1');
      expect(keyId).toBe('k1');
      expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
      expect(Buffer.from(ciphertext, 'base64url')).toHaveLength(3);
      expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    });

    it('rejects a string that cannot round trip through UTF-8', () => {
      expect(failure(() => k1Only().seal('\uD800', CONTEXT)).code).toBe(
        'MALFORMED'
      );
    });
  });

  it('seals the same plaintext differently every time', () => {
    const secrets = k1Only();
    const first = secrets.seal('same secret', CONTEXT);
    const second = secrets.seal('same secret', CONTEXT);

    expect(first).not.toBe(second);
    expect(parts(first)[2]).not.toBe(parts(second)[2]);
    expect(secrets.open(first, CONTEXT)).toBe('same secret');
    expect(secrets.open(second, CONTEXT)).toBe('same secret');
  });

  describe('tampering', () => {
    const secrets = rotated();
    const envelope = secrets.seal('tamper me', CONTEXT);

    it.each([
      ['version', () => withPart(envelope, 0, 'sb2'), 'MALFORMED'],
      [
        'key id to an unknown key',
        () => withPart(envelope, 1, 'k9'),
        'UNKNOWN_KEY',
      ],
      [
        'key id to the other known key',
        () => withPart(envelope, 1, 'k1'),
        'DECRYPT_FAILED',
      ],
      [
        'key id to an invalid id',
        () => withPart(envelope, 1, 'K!'),
        'MALFORMED',
      ],
      [
        'IV bits',
        () => withPart(envelope, 2, flipped(parts(envelope)[2])),
        'DECRYPT_FAILED',
      ],
      [
        'IV length',
        () => withPart(envelope, 2, parts(envelope)[2].slice(2)),
        'MALFORMED',
      ],
      [
        'ciphertext bits',
        () => withPart(envelope, 3, flipped(parts(envelope)[3])),
        'DECRYPT_FAILED',
      ],
      ['ciphertext removed', () => withPart(envelope, 3, ''), 'DECRYPT_FAILED'],
      [
        'tag bits',
        () => withPart(envelope, 4, flipped(parts(envelope)[4])),
        'DECRYPT_FAILED',
      ],
      [
        'tag length',
        () => withPart(envelope, 4, parts(envelope)[4].slice(4)),
        'MALFORMED',
      ],
    ])('rejects a changed %s', (_name, tamper, code) => {
      expect(failure(() => secrets.open(tamper(), CONTEXT)).code).toBe(code);
    });
  });

  describe('context binding', () => {
    it.each([
      ['ai-connection|org-b|conn-1'],
      ['ai-connection|org-a|conn-2'],
      ['ai-connection|org-a|conn-1 '],
    ])('does not open under %p', (context) => {
      const secrets = k1Only();
      const envelope = secrets.seal('bound', CONTEXT);

      expect(failure(() => secrets.open(envelope, context)).code).toBe(
        'DECRYPT_FAILED'
      );
    });

    it.each([[''], ['x'.repeat(1025)], [undefined as unknown as string]])(
      'rejects the context %p',
      (context) => {
        const secrets = k1Only();
        expect(failure(() => secrets.seal('value', context)).code).toBe(
          'INVALID_CONTEXT'
        );
        const envelope = secrets.seal('value', CONTEXT);
        expect(failure(() => secrets.open(envelope, context)).code).toBe(
          'INVALID_CONTEXT'
        );
      }
    );
  });

  it('does not open with different key material under the same id', () => {
    const envelope = k1Only().seal('keyed', CONTEXT);
    const impostor = box(`k1:${OTHER_KEY}`, 'k1');

    expect(failure(() => impostor.open(envelope, CONTEXT)).code).toBe(
      'DECRYPT_FAILED'
    );
  });

  describe('rotation', () => {
    it('keeps old values readable and flags them for re-sealing', () => {
      const old = k1Only().seal('rotate me', CONTEXT);
      const secrets = rotated();

      expect(secrets.open(old, CONTEXT)).toBe('rotate me');
      expect(secrets.needsRotation(old)).toBe(true);

      const fresh = secrets.seal('rotate me', CONTEXT);
      expect(parts(fresh)[1]).toBe('k2');
      expect(secrets.needsRotation(fresh)).toBe(false);

      const withoutK1 = box(`k2:${KEY_2}`, 'k2');
      expect(withoutK1.open(fresh, CONTEXT)).toBe('rotate me');
      expect(failure(() => withoutK1.open(old, CONTEXT)).code).toBe(
        'UNKNOWN_KEY'
      );
      expect(failure(() => withoutK1.needsRotation(old)).code).toBe(
        'UNKNOWN_KEY'
      );
    });

    it('throws for a malformed envelope instead of answering', () => {
      expect(failure(() => rotated().needsRotation('sb1.k1.x')).code).toBe(
        'MALFORMED'
      );
    });
  });

  describe('keyring configuration', () => {
    it('accepts spaces around entries and the active key', () => {
      const secrets = createSecretBox({
        keys: ` k1:${KEY_1} , k2:${KEY_2} `,
        activeKey: ' k2 ',
      });
      expect(parts(secrets.seal('x', CONTEXT))[1]).toBe('k2');
    });

    it.each<[string, SecretBoxConfig]>([
      ['missing keyring', { activeKey: 'k1' }],
      ['empty keyring', { keys: '', activeKey: 'k1' }],
      ['missing active key', { keys: `k1:${KEY_1}` }],
      ['empty active key', { keys: `k1:${KEY_1}`, activeKey: '' }],
      ['active key not in keyring', { keys: `k1:${KEY_1}`, activeKey: 'k3' }],
      ['duplicate ids', { keys: `k1:${KEY_1},k1:${KEY_2}`, activeKey: 'k1' }],
      ['uppercase id', { keys: `K1:${KEY_1}`, activeKey: 'K1' }],
      ['id with a dot', { keys: `k.1:${KEY_1}`, activeKey: 'k.1' }],
      ['empty id', { keys: `:${KEY_1}`, activeKey: '' }],
      ['missing separator', { keys: `k1${KEY_1}`, activeKey: 'k1' }],
      ['wrong separator', { keys: `k1=${KEY_1}`, activeKey: 'k1' }],
      ['empty key', { keys: 'k1:', activeKey: 'k1' }],
      [
        'invalid base64',
        { keys: `k1:${KEY_1.slice(0, -4)}!!!!`, activeKey: 'k1' },
      ],
      [
        'base64url instead of base64',
        {
          keys: `k1:${Buffer.from(KEY_1, 'base64').toString('base64url')}`,
          activeKey: 'k1',
        },
      ],
      [
        '16-byte key',
        { keys: `k1:${randomBytes(16).toString('base64')}`, activeKey: 'k1' },
      ],
      [
        '33-byte key',
        { keys: `k1:${randomBytes(33).toString('base64')}`, activeKey: 'k1' },
      ],
      ['empty entry', { keys: `k1:${KEY_1},,k2:${KEY_2}`, activeKey: 'k1' }],
      ['trailing comma', { keys: `k1:${KEY_1},`, activeKey: 'k1' }],
    ])('rejects %s without echoing the configuration', (_name, config) => {
      const err = failure(() => createSecretBox(config));
      expect(err.code).toBe('NOT_CONFIGURED');
      for (const value of [KEY_1, KEY_2, KEY_1.slice(0, 16)]) {
        expect(rendered(err)).not.toContain(value);
      }
    });
  });

  describe('plaintext limit', () => {
    it('accepts exactly 16 KiB of UTF-8', () => {
      const secrets = k1Only();
      for (const plaintext of ['a'.repeat(16384), 'é'.repeat(8192)]) {
        expect(secrets.open(secrets.seal(plaintext, CONTEXT), CONTEXT)).toBe(
          plaintext
        );
      }
    });

    it.each([['a'.repeat(16385)], ['é'.repeat(8192) + 'a']])(
      'rejects one byte more',
      (plaintext) => {
        expect(failure(() => k1Only().seal(plaintext, CONTEXT)).code).toBe(
          'PLAINTEXT_TOO_LARGE'
        );
      }
    );
  });

  describe('envelope parser', () => {
    const envelope = () => k1Only().seal('parse me', CONTEXT);

    it.each([
      ['wrong version', (e: string) => withPart(e, 0, 'sb0')],
      ['no version', (e: string) => withPart(e, 0, '')],
      ['four parts', (e: string) => parts(e).slice(0, 4).join('.')],
      ['six parts', (e: string) => `${e}.extra`],
      ['empty key id', (e: string) => withPart(e, 1, '')],
      ['empty IV', (e: string) => withPart(e, 2, '')],
      ['empty tag', (e: string) => withPart(e, 4, '')],
      [
        'base64 instead of base64url',
        (e: string) => withPart(e, 2, `${parts(e)[2].slice(0, -1)}+`),
      ],
      ['padding', (e: string) => withPart(e, 4, `${parts(e)[4]}==`)],
      [
        'non-canonical trailing bits',
        (e: string) => withPart(e, 4, `${parts(e)[4].slice(0, -1)}B`),
      ],
      ['oversized', (e: string) => withPart(e, 3, 'A'.repeat(25 * 1024))],
      ['empty string', () => ''],
      ['not a string', () => undefined as unknown as string],
    ])('rejects %s as MALFORMED', (_name, change) => {
      const secrets = k1Only();
      expect(
        failure(() => secrets.open(change(envelope()), CONTEXT)).code
      ).toBe('MALFORMED');
      expect(
        failure(() => secrets.needsRotation(change(envelope()))).code
      ).toBe('MALFORMED');
    });
  });

  describe('error redaction', () => {
    const PLAINTEXT = 'PLAINTEXT-MARKER-7f3a';

    it('keeps plaintext, envelope and key material out of every error', () => {
      const secrets = rotated();
      const envelope = secrets.seal(PLAINTEXT, CONTEXT);
      const [, , iv, ciphertext, tag] = parts(envelope);
      const errors = [
        failure(() => secrets.open(envelope, 'ai-connection|org-b|conn-1')),
        failure(() =>
          secrets.open(withPart(envelope, 3, flipped(ciphertext)), CONTEXT)
        ),
        failure(() => secrets.open(withPart(envelope, 1, 'k9'), CONTEXT)),
        failure(() => secrets.open(`${envelope}.${PLAINTEXT}`, CONTEXT)),
        failure(() => secrets.seal(PLAINTEXT.repeat(2000), CONTEXT)),
        failure(() => secrets.seal(PLAINTEXT, '')),
        failure(() => box(`k1:${KEY_1},k2:${KEY_2}`, 'k3')),
        failure(() => box(`k1:${KEY_2}${PLAINTEXT}`, 'k1')),
      ];

      for (const err of errors) {
        const text = rendered(err);
        for (const secret of [
          PLAINTEXT,
          envelope,
          iv,
          ciphertext,
          tag,
          KEY_1,
          KEY_2,
        ]) {
          expect(text).not.toContain(secret);
        }
        expect(err).not.toHaveProperty('cause');
        expect(Object.keys(JSON.parse(JSON.stringify(err))).sort()).toEqual([
          'code',
          'message',
          'name',
        ]);
      }
      expect(util.inspect(secrets)).not.toContain(KEY_1);
    });
  });

  describe('production instance', () => {
    const NAMES = ['SECRET_BOX_KEYS', 'SECRET_BOX_ACTIVE_KEY', 'JWT_SECRET'];
    const saved: Record<string, string | undefined> = {};
    const load = () => {
      let loaded: {
        secretBox: SecretBox;
        SecretBoxError: typeof SecretBoxError;
      };
      // a fresh module, so the lazily cached instance starts empty
      jest.isolateModules(() => {
        loaded = require('./secret.box');
      });
      return loaded!;
    };

    beforeEach(() => {
      for (const name of NAMES) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of NAMES) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    // With only the active key id set, a keyring derived from JWT_SECRET would
    // be the one thing that could make these succeed
    it.each([
      ['no SecretBox variables', {}],
      ['only an active key id', { SECRET_BOX_ACTIVE_KEY: 'k1' }],
    ])(
      'loads with %s and never falls back to JWT_SECRET',
      (_name, env: Record<string, string>) => {
        process.env.JWT_SECRET = 'JWT-SECRET-MARKER-91c2';
        Object.assign(process.env, env);
        const { secretBox: secrets, SecretBoxError: IsolatedError } = load();

        for (const action of [
          () => secrets.seal('value', CONTEXT),
          () =>
            secrets.open(
              'sb1.k1.AAAAAAAAAAAAAAAA..AAAAAAAAAAAAAAAAAAAAAA',
              CONTEXT
            ),
          () =>
            secrets.needsRotation(
              'sb1.k1.AAAAAAAAAAAAAAAA..AAAAAAAAAAAAAAAAAAAAAA'
            ),
        ]) {
          const err = failure(action, IsolatedError);
          expect(err.code).toBe('NOT_CONFIGURED');
          expect(rendered(err)).not.toContain('JWT-SECRET-MARKER-91c2');
        }
      }
    );

    it('reads its keyring from SECRET_BOX_KEYS and SECRET_BOX_ACTIVE_KEY on first use', () => {
      const { secretBox: secrets } = load();
      process.env.SECRET_BOX_KEYS = `k1:${KEY_1},k2:${KEY_2}`;
      process.env.SECRET_BOX_ACTIVE_KEY = 'k2';

      const envelope = secrets.seal('from env', CONTEXT);
      expect(parts(envelope)[1]).toBe('k2');
      expect(rotated().open(envelope, CONTEXT)).toBe('from env');
      expect(secrets.open(k1Only().seal('old', CONTEXT), CONTEXT)).toBe('old');
    });
  });
});
