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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioAIConnectionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';
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

// The global pipe neither strips nor rejects unknown fields; here any field
// the DTO does not declare (organizationId, createdById, ...) is a 400
const contentStudioValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

@ApiTags('Content Studio')
@Controller('/content-studio')
@UsePipes(contentStudioValidationPipe)
export class ContentStudioController {
  constructor(
    private _contentStudioService: ContentStudioService,
    private _contentStudioHandoffService: ContentStudioHandoffService,
    private _contentStudioAIConnectionService: ContentStudioAIConnectionService
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
}
