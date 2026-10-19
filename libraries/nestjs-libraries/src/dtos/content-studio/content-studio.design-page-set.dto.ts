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
import {
  DESIGN_PAGE_SET_DESCRIPTION_MAX,
  DESIGN_PAGE_SET_NAME_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;

export class ListContentStudioDesignPageSetsDto {
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

// The pages are checked against Page Set v1 by the service, not here. There
// is no field for an organization, a creator, a hash, a design, a page id,
// layers, a Brand Kit, template guidance or a source
export class CreateContentStudioDesignPageSetDto {
  @IsString()
  @MaxLength(DESIGN_PAGE_SET_NAME_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_PAGE_SET_DESCRIPTION_MAX)
  description?: string;

  @IsObject()
  content: Record<string, unknown>;
}

// The name, the description and the pages of a page set, each optional
export class UpdateContentStudioDesignPageSetDto {
  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_PAGE_SET_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_PAGE_SET_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;
}
