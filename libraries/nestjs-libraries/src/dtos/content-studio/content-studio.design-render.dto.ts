import { IsIn, IsInt, IsString, Matches, MaxLength } from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { DESIGN_FONT_FAMILY_MAX } from '@gitroom/nestjs-libraries/content-studio/design/design.document';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the Design Document page id rule
const PAGE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// Multipart fields are text: '400' becomes 400, anything else stays text and
// fails
const toFormInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

// The exact revision and the page, nothing else: no latest revision, no
// organization, creator, assets, Media, fonts, bytes, URLs or render options
// (format, size, quality). The server reads every input itself
export class RenderContentStudioDesignDto {
  @IsString()
  @Matches(UUID)
  revisionId: string;

  @IsString()
  @Matches(PAGE_ID)
  pageId: string;
}

// Every page of exactly this revision, in the design's order: no page list
// or order, no latest revision, no organization, creator, assets or render
// options. The server reads every page itself
export class RenderAllContentStudioDesignDto {
  @IsString()
  @Matches(UUID)
  revisionId: string;
}

// The multipart fields beside the `file` part: the exact family, weight and
// style the file is the font for. No organization, creator, hash, storage
// key, path, URL or file name: the server derives what it stores from the
// bytes. The service checks the family exactly as a design names it
export class UploadContentStudioRenderFontDto {
  @IsString()
  @MaxLength(DESIGN_FONT_FAMILY_MAX)
  family: string;

  @IsInt()
  @IsIn(BRAND_FONT_WEIGHTS as unknown as number[])
  @Transform(toFormInteger)
  weight: number;

  @IsString()
  @IsIn(BRAND_FONT_STYLES as unknown as string[])
  style: string;
}
