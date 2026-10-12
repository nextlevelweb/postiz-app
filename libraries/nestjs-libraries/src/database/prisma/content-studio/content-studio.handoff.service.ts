import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';
import {
  ContentStudioMediaService,
  ContentStudioMediaUnavailableError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import {
  ContentPackageRevisionIntegrityError,
  parseVerifiedContentPackageRevision,
} from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import { ContentPackageDraftV1 } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { contentStudioTextToComposerHtml } from '@gitroom/nestjs-libraries/content-studio/handoff.html';

export const CONTENT_STUDIO_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

// randomBytes(32) as hex: anything else can't be a handoff id
const HANDOFF_ID = /^[0-9a-f]{64}$/;

// Fixed messages only: never an id, path or content. A handoff of another
// organization or user is a plain 404, never a 403 (HttpForbiddenException
// would log the user out)
const notFound = () =>
  new HttpException(
    { msg: 'Content Studio item not found', code: 'CS_NOT_FOUND' },
    404
  );
const handoffGone = () =>
  new HttpException(
    {
      msg: 'This Content Studio handoff is no longer available',
      code: 'CS_HANDOFF_GONE',
    },
    410
  );
const storedHandoffInvalid = () =>
  new HttpException(
    {
      msg: 'Stored Content Studio handoff is invalid',
      code: 'CS_STORED_HANDOFF_INVALID',
    },
    500
  );
const storedRevisionInvalid = () =>
  new HttpException(
    {
      msg: 'Stored Content Studio revision is invalid',
      code: 'CS_STORED_REVISION_INVALID',
    },
    500
  );
// positions and reasons only, never Media ids or paths
const mediaUnavailable = (err: ContentStudioMediaUnavailableError) =>
  new HttpException(
    {
      msg: 'Content Studio media is unavailable',
      code: 'CS_MEDIA_UNAVAILABLE',
      items: err.items.map(({ itemIndex, mediaIndex, reason }) => ({
        itemIndex,
        mediaIndex,
        reason,
      })),
    },
    400
  );

interface HandoffRequest {
  organizationId: string;
  userId: string;
  handoffId: string;
}

// A handoff hands one frozen revision to the composer of the user who made
// it, for 24 hours. It can be opened again until it expires or is revoked.
// Nothing here creates posts or changes packages and revisions
@Injectable()
export class ContentStudioHandoffService {
  private readonly _logger = new Logger(ContentStudioHandoffService.name);

  constructor(
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioHandoffRepository: ContentStudioHandoffRepository,
    private _contentStudioMediaService: ContentStudioMediaService
  ) {}

  // Allowed for a revision of an archived package too: archiving stops
  // editing, not the use of history. Nothing is stored unless every Media of
  // the revision is ready
  async createHandoff(input: {
    organizationId: string;
    userId: string;
    packageId: string;
    revisionId: string;
  }) {
    const revision = await this.getVerifiedRevision(
      input.organizationId,
      input.packageId,
      input.revisionId
    );
    if (!revision) {
      throw notFound();
    }
    await this.resolveMedia(input.organizationId, revision.content);

    const now = new Date();
    return this._contentStudioHandoffRepository.createHandoff({
      id: randomBytes(32).toString('hex'),
      organizationId: input.organizationId,
      userId: input.userId,
      packageId: input.packageId,
      packageRevisionId: input.revisionId,
      expiresAt: new Date(now.getTime() + CONTENT_STUDIO_HANDOFF_TTL_MS),
    });
  }

  // The composer values of the frozen revision: never the current draft. The
  // Media are checked again, as they may have changed since the handoff was
  // made. Only a successful open is recorded
  async resolveHandoff(input: HandoffRequest) {
    const handoff = await this.getHandoff(input);
    const now = new Date();
    // only said to the user the handoff belongs to
    if (handoff.revokedAt || handoff.expiresAt.getTime() <= now.getTime()) {
      throw handoffGone();
    }

    const revision = await this.getVerifiedRevision(
      input.organizationId,
      handoff.packageId,
      handoff.packageRevisionId
    );
    if (!revision) {
      this._logger.error(
        `Content Studio handoff has no revision: ${handoff.id}`
      );
      throw storedHandoffInvalid();
    }
    const media = await this.resolveMedia(
      input.organizationId,
      revision.content
    );

    // The composer makes its own ids, so none are sent. Content always has
    // <p>, so the composer never takes its unescaped plain-text path
    const onlyValues = revision.content.copy.global.thread.map(
      (item, itemIndex) => ({
        content: contentStudioTextToComposerHtml(item.text),
        ...(media[itemIndex].length ? { image: media[itemIndex] } : {}),
      })
    );

    await this._contentStudioHandoffRepository.markOpenedIfNeeded({
      organizationId: input.organizationId,
      userId: input.userId,
      id: handoff.id,
      openedAt: now,
    });

    return {
      id: handoff.id,
      packageId: handoff.packageId,
      revisionId: handoff.packageRevisionId,
      revisionNumber: revision.revisionNumber,
      expiresAt: handoff.expiresAt,
      onlyValues,
    };
  }

  // Idempotent, and allowed after expiry: revoking only ever closes a handoff
  async revokeHandoff(input: HandoffRequest) {
    if (!HANDOFF_ID.test(input.handoffId)) {
      throw notFound();
    }
    const revoke = async (revokedAt: Date) => {
      const { count } =
        await this._contentStudioHandoffRepository.revokeHandoff({
          organizationId: input.organizationId,
          userId: input.userId,
          id: input.handoffId,
          revokedAt,
        });
      return count === 1;
    };

    const now = new Date();
    if (await revoke(now)) {
      return { id: input.handoffId, revokedAt: now };
    }
    const handoff = await this.getHandoff(input);
    if (handoff.revokedAt) {
      return { id: handoff.id, revokedAt: handoff.revokedAt };
    }
    // revokedAt is never cleared, so this only follows a concurrent change:
    // one more try
    if (await revoke(now)) {
      return { id: input.handoffId, revokedAt: now };
    }
    throw notFound();
  }

  // Malformed ids are refused before any query. Missing, foreign and another
  // user's handoffs are the same 404
  private async getHandoff(input: HandoffRequest) {
    if (!HANDOFF_ID.test(input.handoffId)) {
      throw notFound();
    }
    const handoff =
      await this._contentStudioHandoffRepository.getHandoffForOrganizationAndUser(
        {
          organizationId: input.organizationId,
          userId: input.userId,
          id: input.handoffId,
        }
      );
    if (!handoff) {
      throw notFound();
    }
    return handoff;
  }

  // One query scoped to organization, package and revision; null when there
  // is no such revision
  private async getVerifiedRevision(
    organizationId: string,
    packageId: string,
    revisionId: string
  ) {
    const row = await this._contentStudioRepository.getRevisionForPackage(
      organizationId,
      packageId,
      revisionId
    );
    if (!row) {
      return null;
    }
    try {
      return {
        revisionNumber: row.revisionNumber,
        content: parseVerifiedContentPackageRevision(row),
      };
    } catch (err) {
      if (err instanceof ContentPackageRevisionIntegrityError) {
        this._logger.error(
          `Stored Content Studio revision is invalid: ${row.id}`
        );
        throw storedRevisionInvalid();
      }
      throw err;
    }
  }

  // Ready Media only, per thread item and in order. Lookup failures are not
  // "unavailable" and propagate
  private async resolveMedia(
    organizationId: string,
    content: ContentPackageDraftV1
  ) {
    try {
      return await this._contentStudioMediaService.resolveForHandoff(
        organizationId,
        content
      );
    } catch (err) {
      if (err instanceof ContentStudioMediaUnavailableError) {
        throw mediaUnavailable(err);
      }
      throw err;
    }
  }
}
