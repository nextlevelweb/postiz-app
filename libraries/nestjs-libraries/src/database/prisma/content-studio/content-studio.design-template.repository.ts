import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const TEMPLATE_SUMMARY = {
  id: true,
  name: true,
  description: true,
  latestRevisionNumber: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Revision lists and the compare-and-swap never load the content
const REVISION_SUMMARY = {
  id: true,
  revisionNumber: true,
  schemaVersion: true,
  contentHash: true,
  createdAt: true,
} as const;

const REVISION_DETAIL = {
  ...REVISION_SUMMARY,
  content: true,
} as const;

// A revision as the service canonicalized and hashed it
interface StoredRevision {
  schemaVersion: number;
  content: string;
  contentHash: string;
}

// Design templates of an organization, like its design projects: every query
// filters on organizationId itself, so a template of another organization
// reads exactly like a missing one (null or count 0). An archived template is
// read-only until it is restored, and its history stays readable. The
// template row holds the name, the description, the archive state and the
// latest revision number; the design documents are revisions, only ever
// created (with their template, or by the compare-and-swap), never updated
// or deleted, and nothing is deleted at all
@Injectable()
export class ContentStudioDesignTemplateRepository {
  constructor(
    private _template: PrismaRepository<'contentStudioDesignTemplate'>,
    private _revision: PrismaRepository<'contentStudioDesignTemplateRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  listTemplatesForOrganization(input: {
    organizationId: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._template.model.contentStudioDesignTemplate.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: TEMPLATE_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countTemplatesForOrganization(input: {
    organizationId: string;
    archived: boolean;
  }) {
    return this._template.model.contentStudioDesignTemplate.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getTemplateForOrganization(organizationId: string, id: string) {
    return this._template.model.contentStudioDesignTemplate.findFirst({
      where: {
        id,
        organizationId,
      },
      select: TEMPLATE_SUMMARY,
    });
  }

  // The template and its first revision, or neither
  createTemplateWithFirstRevision(input: {
    templateId: string;
    revisionId: string;
    organizationId: string;
    name: string;
    description: string | null;
    createdById: string;
    revision: StoredRevision;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const template = await tx.contentStudioDesignTemplate.create({
        data: {
          id: input.templateId,
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          latestRevisionNumber: 1,
          createdById: input.createdById,
        },
        select: TEMPLATE_SUMMARY,
      });
      const revision = await tx.contentStudioDesignTemplateRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          templateId: input.templateId,
          revisionNumber: 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { template, revision };
    });
  }

  // The name and description are not part of the design document: changing
  // them makes no revision
  updateTemplateDetails(
    organizationId: string,
    id: string,
    details: { name?: string; description?: string | null }
  ) {
    return this._template.model.contentStudioDesignTemplate.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: details,
    });
  }

  archiveTemplate(organizationId: string, id: string, archivedAt: Date) {
    return this._template.model.contentStudioDesignTemplate.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: {
        archivedAt,
      },
    });
  }

  restoreTemplate(organizationId: string, id: string) {
    return this._template.model.contentStudioDesignTemplate.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: { not: null },
      },
      data: {
        archivedAt: null,
      },
    });
  }

  // Saves a new design document over the revision the editor started from,
  // in one transaction, exactly like a design revision: the template must be
  // live and still at that revision. Content equal to that revision makes no
  // new one. The update only matches the expected revision number and holds
  // the template row until commit, so two saves can never take the same
  // number
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    templateId: string;
    expectedLatestRevisionNumber: number;
    revisionId: string;
    revision: StoredRevision;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const template = await tx.contentStudioDesignTemplate.findFirst({
        where: {
          id: input.templateId,
          organizationId: input.organizationId,
        },
        select: {
          latestRevisionNumber: true,
          archivedAt: true,
        },
      });
      if (!template) {
        return { status: 'not-found' as const };
      }
      if (template.archivedAt) {
        return { status: 'archived' as const };
      }
      if (
        template.latestRevisionNumber !== input.expectedLatestRevisionNumber
      ) {
        return {
          status: 'conflict' as const,
          currentRevisionNumber: template.latestRevisionNumber,
        };
      }

      const current = await tx.contentStudioDesignTemplateRevision.findFirst({
        where: {
          organizationId: input.organizationId,
          templateId: input.templateId,
          revisionNumber: input.expectedLatestRevisionNumber,
        },
        select: REVISION_DETAIL,
      });
      if (current && current.contentHash === input.revision.contentHash) {
        return { status: 'unchanged' as const, revision: current };
      }

      const { count } = await tx.contentStudioDesignTemplate.updateMany({
        where: {
          id: input.templateId,
          organizationId: input.organizationId,
          archivedAt: null,
          latestRevisionNumber: input.expectedLatestRevisionNumber,
        },
        data: {
          latestRevisionNumber: {
            increment: 1,
          },
        },
      });
      if (count !== 1) {
        return { status: 'changed' as const };
      }

      const revision = await tx.contentStudioDesignTemplateRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          templateId: input.templateId,
          revisionNumber: input.expectedLatestRevisionNumber + 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { status: 'created' as const, revision };
    });
  }

  // Summaries only, newest first: content is loaded one revision at a time
  listRevisionsForTemplate(input: {
    organizationId: string;
    templateId: string;
    skip: number;
    take: number;
  }) {
    return this._revision.model.contentStudioDesignTemplateRevision.findMany({
      where: {
        organizationId: input.organizationId,
        templateId: input.templateId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: REVISION_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countRevisionsForTemplate(organizationId: string, templateId: string) {
    return this._revision.model.contentStudioDesignTemplateRevision.count({
      where: {
        organizationId,
        templateId,
      },
    });
  }

  // A revision of exactly this template of the organization: an id of
  // another template, or of another organization, finds nothing
  getRevisionForTemplate(
    organizationId: string,
    templateId: string,
    revisionId: string
  ) {
    return this._revision.model.contentStudioDesignTemplateRevision.findFirst({
      where: {
        id: revisionId,
        templateId,
        organizationId,
      },
      select: REVISION_DETAIL,
    });
  }

  getRevisionByNumber(
    organizationId: string,
    templateId: string,
    revisionNumber: number
  ) {
    return this._revision.model.contentStudioDesignTemplateRevision.findFirst({
      where: {
        organizationId,
        templateId,
        revisionNumber,
      },
      select: REVISION_DETAIL,
    });
  }

  // The current revision of each listed template, in one query
  listCurrentRevisions(
    organizationId: string,
    templates: Array<{ id: string; latestRevisionNumber: number }>
  ) {
    if (!templates.length) {
      return Promise.resolve([]);
    }
    return this._revision.model.contentStudioDesignTemplateRevision.findMany({
      where: {
        organizationId,
        OR: templates.map((template) => ({
          templateId: template.id,
          revisionNumber: template.latestRevisionNumber,
        })),
      },
      select: { ...REVISION_DETAIL, templateId: true },
    });
  }
}
