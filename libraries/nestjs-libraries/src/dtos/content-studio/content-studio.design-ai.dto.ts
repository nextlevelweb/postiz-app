import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  ContentStudioDesignAIIntent,
  DESIGN_AI_INTENTS,
} from '@gitroom/nestjs-libraries/content-studio/design/design.ai.proposal';
import { AI_WRITING_INSTRUCTION_MAX } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-writing.dto';

// What the user chose for one Design Creative AI suggestion (P6-02): the
// intent, the organization's AI connection, an optional instruction and, for
// copy intents, the same optional profiles as AI writing. The design and its
// exact revision are the route. There is no field for a model, a provider, a
// key, an organization, a user, a hash, a document, a layer, Media or a URL:
// the server reads the revision, its Brand Kit revision and the connection's
// model itself
export class ContentStudioDesignAIProposalDto {
  @IsIn(DESIGN_AI_INTENTS)
  intent: ContentStudioDesignAIIntent;

  @IsUUID()
  connectionId: string;

  @IsOptional()
  @IsUUID()
  writingProfileId?: string | null;

  @IsOptional()
  @IsBoolean()
  editorialPolicy?: boolean;

  @IsOptional()
  @IsUUID()
  audienceProfileId?: string | null;

  @IsOptional()
  @IsUUID()
  expertiseProfileId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(AI_WRITING_INSTRUCTION_MAX)
  instruction?: string | null;
}
