import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioDesignPageSetRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.repository';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import {
  ContentStudioDesignPageSetError,
  DESIGN_PAGE_SET_DESCRIPTION_MAX,
  DESIGN_PAGE_SET_NAME_MAX,
  instantiateContentStudioDesignPageSet,
  parseContentStudioDesignPageSetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import {
  ContentStudioDesignPageSetIntegrityError,
  parseVerifiedContentStudioDesignPageSet,
  storedContentStudioDesignPageSet,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set.stored';
import {
  ContentStudioSystemDesignPageSet,
  DESIGN_SYSTEM_PAGE_SET_ID,
  getContentStudioSystemDesignPageSet,
  listContentStudioSystemDesignPageSets,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.page.sets';

// Fixed messages only: never page set names, pages, ids, zod or Prisma
// errors. A page set of another organization is a plain 404
const notFound = () =>
  new HttpException({ msg: 'Page set not found.', code: 'CS_NOT_FOUND' }, 404);
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const pageSetInvalid = () =>
  new HttpException(
    {
      msg: 'The page set is invalid.',
      code: 'CS_DESIGN_PAGE_SET_INVALID',
    },
    400
  );
const pageSetTooLarge = () =>
  new HttpException(
    {
      msg: 'The page set is too large.',
      code: 'CS_DESIGN_PAGE_SET_TOO_LARGE',
    },
    413
  );
const pageSetArchived = () =>
  new HttpException(
    {
      msg: 'This page set is archived.',
      code: 'CS_DESIGN_PAGE_SET_ARCHIVED',
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored page set data could not be read safely.',
      code: 'CS_DESIGN_PAGE_SET_INTEGRITY_ERROR',
    },
    500
  );

// Page set ids are Prisma uuid() values; anything else cannot be a row (a
// built-in id is "system:…")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the editor lists a page of page sets at a time
const PAGE_SIZE = 50;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface PageSetRow {
  id: string;
  name: string;
  description: string | null;
  schemaVersion: number;
  content: string;
  contentHash: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// A built-in page set as the catalog shows it: never archived or changed
const systemSummary = (pageSet: ContentStudioSystemDesignPageSet) => ({
  source: 'system' as const,
  id: pageSet.id,
  name: pageSet.name,
  description: pageSet.description,
  pageCount: pageSet.content.pages.length,
  archivedAt: null as Date | null,
  contentHash: pageSet.contentHash,
  content: pageSet.content,
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

// A page id as the editor makes them: p_ and 20 hex characters
const newPageId = () => `p_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

// Design page sets: reusable page structures (names, sizes, literal
// backgrounds, in order), of one organization (rows) or built in (code, the
// same everywhere, never changed by a route). Every member may create,
// change, archive, restore and use the organization's page sets: no role,
// plan or billing check. A page set is Page Set v1 only, checked by its
// parser (which checks every page as Design Document v1 does) and stored
// as canonical JSON with its hash. A new design can start from one (the
// server makes its blank pages); the editor adds one to a draft by copying
// its pages. Nothing here touches an existing design, a template, a Brand
// Kit, Media or a render, and a change to a page set reaches no design that
// used it before
@Injectable()
export class ContentStudioDesignPageSetService {
  constructor(
    private _contentStudioDesignPageSetRepository: ContentStudioDesignPageSetRepository,
    private _contentStudioDesignService: ContentStudioDesignService
  ) {}

  // The built-in page sets (not when archived ones are asked for) and one
  // page of the organization's
  async listPageSets(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioDesignPageSetRepository.listPageSetsForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioDesignPageSetRepository.countPageSetsForOrganization(
        filter
      ),
    ]);
    return {
      system: input.archived
        ? []
        : listContentStudioSystemDesignPageSets().map(systemSummary),
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => this.pageSetDetail(row)),
    };
  }

  async createPageSet(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    description: unknown;
    content: unknown;
  }) {
    const name = plainText(
      input.name,
      DESIGN_PAGE_SET_NAME_MAX,
      true
    ) as string;
    const description = this.description(input.description);
    const content = this.parseContent(input.content);
    const row = await this._contentStudioDesignPageSetRepository.createPageSet({
      id: randomUUID(),
      organizationId: input.organizationId,
      name,
      description,
      createdById: input.userId,
      pageSet: storedContentStudioDesignPageSet(content),
    });
    return this.pageSetDetail(row);
  }

  // The name, the description and the pages of an active page set, in
  // place. Designs made from it before keep their own pages
  async updatePageSet(
    organizationId: string,
    id: string,
    input: { name: unknown; description: unknown; content: unknown }
  ) {
    const name = plainText(input.name, DESIGN_PAGE_SET_NAME_MAX, false);
    const description =
      input.description === undefined
        ? undefined
        : this.description(input.description);
    const content =
      input.content === undefined
        ? undefined
        : this.parseContent(input.content);
    if (
      name === undefined &&
      description === undefined &&
      content === undefined
    ) {
      throw invalidRequest();
    }
    const current = await this.getRow(organizationId, id);
    if (current.archivedAt) {
      throw pageSetArchived();
    }
    const { count } =
      await this._contentStudioDesignPageSetRepository.updatePageSet(
        organizationId,
        id,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(content
            ? { pageSet: storedContentStudioDesignPageSet(content) }
            : {}),
        }
      );
    const row = await this.getRow(organizationId, id);
    if (count === 0) {
      // archived meanwhile
      throw pageSetArchived();
    }
    return this.pageSetDetail(row);
  }

  // Archiving an archived page set (or restoring an active one) changes
  // nothing and returns it as it is
  async archivePageSet(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignPageSetRepository.archivePageSet(
      organizationId,
      id,
      new Date()
    );
    return this.pageSetDetail(await this.getRow(organizationId, id));
  }

  async restorePageSet(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignPageSetRepository.restorePageSet(
      organizationId,
      id
    );
    return this.pageSetDetail(await this.getRow(organizationId, id));
  }

  // A new ordinary design from one page set: a built-in by its id, or an
  // active one of the organization's, read back and verified. The server
  // makes its blank pages (new page ids, the set's names, sizes and
  // backgrounds, no layers, no Brand Kit); the design service then creates
  // the design and its revision 1 together, under the same checks as any
  // new design. The design holds nothing of the page set. A request that
  // also brings a document of its own is refused: the page set is the only
  // source of the pages
  async createDesignFromPageSet(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    pageSetId: unknown;
    content: unknown;
  }) {
    if (input.content !== undefined || typeof input.pageSetId !== 'string') {
      throw invalidRequest();
    }
    const content = await this.usablePageSet(
      input.organizationId,
      input.pageSetId
    );
    const taken = new Set<string>();
    const pages = instantiateContentStudioDesignPageSet(content, () => {
      let id = newPageId();
      while (taken.has(id)) {
        id = newPageId();
      }
      taken.add(id);
      return id;
    });
    return this._contentStudioDesignService.createDesign({
      organizationId: input.organizationId,
      userId: input.userId,
      name: input.name,
      content: { schemaVersion: 1, brandKit: null, pages },
    });
  }

  // The content of a page set a design may start from: a built-in, or an
  // active page set of the organization (an archived one is not used)
  private async usablePageSet(organizationId: string, id: string) {
    if (DESIGN_SYSTEM_PAGE_SET_ID.test(id)) {
      const system = getContentStudioSystemDesignPageSet(id);
      if (!system) {
        throw notFound();
      }
      return system.content;
    }
    const row = await this.getRow(organizationId, id);
    if (row.archivedAt) {
      throw pageSetArchived();
    }
    return this.pageSetDetail(row).content;
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioDesignPageSetContent(input);
    } catch (err) {
      if (err instanceof ContentStudioDesignPageSetError) {
        throw err.code === 'TOO_LARGE' ? pageSetTooLarge() : pageSetInvalid();
      }
      throw err;
    }
  }

  // Optional; empty is none
  private description(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }
    return plainText(value, DESIGN_PAGE_SET_DESCRIPTION_MAX, false) || null;
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    this.assertId(id);
    const row =
      await this._contentStudioDesignPageSetRepository.getPageSetForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // Built field by field: no organization or creator leaves. The stored
  // pages must still be exactly what was written
  private pageSetDetail(row: PageSetRow) {
    let content;
    try {
      content = parseVerifiedContentStudioDesignPageSet(row);
    } catch (err) {
      if (err instanceof ContentStudioDesignPageSetIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return {
      source: 'organization' as const,
      id: row.id,
      name: row.name,
      description: row.description,
      pageCount: content.pages.length,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      contentHash: row.contentHash,
      content,
    };
  }
}
