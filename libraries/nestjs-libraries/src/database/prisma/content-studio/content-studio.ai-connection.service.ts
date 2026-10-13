import { HttpException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import {
  ContentStudioAICredentialError,
  isContentStudioAIProvider,
  listContentStudioAIProviders,
  parseContentStudioAICredential,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import { sealContentStudioAICredential } from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import { AI_CONNECTION_NAME_MAX } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-connection.dto';

// Fixed messages only: never a key, an envelope, a SecretBox or Zod message.
// A connection of another organization is a plain 404. A refused manager is a
// plain 403 HttpException (HttpForbiddenException would log the user out);
// nothing here answers 401, 402 or 406, which the app treats as session or
// billing problems
const notFound = () =>
  new HttpException(
    { msg: 'AI connection not found.', code: 'CS_NOT_FOUND' },
    404
  );
const adminRequired = () =>
  new HttpException(
    {
      msg: 'You do not have permission to manage AI connections.',
      code: 'CS_AI_ADMIN_REQUIRED',
    },
    403
  );
const invalidName = () =>
  new HttpException(
    { msg: 'The AI connection name is invalid.', code: 'CS_INVALID_REQUEST' },
    400
  );
const providerUnsupported = () =>
  new HttpException(
    {
      msg: 'This AI provider is not supported.',
      code: 'CS_AI_PROVIDER_UNSUPPORTED',
    },
    400
  );
const credentialInvalid = () =>
  new HttpException(
    { msg: 'The AI credential is invalid.', code: 'CS_AI_CREDENTIAL_INVALID' },
    400
  );
const secretStoreUnavailable = () =>
  new HttpException(
    {
      msg: 'AI credential storage is not available.',
      code: 'CS_AI_SECRET_STORE_UNAVAILABLE',
    },
    503
  );
const operationFailed = () =>
  new HttpException(
    {
      msg: 'Could not update this AI connection.',
      code: 'CS_AI_OPERATION_FAILED',
    },
    500
  );

const fromCredentialError = (err: unknown) => {
  if (!(err instanceof ContentStudioAICredentialError)) {
    return err;
  }
  switch (err.code) {
    case 'INVALID':
      return credentialInvalid();
    case 'UNAVAILABLE':
      return secretStoreUnavailable();
    default:
      // ids come from the request context and the server, so a bad context
      // or an unreadable value here is a server fault
      return operationFailed();
  }
};

const MANAGER_ROLES: string[] = [Role.ADMIN, Role.SUPERADMIN];
// Connection ids are Prisma uuid() values; anything else cannot exist
const CONNECTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The organization as the auth middleware puts it on the request: `users`
// holds only the requesting user's own membership (getOrgsByUserId and the
// impersonation path both filter it by user id)
export interface ContentStudioAIConnectionActor {
  organization: {
    id: string;
    users?: Array<{ role?: string; disabled?: boolean; userId?: string }>;
  };
  user: { id: string };
}

interface ConnectionRow {
  id: string;
  name: string;
  provider: string;
  defaultModel: string | null;
  disabledAt: Date | null;
  credentialUpdatedAt: Date;
  lastValidatedAt: Date | null;
  lastValidationStatus: string | null;
  lastValidationCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// The only shape a connection leaves the server in. Built field by field, so
// nothing a row happens to carry (organization, creator, envelope) can leak.
// Every active connection has a credential: it is created with one and
// archiving removes both the row from reads and the credential
export const toPublicAIConnection = (row: ConnectionRow) => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  defaultModel: row.defaultModel,
  disabled: row.disabledAt !== null,
  credentialPresent: true,
  credentialUpdatedAt: row.credentialUpdatedAt,
  lastValidatedAt: row.lastValidatedAt,
  lastValidationStatus: row.lastValidationStatus,
  lastValidationCode: row.lastValidationCode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// Organization AI connections: every member may see them (and later use
// them); only ADMIN and SUPERADMIN members may change them. This is checked
// here from the membership role, never through CheckPolicies, which allows
// everything when billing is not configured, and never through the AI
// subscription section: customer managed connections are not billed
@Injectable()
export class ContentStudioAIConnectionService {
  constructor(
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository
  ) {}

  listProviders() {
    return listContentStudioAIProviders();
  }

  async listConnections(organizationId: string) {
    const rows =
      await this._contentStudioAIConnectionRepository.listConnectionsForOrganization(
        organizationId
      );
    return rows.map(toPublicAIConnection);
  }

  async getConnection(organizationId: string, id: string) {
    return toPublicAIConnection(await this.getRow(organizationId, id));
  }

  async createConnection(
    actor: ContentStudioAIConnectionActor,
    input: { name: string; provider: string; credential: unknown }
  ) {
    this.assertManager(actor);
    const name = this.connectionName(input.name);
    if (!isContentStudioAIProvider(input.provider)) {
      throw providerUnsupported();
    }

    // the id exists before the row: the credential is sealed for it
    const id = randomUUID();
    let sealedCredential: string;
    try {
      const credential = parseContentStudioAICredential(
        input.provider,
        input.credential
      );
      sealedCredential = sealContentStudioAICredential({
        organizationId: actor.organization.id,
        connectionId: id,
        provider: input.provider,
        credential,
      });
    } catch (err) {
      throw fromCredentialError(err);
    }

    const row =
      await this._contentStudioAIConnectionRepository.createConnection({
        id,
        organizationId: actor.organization.id,
        name,
        provider: input.provider,
        sealedCredential,
        defaultModel: null,
        credentialUpdatedAt: new Date(),
        createdById: actor.user.id,
      });
    return toPublicAIConnection(row);
  }

  async renameConnection(
    actor: ContentStudioAIConnectionActor,
    id: string,
    rawName: string
  ) {
    this.assertManager(actor);
    const name = this.connectionName(rawName);
    const organizationId = actor.organization.id;
    await this.getRow(organizationId, id);

    const { count } =
      await this._contentStudioAIConnectionRepository.updateConnectionMetadata({
        organizationId,
        connectionId: id,
        name,
      });
    if (count !== 1) {
      throw notFound();
    }
    return this.getConnection(organizationId, id);
  }

  // The new key is checked against the provider the connection already has
  // and sealed for the same connection; the old envelope is never read
  async replaceCredential(
    actor: ContentStudioAIConnectionActor,
    id: string,
    credentialInput: unknown
  ) {
    this.assertManager(actor);
    const organizationId = actor.organization.id;
    const current = await this.getRow(organizationId, id);

    let sealedCredential: string;
    try {
      const credential = parseContentStudioAICredential(
        current.provider,
        credentialInput
      );
      sealedCredential = sealContentStudioAICredential({
        organizationId,
        connectionId: current.id,
        provider: current.provider,
        credential,
      });
    } catch (err) {
      throw fromCredentialError(err);
    }

    const { count } =
      await this._contentStudioAIConnectionRepository.replaceCredential({
        organizationId,
        connectionId: current.id,
        sealedCredential,
        credentialUpdatedAt: new Date(),
      });
    if (count !== 1) {
      throw notFound();
    }
    return this.getConnection(organizationId, id);
  }

  // Idempotent: a connection that is already disabled is returned as it is
  async disableConnection(actor: ContentStudioAIConnectionActor, id: string) {
    this.assertManager(actor);
    const organizationId = actor.organization.id;
    const current = await this.getRow(organizationId, id);
    if (current.disabledAt) {
      return toPublicAIConnection(current);
    }
    await this._contentStudioAIConnectionRepository.disableConnection(
      organizationId,
      id,
      new Date()
    );
    return this.getConnection(organizationId, id);
  }

  // Idempotent: a connection that is already enabled is returned as it is
  async enableConnection(actor: ContentStudioAIConnectionActor, id: string) {
    this.assertManager(actor);
    const organizationId = actor.organization.id;
    const current = await this.getRow(organizationId, id);
    if (!current.disabledAt) {
      return toPublicAIConnection(current);
    }
    await this._contentStudioAIConnectionRepository.enableConnection(
      organizationId,
      id
    );
    return this.getConnection(organizationId, id);
  }

  // Removal for good: the repository wipes the credential in the same write.
  // An archived connection is gone from every read, so a second archive is a
  // 404 and there is no restore
  async archiveConnection(actor: ContentStudioAIConnectionActor, id: string) {
    this.assertManager(actor);
    const organizationId = actor.organization.id;
    await this.getRow(organizationId, id);
    const { count } =
      await this._contentStudioAIConnectionRepository.archiveConnection(
        organizationId,
        id,
        new Date()
      );
    if (count !== 1) {
      throw notFound();
    }
    return { id };
  }

  // Exactly one membership, the requesting user's own, enabled, with a
  // manager role. Anything else (no membership, a disabled one, several, one
  // of another user) is refused
  private assertManager(actor: ContentStudioAIConnectionActor) {
    const memberships = actor.organization.users;
    if (!Array.isArray(memberships) || memberships.length !== 1) {
      throw adminRequired();
    }
    const [membership] = memberships;
    if (
      !membership ||
      membership.disabled ||
      (membership.userId !== undefined &&
        membership.userId !== actor.user.id) ||
      !MANAGER_ROLES.includes(membership.role as string)
    ) {
      throw adminRequired();
    }
  }

  // Trimmed, 1-100 characters, no NUL or unpaired surrogate
  private connectionName(name: unknown) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (
      !trimmed ||
      trimmed.length > AI_CONNECTION_NAME_MAX ||
      trimmed.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(trimmed)
    ) {
      throw invalidName();
    }
    return trimmed;
  }

  private async getRow(organizationId: string, id: string) {
    if (typeof id !== 'string' || !CONNECTION_ID.test(id)) {
      throw notFound();
    }
    const row =
      await this._contentStudioAIConnectionRepository.getConnectionForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }
}
