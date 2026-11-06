import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import {
  CONTENT_STUDIO_RATE_LIMITS,
  CONTENT_STUDIO_RATE_WINDOW_MS,
  contentStudioRateLimit,
  ThrottlerBehindProxyGuard,
} from '@gitroom/nestjs-libraries/throttler/throttler.provider';

// Review 20 (S3): the global guard limits Content Studio's expensive writes
// per user and route in a 10 minute window, and nothing else of it
const PUBLIC_LIMIT = 3;

// the in-memory storage keeps a timer per hit: cleared after each test
const storages: ThrottlerStorageService[] = [];
afterEach(() => {
  storages.splice(0).forEach((storage) => storage.onApplicationShutdown());
});

const setup = async () => {
  const storage = new ThrottlerStorageService();
  storages.push(storage);
  const guard = new ThrottlerBehindProxyGuard(
    { throttlers: [{ ttl: 3_600_000, limit: PUBLIC_LIMIT }] },
    storage,
    new Reflector()
  );
  await guard.onModuleInit();
  const run = (method: string, url: string, user = 'user-1') => {
    const headers: Record<string, unknown> = {};
    const req = {
      method,
      url,
      headers: {},
      ip: '10.0.0.1',
      user: { id: user },
      org: { id: 'org-1' },
    };
    const res = {
      header: (name: string, value: unknown) => (headers[name] = value),
    };
    // one handler per route, as Nest has
    const handler = { [url.split('?')[0]]: () => undefined }[url.split('?')[0]];
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => handler,
      getClass: () => class ContentStudioController {},
    } as any;
    return guard.canActivate(context).then(
      (ok) => ({ ok, error: undefined as unknown, headers }),
      (error: unknown) => ({ ok: false, error, headers })
    );
  };
  return { run, storage };
};

const SETUP = '/content-studio/ai/setup/proposal';

describe('Content Studio rate limits', () => {
  it('RL1 the request after the limit is a 429 CS_RATE_LIMITED, with a retry time', async () => {
    const { run } = await setup();
    for (let i = 0; i < 10; i++) {
      expect((await run('POST', SETUP)).ok).toBe(true);
    }
    const refused = await run('POST', SETUP);
    expect(refused.error).toBeInstanceOf(HttpException);
    const error = refused.error as HttpException;
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      msg: 'Too many requests in a short time. Wait a few minutes and try again.',
      code: 'CS_RATE_LIMITED',
    });
    expect(refused.headers['Retry-After-content-studio']).toBeGreaterThan(0);
  });

  it('RL2 each user and each route has its own count', async () => {
    const { run } = await setup();
    for (let i = 0; i < 10; i++) {
      await run('POST', SETUP);
    }
    expect((await run('POST', SETUP, 'user-2')).ok).toBe(true);
    expect((await run('POST', '/content-studio/packages/p1/ai/item')).ok).toBe(
      true
    );
  });

  it('RL3 reads and other Content Studio routes are never counted', async () => {
    const { run, storage } = await setup();
    for (let i = 0; i < 50; i++) {
      for (const [method, url] of [
        ['GET', `${SETUP}/op-1`],
        ['GET', '/content-studio/designs'],
        ['POST', '/content-studio/designs'],
        ['POST', '/content-studio/sources/s1/refresh'],
        ['PUT', '/content-studio/packages/p1'],
      ]) {
        expect((await run(method, url)).ok).toBe(true);
      }
    }
    expect(storage.storage.size).toBe(0);
  });

  it('RL4 the public API keeps its own hourly limit, unchanged', async () => {
    const { run } = await setup();
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      expect((await run('POST', '/public/v1/posts')).ok).toBe(true);
    }
    const refused = await run('POST', '/public/v1/posts');
    expect(refused.error).toBeInstanceOf(ThrottlerException);
  });

  it('RL5 the limited routes and their limits, in a 10 minute window', () => {
    expect(CONTENT_STUDIO_RATE_WINDOW_MS).toBe(600_000);
    expect(
      CONTENT_STUDIO_RATE_LIMITS.map(({ route, limit }) => [
        route.source,
        limit,
      ])
    ).toEqual([
      ['^\\/content-studio\\/packages\\/[^/]+\\/ai\\/(item|thread)$', 30],
      ['^\\/content-studio\\/ai\\/setup\\/proposal$', 10],
      ['^\\/content-studio\\/activation\\/first-post$', 10],
      [
        '^\\/content-studio\\/designs\\/[^/]+\\/revisions\\/[^/]+\\/ai\\/propose$',
        30,
      ],
      ['^\\/content-studio\\/ai\\/connections\\/[^/]+\\/test$', 10],
      ['^\\/content-studio\\/designs\\/[^/]+\\/render$', 60],
      ['^\\/content-studio\\/designs\\/[^/]+\\/render-all$', 20],
    ]);
    expect(contentStudioRateLimit('POST', `${SETUP}?x=1`)).toBe(10);
    expect(contentStudioRateLimit('GET', SETUP)).toBeNull();
    expect(
      contentStudioRateLimit('POST', '/content-studio/designs/d1/render-all')
    ).toBe(20);
  });
});
