import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES,
  CONTENT_STUDIO_DISCOVERY_WINDOWS,
  CONTENT_STUDIO_SOURCE_KINDS,
  CONTENT_STUDIO_SOURCE_NAME_MAX,
  CONTENT_STUDIO_SOURCE_SEARCH_MAX,
  ContentStudioDiscoveryCaptureState,
  ContentStudioDiscoveryWindow,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
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

  // One kind only (P8-02); without it every kind, as before
  @IsOptional()
  @IsIn(CONTENT_STUDIO_SOURCE_KINDS)
  kind?: string;

  // Part of the name or the URL (P8-03), any case; blank is none. The
  // service trims it and refuses control text
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_STUDIO_SOURCE_SEARCH_MAX)
  search?: string;
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

// News Radar (P8-02): what the organization's live feeds found. The window is
// named, never a timestamp: the server reads it as a first sighting at or
// after now minus the window, 7 days when absent. A feed narrows it to one
// feed of the organization; a capture state to pages with or without a
// version. There is no field for an organization, an order, a kind, a search
// or archived feeds
export class ListContentStudioDiscoveriesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;

  @IsOptional()
  @IsIn(CONTENT_STUDIO_DISCOVERY_WINDOWS)
  since?: ContentStudioDiscoveryWindow;

  @IsOptional()
  @IsUUID()
  feedSourceId?: string;

  @IsOptional()
  @IsIn(CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES)
  captureState?: ContentStudioDiscoveryCaptureState;
}

// Organization Changes (P8-04B1): a page and how far back the last page
// change may be (the News Radar windows; 7 days when not given). Nothing else
export class ListContentStudioSourceChangesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;

  @IsOptional()
  @IsIn(CONTENT_STUDIO_DISCOVERY_WINDOWS)
  since?: ContentStudioDiscoveryWindow;
}
