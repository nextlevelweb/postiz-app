import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import {
  CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW,
  CONTENT_STUDIO_SOURCE_NAME_MAX,
  CONTENT_STUDIO_SOURCE_SEARCH_MAX,
  ContentStudioDiscoveryCaptureState,
  ContentStudioDiscoveryWindow,
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
import {
  compareContentStudioSourceVersions,
  ContentStudioComparedSourceVersion,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';

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
const searchInvalid = () =>
  new HttpException(
    { msg: 'The search is invalid.', code: 'CS_SOURCE_SEARCH_INVALID' },
    400
  );
const kindUnsupported = () =>
  new HttpException(
    {
      msg: 'This source type has no discoveries.',
      code: 'CS_SOURCE_KIND_UNSUPPORTED',
    },
    400
  );

const kindHasNoVersions = () =>
  new HttpException(
    {
      msg: 'This source type has no versions.',
      code: 'CS_SOURCE_KIND_UNSUPPORTED',
    },
    400
  );

// Source and version ids are Prisma uuid() values; anything else cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the page size of every Content Studio list
const PAGE_SIZE = 20;
// the pages a feed found, a longer list of small rows
const DISCOVERY_PAGE_SIZE = 50;
const HOUR = 60 * 60 * 1000;
// News Radar (P8-02): how far back a first sighting may be; 'all' is unbounded
const DISCOVERY_WINDOW_MS: Record<ContentStudioDiscoveryWindow, number | null> =
  {
    '24h': 24 * HOUR,
    '7d': 7 * 24 * HOUR,
    '30d': 30 * 24 * HOUR,
    all: null,
  };
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
  // feeds only (P8-01)
  lastCapturedAt?: Date | null;
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
  // a feed's last successful capture; null for a page source
  lastCapturedAt: row.lastCapturedAt ?? null,
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
    private _contentStudioSourceRepository: ContentStudioSourceRepository,
    private _contentStudioSourceDiscoveryRepository: ContentStudioSourceDiscoveryRepository
  ) {}

  async listSources(input: {
    organizationId: string;
    archived: boolean;
    kind?: string;
    search?: unknown;
    page: number;
  }) {
    const search = this.search(input.search);
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
      kind: input.kind,
      // without a search, exactly the P8-02 filter
      ...(search ? { search } : {}),
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
    return {
      ...toPublicContentStudioSourceVersion(row),
      content: this.intactContent(row),
    };
  }

  // What changed in one version of a page source (P8-04A). The server
  // chooses what it is compared with, the request names the version only:
  // the first capture of the newest earlier run of captures that is not the
  // same capture (blocks, title and extraction). So repeats a refresh added
  // are skipped both ways: v1 A, v2 A, v3 B compares v3 with v1, and v2 is a
  // repeat of v1 with no earlier change. The two versions compared are proven
  // to be what was stored before anything is compared; every other version is
  // matched by its stored blocks hash, title and extraction only, never read
  // or shown. Readable when the source is archived. Read only: nothing is
  // fetched, captured, stored or asked of an AI
  async getVersionChanges(input: {
    organizationId: string;
    sourceId: string;
    versionId: string;
  }) {
    this.assertId(input.sourceId);
    this.assertId(input.versionId);
    const source = await this.getRow(input.organizationId, input.sourceId);
    // a feed has no versions, whatever is stored for it
    if (source.kind !== 'url') {
      throw kindHasNoVersions();
    }
    const row = await this._contentStudioSourceRepository.getVersionForSource(
      input.organizationId,
      source.id,
      input.versionId
    );
    if (!row) {
      throw notFound();
    }
    const after = { ...row, content: this.intactContent(row) };

    // a version's run: the captures it repeats, back to the newest earlier
    // different capture
    const scope = {
      organizationId: input.organizationId,
      sourceId: source.id,
    };
    const capture = (version: {
      versionNumber: number;
      contentHash: string;
      title: string | null;
      extractionVersion: string;
    }) => ({
      ...scope,
      versionNumber: version.versionNumber,
      contentHash: version.contentHash,
      title: version.title,
      extractionVersion: version.extractionVersion,
    });
    const previous =
      await this._contentStudioSourceRepository.getPreviousDifferentVersion(
        capture(row)
      );
    const repeatOf =
      await this._contentStudioSourceRepository.getFirstRepeatOfVersion({
        ...capture(row),
        afterVersionNumber: previous ? previous.versionNumber : null,
      });
    let before:
      | (ContentStudioComparedSourceVersion & {
          id: string;
          versionNumber: number;
          fetchedAt: Date;
        })
      | null = null;
    if (previous) {
      const earlier =
        await this._contentStudioSourceRepository.getPreviousDifferentVersion(
          capture(previous)
        );
      const first =
        await this._contentStudioSourceRepository.getFirstRepeatOfVersion({
          ...capture(previous),
          afterVersionNumber: earlier ? earlier.versionNumber : null,
        });
      const baseline =
        await this._contentStudioSourceRepository.getVersionForSource(
          input.organizationId,
          source.id,
          (first ?? previous).id
        );
      if (!baseline) {
        throw integrityError();
      }
      before = { ...baseline, content: this.intactContent(baseline) };
    }

    const summary = (version: {
      id: string;
      versionNumber: number;
      fetchedAt: Date;
      title: string | null;
      extractionVersion: string;
    }) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      fetchedAt: version.fetchedAt,
      title: version.title,
      extractionVersion: version.extractionVersion,
    });
    const comparison = compareContentStudioSourceVersions(before, after);
    return {
      source: {
        id: source.id,
        name: source.name,
        canonicalUrl: source.canonicalUrl,
      },
      after: summary(row),
      before: before ? summary(before) : null,
      repeatOf: repeatOf
        ? {
            id: repeatOf.id,
            versionNumber: repeatOf.versionNumber,
            fetchedAt: repeatOf.fetchedAt,
          }
        : null,
      change: comparison.change,
      titleChanged: comparison.titleChanged,
      sameFetchedBytes: comparison.sameFetchedBytes,
      counts: comparison.counts,
      blocks: comparison.blocks,
    };
  }

  // The pages a feed source found (P8-01), newest first sighting first, with
  // their page source's summary and when this feed listed them. Read for a
  // feed only, archived or not. A row is used only once it proves to be what
  // a capture writes (this feed, a `url` source, both of this organization);
  // anything else is reported, never repaired or left out
  async listDiscoveries(input: {
    organizationId: string;
    sourceId: string;
    page: number;
  }) {
    const feed = await this.getRow(input.organizationId, input.sourceId);
    if (feed.kind === 'url') {
      throw kindUnsupported();
    }
    if (feed.kind !== 'feed') {
      throw integrityError();
    }
    const [rows, count] = await Promise.all([
      this._contentStudioSourceDiscoveryRepository.listDiscoveriesForFeed({
        organizationId: input.organizationId,
        feedSourceId: feed.id,
        skip: (input.page - 1) * DISCOVERY_PAGE_SIZE,
        take: DISCOVERY_PAGE_SIZE,
      }),
      this._contentStudioSourceDiscoveryRepository.countDiscoveriesForFeed(
        input.organizationId,
        feed.id
      ),
    ]);
    return {
      pages: Math.ceil(count / DISCOVERY_PAGE_SIZE),
      total: count,
      results: rows.map((row) => {
        if (row.feedSourceId !== feed.id) {
          throw integrityError();
        }
        return this.toPublicDiscovery(input.organizationId, row);
      }),
    };
  }

  // News Radar (P8-02): one page of what the organization's live feeds found,
  // one row per feed and page (a page two feeds found is two rows), newest
  // first sighting first. Read only. A named feed must be a feed of the
  // organization; an archived one has nothing here. Every row is checked as
  // it is read, and one that is not what a capture writes fails the request
  async listOrganizationDiscoveries(input: {
    organizationId: string;
    page: number;
    since?: ContentStudioDiscoveryWindow;
    feedSourceId?: string;
    captureState?: ContentStudioDiscoveryCaptureState;
  }) {
    if (input.feedSourceId !== undefined) {
      const feed = await this.getRow(input.organizationId, input.feedSourceId);
      if (feed.kind === 'url') {
        throw kindUnsupported();
      }
      if (feed.kind !== 'feed') {
        throw integrityError();
      }
    }
    const window =
      DISCOVERY_WINDOW_MS[
        input.since ?? CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW
      ];
    const filter = {
      organizationId: input.organizationId,
      seenSince: window === null ? null : new Date(Date.now() - window),
      feedSourceId: input.feedSourceId ?? null,
      captureState: input.captureState ?? null,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioSourceDiscoveryRepository.listDiscoveriesForOrganization(
        {
          ...filter,
          skip: (input.page - 1) * DISCOVERY_PAGE_SIZE,
          take: DISCOVERY_PAGE_SIZE,
        }
      ),
      this._contentStudioSourceDiscoveryRepository.countDiscoveriesForOrganization(
        filter
      ),
    ]);
    return {
      pages: Math.ceil(count / DISCOVERY_PAGE_SIZE),
      total: count,
      results: rows.map((row) => {
        const feed = row.feedSource;
        if (
          !feed ||
          feed.id !== row.feedSourceId ||
          feed.organizationId !== input.organizationId ||
          feed.kind !== 'feed' ||
          feed.archivedAt !== null ||
          (filter.feedSourceId !== null && feed.id !== filter.feedSourceId)
        ) {
          throw integrityError();
        }
        return {
          ...this.toPublicDiscovery(input.organizationId, row),
          feed: { id: feed.id, name: feed.name },
        };
      }),
    };
  }

  // Trimmed; blank is none. Plain text matched as it is: never a pattern
  private search(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (
      typeof value !== 'string' ||
      value.length > CONTENT_STUDIO_SOURCE_SEARCH_MAX ||
      value.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(value)
    ) {
      throw searchInvalid();
    }
    return value.trim() || undefined;
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

  // A discovery as a capture writes it, or an integrity error: of the
  // organization, a url page (archived or not) with its URL, last seen at or
  // after first seen. Built field by field: no organization, feed id, entry
  // id or page text
  private toPublicDiscovery(
    organizationId: string,
    row: {
      id: string;
      organizationId: string;
      entryTitle: string | null;
      publishedAt: Date | null;
      firstSeenAt: Date;
      lastSeenAt: Date;
      discoveredSource: {
        id: string;
        organizationId: string;
        kind: string;
        name: string;
        canonicalUrl: string | null;
        latestVersionNumber: number;
        archivedAt: Date | null;
      } | null;
    }
  ) {
    const page = row.discoveredSource;
    if (
      row.organizationId !== organizationId ||
      !page ||
      page.organizationId !== organizationId ||
      page.kind !== 'url' ||
      !page.canonicalUrl ||
      !(row.firstSeenAt instanceof Date) ||
      !(row.lastSeenAt instanceof Date) ||
      row.lastSeenAt < row.firstSeenAt
    ) {
      throw integrityError();
    }
    return {
      id: row.id,
      entryTitle: row.entryTitle,
      publishedAt: row.publishedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      source: {
        id: page.id,
        name: page.name,
        canonicalUrl: page.canonicalUrl,
        latestVersionNumber: page.latestVersionNumber,
        archivedAt: page.archivedAt,
      },
    };
  }

  // A stored version's blocks, proven to be exactly what was written; anything
  // else is reported, never repaired, and never quoted
  private intactContent(row: {
    schemaVersion: number;
    content: string;
    contentHash: string;
  }) {
    try {
      return parseVerifiedContentStudioSourceVersion(row);
    } catch (err) {
      if (err instanceof ContentStudioSourceIntegrityError) {
        throw integrityError();
      }
      throw err;
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
