import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// What a feed listing shows of a page: its source summary, never its text
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
    },
  },
} as const;

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

  // Newest first sighting first; id breaks ties so pages never overlap
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
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'asc' }],
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
}
