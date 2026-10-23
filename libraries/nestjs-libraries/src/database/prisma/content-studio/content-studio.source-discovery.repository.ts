import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContentStudioDiscoveryCaptureState } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// What a feed listing shows of a page: its source summary, never its text.
// With the two times of the page's last change (P8-04B2) that say whether
// it changed since this feed found it, read with the page in the same query
const DISCOVERY_SUMMARY = {
  id: true,
  organizationId: true,
  feedSourceId: true,
  entryTitle: true,
  publishedAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
  discoveredSource: {
    select: {
      id: true,
      organizationId: true,
      kind: true,
      name: true,
      canonicalUrl: true,
      latestVersionNumber: true,
      archivedAt: true,
      lastPageChangeAt: true,
      lastPageChangePreviousCaptureAt: true,
    },
  },
} as const;

// News Radar (P8-02): a discovery with the feed that found it, by name
const RADAR_DISCOVERY_SUMMARY = {
  ...DISCOVERY_SUMMARY,
  feedSource: {
    select: {
      id: true,
      organizationId: true,
      kind: true,
      name: true,
      archivedAt: true,
    },
  },
} as const;

// Newest first sighting first. One capture sees all its pages at once, so
// the feed's dates order a capture's pages (undated last); id breaks the
// remaining ties so pages never overlap
const DISCOVERY_ORDER = [
  { firstSeenAt: 'desc' as const },
  { publishedAt: { sort: 'desc' as const, nulls: 'last' as const } },
  { id: 'asc' as const },
];

export interface ContentStudioRadarFilter {
  organizationId: string;
  seenSince: Date | null;
  feedSourceId: string | null;
  captureState: ContentStudioDiscoveryCaptureState | null;
}

const radarWhere = (
  input: ContentStudioRadarFilter
): Prisma.ContentStudioSourceDiscoveryWhereInput => ({
  organizationId: input.organizationId,
  ...(input.seenSince ? { firstSeenAt: { gte: input.seenSince } } : {}),
  ...(input.feedSourceId ? { feedSourceId: input.feedSourceId } : {}),
  feedSource: { archivedAt: null },
  ...(input.captureState === 'captured'
    ? { discoveredSource: { latestVersionNumber: { gte: 1 } } }
    : input.captureState === 'not-captured'
    ? { discoveredSource: { latestVersionNumber: 0 } }
    : {}),
});

// Discoveries (P8-01): that a feed source listed a page source of the same
// organization. Every query filters on organizationId itself. A discovery is
// written by server-side feed capture only, never from a request, and never
// deleted. The service checks the kinds of both sources; the composite keys
// keep them in the row's organization
@Injectable()
export class ContentStudioSourceDiscoveryRepository {
  constructor(
    private _discovery: PrismaRepository<'contentStudioSourceDiscovery'>
  ) {}

  // One sighting of a page in a feed at `seenAt`. The first one creates the
  // row (first and last seen at once); a later one moves lastSeenAt forward
  // and keeps the entry's metadata of that sighting. firstSeenAt never
  // changes, and lastSeenAt never moves back: an older capture finishing
  // after a newer one changes nothing. Two captures creating the same row
  // at once meet at the unique key, and the second one becomes a sighting
  async recordDiscovery(input: {
    organizationId: string;
    feedSourceId: string;
    discoveredSourceId: string;
    entryId: string | null;
    entryTitle: string | null;
    publishedAt: Date | null;
    seenAt: Date;
  }): Promise<'created' | 'seen'> {
    const sighting = () =>
      this._discovery.model.contentStudioSourceDiscovery.updateMany({
        where: {
          organizationId: input.organizationId,
          feedSourceId: input.feedSourceId,
          discoveredSourceId: input.discoveredSourceId,
          lastSeenAt: { lt: input.seenAt },
        },
        data: {
          lastSeenAt: input.seenAt,
          entryId: input.entryId,
          entryTitle: input.entryTitle,
          publishedAt: input.publishedAt,
        },
      });

    if ((await sighting()).count) {
      return 'seen';
    }
    try {
      await this._discovery.model.contentStudioSourceDiscovery.create({
        data: {
          organizationId: input.organizationId,
          feedSourceId: input.feedSourceId,
          discoveredSourceId: input.discoveredSourceId,
          entryId: input.entryId,
          entryTitle: input.entryTitle,
          publishedAt: input.publishedAt,
          firstSeenAt: input.seenAt,
          lastSeenAt: input.seenAt,
        },
        select: { id: true },
      });
      return 'created';
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      // the row exists: created at the same time, or already seen at or
      // after `seenAt`
      await sighting();
      return 'seen';
    }
  }

  listDiscoveriesForFeed(input: {
    organizationId: string;
    feedSourceId: string;
    skip: number;
    take: number;
  }) {
    return this._discovery.model.contentStudioSourceDiscovery.findMany({
      where: {
        organizationId: input.organizationId,
        feedSourceId: input.feedSourceId,
      },
      orderBy: DISCOVERY_ORDER,
      select: DISCOVERY_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countDiscoveriesForFeed(organizationId: string, feedSourceId: string) {
    return this._discovery.model.contentStudioSourceDiscovery.count({
      where: {
        organizationId,
        feedSourceId,
      },
    });
  }

  // News Radar (P8-02): what the organization's live feeds found, read only.
  // The list and its count share one filter: a first sighting at or after
  // `seenSince` (any time when null), one feed when named, and a page with or
  // without a version when asked. A discovery of an archived feed is never
  // part of it; an archived page is
  listDiscoveriesForOrganization(
    input: ContentStudioRadarFilter & {
      skip: number;
      take: number;
    }
  ) {
    return this._discovery.model.contentStudioSourceDiscovery.findMany({
      where: radarWhere(input),
      orderBy: DISCOVERY_ORDER,
      select: RADAR_DISCOVERY_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countDiscoveriesForOrganization(input: ContentStudioRadarFilter) {
    return this._discovery.model.contentStudioSourceDiscovery.count({
      where: radarWhere(input),
    });
  }
}
