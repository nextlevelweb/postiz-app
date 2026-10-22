import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContentStudioSourceVersionData } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

const SOURCE_SUMMARY = {
  id: true,
  kind: true,
  name: true,
  canonicalUrl: true,
  latestVersionNumber: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  lastCapturedAt: true,
} as const;

// Version lists, the current version and the compare-and-swap never load the
// content
const VERSION_SUMMARY = {
  id: true,
  versionNumber: true,
  schemaVersion: true,
  extractionVersion: true,
  requestedUrl: true,
  finalUrl: true,
  redirectCount: true,
  fetchedAt: true,
  httpStatus: true,
  contentType: true,
  contentLength: true,
  title: true,
  contentHash: true,
  sourceHash: true,
  createdAt: true,
} as const;

const VERSION_DETAIL = {
  ...VERSION_SUMMARY,
  content: true,
} as const;

export interface ContentStudioSourceListFilter {
  organizationId: string;
  archived: boolean;
  kind?: string;
  search?: string;
}

// Prisma's contains hands its text to PostgreSQL's (I)LIKE as it is, where
// % and _ are wildcards and \ escapes: escaped, a search is matched as the
// plain text it is
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, '\\$&');

// One where for a list page and its count. Without a kind or a search it is
// exactly the P3 one
const sourceListWhere = (
  input: ContentStudioSourceListFilter
): Prisma.ContentStudioSourceWhereInput => ({
  organizationId: input.organizationId,
  archivedAt: input.archived ? { not: null } : null,
  ...(input.kind ? { kind: input.kind } : {}),
  ...(input.search
    ? {
        OR: [
          {
            name: { contains: likeLiteral(input.search), mode: 'insensitive' },
          },
          {
            canonicalUrl: {
              contains: likeLiteral(input.search),
              mode: 'insensitive',
            },
          },
        ],
      }
    : {}),
});

// Every query filters on organizationId itself, so a source of another
// organization reads exactly like a missing one (null or count 0). An archived
// source is read-only until it is restored; its versions stay readable. The
// canonical URL is set once, at creation. Versions are only ever appended by
// the compare-and-swap, never updated or deleted, and nothing is deleted at
// all. This is what the code allows; PostgreSQL itself does not forbid an
// update of a version row
@Injectable()
export class ContentStudioSourceRepository {
  constructor(
    private _source: PrismaRepository<'contentStudioSource'>,
    private _version: PrismaRepository<'contentStudioSourceVersion'>,
    private _transaction: PrismaTransaction
  ) {}

  // Every kind unless one is named (P8-02); with a search (P8-03) only the
  // sources whose name or URL holds it, in any case
  listSourcesForOrganization(
    input: ContentStudioSourceListFilter & {
      skip: number;
      take: number;
    }
  ) {
    return this._source.model.contentStudioSource.findMany({
      where: sourceListWhere(input),
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: SOURCE_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countSourcesForOrganization(input: ContentStudioSourceListFilter) {
    return this._source.model.contentStudioSource.count({
      where: sourceListWhere(input),
    });
  }

  getSourceForOrganization(organizationId: string, id: string) {
    return this._source.model.contentStudioSource.findFirst({
      where: {
        id,
        organizationId,
      },
      select: SOURCE_SUMMARY,
    });
  }

  // What a capture needs, with who created the source: a scheduled feed
  // capture (P8-01) records its captures in the feed creator's name
  getSourceForCapture(organizationId: string, id: string) {
    return this._source.model.contentStudioSource.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        ...SOURCE_SUMMARY,
        createdById: true,
      },
    });
  }

  // Archived sources included: the URL stays taken until the source is gone,
  // which it never is
  getSourceByCanonicalUrlForOrganization(
    organizationId: string,
    canonicalUrl: string
  ) {
    return this._source.model.contentStudioSource.findFirst({
      where: {
        organizationId,
        canonicalUrl,
      },
      select: SOURCE_SUMMARY,
    });
  }

  // A new source has no version yet: ingestion appends the first one
  createSource(input: {
    id: string;
    organizationId: string;
    kind: string;
    name: string;
    canonicalUrl: string;
    createdById: string;
  }) {
    return this._source.model.contentStudioSource.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        kind: input.kind,
        name: input.name,
        canonicalUrl: input.canonicalUrl,
        latestVersionNumber: 0,
        createdById: input.createdById,
      },
      select: SOURCE_SUMMARY,
    });
  }

  // The name is the organization's label, not captured content: renaming
  // makes no version
  updateSourceName(organizationId: string, id: string, name: string) {
    return this._source.model.contentStudioSource.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: {
        name,
      },
    });
  }

  archiveSource(organizationId: string, id: string, archivedAt: Date) {
    return this._source.model.contentStudioSource.updateMany({
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

  restoreSource(organizationId: string, id: string) {
    return this._source.model.contentStudioSource.updateMany({
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

  // A feed that was just read (P8-01). Only a live feed: one archived during
  // the capture keeps what it had
  markFeedCaptured(organizationId: string, id: string, capturedAt: Date) {
    return this._source.model.contentStudioSource.updateMany({
      where: {
        id,
        organizationId,
        kind: 'feed',
        archivedAt: null,
      },
      data: {
        lastCapturedAt: capturedAt,
      },
    });
  }

  // For the feed capture schedule only (no route reaches it): live feeds of
  // every live organization not read since `capturedBefore`, one page after
  // `afterId` in id order, so a scan walks every feed once. Ids only
  listFeedsDueForCapture(input: {
    capturedBefore: Date;
    afterId: string | null;
    take: number;
  }) {
    return this._source.model.contentStudioSource.findMany({
      where: {
        kind: 'feed',
        archivedAt: null,
        ...(input.afterId ? { id: { gt: input.afterId } } : {}),
        OR: [
          { lastCapturedAt: null },
          { lastCapturedAt: { lt: input.capturedBefore } },
        ],
        organization: {
          deletedAt: null,
        },
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
        organizationId: true,
      },
      take: input.take,
    });
  }

  // For server-side ingestion only (no route reaches it): appends a capture
  // as the next version, in one transaction. The source must be live and
  // still at the version the ingestion started from. A capture is always a
  // new version, also when its blocks equal the previous ones: fetchedAt, the
  // final URL or sourceHash can differ, and a version records a capture, not
  // only a change. The update only matches the expected version number and
  // holds the source row until commit, so two captures can never take the same
  // number. Nothing is retried here
  appendVersionWithCompareAndSwap(input: {
    organizationId: string;
    sourceId: string;
    expectedLatestVersionNumber: number;
    versionId: string;
    version: ContentStudioSourceVersionData;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const source = await tx.contentStudioSource.findFirst({
        where: {
          id: input.sourceId,
          organizationId: input.organizationId,
        },
        select: {
          latestVersionNumber: true,
          archivedAt: true,
        },
      });
      if (!source) {
        return { status: 'not-found' as const };
      }
      if (source.archivedAt) {
        return { status: 'archived' as const };
      }
      if (source.latestVersionNumber !== input.expectedLatestVersionNumber) {
        return {
          status: 'conflict' as const,
          currentVersionNumber: source.latestVersionNumber,
        };
      }

      const { count } = await tx.contentStudioSource.updateMany({
        where: {
          id: input.sourceId,
          organizationId: input.organizationId,
          archivedAt: null,
          latestVersionNumber: input.expectedLatestVersionNumber,
        },
        data: {
          latestVersionNumber: {
            increment: 1,
          },
        },
      });
      if (count !== 1) {
        return { status: 'changed' as const };
      }

      const version = await tx.contentStudioSourceVersion.create({
        data: {
          id: input.versionId,
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          versionNumber: input.expectedLatestVersionNumber + 1,
          schemaVersion: input.version.schemaVersion,
          extractionVersion: input.version.extractionVersion,
          requestedUrl: input.version.requestedUrl,
          finalUrl: input.version.finalUrl,
          redirectCount: input.version.redirectCount,
          fetchedAt: input.version.fetchedAt,
          httpStatus: input.version.httpStatus,
          contentType: input.version.contentType,
          contentLength: input.version.contentLength,
          title: input.version.title,
          content: input.version.content,
          contentHash: input.version.contentHash,
          sourceHash: input.version.sourceHash,
          createdById: input.createdById,
        },
        select: VERSION_SUMMARY,
      });
      return { status: 'created' as const, version };
    });
  }

  // Summaries only, newest first: content is loaded one version at a time
  listVersionsForSource(input: {
    organizationId: string;
    sourceId: string;
    skip: number;
    take: number;
  }) {
    return this._version.model.contentStudioSourceVersion.findMany({
      where: {
        organizationId: input.organizationId,
        sourceId: input.sourceId,
      },
      orderBy: {
        versionNumber: 'desc',
      },
      select: VERSION_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countVersionsForSource(organizationId: string, sourceId: string) {
    return this._version.model.contentStudioSourceVersion.count({
      where: {
        organizationId,
        sourceId,
      },
    });
  }

  getVersionForSource(
    organizationId: string,
    sourceId: string,
    versionId: string
  ) {
    return this._version.model.contentStudioSourceVersion.findFirst({
      where: {
        id: versionId,
        sourceId,
        organizationId,
      },
      select: VERSION_DETAIL,
    });
  }

  // The metadata of one version, without its content
  getVersionByNumber(
    organizationId: string,
    sourceId: string,
    versionNumber: number
  ) {
    return this._version.model.contentStudioSourceVersion.findFirst({
      where: {
        organizationId,
        sourceId,
        versionNumber,
      },
      select: VERSION_SUMMARY,
    });
  }

  // The newest earlier version of the source that is not the same capture as
  // the given one (other blocks, title or extraction), metadata only
  // (P8-04A). Written as "any of them differs" so a null title is compared as
  // a value: in SQL `title <> 'x'` is never true for a null title
  getPreviousDifferentVersion(input: {
    organizationId: string;
    sourceId: string;
    versionNumber: number;
    contentHash: string;
    title: string | null;
    extractionVersion: string;
  }) {
    return this._version.model.contentStudioSourceVersion.findFirst({
      where: {
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        versionNumber: { lt: input.versionNumber },
        OR: [
          { contentHash: { not: input.contentHash } },
          { extractionVersion: { not: input.extractionVersion } },
          ...(input.title === null
            ? [{ title: { not: null } }]
            : [{ title: { not: input.title } }, { title: null }]),
        ],
      },
      orderBy: {
        versionNumber: 'desc',
      },
      select: VERSION_SUMMARY,
    });
  }

  // The first of a run of the same captures (P8-04A): the oldest version
  // before the given one that is the same capture, after `afterVersionNumber`
  // (the newest earlier different capture, or none). Read from the rows, so a
  // gap in the numbers changes nothing. Metadata only
  getFirstRepeatOfVersion(input: {
    organizationId: string;
    sourceId: string;
    versionNumber: number;
    afterVersionNumber: number | null;
    contentHash: string;
    title: string | null;
    extractionVersion: string;
  }) {
    return this._version.model.contentStudioSourceVersion.findFirst({
      where: {
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        versionNumber: {
          lt: input.versionNumber,
          ...(input.afterVersionNumber === null
            ? {}
            : { gt: input.afterVersionNumber }),
        },
        contentHash: input.contentHash,
        title: input.title,
        extractionVersion: input.extractionVersion,
      },
      orderBy: {
        versionNumber: 'asc',
      },
      select: {
        id: true,
        versionNumber: true,
        fetchedAt: true,
      },
    });
  }

  // The versions a package's grounding names, with their content, in one
  // query: only versions of this organization, by exact id. Never the latest
  // version of a source; of the source itself only its name
  getVersionsByIdsForOrganization(organizationId: string, ids: string[]) {
    return this._version.model.contentStudioSourceVersion.findMany({
      where: {
        organizationId,
        id: { in: ids },
      },
      select: {
        ...VERSION_DETAIL,
        sourceId: true,
        source: {
          select: {
            name: true,
          },
        },
      },
    });
  }

  // One version with its content, by number: what AI writing reads for a
  // selected source at its current version
  getVersionDetailByNumber(
    organizationId: string,
    sourceId: string,
    versionNumber: number
  ) {
    return this._version.model.contentStudioSourceVersion.findFirst({
      where: {
        organizationId,
        sourceId,
        versionNumber,
      },
      select: VERSION_DETAIL,
    });
  }
}
