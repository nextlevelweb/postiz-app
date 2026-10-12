import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { PACKAGE_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { toQueryBoolean } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

// Validates the field only when it was sent, so null is rejected
const isPresent = (_: object, value: unknown) => value !== undefined;

const PAGE_MAX = 100_000;
// draftVersion is a Postgres integer
const DRAFT_VERSION_MAX = 2_147_483_647;

export const CONTENT_PACKAGE_REVISION_ORIGINS = ['manual', 'handoff'] as const;
export type ContentPackageRevisionOrigin =
  (typeof CONTENT_PACKAGE_REVISION_ORIGINS)[number];

export class ListContentPackagesDto {
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

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

// Left out or blank, the service names the package "Untitled package"
export class CreateContentPackageDto {
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(PACKAGE_NAME_MAX)
  name?: string;

  @ValidateIf(isPresent)
  @IsUUID()
  projectId?: string;
}

// projectId null detaches the package from its project
export class UpdateContentPackageDto {
  @ValidateIf(isPresent)
  @IsString()
  @MaxLength(PACKAGE_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string | null;
}

export class SaveContentPackageDraftDto {
  @IsInt()
  @Min(1)
  @Max(DRAFT_VERSION_MAX)
  baseDraftVersion: number;

  // Only the top level is checked here. The draft itself is validated by the
  // Content Studio draft schema in the service, so it is kept exactly as
  // parsed from the request instead of being converted by class-transformer
  @IsObject()
  @Transform(({ obj }) => obj.draft)
  draft: Record<string, unknown>;
}

// The revision is made from the stored draft, and only while it is still at
// draftVersion. Left out, origin is 'manual'
export class CreateContentPackageRevisionDto {
  @IsInt()
  @Min(1)
  @Max(DRAFT_VERSION_MAX)
  draftVersion: number;

  @ValidateIf(isPresent)
  @IsIn(CONTENT_PACKAGE_REVISION_ORIGINS)
  origin?: ContentPackageRevisionOrigin;
}

export class ListContentPackageRevisionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}
