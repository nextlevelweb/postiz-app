import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const AI_CONNECTION_NAME_MAX = 100;
const AI_PROVIDER_ID_MAX = 64;
const AI_MODEL_ID_MAX = 128;

// Validates the field only when it was sent, so null is rejected
const isPresent = (_: object, value: unknown) => value !== undefined;

// The provider is checked against the catalog, the credential against that
// provider's exact schema and the model against that provider's models by the
// service; none is trusted here. There is no field for an id, an
// organization or a sealed value. Left out, defaultModel is the provider's
// default
export class CreateContentStudioAIConnectionDto {
  @IsString()
  @MaxLength(AI_CONNECTION_NAME_MAX)
  name: string;

  @IsString()
  @MaxLength(AI_PROVIDER_ID_MAX)
  provider: string;

  @IsObject()
  credential: Record<string, unknown>;

  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(AI_MODEL_ID_MAX)
  defaultModel?: string;
}

// The name and the default model change here (defaultModel null removes it);
// the provider never does, and the credential has its own route
export class UpdateContentStudioAIConnectionDto {
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(AI_CONNECTION_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(AI_MODEL_ID_MAX)
  defaultModel?: string | null;
}

export class ReplaceContentStudioAIConnectionCredentialDto {
  @IsObject()
  credential: Record<string, unknown>;
}
