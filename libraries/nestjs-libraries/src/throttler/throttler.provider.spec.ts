import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  Throttle,
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import {
  CONTENT_STUDIO_RATE_WINDOW_MS,
  ThrottlerBehindProxyGuard,
  ThrottlerContentStudioGuard,
} from '@gitroom/nestjs-libraries/throttler/throttler.provider';

// Review 20 (S3): Content Studio's expensive writes carry @Throttle and the
// Content Studio guard, which counts per user and route; the global guard
// keeps counting the public API only
const PUBLIC_LIMIT = 3;

class ContentStudioController {
  @Throttle({ default: { limit: 10, ttl: CONTENT_STUDIO_RATE_WINDOW_MS } })
  proposeAISetup() {
    return undefined;
  }

  @Throttle({ default: { limit: 10, ttl: CONTENT_STUDIO_RATE_WINDOW_MS } })
  testAIConnection() {
    return undefined;
  }

  listDesigns() {
    return undefined;
  }
}

// the in-memory storage keeps a timer per hit: cleared after each test
const storages: ThrottlerStorageService[] = [];
afterEach(() => {
  storages.splice(0).forEach((storage) => storage.onApplicationShutdown());
});

const setup = async <T extends ThrottlerGuard>(
  Guard: new (...args: any[]) => T
) => {
  const storage = new ThrottlerStorageService();
  storages.push(storage);
  const guard = new Guard(
    { throttlers: [{ ttl: 3_600_000, limit: PUBLIC_LIMIT }] },
    storage,
    new Reflector()
  );
  await guard.onModuleInit();
  const run = (
    method: string,
    url: string,
    name: keyof ContentStudioController = 'proposeAISetup',
    user = 'user-1'
  ) => {
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
      header: (header: string, value: unknown) => (headers[header] = value),
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ContentStudioController.prototype[name],
      getClass: () => ContentStudioController,
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
  it('RL1 the request after the route limit is a 429 CS_RATE_LIMITED, with a retry time', async () => {
    const { run } = await setup(ThrottlerContentStudioGuard);
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
    expect(refused.headers['Retry-After']).toBeGreaterThan(0);
    expect(CONTENT_STUDIO_RATE_WINDOW_MS).toBe(600_000);
  });

  it('RL2 each user and each route has its own count', async () => {
    const { run } = await setup(ThrottlerContentStudioGuard);
    for (let i = 0; i < 10; i++) {
      await run('POST', SETUP);
    }
    expect((await run('POST', SETUP, 'proposeAISetup', 'user-2')).ok).toBe(
      true
    );
    expect(
      (
        await run(
          'POST',
          '/content-studio/ai/connections/c1/test',
          'testAIConnection'
        )
      ).ok
    ).toBe(true);
  });

  it('RL3 the global guard counts no Content Studio route', async () => {
    const { run, storage } = await setup(ThrottlerBehindProxyGuard);
    for (let i = 0; i < 50; i++) {
      for (const [method, url, name] of [
        ['POST', SETUP, 'proposeAISetup'],
        ['GET', '/content-studio/designs', 'listDesigns'],
      ] as const) {
        expect((await run(method, url, name)).ok).toBe(true);
      }
    }
    expect(storage.storage.size).toBe(0);
  });

  it('RL4 the public API keeps its own hourly limit, unchanged', async () => {
    const { run } = await setup(ThrottlerBehindProxyGuard);
    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      expect((await run('POST', '/public/v1/posts', 'listDesigns')).ok).toBe(
        true
      );
    }
    const refused = await run('POST', '/public/v1/posts', 'listDesigns');
    expect(refused.error).toBeInstanceOf(ThrottlerException);
  });
});
