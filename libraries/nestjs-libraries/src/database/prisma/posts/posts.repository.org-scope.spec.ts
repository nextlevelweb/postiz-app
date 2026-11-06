import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';

// Review 20 (M5): every write createOrUpdatePost makes is bound to the
// organization of the request. The PostgreSQL proof is
// posts.org-scope.postgres.integration.spec.ts; this pins the queries
const ORG = 'org-a';

const setup = () => {
  const post = {
    upsert: jest.fn(async (input: any) => ({
      id: input.where.id,
      organizationId: ORG,
    })),
    findFirst: jest.fn(async () => null),
    updateMany: jest.fn(async () => ({ count: 0 })),
    update: jest.fn(),
  };
  const tagsPosts = { deleteMany: jest.fn(async () => ({ count: 0 })) };
  const repo = (model: string, methods: unknown) =>
    ({ model: { [model]: methods } } as any);
  const repository = new PostsRepository(
    repo('post', post),
    repo('popularPosts', {}),
    repo('comments', {}),
    repo('tags', { findMany: jest.fn(async () => []) }),
    repo('tagsPosts', tagsPosts),
    repo('errors', {})
  );
  return { post, repository };
};

const save = (
  repository: PostsRepository,
  ids: Array<string | undefined>,
  group: string | undefined,
  keepGroup: boolean
) =>
  repository.createOrUpdatePost(
    'schedule',
    ORG,
    '2027-03-01T10:00:00.000Z',
    {
      integration: { id: 'integration-a' },
      value: ids.map((id) => ({ id, content: 'text', image: [] })),
      group,
      settings: { __type: 'x' },
    } as any,
    [],
    'API',
    undefined,
    keepGroup
  );

describe('PostsRepository.createOrUpdatePost organization scope', () => {
  it('PS1 updates by id only within the organization, for the post and every comment', async () => {
    const { post, repository } = setup();
    await save(repository, ['given-1', undefined, 'given-3'], undefined, false);
    expect(post.upsert).toHaveBeenCalledTimes(3);
    for (const [input] of post.upsert.mock.calls as any[]) {
      expect(input.where).toEqual({
        id: expect.any(String),
        organizationId: ORG,
      });
      // the create branch never takes the given id
      expect(input.create.id).toBeUndefined();
      expect(input.create.organization).toEqual({ connect: { id: ORG } });
    }
    expect(
      (post.upsert.mock.calls as any[]).map(([input]) => input.where.id)
    ).toEqual(['given-1', expect.any(String), 'given-3']);
  });

  it('PS2 finds the previous post and sweeps a group only within the organization', async () => {
    for (const keepGroup of [false, true]) {
      const { post, repository } = setup();
      await save(repository, ['given-1'], 'group-1', keepGroup);
      expect((post.findFirst.mock.calls as any[])[0][0].where).toMatchObject({
        organizationId: ORG,
        group: 'group-1',
      });
      expect(post.updateMany).toHaveBeenCalledTimes(1);
      expect((post.updateMany.mock.calls as any[])[0][0].where).toMatchObject({
        organizationId: ORG,
        group: 'group-1',
        deletedAt: null,
      });
    }
  });
});
