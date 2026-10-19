import {
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
  CONTENT_STUDIO_REVIEW_COMMENT_MAX,
  CONTENT_STUDIO_REVIEW_STATES,
  CONTENT_STUDIO_REVIEW_TARGET_TYPES,
  CONTENT_STUDIO_REVISION_REQUEST_MAX,
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

// What must change in the exact revision reviewed, as plain text (the
// service refuses an empty one once trimmed). There is no field for a
// state, a status, an author, a revision, a hash or an organization
export class RequestContentStudioReviewChangesDto {
  @IsString()
  @MaxLength(CONTENT_STUDIO_REVISION_REQUEST_MAX)
  body: string;
}

export class ListContentStudioReviewCommentsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}

// A comment is plain text only: the review comes from the path, the author
// and the organization from the request. No thread, mention, attachment,
// layer, page, source or claim
export class CreateContentStudioReviewCommentDto {
  @IsString()
  @MaxLength(CONTENT_STUDIO_REVIEW_COMMENT_MAX)
  body: string;
}

export class UpdateContentStudioReviewCommentDto {
  @IsString()
  @MaxLength(CONTENT_STUDIO_REVIEW_COMMENT_MAX)
  body: string;
}

// The exact saved revision that made the requested changes, by its id only:
// the type follows from the review, the hash from the revision, the user and
// the time from the request
export class ResolveContentStudioReviewRevisionRequestDto {
  @IsUUID()
  resolutionRevisionId: string;
}
