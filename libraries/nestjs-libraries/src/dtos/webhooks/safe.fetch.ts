import { Agent, fetch, Response } from 'undici';
import net from 'node:net';
import { isBlockedLiteralHost, ssrfSafeConnect } from './ssrf.safe.dispatcher';

// SafeFetch reads untrusted remote URLs (source ingestion, organization
// connections). Unlike getSsrfSafeDispatcher it never honours
// DISABLE_SSRF_PROTECTION or proxy environment variables, follows redirects
// itself so every hop is validated again, and only returns bodies that were
// capped while streaming. GET and HEAD only, no request body.

export type SafeFetchErrorCategory =
  | 'INVALID_URL'
  | 'INVALID_REQUEST'
  | 'BLOCKED_DESTINATION'
  | 'UNSUPPORTED_SCHEME'
  | 'UNSUPPORTED_PORT'
  | 'DNS_FAILURE'
  | 'REDIRECT_INVALID'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_LOOP'
  | 'DOWNGRADE_BLOCKED'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'HTTP_STATUS'
  | 'NETWORK';

const ERROR_MESSAGES: Record<SafeFetchErrorCategory, string> = {
  INVALID_URL: 'The URL is not valid',
  INVALID_REQUEST: 'The request options are not allowed',
  BLOCKED_DESTINATION: 'The destination is not allowed',
  UNSUPPORTED_SCHEME: 'The URL scheme is not allowed',
  UNSUPPORTED_PORT: 'The URL port is not allowed',
  DNS_FAILURE: 'The hostname could not be resolved',
  REDIRECT_INVALID: 'The redirect is not valid',
  TOO_MANY_REDIRECTS: 'Too many redirects',
  REDIRECT_LOOP: 'Redirect loop detected',
  DOWNGRADE_BLOCKED: 'Redirect from HTTPS to HTTP is not allowed',
  TIMEOUT: 'The request timed out',
  TOO_LARGE: 'The response is too large',
  UNSUPPORTED_CONTENT_TYPE: 'The response content type is not allowed',
  HTTP_STATUS: 'The server returned an unsuccessful status',
  NETWORK: 'The request failed',
};

// Fixed messages and no `cause`: only the category, status code and hostname
// are kept, never the path, query, credentials, headers, body or resolved IP
export class SafeFetchError extends Error {
  readonly statusCode?: number;
  readonly hostname?: string;

  constructor(
    readonly category: SafeFetchErrorCategory,
    details: { statusCode?: number; hostname?: string } = {}
  ) {
    super(ERROR_MESSAGES[category]);
    this.name = 'SafeFetchError';
    this.statusCode = details.statusCode;
    this.hostname = details.hostname;
  }

  toJSON() {
    return {
      name: this.name,
      category: this.category,
      message: this.message,
      statusCode: this.statusCode,
      hostname: this.hostname,
    };
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  // Media types such as `text/html` or `image/*`, compared without parameters
  allowedContentTypes: string[];
  // Only Accept, Accept-Language, If-None-Match and If-Modified-Since,
  // any other header rejects the request
  headers?: Record<string, string>;
  // Decoded body cap, at most the policy's maxBytes
  maxBytes?: number;
  // Whole-request deadline, redirects and body included
  timeoutMs?: number;
}

export interface SafeFetchHeaders {
  contentType?: string;
  contentLength?: number;
  contentEncoding?: string;
  contentLanguage?: string;
  etag?: string;
  lastModified?: string;
  date?: string;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  // Every URL that answered with a redirect, in order
  redirects: Array<{ url: string; status: number }>;
  status: number;
  headers: SafeFetchHeaders;
  body: Uint8Array;
  bytesRead: number;
}

export interface SafeFetchPolicy {
  // Allows http: next to https:
  allowHttp?: boolean;
  // Ports allowed next to 443 (https:) and 80 (http:)
  allowedPorts?: number[];
  maxRedirects?: number;
  // Wire cap per response (undici maxResponseSize) and ceiling of the
  // per-request decoded cap
  maxBytes?: number;
  headersTimeoutMs?: number;
  // Idle time allowed between body chunks
  bodyTimeoutMs?: number;
  // Default whole-request deadline
  timeoutMs?: number;
}

const LIMITS = {
  maxRedirects: { fallback: 5, min: 0, max: 10 },
  maxBytes: { fallback: 10 * 1024 * 1024, min: 1, max: 50 * 1024 * 1024 },
  headersTimeoutMs: { fallback: 15000, min: 1, max: 60000 },
  bodyTimeoutMs: { fallback: 15000, min: 1, max: 60000 },
  timeoutMs: { fallback: 30000, min: 1, max: 120000 },
};

const MAX_URL_LENGTH = 2048;
const DEFAULT_PORTS: Record<string, number> = { 'https:': 443, 'http:': 80 };
const LOCAL_DOMAINS = ['localhost', 'local', 'internal', 'home.arpa'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NO_CONTENT_STATUSES = new Set([204, 205]);
const CALLER_HEADERS = new Set([
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
]);
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MEDIA_RANGE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/\*$/;
const USER_AGENT = 'Postiz-SafeFetch/1.0';

const DNS_ERRORS = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NODATA',
  'EAI_NONAME',
  'ENODATA',
]);
const TIMEOUT_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

type Settings = Required<
  Pick<
    SafeFetchPolicy,
    'allowHttp' | 'allowedPorts' | 'maxRedirects' | 'maxBytes' | 'timeoutMs'
  >
>;

function limit(
  name: keyof typeof LIMITS,
  value: number | undefined,
  fallback = LIMITS[name].fallback,
  max = LIMITS[name].max
) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < LIMITS[name].min || result > max) {
    throw new SafeFetchError('INVALID_REQUEST');
  }
  return result;
}

// Literal IPs are judged by the shared classifier, names by local-only
// suffixes; addresses behind a name are checked at connect time
function isBlockedHostname(hostname: string) {
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(host)) {
    return isBlockedLiteralHost(host);
  }
  const name = host.replace(/\.$/, '');
  return (
    !name.includes('.') ||
    LOCAL_DOMAINS.some(
      (domain) => name === domain || name.endsWith(`.${domain}`)
    )
  );
}

function parseTarget(value: string, settings: Settings): URL {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) {
    throw new SafeFetchError('INVALID_URL');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeFetchError('INVALID_URL');
  }
  url.hash = '';

  const hostname = url.hostname || undefined;
  if (
    url.protocol !== 'https:' &&
    !(settings.allowHttp && url.protocol === 'http:')
  ) {
    throw new SafeFetchError('UNSUPPORTED_SCHEME', { hostname });
  }
  if (url.username || url.password || url.href.length > MAX_URL_LENGTH) {
    throw new SafeFetchError('INVALID_URL', { hostname });
  }

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (
    port !== DEFAULT_PORTS[url.protocol] &&
    !settings.allowedPorts.includes(port)
  ) {
    throw new SafeFetchError('UNSUPPORTED_PORT', { hostname });
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SafeFetchError('BLOCKED_DESTINATION', { hostname });
  }
  return url;
}

function redirectTarget(
  current: URL,
  location: string | null,
  settings: Settings
): URL {
  let next: URL;
  try {
    if (!location) {
      throw new Error('Missing Location');
    }
    next = new URL(location, current);
  } catch {
    throw new SafeFetchError('REDIRECT_INVALID', {
      hostname: current.hostname,
    });
  }
  if (current.protocol === 'https:' && next.protocol === 'http:') {
    throw new SafeFetchError('DOWNGRADE_BLOCKED', { hostname: next.hostname });
  }
  return parseTarget(next.href, settings);
}

function requestHeaders(options: SafeFetchOptions, allowedTypes: string[]) {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: allowedTypes.join(', '),
  };
  for (const [name, value] of Object.entries(options.headers || {})) {
    const key = name.toLowerCase();
    if (
      !CALLER_HEADERS.has(key) ||
      typeof value !== 'string' ||
      value.length > 1024 ||
      /[\r\n\0]/.test(value)
    ) {
      throw new SafeFetchError('INVALID_REQUEST');
    }
    headers[key] = value;
  }
  return headers;
}

function allowedContentTypes(types: string[]) {
  const normalized = (Array.isArray(types) ? types : []).map((type) =>
    String(type).trim().toLowerCase()
  );
  if (
    !normalized.length ||
    normalized.some((type) => !MEDIA_TYPE.test(type) && !MEDIA_RANGE.test(type))
  ) {
    throw new SafeFetchError('INVALID_REQUEST');
  }
  return normalized;
}

function isAllowedContentType(header: string | undefined, allowed: string[]) {
  const type = (header || '').split(';')[0].trim().toLowerCase();
  return (
    MEDIA_TYPE.test(type) &&
    allowed.some(
      (entry) =>
        entry === type ||
        (entry.endsWith('/*') && type.startsWith(entry.slice(0, -1)))
    )
  );
}

function responseHeaders(response: Response): SafeFetchHeaders {
  const value = (name: string) => response.headers.get(name) ?? undefined;
  const length = value('content-length');
  return {
    contentType: value('content-type'),
    contentLength: length && /^\d+$/.test(length) ? Number(length) : undefined,
    contentEncoding: value('content-encoding'),
    contentLanguage: value('content-language'),
    etag: value('etag'),
    lastModified: value('last-modified'),
    date: value('date'),
  };
}

// undici fetch decodes gzip/deflate/br/zstd itself, so these are decoded bytes;
// wire bytes are capped separately by the agent's maxResponseSize
async function readBody(
  response: Response,
  maxBytes: number,
  hostname: string
) {
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new SafeFetchError('TOO_LARGE', { hostname });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytesRead);
}

function toSafeFetchError(err: unknown, hostname?: string) {
  for (let cause: any = err, depth = 0; cause && depth < 5; depth++) {
    if (cause instanceof SafeFetchError) {
      return cause;
    }
    if (cause.message === 'Blocked IP') {
      return new SafeFetchError('BLOCKED_DESTINATION', { hostname });
    }
    if (DNS_ERRORS.has(cause.code)) {
      return new SafeFetchError('DNS_FAILURE', { hostname });
    }
    if (TIMEOUT_ERRORS.has(cause.code)) {
      return new SafeFetchError('TIMEOUT', { hostname });
    }
    if (cause.code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') {
      return new SafeFetchError('TOO_LARGE', { hostname });
    }
    cause = cause.cause;
  }
  return new SafeFetchError('NETWORK', { hostname });
}

// Production code uses `safeFetch`. The factory exists for tests (local ports,
// plain http, short timeouts, small caps); it can only narrow limits or widen
// scheme/ports, never skip the address checks
export function createSafeFetch(policy: SafeFetchPolicy = {}) {
  const settings: Settings = {
    allowHttp: policy.allowHttp === true,
    allowedPorts: (policy.allowedPorts || []).map((port) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new SafeFetchError('INVALID_REQUEST');
      }
      return port;
    }),
    maxRedirects: limit('maxRedirects', policy.maxRedirects),
    maxBytes: limit('maxBytes', policy.maxBytes),
    timeoutMs: limit('timeoutMs', policy.timeoutMs),
  };

  // Explicit dispatcher: proxy environment variables and the global
  // dispatcher are never consulted
  const agent = new Agent({
    connect: ssrfSafeConnect,
    headersTimeout: limit('headersTimeoutMs', policy.headersTimeoutMs),
    bodyTimeout: limit('bodyTimeoutMs', policy.bodyTimeoutMs),
    maxResponseSize: settings.maxBytes,
  });

  return async (
    input: string,
    options: SafeFetchOptions
  ): Promise<SafeFetchResult> => {
    const method = options.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      throw new SafeFetchError('INVALID_REQUEST');
    }
    const allowed = allowedContentTypes(options.allowedContentTypes);
    const headers = requestHeaders(options, allowed);
    const conditional = !!(
      headers['if-none-match'] || headers['if-modified-since']
    );
    const maxBytes = limit(
      'maxBytes',
      options.maxBytes,
      settings.maxBytes,
      settings.maxBytes
    );
    const timeoutMs = limit('timeoutMs', options.timeoutMs, settings.timeoutMs);

    let url = parseTarget(input, settings);
    const requestedUrl = url.href;
    const visited = new Set([url.href]);
    const redirects: SafeFetchResult['redirects'] = [];

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      for (;;) {
        const response = await fetch(url.href, {
          method,
          headers,
          redirect: 'manual',
          referrer: '',
          credentials: 'omit',
          dispatcher: agent,
          signal: controller.signal,
        });
        const { status } = response;

        if (REDIRECT_STATUSES.has(status)) {
          await response.body?.cancel();
          const next = redirectTarget(
            url,
            response.headers.get('location'),
            settings
          );
          if (visited.has(next.href)) {
            throw new SafeFetchError('REDIRECT_LOOP', {
              hostname: url.hostname,
            });
          }
          if (redirects.length >= settings.maxRedirects) {
            throw new SafeFetchError('TOO_MANY_REDIRECTS', {
              hostname: url.hostname,
            });
          }
          redirects.push({ url: url.href, status });
          visited.add(next.href);
          url = next;
          continue;
        }

        const notModified = status === 304 && conditional;
        if (!notModified && (status < 200 || status > 299)) {
          throw new SafeFetchError('HTTP_STATUS', {
            statusCode: status,
            hostname: url.hostname,
          });
        }

        const result = {
          requestedUrl,
          finalUrl: url.href,
          redirects,
          status,
          headers: responseHeaders(response),
          body: new Uint8Array(0),
          bytesRead: 0,
        };
        if (notModified || NO_CONTENT_STATUSES.has(status)) {
          return result;
        }
        if (!isAllowedContentType(result.headers.contentType, allowed)) {
          throw new SafeFetchError('UNSUPPORTED_CONTENT_TYPE', {
            hostname: url.hostname,
          });
        }
        if (method === 'HEAD') {
          return result;
        }
        // A declared length over the cap fails before any body is read
        if ((result.headers.contentLength ?? 0) > maxBytes) {
          throw new SafeFetchError('TOO_LARGE', { hostname: url.hostname });
        }

        result.body = await readBody(response, maxBytes, url.hostname);
        result.bytesRead = result.body.byteLength;
        return result;
      }
    } catch (err) {
      if (timedOut && !(err instanceof SafeFetchError)) {
        throw new SafeFetchError('TIMEOUT', { hostname: url.hostname });
      }
      throw toSafeFetchError(err, url.hostname);
    } finally {
      clearTimeout(timer);
      // Releases any response body that was not read to the end
      controller.abort();
    }
  };
}

export const safeFetch = createSafeFetch();
