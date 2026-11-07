import { ThrottlerGuard } from '@nestjs/throttler';
import { ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Request } from 'express';

const isPublicComment = (method: string, url: string) =>
  method === 'POST' && /^\/public\/posts\/[^/]+\/comments/.test(url);

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  public override async canActivate(
    context: ExecutionContext
  ): Promise<boolean> {
    const { url, method } = context.switchToHttp().getRequest<Request>();
    if (
      (method === 'POST' && url.includes('/public/v1/posts')) ||
      isPublicComment(method, url)
    ) {
      return super.canActivate(context);
    }

    return true;
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

// route-level guard for Content Studio's expensive writes: each calls an AI
// provider or renders, so with @Throttle on the route it counts per user, in
// the window of the route, and answers with a code the screens understand
export const CONTENT_STUDIO_RATE_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class ThrottlerContentStudioGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    return 'user_' + req.user.id;
  }

  protected override async throwThrottlingException(): Promise<void> {
    throw new HttpException(
      {
        msg: 'Too many requests in a short time. Wait a few minutes and try again.',
        code: 'CS_RATE_LIMITED',
      },
      429
    );
  }
}
