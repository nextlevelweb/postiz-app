import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioDesignTemplateRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.repository';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignDocumentError,
  ContentStudioDesignDocumentV1,
  DESIGN_PROJECT_NAME_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignIntegrityError,
  parseVerifiedContentStudioDesignRevision,
  storedContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import {
  ContentStudioSystemDesignTemplate,
  DESIGN_TEMPLATE_DESCRIPTION_MAX,
  findContentStudioSystemDesignTemplate,
  listContentStudioSystemDesignTemplates,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.templates';
import {
  applyContentStudioDesignTemplateCustomization,
  ContentStudioDesignTemplateCustomizationError,
  ContentStudioDesignTemplateGuidanceError,
  ContentStudioDesignTemplateGuidanceV1,
  ContentStudioDesignTemplateValue,
  parseContentStudioDesignTemplateGuidance,
  parseContentStudioDesignTemplateValues,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import {
  parseVerifiedContentStudioDesignTemplateGuidance,
  storedContentStudioDesignTemplateGuidance,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance.revision';

// Fixed messages only: never template text, names, ids, zod or Prisma
// errors. A template of another organization is a plain 404
const notFound = () =>
  new HttpException({ msg: 'Template not found.', code: 'CS_NOT_FOUND' }, 404);
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const templateArchived = () =>
  new HttpException(
    { msg: 'This template is archived.', code: 'CS_DESIGN_TEMPLATE_ARCHIVED' },
    409
  );
const revisionConflict = (currentRevisionNumber: number) =>
  new HttpException(
    {
      msg: 'The template changed. Reload it and try again.',
      code: 'CS_DESIGN_TEMPLATE_REVISION_CONFLICT',
      currentRevisionNumber,
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored template data could not be read safely.',
      code: 'CS_DESIGN_TEMPLATE_INTEGRITY_ERROR',
    },
    500
  );
const guidanceInvalid = () =>
  new HttpException(
    {
      msg: 'The template fields are invalid.',
      code: 'CS_DESIGN_TEMPLATE_GUIDANCE_INVALID',
    },
    400
  );
const guidanceStale = () =>
  new HttpException(
    {
      msg: 'A template field no longer matches a layer of the design.',
      code: 'CS_DESIGN_TEMPLATE_GUIDANCE_STALE',
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
const CUSTOMIZATION_ERRORS: Record<string, [string, string]> = {
  INVALID: ['The template values are invalid.', 'CS_INVALID_REQUEST'],
  UNKNOWN_FIELD: [
    'A value names a field this template does not have.',
    'CS_DESIGN_TEMPLATE_FIELD_UNKNOWN',
  ],
  FIELD_TYPE: [
    'A value does not fit its template field.',
    'CS_DESIGN_TEMPLATE_FIELD_INVALID',
  ],
  REQUIRED_FIELD: [
    'A required template field has no value.',
    'CS_DESIGN_TEMPLATE_FIELD_REQUIRED',
  ],
  BRAND_REBIND_UNSUPPORTED: [
    'This template cannot be used with another Brand Kit revision.',
    'CS_DESIGN_TEMPLATE_BRAND_REBIND_UNSUPPORTED',
  ],
  STALE: [
    'A template field no longer matches a layer of the design.',
    'CS_DESIGN_TEMPLATE_GUIDANCE_STALE',
  ],
};
const customizationError = (
  err: ContentStudioDesignTemplateCustomizationError
) => {
  const [msg, code] = CUSTOMIZATION_ERRORS[err.code];
  return new HttpException({ msg, code }, 400);
};
const mediaInvalid = () =>
  new HttpException(
    {
      msg: 'The selected media item cannot be used for this field.',
      code: 'CS_DESIGN_TEMPLATE_MEDIA_INVALID',
    },
    400
  );
const brandReferenceNotFound = () =>
  new HttpException(
    {
      msg: 'The selected Brand Kit revision is not available.',
      code: 'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND',
    },
    400
  );
const brandIncompatible = () =>
  new HttpException(
    {
      msg: 'The selected Brand Kit revision lacks a color or type style this template uses.',
      code: 'CS_DESIGN_TEMPLATE_BRAND_INCOMPATIBLE',
    },
    400
  );

// Template and revision ids are Prisma uuid() values; anything else cannot
// exist (a built-in id is "system:…" and is never a row)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
// a template page carries a document per template: fewer than other lists
const PAGE_SIZE = 12;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Two saves took the same number: the compare-and-swap normally stops this
// first, so it is the same conflict
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
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

// a stored revision with its document and guidance
interface RevisionDetailRow extends RevisionRow {
  content: string;
  guidanceSchemaVersion: number | null;
  guidance: string | null;
  guidanceHash: string | null;
}

// the fixed code of an HttpException of another Content Studio service
const errorCode = (err: unknown) => {
  if (!(err instanceof HttpException)) {
    return undefined;
  }
  const response = err.getResponse();
  return typeof response === 'object' && response !== null
    ? (response as { code?: unknown }).code
    : undefined;
};

// Built field by field: no organization, creator or stored text leaves
const templateSummary = (row: TemplateRow) => ({
  source: 'organization' as const,
  id: row.id,
  name: row.name,
  description: row.description,
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

// A built-in template as the catalog shows it: never archived, never
// changed by any route
const systemSummary = (template: ContentStudioSystemDesignTemplate) => ({
  source: 'system' as const,
  id: template.id,
  name: template.name,
  description: template.description,
  latestRevisionNumber: template.revisionNumber,
  archivedAt: null as Date | null,
  currentRevision: {
    revisionNumber: template.revisionNumber,
    schemaVersion: template.schemaVersion,
    contentHash: template.contentHash,
    content: template.content,
    guidanceHash: template.guidanceHash,
    guidance: template.guidance,
  },
});

// Line endings normalized, trimmed, within a length, no NUL or unpaired
// surrogate
const plainText = (value: unknown, max: number, required: boolean) => {
  if (value === undefined && !required) {
    return undefined;
  }
  const trimmed =
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : null;
  if (
    trimmed === null ||
    (required && !trimmed) ||
    trimmed.length > max ||
    trimmed.includes('\u0000') ||
    UNPAIRED_SURROGATE.test(trimmed)
  ) {
    throw invalidRequest();
  }
  return trimmed;
};

// Design templates: reusable starting points for designs, of one
// organization (custom, as rows with immutable revisions) or built in (code,
// the same everywhere, never changed by a route). Every member may create,
// rename, revise, archive, restore and use the organization's templates: no
// role, plan or billing check. A template revision is a Design Document v1
// under the same rules as a design revision: the parser, the exact Brand Kit
// reference of the organization, canonical JSON and its hash. Using a
// template creates an ordinary design (through the design service) from
// exactly the revision asked for, its document copied as it is: nothing is
// relinked, rehashed, renumbered or replaced by a current Brand Kit, and
// nothing links the design back. A template revision may also hold
// Template Guidance v1 for exactly its document (P4-12): fields that the
// person using it fills (text, or an image of the organization's Media) and
// whether another exact Brand Kit revision may be used. Those values are
// written into the copy before the design is created, and the copy is still
// only Design Document v1. A design revision saved as a template is read by
// the server from the stored revision, never from the request, and gets no
// guidance. Nothing here renders, lays out, generates or fetches; Media is
// only looked at through the design reference service, for the exact image
// a field is given
@Injectable()
export class ContentStudioDesignTemplateService {
  constructor(
    private _contentStudioDesignTemplateRepository: ContentStudioDesignTemplateRepository,
    private _contentStudioDesignService: ContentStudioDesignService,
    private _contentStudioDesignReferenceService: ContentStudioDesignReferenceService
  ) {}

  // The built-in templates (not when archived ones are asked for) and one
  // page of the organization's, each with its current document
  async listTemplates(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioDesignTemplateRepository.listTemplatesForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioDesignTemplateRepository.countTemplatesForOrganization(
        filter
      ),
    ]);
    const current =
      await this._contentStudioDesignTemplateRepository.listCurrentRevisions(
        input.organizationId,
        rows
      );
    return {
      system: input.archived
        ? []
        : listContentStudioSystemDesignTemplates().map(systemSummary),
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => {
        const revision = current.find(
          (entry) =>
            entry.templateId === row.id &&
            entry.revisionNumber === row.latestRevisionNumber
        );
        if (!revision) {
          throw integrityError();
        }
        return {
          ...templateSummary(row),
          currentRevision: this.revisionDetail(revision),
        };
      }),
    };
  }

  // The template and its first revision are created together, after the
  // document (and its Brand Kit reference) checked out like a design's
  async createTemplate(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    description: unknown;
    content: unknown;
  }) {
    const name = plainText(input.name, DESIGN_PROJECT_NAME_MAX, true) as string;
    const description = this.description(input.description);
    const content =
      await this._contentStudioDesignService.parseDocumentForOrganization(
        input.organizationId,
        input.content
      );
    return this.storeNewTemplate({
      organizationId: input.organizationId,
      userId: input.userId,
      name,
      description,
      content,
    });
  }

  // A new template from exactly one stored revision of one of the
  // organization's designs: the server reads that revision (its integrity
  // proven) and nothing of the document comes from the request. The design
  // is not changed. Any revision of the design may be saved, also an older
  // one and also of an archived design: they are all immutable and readable
  async saveDesignRevisionAsTemplate(input: {
    organizationId: string;
    userId: string;
    designId: string;
    revisionId: string;
    name: unknown;
    description: unknown;
  }) {
    const name = plainText(input.name, DESIGN_PROJECT_NAME_MAX, true) as string;
    const description = this.description(input.description);
    const revision = await this._contentStudioDesignService.getStoredRevision({
      organizationId: input.organizationId,
      designId: input.designId,
      revisionId: input.revisionId,
    });
    // the same checks as any template document: its Brand Kit reference is
    // looked at again, exactly, never replaced
    const content =
      await this._contentStudioDesignService.parseDocumentForOrganization(
        input.organizationId,
        revision.content
      );
    return this.storeNewTemplate({
      organizationId: input.organizationId,
      userId: input.userId,
      name,
      description,
      content,
    });
  }

  // An archived template stays readable, with its current document
  async getTemplate(organizationId: string, id: string) {
    const template = await this.getRow(organizationId, id);
    const current =
      await this._contentStudioDesignTemplateRepository.getRevisionByNumber(
        organizationId,
        template.id,
        template.latestRevisionNumber
      );
    if (!current) {
      throw integrityError();
    }
    return {
      ...templateSummary(template),
      currentRevision: this.revisionDetail(current),
    };
  }

  // The name and the description only: the document needs a revision. An
  // archived template is read-only until it is restored
  async updateTemplate(
    organizationId: string,
    id: string,
    input: { name: unknown; description: unknown }
  ) {
    const name = plainText(input.name, DESIGN_PROJECT_NAME_MAX, false);
    const description =
      input.description === undefined
        ? undefined
        : this.description(input.description);
    if (name === undefined && description === undefined) {
      throw invalidRequest();
    }
    this.assertId(id);
    const { count } =
      await this._contentStudioDesignTemplateRepository.updateTemplateDetails(
        organizationId,
        id,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
        }
      );
    const template = await this.getRow(organizationId, id);
    if (count === 0) {
      throw templateArchived();
    }
    return templateSummary(template);
  }

  // Archiving an archived template (or restoring an active one) changes
  // nothing and returns it as it is. Neither touches the revisions
  async archiveTemplate(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignTemplateRepository.archiveTemplate(
      organizationId,
      id,
      new Date()
    );
    return templateSummary(await this.getRow(organizationId, id));
  }

  async restoreTemplate(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignTemplateRepository.restoreTemplate(
      organizationId,
      id
    );
    return templateSummary(await this.getRow(organizationId, id));
  }

  // Saves a new document and its guidance (or none: null) over the revision
  // the editor started from, like a design revision: a missing, archived or
  // moved-on template is answered before the Brand Kit is read, and the
  // compare-and-swap decides the rest, for both together. The guidance is
  // checked after the document, against exactly that document. Nothing is
  // retried
  async createRevision(input: {
    organizationId: string;
    templateId: string;
    userId: string;
    baseRevisionNumber: unknown;
    content: unknown;
    guidance: unknown;
  }) {
    this.assertId(input.templateId);
    if (
      !Number.isSafeInteger(input.baseRevisionNumber) ||
      (input.baseRevisionNumber as number) < 1 ||
      (input.baseRevisionNumber as number) > INT4_MAX
    ) {
      throw invalidRequest();
    }
    if (input.guidance === undefined) {
      throw invalidRequest();
    }
    const template = await this.getRow(input.organizationId, input.templateId);
    if (template.archivedAt) {
      throw templateArchived();
    }
    if (template.latestRevisionNumber !== input.baseRevisionNumber) {
      throw revisionConflict(template.latestRevisionNumber);
    }
    const content =
      await this._contentStudioDesignService.parseDocumentForOrganization(
        input.organizationId,
        input.content
      );
    const guidance = this.parseGuidance(input.guidance, content);
    const stored = {
      ...storedContentStudioDesignDocument(content),
      ...storedContentStudioDesignTemplateGuidance(guidance),
    };

    let result;
    try {
      result =
        await this._contentStudioDesignTemplateRepository.createRevisionWithCompareAndSwap(
          {
            organizationId: input.organizationId,
            templateId: input.templateId,
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
          revision: {
            ...revisionSummary(result.revision),
            content,
            guidanceHash: stored.guidanceHash,
            guidance,
          },
        };
      case 'unchanged':
        return {
          created: false,
          revision: this.revisionDetail(result.revision),
        };
      case 'not-found':
        throw notFound();
      case 'archived':
        throw templateArchived();
      case 'conflict':
        throw revisionConflict(result.currentRevisionNumber);
      default: {
        // the template moved on inside the transaction: tell why from now
        const now = await this.getRow(input.organizationId, input.templateId);
        if (now.archivedAt) {
          throw templateArchived();
        }
        throw revisionConflict(now.latestRevisionNumber);
      }
    }
  }

  // History stays readable when the template is archived
  async listRevisions(input: {
    organizationId: string;
    templateId: string;
    page: number;
  }) {
    await this.getRow(input.organizationId, input.templateId);
    const [rows, count] = await Promise.all([
      this._contentStudioDesignTemplateRepository.listRevisionsForTemplate({
        organizationId: input.organizationId,
        templateId: input.templateId,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioDesignTemplateRepository.countRevisionsForTemplate(
        input.organizationId,
        input.templateId
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(revisionSummary),
    };
  }

  async getRevision(input: {
    organizationId: string;
    templateId: string;
    revisionId: string;
  }) {
    this.assertId(input.templateId);
    this.assertId(input.revisionId);
    const row =
      await this._contentStudioDesignTemplateRepository.getRevisionForTemplate(
        input.organizationId,
        input.templateId,
        input.revisionId
      );
    if (!row) {
      throw notFound();
    }
    return this.revisionDetail(row);
  }

  // A new ordinary design from exactly one template revision: a built-in by
  // its id and revision number, or one of the organization's own by its
  // template and revision ids (an archived template is not used). The
  // document is copied as it is stored, with its page and layer ids, its
  // Brand Kit reference and its image references, and then gets the values
  // given for the revision's fields: every value must name one of its
  // fields, of the right kind, and every required field needs one (checked
  // before anything else is read). An image value must be exactly the
  // reference the server makes now for that Media item of the organization;
  // another Brand Kit revision, only where the guidance allows it, must be a
  // revision of the organization's kit holding every token the document
  // uses, or nothing changes (never the latest revision, never a mapping of
  // tokens, never part of it). The design service then creates the design
  // and its revision 1 together, under the same checks as any new design;
  // the design holds no guidance and nothing of the template
  async instantiateTemplate(input: {
    organizationId: string;
    userId: string;
    source: unknown;
    templateId: unknown;
    revisionId: unknown;
    revisionNumber: unknown;
    name: unknown;
    values?: unknown;
    brandKitRevisionId?: unknown;
  }) {
    const revision = await this.templateRevision(input);
    let values: Record<string, ContentStudioDesignTemplateValue>;
    try {
      values = parseContentStudioDesignTemplateValues(input.values);
    } catch (err) {
      if (err instanceof ContentStudioDesignTemplateCustomizationError) {
        throw customizationError(err);
      }
      throw err;
    }
    const rebind = input.brandKitRevisionId !== undefined;
    if (rebind && typeof input.brandKitRevisionId !== 'string') {
      throw invalidRequest();
    }
    // every field checked, with no Media or Brand Kit read yet; a Brand Kit
    // revision is refused here when the template does not allow one
    let content = this.customize({
      document: revision.content,
      guidance: revision.guidance,
      values,
      brandKit:
        rebind && revision.content.brandKit
          ? revision.content.brandKit
          : undefined,
      rebind,
    });
    for (const slot of revision.guidance?.slots ?? []) {
      const value = values[slot.id];
      if (slot.type === 'image' && value !== undefined) {
        await this.assertMediaReference(
          input.organizationId,
          value as { mediaId: string; sha256: string }
        );
      }
    }
    if (rebind) {
      const brandKit = await this.brandKitReference(
        input.organizationId,
        input.brandKitRevisionId as string
      );
      content = this.customize({
        document: revision.content,
        guidance: revision.guidance,
        values,
        brandKit,
        rebind,
      });
      await this.assertBrandCompatible(input.organizationId, content);
    }
    return this._contentStudioDesignService.createDesign({
      organizationId: input.organizationId,
      userId: input.userId,
      name: input.name,
      content,
    });
  }

  private customize(input: {
    document: ContentStudioDesignDocumentV1;
    guidance: ContentStudioDesignTemplateGuidanceV1 | null;
    values: Record<string, ContentStudioDesignTemplateValue>;
    brandKit: ContentStudioDesignBrandKitRef | undefined;
    rebind: boolean;
  }) {
    if (input.rebind && !input.brandKit) {
      // a document without a Brand Kit has nothing to rebind
      throw customizationError(
        new ContentStudioDesignTemplateCustomizationError(
          'BRAND_REBIND_UNSUPPORTED'
        )
      );
    }
    try {
      return applyContentStudioDesignTemplateCustomization({
        document: input.document,
        guidance: input.guidance,
        values: input.values,
        brandKit: input.brandKit,
      });
    } catch (err) {
      if (err instanceof ContentStudioDesignTemplateCustomizationError) {
        throw customizationError(err);
      }
      if (err instanceof ContentStudioDesignDocumentError) {
        throw err.code === 'TOO_LARGE' ? designTooLarge() : designInvalid();
      }
      throw err;
    }
  }

  // The image of a field is exactly what the design reference service makes
  // for that Media item of the organization now: its id and the SHA-256 of
  // its stored bytes. Another organization's or a missing item, or other
  // bytes than the browser was given, is refused
  private async assertMediaReference(
    organizationId: string,
    value: { mediaId: string; sha256: string }
  ) {
    let reference;
    try {
      reference =
        await this._contentStudioDesignReferenceService.getMediaReference(
          organizationId,
          value.mediaId
        );
    } catch (err) {
      if (errorCode(err) === 'CS_NOT_FOUND') {
        throw mediaInvalid();
      }
      throw err;
    }
    if (
      reference.mediaId !== value.mediaId ||
      reference.sha256 !== value.sha256
    ) {
      throw mediaInvalid();
    }
  }

  // Exactly the Brand Kit revision asked for, of the organization's kit and
  // intact, never its latest
  private async brandKitReference(organizationId: string, revisionId: string) {
    try {
      return await this._contentStudioDesignReferenceService.getBrandKitReference(
        organizationId,
        revisionId
      );
    } catch (err) {
      if (errorCode(err) === 'CS_NOT_FOUND') {
        throw brandReferenceNotFound();
      }
      throw err;
    }
  }

  // All or nothing: the design service refuses a reference whose revision
  // lacks a token the document uses. The reference was made by the server
  // from that exact revision, so that is the only way it can be invalid here
  private async assertBrandCompatible(
    organizationId: string,
    content: ContentStudioDesignDocumentV1
  ) {
    try {
      await this._contentStudioDesignService.parseDocumentForOrganization(
        organizationId,
        content
      );
    } catch (err) {
      if (errorCode(err) === 'CS_DESIGN_BRAND_REFERENCE_INVALID') {
        throw brandIncompatible();
      }
      throw err;
    }
  }

  private async templateRevision(input: {
    organizationId: string;
    source: unknown;
    templateId: unknown;
    revisionId: unknown;
    revisionNumber: unknown;
  }): Promise<{
    content: ContentStudioDesignDocumentV1;
    guidance: ContentStudioDesignTemplateGuidanceV1 | null;
  }> {
    if (input.source === 'system') {
      const template = findContentStudioSystemDesignTemplate(input.templateId);
      if (!template) {
        throw notFound();
      }
      if (input.revisionNumber !== template.revisionNumber) {
        throw notFound();
      }
      return { content: template.content, guidance: template.guidance };
    }
    if (input.source !== 'organization') {
      throw invalidRequest();
    }
    if (typeof input.templateId !== 'string') {
      throw notFound();
    }
    const template = await this.getRow(input.organizationId, input.templateId);
    if (template.archivedAt) {
      throw templateArchived();
    }
    if (typeof input.revisionId !== 'string') {
      throw notFound();
    }
    this.assertId(input.revisionId);
    const row =
      await this._contentStudioDesignTemplateRepository.getRevisionForTemplate(
        input.organizationId,
        template.id,
        input.revisionId
      );
    if (!row) {
      throw notFound();
    }
    const detail = this.revisionDetail(row);
    return { content: detail.content, guidance: detail.guidance };
  }

  // A new template has no guidance: fields are marked by a later revision,
  // never inferred
  private async storeNewTemplate(input: {
    organizationId: string;
    userId: string;
    name: string;
    description: string | null;
    content: ContentStudioDesignDocumentV1;
  }) {
    const stored = {
      ...storedContentStudioDesignDocument(input.content),
      ...storedContentStudioDesignTemplateGuidance(null),
    };
    const { template, revision } =
      await this._contentStudioDesignTemplateRepository.createTemplateWithFirstRevision(
        {
          templateId: randomUUID(),
          revisionId: randomUUID(),
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          createdById: input.userId,
          revision: stored,
        }
      );
    return {
      ...templateSummary(template),
      currentRevision: {
        ...revisionSummary(revision),
        content: input.content,
        guidanceHash: null as string | null,
        guidance: null as ContentStudioDesignTemplateGuidanceV1 | null,
      },
    };
  }

  // Template Guidance v1 for exactly this document, or null for none
  private parseGuidance(
    input: unknown,
    content: ContentStudioDesignDocumentV1
  ): ContentStudioDesignTemplateGuidanceV1 | null {
    if (input === null) {
      return null;
    }
    try {
      return parseContentStudioDesignTemplateGuidance(input, content);
    } catch (err) {
      if (err instanceof ContentStudioDesignTemplateGuidanceError) {
        throw err.code === 'STALE' ? guidanceStale() : guidanceInvalid();
      }
      throw err;
    }
  }

  // Optional; empty is none
  private description(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }
    return plainText(value, DESIGN_TEMPLATE_DESCRIPTION_MAX, false) || null;
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    this.assertId(id);
    const row =
      await this._contentStudioDesignTemplateRepository.getTemplateForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // A revision must still be exactly what was stored, its document and its
  // guidance for that document; anything else is reported, never repaired,
  // and never quoted
  private revisionDetail(row: RevisionDetailRow) {
    let content;
    let guidance;
    try {
      content = parseVerifiedContentStudioDesignRevision(row);
      guidance = parseVerifiedContentStudioDesignTemplateGuidance(row, content);
    } catch (err) {
      if (err instanceof ContentStudioDesignIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return {
      ...revisionSummary(row),
      content,
      guidanceHash: row.guidanceHash,
      guidance,
    };
  }
}
