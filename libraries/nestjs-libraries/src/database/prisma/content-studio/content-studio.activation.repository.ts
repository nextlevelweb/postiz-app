import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { CreationMethod, State } from '@prisma/client';

// What the first post (activation flow 01) needs to know about what happened
// to it outside Content Studio, read only: when it first went to the
// composer, and whether a post was scheduled or published since. Every query
// filters on organizationId itself; nothing is written here.
// A handoff opens in the Postiz composer, which creates posts as WEB, so only
// WEB posts can be the first post: one made by the public API, MCP, an
// autopost or a clipping never counts. A Post has no author and no link to
// the handoff, so other WEB posts made in the same window still count: a
// teammate's composer post, a draft from the post generator, a channel added
// to an older post
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

  // The first post the organization published since a moment (a thread
  // head, not deleted): only whether there is one
  getFirstPublishedSince(organizationId: string, since: Date) {
    return this._post.model.post.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        parentPostId: null,
        creationMethod: CreationMethod.WEB,
        createdAt: { gte: since },
        state: State.PUBLISHED,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
      },
    });
  }

  // The first post the organization scheduled since a moment (a thread
  // head, not deleted, still waiting to go out): when it is planned for
  getFirstScheduledSince(organizationId: string, since: Date) {
    return this._post.model.post.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        parentPostId: null,
        creationMethod: CreationMethod.WEB,
        createdAt: { gte: since },
        state: State.QUEUE,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        publishDate: true,
      },
    });
  }

  // The newest post the organization saved as a draft since a moment (a
  // thread head, not deleted): in the calendar, but not scheduled, so no
  // activation. Its planned date, its group (to open it again) and when it
  // was saved
  getLatestDraftSince(organizationId: string, since: Date) {
    return this._post.model.post.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        parentPostId: null,
        creationMethod: CreationMethod.WEB,
        createdAt: { gte: since },
        state: State.DRAFT,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        publishDate: true,
        group: true,
        createdAt: true,
      },
    });
  }
}
