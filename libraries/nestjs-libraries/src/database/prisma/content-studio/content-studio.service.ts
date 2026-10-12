import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import {
  ContentPackageDraftError,
  emptyContentPackageDraft,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

export const CONTENT_STUDIO_PAGE_SIZE = 20;
const UNTITLED_PACKAGE = 'Untitled package';

// Fixed messages only: never user content, ids or Prisma errors. A record of
// another organization is a plain 404, never a 403 (HttpForbiddenException
// would log the user out)
const notFound = () =>
  new HttpException(
    { msg: 'Content Studio item not found', code: 'CS_NOT_FOUND' },
    404
  );
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const projectArchived = () =>
  new HttpException(
    { msg: 'This project is archived', code: 'CS_PROJECT_ARCHIVED' },
    409
  );
const packageArchived = () =>
  new HttpException(
    { msg: 'This package is archived', code: 'CS_PACKAGE_ARCHIVED' },
    409
  );
const draftInvalid = () =>
  new HttpException(
    { msg: 'The Content Studio draft is invalid', code: 'CS_DRAFT_INVALID' },
    400
  );
const draftTooLarge = () =>
  new HttpException(
    {
      msg: 'The Content Studio draft is too large',
      code: 'CS_DRAFT_TOO_LARGE',
    },
    400
  );
const draftConflict = (currentDraftVersion: number) =>
  new HttpException(
    {
      msg: 'This Content Studio draft has changed',
      code: 'CS_DRAFT_VERSION_CONFLICT',
      currentDraftVersion,
    },
    409
  );
const storedDraftInvalid = () =>
  new HttpException(
    {
      msg: 'Stored Content Studio draft is invalid',
      code: 'CS_STORED_DRAFT_INVALID',
    },
    500
  );

interface PackageRow {
  id: string;
  name: string;
  projectId: string | null;
  draftVersion: number;
  latestRevisionNumber: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const packageSummary = (row: PackageRow) => ({
  id: row.id,
  name: row.name,
  projectId: row.projectId,
  draftVersion: row.draftVersion,
  latestRevisionNumber: row.latestRevisionNumber,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Injectable()
export class ContentStudioService {
  private readonly _logger = new Logger(ContentStudioService.name);

  constructor(private _contentStudioRepository: ContentStudioRepository) {}

  listProjects(organizationId: string, archived: boolean) {
    return this._contentStudioRepository.listProjectsForOrganization(
      organizationId,
      archived
    );
  }

  async createProject(organizationId: string, userId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw invalidRequest();
    }

    return this._contentStudioRepository.createProject({
      organizationId,
      name: trimmed,
      createdById: userId,
    });
  }

  // An archived project is read-only until it is restored
  async updateProjectName(organizationId: string, id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw invalidRequest();
    }

    const { count } = await this._contentStudioRepository.updateProjectName(
      organizationId,
      id,
      trimmed
    );
    const project =
      await this._contentStudioRepository.getProjectForOrganization(
        organizationId,
        id
      );
    if (!project) {
      throw notFound();
    }
    if (count === 0) {
      throw projectArchived();
    }
    return project;
  }

  // Archiving an archived project (or restoring an active one) changes
  // nothing and returns it as it is
  async archiveProject(organizationId: string, id: string) {
    await this._contentStudioRepository.archiveProject(
      organizationId,
      id,
      new Date()
    );
    return this.getProject(organizationId, id);
  }

  async restoreProject(organizationId: string, id: string) {
    await this._contentStudioRepository.restoreProject(organizationId, id);
    return this.getProject(organizationId, id);
  }

  async listPackages(input: {
    organizationId: string;
    archived: boolean;
    projectId?: string;
    page: number;
  }) {
    // the project may be archived: its packages stay visible
    if (input.projectId !== undefined) {
      await this.getProject(input.organizationId, input.projectId);
    }

    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
      projectId: input.projectId,
    };
    const [results, count] = await Promise.all([
      this._contentStudioRepository.listPackagesForOrganization({
        ...filter,
        skip: (input.page - 1) * CONTENT_STUDIO_PAGE_SIZE,
        take: CONTENT_STUDIO_PAGE_SIZE,
      }),
      this._contentStudioRepository.countPackagesForOrganization(filter),
    ]);

    return {
      pages: Math.ceil(count / CONTENT_STUDIO_PAGE_SIZE),
      results,
    };
  }

  async createPackage(input: {
    organizationId: string;
    userId: string;
    name?: string;
    projectId?: string;
  }) {
    if (input.projectId !== undefined) {
      await this.assertProjectAttachable(input.organizationId, input.projectId);
    }

    // The thread item id comes from the server, never from the client
    const draft = emptyContentPackageDraft(
      randomBytes(8).toString('base64url')
    );
    const row = await this._contentStudioRepository.createPackage({
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      name: input.name?.trim() || UNTITLED_PACKAGE,
      draft: JSON.stringify(draft),
      createdById: input.userId,
    });

    return { ...packageSummary(row), draft };
  }

  async getPackage(organizationId: string, id: string) {
    const row = await this._contentStudioRepository.getPackageForOrganization(
      organizationId,
      id
    );
    if (!row) {
      throw notFound();
    }
    return this.packageDetail(row);
  }

  // A name left out stays; projectId null detaches the package. An archived
  // package is read-only until it is restored
  async updatePackageMetadata(input: {
    organizationId: string;
    packageId: string;
    name?: string;
    projectId?: string | null;
  }) {
    if (input.name === undefined && input.projectId === undefined) {
      throw invalidRequest();
    }
    const name = input.name?.trim();
    if (name === '') {
      throw invalidRequest();
    }
    if (input.projectId !== undefined && input.projectId !== null) {
      await this.assertProjectAttachable(input.organizationId, input.projectId);
    }

    const { count } = await this._contentStudioRepository.updatePackageMetadata(
      {
        organizationId: input.organizationId,
        packageId: input.packageId,
        name,
        projectId: input.projectId,
      }
    );
    const row = await this._contentStudioRepository.getPackageForOrganization(
      input.organizationId,
      input.packageId
    );
    if (!row) {
      throw notFound();
    }
    if (count === 0) {
      throw packageArchived();
    }
    return this.packageDetail(row);
  }

  async archivePackage(organizationId: string, id: string) {
    await this._contentStudioRepository.archivePackage(
      organizationId,
      id,
      new Date()
    );
    return this.getPackage(organizationId, id);
  }

  async restorePackage(organizationId: string, id: string) {
    await this._contentStudioRepository.restorePackage(organizationId, id);
    return this.getPackage(organizationId, id);
  }

  // Saves only over the version the editor started from. The draft is
  // validated and stored in its normalized form, never as it was sent
  async saveDraft(input: {
    organizationId: string;
    packageId: string;
    baseDraftVersion: number;
    draft: unknown;
  }) {
    let draft;
    try {
      draft = parseContentPackageDraft(input.draft);
    } catch (err) {
      if (err instanceof ContentPackageDraftError) {
        throw err.code === 'DRAFT_TOO_LARGE' ? draftTooLarge() : draftInvalid();
      }
      throw err;
    }

    const { count } =
      await this._contentStudioRepository.saveDraftCompareAndSwap({
        organizationId: input.organizationId,
        packageId: input.packageId,
        baseDraftVersion: input.baseDraftVersion,
        draft: JSON.stringify(draft),
      });
    if (count === 1) {
      return { draftVersion: input.baseDraftVersion + 1 };
    }

    const state =
      await this._contentStudioRepository.getPackageWriteStateForOrganization(
        input.organizationId,
        input.packageId
      );
    if (!state) {
      throw notFound();
    }
    if (state.archivedAt) {
      throw packageArchived();
    }
    throw draftConflict(state.draftVersion);
  }

  private async getProject(organizationId: string, id: string) {
    const project =
      await this._contentStudioRepository.getProjectForOrganization(
        organizationId,
        id
      );
    if (!project) {
      throw notFound();
    }
    return project;
  }

  private async assertProjectAttachable(organizationId: string, id: string) {
    const project = await this.getProject(organizationId, id);
    if (project.archivedAt) {
      throw projectArchived();
    }
  }

  // A stored draft that no longer parses is corrupt data, not a bad request:
  // it is reported as such and never repaired or replaced
  private packageDetail(row: PackageRow & { draft: string }) {
    let draft;
    try {
      draft = parseContentPackageDraft(JSON.parse(row.draft));
    } catch {
      this._logger.error(`Stored Content Studio draft is invalid: ${row.id}`);
      throw storedDraftInvalid();
    }
    return { ...packageSummary(row), draft };
  }
}
