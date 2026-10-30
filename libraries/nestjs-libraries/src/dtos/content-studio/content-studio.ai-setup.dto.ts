import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CONTENT_STUDIO_FIRST_POST_MODES } from '@gitroom/nestjs-libraries/content-studio/ai/ai.activation.prompt';
import {
  SETUP_COMPANY_NAME_MAX,
  SETUP_DESCRIPTION_MAX,
  SETUP_NOTE_MAX,
  SETUP_TAGLINE_MAX,
  SETUP_WEBSITE_MAX,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.prompt';

// What the user typed for the guided setup's AI draft: the organization's AI
// connection and a few facts about the company. There is no field for a
// model, a provider, a key, an organization, a user or existing profile
// content: the server uses the connection's own model, and the draft is
// returned for review, never saved
export class ContentStudioAISetupProposalDto {
  @IsUUID()
  connectionId: string;

  @IsString()
  @MaxLength(SETUP_COMPANY_NAME_MAX)
  companyName: string;

  @IsOptional()
  @IsString()
  @MaxLength(SETUP_TAGLINE_MAX)
  tagline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(SETUP_WEBSITE_MAX)
  website?: string | null;

  @IsString()
  @MaxLength(SETUP_DESCRIPTION_MAX)
  description: string;

  @IsOptional()
  @IsString()
  @MaxLength(SETUP_NOTE_MAX)
  goal?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(SETUP_NOTE_MAX)
  audience?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(35)
  language?: string | null;
}

// Starting the first post (activation flow 01): the organization's AI
// connection, what to do (see CONTENT_STUDIO_FIRST_POST_MODES), the language
// of the post, the name of its package and, to put an earlier draft back,
// that draft's operation. Nothing of a profile, a preference or a post: the
// server reads those from the organization
export class StartContentStudioFirstPostDto {
  @IsUUID()
  connectionId: string;

  @IsIn(CONTENT_STUDIO_FIRST_POST_MODES)
  mode: string;

  @IsOptional()
  @IsString()
  @MaxLength(35)
  language?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;

  // apply only: an earlier draft of the first post to put back
  @IsOptional()
  @IsUUID()
  draftOperationId?: string | null;
}
