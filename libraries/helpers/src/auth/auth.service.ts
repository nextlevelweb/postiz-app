import { sign, SignOptions, verify } from 'jsonwebtoken';
import { hashSync, compareSync } from 'bcrypt';
import crypto from 'crypto';
// @ts-ignore
import EVP_BytesToKey from 'evp_bytestokey';
const algorithm = 'aes-256-cbc';
const { keyLength, ivLength } = crypto.getCipherInfo(algorithm);

function deriveLegacyKeyIv(secret: string) {
  const { keyLength, ivLength } = crypto.getCipherInfo(algorithm); // 32, 16
  const pass = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? '', 'utf8');

  // evp_bytestokey: key length in **bits**, IV length in **bytes**
  const { key, iv } = EVP_BytesToKey(pass, null, keyLength * 8, ivLength, 'md5');

  if (key.length !== keyLength || iv.length !== ivLength) {
    throw new Error(`Derived wrong sizes (key=${key.length}, iv=${iv.length})`);
  }
  return { key, iv };
}

export function decrypt_legacy_using_IV(hexCiphertext: string) {
  const { key, iv } = deriveLegacyKeyIv(process.env.JWT_SECRET);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  const out = Buffer.concat([decipher.update(hexCiphertext, 'hex'), decipher.final()]);
  return out.toString('utf8');
}

export function encrypt_legacy_using_IV(utf8Plaintext: string) {
  const { key, iv } = deriveLegacyKeyIv(process.env.JWT_SECRET);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const out = Buffer.concat([cipher.update(utf8Plaintext, 'utf8'), cipher.final()]);
  return out.toString('hex');
}
export class AuthService {
  static hashPassword(password: string) {
    return hashSync(password, 10);
  }
  static comparePassword(password: string, hash: string) {
    return compareSync(password, hash);
  }
  // Tokens signed since Review 20 say what they are for (`purpose`: session,
  // password_reset, invite, activation, connect-link) and, unless they are a
  // session, when they expire (`exp`, enforced by verify)
  static signJWT(value: object, options?: Pick<SignOptions, 'expiresIn'>) {
    return sign(value, process.env.JWT_SECRET!, options);
  }
  static verifyJWT(token: string) {
    return verify(token, process.env.JWT_SECRET!);
  }

  // A login session only. Every token kind shares JWT_SECRET, so a password
  // reset, invite or activation link would otherwise work as a session.
  // Refused: another purpose, and the shapes those links had before they
  // carried one (a reset has `expires`, an invite `timeLimit` and `orgId`, an
  // activation link `activated: false`). A session is the user row, which has
  // none of these, so sessions signed before purposes existed stay valid
  static verifySessionJWT(token: string): { id: string } & Record<
    string,
    unknown
  > {
    const payload = verify(token, process.env.JWT_SECRET!) as unknown;
    if (!payload || typeof payload !== 'object') {
      throw new Error('Not a session token');
    }
    const claims = payload as Record<string, unknown>;
    if (
      (claims.purpose !== undefined && claims.purpose !== 'session') ||
      'expires' in claims ||
      'timeLimit' in claims ||
      'orgId' in claims ||
      claims.activated === false ||
      typeof claims.id !== 'string'
    ) {
      throw new Error('Not a session token');
    }
    return claims as { id: string } & Record<string, unknown>;
  }

  static fixedEncryption(value: string) {
    return encrypt_legacy_using_IV(value);
  }

  static fixedDecryption(hash: string) {
    return decrypt_legacy_using_IV(hash);
  }
}
