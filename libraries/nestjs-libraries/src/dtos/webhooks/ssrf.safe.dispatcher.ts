import { Agent, buildConnector } from 'undici';
import axios, { AxiosInstance } from 'axios';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { isBlockedIp } from './webhook.url.validator';

// Pins DNS resolution: every resolved IP is checked with `isBlockedIp` and
// the caller connects to that same set. Closes the TOCTOU window
// `isSafePublicHttpsUrl` alone leaves open (see GHSA-f7jj-p389-4w45).
function ssrfSafeLookup(
  hostname: string,
  options: any,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: any,
    family?: number
  ) => void
) {
  if (net.isIP(hostname)) {
    const family = net.isIP(hostname);
    if (isBlockedIp(hostname)) {
      return callback(new Error('Blocked IP'), '', 0);
    }
    return options && (options as any).all
      ? callback(null, [{ address: hostname, family }] as any, family)
      : callback(null, hostname, family);
  }

  dns.lookup(hostname, options, (err, address: any, family: any) => {
    if (err) return callback(err, '', 0);
    if (Array.isArray(address)) {
      for (const entry of address) {
        if (isBlockedIp(entry.address)) {
          return callback(new Error('Blocked IP'), '', 0);
        }
      }
      return callback(null, address as any, 0);
    }
    if (isBlockedIp(address)) {
      return callback(new Error('Blocked IP'), '', 0);
    }
    callback(null, address, family);
  });
}

// True only for a literal IP host (bracketed IPv6 included) that is blocked.
// Hostnames return false: their addresses are checked by `ssrfSafeLookup`
export function isBlockedLiteralHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  return net.isIP(host) !== 0 && isBlockedIp(host);
}

const connectWithSafeLookup = buildConnector({ lookup: ssrfSafeLookup });

// Sockets skip `lookup` when the host is already an IP, so a literal host
// is checked here, before undici's own connector opens the socket
export const ssrfSafeConnect: buildConnector.connector = (
  options,
  callback
) => {
  if (isBlockedLiteralHost(options.hostname)) {
    return callback(new Error('Blocked IP'), null);
  }
  return connectWithSafeLookup(options, callback);
};

export const ssrfSafeDispatcher = new Agent({
  connect: ssrfSafeConnect,
});

// Node's http(s) agents skip `lookup` for an IP host too, so the literal host
// is checked before the agent creates a socket (keep-alive sockets are only
// ever created through here). A forward-proxy request (absolute request path)
// connects to the operator's proxy, not the target, and keeps its previous
// behaviour
function guardLiteralHosts<T extends http.Agent>(agent: T): T {
  const createSocket = (agent as any).createSocket;
  (agent as any).createSocket = function (
    req: http.ClientRequest,
    options: { host?: string; hostname?: string },
    callback: (err: Error | null, socket?: net.Socket) => void
  ) {
    const viaForwardProxy = /^https?:\/\//i.test(req.path || '');
    const blocked = [options.hostname, options.host].some(
      (host) => !!host && isBlockedLiteralHost(host)
    );
    if (blocked && !viaForwardProxy) {
      process.nextTick(callback, new Error('Blocked IP'));
      return;
    }
    return createSocket.call(this, req, options, callback);
  };
  return agent;
}

// axios can't use an undici dispatcher, but Node's http(s) agents accept the
// same `lookup` hook, so axios requests (providers that need form-data /
// stream uploads) get the identical pinned-DNS guard as `this.fetch`.
const ssrfSafeAxios = axios.create({
  httpAgent: guardLiteralHosts(
    new http.Agent({ lookup: ssrfSafeLookup } as http.AgentOptions)
  ),
  httpsAgent: guardLiteralHosts(
    new https.Agent({
      lookup: ssrfSafeLookup,
    } as https.AgentOptions)
  ),
});

// Self-hosters legitimately connect Postiz to WordPress/Mastodon/Lemmy/Listmonk
// instances that live on a private network (e.g. the same Docker network or VPC).
// Setting DISABLE_SSRF_PROTECTION=true opts those deployments out of the IP
// guard. It stays ON by default so the hosted product is protected.
export function getSsrfSafeDispatcher(): Agent | undefined {
  return process.env.DISABLE_SSRF_PROTECTION === 'true'
    ? undefined
    : ssrfSafeDispatcher;
}

export function getSsrfSafeAxios(): AxiosInstance {
  return process.env.DISABLE_SSRF_PROTECTION === 'true' ? axios : ssrfSafeAxios;
}
