import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import {
  ContentStudioAudienceProfileError,
  parseContentStudioAudienceProfileContent,
  AUDIENCE_PROFILE_NAME_MAX,
} from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';
import {
  ContentStudioAudienceProfileIntegrityError,
  parseVerifiedContentStudioAudienceProfileRevision,
  storedContentStudioAudienceProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';

// Fixed messages only: never audience content, ids, zod or Prisma errors. A
// profile of another organization is a plain 404. The codes are the generic
// CS_PROFILE_* ones the other profile kinds will use too
const notFound = () =>
  new HttpException(
    { msg: 'Audience profile not found.', code: 'CS_NOT_FOUND' },
    404
  );
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const profileInvalid = () =>
  new HttpException(
    { msg: 'The audience profile is invalid.', code: 'CS_PROFILE_INVALID' },
    400
  );
const profileTooLarge = () =>
  new HttpException(
    { msg: 'The audience profile is too large.', code: 'CS_PROFILE_TOO_LARGE' },
    400
  );
const profileArchived = () =>
  new HttpException(
    { msg: 'This audience profile is archived.', code: 'CS_PROFILE_ARCHIVED' },
    409
  );
const revisionConflict = (currentRevisionNumber: number) =>
  new HttpException(
    {
      msg: 'The audience profile changed. Reload it and try again.',
      code: 'CS_PROFILE_REVISION_CONFLICT',
      currentRevisionNumber,
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored audience profile data could not be verified.',
      code: 'CS_PROFILE_INTEGRITY_ERROR',
    },
    500
  );

// Profile and revision ids are Prisma uuid() values; anything else cannot
// exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
// the page size of every Content Studio list
const PAGE_SIZE = 20;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Two saves took the same number: the compare-and-swap normally stops this
// first, so it is the same conflict
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface ProfileRow {
  id: string;
  name: string;
  latestRevisionNumber: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RevisionRow {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: Date;
}

// Built field by field: no organization, creator or stored text leaves
const profileSummary = (row: ProfileRow) => ({
  id: row.id,
  name: row.name,
  latestRevisionNumber: row.latestRevisionNumber,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const revisionSummary = (row: RevisionRow) => ({
  id: row.id,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  createdAt: row.createdAt,
});

// Audience Profiles of an organization: who its content is written for, as
// editorial context, never ad targeting or data about people. Every member may
// create, rename, revise, archive and restore them: no role, plan or billing
// check. The content is entered by hand; nothing here calls an AI provider or
// infers an audience
@Injectable()
export class ContentStudioAudienceProfileService {
  constructor(
    private _contentStudioAudienceProfileRepository: ContentStudioAudienceProfileRepository
  ) {}

  async listProfiles(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioAudienceProfileRepository.listProfilesForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioAudienceProfileRepository.countProfilesForOrganization(
        filter
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(profileSummary),
    };
  }

  // The profile and its first revision are created together
  async createProfile(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    content: unknown;
  }) {
    const name = this.profileName(input.name);
    const content = this.parseContent(input.content);
    const stored = storedContentStudioAudienceProfileContent(content);

    const { profile, revision } =
      await this._contentStudioAudienceProfileRepository.createProfileWithFirstRevision(
        {
          profileId: randomUUID(),
          revisionId: randomUUID(),
          organizationId: input.organizationId,
          name,
          createdById: input.userId,
          revision: stored,
        }
      );
    return {
      ...profileSummary(profile),
      currentRevision: { ...revisionSummary(revision), content },
    };
  }

  // An archived profile stays readable, with its current audience content
  async getProfile(organizationId: string, id: string) {
    const profile = await this.getRow(organizationId, id);
    const current =
      await this._contentStudioAudienceProfileRepository.getRevisionByNumber(
        organizationId,
        profile.id,
        profile.latestRevisionNumber
      );
    if (!current) {
      throw integrityError();
    }
    return {
      ...profileSummary(profile),
      currentRevision: this.revisionDetail(current),
    };
  }

  // Renames only: the audience content needs a revision. An archived profile is
  // read-only until it is restored
  async renameProfile(organizationId: string, id: string, rawName: unknown) {
    const name = this.profileName(rawName);
    this.assertId(id);
    const { count } =
      await this._contentStudioAudienceProfileRepository.updateProfileName(
        organizationId,
        id,
        name
      );
    const profile = await this.getRow(organizationId, id);
    if (count === 0) {
      throw profileArchived();
    }
    return profileSummary(profile);
  }

  // Archiving an archived profile (or restoring an active one) changes
  // nothing and returns it as it is. Neither touches the revisions
  async archiveProfile(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioAudienceProfileRepository.archiveProfile(
      organizationId,
      id,
      new Date()
    );
    return profileSummary(await this.getRow(organizationId, id));
  }

  async restoreProfile(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioAudienceProfileRepository.restoreProfile(
      organizationId,
      id
    );
    return profileSummary(await this.getRow(organizationId, id));
  }

  // Saves new audience content over the revision the editor started from.
  // Content equal to that revision returns it instead of a copy; a stale base
  // is a conflict even when the content is the same
  async createRevision(input: {
    organizationId: string;
    profileId: string;
    userId: string;
    baseRevisionNumber: unknown;
    content: unknown;
  }) {
    this.assertId(input.profileId);
    if (
      !Number.isSafeInteger(input.baseRevisionNumber) ||
      (input.baseRevisionNumber as number) < 1 ||
      (input.baseRevisionNumber as number) > INT4_MAX
    ) {
      throw invalidRequest();
    }
    const content = this.parseContent(input.content);
    const stored = storedContentStudioAudienceProfileContent(content);

    let result;
    try {
      result =
        await this._contentStudioAudienceProfileRepository.createRevisionWithCompareAndSwap(
          {
            organizationId: input.organizationId,
            profileId: input.profileId,
            expectedLatestRevisionNumber: input.baseRevisionNumber as number,
            revisionId: randomUUID(),
            revision: stored,
            createdById: input.userId,
          }
        );
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      result = { status: 'changed' as const };
    }

    switch (result.status) {
      case 'created':
        return {
          created: true,
          revision: { ...revisionSummary(result.revision), content },
        };
      case 'unchanged':
        return {
          created: false,
          revision: this.revisionDetail(result.revision),
        };
      case 'not-found':
        throw notFound();
      case 'archived':
        throw profileArchived();
      case 'conflict':
        throw revisionConflict(result.currentRevisionNumber);
      default: {
        // the profile moved on inside the transaction: tell why from now
        const profile = await this.getRow(
          input.organizationId,
          input.profileId
        );
        if (profile.archivedAt) {
          throw profileArchived();
        }
        throw revisionConflict(profile.latestRevisionNumber);
      }
    }
  }

  // History stays readable when the profile is archived
  async listRevisions(input: {
    organizationId: string;
    profileId: string;
    page: number;
  }) {
    await this.getRow(input.organizationId, input.profileId);
    const [rows, count] = await Promise.all([
      this._contentStudioAudienceProfileRepository.listRevisionsForProfile({
        organizationId: input.organizationId,
        profileId: input.profileId,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioAudienceProfileRepository.countRevisionsForProfile(
        input.organizationId,
        input.profileId
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(revisionSummary),
    };
  }

  async getRevision(input: {
    organizationId: string;
    profileId: string;
    revisionId: string;
  }) {
    this.assertId(input.profileId);
    this.assertId(input.revisionId);
    const row =
      await this._contentStudioAudienceProfileRepository.getRevisionForProfile(
        input.organizationId,
        input.profileId,
        input.revisionId
      );
    if (!row) {
      throw notFound();
    }
    return this.revisionDetail(row);
  }

  // Trimmed, 1-100 characters, no NUL or unpaired surrogate
  private profileName(name: unknown) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (
      !trimmed ||
      trimmed.length > AUDIENCE_PROFILE_NAME_MAX ||
      trimmed.includes('\u0000') ||
      UNPAIRED_SURROGATE.test(trimmed)
    ) {
      throw invalidRequest();
    }
    return trimmed;
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioAudienceProfileContent(input);
    } catch (err) {
      if (err instanceof ContentStudioAudienceProfileError) {
        throw err.code === 'TOO_LARGE' ? profileTooLarge() : profileInvalid();
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
      await this._contentStudioAudienceProfileRepository.getProfileForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // A revision must still be exactly what was stored; anything else is
  // reported, never repaired, and never quoted
  private revisionDetail(row: RevisionRow & { content: string }) {
    let content;
    try {
      content = parseVerifiedContentStudioAudienceProfileRevision(row);
    } catch (err) {
      if (err instanceof ContentStudioAudienceProfileIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return { ...revisionSummary(row), content };
  }
}
