import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { CONTENT_STUDIO_SOURCE_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import { CONTENT_STUDIO_SOURCE_URL_MAX_BYTES } from '@gitroom/nestjs-libraries/content-studio/sources/source.url';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;

export class ListContentStudioSourcesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;

  @IsOptional()
  @IsBoolean()
  @Transform(toQueryBoolean)
  archived: boolean = false;
}

// The kind and the URL are checked and canonicalized by the service, not here.
// There is no field for an organization, a creator, a canonical URL, a
// version, content or any fetch metadata: the server sets them, and only its
// own ingestion records a capture
export class CreateContentStudioSourceDto {
  @IsString()
  kind: string;

  @IsString()
  @MaxLength(CONTENT_STUDIO_SOURCE_NAME_MAX)
  name: string;

  @IsString()
  @MaxLength(CONTENT_STUDIO_SOURCE_URL_MAX_BYTES)
  url: string;
}

// Only the name: the URL is the source's identity
export class UpdateContentStudioSourceDto {
  @IsString()
  @MaxLength(CONTENT_STUDIO_SOURCE_NAME_MAX)
  name: string;
}

export class ListContentStudioSourceVersionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}

// The pages a feed found: one page of them, nothing else
export class ListContentStudioSourceDiscoveriesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}
