import { ContentStudioActivationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.activation.repository';

// No database: the Prisma delegates are mocked and the queries are read as
// they are sent. What counts for the first post (activation flow 01) is
// decided by these where clauses: the organization's own thread heads made in
// the Postiz composer (WEB), not deleted, created since the first handoff.
// Each asks for one row at most (findFirst), never a list of every post

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
  it('PERF1/ATTR4/ATTR6 published: one row at most, its id only, of this organization, made in the composer', async () => {
    const { repository, post } = setup();
    await repository.getFirstPublishedSince(ORG, SINCE);
    expect(post.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        deletedAt: null,
        parentPostId: null,
        creationMethod: 'WEB',
        createdAt: { gte: SINCE },
        state: 'PUBLISHED',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  });

  it('PERF6 nothing in the activation path lists posts or uses distinct', async () => {
    const { repository, post } = setup();
    await repository.getFirstPublishedSince(ORG, SINCE);
    await repository.getFirstScheduledSince(ORG, SINCE);
    await repository.getLatestDraftSince(ORG, SINCE);
    expect(post.findMany).not.toHaveBeenCalled();
    for (const [query] of post.findFirst.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >) {
      expect(query).not.toHaveProperty('distinct');
    }
  });

  it('ATTR8 every post query is scoped to the organization asked for', async () => {
    const { repository, post } = setup();
    const OTHER = '22222222-2222-4222-8222-222222222222';
    await repository.getFirstPublishedSince(OTHER, SINCE);
    await repository.getFirstScheduledSince(OTHER, SINCE);
    await repository.getLatestDraftSince(OTHER, SINCE);
    for (const [query] of post.findFirst.mock.calls as unknown as Array<
      [{ where: { organizationId: string } }]
    >) {
      expect(query.where.organizationId).toBe(OTHER);
    }
  });

  it('PERF2/PERF3/SCHED-DATE1/ATTR3/ATTR6 the first post scheduled since the handoff, of this organization, made in the composer, with its planned date only, oldest first', async () => {
    const { repository, post } = setup();
    await repository.getFirstScheduledSince(ORG, SINCE);
    expect(post.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        deletedAt: null,
        parentPostId: null,
        creationMethod: 'WEB',
        createdAt: { gte: SINCE },
        state: 'QUEUE',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { publishDate: true },
    });
  });

  it('PERF4/ACT9/D1/ATTR2/ATTR6 the newest draft since the handoff, of this organization, made in the composer, with its planned date, group and save time only', async () => {
    const { repository, post } = setup();
    await repository.getLatestDraftSince(ORG, SINCE);
    expect(post.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        deletedAt: null,
        parentPostId: null,
        creationMethod: 'WEB',
        createdAt: { gte: SINCE },
        state: 'DRAFT',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { publishDate: true, group: true, createdAt: true },
    });
  });
});
