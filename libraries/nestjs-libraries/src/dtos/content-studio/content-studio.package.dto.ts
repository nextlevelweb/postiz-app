import {
  IsBoolean,
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

export class ListContentPackagesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
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
  @Max(2_147_483_647)
  baseDraftVersion: number;

  // Only the top level is checked here. The draft itself is validated by the
  // Content Studio draft schema in the service, so it is kept exactly as
  // parsed from the request instead of being converted by class-transformer
  @IsObject()
  @Transform(({ obj }) => obj.draft)
  draft: Record<string, unknown>;
}
