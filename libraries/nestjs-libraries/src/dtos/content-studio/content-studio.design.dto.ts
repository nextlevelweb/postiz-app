import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { DESIGN_PROJECT_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;
// revision numbers are PostgreSQL integers
const REVISION_NUMBER_MAX = 2_147_483_647;
// a page set id: a uuid, or "system:" and at most 63 more characters
const PAGE_SET_ID_MAX = 70;

export class ListContentStudioDesignsDto {
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

// The design document is checked against its exact schema by the service,
// not here. There is no field for an organization, a creator, a revision
// number, a hash, render settings or an upload: the server sets or refuses
// them. A new design starts from exactly one source: its first document, or
// a page set (P4-17) by its id, a built-in or one of the organization's,
// whose blank pages the server makes (never pages sent with it). A page set
// with a document too is refused; neither is an invalid document
export class CreateContentStudioDesignDto {
  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name: string;

  // required unless a page set is named
  @ValidateIf(
    (body: CreateContentStudioDesignDto) => body.pageSetId === undefined
  )
  @IsObject()
  content?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(PAGE_SET_ID_MAX)
  pageSetId?: string;
}

// Only the name: the document changes through a new revision
export class UpdateContentStudioDesignDto {
  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name: string;
}

export class CreateContentStudioDesignRevisionDto {
  @IsInt()
  @Min(1)
  @Max(REVISION_NUMBER_MAX)
  baseRevisionNumber: number;

  @IsObject()
  content: Record<string, unknown>;
}

export class ListContentStudioDesignRevisionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}
