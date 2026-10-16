import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import {
  collectContentStudioDesignBrandTokenRefs,
  ContentStudioDesignDocumentError,
  ContentStudioDesignDocumentV1,
  DESIGN_PROJECT_NAME_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignIntegrityError,
  parseVerifiedContentStudioDesignRevision,
  storedContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import {
  ContentStudioBrandKitIntegrityError,
  parseVerifiedContentStudioBrandKitRevision,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';

// Fixed messages only: never design text, names, ids, zod or Prisma errors.
// A design of another organization is a plain 404, and so is a Brand Kit
// revision of another organization
const notFound = () =>
  new HttpException({ msg: 'Design not found.', code: 'CS_NOT_FOUND' }, 404);
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const designInvalid = () =>
  new HttpException(
    { msg: 'The design document is invalid.', code: 'CS_DESIGN_INVALID' },
    400
  );
const designTooLarge = () =>
  new HttpException(
    { msg: 'The design document is too large.', code: 'CS_DESIGN_TOO_LARGE' },
    413
  );
const designArchived = () =>
  new HttpException(
    { msg: 'This design is archived.', code: 'CS_DESIGN_ARCHIVED' },
    409
  );
const revisionConflict = (currentRevisionNumber: number) =>
  new HttpException(
    {
      msg: 'The design changed. Reload it and try again.',
      code: 'CS_DESIGN_REVISION_CONFLICT',
      currentRevisionNumber,
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored design data could not be read safely.',
      code: 'CS_DESIGN_INTEGRITY_ERROR',
    },
    500
  );
const brandReferenceNotFound = () =>
  new HttpException(
    {
      msg: 'The selected Brand Kit revision is not available.',
      code: 'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND',
    },
    400
  );
const brandReferenceInvalid = () =>
  new HttpException(
    {
      msg: 'The design contains an invalid Brand Kit reference.',
      code: 'CS_DESIGN_BRAND_REFERENCE_INVALID',
    },
    400
  );
const brandReferenceIntegrityError = () =>
  new HttpException(
    {
      msg: 'Stored Brand Kit data could not be read safely.',
      code: 'CS_DESIGN_BRAND_REFERENCE_INTEGRITY_ERROR',
    },
    500
  );

// Design and revision ids are Prisma uuid() values; anything else cannot
// exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
// the page size of every Content Studio list
const PAGE_SIZE = 20;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Two saves took the same number: the compare-and-swap normally stops this
// first, so it is the same conflict
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface ProjectRow {
  id: string;
  name: string;
  latestRevisionNumber: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RevisionRow {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: Date;
}

// Built field by field: no organization, creator or stored text leaves
const projectSummary = (row: ProjectRow) => ({
  id: row.id,
  name: row.name,
  latestRevisionNumber: row.latestRevisionNumber,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const revisionSummary = (row: RevisionRow) => ({
  id: row.id,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  createdAt: row.createdAt,
});

// Design projects of an organization: named designs whose documents are
// immutable revisions. Every member may create, rename, revise, archive and
// restore them: no role, plan or billing check. A document naming a Brand Kit
// revision is saved only once that exact revision of the organization's kit is
// found, intact and has every token the document uses; nothing is copied from
// it and nothing follows a later revision. Nothing here renders, lays out,
// generates, fetches or looks at Media
@Injectable()
export class ContentStudioDesignService {
  constructor(
    private _contentStudioDesignRepository: ContentStudioDesignRepository,
    private _contentStudioBrandKitRepository: ContentStudioBrandKitRepository
  ) {}

  async listDesigns(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioDesignRepository.listProjectsForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioDesignRepository.countProjectsForOrganization(filter),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(projectSummary),
    };
  }

  // The project and its first revision are created together, after the
  // Brand Kit reference checked out
  async createDesign(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    content: unknown;
  }) {
    const name = this.designName(input.name);
    const content = this.parseContent(input.content);
    await this.checkBrandReferences(input.organizationId, content);
    const stored = storedContentStudioDesignDocument(content);

    const { project, revision } =
      await this._contentStudioDesignRepository.createProjectWithFirstRevision({
        designProjectId: randomUUID(),
        revisionId: randomUUID(),
        organizationId: input.organizationId,
        name,
        createdById: input.userId,
        revision: stored,
      });
    return {
      ...projectSummary(project),
      currentRevision: { ...revisionSummary(revision), content },
    };
  }

  // An archived design stays readable, with its current document
  async getDesign(organizationId: string, id: string) {
    const project = await this.getRow(organizationId, id);
    const current =
      await this._contentStudioDesignRepository.getRevisionByNumber(
        organizationId,
        project.id,
        project.latestRevisionNumber
      );
    if (!current) {
      throw integrityError();
    }
    return {
      ...projectSummary(project),
      currentRevision: this.revisionDetail(current),
    };
  }

  // Renames only: the document needs a revision. An archived design is
  // read-only until it is restored
  async renameDesign(organizationId: string, id: string, rawName: unknown) {
    const name = this.designName(rawName);
    this.assertId(id);
    const { count } =
      await this._contentStudioDesignRepository.updateProjectName(
        organizationId,
        id,
        name
      );
    const project = await this.getRow(organizationId, id);
    if (count === 0) {
      throw designArchived();
    }
    return projectSummary(project);
  }

  // Archiving an archived design (or restoring an active one) changes nothing
  // and returns it as it is. Neither touches the revisions
  async archiveDesign(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignRepository.archiveProject(
      organizationId,
      id,
      new Date()
    );
    return projectSummary(await this.getRow(organizationId, id));
  }

  async restoreDesign(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignRepository.restoreProject(
      organizationId,
      id
    );
    return projectSummary(await this.getRow(organizationId, id));
  }

  // Saves a new document over the revision the editor started from. A
  // missing, archived or moved-on design is answered before the Brand Kit is
  // read; the compare-and-swap decides the rest. Content equal to the base
  // revision returns it instead of a copy; a stale base is a conflict even
  // when the content is the same
  async createRevision(input: {
    organizationId: string;
    designId: string;
    userId: string;
    baseRevisionNumber: unknown;
    content: unknown;
  }) {
    this.assertId(input.designId);
    if (
      !Number.isSafeInteger(input.baseRevisionNumber) ||
      (input.baseRevisionNumber as number) < 1 ||
      (input.baseRevisionNumber as number) > INT4_MAX
    ) {
      throw invalidRequest();
    }
    const content = this.parseContent(input.content);
    const project = await this.getRow(input.organizationId, input.designId);
    if (project.archivedAt) {
      throw designArchived();
    }
    if (project.latestRevisionNumber !== input.baseRevisionNumber) {
      throw revisionConflict(project.latestRevisionNumber);
    }
    await this.checkBrandReferences(input.organizationId, content);
    const stored = storedContentStudioDesignDocument(content);

    let result;
    try {
      result =
        await this._contentStudioDesignRepository.createRevisionWithCompareAndSwap(
          {
            organizationId: input.organizationId,
            designProjectId: input.designId,
            expectedLatestRevisionNumber: input.baseRevisionNumber as number,
            revisionId: randomUUID(),
            revision: stored,
            createdById: input.userId,
          }
        );
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      result = { status: 'changed' as const };
    }

    switch (result.status) {
      case 'created':
        return {
          created: true,
          revision: { ...revisionSummary(result.revision), content },
        };
      case 'unchanged':
        return {
          created: false,
          revision: this.revisionDetail(result.revision),
        };
      case 'not-found':
        throw notFound();
      case 'archived':
        throw designArchived();
      case 'conflict':
        throw revisionConflict(result.currentRevisionNumber);
      default: {
        // the design moved on inside the transaction: tell why from now
        const now = await this.getRow(input.organizationId, input.designId);
        if (now.archivedAt) {
          throw designArchived();
        }
        throw revisionConflict(now.latestRevisionNumber);
      }
    }
  }

  // History stays readable when the design is archived
  async listRevisions(input: {
    organizationId: string;
    designId: string;
    page: number;
  }) {
    await this.getRow(input.organizationId, input.designId);
    const [rows, count] = await Promise.all([
      this._contentStudioDesignRepository.listRevisionsForProject({
        organizationId: input.organizationId,
        designProjectId: input.designId,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioDesignRepository.countRevisionsForProject(
        input.organizationId,
        input.designId
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(revisionSummary),
    };
  }

  // A stored revision is read on its own integrity: the Brand Kit revision it
  // names is not loaded again
  async getRevision(input: {
    organizationId: string;
    designId: string;
    revisionId: string;
  }) {
    this.assertId(input.designId);
    this.assertId(input.revisionId);
    const row = await this._contentStudioDesignRepository.getRevisionForProject(
      input.organizationId,
      input.designId,
      input.revisionId
    );
    if (!row) {
      throw notFound();
    }
    return this.revisionDetail(row);
  }

  // Without a Brand Kit reference no token may be used. With one, it must be
  // exactly a revision of this organization's kit: same kit, revision, number
  // and hash, intact, and holding every token the document uses. Nothing is
  // repaired or replaced by the current revision
  private async checkBrandReferences(
    organizationId: string,
    document: ContentStudioDesignDocumentV1
  ) {
    const { colorTokenIds, typographyTokenIds } =
      collectContentStudioDesignBrandTokenRefs(document);
    const reference = document.brandKit;
    if (!reference) {
      if (colorTokenIds.length || typographyTokenIds.length) {
        throw brandReferenceInvalid();
      }
      return;
    }
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        organizationId
      );
    if (!brandKit || brandKit.id !== reference.brandKitId) {
      throw brandReferenceNotFound();
    }
    const revision =
      await this._contentStudioBrandKitRepository.getRevisionForBrandKit(
        organizationId,
        brandKit.id,
        reference.revisionId
      );
    if (!revision) {
      throw brandReferenceNotFound();
    }
    let content;
    try {
      content = parseVerifiedContentStudioBrandKitRevision(revision);
    } catch (err) {
      if (err instanceof ContentStudioBrandKitIntegrityError) {
        throw brandReferenceIntegrityError();
      }
      throw err;
    }
    if (
      revision.revisionNumber !== reference.revisionNumber ||
      revision.contentHash !== reference.contentHash
    ) {
      throw brandReferenceInvalid();
    }
    const colors = new Set(content.colors.map((token) => token.id));
    const typography = new Set(content.typography.map((token) => token.id));
    if (
      colorTokenIds.some((id) => !colors.has(id)) ||
      typographyTokenIds.some((id) => !typography.has(id))
    ) {
      throw brandReferenceInvalid();
    }
  }

  // Line endings normalized, trimmed, 1-200 characters, no NUL or unpaired
  // surrogate
  private designName(name: unknown) {
    const trimmed =
      typeof name === 'string' ? name.replace(/\r\n?/g, '\n').trim() : '';
    if (
      !trimmed ||
      trimmed.length > DESIGN_PROJECT_NAME_MAX ||
      trimmed.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(trimmed)
    ) {
      throw invalidRequest();
    }
    return trimmed;
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioDesignDocument(input);
    } catch (err) {
      if (err instanceof ContentStudioDesignDocumentError) {
        throw err.code === 'TOO_LARGE' ? designTooLarge() : designInvalid();
      }
      throw err;
    }
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    this.assertId(id);
    const row =
      await this._contentStudioDesignRepository.getProjectForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // A revision must still be exactly what was stored; anything else is
  // reported, never repaired, and never quoted
  private revisionDetail(row: RevisionRow & { content: string }) {
    let content;
    try {
      content = parseVerifiedContentStudioDesignRevision(row);
    } catch (err) {
      if (err instanceof ContentStudioDesignIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return { ...revisionSummary(row), content };
  }
}
