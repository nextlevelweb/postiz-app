import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// Authenticated, randomized encryption for new server-side secrets (AI
// connection keys first). It has its own keyring and never touches JWT_SECRET
// or AuthService.fixedEncryption, which stays as it is for existing data.
//
// Envelope: sb1.<keyId>.<iv>.<ciphertext>.<tag>, base64url parts, AES-256-GCM
// with a 96-bit random IV and a 128-bit tag. The AAD binds the version, the
// key id and a caller context, so a sealed value copied to another row or
// organization does not open. The context must be immutable identity only,
// e.g. `ai-connection|<organizationId>|<connectionId>`.

export type SecretBoxErrorCode =
  | 'NOT_CONFIGURED'
  | 'MALFORMED'
  | 'UNKNOWN_KEY'
  | 'DECRYPT_FAILED'
  | 'PLAINTEXT_TOO_LARGE'
  | 'INVALID_CONTEXT';

const ERROR_MESSAGES: Record<SecretBoxErrorCode, string> = {
  NOT_CONFIGURED: 'SecretBox is not configured',
  MALFORMED: 'The sealed secret or its input is malformed',
  UNKNOWN_KEY: 'The sealed secret uses a key that is not in the keyring',
  DECRYPT_FAILED: 'The sealed secret could not be opened',
  PLAINTEXT_TOO_LARGE: 'The secret is too large',
  INVALID_CONTEXT: 'The secret context is invalid',
};

// Fixed messages and no `cause`: never the plaintext, the envelope, key
// material or the underlying crypto error
export class SecretBoxError extends Error {
  constructor(readonly code: SecretBoxErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SecretBoxError';
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export interface SecretBoxConfig {
  // `k1:<base64 32-byte key>,k2:<base64 32-byte key>`
  keys?: string;
  // id of the key new values are sealed with
  activeKey?: string;
}

export interface SecretBox {
  seal(plaintext: string, context: string): string;
  open(envelope: string, context: string): string;
  // True when the value was sealed with a key other than the active one
  needsRotation(envelope: string): boolean;
}

const VERSION = 'sb1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_LENGTH = 1024;
const MAX_ENVELOPE_LENGTH = 24 * 1024;
const KEY_ID = /^[a-z0-9_-]{1,32}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function parseKeyring(config: SecretBoxConfig) {
  const keys = new Map<string, Buffer>();
  const entries = (config.keys || '').split(',').map((entry) => entry.trim());

  for (const entry of entries) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    const key = Buffer.from(encoded, 'base64');
    if (
      separator < 0 ||
      !KEY_ID.test(id) ||
      keys.has(id) ||
      key.length !== KEY_BYTES ||
      key.toString('base64') !== encoded
    ) {
      throw new SecretBoxError('NOT_CONFIGURED');
    }
    keys.set(id, key);
  }

  const activeKey = (config.activeKey || '').trim();
  if (!keys.has(activeKey)) {
    throw new SecretBoxError('NOT_CONFIGURED');
  }
  return { keys, activeKey };
}

// Strict, canonical base64url, so one envelope has exactly one spelling
function decodePart(part: string, length?: number) {
  const bytes = Buffer.from(part, 'base64url');
  if (
    !BASE64URL.test(part) ||
    bytes.toString('base64url') !== part ||
    (length !== undefined && bytes.length !== length)
  ) {
    throw new SecretBoxError('MALFORMED');
  }
  return bytes;
}

function parseEnvelope(envelope: string) {
  if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_LENGTH) {
    throw new SecretBoxError('MALFORMED');
  }
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION || !KEY_ID.test(parts[1])) {
    throw new SecretBoxError('MALFORMED');
  }
  return {
    keyId: parts[1],
    iv: decodePart(parts[2], IV_BYTES),
    // empty for an empty plaintext
    ciphertext: decodePart(parts[3]),
    tag: decodePart(parts[4], TAG_BYTES),
  };
}

function aad(keyId: string, context: string) {
  if (
    typeof context !== 'string' ||
    !context.length ||
    context.length > MAX_CONTEXT_LENGTH
  ) {
    throw new SecretBoxError('INVALID_CONTEXT');
  }
  return Buffer.from(`${VERSION}|${keyId}|${context}`, 'utf8');
}

// Tests and explicit configuration; production code uses `secretBox`
export function createSecretBox(config: SecretBoxConfig): SecretBox {
  const { keys, activeKey } = parseKeyring(config);

  const keyFor = (keyId: string) => {
    const key = keys.get(keyId);
    if (!key) {
      throw new SecretBoxError('UNKNOWN_KEY');
    }
    return key;
  };

  return {
    seal(plaintext, context) {
      const data = Buffer.from(
        typeof plaintext === 'string' ? plaintext : '',
        'utf8'
      );
      // lone surrogates would not survive the UTF-8 round trip
      if (
        typeof plaintext !== 'string' ||
        data.toString('utf8') !== plaintext
      ) {
        throw new SecretBoxError('MALFORMED');
      }
      if (data.length > MAX_PLAINTEXT_BYTES) {
        throw new SecretBoxError('PLAINTEXT_TOO_LARGE');
      }

      const additionalData = aad(activeKey, context);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyFor(activeKey), iv, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(additionalData);
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

      return [
        VERSION,
        activeKey,
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.');
    },

    open(envelope, context) {
      const { keyId, iv, ciphertext, tag } = parseEnvelope(envelope);
      const additionalData = aad(keyId, context);
      const key = keyFor(keyId);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(additionalData);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new SecretBoxError('DECRYPT_FAILED');
      }
    },

    needsRotation(envelope) {
      const { keyId } = parseEnvelope(envelope);
      keyFor(keyId);
      return keyId !== activeKey;
    },
  };
}

// Reads SECRET_BOX_KEYS / SECRET_BOX_ACTIVE_KEY on first use, so deployments
// that never seal anything don't need them. A failed read is not cached
let configured: SecretBox | undefined;
const fromEnv = () =>
  (configured ??= createSecretBox({
    keys: process.env.SECRET_BOX_KEYS,
    activeKey: process.env.SECRET_BOX_ACTIVE_KEY,
  }));

export const secretBox: SecretBox = {
  seal: (plaintext, context) => fromEnv().seal(plaintext, context),
  open: (envelope, context) => fromEnv().open(envelope, context),
  needsRotation: (envelope) => fromEnv().needsRotation(envelope),
};
