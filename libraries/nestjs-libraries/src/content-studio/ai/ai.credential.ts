import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  secretBox,
  SecretBoxError,
} from '@gitroom/nestjs-libraries/services/secret.box';
import {
  ContentStudioAICredential,
  ContentStudioAICredentialError,
  ContentStudioAICredentialErrorCode,
  isContentStudioAIProvider,
  parseContentStudioAICredential,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

// Organization and connection ids are Prisma uuid() values. Checking them
// keeps the `|` separated context unambiguous
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PAYLOAD_VERSION = 1;

interface ConnectionIdentity {
  organizationId: string;
  connectionId: string;
}

// The SecretBox context of one connection: an envelope sealed for one
// organization and connection opens for no other
export function aiConnectionSecretContext(
  organizationId: string,
  connectionId: string
) {
  if (
    typeof organizationId !== 'string' ||
    typeof connectionId !== 'string' ||
    !UUID.test(organizationId) ||
    !UUID.test(connectionId)
  ) {
    throw new ContentStudioAICredentialError('INVALID_CONTEXT');
  }
  return `ai-connection|${organizationId}|${connectionId}`;
}

// A SecretBox without its keyring is an operator problem, not a bad
// credential; every other failure becomes `otherwise`
const fromSecretBox = (
  err: unknown,
  otherwise: ContentStudioAICredentialErrorCode
) =>
  new ContentStudioAICredentialError(
    err instanceof SecretBoxError && err.code === 'NOT_CONFIGURED'
      ? 'UNAVAILABLE'
      : otherwise
  );

// Validates a credential for its provider and seals it for one connection.
// The id must exist before the row does, so the service generates it first
export function sealContentStudioAICredential(
  input: ConnectionIdentity & { provider: string; credential: unknown }
): string {
  const context = aiConnectionSecretContext(
    input.organizationId,
    input.connectionId
  );
  const { apiKey } = parseContentStudioAICredential(
    input.provider,
    input.credential
  );
  try {
    return secretBox.seal(
      canonicalJson({ v: PAYLOAD_VERSION, apiKey }),
      context
    );
  } catch (err) {
    throw fromSecretBox(err, 'INVALID');
  }
}

// Opens a stored envelope with the provider of its own row. Anything that
// does not open or is not exactly a v1 credential of that provider is
// UNREADABLE; the caller gets the typed credential, never the plaintext
export function openContentStudioAICredential(
  input: ConnectionIdentity & { provider: string; envelope: string }
): ContentStudioAICredential {
  const context = aiConnectionSecretContext(
    input.organizationId,
    input.connectionId
  );
  if (!isContentStudioAIProvider(input.provider)) {
    throw new ContentStudioAICredentialError('UNREADABLE');
  }

  let plaintext: string;
  try {
    plaintext = secretBox.open(input.envelope, context);
  } catch (err) {
    throw fromSecretBox(err, 'UNREADABLE');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new ContentStudioAICredentialError('UNREADABLE');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    (payload as { v?: unknown }).v !== PAYLOAD_VERSION
  ) {
    throw new ContentStudioAICredentialError('UNREADABLE');
  }
  const { v, ...credential } = payload as Record<string, unknown>;
  try {
    return parseContentStudioAICredential(input.provider, credential);
  } catch {
    throw new ContentStudioAICredentialError('UNREADABLE');
  }
}
