import { IsObject, IsString, MaxLength } from 'class-validator';

export const AI_CONNECTION_NAME_MAX = 100;
const AI_PROVIDER_ID_MAX = 64;

// The provider is checked against the catalog and the credential against
// that provider's exact schema by the service; neither is trusted here. There
// is no field for an id, an organization, a sealed value or a model
export class CreateContentStudioAIConnectionDto {
  @IsString()
  @MaxLength(AI_CONNECTION_NAME_MAX)
  name: string;

  @IsString()
  @MaxLength(AI_PROVIDER_ID_MAX)
  provider: string;

  @IsObject()
  credential: Record<string, unknown>;
}

// Only the name changes here: the provider never does, and the credential
// has its own route
export class UpdateContentStudioAIConnectionDto {
  @IsString()
  @MaxLength(AI_CONNECTION_NAME_MAX)
  name: string;
}

export class ReplaceContentStudioAIConnectionCredentialDto {
  @IsObject()
  credential: Record<string, unknown>;
}
