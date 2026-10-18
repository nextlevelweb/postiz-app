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
import {
  DESIGN_STYLE_PRESET_DESCRIPTION_MAX,
  DESIGN_STYLE_PRESET_KINDS,
  DESIGN_STYLE_PRESET_NAME_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;

export class ListContentStudioDesignStylePresetsDto {
  @IsOptional()
  @IsIn(DESIGN_STYLE_PRESET_KINDS)
  kind?: 'text' | 'shape';

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

// The style is checked against Style Preset v1 by the service, not here:
// it holds the kind, so there is no separate kind field. There is no field
// for an organization, a creator, a hash, a layer, a design or a source
export class CreateContentStudioDesignStylePresetDto {
  @IsString()
  @MaxLength(DESIGN_STYLE_PRESET_NAME_MAX)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_STYLE_PRESET_DESCRIPTION_MAX)
  description?: string;

  @IsObject()
  content: Record<string, unknown>;
}

// The name, the description and the style of a preset, each optional; the
// style keeps the preset's kind
export class UpdateContentStudioDesignStylePresetDto {
  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_STYLE_PRESET_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_STYLE_PRESET_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;
}
