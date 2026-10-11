import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net, { AddressInfo } from 'node:net';
import tls from 'node:tls';
import util from 'node:util';
import zlib from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import * as validator from './webhook.url.validator';
import {
  createSafeFetch,
  safeFetch,
  SafeFetchError,
  SafeFetchPolicy,
} from './safe.fetch';

// Throwaway self-signed certificate for `secure.test`, generated for this spec
// only. It is trusted solely by the tls.connect spy below and protects nothing
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUcPhFtOycdcbq3WkAuzZOsbw+DAYwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLc2VjdXJlLnRlc3QwIBcNMjYxMDExMjA0OTIzWhgPMjEyNjA5
MTcyMDQ5MjNaMBYxFDASBgNVBAMMC3NlY3VyZS50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE4dRZp2ucSZO9V0HP5Xm4YuhbgmKIxdqJxSInep15OMI6yj20
W3VAE8gflZAFj9vXjyZbH+vDuOBaaec/ivzhk6NrMGkwHQYDVR0OBBYEFF7KeIuH
8JFoMCln1SmpTd7ECasHMB8GA1UdIwQYMBaAFF7KeIuH8JFoMCln1SmpTd7ECasH
MA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILc2VjdXJlLnRlc3QwCgYIKoZI
zj0EAwIDSQAwRgIhAMsvan8IECGNgSQpHhn+tTqEDmhjKQ1Q3Xi/IlVFwDrsAiEA
zWv8E/wPG9cSc3cdfO604HGYWSpyMiMTJnem/Jo59ZY=
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxmd/v7nfeyEJAk1N
moEbpx4m6gjrjzbpn8z5ROKvSi+hRANCAATh1Fmna5xJk71XQc/lebhi6FuCYojF
2onFIid6nXk4wjrKPbRbdUATyB+VkAWP29ePJlsf68O44Fpp5z+K/OGT
-----END PRIVATE KEY-----`;

// ::1 stands in for a public address: the isBlockedIp spy lets only ::1
// through, so 127.0.0.1, mapped addresses and every other private range keep
// the real policy. Test hostnames resolve through the dns.lookup spy only
const HOSTS: Record<string, string[]> = {
  'public.test': ['::1'],
  'other.test': ['::1'],
  'secure.test': ['::1'],
  'private.test': ['127.0.0.1'],
  'mixed.test': ['::1', '127.0.0.1'],
  'mapped.test': ['::ffff:127.0.0.1'],
};

const realLookup = dns.lookup;
const realIsBlockedIp = validator.isBlockedIp;
const realTlsConnect = tls.connect;

beforeEach(() => {
  jest
    .spyOn(validator, 'isBlockedIp')
    .mockImplementation((ip) => ip !== '::1' && realIsBlockedIp(ip));
  jest.spyOn(dns, 'lookup').mockImplementation(((
    host: string,
    options: any,
    callback: any
  ) => {
    if (net.isIP(host)) {
      return realLookup(host, options, callback);
    }
    const answers = HOSTS[host];
    process.nextTick(() => {
      if (!answers) {
        return callback(
          Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
            code: 'ENOTFOUND',
          })
        );
      }
      const records = answers.map((address) => ({
        address,
        family: net.isIP(address),
      }));
      return options?.all
        ? callback(null, records)
        : callback(null, records[0].address, records[0].family);
    });
  }) as any);
  jest
    .spyOn(tls, 'connect')
    .mockImplementation(((options: tls.ConnectionOptions, ...rest: any[]) =>
      realTlsConnect({ ...options, ca: [TEST_CERT] }, ...rest)) as any);
});

// `restoreMocks` only restores before the next test, but server.listen also
// resolves its host through dns.lookup
afterEach(() => {
  jest.restoreAllMocks();
});

interface LocalServer {
  port: number;
  connections: () => number;
  requests: Array<{
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
  }>;
  close: () => Promise<void>;
}

const startServer = (
  host: string,
  handler: http.RequestListener,
  secure = false
) =>
  new Promise<LocalServer>((resolve, reject) => {
    let connections = 0;
    const requests: LocalServer['requests'] = [];
    const listener: http.RequestListener = (req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    };
    const server = secure
      ? https.createServer({ key: TEST_KEY, cert: TEST_CERT }, listener)
      : http.createServer(listener);
    server.on(secure ? 'secureConnection' : 'connection', () => connections++);
    server.once('error', reject);
    server.listen(0, host, () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        connections: () => connections,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      })
    );
  });

const failure = async (request: Promise<unknown>) => {
  try {
    await request;
  } catch (err) {
    if (err instanceof SafeFetchError) {
      return err;
    }
    throw err;
  }
  throw new Error('request did not fail');
};

const text = (body: Uint8Array) => Buffer.from(body).toString();

const lastRequest = () =>
  publicServer.requests[publicServer.requests.length - 1];

// Keeps a handler's pending timers from outliving its connection
const onClose = (req: http.IncomingMessage, timer: NodeJS.Timeout) =>
  req.socket.once('close', () => clearTimeout(timer));

let publicServer: LocalServer;
let privateServer: LocalServer;
let secureServer: LocalServer;
let proxyServer: LocalServer;

const route: http.RequestListener = (req, res) => {
  const { pathname, searchParams } = new URL(req.url || '/', 'http://local');
  const port = req.socket.localPort;
  const redirect = (status: number, location?: string) => {
    res.writeHead(status, location ? { location } : {});
    res.end();
  };

  if (pathname === '/article') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': 5,
      'content-language': 'nl',
      etag: '"v1"',
      'last-modified': 'Sun, 11 Oct 2026 10:00:00 GMT',
      'set-cookie': 'session=secret',
    });
    return res.end(req.method === 'HEAD' ? undefined : 'hello');
  }
  if (pathname === '/final') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('final');
  }
  if (pathname === '/relative') return redirect(302, 'final');
  if (pathname === '/absolute') {
    return redirect(301, `http://other.test:${port}/final`);
  }
  if (pathname.startsWith('/status/')) {
    return redirect(Number(pathname.slice(8)), '/final');
  }
  if (pathname === '/loop') return redirect(302, '/loop');
  if (pathname === '/loop-a') return redirect(302, '/loop-b');
  if (pathname === '/loop-b') return redirect(302, '/loop-a');
  if (pathname.startsWith('/chain/')) {
    return redirect(302, `/chain/${Number(pathname.slice(7)) + 1}`);
  }
  if (pathname === '/no-location') return redirect(302);
  if (pathname === '/bad-location') return redirect(302, 'http://[::1');
  if (pathname === '/to-ftp') return redirect(302, 'ftp://public.test/file');
  if (pathname === '/to-private-literal') {
    return redirect(302, `http://127.0.0.1:${privateServer.port}/secret`);
  }
  if (pathname === '/to-private-dns') {
    return redirect(302, `http://private.test:${privateServer.port}/secret`);
  }
  if (pathname === '/to-other-with-cookie') {
    res.writeHead(302, {
      location: `http://other.test:${port}/final`,
      'set-cookie': 'session=secret',
    });
    return res.end();
  }
  if (pathname.startsWith('/missing/')) {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('SECRET-BODY');
  }
  if (pathname === '/error') {
    res.writeHead(500, { 'content-type': 'text/html' });
    return res.end('SECRET-BODY');
  }
  if (pathname === '/not-modified') {
    res.writeHead(304);
    return res.end();
  }
  if (pathname === '/type') {
    const type = searchParams.get('value');
    res.writeHead(200, type ? { 'content-type': type } : {});
    return res.end('typed');
  }
  if (pathname === '/size') {
    const body = Buffer.alloc(Number(searchParams.get('bytes')), 'x');
    if (searchParams.get('chunked')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write(body.subarray(0, body.length >> 1));
      return res.end(body.subarray(body.length >> 1));
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': body.length,
    });
    return res.end(body);
  }
  if (pathname === '/declared-large') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': 10_000_000,
    });
    return res.write('x');
  }
  if (pathname === '/gzip') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
    });
    const bytes = Number(searchParams.get('bytes'));
    return res.end(zlib.gzipSync(Buffer.alloc(bytes, 'x')));
  }
  if (pathname === '/br') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'br',
    });
    return res.end(zlib.brotliCompressSync(Buffer.alloc(2 * 1024 * 1024)));
  }
  if (pathname === '/empty-gzip-members') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
    });
    // 200 empty gzip members: about 4000 bytes on the wire, nothing decoded
    return res.end(Buffer.concat(Array(200).fill(zlib.gzipSync(''))));
  }
  if (pathname === '/slow-headers') {
    return onClose(
      req,
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }, 3000)
    );
  }
  if (pathname === '/stall-body') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.write('x');
  }
  if (pathname === '/trickle') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => res.write('x'), 100);
    return onClose(req, timer);
  }
  res.writeHead(404);
  res.end();
};

beforeAll(async () => {
  publicServer = await startServer('::1', route);
  privateServer = await startServer('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('secret');
  });
  secureServer = await startServer(
    '::1',
    (req, res) => {
      if (req.url === '/downgrade') {
        res.writeHead(302, {
          location: `http://public.test:${publicServer.port}/final`,
        });
        return res.end();
      }
      if (req.url === '/to-ok') {
        res.writeHead(302, { location: '/ok' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('secure');
    },
    true
  );
  proxyServer = await startServer('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('proxied');
  });
});

afterAll(async () => {
  await Promise.all(
    [publicServer, privateServer, secureServer, proxyServer].map((server) =>
      server?.close()
    )
  );
});

// Local-only policy: plain http and the ephemeral test ports, nothing else
const localFetch = (policy: SafeFetchPolicy = {}) =>
  createSafeFetch({
    allowHttp: true,
    allowedPorts: [publicServer.port, privateServer.port, secureServer.port],
    ...policy,
  });

const HTML = ['text/html'];

describe('safeFetch', () => {
  describe('basic success', () => {
    it('returns the capped body and the safe metadata', async () => {
      const url = `http://public.test:${publicServer.port}/article`;
      const result = await localFetch()(url, { allowedContentTypes: HTML });

      expect(text(result.body)).toBe('hello');
      expect(result).toMatchObject({
        requestedUrl: url,
        finalUrl: url,
        redirects: [],
        status: 200,
        bytesRead: 5,
        headers: {
          contentType: 'text/html; charset=utf-8',
          contentLength: 5,
          contentLanguage: 'nl',
          etag: '"v1"',
          lastModified: 'Sun, 11 Oct 2026 10:00:00 GMT',
        },
      });
      expect(result.headers.date).toEqual(expect.any(String));
      expect(JSON.stringify(result.headers)).not.toContain('session');
    });

    it('sends only the fixed request headers', async () => {
      await localFetch()(`http://public.test:${publicServer.port}/article`, {
        allowedContentTypes: ['text/html', 'application/xhtml+xml'],
      });
      const { method, headers } = lastRequest();

      expect(method).toBe('GET');
      expect(headers['user-agent']).toBe('Postiz-SafeFetch/1.0');
      expect(headers.accept).toBe('text/html, application/xhtml+xml');
      expect(headers.host).toBe(`public.test:${publicServer.port}`);
      expect(headers).not.toHaveProperty('cookie');
      expect(headers).not.toHaveProperty('authorization');
      expect(headers).not.toHaveProperty('proxy-authorization');
      expect(headers).not.toHaveProperty('referer');
    });

    it('classifies a literal IP by the IP rules, not the hostname rules', async () => {
      const result = await localFetch()(
        `http://[::1]:${publicServer.port}/article`,
        { allowedContentTypes: HTML }
      );
      expect(result.status).toBe(200);
    });

    it('fetches over https with normal certificate verification', async () => {
      const result = await localFetch()(
        `https://secure.test:${secureServer.port}/to-ok`,
        { allowedContentTypes: HTML }
      );
      expect(text(result.body)).toBe('secure');
      expect(result.finalUrl).toBe(
        `https://secure.test:${secureServer.port}/ok`
      );
    });
  });

  describe('production instance', () => {
    const disable = process.env.DISABLE_SSRF_PROTECTION;

    beforeEach(() => {
      process.env.DISABLE_SSRF_PROTECTION = 'true';
    });

    afterEach(() => {
      if (disable === undefined) {
        delete process.env.DISABLE_SSRF_PROTECTION;
      } else {
        process.env.DISABLE_SSRF_PROTECTION = disable;
      }
    });

    it('still blocks a private literal with DISABLE_SSRF_PROTECTION=true', async () => {
      const err = await failure(
        safeFetch('https://127.0.0.1/', { allowedContentTypes: HTML })
      );
      expect(err.category).toBe('BLOCKED_DESTINATION');
    });

    it('still blocks a hostname resolving to a private address', async () => {
      const err = await failure(
        safeFetch('https://private.test/', { allowedContentTypes: HTML })
      );
      expect(err.category).toBe('BLOCKED_DESTINATION');
    });

    it.each([
      ['http://public.test/', 'UNSUPPORTED_SCHEME'],
      ['https://public.test:8443/', 'UNSUPPORTED_PORT'],
      ['https://public.test:80/', 'UNSUPPORTED_PORT'],
    ])('defaults to https on 443 only: %s', async (url, category) => {
      const err = await failure(safeFetch(url, { allowedContentTypes: HTML }));
      expect(err.category).toBe(category);
    });
  });

  describe('URL validation', () => {
    it.each([
      ['not a url', 'INVALID_URL'],
      ['', 'INVALID_URL'],
      [`http://public.test/${'a'.repeat(2048)}`, 'INVALID_URL'],
      ['ftp://public.test/file', 'UNSUPPORTED_SCHEME'],
      ['file:///etc/passwd', 'UNSUPPORTED_SCHEME'],
      ['javascript:alert(1)', 'UNSUPPORTED_SCHEME'],
      ['http://user:pass@public.test/', 'INVALID_URL'],
      ['http://user@public.test/', 'INVALID_URL'],
      ['http://public.test:1/', 'UNSUPPORTED_PORT'],
    ])('rejects %p as %s', async (url, category) => {
      const err = await failure(
        localFetch()(url, { allowedContentTypes: HTML })
      );
      expect(err.category).toBe(category);
    });

    it.each([
      ['localhost'],
      ['LOCALHOST'],
      ['localhost.'],
      ['app.localhost'],
      ['printer.local'],
      ['db.internal'],
      ['router.home.arpa'],
      ['intranet'],
      ['127.0.0.1'],
      ['0x7f.1'],
      ['169.254.169.254'],
      ['[::ffff:127.0.0.1]'],
    ])('blocks local destination %s before connecting', async (host) => {
      const before = privateServer.connections() + publicServer.connections();
      const err = await failure(
        localFetch()(`http://${host}:${privateServer.port}/`, {
          allowedContentTypes: HTML,
        })
      );
      expect(err.category).toBe('BLOCKED_DESTINATION');
      expect(privateServer.connections() + publicServer.connections()).toBe(
        before
      );
    });

    it('strips the fragment before the request', async () => {
      const result = await localFetch()(
        `http://public.test:${publicServer.port}/article?q=1#section`,
        { allowedContentTypes: HTML }
      );
      expect(lastRequest().url).toBe('/article?q=1');
      expect(result.requestedUrl).toBe(
        `http://public.test:${publicServer.port}/article?q=1`
      );
    });
  });

  describe('redirects', () => {
    const base = () => `http://public.test:${publicServer.port}`;

    it('follows a relative redirect', async () => {
      const result = await localFetch()(`${base()}/relative`, {
        allowedContentTypes: HTML,
      });
      expect(text(result.body)).toBe('final');
      expect(result.finalUrl).toBe(`${base()}/final`);
      expect(result.redirects).toEqual([
        { url: `${base()}/relative`, status: 302 },
      ]);
    });

    it('follows an absolute cross-origin redirect without cookies', async () => {
      const result = await localFetch()(`${base()}/to-other-with-cookie`, {
        allowedContentTypes: HTML,
        headers: { 'Accept-Language': 'nl' },
      });
      const { headers } = lastRequest();

      expect(result.finalUrl).toBe(
        `http://other.test:${publicServer.port}/final`
      );
      expect(headers.host).toBe(`other.test:${publicServer.port}`);
      expect(headers['accept-language']).toBe('nl');
      expect(headers).not.toHaveProperty('cookie');
      expect(headers).not.toHaveProperty('referer');
    });

    it('follows a 301 absolute redirect', async () => {
      const result = await localFetch()(`${base()}/absolute`, {
        allowedContentTypes: HTML,
      });
      expect(result.status).toBe(200);
      expect(result.redirects[0].status).toBe(301);
    });

    it.each([[301], [302], [303], [307], [308]])(
      'keeps GET and HEAD on %s',
      async (status) => {
        for (const method of ['GET', 'HEAD'] as const) {
          const result = await localFetch()(`${base()}/status/${status}`, {
            method,
            allowedContentTypes: HTML,
          });
          expect(result.redirects).toEqual([
            { url: `${base()}/status/${status}`, status },
          ]);
          expect(lastRequest()).toMatchObject({
            method,
            url: '/final',
          });
        }
      }
    );

    it.each([['/loop'], ['/loop-a']])('rejects the loop %s', async (path) => {
      const err = await failure(
        localFetch()(`${base()}${path}`, { allowedContentTypes: HTML })
      );
      expect(err.category).toBe('REDIRECT_LOOP');
    });

    it('stops after 5 redirects', async () => {
      const before = publicServer.requests.length;
      const err = await failure(
        localFetch()(`${base()}/chain/0`, { allowedContentTypes: HTML })
      );
      expect(err.category).toBe('TOO_MANY_REDIRECTS');
      expect(publicServer.requests.length - before).toBe(6);
    });

    it('honours a lower maxRedirects policy', async () => {
      const err = await failure(
        localFetch({ maxRedirects: 0 })(`${base()}/relative`, {
          allowedContentTypes: HTML,
        })
      );
      expect(err.category).toBe('TOO_MANY_REDIRECTS');
    });

    it.each([
      ['/no-location', 'REDIRECT_INVALID'],
      ['/bad-location', 'REDIRECT_INVALID'],
      ['/to-ftp', 'UNSUPPORTED_SCHEME'],
    ])('rejects %s as %s', async (path, category) => {
      const err = await failure(
        localFetch()(`${base()}${path}`, { allowedContentTypes: HTML })
      );
      expect(err.category).toBe(category);
    });

    it('blocks an https -> http downgrade before the http request', async () => {
      const before = publicServer.connections();
      const err = await failure(
        localFetch()(`https://secure.test:${secureServer.port}/downgrade`, {
          allowedContentTypes: HTML,
        })
      );
      expect(err.category).toBe('DOWNGRADE_BLOCKED');
      expect(publicServer.connections()).toBe(before);
    });

    it.each([['/to-private-literal'], ['/to-private-dns']])(
      'blocks %s without reaching the private target',
      async (path) => {
        const before = privateServer.connections();
        const err = await failure(
          localFetch()(`${base()}${path}`, { allowedContentTypes: HTML })
        );
        expect(err.category).toBe('BLOCKED_DESTINATION');
        expect(privateServer.connections()).toBe(before);
      }
    );
  });

  describe('DNS', () => {
    it.each([['private.test'], ['mixed.test'], ['mapped.test']])(
      'blocks %s at connect time',
      async (host) => {
        const before = privateServer.connections() + publicServer.connections();
        const err = await failure(
          localFetch()(`http://${host}:${privateServer.port}/`, {
            allowedContentTypes: HTML,
          })
        );
        expect(err.category).toBe('BLOCKED_DESTINATION');
        expect(err.hostname).toBe(host);
        expect(privateServer.connections() + publicServer.connections()).toBe(
          before
        );
      }
    );

    it('checks every answer of the lookup', async () => {
      await failure(
        localFetch()(`http://mixed.test:${publicServer.port}/`, {
          allowedContentTypes: HTML,
        })
      );
      expect(dns.lookup).toHaveBeenCalledWith(
        'mixed.test',
        expect.objectContaining({ all: true }),
        expect.any(Function)
      );
    });

    it('maps a failed lookup to DNS_FAILURE', async () => {
      const err = await failure(
        localFetch()(`http://nxdomain.test:${publicServer.port}/`, {
          allowedContentTypes: HTML,
        })
      );
      expect(err.category).toBe('DNS_FAILURE');
    });
  });

  describe('status', () => {
    it.each([
      ['/missing/page', 404],
      ['/error', 500],
      ['/not-modified', 304],
    ])('rejects %s as HTTP_STATUS %s', async (path, statusCode) => {
      const err = await failure(
        localFetch()(`http://public.test:${publicServer.port}${path}`, {
          allowedContentTypes: HTML,
        })
      );
      expect(err).toMatchObject({ category: 'HTTP_STATUS', statusCode });
      expect(JSON.stringify(err)).not.toContain('SECRET-BODY');
      expect(util.inspect(err)).not.toContain('SECRET-BODY');
    });

    it('returns 304 with an empty body for a conditional request', async () => {
      const result = await localFetch()(
        `http://public.test:${publicServer.port}/not-modified`,
        { allowedContentTypes: HTML, headers: { 'If-None-Match': '"v1"' } }
      );
      expect(result.status).toBe(304);
      expect(result.bytesRead).toBe(0);
      expect(lastRequest().headers['if-none-match']).toBe('"v1"');
    });
  });

  describe('content type', () => {
    const fetchType = (type: string | null, allowedContentTypes: string[]) =>
      localFetch()(
        `http://public.test:${publicServer.port}/type${
          type ? `?value=${encodeURIComponent(type)}` : ''
        }`,
        { allowedContentTypes }
      );

    it.each([
      ['application/rss+xml', ['application/rss+xml']],
      ['text/html; charset=ISO-8859-1', ['TEXT/HTML']],
      ['Text/HTML', ['text/html']],
      ['image/png', ['image/*']],
    ])('accepts %s for %j', async (type, allowed) => {
      const result = await fetchType(type, allowed);
      expect(result.headers.contentType).toBe(type);
    });

    it.each([
      ['application/json', ['text/html']],
      ['text/html', ['image/*']],
      ['imagex/png', ['image/*']],
      ['text/html/extra', ['text/html']],
      [null, ['text/html']],
    ])('rejects %p for %j', async (type, allowed) => {
      const err = await failure(fetchType(type, allowed));
      expect(err.category).toBe('UNSUPPORTED_CONTENT_TYPE');
    });

    it.each([[[]], [['*/*']], [['html']]])(
      'rejects the allowlist %j',
      async (allowed) => {
        const err = await failure(fetchType('text/html', allowed));
        expect(err.category).toBe('INVALID_REQUEST');
      }
    );
  });

  describe('size', () => {
    const fetchPath = (path: string, maxBytes?: number) =>
      localFetch({ maxBytes: 1024 })(
        `http://public.test:${publicServer.port}${path}`,
        { allowedContentTypes: ['text/plain'], maxBytes }
      );

    it('accepts a body of exactly maxBytes', async () => {
      const result = await fetchPath('/size?bytes=1024');
      expect(result.bytesRead).toBe(1024);
    });

    it.each([['/size?bytes=1025'], ['/size?bytes=1025&chunked=1']])(
      'rejects %s',
      async (path) => {
        const err = await failure(fetchPath(path));
        expect(err.category).toBe('TOO_LARGE');
      }
    );

    it('rejects a declared length before reading the body', async () => {
      const err = await failure(fetchPath('/declared-large'));
      expect(err.category).toBe('TOO_LARGE');
    });

    it('applies a smaller per-request cap to the streamed body', async () => {
      const ok = await fetchPath('/size?bytes=100&chunked=1', 100);
      expect(ok.bytesRead).toBe(100);
      const err = await failure(fetchPath('/size?bytes=101&chunked=1', 100));
      expect(err.category).toBe('TOO_LARGE');
    });

    it('rejects a per-request cap above the policy', async () => {
      const err = await failure(fetchPath('/size?bytes=1', 1025));
      expect(err.category).toBe('INVALID_REQUEST');
    });

    it('counts decoded bytes of a compressed response', async () => {
      const result = await fetchPath('/gzip?bytes=500');
      expect(text(result.body)).toBe('x'.repeat(500));
      expect(result.bytesRead).toBe(500);
      expect(result.headers.contentEncoding).toBe('gzip');
    });

    it.each([['/gzip?bytes=1048576'], ['/br']])(
      'stops a compressed response inflating past the cap: %s',
      async (path) => {
        const err = await failure(
          localFetch({ maxBytes: 64 * 1024 })(
            `http://public.test:${publicServer.port}${path}`,
            { allowedContentTypes: ['text/plain'] }
          )
        );
        expect(err.category).toBe('TOO_LARGE');
      }
    );

    it('caps wire bytes that decode to nothing', async () => {
      const url = `http://public.test:${publicServer.port}/empty-gzip-members`;
      // Control: without the wire cap this response decodes to an empty body
      const plain = new Agent();
      const control = await undiciFetch(url, { dispatcher: plain });
      expect(await control.text()).toBe('');
      await plain.close();

      const err = await failure(fetchPath('/empty-gzip-members'));
      expect(err.category).toBe('TOO_LARGE');
    });
  });

  describe('timeouts', () => {
    const timed = async (path: string, policy: SafeFetchPolicy) => {
      const started = Date.now();
      const err = await failure(
        localFetch(policy)(`http://public.test:${publicServer.port}${path}`, {
          allowedContentTypes: ['text/plain'],
        })
      );
      return { err, elapsed: Date.now() - started };
    };

    it('times out waiting for headers', async () => {
      const { err, elapsed } = await timed('/slow-headers', {
        headersTimeoutMs: 300,
      });
      expect(err.category).toBe('TIMEOUT');
      expect(elapsed).toBeLessThan(2500);
    });

    it('times out when the body stalls', async () => {
      const { err, elapsed } = await timed('/stall-body', {
        bodyTimeoutMs: 300,
      });
      expect(err.category).toBe('TIMEOUT');
      expect(elapsed).toBeLessThan(2500);
    });

    it('enforces the overall deadline on a trickling body', async () => {
      const { err, elapsed } = await timed('/trickle', { timeoutMs: 600 });
      expect(err.category).toBe('TIMEOUT');
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(2500);
    });
  });

  describe('proxy environment', () => {
    const KEYS = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
    ];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      const proxy = `http://127.0.0.1:${proxyServer.port}`;
      for (const key of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ]) {
        process.env[key] = proxy;
      }
    });

    afterEach(() => {
      for (const key of KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    });

    it('never sends a request through the proxy', async () => {
      const before = proxyServer.connections();
      const plain = await localFetch()(
        `http://public.test:${publicServer.port}/final`,
        { allowedContentTypes: HTML }
      );
      const secure = await localFetch()(
        `https://secure.test:${secureServer.port}/ok`,
        { allowedContentTypes: HTML }
      );
      expect(text(plain.body)).toBe('final');
      expect(text(secure.body)).toBe('secure');
      expect(proxyServer.connections()).toBe(before);
      expect(proxyServer.requests).toHaveLength(0);
    });
  });

  describe('error redaction', () => {
    const secrets = [
      'secret-path-123',
      'SECRET-TOKEN-456',
      'SECRET-BODY',
      '127.0.0.1',
    ];

    it.each([
      [
        `http://public.test:{port}/missing/secret-path-123?token=SECRET-TOKEN-456`,
      ],
      [`http://nxdomain.test:{port}/secret-path-123?token=SECRET-TOKEN-456`],
      [`http://private.test:{port}/secret-path-123?token=SECRET-TOKEN-456`],
      [`http://user:SECRET-TOKEN-456@public.test:{port}/secret-path-123`],
      [`https://secure.test:{port}/secret-path-123?token=SECRET-TOKEN-456`],
    ])('keeps %s out of the error', async (template) => {
      const url = template.replace('{port}', String(publicServer.port));
      const err = await failure(
        localFetch()(url, { allowedContentTypes: ['application/json'] })
      );
      const serialized = [
        JSON.stringify(err),
        String(err),
        err.message,
        err.stack,
        util.inspect(err),
      ].join('\n');

      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
      expect(err).not.toHaveProperty('cause');
    });
  });

  describe('request headers', () => {
    it('passes the allowlisted headers', async () => {
      await localFetch()(`http://public.test:${publicServer.port}/article`, {
        allowedContentTypes: HTML,
        headers: {
          Accept: 'text/html;q=0.9',
          'Accept-Language': 'nl-NL',
          'If-Modified-Since': 'Sun, 11 Oct 2026 10:00:00 GMT',
        },
      });
      expect(lastRequest().headers).toMatchObject({
        accept: 'text/html;q=0.9',
        'accept-language': 'nl-NL',
        'if-modified-since': 'Sun, 11 Oct 2026 10:00:00 GMT',
      });
    });

    it.each([
      [{ Authorization: 'Bearer token' }],
      [{ Cookie: 'session=1' }],
      [{ 'Proxy-Authorization': 'Basic x' }],
      [{ Referer: 'https://postiz.com' }],
      [{ Host: 'other.test' }],
      [{ 'X-Api-Key': 'key' }],
      [{ Accept: 'text/html\r\nX-Injected: 1' }],
    ])('rejects %j before any request', async (headers) => {
      const before = publicServer.requests.length;
      const err = await failure(
        localFetch()(`http://public.test:${publicServer.port}/article`, {
          allowedContentTypes: HTML,
          headers,
        })
      );
      expect(err.category).toBe('INVALID_REQUEST');
      expect(publicServer.requests.length).toBe(before);
    });

    it('rejects methods other than GET and HEAD', async () => {
      const err = await failure(
        localFetch()(`http://public.test:${publicServer.port}/article`, {
          method: 'POST' as any,
          allowedContentTypes: HTML,
        })
      );
      expect(err.category).toBe('INVALID_REQUEST');
    });
  });

  describe('HEAD', () => {
    it('returns the metadata with an empty body', async () => {
      const result = await localFetch()(
        `http://public.test:${publicServer.port}/article`,
        { method: 'HEAD', allowedContentTypes: HTML }
      );
      expect(lastRequest().method).toBe('HEAD');
      expect(result.status).toBe(200);
      expect(result.body.byteLength).toBe(0);
      expect(result.bytesRead).toBe(0);
      expect(result.headers).toMatchObject({
        contentType: 'text/html; charset=utf-8',
        contentLength: 5,
      });
    });
  });

  describe('createSafeFetch policy bounds', () => {
    it.each([
      [{ maxBytes: 50 * 1024 * 1024 + 1 }],
      [{ maxBytes: 0 }],
      [{ timeoutMs: 0 }],
      [{ timeoutMs: 120001 }],
      [{ headersTimeoutMs: 60001 }],
      [{ bodyTimeoutMs: 1.5 }],
      [{ maxRedirects: 11 }],
      [{ allowedPorts: [0] }],
      [{ allowedPorts: [65536] }],
    ])('rejects %j', (policy) => {
      expect(() => createSafeFetch(policy)).toThrow(SafeFetchError);
    });
  });
});
