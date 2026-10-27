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
import { ContentStudioAISetupService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-setup.service';
import { ContentStudioAISetupProposalDto } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-setup.dto';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { ContentStudioBrandKitService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import {
  ContentStudioRenderFontService,
  RENDER_FONT_FILE_MAX_BYTES,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { ContentStudioDesignStylePresetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-style-preset.service';
import { ContentStudioDesignLayoutPatternService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-layout-pattern.service';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioDesignBlockService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-block.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioDesignAIService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-ai.service';
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
  ListContentStudioSourceDiscoveriesDto,
  ListContentStudioFeedCapturesDto,
  ListContentStudioDiscoveriesDto,
  ListContentStudioSourceChangesDto,
  SetContentStudioFeedIntervalDto,
  UpdateContentStudioSourceDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.source.dto';
import {
  ListContentStudioBrandKitRevisionsDto,
  SaveContentStudioBrandKitRevisionDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.brand-kit.dto';
import {
  CreateContentStudioDesignDto,
  CreateContentStudioDesignFromPackageDto,
  CreateContentStudioDesignRevisionDto,
  ListContentStudioDesignRevisionsDto,
  ListContentStudioDesignsDto,
  UpdateContentStudioDesignDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design.dto';
import { ContentStudioDesignAIProposalDto } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-ai.dto';
import {
  CreateContentStudioDesignTemplateDto,
  CreateContentStudioDesignTemplateRevisionDto,
  InstantiateContentStudioDesignTemplateDto,
  ListContentStudioDesignTemplateRevisionsDto,
  ListContentStudioDesignTemplatesDto,
  SaveContentStudioDesignAsTemplateDto,
  UpdateContentStudioDesignTemplateDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-template.dto';
import {
  CreateContentStudioDesignStylePresetDto,
  ListContentStudioDesignStylePresetsDto,
  UpdateContentStudioDesignStylePresetDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-style-preset.dto';
import {
  CreateContentStudioDesignLayoutPatternDto,
  ListContentStudioDesignLayoutPatternsDto,
  UpdateContentStudioDesignLayoutPatternDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-layout-pattern.dto';
import {
  CreateContentStudioDesignPageSetDto,
  ListContentStudioDesignPageSetsDto,
  UpdateContentStudioDesignPageSetDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-page-set.dto';
import {
  CreateContentStudioDesignBlockDto,
  ListContentStudioDesignBlocksDto,
  UpdateContentStudioDesignBlockDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-block.dto';
import {
  ApproveContentStudioReviewDto,
  CreateContentStudioReviewCommentDto,
  CreateContentStudioReviewDto,
  ListContentStudioReviewCommentsDto,
  ListContentStudioReviewsDto,
  RefuseContentStudioReviewDto,
  RequestContentStudioReviewChangesDto,
  ResolveContentStudioReviewRevisionRequestDto,
  UpdateContentStudioReviewClaimDto,
  UpdateContentStudioReviewCommentDto,
  WithdrawContentStudioReviewApprovalDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.review.dto';
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
    private _contentStudioDesignRenderService: ContentStudioDesignRenderService,
    private _contentStudioDesignReferenceService: ContentStudioDesignReferenceService,
    private _contentStudioDesignTemplateService: ContentStudioDesignTemplateService,
    private _contentStudioDesignStylePresetService: ContentStudioDesignStylePresetService,
    private _contentStudioDesignLayoutPatternService: ContentStudioDesignLayoutPatternService,
    private _contentStudioDesignPageSetService: ContentStudioDesignPageSetService,
    private _contentStudioDesignBlockService: ContentStudioDesignBlockService,
    private _contentStudioReviewService: ContentStudioReviewService,
    private _contentStudioDesignAIService: ContentStudioDesignAIService,
    private _contentStudioAISetupService: ContentStudioAISetupService
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

  // A new design from exactly this saved revision (P6-01): the package
  // service reads the revision and the thread item the body names; the body
  // holds only identities, a name and the starting point. Not a handoff:
  // nothing of the package changes and no approval is asked for
  @Post('/packages/:id/revisions/:revisionId/designs')
  createDesignFromPackageRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() body: CreateContentStudioDesignFromPackageDto
  ) {
    return this._contentStudioService.createDesignFromRevision({
      organizationId: org.id,
      userId: user.id,
      packageId: id,
      revisionId,
      name: body.name,
      itemId: body.itemId,
      canvas: body.canvas,
      pageSetId: body.pageSetId,
      templateSource: body.templateSource,
      templateId: body.templateId,
      templateRevisionId: body.templateRevisionId,
      templateRevisionNumber: body.templateRevisionNumber,
      values: body.values,
      textSlotId: body.textSlotId,
      mediaId: body.mediaId,
      imageSlotId: body.imageSlotId,
    });
  }

  // Hands a frozen revision to this user's composer for 24 hours. Handoffs
  // can't be listed, changed or deleted; the body is never read. Whether the
  // revision must be approved first is the organization's current editorial
  // policy, read by the server (P5-07): nothing the client sends decides it
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

  // The guided setup's AI draft: one suggestion for the organization's brand
  // description, writing profile, audiences, expertise and editorial policy,
  // from what the user typed. Any member may ask; nothing is saved here: the
  // reviewed draft is saved through the routes of each profile. 200, since
  // nothing is created for the user to keep
  @Post('/ai/setup/proposal')
  @HttpCode(200)
  proposeAISetup(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: ContentStudioAISetupProposalDto
  ) {
    return this._contentStudioAISetupService.proposeSetup({
      organizationId: org.id,
      userId: user.id,
      request: {
        connectionId: body.connectionId,
        companyName: body.companyName,
        website: body.website,
        description: body.description,
        goal: body.goal,
        audience: body.audience,
        language: body.language,
      },
    });
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
  // provenance, and feeds that find pages (P8-01). Every member may manage
  // them; the organization and the user come from the request only. No route
  // takes a version, a URL to fetch or fetch options: refresh fetches the
  // stored URL of the source, and versions and discoveries come from that
  // server-side ingestion only
  @Get('/sources')
  listSources(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioSourcesDto
  ) {
    return this._contentStudioSourceService.listSources({
      organizationId: org.id,
      archived: query.archived,
      kind: query.kind,
      search: query.search,
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

  // What changed in one version since an earlier different capture (P8-04A):
  // the server chooses what it is compared with. Read only
  @Get('/sources/:id/versions/:versionId/changes')
  getSourceVersionChanges(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('versionId') versionId: string
  ) {
    return this._contentStudioSourceService.getVersionChanges({
      organizationId: org.id,
      sourceId: id,
      versionId,
    });
  }

  // The pages a feed source found, with when it listed them: metadata of
  // their own sources only, never their text
  @Get('/sources/:id/discoveries')
  listSourceDiscoveries(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioSourceDiscoveriesDto
  ) {
    return this._contentStudioSourceService.listDiscoveries({
      organizationId: org.id,
      sourceId: id,
      page: query.page,
    });
  }

  // A feed's capture history (P8-O1), newest first: what each scheduled
  // capture or refresh did, never what it read. Read only; captures write it
  @Get('/sources/:id/captures')
  listSourceCaptures(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioFeedCapturesDto
  ) {
    return this._contentStudioSourceService.listFeedCaptures({
      organizationId: org.id,
      sourceId: id,
      page: query.page,
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

  // A feed's scheduled captures (P8-C3): paused or resumed, nothing else. No
  // body; neither captures anything, and a paused feed can still be refreshed
  @Post('/sources/:id/pause')
  @HttpCode(200)
  pauseSource(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._contentStudioSourceService.pauseFeed(org.id, id);
  }

  @Post('/sources/:id/resume')
  @HttpCode(200)
  resumeSource(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioSourceService.resumeFeed(org.id, id);
  }

  // Fetches the source's own stored URL: a page's capture becomes its next
  // version, a feed's capture records and captures the pages it lists. No
  // body: nothing about the fetch comes from the request
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

  // How often a feed is captured automatically (P8-C4): a preset or the
  // default, nothing else. Nothing is captured here
  @Post('/sources/:id/interval')
  @HttpCode(200)
  setSourceInterval(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: SetContentStudioFeedIntervalDto
  ) {
    return this._contentStudioSourceService.setFeedInterval(
      org.id,
      id,
      body.intervalMinutes
    );
  }

  // News Radar (P8-02): what the organization's live feeds found, across
  // feeds, newest first. Read only: nothing is fetched, captured or marked
  @Get('/discoveries')
  listDiscoveries(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDiscoveriesDto
  ) {
    return this._contentStudioSourceService.listOrganizationDiscoveries({
      organizationId: org.id,
      page: query.page,
      since: query.since,
      feedSourceId: query.feedSourceId,
      captureState: query.captureState,
    });
  }

  // Organization Changes (P8-04B1): the organization's page sources by their
  // last page change, newest first. Read only: nothing is fetched or captured
  @Get('/source-changes')
  listSourceChanges(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioSourceChangesDto
  ) {
    return this._contentStudioSourceService.listPageChanges({
      organizationId: org.id,
      page: query.page,
      since: query.since,
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

  // The exact reference a design stores for one verified revision of the
  // organization's kit: its kit and revision ids, number and content hash
  // only. Read-only, for building a Design Document reference
  @Get('/brand-kit/revisions/:revisionId/design-ref')
  getBrandKitDesignReference(
    @GetOrgFromRequest() org: Organization,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioDesignReferenceService.getBrandKitReference(
      org.id,
      revisionId
    );
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

  // A new design from its first document, or from a page set (P4-17), whose
  // pages the page set service makes and hands to the design service
  @Post('/designs')
  createDesign(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignDto
  ) {
    if (body.pageSetId !== undefined) {
      return this._contentStudioDesignPageSetService.createDesignFromPageSet({
        organizationId: org.id,
        userId: user.id,
        name: body.name,
        pageSetId: body.pageSetId,
        content: body.content,
      });
    }
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

  // Saves exactly one stored revision of a design as a new template of the
  // organization. The server reads that revision: the body holds only the
  // template's name and description, never a document
  @Post('/designs/:id/revisions/:revisionId/save-as-template')
  saveDesignRevisionAsTemplate(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() body: SaveContentStudioDesignAsTemplateDto
  ) {
    return this._contentStudioDesignTemplateService.saveDesignRevisionAsTemplate(
      {
        organizationId: org.id,
        userId: user.id,
        designId: id,
        revisionId,
        name: body.name,
        description: body.description,
      }
    );
  }

  // Design Creative AI (P6-02): one suggestion for exactly this saved
  // revision, which must be the design's current one. The body holds the
  // intent, the AI connection, an optional instruction and, for copy, the
  // profiles; the model comes from the connection. Any member may ask;
  // nothing of the design is changed here: an accepted suggestion is saved
  // from the editor like any edit. 200, since nothing is created to keep
  @Post('/designs/:id/revisions/:revisionId/ai/propose')
  @HttpCode(200)
  proposeDesignAI(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() body: ContentStudioDesignAIProposalDto
  ) {
    return this._contentStudioDesignAIService.proposeDesign({
      organizationId: org.id,
      userId: user.id,
      designId: id,
      revisionId,
      intent: body.intent,
      selection: {
        connectionId: body.connectionId,
        writingProfileId: body.writingProfileId,
        editorialPolicy: body.editorialPolicy,
        audienceProfileId: body.audienceProfileId,
        expertiseProfileId: body.expertiseProfileId,
        instruction: body.instruction,
      },
    });
  }

  // Design templates: the built-in ones (code, read-only) and the
  // organization's own, whose documents are immutable revisions. Every member
  // may read, create, rename, revise, archive, restore and use them. The
  // organization and the user come from the request only. Using a template
  // creates an ordinary design from one exact template revision; none
  // renders, shares, generates or deletes
  @Get('/design-templates')
  listDesignTemplates(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDesignTemplatesDto
  ) {
    return this._contentStudioDesignTemplateService.listTemplates({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/design-templates')
  createDesignTemplate(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignTemplateDto
  ) {
    return this._contentStudioDesignTemplateService.createTemplate({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Post('/design-templates/instantiate')
  instantiateDesignTemplate(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: InstantiateContentStudioDesignTemplateDto
  ) {
    return this._contentStudioDesignTemplateService.instantiateTemplate({
      organizationId: org.id,
      userId: user.id,
      source: body.source,
      templateId: body.templateId,
      revisionId: body.revisionId,
      revisionNumber: body.revisionNumber,
      name: body.name,
      values: body.values,
      brandKitRevisionId: body.brandKitRevisionId,
    });
  }

  @Get('/design-templates/:id')
  getDesignTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignTemplateService.getTemplate(org.id, id);
  }

  @Patch('/design-templates/:id')
  updateDesignTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioDesignTemplateDto
  ) {
    return this._contentStudioDesignTemplateService.updateTemplate(org.id, id, {
      name: body.name,
      description: body.description,
    });
  }

  @Post('/design-templates/:id/revisions')
  createDesignTemplateRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentStudioDesignTemplateRevisionDto
  ) {
    return this._contentStudioDesignTemplateService.createRevision({
      organizationId: org.id,
      templateId: id,
      userId: user.id,
      baseRevisionNumber: body.baseRevisionNumber,
      content: body.content,
      guidance: body.guidance,
    });
  }

  @Get('/design-templates/:id/revisions')
  listDesignTemplateRevisions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioDesignTemplateRevisionsDto
  ) {
    return this._contentStudioDesignTemplateService.listRevisions({
      organizationId: org.id,
      templateId: id,
      page: query.page,
    });
  }

  @Get('/design-templates/:id/revisions/:revisionId')
  getDesignTemplateRevision(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string
  ) {
    return this._contentStudioDesignTemplateService.getRevision({
      organizationId: org.id,
      templateId: id,
      revisionId,
    });
  }

  @Post('/design-templates/:id/archive')
  @HttpCode(200)
  archiveDesignTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignTemplateService.archiveTemplate(org.id, id);
  }

  @Post('/design-templates/:id/restore')
  @HttpCode(200)
  restoreDesignTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignTemplateService.restoreTemplate(org.id, id);
  }

  // Design style presets: the built-in ones (code, read-only) and the
  // organization's own, reusable text and shape styles the editor copies
  // into a layer. Every member may read, create, change, archive and restore
  // them. The organization and the user come from the request only; none
  // touches a design, and none deletes
  @Get('/design-style-presets')
  listDesignStylePresets(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDesignStylePresetsDto
  ) {
    return this._contentStudioDesignStylePresetService.listPresets({
      organizationId: org.id,
      kind: query.kind,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/design-style-presets')
  createDesignStylePreset(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignStylePresetDto
  ) {
    return this._contentStudioDesignStylePresetService.createPreset({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Patch('/design-style-presets/:id')
  updateDesignStylePreset(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioDesignStylePresetDto
  ) {
    return this._contentStudioDesignStylePresetService.updatePreset(
      org.id,
      id,
      {
        name: body.name,
        description: body.description,
        content: body.content,
      }
    );
  }

  @Post('/design-style-presets/:id/archive')
  @HttpCode(200)
  archiveDesignStylePreset(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignStylePresetService.archivePreset(
      org.id,
      id
    );
  }

  @Post('/design-style-presets/:id/restore')
  @HttpCode(200)
  restoreDesignStylePreset(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignStylePresetService.restorePreset(
      org.id,
      id
    );
  }

  // Design layout patterns: the built-in ones (code, read-only) and the
  // organization's own, reusable arrangements of layers the editor copies
  // into a page under new ids. Every member may read, create, change,
  // archive and restore them. The organization and the user come from the
  // request only; none touches a design, none is applied here, and none
  // deletes
  @Get('/design-layout-patterns')
  listDesignLayoutPatterns(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDesignLayoutPatternsDto
  ) {
    return this._contentStudioDesignLayoutPatternService.listPatterns({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/design-layout-patterns')
  createDesignLayoutPattern(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignLayoutPatternDto
  ) {
    return this._contentStudioDesignLayoutPatternService.createPattern({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Patch('/design-layout-patterns/:id')
  updateDesignLayoutPattern(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioDesignLayoutPatternDto
  ) {
    return this._contentStudioDesignLayoutPatternService.updatePattern(
      org.id,
      id,
      {
        name: body.name,
        description: body.description,
        content: body.content,
      }
    );
  }

  @Post('/design-layout-patterns/:id/archive')
  @HttpCode(200)
  archiveDesignLayoutPattern(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignLayoutPatternService.archivePattern(
      org.id,
      id
    );
  }

  @Post('/design-layout-patterns/:id/restore')
  @HttpCode(200)
  restoreDesignLayoutPattern(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignLayoutPatternService.restorePattern(
      org.id,
      id
    );
  }

  // Design page sets: the built-in ones (code, read-only) and the
  // organization's own, reusable page structures (names, sizes, literal
  // backgrounds) a new design starts from or the editor adds to a draft as
  // blank pages. Every member may read, create, change, archive and restore
  // them. The organization and the user come from the request only; none
  // touches an existing design, and none deletes
  @Get('/design-page-sets')
  listDesignPageSets(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDesignPageSetsDto
  ) {
    return this._contentStudioDesignPageSetService.listPageSets({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/design-page-sets')
  createDesignPageSet(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignPageSetDto
  ) {
    return this._contentStudioDesignPageSetService.createPageSet({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Patch('/design-page-sets/:id')
  updateDesignPageSet(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioDesignPageSetDto
  ) {
    return this._contentStudioDesignPageSetService.updatePageSet(org.id, id, {
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Post('/design-page-sets/:id/archive')
  @HttpCode(200)
  archiveDesignPageSet(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignPageSetService.archivePageSet(org.id, id);
  }

  @Post('/design-page-sets/:id/restore')
  @HttpCode(200)
  restoreDesignPageSet(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignPageSetService.restorePageSet(org.id, id);
  }

  // Design blocks: the organization's own reusable creative assets, styled
  // layers the editor copies into a page under new ids (there are no
  // built-in blocks). Every member may read, create, change, archive and
  // restore them. The organization and the user come from the request only;
  // none touches a design, none is applied here, and none deletes
  @Get('/design-blocks')
  listDesignBlocks(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioDesignBlocksDto
  ) {
    return this._contentStudioDesignBlockService.listBlocks({
      organizationId: org.id,
      archived: query.archived,
      page: query.page,
    });
  }

  @Post('/design-blocks')
  createDesignBlock(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioDesignBlockDto
  ) {
    return this._contentStudioDesignBlockService.createBlock({
      organizationId: org.id,
      userId: user.id,
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Patch('/design-blocks/:id')
  updateDesignBlock(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateContentStudioDesignBlockDto
  ) {
    return this._contentStudioDesignBlockService.updateBlock(org.id, id, {
      name: body.name,
      description: body.description,
      content: body.content,
    });
  }

  @Post('/design-blocks/:id/archive')
  @HttpCode(200)
  archiveDesignBlock(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignBlockService.archiveBlock(org.id, id);
  }

  @Post('/design-blocks/:id/restore')
  @HttpCode(200)
  restoreDesignBlock(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignBlockService.restoreBlock(org.id, id);
  }

  // Reviews (P5-01) of exactly one immutable revision: a Content Package
  // revision or a Design revision. Every member may request one and move it
  // on. The organization, the user, the hash and every state come from the
  // request and the server only; a state change reads no body (no state),
  // except request changes, whose body is its revision request (P5-02). A
  // review is not an approval and gates nothing; none is deleted. The list is
  // also the Review & Approval queue (P5-06): read only, filtered by the
  // binding state the server derives
  @Get('/reviews')
  listReviews(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListContentStudioReviewsDto
  ) {
    return this._contentStudioReviewService.listReviews({
      organizationId: org.id,
      targetType: query.targetType,
      targetRevisionId: query.targetRevisionId,
      state: query.state,
      queue: query.queue,
      search: query.search,
      page: query.page,
    });
  }

  @Post('/reviews')
  requestReview(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateContentStudioReviewDto
  ) {
    return this._contentStudioReviewService.requestReview({
      organizationId: org.id,
      userId: user.id,
      targetType: body.targetType,
      targetRevisionId: body.targetRevisionId,
    });
  }

  @Post('/reviews/:id/start')
  @HttpCode(200)
  startReview(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioReviewService.transitionReview({
      organizationId: org.id,
      userId: user.id,
      id,
      action: 'start',
    });
  }

  // The state together with the formal revision request that says what
  // must change: its plain text only (P5-02)
  @Post('/reviews/:id/request-changes')
  @HttpCode(200)
  requestReviewChanges(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: RequestContentStudioReviewChangesDto
  ) {
    return this._contentStudioReviewService.requestChanges({
      organizationId: org.id,
      userId: user.id,
      id,
      body: body.body,
    });
  }

  // Ready for the approval stage, not approved
  @Post('/reviews/:id/ready-for-approval')
  @HttpCode(200)
  markReviewReadyForApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioReviewService.transitionReview({
      organizationId: org.id,
      userId: user.id,
      id,
      action: 'ready-for-approval',
    });
  }

  @Post('/reviews/:id/cancel')
  @HttpCode(200)
  cancelReview(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this._contentStudioReviewService.transitionReview({
      organizationId: org.id,
      userId: user.id,
      id,
      action: 'cancel',
    });
  }

  // The discussion of a review (P5-02): flat plain-text comments by any
  // member, edited by their author only, never deleted; and the one revision
  // request, resolved by naming a newer saved revision of the same package
  // or design. The review comes from the path; the organization, the author
  // and the resolver from the request; the resolving revision's type and
  // hash from the server. Nothing here changes a review's state
  @Get('/reviews/:id/comments')
  listReviewComments(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query() query: ListContentStudioReviewCommentsDto
  ) {
    return this._contentStudioReviewService.listComments({
      organizationId: org.id,
      reviewId: id,
      page: query.page,
    });
  }

  @Post('/reviews/:id/comments')
  addReviewComment(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: CreateContentStudioReviewCommentDto
  ) {
    return this._contentStudioReviewService.addComment({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      body: body.body,
    });
  }

  @Patch('/reviews/:id/comments/:commentId')
  editReviewComment(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: UpdateContentStudioReviewCommentDto
  ) {
    return this._contentStudioReviewService.editComment({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      commentId,
      body: body.body,
    });
  }

  @Get('/reviews/:id/revision-request')
  getReviewRevisionRequest(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioReviewService.getRevisionRequest({
      organizationId: org.id,
      reviewId: id,
    });
  }

  @Post('/reviews/:id/revision-request/resolve')
  @HttpCode(200)
  resolveReviewRevisionRequest(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ResolveContentStudioReviewRevisionRequestDto
  ) {
    return this._contentStudioReviewService.resolveRevisionRequest({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      resolutionRevisionId: body.resolutionRevisionId,
    });
  }

  // Claim review (P5-03B): every grounded claim of the exact package
  // revision the review is about, with its assessment and exact evidence
  @Get('/reviews/:id/claims')
  listReviewClaims(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioReviewService.listClaims({
      organizationId: org.id,
      reviewId: id,
    });
  }

  // The whole current assessment of one claim, by the request user, while
  // the review is in review
  @Put('/reviews/:id/claims/:claimId')
  assessReviewClaim(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('claimId') claimId: string,
    @Body() body: UpdateContentStudioReviewClaimDto
  ) {
    return this._contentStudioReviewService.assessClaim({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      claimId,
      status: body.status,
      finding: body.finding,
    });
  }

  // Approval (P5-04) of a review that is ready for approval: its current
  // state and decision history, and one route per decision. Every member
  // may decide. The decision comes from the route, its note from the body;
  // the actor, sequence, revision and hash from the request and the server.
  // A decision is never edited or deleted: it is withdrawn. Nothing here
  // changes the review or gates a handoff
  @Get('/reviews/:id/approval')
  getReviewApproval(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioReviewService.getApproval({
      organizationId: org.id,
      reviewId: id,
    });
  }

  @Post('/reviews/:id/approval/approve')
  @HttpCode(200)
  approveReview(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ApproveContentStudioReviewDto
  ) {
    return this._contentStudioReviewService.decideApproval({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      action: 'approve',
      note: body.note,
    });
  }

  @Post('/reviews/:id/approval/refuse')
  @HttpCode(200)
  refuseReviewApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: RefuseContentStudioReviewDto
  ) {
    return this._contentStudioReviewService.decideApproval({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      action: 'refuse',
      note: body.note,
    });
  }

  // Takes back the decision in force; it stays in the history
  @Post('/reviews/:id/approval/withdraw')
  @HttpCode(200)
  withdrawReviewApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: WithdrawContentStudioReviewApprovalDto
  ) {
    return this._contentStudioReviewService.decideApproval({
      organizationId: org.id,
      userId: user.id,
      reviewId: id,
      action: 'withdraw',
      note: body.note,
    });
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

  // The image reference a design stores for one ready Media of the
  // organization: its id and the SHA-256 of its stored bytes, hashed by the
  // server. No URL, path or file leaves, and nothing changes
  @Get('/media/:id/design-ref')
  getMediaDesignReference(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._contentStudioDesignReferenceService.getMediaReference(
      org.id,
      id
    );
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
