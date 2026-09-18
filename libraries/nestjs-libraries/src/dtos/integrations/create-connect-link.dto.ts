import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Creates a temporary customer-facing connection link.
 *
 * A connect link may be reused during its lifetime so a customer can connect
 * multiple integrations. Keep the lifetime deliberately short.
 */
export class CreateConnectLinkDto {
  @IsInt()
  @Min(1)
  @Max(168)
  @IsOptional()
  expiresInHours?: number;
}
