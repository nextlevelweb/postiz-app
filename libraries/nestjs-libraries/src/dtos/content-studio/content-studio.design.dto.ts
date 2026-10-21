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
  ValidateIf,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { DESIGN_PROJECT_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { DESIGN_CANVAS_PRESETS } from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;
// revision numbers are PostgreSQL integers
const REVISION_NUMBER_MAX = 2_147_483_647;
// a page set id: a uuid, or "system:" and at most 63 more characters
const PAGE_SET_ID_MAX = 70;
// a template id: a uuid, or "system:" and at most 63 more characters
const TEMPLATE_ID_MAX = 100;
// a thread item id, a template field id, a Media id
const ITEM_ID_MAX = 32;
const SLOT_ID_MAX = 64;
const MEDIA_ID_MAX = 64;

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

// A new design from a saved package revision (P6-01), which the path names:
// the design's name, the id of the thread item whose text it starts with,
// and one starting point, a canvas size, a page set or a template revision
// (with the field for the item's text, the values of its other fields and,
// optionally, one Media of the item and the image field for it). The server
// reads the text, the Media and the revision's hash itself: there is no
// field for any of them, for a document, an organization or a creator
export class CreateContentStudioDesignFromPackageDto {
  @IsString()
  @MaxLength(DESIGN_PROJECT_NAME_MAX)
  name: string;

  @IsString()
  @MaxLength(ITEM_ID_MAX)
  itemId: string;

  @IsOptional()
  @IsIn(DESIGN_CANVAS_PRESETS.map((preset) => preset.id))
  canvas?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PAGE_SET_ID_MAX)
  pageSetId?: string;

  @IsOptional()
  @IsIn(['system', 'organization'])
  templateSource?: 'system' | 'organization';

  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_ID_MAX)
  templateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_ID_MAX)
  templateRevisionId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(REVISION_NUMBER_MAX)
  templateRevisionNumber?: number;

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(SLOT_ID_MAX)
  textSlotId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MEDIA_ID_MAX)
  mediaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SLOT_ID_MAX)
  imageSlotId?: string;
}
