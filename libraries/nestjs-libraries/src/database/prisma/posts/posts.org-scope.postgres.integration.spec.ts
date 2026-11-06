import { PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Review 20 (M5): a post is only ever updated or swept within the
// organization of the request. An id or group of another organization in a
// create or update body must leave that organization's posts exactly as
// they were; the id then behaves like an unknown one (a new post is made)

const ORG_A = '20520000-0000-4000-8000-00000000000a';
const ORG_B = '20520000-0000-4000-8000-00000000000b';
const ORGS = [ORG_A, ORG_B];
const INTEGRATION: Record<string, string> = {
  [ORG_A]: 'r20m5-integration-a',
  [ORG_B]: 'r20m5-integration-b',
};
const DATE = '2027-03-01T10:00:00.000Z';

let client: PrismaClient;
let posts: PostsRepository;

const clean = async () => {
  await client.post.deleteMany({ where: { organizationId: { in: ORGS } } });
  await client.integration.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

const body = (
  organizationId: string,
  value: Array<{ id?: string; content: string }>,
  group?: string
) =>
  ({
    integration: { id: INTEGRATION[organizationId] },
    value: value.map((entry) => ({ ...entry, image: [] })),
    group,
    settings: { __type: 'x' },
  } as any);

const save = (
  organizationId: string,
  value: Array<{ id?: string; content: string }>,
  group?: string,
  keepGroup = false
) =>
  posts.createOrUpdatePost(
    'draft',
    organizationId,
    DATE,
    body(organizationId, value, group),
    [],
    'API',
    undefined,
    keepGroup
  );

// what org B's row looks like: everything an attacker could change
const snapshot = (id: string) =>
  client.post.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      organizationId: true,
      integrationId: true,
      content: true,
      group: true,
      state: true,
      deletedAt: true,
      publishDate: true,
      parentPostId: true,
    },
  });

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  posts = new PostsRepository(
    new PrismaRepository<'post'>(prisma),
    new PrismaRepository<'popularPosts'>(prisma),
    new PrismaRepository<'comments'>(prisma),
    new PrismaRepository<'tags'>(prisma),
    new PrismaRepository<'tagsPosts'>(prisma),
    new PrismaRepository<'errors'>(prisma)
  );
  await clean();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `R20 M5 ${id}` } });
    await client.integration.create({
      data: {
        id: INTEGRATION[id],
        organizationId: id,
        internalId: `r20m5-${id}`,
        name: 'R20 M5 channel',
        providerIdentifier: 'x',
        type: 'social',
        token: 'not-a-real-token',
      },
    });
  }
});

afterEach(async () => {
  await client.post.deleteMany({ where: { organizationId: { in: ORGS } } });
});

afterAll(async () => {
  if (client) {
    await clean();
    await client.$disconnect();
  }
});

describe('Post create and update stay inside the organization (PostgreSQL)', () => {
  it('PO1 an id of another organization changes nothing there and makes a new post here', async () => {
    const {
      posts: [victim],
    } = await save(ORG_B, [{ content: 'Org B original' }]);
    const before = await snapshot(victim.id);

    const {
      posts: [made],
    } = await save(ORG_A, [{ id: victim.id, content: 'Org A takeover' }]);

    expect(await snapshot(victim.id)).toEqual(before);
    expect(made.id).not.toBe(victim.id);
    expect(made.organizationId).toBe(ORG_A);
    expect(made.integrationId).toBe(INTEGRATION[ORG_A]);
    expect(made.content).toBe('Org A takeover');
    expect(await client.post.count({ where: { organizationId: ORG_B } })).toBe(
      1
    );
  });

  it('PO2 a comment id of another organization is not taken over either', async () => {
    const { posts: thread } = await save(ORG_B, [
      { content: 'Org B main' },
      { content: 'Org B comment' },
    ]);
    const before = await Promise.all(thread.map((p) => snapshot(p.id)));
    const { posts: made } = await save(ORG_A, [
      { content: 'Org A main' },
      { id: thread[1].id, content: 'Org A comment' },
    ]);
    expect(await Promise.all(thread.map((p) => snapshot(p.id)))).toEqual(
      before
    );
    expect(made.map((p) => p.organizationId)).toEqual([ORG_A, ORG_A]);
    expect(made.map((p) => p.id)).not.toContain(thread[1].id);
  });

  it('PO3 the group of another organization is never swept, with or without keepGroup', async () => {
    const {
      posts: [victim],
    } = await save(ORG_B, [{ content: 'Org B scheduled' }]);
    const { group } = await snapshot(victim.id);
    for (const keepGroup of [false, true]) {
      await save(ORG_A, [{ content: 'Org A' }], group, keepGroup);
      expect((await snapshot(victim.id)).deletedAt).toBeNull();
    }
  });

  it('PO4 an update of an own post by id still updates it in place, and its own group sweep still works', async () => {
    const {
      posts: [own],
    } = await save(ORG_A, [{ content: 'v1' }]);
    const { group } = await snapshot(own.id);
    const {
      posts: [updated],
    } = await save(ORG_A, [{ id: own.id, content: 'v2' }], group);
    expect(updated.id).toBe(own.id);
    expect((await snapshot(own.id)).content).toBe('v2');
    // the dashboard save rotates the group and sweeps what was left behind
    const {
      posts: [other],
    } = await save(ORG_A, [{ content: 'sibling' }]);
    await client.post.update({ where: { id: other.id }, data: { group } });
    await save(ORG_A, [{ id: own.id, content: 'v3' }], group);
    expect((await snapshot(other.id)).deletedAt).not.toBeNull();
    expect((await snapshot(own.id)).deletedAt).toBeNull();
  });

  it('PO5 an unknown id still creates a post, as before', async () => {
    const {
      posts: [made],
    } = await save(ORG_A, [{ id: 'r20m5-unknown-id', content: 'new' }]);
    expect(made.organizationId).toBe(ORG_A);
    expect(made.id).not.toBe('r20m5-unknown-id');
  });
});
