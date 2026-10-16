import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioAIConnectionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';
import { ContentStudioWritingProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioAudienceProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.service';
import { ContentStudioExpertiseProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.service';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { ContentStudioBrandKitService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import {
  ContentStudioRenderFontService,
  RENDER_FONT_FILE_MAX_BYTES,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import {
  CreateContentStudioProjectDto,
  ListContentStudioProjectsDto,
  UpdateContentStudioProjectDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';
import {
  CreateContentPackageDto,
  CreateContentPackageRevisionDto,
  ListContentPackageRevisionsDto,
  ListContentPackagesDto,
  SaveContentPackageDraftDto,
  UpdateContentPackageDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.package.dto';
import {
  CreateContentStudioAIConnectionDto,
  ReplaceContentStudioAIConnectionCredentialDto,
  UpdateContentStudioAIConnectionDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-connection.dto';
import {
  CreateContentStudioWritingProfileDto,
  CreateContentStudioWritingProfileRevisionDto,
  ListContentStudioWritingProfileRevisionsDto,
  ListContentStudioWritingProfilesDto,
  UpdateContentStudioWritingProfileDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.writing-profile.dto';
import {
  CreateContentStudioEditorialPolicyRevisionDto,
  ListContentStudioEditorialPolicyRevisionsDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.editorial-policy.dto';
import {
  CreateContentStudioAudienceProfileDto,
  CreateContentStudioAudienceProfileRevisionDto,
  ListContentStudioAudienceProfileRevisionsDto,
  ListContentStudioAudienceProfilesDto,
  UpdateContentStudioAudienceProfileDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.audience-profile.dto';
import {
  CreateContentStudioExpertiseProfileDto,
  CreateContentStudioExpertiseProfileRevisionDto,
  ListContentStudioExpertiseProfileRevisionsDto,
  ListContentStudioExpertiseProfilesDto,
  UpdateContentStudioExpertiseProfileDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.expertise-profile.dto';
import {
  ContentStudioAIItemProposalDto,
  ContentStudioAIThreadProposalDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-writing.dto';
import {
  CreateContentStudioSourceDto,
  ListContentStudioSourcesDto,
  ListContentStudioSourceVersionsDto,
  UpdateContentStudioSourceDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.source.dto';
import {
  ListContentStudioBrandKitRevisionsDto,
  SaveContentStudioBrandKitRevisionDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.brand-kit.dto';
import {
  CreateContentStudioDesignDto,
  CreateContentStudioDesignRevisionDto,
  ListContentStudioDesignRevisionsDto,
  ListContentStudioDesignsDto,
  UpdateContentStudioDesignDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design.dto';
import {
  RenderAllContentStudioDesignDto,
  RenderContentStudioDesignDto,
  UploadContentStudioRenderFontDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-render.dto';

// The global pipe neither strips nor rejects unknown fields; here any field
// the DTO does not declare (organizationId, createdById, ...) is a 400
const contentStudioValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

// A render font upload: one `file` part held in memory (never written to a
// temporary or upload folder, never through the Media upload engine) and the
// three tuple fields. One byte over the renderer's limit still reaches the
// service, which refuses it with its own code; multer stops anything larger
const renderFontUploadOptions = {
  limits: {
    fileSize: RENDER_FONT_FILE_MAX_BYTES + 1,
    files: 1,
    fields: 3,
    parts: 4,
  },
};

@ApiTags('Content Studio')
@Controller('/content-studio')
@UsePipes(contentStudioValidationPipe)
export class ContentStudioController {
  constructor(
    private _contentStudioService: ContentStudioService,
    private _contentStudioHandoffService: ContentStudioHandoffService,
    private _contentStudioAIConnectionService: ContentStudioAIConnectionService,
    private _contentStudioWritingProfileService: ContentStudioWritingProfileService,
    private _contentStudioEditorialPolicyService: ContentStudioEditorialPolicyService,
    private _contentStudioAudienceProfileService: ContentStudioAudienceProfileService,
    private _contentStudioExpertiseProfileService: ContentStudioExpertiseProfileService,
    private _contentStudioAIWritingService: ContentStudioAIWritingService,
    private _contentStudioSourceService: ContentStudioSourceService,
    private _contentStudioSourceIngestionService: ContentStudioSourceIngestionService,
    private _contentStudioBrandKitService: ContentStudioBrandKitService,
    private _contentStudioDesignService: ContentStudioDesignService,
    private _contentStudioRenderFontService: ContentStudioRenderFontService,
    private _contentStudioDesignRenderService: ContentStudioDesignRenderService
  ) {}

  @Get('/projects')
  listProjects(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioProjectsDto
  ) {
    return this._contentStudioService.listProjects(org.id, query.archived);
  }

  @Post('/projects')
  createProject(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioProjectDto
  ) {
    return this._contentStudioService.createProject(org.id, user.id, body.name);
  }

  @Patch('/projects/:id')
  updateProject(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioProjectDto
  ) {
    return this._contentStudioService.updateProjectName(org.id, id, body.name);
  }

  @Post('/projects/:id/archive')
  @HttpCode(200)
  archiveProject(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioService.archiveProject(org.id, id);
  }

  @Post('/projects/:id/restore')
  @HttpCode(200)
  restoreProject(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioService.restoreProject(org.id, id);
  }

  @Get('/packages')
  listPackages(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentPackagesDto
  ) {
    return this._contentStudioService.listPackages({
      organizationId: org.id,
      archived: query.archived,
      projectId: query.projectId,
      page: query.page,
    });
  }

  @Post('/packages')
  createPackage(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentPackageDto
  ) {
    return this._contentStudioService.createPackage({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      projectId: body.projectId,
    });
  }

  @Get('/packages/:id')
  getPackage(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._contentStudioService.getPackage(org.id, id);
  }

  @Patch('/packages/:id')
  updatePackage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentPackageDto
  ) {
    return this._contentStudioService.updatePackageMetadata({
      organizationId: org.id,
      packageId: id,
      name: body.name,
      projectId: body.projectId,
    });
  }

  @Post('/packages/:id/archive')
  @HttpCode(200)
  archivePackage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioService.archivePackage(org.id, id);
  }

  @Post('/packages/:id/restore')
  @HttpCode(200)
  restorePackage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioService.restorePackage(org.id, id);
  }

  @Put('/packages/:id/draft')
  saveDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: SaveContentPackageDraftDto
  ) {
    return this._contentStudioService.saveDraft({
      organizationId: org.id,
      packageId: id,
      baseDraftVersion: body.baseDraftVersion,
      draft: body.draft,
    });
  }

  // 201 for a new revision, 200 when the draft was unchanged and the latest
  // revision is returned. Revisions have no update or delete routes
  @Post('/packages/:id/revisions')
  async createRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentPackageRevisionDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this._contentStudioService.createRevision({
      organizationId: org.id,
      packageId: id,
      userId: user.id,
      draftVersion: body.draftVersion,
      origin: body.origin,
    });
    response.status(result.created ? 201 : 200);
    return result;
  }

  // AI writing: a suggestion for one item or the whole thread, with the
  // connection, model, profiles and sources the user chose. Any member may
  // ask; the draft is never changed here: an accepted suggestion is saved
  // like any edit. 200, since nothing is created for the user to keep
  @Post('/packages/:id/ai/item')
  @HttpCode(200)
  generateItemProposal(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ContentStudioAIItemProposalDto
  ) {
    return this._contentStudioAIWritingService.proposeItem({
      organizationId: org.id,
      userId: user.id,
      packageId: id,
      operation: body.operation,
      itemId: body.itemId,
      selection: {
        connectionId: body.connectionId,
        model: body.model,
        baseDraftVersion: body.baseDraftVersion,
        writingProfileId: body.writingProfileId,
        editorialPolicy: body.editorialPolicy,
        audienceProfileId: body.audienceProfileId,
        expertiseProfileId: body.expertiseProfileId,
        sourceIds: body.sourceIds,
        instruction: body.instruction,
      },
    });
  }

  @Post('/packages/:id/ai/thread')
  @HttpCode(200)
  generateThreadProposal(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ContentStudioAIThreadProposalDto
  ) {
    return this._contentStudioAIWritingService.proposeThread({
      organizationId: org.id,
      userId: user.id,
      packageId: id,
      operation: body.operation,
      selection: {
        connectionId: body.connectionId,
        model: body.model,
        baseDraftVersion: body.baseDraftVersion,
        writingProfileId: body.writingProfileId,
        editorialPolicy: body.editorialPolicy,
        audienceProfileId: body.audienceProfileId,
        expertiseProfileId: body.expertiseProfileId,
        sourceIds: body.sourceIds,
        instruction: body.instruction,
      },
    });
  }

  @Get('/packages/:id/revisions')
  listRevisions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentPackageRevisionsDto
  ) {
    return this._contentStudioService.listRevisions({
      organizationId: org.id,
      packageId: id,
      page: query.page,
    });
  }

  @Get('/packages/:id/revisions/:revisionId')
  getRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioService.getRevision({
      organizationId: org.id,
      packageId: id,
      revisionId,
    });
  }

  // Hands a frozen revision to this user's composer for 24 hours. Handoffs
  // can't be listed, changed or deleted; the body is never read
  @Post('/packages/:id/revisions/:revisionId/handoffs')
  createHandoff(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioHandoffService.createHandoff({
      organizationId: org.id,
      userId: user.id,
      packageId: id,
      revisionId,
    });
  }

  @Get('/handoffs/:handoffId')
  resolveHandoff(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('handoffId') handoffId: string
  ) {
    return this._contentStudioHandoffService.resolveHandoff({
      organizationId: org.id,
      userId: user.id,
      handoffId,
    });
  }

  @Post('/handoffs/:handoffId/revoke')
  @HttpCode(200)
  revokeHandoff(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('handoffId') handoffId: string
  ) {
    return this._contentStudioHandoffService.revokeHandoff({
      organizationId: org.id,
      userId: user.id,
      handoffId,
    });
  }

  // AI connections: any member reads them, only ADMIN and SUPERADMIN change
  // them (checked by the service from the request's own membership). Keys
  // come in on create and replace only and never go back out

  @Get('/ai/providers')
  listAIProviders() {
    return this._contentStudioAIConnectionService.listProviders();
  }

  @Get('/ai/connections')
  listAIConnections(@GetOrgFromRequest() org: Organization) {
    return this._contentStudioAIConnectionService.listConnections(org.id);
  }

  @Get('/ai/connections/:id')
  getAIConnection(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioAIConnectionService.getConnection(org.id, id);
  }

  @Post('/ai/connections')
  createAIConnection(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioAIConnectionDto
  ) {
    return this._contentStudioAIConnectionService.createConnection(
      { organization: org, user },
      {
        name: body.name,
        provider: body.provider,
        credential: body.credential,
        defaultModel: body.defaultModel,
      }
    );
  }

  @Patch('/ai/connections/:id')
  updateAIConnection(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioAIConnectionDto
  ) {
    return this._contentStudioAIConnectionService.updateConnection(
      { organization: org, user },
      id,
      { name: body.name, defaultModel: body.defaultModel }
    );
  }

  @Put('/ai/connections/:id/credential')
  replaceAIConnectionCredential(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ReplaceContentStudioAIConnectionCredentialDto
  ) {
    return this._contentStudioAIConnectionService.replaceCredential(
      { organization: org, user },
      id,
      body.credential
    );
  }

  @Post('/ai/connections/:id/disable')
  @HttpCode(200)
  disableAIConnection(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioAIConnectionService.disableConnection(
      { organization: org, user },
      id
    );
  }

  @Post('/ai/connections/:id/enable')
  @HttpCode(200)
  enableAIConnection(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioAIConnectionService.enableConnection(
      { organization: org, user },
      id
    );
  }

  // Answers { ok, code? } with 200 whatever the provider said; see the service
  @Post('/ai/connections/:id/test')
  @HttpCode(200)
  testAIConnection(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioAIConnectionService.testConnection(
      { organization: org, user },
      id
    );
  }

  @Post('/ai/connections/:id/archive')
  @HttpCode(200)
  archiveAIConnection(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioAIConnectionService.archiveConnection(
      { organization: org, user },
      id
    );
  }

  // Sources: pages an organization tracks, with their captured versions as
  // provenance. Every member may manage them; the organization and the user
  // come from the request only. No route takes a version, a URL to fetch or
  // fetch options: refresh fetches the stored URL of the source, and versions
  // come from that server-side ingestion only
  @Get('/sources')
  listSources(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioSourcesDto
  ) {
    return this._contentStudioSourceService.listSources({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/sources')
  createSource(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioSourceDto
  ) {
    return this._contentStudioSourceService.createSource({
      organizationId: org.id,
      userId: user.id,
      kind: body.kind,
      name: body.name,
      url: body.url,
    });
  }

  @Get('/sources/:id')
  getSource(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._contentStudioSourceService.getSource(org.id, id);
  }

  @Patch('/sources/:id')
  updateSource(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioSourceDto
  ) {
    return this._contentStudioSourceService.renameSource(org.id, id, body.name);
  }

  @Get('/sources/:id/versions')
  listSourceVersions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioSourceVersionsDto
  ) {
    return this._contentStudioSourceService.listVersions({
      organizationId: org.id,
      sourceId: id,
      page: query.page,
    });
  }

  @Get('/sources/:id/versions/:versionId')
  getSourceVersion(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('versionId') versionId: string
  ) {
    return this._contentStudioSourceService.getVersion({
      organizationId: org.id,
      sourceId: id,
      versionId,
    });
  }

  @Post('/sources/:id/archive')
  @HttpCode(200)
  archiveSource(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioSourceService.archiveSource(org.id, id);
  }

  @Post('/sources/:id/restore')
  @HttpCode(200)
  restoreSource(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioSourceService.restoreSource(org.id, id);
  }

  // Fetches the source's own stored URL and stores the capture as its next
  // version. No body: nothing about the fetch comes from the request
  @Post('/sources/:id/refresh')
  @HttpCode(200)
  refreshSource(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioSourceIngestionService.refreshSource({
      organizationId: org.id,
      userId: user.id,
      sourceId: id,
    });
  }

  // Writing Profiles: every member of the organization may read and change
  // them; the organization and the user come from the request only
  @Get('/writing-profiles')
  listWritingProfiles(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioWritingProfilesDto
  ) {
    return this._contentStudioWritingProfileService.listProfiles({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/writing-profiles')
  createWritingProfile(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioWritingProfileDto
  ) {
    return this._contentStudioWritingProfileService.createProfile({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      content: body.content,
    });
  }

  @Get('/writing-profiles/:id')
  getWritingProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioWritingProfileService.getProfile(org.id, id);
  }

  @Patch('/writing-profiles/:id')
  updateWritingProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioWritingProfileDto
  ) {
    return this._contentStudioWritingProfileService.renameProfile(
      org.id,
      id,
      body.name
    );
  }

  @Post('/writing-profiles/:id/revisions')
  createWritingProfileRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentStudioWritingProfileRevisionDto
  ) {
    return this._contentStudioWritingProfileService.createRevision({
      organizationId: org.id,
      profileId: id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
    });
  }

  @Get('/writing-profiles/:id/revisions')
  listWritingProfileRevisions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioWritingProfileRevisionsDto
  ) {
    return this._contentStudioWritingProfileService.listRevisions({
      organizationId: org.id,
      profileId: id,
      page: query.page,
    });
  }

  @Get('/writing-profiles/:id/revisions/:revisionId')
  getWritingProfileRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioWritingProfileService.getRevision({
      organizationId: org.id,
      profileId: id,
      revisionId,
    });
  }

  @Post('/writing-profiles/:id/archive')
  @HttpCode(200)
  archiveWritingProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioWritingProfileService.archiveProfile(org.id, id);
  }

  @Post('/writing-profiles/:id/restore')
  @HttpCode(200)
  restoreWritingProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioWritingProfileService.restoreProfile(org.id, id);
  }

  // The editorial policy: one per organization, addressed by the request
  // organization and never by an id. Every member may read and revise it
  @Get('/editorial-policy')
  getEditorialPolicy(@GetOrgFromRequest() org: Organization) {
    return this._contentStudioEditorialPolicyService.getPolicy(org.id);
  }

  @Post('/editorial-policy/revisions')
  createEditorialPolicyRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioEditorialPolicyRevisionDto
  ) {
    return this._contentStudioEditorialPolicyService.createRevision({
      organizationId: org.id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
    });
  }

  @Get('/editorial-policy/revisions')
  listEditorialPolicyRevisions(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioEditorialPolicyRevisionsDto
  ) {
    return this._contentStudioEditorialPolicyService.listRevisions({
      organizationId: org.id,
      page: query.page,
    });
  }

  @Get('/editorial-policy/revisions/:revisionId')
  getEditorialPolicyRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioEditorialPolicyService.getRevision({
      organizationId: org.id,
      revisionId,
    });
  }

  // The Brand Kit: one per organization, addressed by the request
  // organization and never by an id. Every member may read and revise it.
  // Structured identity, color and type tokens only: no asset, font file,
  // Media or URL route
  @Get('/brand-kit')
  getBrandKit(@GetOrgFromRequest() org: Organization) {
    return this._contentStudioBrandKitService.getBrandKit(org.id);
  }

  @Post('/brand-kit/revisions')
  createBrandKitRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveContentStudioBrandKitRevisionDto
  ) {
    return this._contentStudioBrandKitService.createRevision({
      organizationId: org.id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
    });
  }

  @Get('/brand-kit/revisions')
  listBrandKitRevisions(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioBrandKitRevisionsDto
  ) {
    return this._contentStudioBrandKitService.listRevisions({
      organizationId: org.id,
      page: query.page,
    });
  }

  @Get('/brand-kit/revisions/:revisionId')
  getBrandKitRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioBrandKitService.getRevision({
      organizationId: org.id,
      revisionId,
    });
  }

  // Designs: named design projects whose documents are immutable revisions.
  // Every member may read, create, rename, revise, archive and restore them.
  // The organization and the user come from the request only. One route
  // renders one page of one exact revision and one renders all its pages;
  // none previews, exports, generates or deletes
  @Get('/designs')
  listDesigns(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDesignsDto
  ) {
    return this._contentStudioDesignService.listDesigns({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/designs')
  createDesign(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignDto
  ) {
    return this._contentStudioDesignService.createDesign({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      content: body.content,
    });
  }

  @Get('/designs/:id')
  getDesign(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._contentStudioDesignService.getDesign(org.id, id);
  }

  @Patch('/designs/:id')
  updateDesign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioDesignDto
  ) {
    return this._contentStudioDesignService.renameDesign(org.id, id, body.name);
  }

  @Post('/designs/:id/revisions')
  createDesignRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentStudioDesignRevisionDto
  ) {
    return this._contentStudioDesignService.createRevision({
      organizationId: org.id,
      designId: id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
    });
  }

  @Get('/designs/:id/revisions')
  listDesignRevisions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioDesignRevisionsDto
  ) {
    return this._contentStudioDesignService.listRevisions({
      organizationId: org.id,
      designId: id,
      page: query.page,
    });
  }

  @Get('/designs/:id/revisions/:revisionId')
  getDesignRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioDesignService.getRevision({
      organizationId: org.id,
      designId: id,
      revisionId,
    });
  }

  @Post('/designs/:id/archive')
  @HttpCode(200)
  archiveDesign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignService.archiveDesign(org.id, id);
  }

  @Post('/designs/:id/restore')
  @HttpCode(200)
  restoreDesign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignService.restoreDesign(org.id, id);
  }

  // Renders one page of exactly the revision asked for (never the latest) to
  // a PNG Media of the organization. Any member may render
  @Post('/designs/:id/render')
  @HttpCode(200)
  renderDesign(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: RenderContentStudioDesignDto
  ) {
    return this._contentStudioDesignRenderService.renderPage({
      organizationId: org.id,
      userId: user.id,
      designId: id,
      revisionId: body.revisionId,
      pageId: body.pageId,
    });
  }

  // Renders every page of exactly the revision asked for, in the design's
  // order, to one PNG Media each. Any member may render; the server, not the
  // request, decides the pages and their order
  @Post('/designs/:id/render-all')
  @HttpCode(200)
  renderAllDesignPages(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: RenderAllContentStudioDesignDto
  ) {
    return this._contentStudioDesignRenderService.renderAllPages({
      organizationId: org.id,
      userId: user.id,
      designId: id,
      revisionId: body.revisionId,
    });
  }

  // Render fonts: the exact font file each family, weight and style of a
  // design is drawn with. Any member lists them (no file, hash or storage
  // detail); only ADMIN and SUPERADMIN upload, disable and enable (checked by
  // the service from the request's own membership). Files go to private
  // storage, never to Media; no route downloads or deletes one
  @Get('/render-fonts')
  listRenderFonts(@GetOrgFromRequest() org: Organization) {
    return this._contentStudioRenderFontService.listFonts(org.id);
  }

  @Post('/render-fonts/upload')
  @UseInterceptors(FileInterceptor('file', renderFontUploadOptions))
  uploadRenderFont(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadContentStudioRenderFontDto
  ) {
    return this._contentStudioRenderFontService.uploadFont(
      { organization: org, user },
      {
        family: body.family,
        weight: body.weight,
        style: body.style,
        file,
      }
    );
  }

  @Post('/render-fonts/:id/disable')
  @HttpCode(200)
  disableRenderFont(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioRenderFontService.disableFont(
      { organization: org, user },
      id
    );
  }

  @Post('/render-fonts/:id/enable')
  @HttpCode(200)
  enableRenderFont(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioRenderFontService.enableFont(
      { organization: org, user },
      id
    );
  }

  // Audience Profiles: editorial context about who content is for, never ad
  // targeting. Every member of the organization may read and change them; the
  // organization and the user come from the request only
  @Get('/audience-profiles')
  listAudienceProfiles(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioAudienceProfilesDto
  ) {
    return this._contentStudioAudienceProfileService.listProfiles({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/audience-profiles')
  createAudienceProfile(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioAudienceProfileDto
  ) {
    return this._contentStudioAudienceProfileService.createProfile({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      content: body.content,
    });
  }

  @Get('/audience-profiles/:id')
  getAudienceProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioAudienceProfileService.getProfile(org.id, id);
  }

  @Patch('/audience-profiles/:id')
  updateAudienceProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioAudienceProfileDto
  ) {
    return this._contentStudioAudienceProfileService.renameProfile(
      org.id,
      id,
      body.name
    );
  }

  @Post('/audience-profiles/:id/revisions')
  createAudienceProfileRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentStudioAudienceProfileRevisionDto
  ) {
    return this._contentStudioAudienceProfileService.createRevision({
      organizationId: org.id,
      profileId: id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
    });
  }

  @Get('/audience-profiles/:id/revisions')
  listAudienceProfileRevisions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioAudienceProfileRevisionsDto
  ) {
    return this._contentStudioAudienceProfileService.listRevisions({
      organizationId: org.id,
      profileId: id,
      page: query.page,
    });
  }

  @Get('/audience-profiles/:id/revisions/:revisionId')
  getAudienceProfileRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioAudienceProfileService.getRevision({
      organizationId: org.id,
      profileId: id,
      revisionId,
    });
  }

  @Post('/audience-profiles/:id/archive')
  @HttpCode(200)
  archiveAudienceProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioAudienceProfileService.archiveProfile(org.id, id);
  }

  @Post('/audience-profiles/:id/restore')
  @HttpCode(200)
  restoreAudienceProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioAudienceProfileService.restoreProfile(org.id, id);
  }

  // Expertise Profiles: organization-provided context, never verified fact.
  // Every member of the organization may read and change them; the
  // organization and the user come from the request only
  @Get('/expertise-profiles')
  listExpertiseProfiles(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioExpertiseProfilesDto
  ) {
    return this._contentStudioExpertiseProfileService.listProfiles({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/expertise-profiles')
  createExpertiseProfile(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioExpertiseProfileDto
  ) {
    return this._contentStudioExpertiseProfileService.createProfile({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      content: body.content,
    });
  }

  @Get('/expertise-profiles/:id')
  getExpertiseProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioExpertiseProfileService.getProfile(org.id, id);
  }

  @Patch('/expertise-profiles/:id')
  updateExpertiseProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioExpertiseProfileDto
  ) {
    return this._contentStudioExpertiseProfileService.renameProfile(
      org.id,
      id,
      body.name
    );
  }

  @Post('/expertise-profiles/:id/revisions')
  createExpertiseProfileRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentStudioExpertiseProfileRevisionDto
  ) {
    return this._contentStudioExpertiseProfileService.createRevision({
      organizationId: org.id,
      profileId: id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
    });
  }

  @Get('/expertise-profiles/:id/revisions')
  listExpertiseProfileRevisions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioExpertiseProfileRevisionsDto
  ) {
    return this._contentStudioExpertiseProfileService.listRevisions({
      organizationId: org.id,
      profileId: id,
      page: query.page,
    });
  }

  @Get('/expertise-profiles/:id/revisions/:revisionId')
  getExpertiseProfileRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioExpertiseProfileService.getRevision({
      organizationId: org.id,
      profileId: id,
      revisionId,
    });
  }

  @Post('/expertise-profiles/:id/archive')
  @HttpCode(200)
  archiveExpertiseProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioExpertiseProfileService.archiveProfile(
      org.id,
      id
    );
  }

  @Post('/expertise-profiles/:id/restore')
  @HttpCode(200)
  restoreExpertiseProfile(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioExpertiseProfileService.restoreProfile(
      org.id,
      id
    );
  }
}
