import { BadRequestException } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

// ESM-only packages the controller's imports pull in
jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
  fileTypeStream: jest.fn(),
}));
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: jest.fn() },
}));
jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  finalizeEvent: jest.fn(),
  Relay: { connect: jest.fn() },
  SimplePool: class {},
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));
jest.mock('@sentry/nestjs', () => ({
  metrics: { count: jest.fn() },
}));

const {
  PostsService,
} = require('@gitroom/nestjs-libraries/database/prisma/posts/posts.service');
const {
  PublicIntegrationsController,
} = require('./public.integrations.controller');

// Review 20 (M6): POST /public/v1/posts publishes only when asked to
const ORG = { id: 'org-a' } as any;
const future = () => dayjs.utc().add(1, 'day').toISOString();

const setup = () => {
  const posts = {
    // the real rules
    publicPostType: PostsService.prototype.publicPostType,
    assertPublicPublishDate: PostsService.prototype.assertPublicPublishDate,
    // the mapping and validation the service does, as plain copies
    mapTypeToPost: jest.fn(
      async (body: any, _org: string, replace: boolean) => ({
        ...body,
        type: replace ? 'schedule' : body.type,
        posts: body.posts,
      })
    ),
    validatePosts: jest.fn(async () => [
      { valid: true, errors: true, tooLong: false, emptyContent: false },
    ]),
    createPost: jest.fn(async (..._args: any[]) => [
      { postId: 'p1', integration: 'i1' },
    ]),
  };
  const none = {} as any;
  const controller = new PublicIntegrationsController(
    none,
    posts,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none
  );
  return { posts, controller };
};

const request = (patch: Record<string, unknown> = {}) => ({
  date: future(),
  shortLink: false,
  tags: [],
  posts: [
    {
      integration: { id: 'i1' },
      value: [{ content: 'Hello', image: [] }],
      settings: { __type: 'x' },
    },
  ],
  ...patch,
});

const refused = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).getResponse();
};

describe('POST /public/v1/posts delivery mode', () => {
  it('PA1 without a type the post is a draft: saved, never published', async () => {
    for (const type of [undefined, null]) {
      const { posts, controller } = setup();
      await controller.createPost(ORG, request({ type }));
      expect(posts.createPost).toHaveBeenCalledTimes(1);
      expect((posts.createPost.mock.calls[0] as any[])[1].type).toBe('draft');
    }
  });

  it('PA2 draft, schedule, now and update are taken exactly as sent', async () => {
    for (const type of ['draft', 'schedule', 'now', 'update']) {
      const { posts, controller } = setup();
      await controller.createPost(ORG, request({ type }));
      expect((posts.createPost.mock.calls[0] as any[])[1].type).toBe(type);
    }
  });

  it('PA3 every post is still checked with the settings of a scheduled one', async () => {
    const { posts, controller } = setup();
    await controller.createPost(ORG, request({ type: 'draft' }));
    expect(posts.mapTypeToPost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'draft' }),
      'org-a',
      true
    );
  });

  it('PA4 an unknown type is a 400 before anything is read or saved', async () => {
    for (const type of ['publish', 'NOW', 'Draft', '', 1, true, ['now'], {}]) {
      const { posts, controller } = setup();
      expect(
        await refused(controller.createPost(ORG, request({ type })))
      ).toMatchObject({
        message: 'type must be one of: draft, schedule, now, update',
      });
      expect(posts.mapTypeToPost).not.toHaveBeenCalled();
      expect(posts.createPost).not.toHaveBeenCalled();
    }
  });

  it('PA5 a schedule date already gone is a 400; a minute of clock difference is allowed', async () => {
    const { posts, controller } = setup();
    expect(
      await refused(
        controller.createPost(
          ORG,
          request({
            type: 'schedule',
            date: dayjs.utc().subtract(5, 'minute').toISOString(),
          })
        )
      )
    ).toMatchObject({
      message:
        "date must be in the future for type 'schedule'; use type 'now' to publish at once",
    });
    expect(posts.createPost).not.toHaveBeenCalled();
    await controller.createPost(
      ORG,
      request({
        type: 'schedule',
        date: dayjs.utc().subtract(30, 'second').toISOString(),
      })
    );
    expect(posts.createPost).toHaveBeenCalledTimes(1);
  });

  it('PA6 a past date only matters for schedule: a draft keeps it, now ignores it', async () => {
    for (const type of ['draft', 'now', undefined]) {
      const { posts, controller } = setup();
      await controller.createPost(
        ORG,
        request({ type, date: '2020-01-01T00:00:00.000Z' })
      );
      expect(posts.createPost).toHaveBeenCalledTimes(1);
    }
  });
});

describe('POST /public/v1/posts body validation (CreatePostDto)', () => {
  // the service's own validation pipe, as mapTypeToPost runs it
  const { ValidationPipe } = require('@nestjs/common');
  const {
    CreatePostDto,
  } = require('@gitroom/nestjs-libraries/dtos/posts/create.post.dto');
  const validate = (body: unknown) =>
    new ValidationPipe({
      skipMissingProperties: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }).transform(body, { type: 'body', metatype: CreatePostDto });

  // the date messages only: the fixture's content and channel settings are
  // not what is checked here
  const dateErrors = (body: unknown) =>
    validate(body).then(
      () => [],
      (e: any) =>
        (e.getResponse().message as string[]).filter((m) => /^date /.test(m))
    );

  it('PA7 a schedule without a date, or with a malformed one, is a 400', async () => {
    for (const date of [undefined, 'tomorrow', '2027-13-45T99:00:00Z', 12]) {
      expect(await dateErrors(request({ type: 'schedule', date }))).not.toEqual(
        []
      );
    }
    expect(await dateErrors(request({ type: 'schedule' }))).toEqual([]);
  });
});
