import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
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
import {
  contentStudioDesignBlankDocument,
  ContentStudioDesignFromPackage,
  ContentStudioDesignPackageSource,
  withContentStudioDesignPackageText,
} from '@gitroom/nestjs-libraries/content-studio/design/design.package.source';

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
const sourceIntegrityError = () =>
  new HttpException(
    {
      msg: 'Where this design came from could not be read safely.',
      code: 'CS_DESIGN_SOURCE_INTEGRITY_ERROR',
    },
    500
  );

// Design and revision ids are Prisma uuid() values; anything else cannot
// exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
// the page size of every Content Studio list
const PAGE_SIZE = 20;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Page and layer ids as the editor makes them: p_ or l_ and 20 hex
// characters
const newId = (prefix: 'p' | 'l') => () =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

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

// A project with the package revision it was created from, as stored and as
// that revision is now (read through the relation of the same organization)
interface ProjectDetailRow extends ProjectRow {
  sourcePackageRevisionId: string | null;
  sourcePackageContentHash: string | null;
  sourcePackageRevision: {
    id: string;
    packageId: string;
    revisionNumber: number;
    contentHash: string;
    package: { name: string };
  } | null;
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
// generates, fetches or looks at Media. A design created from a saved package
// revision (P6-01) keeps that revision and its hash from creation on; the
// detail shows it only while both still match that exact revision, never
// another revision of the package
@Injectable()
export class ContentStudioDesignService {
  constructor(
    private _contentStudioDesignRepository: ContentStudioDesignRepository,
    private _contentStudioBrandKitRepository: ContentStudioBrandKitRepository,
    private _contentStudioReviewService: ContentStudioReviewService
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
  // Brand Kit reference checked out. A source is only ever the exact package
  // revision the server read for this design (P6-01), stored with the
  // project in the same transaction; without one the design has none
  async createDesign(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    content: unknown;
    source?: ContentStudioDesignPackageSource;
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
        source: input.source
          ? {
              packageRevisionId: input.source.packageRevisionId,
              contentHash: input.source.contentHash,
            }
          : null,
      });
    return {
      ...projectSummary(project),
      currentRevision: { ...revisionSummary(revision), content },
    };
  }

  // A new design from one thread item of one saved package revision
  // (P6-01), as the package service read and verified them: the document a
  // template or a page set made for it, or else one blank page of a fixed
  // size, with the item's text exactly as saved in a new layer on the first
  // page unless a template field already holds it. Then created like any
  // other design, under the same checks, with the revision it came from
  async createDesignFromPackage(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    fromPackage: ContentStudioDesignFromPackage;
    document?: ContentStudioDesignDocumentV1;
    preset?: unknown;
    textPlaced: boolean;
  }) {
    const document =
      input.document ??
      contentStudioDesignBlankDocument(input.preset, newId('p')());
    if (!document) {
      throw invalidRequest();
    }
    let content = document;
    if (!input.textPlaced) {
      try {
        content = withContentStudioDesignPackageText(
          document,
          input.fromPackage.item.text,
          newId('l')
        );
      } catch (err) {
        if (err instanceof ContentStudioDesignDocumentError) {
          throw err.code === 'TOO_LARGE' ? designTooLarge() : designInvalid();
        }
        throw err;
      }
    }
    return this.createDesign({
      organizationId: input.organizationId,
      userId: input.userId,
      name: input.name,
      content,
      source: input.fromPackage.source,
    });
  }

  // An archived design stays readable, with its current document and where
  // it came from (P6-01)
  async getDesign(organizationId: string, id: string) {
    this.assertId(id);
    const project =
      await this._contentStudioDesignRepository.getProjectDetailForOrganization(
        organizationId,
        id
      );
    if (!project) {
      throw notFound();
    }
    const source = this.packageSource(project);
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
      source,
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

  // History stays readable when the design is archived. Each revision says
  // whether exactly it is approved (P5-05), judged for the whole page at once
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
    const approvals =
      await this._contentStudioReviewService.getRevisionApprovalStatuses({
        organizationId: input.organizationId,
        targetType: 'DESIGN_REVISION',
        revisionIds: rows.map((revision) => revision.id),
      });
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => ({
        ...revisionSummary(row),
        approval: approvals.get(row.id),
      })),
    };
  }

  // One revision as the API shows it: its document and whether exactly it
  // is approved now (P5-05)
  async getRevision(input: {
    organizationId: string;
    designId: string;
    revisionId: string;
  }) {
    const revision = await this.getStoredRevision(input);
    return {
      ...revision,
      approval:
        await this._contentStudioReviewService.getRevisionApprovalStatus({
          organizationId: input.organizationId,
          targetType: 'DESIGN_REVISION',
          targetRevisionId: revision.id,
        }),
    };
  }

  // A stored revision is read on its own integrity: the Brand Kit revision it
  // names is not loaded again
  async getStoredRevision(input: {
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

  // A design document as any design of the organization may hold it: valid
  // Design Document v1 whose Brand Kit reference, if any, is an exact intact
  // revision of the organization's kit holding every token it uses. The same
  // checks as creating a design or saving a revision; for design templates
  async parseDocumentForOrganization(organizationId: string, input: unknown) {
    const content = this.parseContent(input);
    await this.checkBrandReferences(organizationId, content);
    return content;
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

  // The package revision a design was created from: null for a design made
  // on its own (both stored fields null), else exactly the revision stored,
  // of the same organization, whose contentHash is still the one stored
  // with the design. Anything else is reported, never repaired or replaced
  // by another revision of the package
  private packageSource(row: ProjectDetailRow) {
    const revision = row.sourcePackageRevision;
    if (
      row.sourcePackageRevisionId === null &&
      row.sourcePackageContentHash === null &&
      revision === null
    ) {
      return null;
    }
    if (
      !revision ||
      revision.id !== row.sourcePackageRevisionId ||
      typeof row.sourcePackageContentHash !== 'string' ||
      !SHA256_HEX.test(row.sourcePackageContentHash) ||
      revision.contentHash !== row.sourcePackageContentHash
    ) {
      throw sourceIntegrityError();
    }
    return {
      packageId: revision.packageId,
      packageName: revision.package.name,
      packageRevisionId: revision.id,
      packageRevisionNumber: revision.revisionNumber,
      packageContentHash: revision.contentHash,
    };
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
