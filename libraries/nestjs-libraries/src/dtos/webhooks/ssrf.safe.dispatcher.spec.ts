import http from 'node:http';
import dns from 'node:dns';
import { AddressInfo } from 'node:net';
import axios from 'axios';
import { Agent, fetch as undiciFetch } from 'undici';
import * as validator from './webhook.url.validator';
import {
  getSsrfSafeAxios,
  getSsrfSafeDispatcher,
  isBlockedLiteralHost,
  ssrfSafeDispatcher,
} from './ssrf.safe.dispatcher';

// `restoreMocks` only restores before the next test, but server.listen also
// resolves its host through dns.lookup: a DNS spy left over from the last
// test would bind the next beforeAll's servers to the wrong address
afterEach(() => {
  jest.restoreAllMocks();
});

// Local servers only: every blocked case must fail before a TCP connection
// reaches the server, which the connection counter proves
interface LocalServer {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

const startServer = (
  host: string,
  handler: http.RequestListener = (_req, res) => res.end('ok')
) =>
  new Promise<LocalServer>((resolve, reject) => {
    let connections = 0;
    const server = http.createServer(handler);
    server.on('connection', () => connections++);
    server.once('error', reject);
    server.listen(0, host, () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        connections: () => connections,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      })
    );
  });

const blockedReason = async (request: Promise<unknown>) => {
  try {
    await request;
  } catch (err: any) {
    return err?.cause?.message ?? err?.message;
  }
  throw new Error('request was not blocked');
};

describe('ssrfSafeDispatcher', () => {
  let ipv4: LocalServer;
  let ipv6: LocalServer | undefined;

  beforeAll(async () => {
    ipv4 = await startServer('127.0.0.1');
    // CI runners without IPv6 loopback skip only the [::1] case
    ipv6 = await startServer('::1').catch((): undefined => undefined);
  });

  afterAll(async () => {
    await ipv4.close();
    await ipv6?.close();
  });

  it('control: the local server is reachable without the guard', async () => {
    const plain = new Agent();
    const before = ipv4.connections();
    const res = await undiciFetch(`http://127.0.0.1:${ipv4.port}/`, {
      dispatcher: plain,
    });
    expect(await res.text()).toBe('ok');
    expect(ipv4.connections()).toBe(before + 1);
    await plain.close();
  });

  describe('literal IP hosts never connect', () => {
    it.each([
      ['127.0.0.1'],
      ['0x7f.1'],
      ['2130706433'],
      ['017700000001'],
      ['127.1'],
      ['[::ffff:127.0.0.1]'],
      ['[::ffff:7f00:1]'],
    ])('blocks %s with undici fetch', async (host) => {
      const before = ipv4.connections();
      const reason = await blockedReason(
        undiciFetch(`http://${host}:${ipv4.port}/`, {
          dispatcher: ssrfSafeDispatcher,
        })
      );
      expect(reason).toBe('Blocked IP');
      expect(ipv4.connections()).toBe(before);
    });

    it('blocks 127.0.0.1 with the global fetch existing callers use', async () => {
      const before = ipv4.connections();
      const reason = await blockedReason(
        fetch(`http://127.0.0.1:${ipv4.port}/`, {
          // @ts-ignore - undici option, not in lib.dom fetch types
          dispatcher: ssrfSafeDispatcher,
        })
      );
      expect(reason).toBe('Blocked IP');
      expect(ipv4.connections()).toBe(before);
    });

    it('blocks [::1] when IPv6 loopback is available', async () => {
      if (!ipv6) {
        console.warn('IPv6 loopback unavailable, [::1] case skipped');
        return;
      }
      const before = ipv6.connections();
      const reason = await blockedReason(
        undiciFetch(`http://[::1]:${ipv6.port}/`, {
          dispatcher: ssrfSafeDispatcher,
        })
      );
      expect(reason).toBe('Blocked IP');
      expect(ipv6.connections()).toBe(before);
    });
  });

  describe('hostnames still go through the safe lookup', () => {
    const mockLookup = (answers: Array<{ address: string; family: number }>) =>
      jest
        .spyOn(dns, 'lookup')
        .mockImplementation(((_host: string, options: any, cb: any) =>
          // A single-answer lookup only ever gets the loopback address, so a
          // mismatch in how the socket asks can never reach a public IP
          options?.all
            ? cb(null, answers)
            : cb(null, '127.0.0.1', 4)) as any);

    it.each([
      ['a blocked answer', [{ address: '127.0.0.1', family: 4 }]],
      [
        'a mixed answer set',
        [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      ],
      ['a mapped IPv6 answer', [{ address: '::ffff:7f00:1', family: 6 }]],
    ])('rejects %s', async (_label, answers) => {
      const lookup = mockLookup(answers);
      const before = ipv4.connections();
      const reason = await blockedReason(
        undiciFetch(`http://blocked.test:${ipv4.port}/`, {
          dispatcher: ssrfSafeDispatcher,
        })
      );
      expect(reason).toBe('Blocked IP');
      expect(lookup).toHaveBeenCalled();
      expect(lookup.mock.calls[0][0]).toBe('blocked.test');
      expect((lookup.mock.calls[0][1] as any)?.all).toBe(true);
      expect(ipv4.connections()).toBe(before);
    });
  });
});

describe('ssrfSafeAxios', () => {
  // Proxy variables on a developer machine would change how axios routes the
  // requests below; they are cleared for these tests only and restored after
  const envKeys = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
    'DISABLE_SSRF_PROTECTION',
  ];
  const savedEnv: Record<string, string | undefined> = {};
  const realIsBlockedIp = validator.isBlockedIp;

  let ipv4: LocalServer;
  let ipv6: LocalServer | undefined;

  const mockLookup = (answers: Array<{ address: string; family: number }>) =>
    jest
      .spyOn(dns, 'lookup')
      .mockImplementation(((_host: string, options: any, cb: any) =>
        options?.all ? cb(null, answers) : cb(null, '127.0.0.1', 4)) as any);

  // Lets the test treat ::1 as a public address so a hostname can reach a
  // local server through the guard; every other address keeps the real policy
  const treatIPv6LoopbackAsPublic = () =>
    jest
      .spyOn(validator, 'isBlockedIp')
      .mockImplementation((ip) => (ip === '::1' ? false : realIsBlockedIp(ip)));

  beforeAll(async () => {
    envKeys.forEach((key) => {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    });
    ipv4 = await startServer('127.0.0.1');
    ipv6 = await startServer('::1').catch((): undefined => undefined);
  });

  afterAll(async () => {
    envKeys.forEach((key) => {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    await ipv4.close();
    await ipv6?.close();
  });

  it('control: plain axios reaches the local server', async () => {
    const before = ipv4.connections();
    const { data } = await axios.get(`http://127.0.0.1:${ipv4.port}/`);
    expect(data).toBe('ok');
    expect(ipv4.connections()).toBe(before + 1);
  });

  it.each([
    ['127.0.0.1'],
    ['0x7f.1'],
    ['2130706433'],
    ['017700000001'],
    ['127.1'],
    ['[::ffff:127.0.0.1]'],
    ['[::ffff:7f00:1]'],
  ])('blocks literal %s before connecting', async (host) => {
    const before = ipv4.connections();
    const reason = await blockedReason(
      getSsrfSafeAxios().get(`http://${host}:${ipv4.port}/`)
    );
    expect(reason).toBe('Blocked IP');
    expect(ipv4.connections()).toBe(before);
  });

  it('blocks a literal over https before the TLS connection', async () => {
    const before = ipv4.connections();
    const reason = await blockedReason(
      getSsrfSafeAxios().get(`https://127.0.0.1:${ipv4.port}/`)
    );
    expect(reason).toBe('Blocked IP');
    expect(ipv4.connections()).toBe(before);
  });

  it('blocks [::1] when IPv6 loopback is available', async () => {
    if (!ipv6) {
      console.warn('IPv6 loopback unavailable, [::1] case skipped');
      return;
    }
    const before = ipv6.connections();
    const reason = await blockedReason(
      getSsrfSafeAxios().get(`http://[::1]:${ipv6.port}/`)
    );
    expect(reason).toBe('Blocked IP');
    expect(ipv6.connections()).toBe(before);
  });

  it.each([
    ['a blocked answer', [{ address: '127.0.0.1', family: 4 }]],
    [
      'a mixed answer set',
      [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    ],
  ])('keeps the safe lookup for hostnames: rejects %s', async (_l, answers) => {
    const lookup = mockLookup(answers);
    const before = ipv4.connections();
    const reason = await blockedReason(
      getSsrfSafeAxios().get(`http://blocked.test:${ipv4.port}/`)
    );
    expect(reason).toBe('Blocked IP');
    expect(lookup.mock.calls[0][0]).toBe('blocked.test');
    expect((lookup.mock.calls[0][1] as any)?.all).toBe(true);
    expect(ipv4.connections()).toBe(before);
  });

  it('blocks a redirect to a literal private target', async () => {
    if (!ipv6) {
      console.warn('IPv6 loopback unavailable, redirect case skipped');
      return;
    }
    let targetRequests = 0;
    const target = await startServer('127.0.0.1', (_req, res) => {
      targetRequests++;
      res.end('secret');
    });
    let sourceRequests = 0;
    const source = await startServer('::1', (_req, res) => {
      sourceRequests++;
      res.writeHead(302, {
        Location: `http://127.0.0.1:${target.port}/secret`,
      });
      res.end();
    });

    try {
      mockLookup([{ address: '::1', family: 6 }]);
      treatIPv6LoopbackAsPublic();

      const reason = await blockedReason(
        getSsrfSafeAxios().get(`http://redirector.test:${source.port}/`)
      );
      expect(reason).toBe('Blocked IP');
      expect(sourceRequests).toBe(1);
      expect(targetRequests).toBe(0);
      expect(target.connections()).toBe(0);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('hands allowed https connections to the normal TLS path', async () => {
    if (!ipv6) {
      console.warn('IPv6 loopback unavailable, TLS delegation case skipped');
      return;
    }
    mockLookup([{ address: '::1', family: 6 }]);
    treatIPv6LoopbackAsPublic();
    const before = ipv6.connections();

    // The plain HTTP server can't answer a TLS ClientHello: a TLS error (not
    // "Blocked IP") proves the connection went through Node's https agent
    const reason = await blockedReason(
      getSsrfSafeAxios().get(`https://tls.test:${ipv6.port}/`)
    );
    expect(reason).not.toBe('Blocked IP');
    expect(String(reason)).toMatch(/SSL|TLS|EPROTO|wrong version|socket/i);
    expect(ipv6.connections()).toBe(before + 1);
  });

  describe('proxy behaviour is unchanged', () => {
    let proxied: string[];
    let proxy: LocalServer;

    beforeAll(async () => {
      proxy = await startServer('127.0.0.1', (req, res) => {
        proxied.push(req.url || '');
        res.end('proxied');
      });
    });

    beforeEach(() => {
      proxied = [];
      // Any accidental direct lookup of the target fails instead of leaving
      mockLookup([{ address: '127.0.0.1', family: 4 }]);
    });

    afterEach(() => {
      delete process.env.HTTP_PROXY;
    });

    afterAll(async () => {
      await proxy.close();
    });

    it('still reaches a literal-IP forward proxy from config', async () => {
      const { data } = await getSsrfSafeAxios().get(
        'http://target.test/path',
        { proxy: { protocol: 'http', host: '127.0.0.1', port: proxy.port } }
      );
      expect(data).toBe('proxied');
      expect(proxied).toEqual(['http://target.test/path']);
    });

    it('still reaches a literal-IP forward proxy from HTTP_PROXY', async () => {
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
      const { data } = await getSsrfSafeAxios().get('http://target.test/env');
      expect(data).toBe('proxied');
      expect(proxied).toEqual(['http://target.test/env']);
    });
  });
});

describe('getSsrfSafeAxios', () => {
  const original = process.env.DISABLE_SSRF_PROTECTION;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DISABLE_SSRF_PROTECTION;
    } else {
      process.env.DISABLE_SSRF_PROTECTION = original;
    }
  });

  it.each([
    [undefined, true],
    ['false', true],
    ['TRUE', true],
    ['true', false],
  ])('DISABLE_SSRF_PROTECTION=%p guarded=%s', (value, guarded) => {
    delete process.env.DISABLE_SSRF_PROTECTION;
    const protectedInstance = getSsrfSafeAxios();
    if (value !== undefined) {
      process.env.DISABLE_SSRF_PROTECTION = value;
    }
    const instance = getSsrfSafeAxios();
    expect(protectedInstance).not.toBe(axios);
    expect(instance).toBe(guarded ? protectedInstance : axios);
  });
});

describe('isBlockedLiteralHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['::1', true],
    ['[::1]', true],
    ['[::ffff:7f00:1]', true],
    ['[64:ff9b::7f00:1]', true],
    ['8.8.8.8', false],
    ['[2606:4700:4700::1111]', false],
    ['[64:ff9b::808:808]', false],
    ['example.com', false],
    ['localhost', false],
  ])('%s -> %s', (host, blocked) => {
    expect(isBlockedLiteralHost(host)).toBe(blocked);
  });
});

describe('getSsrfSafeDispatcher', () => {
  const original = process.env.DISABLE_SSRF_PROTECTION;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.DISABLE_SSRF_PROTECTION;
    } else {
      process.env.DISABLE_SSRF_PROTECTION = original;
    }
  });

  it.each([
    [undefined, true],
    ['false', true],
    ['TRUE', true],
    ['true', false],
  ])('DISABLE_SSRF_PROTECTION=%p guarded=%s', (value, guarded) => {
    if (value === undefined) {
      delete process.env.DISABLE_SSRF_PROTECTION;
    } else {
      process.env.DISABLE_SSRF_PROTECTION = value;
    }
    expect(getSsrfSafeDispatcher()).toBe(
      guarded ? ssrfSafeDispatcher : undefined
    );
  });
});
