import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';
import {
  ContentStudioMediaService,
  ContentStudioMediaUnavailableError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import {
  ContentPackageRevisionIntegrityError,
  parseVerifiedContentPackageRevision,
} from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import { ContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { contentStudioTextToComposerHtml } from '@gitroom/nestjs-libraries/content-studio/handoff.html';
import { contentStudioHandoffApprovalAuthorization } from '@gitroom/nestjs-libraries/content-studio/review/review.approval';

export const CONTENT_STUDIO_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

// How often an approved handoff is tried when the approval changed between
// its check and the hold (P5-07): each try checks the approval again
const APPROVED_HANDOFF_ATTEMPTS = 3;

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
// The approval kept changing between its check and the hold: approved at
// every check, yet never the same history once held
const approvalChanged = () =>
  new HttpException(
    {
      msg: 'The approval of this revision changed. Try again.',
      code: 'CS_APPROVAL_CONFLICT',
    },
    409
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
// Nothing here creates posts or changes packages and revisions.
//
// Where the organization's current editorial policy requires it (P5-07), a
// revision is handed off only while exactly it is approved, as the one
// approval predicate (requireApprovedRevision, P5-05) judges it, and the
// handoff is written holding the revision's review, so no withdrawal can
// come between the check and the write. That is all the policy guards:
// creating a handoff. A handoff made while the revision was approved stays
// valid and can still be opened after a later withdrawal or refusal; only
// new handoffs are refused. The policy is read once per request, so a change
// of it applies from the next request on. Without the requirement nothing
// about approval is read and a handoff is made exactly as before.
//
// Every handoff keeps what authorized it when it was created (P5-08),
// written with it in the same statement and never changed: not required,
// or approved by that review's decision at that sequence about that hash
// (taken under the hold above). Opening a handoff says so, after checking
// that the stored history still has exactly that decision; it never asks
// whether the revision is approved now. A handoff made before this was
// recorded is LEGACY_UNKNOWN, never guessed from a policy or an approval
@Injectable()
export class ContentStudioHandoffService {
  private readonly _logger = new Logger(ContentStudioHandoffService.name);

  constructor(
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioHandoffRepository: ContentStudioHandoffRepository,
    private _contentStudioMediaService: ContentStudioMediaService,
    private _contentStudioEditorialPolicyService: ContentStudioEditorialPolicyService,
    private _contentStudioReviewService: ContentStudioReviewService
  ) {}

  // Allowed for a revision of an archived package too: archiving stops
  // editing, not the use of history. Nothing is stored unless every Media of
  // the revision is ready and, where the policy requires it, exactly this
  // revision is approved
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
    // the exact revision handed off, never its package or a newer one
    const target = {
      organizationId: input.organizationId,
      targetType: 'PACKAGE_REVISION' as const,
      targetRevisionId: input.revisionId,
    };
    // CS_APPROVAL_REQUIRED unless approved now; integrity errors as they are
    let approval =
      (await this._contentStudioEditorialPolicyService.isApprovalRequiredForHandoff(
        input.organizationId
      ))
        ? await this._contentStudioReviewService.requireApprovedRevision(target)
        : null;
    await this.resolveMedia(input.organizationId, revision.content);

    const now = new Date();
    const handoff = {
      id: randomBytes(32).toString('hex'),
      organizationId: input.organizationId,
      userId: input.userId,
      packageId: input.packageId,
      packageRevisionId: input.revisionId,
      expiresAt: new Date(now.getTime() + CONTENT_STUDIO_HANDOFF_TTL_MS),
    };
    if (!approval) {
      return this._contentStudioHandoffRepository.createHandoff(handoff);
    }
    for (let attempt = 1; ; attempt++) {
      const created =
        await this._contentStudioHandoffRepository.createHandoffWhileApproved({
          ...handoff,
          reviewId: approval.reviewId as string,
          approvalVersion: approval.approvalVersion,
        });
      if (created) {
        return created;
      }
      if (attempt === APPROVED_HANDOFF_ATTEMPTS) {
        throw approvalChanged();
      }
      // a decision came between the check and the hold: judged again, so a
      // withdrawal is CS_APPROVAL_REQUIRED
      approval = await this._contentStudioReviewService.requireApprovedRevision(
        target
      );
    }
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
    const approvalAuthorization = await this.verifiedAuthorization(
      input.organizationId,
      handoff
    );
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
      approvalAuthorization,
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

  // What authorized the handoff when it was created, whole, and checked by
  // the review service against the stored approval history (never the
  // approval of now). A partial record is a stored handoff that is not intact
  private async verifiedAuthorization(
    organizationId: string,
    handoff: { id: string; packageRevisionId: string } & Parameters<
      typeof contentStudioHandoffApprovalAuthorization
    >[0]
  ) {
    const authorization = contentStudioHandoffApprovalAuthorization(handoff);
    if (!authorization) {
      this._logger.error(
        `Content Studio handoff authorization is invalid: ${handoff.id}`
      );
      throw storedHandoffInvalid();
    }
    await this._contentStudioReviewService.verifyHandoffApprovalAuthorization({
      organizationId,
      packageRevisionId: handoff.packageRevisionId,
      authorization,
    });
    return authorization;
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
    content: ContentPackageDraft
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
