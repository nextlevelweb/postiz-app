import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CONTENT_STUDIO_AI_MAX_SOURCES } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';

export const AI_WRITING_ITEM_OPERATIONS = [
  'generate_item',
  'rewrite_item',
  'shorten_item',
  'expand_item',
  'change_tone',
] as const;
export type ContentStudioAIWritingItemOperation =
  (typeof AI_WRITING_ITEM_OPERATIONS)[number];

export const AI_WRITING_THREAD_OPERATIONS = ['generate_thread'] as const;

// Counted in UTF-16 code units after line endings are normalized and the
// outer whitespace is trimmed (the service does both)
export const AI_WRITING_INSTRUCTION_MAX = 2000;
const MODEL_ID_MAX = 128;
// draftVersion is a Postgres integer
const DRAFT_VERSION_MAX = 2_147_483_647;
// The same rule as a draft item id (content.package.draft.ts)
const ITEM_ID = /^[A-Za-z0-9_-]{1,32}$/;

// What the user chose for one AI writing action. The connection and the
// model are named explicitly: there is no default. A profile left out or
// null, or the editorial policy left out or false, is not used. There is no
// field for an organization, a user, a provider, a prompt, a credential or a
// revision: the server takes the current revision of each selected profile.
// Sources are named the same way, by id only and in the order chosen: the
// server takes the current version of each and its blocks. There is no field
// for a source version, a hash or source text
class ContentStudioAIWritingSelectionDto {
  @IsUUID()
  connectionId: string;

  @IsString()
  @MaxLength(MODEL_ID_MAX)
  model: string;

  @IsInt()
  @Min(1)
  @Max(DRAFT_VERSION_MAX)
  baseDraftVersion: number;

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
  @IsArray()
  @ArrayMaxSize(CONTENT_STUDIO_AI_MAX_SOURCES)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  sourceIds?: string[] | null;

  @IsOptional()
  @IsString()
  @MaxLength(AI_WRITING_INSTRUCTION_MAX)
  instruction?: string | null;
}

export class ContentStudioAIItemProposalDto extends ContentStudioAIWritingSelectionDto {
  @IsIn(AI_WRITING_ITEM_OPERATIONS)
  operation: ContentStudioAIWritingItemOperation;

  @IsString()
  @Matches(ITEM_ID)
  itemId: string;
}

export class ContentStudioAIThreadProposalDto extends ContentStudioAIWritingSelectionDto {
  @IsIn(AI_WRITING_THREAD_OPERATIONS)
  operation: 'generate_thread';
}
