import { HttpException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import {
  ContentStudioAICredentialError,
  getContentStudioAIDefaultModel,
  getContentStudioAIModel,
  isContentStudioAIModelSupported,
  parseContentStudioAICredential,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import { ContentStudioAIProviderGate } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.gate';
import { sealContentStudioAICredential } from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import { ContentStudioAIResolutionError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIProviderResolver,
  ContentStudioResolvedAIConnection,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
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
const emptyUpdate = () =>
  new HttpException(
    { msg: 'The AI connection update is empty.', code: 'CS_INVALID_REQUEST' },
    400
  );
const modelUnsupported = () =>
  new HttpException(
    {
      msg: 'This AI model is not supported for this connection.',
      code: 'CS_AI_MODEL_UNSUPPORTED',
    },
    400
  );
const connectionDisabled = () =>
  new HttpException(
    {
      msg: 'This AI connection is disabled.',
      code: 'CS_AI_CONNECTION_DISABLED',
    },
    409
  );
const connectionCredentialInvalid = () =>
  new HttpException(
    {
      msg: 'This AI connection credential cannot be read. Replace the credential and try again.',
      code: 'CS_AI_CONNECTION_CREDENTIAL_INVALID',
    },
    409
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

// A connection that cannot become a provider adapter. Nothing of the
// underlying failure is passed on
const fromResolutionError = (err: unknown) => {
  if (!(err instanceof ContentStudioAIResolutionError)) {
    return err;
  }
  switch (err.code) {
    case 'NOT_FOUND':
      return notFound();
    case 'DISABLED':
      return connectionDisabled();
    case 'CREDENTIAL_INVALID':
      return connectionCredentialInvalid();
    case 'SECRET_STORE_UNAVAILABLE':
      return secretStoreUnavailable();
    default:
      return providerUnsupported();
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
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository,
    private _contentStudioAIProviderResolver: ContentStudioAIProviderResolver,
    private _contentStudioAIProviderGate: ContentStudioAIProviderGate
  ) {}

  // only the providers this server offers (Codex only when switched on)
  listProviders() {
    return this._contentStudioAIProviderGate.listProviders();
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
    input: {
      name: string;
      provider: string;
      credential: unknown;
      defaultModel?: unknown;
    }
  ) {
    this.assertManager(actor);
    const name = this.connectionName(input.name);
    if (!this._contentStudioAIProviderGate.isEnabled(input.provider)) {
      throw providerUnsupported();
    }
    // left out, the connection gets its provider's default model
    const defaultModel =
      input.defaultModel === undefined
        ? getContentStudioAIDefaultModel(input.provider)
        : this.supportedModel(input.provider, input.defaultModel);

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
        defaultModel,
        credentialUpdatedAt: new Date(),
        createdById: actor.user.id,
      });
    return toPublicAIConnection(row);
  }

  // The name, the default model or both; a field left out stays as it is and
  // defaultModel null removes it. The model must be one of the provider the
  // connection already has
  async updateConnection(
    actor: ContentStudioAIConnectionActor,
    id: string,
    input: { name?: unknown; defaultModel?: unknown }
  ) {
    this.assertManager(actor);
    if (input.name === undefined && input.defaultModel === undefined) {
      throw emptyUpdate();
    }
    const name =
      input.name === undefined ? undefined : this.connectionName(input.name);
    const organizationId = actor.organization.id;
    const current = await this.getRow(organizationId, id);
    let defaultModel: string | null | undefined;
    if (input.defaultModel === null) {
      defaultModel = null;
    } else if (input.defaultModel !== undefined) {
      defaultModel = this.supportedModel(current.provider, input.defaultModel);
    }

    const { count } =
      await this._contentStudioAIConnectionRepository.updateConnectionMetadata({
        organizationId,
        connectionId: id,
        ...(name === undefined ? {} : { name }),
        ...(defaultModel === undefined ? {} : { defaultModel }),
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

  // Asks the provider whether the connection works. A provider failure is an
  // answer, not an HTTP error: { ok: false, code } with a normalized code, and
  // it is recorded on the connection. A disabled connection, a credential
  // that cannot be read or a missing keyring are refused before any provider
  // call and leave the recorded result as it is
  async testConnection(actor: ContentStudioAIConnectionActor, id: string) {
    this.assertManager(actor);
    const organizationId = actor.organization.id;
    const current = await this.getRow(organizationId, id);
    if (current.disabledAt) {
      throw connectionDisabled();
    }

    let resolved: ContentStudioResolvedAIConnection;
    try {
      resolved = await this._contentStudioAIProviderResolver.resolve({
        organizationId,
        connectionId: current.id,
      });
    } catch (err) {
      throw fromResolutionError(err);
    }

    // the model the connection's AI calls use: its own while its provider
    // still offers it, else the provider's default (as for every AI call)
    const result = await resolved.adapter.validateConnection(
      getContentStudioAIModel(current.provider, current.defaultModel)
        ? (current.defaultModel as string)
        : getContentStudioAIDefaultModel(resolved.provider)
    );
    // `in` narrows without strictNullChecks too (the backend build has it off)
    const code = !result.ok && 'code' in result ? result.code : null;
    const { count } =
      await this._contentStudioAIConnectionRepository.setValidationResult({
        organizationId,
        connectionId: current.id,
        validatedAt: new Date(),
        status: result.ok ? 'valid' : 'invalid',
        code,
      });
    if (count !== 1) {
      // archived or disabled while the provider answered
      const latest = await this.getRow(organizationId, id);
      if (latest.disabledAt) {
        throw connectionDisabled();
      }
    }
    return result.ok ? { ok: true as const } : { ok: false as const, code };
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

  // A model of this provider's catalog, or a fixed 400 that does not repeat
  // what was sent
  private supportedModel(provider: string, model: unknown) {
    if (!isContentStudioAIModelSupported(provider, model)) {
      throw modelUnsupported();
    }
    return model as string;
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
