import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { PROJECT_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

// Query values arrive as text. Only 'true' and 'false' become booleans;
// anything else is left as it is, so @IsBoolean rejects it
export const toQueryBoolean = ({ value }: TransformFnParams) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListContentStudioProjectsDto {
  @IsOptional()
  @IsBoolean()
  @Transform(toQueryBoolean)
  archived: boolean = false;
}

export class CreateContentStudioProjectDto {
  @IsString()
  @MaxLength(PROJECT_NAME_MAX)
  name: string;
}

export class UpdateContentStudioProjectDto {
  @IsString()
  @MaxLength(PROJECT_NAME_MAX)
  name: string;
}
