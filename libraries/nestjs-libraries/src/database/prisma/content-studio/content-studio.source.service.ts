import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import {
  CONTENT_STUDIO_SOURCE_NAME_MAX,
  isContentStudioSourceKind,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  canonicalContentStudioSourceUrl,
  ContentStudioSourceUrlError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.url';
import {
  ContentStudioSourceIntegrityError,
  parseVerifiedContentStudioSourceVersion,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

// Fixed messages only: never a URL, source text, id, zod or Prisma error. A
// source of another organization is a plain 404
const notFound = () =>
  new HttpException({ msg: 'Source not found.', code: 'CS_NOT_FOUND' }, 404);
const sourceInvalid = () =>
  new HttpException(
    { msg: 'The source is invalid.', code: 'CS_SOURCE_INVALID' },
    400
  );
const urlInvalid = () =>
  new HttpException(
    { msg: 'The source URL is invalid.', code: 'CS_SOURCE_URL_INVALID' },
    400
  );
const alreadyExists = () =>
  new HttpException(
    { msg: 'This source already exists.', code: 'CS_SOURCE_ALREADY_EXISTS' },
    409
  );
const sourceArchived = () =>
  new HttpException(
    { msg: 'This source is archived.', code: 'CS_SOURCE_ARCHIVED' },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored source data could not be verified.',
      code: 'CS_SOURCE_INTEGRITY_ERROR',
    },
    500
  );

// Source and version ids are Prisma uuid() values; anything else cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the page size of every Content Studio list
const PAGE_SIZE = 20;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The same canonical URL created twice at once: the unique key stops the
// second one
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface SourceRow {
  id: string;
  kind: string;
  name: string;
  canonicalUrl: string | null;
  latestVersionNumber: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VersionRow {
  id: string;
  versionNumber: number;
  schemaVersion: number;
  extractionVersion: string;
  requestedUrl: string;
  finalUrl: string;
  redirectCount: number;
  fetchedAt: Date;
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  title: string | null;
  contentHash: string;
  sourceHash: string | null;
  createdAt: Date;
}

// Built field by field: no organization, creator or stored text leaves.
// Shared with source ingestion, so a refresh answers in the same shape
export const toPublicContentStudioSource = (row: SourceRow) => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  canonicalUrl: row.canonicalUrl,
  latestVersionNumber: row.latestVersionNumber,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toPublicContentStudioSourceVersion = (row: VersionRow) => ({
  id: row.id,
  versionNumber: row.versionNumber,
  schemaVersion: row.schemaVersion,
  extractionVersion: row.extractionVersion,
  requestedUrl: row.requestedUrl,
  finalUrl: row.finalUrl,
  redirectCount: row.redirectCount,
  fetchedAt: row.fetchedAt,
  httpStatus: row.httpStatus,
  contentType: row.contentType,
  contentLength: row.contentLength,
  title: row.title,
  contentHash: row.contentHash,
  sourceHash: row.sourceHash,
  createdAt: row.createdAt,
});

// Sources of an organization: pages it tracks, with their captured versions.
// A source is provenance, never a statement that its text is true. Every
// member may create, rename, archive and restore sources and read their
// versions: no role, plan or billing check. Nothing here fetches anything;
// versions are appended by server-side ingestion only, never from a request
@Injectable()
export class ContentStudioSourceService {
  constructor(
    private _contentStudioSourceRepository: ContentStudioSourceRepository
  ) {}

  async listSources(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioSourceRepository.listSourcesForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioSourceRepository.countSourcesForOrganization(filter),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(toPublicContentStudioSource),
    };
  }

  // A source starts without versions: nothing is fetched here. One canonical
  // URL is one source per organization, archived or not
  async createSource(input: {
    organizationId: string;
    userId: string;
    kind: unknown;
    name: unknown;
    url: unknown;
  }) {
    if (!isContentStudioSourceKind(input.kind)) {
      throw sourceInvalid();
    }
    const name = this.sourceName(input.name);
    const canonicalUrl = this.canonicalUrl(input.url);

    const existing =
      await this._contentStudioSourceRepository.getSourceByCanonicalUrlForOrganization(
        input.organizationId,
        canonicalUrl
      );
    if (existing) {
      throw alreadyExists();
    }
    try {
      return toPublicContentStudioSource(
        await this._contentStudioSourceRepository.createSource({
          id: randomUUID(),
          organizationId: input.organizationId,
          kind: input.kind,
          name,
          canonicalUrl,
          createdById: input.userId,
        })
      );
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw alreadyExists();
      }
      throw err;
    }
  }

  // An archived source stays readable. The current version is metadata only:
  // its blocks are read through the version itself
  async getSource(organizationId: string, id: string) {
    const source = await this.getRow(organizationId, id);
    if (source.latestVersionNumber === 0) {
      return { ...toPublicContentStudioSource(source), currentVersion: null };
    }
    const current =
      await this._contentStudioSourceRepository.getVersionByNumber(
        organizationId,
        source.id,
        source.latestVersionNumber
      );
    if (!current) {
      throw integrityError();
    }
    return {
      ...toPublicContentStudioSource(source),
      currentVersion: toPublicContentStudioSourceVersion(current),
    };
  }

  // Renames only: the URL is the source's identity and never changes. An
  // archived source is read-only until it is restored
  async renameSource(organizationId: string, id: string, rawName: unknown) {
    const name = this.sourceName(rawName);
    this.assertId(id);
    const { count } =
      await this._contentStudioSourceRepository.updateSourceName(
        organizationId,
        id,
        name
      );
    const source = await this.getRow(organizationId, id);
    if (count === 0) {
      throw sourceArchived();
    }
    return toPublicContentStudioSource(source);
  }

  // Archiving an archived source (or restoring an active one) changes nothing
  // and returns it as it is. Neither touches the versions
  async archiveSource(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioSourceRepository.archiveSource(
      organizationId,
      id,
      new Date()
    );
    return toPublicContentStudioSource(await this.getRow(organizationId, id));
  }

  async restoreSource(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioSourceRepository.restoreSource(organizationId, id);
    return toPublicContentStudioSource(await this.getRow(organizationId, id));
  }

  // History stays readable when the source is archived. Metadata only
  async listVersions(input: {
    organizationId: string;
    sourceId: string;
    page: number;
  }) {
    await this.getRow(input.organizationId, input.sourceId);
    const [rows, count] = await Promise.all([
      this._contentStudioSourceRepository.listVersionsForSource({
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioSourceRepository.countVersionsForSource(
        input.organizationId,
        input.sourceId
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(toPublicContentStudioSourceVersion),
    };
  }

  // One version with its blocks, after proving they are still exactly what
  // was stored. Anything else is reported, never repaired, and never quoted
  async getVersion(input: {
    organizationId: string;
    sourceId: string;
    versionId: string;
  }) {
    this.assertId(input.sourceId);
    this.assertId(input.versionId);
    const row = await this._contentStudioSourceRepository.getVersionForSource(
      input.organizationId,
      input.sourceId,
      input.versionId
    );
    if (!row) {
      throw notFound();
    }
    let content;
    try {
      content = parseVerifiedContentStudioSourceVersion(row);
    } catch (err) {
      if (err instanceof ContentStudioSourceIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return { ...toPublicContentStudioSourceVersion(row), content };
  }

  // Trimmed, 1-200 characters, no NUL or unpaired surrogate
  private sourceName(name: unknown) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (
      !trimmed ||
      trimmed.length > CONTENT_STUDIO_SOURCE_NAME_MAX ||
      trimmed.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(trimmed)
    ) {
      throw sourceInvalid();
    }
    return trimmed;
  }

  private canonicalUrl(url: unknown) {
    try {
      return canonicalContentStudioSourceUrl(url);
    } catch (err) {
      if (err instanceof ContentStudioSourceUrlError) {
        throw urlInvalid();
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
      await this._contentStudioSourceRepository.getSourceForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }
}
