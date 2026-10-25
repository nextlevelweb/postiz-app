import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContentStudioFeedCaptureTrigger } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// What a capture's record shows: never the organization, the source or who
// asked
const ATTEMPT_SUMMARY = {
  id: true,
  trigger: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  attemptCount: true,
  errorCode: true,
  entriesSeen: true,
  entriesIgnored: true,
  entriesSkipped: true,
  entriesAccepted: true,
  sourcesCreated: true,
  versionsCreated: true,
  unchanged: true,
  failed: true,
  archived: true,
  entriesLimited: true,
  nextCaptureAtAfter: true,
  consecutiveFailuresAfter: true,
} as const;

// Newest first; id breaks ties so pages never overlap
const ATTEMPT_ORDER = [{ startedAt: 'desc' as const }, { id: 'desc' as const }];

// Feed captures (P8-O1): one row per capture, written by ingestion only (no
// route writes one). Every query filters on organizationId and sourceId
// itself, so a capture of another organization or feed reads exactly like a
// missing one. A row is created running and ended once; nothing deletes one
@Injectable()
export class ContentStudioSourceCaptureAttemptRepository {
  constructor(
    private _attempt: PrismaRepository<'contentStudioSourceCaptureAttempt'>
  ) {}

  // A capture that starts reading its feed. Its id is chosen by the caller,
  // so a try of the same scheduled capture finds its row: `resumed`, with its
  // start and status kept and the higher try count; `finished` when it has
  // already ended (nothing changes); `mismatch` for an id of another
  // organization, feed or trigger
  async beginFeedCaptureAttempt(input: {
    id: string;
    organizationId: string;
    sourceId: string;
    trigger: ContentStudioFeedCaptureTrigger;
    requestedByUserId: string | null;
    startedAt: Date;
    attemptCount: number;
  }) {
    try {
      await this._attempt.model.contentStudioSourceCaptureAttempt.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          sourceId: input.sourceId,
          trigger: input.trigger,
          status: 'running',
          requestedByUserId: input.requestedByUserId,
          startedAt: input.startedAt,
          attemptCount: input.attemptCount,
        },
        select: { id: true },
      });
      return { status: 'started' as const };
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
    }
    const existing =
      await this._attempt.model.contentStudioSourceCaptureAttempt.findFirst({
        where: {
          id: input.id,
          organizationId: input.organizationId,
          sourceId: input.sourceId,
        },
        select: { trigger: true, status: true },
      });
    if (!existing || existing.trigger !== input.trigger) {
      return { status: 'mismatch' as const };
    }
    if (existing.status !== 'running') {
      return { status: 'finished' as const };
    }
    // never lower: a try that started reading again after its row was written
    await this._attempt.model.contentStudioSourceCaptureAttempt.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        status: 'running',
        attemptCount: { lt: input.attemptCount },
      },
      data: {
        attemptCount: input.attemptCount,
      },
    });
    return { status: 'resumed' as const };
  }

  // The end of a capture that failed: once, from running only, so a retried
  // or late end never changes one that has ended. The feed's schedule as it
  // is now, read by the caller after the failure was handled
  finishFeedCaptureAttempt(input: {
    id: string;
    organizationId: string;
    sourceId: string;
    status: 'source_failed' | 'infrastructure_failed';
    errorCode: string | null;
    finishedAt: Date;
    nextCaptureAtAfter: Date | null;
    consecutiveFailuresAfter: number;
  }) {
    return this._attempt.model.contentStudioSourceCaptureAttempt.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        sourceId: input.sourceId,
        status: 'running',
      },
      data: {
        status: input.status,
        errorCode: input.errorCode,
        finishedAt: input.finishedAt,
        nextCaptureAtAfter: input.nextCaptureAtAfter,
        consecutiveFailuresAfter: input.consecutiveFailuresAfter,
      },
    });
  }

  listFeedCaptureAttempts(input: {
    organizationId: string;
    sourceId: string;
    skip: number;
    take: number;
  }) {
    return this._attempt.model.contentStudioSourceCaptureAttempt.findMany({
      where: {
        organizationId: input.organizationId,
        sourceId: input.sourceId,
      },
      orderBy: ATTEMPT_ORDER,
      select: ATTEMPT_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countFeedCaptureAttempts(organizationId: string, sourceId: string) {
    return this._attempt.model.contentStudioSourceCaptureAttempt.count({
      where: {
        organizationId,
        sourceId,
      },
    });
  }
}
