import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { State } from '@prisma/client';

// What the first post (activation flow 01) needs to know about what happened
// to it outside Content Studio, read only: when it first went to the
// composer, and whether a post was scheduled or published since. Every query
// filters on organizationId itself; nothing is written here
@Injectable()
export class ContentStudioActivationRepository {
  constructor(
    private _handoff: PrismaRepository<'contentStudioHandoff'>,
    private _post: PrismaRepository<'post'>
  ) {}

  // the first handoff of the first post's package
  getFirstHandoffOfPackage(organizationId: string, packageId: string) {
    return this._handoff.model.contentStudioHandoff.findFirst({
      where: {
        organizationId,
        packageId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        createdAt: true,
      },
    });
  }

  // The states of the organization's posts created since a moment: scheduled
  // (QUEUE) or published, one row per state. Thread heads only; drafts,
  // failures and deleted posts never count
  listPostStatesSince(organizationId: string, since: Date) {
    return this._post.model.post.findMany({
      where: {
        organizationId,
        deletedAt: null,
        parentPostId: null,
        createdAt: { gte: since },
        state: { in: [State.QUEUE, State.PUBLISHED] },
      },
      distinct: ['state'],
      select: {
        state: true,
      },
    });
  }

  // The newest post the organization saved as a draft since a moment (a
  // thread head, not deleted): in the calendar, but not scheduled, so no
  // activation. Its planned date only
  getLatestDraftSince(organizationId: string, since: Date) {
    return this._post.model.post.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        parentPostId: null,
        createdAt: { gte: since },
        state: State.DRAFT,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        publishDate: true,
      },
    });
  }
}
