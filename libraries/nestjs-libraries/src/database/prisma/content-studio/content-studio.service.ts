import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import {
  assertContentPackagePublishable,
  CONTENT_PACKAGE_SCHEMA_VERSION,
  ContentPackageDraftError,
  emptyContentPackageDraft,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  CanonicalJsonError,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentPackageRevisionIntegrityError,
  parseVerifiedContentPackageRevision,
} from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import { ContentPackageRevisionOrigin } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.package.dto';

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

const packageChanged = () =>
  new HttpException(
    {
      msg: 'The Content Studio package changed while creating a revision',
      code: 'CS_PACKAGE_CHANGED',
    },
    409
  );
const draftEmptyItem = (itemIndex: number) =>
  new HttpException(
    {
      msg: 'The Content Studio draft contains an empty item',
      code: 'CS_DRAFT_EMPTY_ITEM',
      itemIndex,
    },
    400
  );
const storedRevisionInvalid = () =>
  new HttpException(
    {
      msg: 'Stored Content Studio revision is invalid',
      code: 'CS_STORED_REVISION_INVALID',
    },
    500
  );
const revisionStateInvalid = () =>
  new HttpException(
    {
      msg: 'Content Studio revision state is invalid',
      code: 'CS_REVISION_STATE_INVALID',
    },
    500
  );

// Two revisions took the same number: the compare-and-swap normally stops
// this first, so it is the same "package changed" conflict
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

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

interface RevisionRow {
  id: string;
  packageId: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  origin: string;
  sourceDraftVersion: number;
  createdAt: Date;
}

const revisionSummary = (row: RevisionRow) => ({
  id: row.id,
  packageId: row.packageId,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  origin: row.origin,
  sourceDraftVersion: row.sourceDraftVersion,
  createdAt: row.createdAt,
});

@Injectable()
export class ContentStudioService {
  private readonly _logger = new Logger(ContentStudioService.name);

  constructor(
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioMediaService: ContentStudioMediaService
  ) {}

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

    return {
      ...packageSummary(row),
      draft,
      media: await this._contentStudioMediaService.getPreviewMap(
        input.organizationId,
        draft
      ),
    };
  }

  async getPackage(organizationId: string, id: string) {
    const row = await this._contentStudioRepository.getPackageForOrganization(
      organizationId,
      id
    );
    if (!row) {
      throw notFound();
    }
    return this.packageDetail(organizationId, row);
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
    return this.packageDetail(input.organizationId, row);
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

  // Turns the current draft into an immutable revision, but only while it is
  // still at the draftVersion the client saw. Unchanged content returns the
  // latest revision instead of a copy; content that went back to an older
  // revision still makes a new one, so the history shows it
  async createRevision(input: {
    organizationId: string;
    packageId: string;
    userId: string;
    draftVersion: number;
    origin?: ContentPackageRevisionOrigin;
  }) {
    const row = await this._contentStudioRepository.getPackageForOrganization(
      input.organizationId,
      input.packageId
    );
    if (!row) {
      throw notFound();
    }
    if (row.archivedAt) {
      throw packageArchived();
    }
    if (row.draftVersion !== input.draftVersion) {
      throw draftConflict(row.draftVersion);
    }

    const draft = this.parseStoredDraft(row.id, row.draft);
    try {
      assertContentPackagePublishable(draft);
    } catch (err) {
      if (
        err instanceof ContentPackageDraftError &&
        err.code === 'EMPTY_ITEM'
      ) {
        throw draftEmptyItem(err.itemIndex);
      }
      throw err;
    }
    // The stored content is exactly the hashed text. A parsed draft is plain
    // JSON data, so canonicalJson failing means the draft itself is broken
    let content: string;
    try {
      content = canonicalJson(draft);
    } catch (err) {
      if (err instanceof CanonicalJsonError) {
        this._logger.error(`Stored Content Studio draft is invalid: ${row.id}`);
        throw storedDraftInvalid();
      }
      throw err;
    }
    const contentHash = sha256Hex(content);

    if (row.latestRevisionNumber > 0) {
      const latest =
        await this._contentStudioRepository.getLatestRevisionForPackage(
          input.organizationId,
          input.packageId
        );
      if (!latest) {
        this._logger.error(
          `Content Studio package has no latest revision: ${row.id}`
        );
        throw revisionStateInvalid();
      }
      if (latest.contentHash === contentHash) {
        return { created: false, revision: revisionSummary(latest) };
      }
    }

    let result;
    try {
      result =
        await this._contentStudioRepository.createRevisionWithCompareAndSwap({
          organizationId: input.organizationId,
          packageId: input.packageId,
          expectedDraftVersion: row.draftVersion,
          expectedLatestRevisionNumber: row.latestRevisionNumber,
          schemaVersion: CONTENT_PACKAGE_SCHEMA_VERSION,
          content,
          contentHash,
          origin: input.origin ?? 'manual',
          createdById: input.userId,
        });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw packageChanged();
      }
      throw err;
    }
    // the draft or the revisions moved on after the read above
    if (!result.created) {
      throw packageChanged();
    }
    return { created: true, revision: revisionSummary(result.revision) };
  }

  // History stays readable when the package is archived
  async listRevisions(input: {
    organizationId: string;
    packageId: string;
    page: number;
  }) {
    const state =
      await this._contentStudioRepository.getPackageWriteStateForOrganization(
        input.organizationId,
        input.packageId
      );
    if (!state) {
      throw notFound();
    }

    const [results, count] = await Promise.all([
      this._contentStudioRepository.listRevisionsForPackage({
        organizationId: input.organizationId,
        packageId: input.packageId,
        skip: (input.page - 1) * CONTENT_STUDIO_PAGE_SIZE,
        take: CONTENT_STUDIO_PAGE_SIZE,
      }),
      this._contentStudioRepository.countRevisionsForPackage(
        input.organizationId,
        input.packageId
      ),
    ]);

    return {
      pages: Math.ceil(count / CONTENT_STUDIO_PAGE_SIZE),
      results,
    };
  }

  async getRevision(input: {
    organizationId: string;
    packageId: string;
    revisionId: string;
  }) {
    const row = await this._contentStudioRepository.getRevisionForPackage(
      input.organizationId,
      input.packageId,
      input.revisionId
    );
    if (!row) {
      throw notFound();
    }

    // a corrupt revision fails here, before any Media is read
    const content = this.verifiedRevisionContent(row);
    return {
      ...revisionSummary(row),
      createdBy: { id: row.createdBy.id, name: row.createdBy.name },
      content,
      media: await this._contentStudioMediaService.getPreviewMap(
        input.organizationId,
        content
      ),
    };
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

  // The detail of a package shows the current state of its Media. A Media
  // that is missing, foreign, processing or failed never fails the detail:
  // the editor has to open so the draft can be fixed
  private async packageDetail(
    organizationId: string,
    row: PackageRow & { draft: string }
  ) {
    const draft = this.parseStoredDraft(row.id, row.draft);
    return {
      ...packageSummary(row),
      draft,
      media: await this._contentStudioMediaService.getPreviewMap(
        organizationId,
        draft
      ),
    };
  }

  // A stored draft that no longer parses is corrupt data, not a bad request:
  // it is reported as such and never repaired or replaced
  private parseStoredDraft(packageId: string, text: string) {
    try {
      return parseContentPackageDraft(JSON.parse(text));
    } catch {
      this._logger.error(
        `Stored Content Studio draft is invalid: ${packageId}`
      );
      throw storedDraftInvalid();
    }
  }

  // A revision must still be exactly what was stored; anything else is
  // reported, never normalized or repaired
  private verifiedRevisionContent(row: RevisionRow & { content: string }) {
    try {
      return parseVerifiedContentPackageRevision(row);
    } catch (err) {
      if (err instanceof ContentPackageRevisionIntegrityError) {
        this._logger.error(
          `Stored Content Studio revision is invalid: ${row.id}`
        );
        throw storedRevisionInvalid();
      }
      throw err;
    }
  }
}
