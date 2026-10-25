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
  contentStudioFeedIntervals,
  contentStudioSourceLimits,
  effectiveFeedIntervalMinutes,
  isContentStudioSourceKind,
  nextCaptureAfterSuccess,
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
  classifyContentStudioSourceCaptureTransition,
  compareContentStudioSourceVersions,
  ContentStudioComparedSourceVersion,
  isContentStudioSourcePageChange,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import { ContentStudioSourcePageChangeData } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';

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
// The organization's technical limits (P8-C1): what it has stays as it is
const feedLimit = () =>
  new HttpException(
    {
      msg: 'The organization has too many active feeds.',
      code: 'CS_SOURCE_FEED_LIMIT',
    },
    409
  );
const sourceLimit = () =>
  new HttpException(
    {
      msg: 'The organization has too many sources.',
      code: 'CS_SOURCE_LIMIT',
    },
    409
  );
// concurrent changes of the organization's sources won every attempt
const sourcesConflict = () =>
  new HttpException(
    {
      msg: 'The sources changed meanwhile. Try again.',
      code: 'CS_SOURCE_CONFLICT',
    },
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

// only a feed has scheduled captures to pause (P8-C3)
const kindNotScheduled = () =>
  new HttpException(
    {
      msg: 'This source type has no scheduled captures.',
      code: 'CS_SOURCE_KIND_UNSUPPORTED',
    },
    400
  );

// a preset the organization may not choose, or no preset at all (P8-C4)
const intervalInvalid = () =>
  new HttpException(
    {
      msg: 'This capture interval is not available.',
      code: 'CS_SOURCE_INTERVAL_INVALID',
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
// The page-change backfill (P8-04B1): sources per page, versions per read,
// and how often one source is read again after a capture or rename raced it
const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_VERSIONS_PAGE_SIZE = 1000;
const BACKFILL_ATTEMPTS = 3;
// How often a feed's interval is decided again when a capture ended between
// its read and its write (P8-C4)
const FEED_INTERVAL_ATTEMPTS = 3;
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
  // feeds only (P8-C3)
  scanPausedAt?: Date | null;
  // feeds only (P8-C4)
  captureIntervalMinutes?: number | null;
  nextCaptureAt?: Date | null;
  consecutiveCaptureFailures?: number;
}

// A source's stored last page change (P8-04B1)
interface PageChangeRow {
  latestVersionNumber: number;
  lastPageChangeAt: Date | null;
  lastPageChangeVersionNumber: number | null;
  lastPageChangeKind: string | null;
  lastPageChangePreviousCaptureAt: Date | null;
}

// The stored fields as one value: null when all four are null, the change
// when all four are set and make sense (a page change, a later version than
// the first, at most the current one), undefined for anything else
const storedPageChange = (
  row: PageChangeRow
): ContentStudioSourcePageChangeData | null | undefined => {
  const fields = [
    row.lastPageChangeAt,
    row.lastPageChangeVersionNumber,
    row.lastPageChangeKind,
    row.lastPageChangePreviousCaptureAt,
  ];
  if (fields.every((field) => field === null)) {
    return null;
  }
  if (
    !(row.lastPageChangeAt instanceof Date) ||
    !(row.lastPageChangePreviousCaptureAt instanceof Date) ||
    !isContentStudioSourcePageChange(row.lastPageChangeKind) ||
    !Number.isInteger(row.lastPageChangeVersionNumber) ||
    row.lastPageChangeVersionNumber! < 2 ||
    row.lastPageChangeVersionNumber! > row.latestVersionNumber
  ) {
    return undefined;
  }
  return {
    at: row.lastPageChangeAt,
    versionNumber: row.lastPageChangeVersionNumber!,
    kind: row.lastPageChangeKind,
    previousCaptureAt: row.lastPageChangePreviousCaptureAt,
  };
};

const samePageChange = (
  a: ContentStudioSourcePageChangeData | null,
  b: ContentStudioSourcePageChangeData | null
) =>
  a === null || b === null
    ? a === b
    : a.at.getTime() === b.at.getTime() &&
      a.versionNumber === b.versionNumber &&
      a.kind === b.kind &&
      a.previousCaptureAt.getTime() === b.previousCaptureAt.getTime();

// Whether a page changed after a feed first listed it (P8-04B2), from the
// source's last page change: only when the capture that change was found
// against was made at or after the first sighting. The change time alone
// proves nothing: a feed's first sighting comes before the capture of the
// same run, and that capture may find a change against an older one. So the
// same page can have changed since one feed found it and not since another
export const isContentStudioDiscoveryChangedSinceFound = (input: {
  firstSeenAt: Date;
  lastPageChangeAt: Date | null;
  lastPageChangePreviousCaptureAt: Date | null;
}) =>
  input.lastPageChangeAt !== null &&
  input.lastPageChangePreviousCaptureAt !== null &&
  input.lastPageChangePreviousCaptureAt.getTime() >=
    input.firstSeenAt.getTime();

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
  // when a feed's scheduled captures were paused (P8-C3); null while they
  // run, and always for a page source
  scanPausedAt: row.scanPausedAt ?? null,
  // a feed's schedule (P8-C4): its preset (null for the default), the
  // earliest time of its next automatic capture (null: due now), and how
  // many scheduled captures failed in a row (0: none). null, null and 0 for
  // a page source
  captureIntervalMinutes: row.captureIntervalMinutes ?? null,
  nextCaptureAt: row.nextCaptureAt ?? null,
  consecutiveCaptureFailures: row.consecutiveCaptureFailures ?? 0,
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
// member may create, rename, archive and restore sources, pause and resume
// feeds, choose their interval, and read their versions: no role, plan or
// billing check. Nothing here fetches anything;
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
  // URL is one source per organization, archived or not: an existing one is
  // CS_SOURCE_ALREADY_EXISTS, whatever the limits. A new feed counts against
  // the organization's live feeds, a new page against all its pages
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
    const limits = contentStudioSourceLimits(input.organizationId);
    let result;
    try {
      result =
        await this._contentStudioSourceRepository.createSourcesWithinLimit({
          organizationId: input.organizationId,
          kind: input.kind,
          createdById: input.userId,
          limit:
            input.kind === 'feed'
              ? limits.activeFeedsMax
              : limits.urlSourcesMax,
          sources: [{ id: randomUUID(), name, canonicalUrl }],
        });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw alreadyExists();
      }
      throw err;
    }
    if (result.status === 'conflict') {
      throw sourcesConflict();
    }
    const [created] = result.results;
    switch (created.status) {
      case 'created':
        return toPublicContentStudioSource(created.source);
      case 'exists':
        throw alreadyExists();
      default:
        throw input.kind === 'feed' ? feedLimit() : sourceLimit();
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

  // A feed is restored only below the organization's live feed limit, and
  // stays archived otherwise; a page has no limit to restore
  async restoreSource(organizationId: string, id: string) {
    this.assertId(id);
    const result =
      await this._contentStudioSourceRepository.restoreSourceWithinLimit({
        organizationId,
        id,
        activeFeedsMax:
          contentStudioSourceLimits(organizationId).activeFeedsMax,
      });
    if (result.status === 'limit') {
      throw feedLimit();
    }
    if (result.status === 'conflict') {
      throw sourcesConflict();
    }
    return toPublicContentStudioSource(await this.getRow(organizationId, id));
  }

  // A paused feed (P8-C3) is not captured on the schedule: it stays live,
  // listed and counted against the live feed limit, keeps what it found, and
  // a member may still refresh it. Pausing a paused feed (or resuming a
  // running one) changes nothing and returns it as it is. An archived feed
  // is read-only, and a page has no schedule. Neither captures anything nor
  // touches the schedule (P8-C4): a resumed feed is due at its next capture
  // time, at the first scan after it when that time has passed
  async pauseFeed(organizationId: string, id: string) {
    const feed = await this.liveFeed(organizationId, id);
    if (!feed.scanPausedAt) {
      await this._contentStudioSourceRepository.pauseFeed(
        organizationId,
        id,
        new Date()
      );
    }
    return toPublicContentStudioSource(await this.liveFeed(organizationId, id));
  }

  async resumeFeed(organizationId: string, id: string) {
    const feed = await this.liveFeed(organizationId, id);
    if (feed.scanPausedAt) {
      await this._contentStudioSourceRepository.resumeFeed(organizationId, id);
    }
    return toPublicContentStudioSource(await this.liveFeed(organizationId, id));
  }

  // How often a live feed is captured automatically (P8-C4): a preset the
  // organization may choose, or null for the default. Paused or not; an
  // archived feed is read-only and a page has no schedule. The same value
  // again changes nothing. A healthy feed's next automatic capture follows
  // from its last capture and the new interval (at once when that time has
  // passed, or when it was never captured); after failures the failure delay
  // stays, and the next success uses the new interval. Nothing is captured
  // here. A capture that read the old interval and ends after this change
  // schedules its next capture with that interval once
  async setFeedInterval(
    organizationId: string,
    id: string,
    intervalMinutes: unknown
  ) {
    for (let attempt = 1; attempt <= FEED_INTERVAL_ATTEMPTS; attempt++) {
      const feed = await this.liveFeed(organizationId, id);
      const captureIntervalMinutes = this.feedInterval(
        organizationId,
        intervalMinutes
      );
      if ((feed.captureIntervalMinutes ?? null) === captureIntervalMinutes) {
        return toPublicContentStudioSource(feed);
      }
      const lastCapturedAt = feed.lastCapturedAt ?? null;
      const consecutiveCaptureFailures = feed.consecutiveCaptureFailures ?? 0;
      const { count } =
        await this._contentStudioSourceRepository.setFeedInterval({
          organizationId,
          id,
          captureIntervalMinutes,
          expected: { lastCapturedAt, consecutiveCaptureFailures },
          nextCaptureAt:
            consecutiveCaptureFailures > 0
              ? undefined
              : lastCapturedAt
              ? nextCaptureAfterSuccess(
                  lastCapturedAt,
                  effectiveFeedIntervalMinutes(captureIntervalMinutes)!
                )
              : null,
        });
      if (count === 1) {
        return toPublicContentStudioSource(
          await this.liveFeed(organizationId, id)
        );
      }
    }
    throw sourcesConflict();
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

  // Organization Changes (P8-04B1): one page of the organization's page
  // sources by their last page change, newest first, one row per source
  // (archived ones too: their change stays true). The fields are derived
  // from the versions; each row is checked as it is read, and its version is
  // found by number in one query and must be the very capture the source
  // names, or the request fails. Read only, nothing of the content
  async listPageChanges(input: {
    organizationId: string;
    page: number;
    since?: ContentStudioDiscoveryWindow;
  }) {
    const window =
      DISCOVERY_WINDOW_MS[
        input.since ?? CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW
      ];
    const filter = {
      organizationId: input.organizationId,
      changedSince: window === null ? null : new Date(Date.now() - window),
    };
    const [rows, count] = await Promise.all([
      this._contentStudioSourceRepository.listPageChangesForOrganization({
        ...filter,
        skip: (input.page - 1) * DISCOVERY_PAGE_SIZE,
        take: DISCOVERY_PAGE_SIZE,
      }),
      this._contentStudioSourceRepository.countPageChangesForOrganization(
        filter
      ),
    ]);
    const changes = rows.map((row) => {
      const change = storedPageChange(row);
      if (
        row.organizationId !== input.organizationId ||
        row.kind !== 'url' ||
        !change
      ) {
        throw integrityError();
      }
      return { row, change };
    });
    const versions = changes.length
      ? await this._contentStudioSourceRepository.getVersionsByNumbersForOrganization(
          input.organizationId,
          changes.map(({ row, change }) => ({
            sourceId: row.id,
            versionNumber: change.versionNumber,
          }))
        )
      : [];
    if (versions.length !== changes.length) {
      throw integrityError();
    }
    return {
      pages: Math.ceil(count / DISCOVERY_PAGE_SIZE),
      total: count,
      results: changes.map(({ row, change }) => {
        const found = versions.filter(
          (version) =>
            version.sourceId === row.id &&
            version.versionNumber === change.versionNumber
        );
        if (
          found.length !== 1 ||
          found[0].fetchedAt.getTime() !== change.at.getTime()
        ) {
          throw integrityError();
        }
        return {
          source: {
            id: row.id,
            name: row.name,
            canonicalUrl: row.canonicalUrl,
            archivedAt: row.archivedAt,
          },
          change: change.kind,
          changedAt: change.at,
          previousCaptureAt: change.previousCaptureAt,
          version: {
            id: found[0].id,
            versionNumber: found[0].versionNumber,
          },
        };
      }),
    };
  }

  // For the page-change backfill command only (no route reaches it): one
  // page of page sources of every organization, archived or not, after
  // `afterId`, each given the last page change its versions show, by the
  // rule captures follow. Only the stored blocks hash, title, extraction and
  // fetch time of the versions are read, in order, each compared with the
  // version before it that exists. A source already right is not written; a
  // wrong one is repaired, to none when it has no page change. Written only
  // while the source is as it was read, keeping its updatedAt; a source a
  // capture or rename raced is read again, and one whose versions do not end
  // at its current version is reported, never written. `next` is where the
  // following page starts, null after the last one
  async backfillPageChanges(input: { afterId: string | null }) {
    const sources =
      await this._contentStudioSourceRepository.listPageSourcesForBackfill({
        afterId:
          typeof input.afterId === 'string' && UUID.test(input.afterId)
            ? input.afterId
            : null,
        take: BACKFILL_PAGE_SIZE,
      });
    let updated = 0;
    let unchanged = 0;
    const failed: string[] = [];
    for (const source of sources) {
      const outcome = await this.backfillPageChange(source);
      if (outcome === 'updated') {
        updated += 1;
      } else if (outcome === 'unchanged') {
        unchanged += 1;
      } else {
        failed.push(source.id);
      }
    }
    return {
      next:
        sources.length === BACKFILL_PAGE_SIZE
          ? sources[sources.length - 1].id
          : null,
      updated,
      unchanged,
      failed,
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
  // after first seen, and the two times of its last page change both set or
  // both none. Built field by field: no organization, feed id, entry id or
  // page text. changedSinceFound (P8-04B2) is decided here, for this feed's
  // first sighting, from the stored times alone: no other read
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
        lastPageChangeAt: Date | null;
        lastPageChangePreviousCaptureAt: Date | null;
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
      row.lastSeenAt < row.firstSeenAt ||
      !(
        (page.lastPageChangeAt === null &&
          page.lastPageChangePreviousCaptureAt === null) ||
        (page.lastPageChangeAt instanceof Date &&
          page.lastPageChangePreviousCaptureAt instanceof Date)
      )
    ) {
      throw integrityError();
    }
    return {
      id: row.id,
      entryTitle: row.entryTitle,
      publishedAt: row.publishedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      changedSinceFound: isContentStudioDiscoveryChangedSinceFound({
        firstSeenAt: row.firstSeenAt,
        lastPageChangeAt: page.lastPageChangeAt,
        lastPageChangePreviousCaptureAt: page.lastPageChangePreviousCaptureAt,
      }),
      source: {
        id: page.id,
        name: page.name,
        canonicalUrl: page.canonicalUrl,
        latestVersionNumber: page.latestVersionNumber,
        archivedAt: page.archivedAt,
        lastPageChangeAt: page.lastPageChangeAt,
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

  // One source of the backfill, read again when a write finds it changed
  private async backfillPageChange(
    source: PageChangeRow & {
      id: string;
      organizationId: string;
      updatedAt: Date;
    }
  ): Promise<'updated' | 'unchanged' | 'failed'> {
    let row = source;
    for (let attempt = 0; attempt < BACKFILL_ATTEMPTS; attempt++) {
      const { pageChange, lastVersionNumber } = await this.lastPageChange(
        row.organizationId,
        row.id
      );
      if (lastVersionNumber === row.latestVersionNumber) {
        const stored = storedPageChange(row);
        if (stored !== undefined && samePageChange(stored, pageChange)) {
          return 'unchanged';
        }
        const { count } =
          await this._contentStudioSourceRepository.setPageChangeWithCompareAndSwap(
            {
              organizationId: row.organizationId,
              sourceId: row.id,
              expectedLatestVersionNumber: row.latestVersionNumber,
              expectedUpdatedAt: row.updatedAt,
              pageChange,
            }
          );
        if (count === 1) {
          return 'updated';
        }
      }
      // a capture, rename or archive went first, or the versions read do
      // not end at the source's current version
      const fresh =
        await this._contentStudioSourceRepository.getPageSourceForBackfill(
          row.organizationId,
          row.id
        );
      if (!fresh) {
        return 'failed';
      }
      row = fresh;
    }
    return 'failed';
  }

  // The last page change a source's versions show, and the number of the
  // last version read: every version from the first, each compared with the
  // one before it that exists (a gap in the numbers changes nothing)
  private async lastPageChange(organizationId: string, sourceId: string) {
    let previous: {
      versionNumber: number;
      contentHash: string;
      title: string | null;
      extractionVersion: string;
      fetchedAt: Date;
    } | null = null;
    let pageChange: ContentStudioSourcePageChangeData | null = null;
    for (;;) {
      const versions =
        await this._contentStudioSourceRepository.listVersionCapturesForBackfill(
          {
            organizationId,
            sourceId,
            afterVersionNumber: previous ? previous.versionNumber : 0,
            take: BACKFILL_VERSIONS_PAGE_SIZE,
          }
        );
      for (const version of versions) {
        const transition = classifyContentStudioSourceCaptureTransition(
          previous,
          version
        );
        if (previous && isContentStudioSourcePageChange(transition)) {
          pageChange = {
            at: version.fetchedAt,
            versionNumber: version.versionNumber,
            kind: transition,
            previousCaptureAt: previous.fetchedAt,
          };
        }
        previous = version;
      }
      if (versions.length < BACKFILL_VERSIONS_PAGE_SIZE) {
        return {
          pageChange,
          lastVersionNumber: previous ? previous.versionNumber : 0,
        };
      }
    }
  }

  // null (the default) or a preset of the organization, nothing else
  private feedInterval(organizationId: string, value: unknown) {
    if (value === null) {
      return null;
    }
    if (
      typeof value === 'number' &&
      (
        contentStudioFeedIntervals(organizationId) as readonly number[]
      ).includes(value)
    ) {
      return value;
    }
    throw intervalInvalid();
  }

  // A feed of the organization that is not archived: a feed archived
  // meanwhile is CS_SOURCE_ARCHIVED, also after a pause or resume
  private async liveFeed(organizationId: string, id: string) {
    const source = await this.getRow(organizationId, id);
    if (source.kind !== 'feed') {
      throw kindNotScheduled();
    }
    if (source.archivedAt) {
      throw sourceArchived();
    }
    return source;
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
