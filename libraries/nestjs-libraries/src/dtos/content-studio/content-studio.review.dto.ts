import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  CONTENT_STUDIO_REVIEW_STATES,
  CONTENT_STUDIO_REVIEW_TARGET_TYPES,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;

// The revision id narrows the list only together with its target type (the
// service refuses it alone)
export class ListContentStudioReviewsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;

  @IsOptional()
  @IsIn(CONTENT_STUDIO_REVIEW_TARGET_TYPES)
  targetType?: string;

  @IsOptional()
  @IsUUID()
  targetRevisionId?: string;

  @IsOptional()
  @IsIn(CONTENT_STUDIO_REVIEW_STATES)
  state?: string;
}

// The exact revision to review, nothing else: the organization and the user
// come from the request, the hash from the revision, the state is REQUESTED.
// There is no field for a package, a design, "the latest", a hash, a state,
// a reviewer or a reason
export class CreateContentStudioReviewDto {
  @IsIn(CONTENT_STUDIO_REVIEW_TARGET_TYPES)
  targetType: string;

  @IsUUID()
  targetRevisionId: string;
}
