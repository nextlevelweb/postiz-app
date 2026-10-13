import { Injectable } from '@nestjs/common';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import {
  ContentStudioAICredential,
  ContentStudioAICredentialError,
  ContentStudioAIProvider,
  isContentStudioAIProvider,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import { openContentStudioAICredential } from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import { ContentStudioAIResolutionError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAIProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { createOpenAIProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider';
import { createOpenRouterProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/providers/openrouter.provider';

// Organization and connection ids are Prisma uuid() values; anything else
// cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ContentStudioResolvedAIConnection {
  connectionId: string;
  provider: ContentStudioAIProvider;
  adapter: ContentStudioAIProviderAdapter;
}

// One adapter per stored provider. No default: a provider without a case
// here is refused
function createAdapter(
  provider: ContentStudioAIProvider,
  credential: ContentStudioAICredential
): ContentStudioAIProviderAdapter {
  switch (provider) {
    case 'openai':
      return createOpenAIProviderAdapter(credential);
    case 'openrouter':
      return createOpenRouterProviderAdapter(credential);
    default:
      throw new ContentStudioAIResolutionError('PROVIDER_UNSUPPORTED');
  }
}

// A SecretBox without its keyring is an operator problem; anything else
// that does not open is a credential that has to be replaced
const fromCredentialError = (err: unknown) => {
  if (!(err instanceof ContentStudioAICredentialError)) {
    return err;
  }
  return new ContentStudioAIResolutionError(
    err.code === 'UNAVAILABLE'
      ? 'SECRET_STORE_UNAVAILABLE'
      : 'CREDENTIAL_INVALID'
  );
};

// Turns one connection of one organization into a provider adapter. Only the
// connection asked for, only in its own organization: no default connection,
// no environment key and no shared client. Every call opens the credential
// again and makes a new adapter
@Injectable()
export class ContentStudioAIProviderResolver {
  constructor(
    private _contentStudioAIConnectionRepository: ContentStudioAIConnectionRepository
  ) {}

  async resolve(input: {
    organizationId: string;
    connectionId: string;
  }): Promise<ContentStudioResolvedAIConnection> {
    const { organizationId, connectionId } = input;
    if (
      typeof organizationId !== 'string' ||
      typeof connectionId !== 'string' ||
      !UUID.test(organizationId) ||
      !UUID.test(connectionId)
    ) {
      throw new ContentStudioAIResolutionError('NOT_FOUND');
    }

    // archived connections are not returned, so they read as missing
    const row =
      await this._contentStudioAIConnectionRepository.getSealedCredentialForResolver(
        organizationId,
        connectionId
      );
    if (!row) {
      throw new ContentStudioAIResolutionError('NOT_FOUND');
    }
    // refused before the credential is opened or a client exists
    if (row.disabledAt) {
      throw new ContentStudioAIResolutionError('DISABLED');
    }
    if (!row.sealedCredential) {
      throw new ContentStudioAIResolutionError('CREDENTIAL_INVALID');
    }
    if (!isContentStudioAIProvider(row.provider)) {
      throw new ContentStudioAIResolutionError('PROVIDER_UNSUPPORTED');
    }

    let credential: ContentStudioAICredential;
    try {
      credential = openContentStudioAICredential({
        organizationId,
        connectionId: row.id,
        provider: row.provider,
        envelope: row.sealedCredential,
      });
    } catch (err) {
      throw fromCredentialError(err);
    }

    return {
      connectionId: row.id,
      provider: row.provider,
      adapter: createAdapter(row.provider, credential),
    };
  }
}
