import { ContentStudioActivationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.activation.repository';

// No database: the Prisma delegates are mocked and the queries are read as
// they are sent. What counts for the first post (activation flow 01) is
// decided by these where clauses: the organization's own thread heads, not
// deleted, created since the first handoff

const ORG = '11111111-1111-4111-8111-111111111111';
const SINCE = new Date('2026-10-30T22:24:15.154Z');

const setup = () => {
  const post = {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
  };
  const handoff = { findFirst: jest.fn(async () => null) };
  const repository = new ContentStudioActivationRepository(
    { model: { contentStudioHandoff: handoff } } as never,
    { model: { post } } as never
  );
  return { repository, post };
};

describe('ContentStudioActivationRepository', () => {
  it('ACT2/ACT3 scheduled (QUEUE) or published only: a draft is never activation', async () => {
    const { repository, post } = setup();
    await repository.listPostStatesSince(ORG, SINCE);
    expect(post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          deletedAt: null,
          parentPostId: null,
          createdAt: { gte: SINCE },
          state: { in: ['QUEUE', 'PUBLISHED'] },
        },
      })
    );
  });

  it('SCHED-DATE1 the first post scheduled since the handoff, of this organization, with its planned date only', async () => {
    const { repository, post } = setup();
    await repository.getFirstScheduledSince(ORG, SINCE);
    expect(post.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        deletedAt: null,
        parentPostId: null,
        createdAt: { gte: SINCE },
        state: 'QUEUE',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { publishDate: true },
    });
  });

  it('ACT9/D1 the newest draft since the handoff, of this organization, with its planned date, group and save time only', async () => {
    const { repository, post } = setup();
    await repository.getLatestDraftSince(ORG, SINCE);
    expect(post.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        deletedAt: null,
        parentPostId: null,
        createdAt: { gte: SINCE },
        state: 'DRAFT',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { publishDate: true, group: true, createdAt: true },
    });
  });
});
