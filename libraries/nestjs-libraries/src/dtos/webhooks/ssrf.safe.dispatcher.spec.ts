import http from 'node:http';
import dns from 'node:dns';
import { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  getSsrfSafeDispatcher,
  isBlockedLiteralHost,
  ssrfSafeDispatcher,
} from './ssrf.safe.dispatcher';

// Local servers only: every blocked case must fail before a TCP connection
// reaches the server, which the connection counter proves
interface LocalServer {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

const startServer = (host: string) =>
  new Promise<LocalServer>((resolve, reject) => {
    let connections = 0;
    const server = http.createServer((_req, res) => res.end('ok'));
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
