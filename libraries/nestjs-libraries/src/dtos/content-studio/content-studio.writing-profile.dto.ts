import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { WRITING_PROFILE_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;
// revision numbers are PostgreSQL integers
const REVISION_NUMBER_MAX = 2_147_483_647;

export class ListContentStudioWritingProfilesDto {
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

// The Writing DNA is checked against its exact schema by the service, not
// here. There is no field for an organization, a creator, a revision number
// or a hash: the server sets them
export class CreateContentStudioWritingProfileDto {
  @IsString()
  @MaxLength(WRITING_PROFILE_NAME_MAX)
  name: string;

  @IsObject()
  content: Record<string, unknown>;
}

// Only the name: the Writing DNA changes through a new revision
export class UpdateContentStudioWritingProfileDto {
  @IsString()
  @MaxLength(WRITING_PROFILE_NAME_MAX)
  name: string;
}

export class CreateContentStudioWritingProfileRevisionDto {
  @IsInt()
  @Min(1)
  @Max(REVISION_NUMBER_MAX)
  baseRevisionNumber: number;

  @IsObject()
  content: Record<string, unknown>;
}

export class ListContentStudioWritingProfileRevisionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}
