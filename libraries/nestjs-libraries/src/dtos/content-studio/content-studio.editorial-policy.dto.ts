import { IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';

// Digits only: '2' becomes 2, while '2abc', '' or '1.5' stay text and fail
const toQueryInteger = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const PAGE_MAX = 100_000;
// revision numbers are PostgreSQL integers
const REVISION_NUMBER_MAX = 2_147_483_647;

// The policy is checked against its exact schema by the service, not here.
// 0 is the base of the first save. There is no field for an organization, a
// policy, a creator, a revision number or a hash: the server sets them
export class CreateContentStudioEditorialPolicyRevisionDto {
  @IsInt()
  @Min(0)
  @Max(REVISION_NUMBER_MAX)
  baseRevisionNumber: number;

  @IsObject()
  content: Record<string, unknown>;
}

export class ListContentStudioEditorialPolicyRevisionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  @Transform(toQueryInteger)
  page: number = 1;
}
