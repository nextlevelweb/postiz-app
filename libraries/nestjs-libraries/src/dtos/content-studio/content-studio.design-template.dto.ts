import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { DESIGN_PROJECT_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { DESIGN_TEMPLATE_DESCRIPTION_MAX } from '@gitroom/nestjs-libraries/content-studio/design/design.system.templates';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;
// revision numbers are PostgreSQL integers
const REVISION_NUMBER_MAX = 2_147_483_647;
// a built-in id ("system:…") or a uuid
const TEMPLATE_ID_MAX = 100;

export class ListContentStudioDesignTemplatesDto {
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
// number, a hash or a source: the server sets or refuses them
export class CreateContentStudioDesignTemplateDto {
  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_TEMPLATE_DESCRIPTION_MAX)
  description?: string;

  @IsObject()
  content: Record<string, unknown>;
}

// The name and the description: the document changes through a new revision
export class UpdateContentStudioDesignTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_TEMPLATE_DESCRIPTION_MAX)
  description?: string;
}

export class CreateContentStudioDesignTemplateRevisionDto {
  @IsInt()
  @Min(1)
  @Max(REVISION_NUMBER_MAX)
  baseRevisionNumber: number;

  @IsObject()
  content: Record<string, unknown>;
}

export class ListContentStudioDesignTemplateRevisionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}

// Which exact template revision a new design starts from, and its name: a
// built-in by its id and revision number, one of the organization's by its
// template and revision ids. Never a document
export class InstantiateContentStudioDesignTemplateDto {
  @IsIn(['system', 'organization'])
  source: 'system' | 'organization';

  @IsString()
  @MaxLength(TEMPLATE_ID_MAX)
  templateId: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_ID_MAX)
  revisionId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(REVISION_NUMBER_MAX)
  revisionNumber?: number;

  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name: string;
}

// Saving a stored design revision as a new template: the revision comes from
// the path and its document from the server, never from this body
export class SaveContentStudioDesignAsTemplateDto {
  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_TEMPLATE_DESCRIPTION_MAX)
  description?: string;
}
