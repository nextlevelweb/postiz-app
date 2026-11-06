import {
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerRequest,
} from '@nestjs/throttler';
import { ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Request } from 'express';

const isPublicComment = (method: string, url: string) =>
  method === 'POST' && /^\/public\/posts\/[^/]+\/comments/.test(url);

// Content Studio's expensive writes (Review 20): each calls an AI provider
// or renders, so each is limited per user and route, in a window of its
// own, never the public API's hourly one. Reads and every other route are
// not counted. The limits leave room for a normal setup and editing session
export const CONTENT_STUDIO_RATE_WINDOW_MS = 10 * 60 * 1000;
export const CONTENT_STUDIO_RATE_LIMITS: Array<{
  route: RegExp;
  limit: number;
}> = [
  {
    route: /^\/content-studio\/packages\/[^/]+\/ai\/(item|thread)$/,
    limit: 30,
  },
  { route: /^\/content-studio\/ai\/setup\/proposal$/, limit: 10 },
  { route: /^\/content-studio\/activation\/first-post$/, limit: 10 },
  {
    route: /^\/content-studio\/designs\/[^/]+\/revisions\/[^/]+\/ai\/propose$/,
    limit: 30,
  },
  { route: /^\/content-studio\/ai\/connections\/[^/]+\/test$/, limit: 10 },
  { route: /^\/content-studio\/designs\/[^/]+\/render$/, limit: 60 },
  { route: /^\/content-studio\/designs\/[^/]+\/render-all$/, limit: 20 },
];

export const contentStudioRateLimit = (method: string, url: string) => {
  if (method !== 'POST') {
    return null;
  }
  const path = url.split('?')[0];
  return (
    CONTENT_STUDIO_RATE_LIMITS.find(({ route }) => route.test(path))?.limit ??
    null
  );
};

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  public override async canActivate(
    context: ExecutionContext
  ): Promise<boolean> {
    const { url, method } = context.switchToHttp().getRequest<Request>();
    if (
      (method === 'POST' && url.includes('/public/v1/posts')) ||
      isPublicComment(method, url) ||
      contentStudioRateLimit(method, url) !== null
    ) {
      return super.canActivate(context);
    }

    return true;
  }

  // a Content Studio route: its own limit, window and name, per user
  protected override async handleRequest(
    requestProps: ThrottlerRequest
  ): Promise<boolean> {
    const { req } = this.getRequestResponse(requestProps.context);
    const limit = contentStudioRateLimit(req.method, req.url);
    if (limit === null) {
      return super.handleRequest(requestProps);
    }
    return super.handleRequest({
      ...requestProps,
      limit,
      ttl: CONTENT_STUDIO_RATE_WINDOW_MS,
      blockDuration: CONTENT_STUDIO_RATE_WINDOW_MS,
      throttler: { ...requestProps.throttler, name: 'content-studio' },
      getTracker: async (request: Record<string, any>) =>
        request.user?.id
          ? 'user_' + request.user.id
          : await this.getTracker(request),
    });
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    const { req } = this.getRequestResponse(context);
    if (contentStudioRateLimit(req.method, req.url) === null) {
      return super.throwThrottlingException(context, detail);
    }
    throw new HttpException(
      {
        msg: 'Too many requests in a short time. Wait a few minutes and try again.',
        code: 'CS_RATE_LIMITED',
      },
      429
    );
  }

  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    if (!req.org) {
      const forwarded = String(req.headers?.['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      return 'ip_' + (forwarded || req.ip || 'unknown');
    }

    return (
      req.org.id + '_' + (req.url.indexOf('/posts') > -1 ? 'posts' : 'other')
    );
  }
}

// route-level guard for public endpoints, keyed by the client address the
// proxy forwards rather than the org the global guard expects
@Injectable()
export class ThrottlerRealIpGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '');
    return forwarded.split(',')[0].trim() || req.ip;
  }
}
