import { CreationMethod, PrismaClient, State } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioActivationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.activation.repository';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Which posts count for the first post (activation flow 01), on a real
// PostgreSQL: the organization's own thread heads made in the Postiz composer
// (WEB) since the first handoff, not deleted. Posts made by the public API,
// the CLI, MCP, an autopost or a clipping (UNKNOWN) never count, and another
// organization's posts are never seen. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. Prisma is used directly only for fixtures

const ORG_A = '30900000-0000-4000-8000-00000000000a';
const ORG_B = '30900000-0000-4000-8000-00000000000b';
const ORGS = [ORG_A, ORG_B];
const INTEGRATION: Record<string, string> = {
  [ORG_A]: '30900000-0000-4000-8000-0000000000a1',
  [ORG_B]: '30900000-0000-4000-8000-0000000000b1',
};
// the first handoff
const SINCE = new Date('2026-10-30T22:24:15.154Z');
const after = (minutes: number) => new Date(SINCE.getTime() + minutes * 60_000);

let client: PrismaClient;
let activation: ContentStudioActivationRepository;

let n = 0;
const post = async (
  organizationId: string,
  over: {
    state: State;
    creationMethod?: CreationMethod;
    createdAt?: Date;
    publishDate?: Date;
    deletedAt?: Date | null;
    parentPostId?: string | null;
    id?: string;
  }
) => {
  n += 1;
  return client.post.create({
    data: {
      id: over.id ?? `p309-${String(n).padStart(4, '0')}`,
      organizationId,
      integrationId: INTEGRATION[organizationId],
      content: `P309 post ${n}`,
      group: `p309-group-${n}`,
      publishDate: over.publishDate ?? new Date('2027-01-05T07:20:00.000Z'),
      state: over.state,
      creationMethod: over.creationMethod ?? CreationMethod.WEB,
      createdAt: over.createdAt ?? after(5),
      deletedAt: over.deletedAt ?? null,
      parentPostId: over.parentPostId ?? null,
    },
    select: { id: true, group: true },
  });
};

const cleanPosts = async () => {
  // children first: a thread's later posts point at its head
  await client.post.deleteMany({
    where: { organizationId: { in: ORGS }, parentPostId: { not: null } },
  });
  await client.post.deleteMany({ where: { organizationId: { in: ORGS } } });
};

const cleanFixtures = async () => {
  await cleanPosts();
  await client.integration.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

const lookups = async (organizationId: string) => ({
  published: await activation.getFirstPublishedSince(organizationId, SINCE),
  scheduled: await activation.getFirstScheduledSince(organizationId, SINCE),
  draft: await activation.getLatestDraftSince(organizationId, SINCE),
});

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  activation = new ContentStudioActivationRepository(
    new PrismaRepository<'contentStudioHandoff'>(prisma),
    new PrismaRepository<'post'>(prisma)
  );
  await cleanFixtures();
  for (const id of ORGS) {
    await client.organization.create({ data: { id, name: `P309 ${id}` } });
    await client.integration.create({
      data: {
        id: INTEGRATION[id],
        internalId: `p309-${id}`,
        organizationId: id,
        name: 'P309 page',
        providerIdentifier: 'linkedin-page',
        type: 'social',
        token: 'p309-not-a-token',
      },
    });
  }
});

beforeEach(async () => {
  await cleanPosts();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('First post activation on PostgreSQL', () => {
  it('ACTPG1/ATTR1 nothing since the handoff: posts made before it never count', async () => {
    for (const state of [State.QUEUE, State.PUBLISHED, State.DRAFT]) {
      await post(ORG_A, { state, createdAt: after(-1) });
    }
    expect(await lookups(ORG_A)).toEqual({
      published: null,
      scheduled: null,
      draft: null,
    });
  });

  it('ACTPG2/ATTR2 the composer draft is the saved first post, with its date and group', async () => {
    const planned = new Date('2026-11-25T07:20:00.000Z');
    const saved = await post(ORG_A, {
      state: State.DRAFT,
      publishDate: planned,
      createdAt: after(5),
    });
    expect(await lookups(ORG_A)).toEqual({
      published: null,
      scheduled: null,
      draft: { publishDate: planned, group: saved.group, createdAt: after(5) },
    });
  });

  it('ACTPG3/ATTR3/PERF3 scheduled: the oldest composer post since the handoff gives the date, ties by id', async () => {
    const first = new Date('2027-01-05T07:20:00.000Z');
    await post(ORG_A, {
      id: 'p309-b-later-id',
      state: State.QUEUE,
      createdAt: after(5),
      publishDate: new Date('2027-03-01T09:00:00.000Z'),
    });
    await post(ORG_A, {
      id: 'p309-a-first-id',
      state: State.QUEUE,
      createdAt: after(5),
      publishDate: first,
    });
    await post(ORG_A, {
      state: State.QUEUE,
      createdAt: after(9),
      publishDate: new Date('2026-12-01T09:00:00.000Z'),
    });
    expect(await activation.getFirstScheduledSince(ORG_A, SINCE)).toEqual({
      publishDate: first,
    });
  });

  it('ACTPG4/ATTR4 published: the composer post is found, its id only', async () => {
    const published = await post(ORG_A, { state: State.PUBLISHED });
    expect(await activation.getFirstPublishedSince(ORG_A, SINCE)).toEqual({
      id: published.id,
    });
  });

  it('ACTPG5/ATTR6/ATTR7 posts made by the API, the CLI, MCP, an autopost or a clipping never count, and never give the date', async () => {
    for (const creationMethod of [
      CreationMethod.API,
      CreationMethod.CLI,
      CreationMethod.MCP,
      CreationMethod.AUTOPOST,
      CreationMethod.UNKNOWN,
    ]) {
      for (const state of [State.QUEUE, State.PUBLISHED, State.DRAFT]) {
        // made before the composer post, with an earlier date
        await post(ORG_A, {
          state,
          creationMethod,
          createdAt: after(1),
          publishDate: new Date('2026-11-10T08:00:00.000Z'),
        });
      }
    }
    expect(await lookups(ORG_A)).toEqual({
      published: null,
      scheduled: null,
      draft: null,
    });
    // the user's own composer post is still found, with its own date
    const planned = new Date('2027-01-05T07:20:00.000Z');
    await post(ORG_A, {
      state: State.QUEUE,
      createdAt: after(6),
      publishDate: planned,
    });
    expect(await activation.getFirstScheduledSince(ORG_A, SINCE)).toEqual({
      publishDate: planned,
    });
  });

  it('ACTPG6/ATTR8 another organization: its composer posts are never seen', async () => {
    for (const state of [State.QUEUE, State.PUBLISHED, State.DRAFT]) {
      await post(ORG_B, { state });
    }
    expect(await lookups(ORG_A)).toEqual({
      published: null,
      scheduled: null,
      draft: null,
    });
    const b = await lookups(ORG_B);
    expect(b.published).not.toBeNull();
    expect(b.scheduled).not.toBeNull();
    expect(b.draft).not.toBeNull();
  });

  it('ACTPG7 deleted posts, later posts of a thread and failed posts never count', async () => {
    const head = await post(ORG_A, {
      state: State.ERROR,
      createdAt: after(2),
    });
    for (const state of [State.QUEUE, State.PUBLISHED, State.DRAFT]) {
      await post(ORG_A, { state, deletedAt: after(30) });
      await post(ORG_A, { state, parentPostId: head.id });
    }
    expect(await lookups(ORG_A)).toEqual({
      published: null,
      scheduled: null,
      draft: null,
    });
  });
});
