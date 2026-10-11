import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { URL } from 'node:url';
import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

// IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96)
// and 6to4 (2002::/16) are decoded in isBlockedIPv6 instead of listed here
const BLOCKED_IPV6: Array<[string, number]> = [
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo, not decoded
  ['2001:10::', 28], // ORCHID
  ['2001:db8::', 32], // documentation
  ['64:ff9b:1::', 48], // NAT64 local-use
  ['::ffff:0:0:0', 96], // IPv4-translated
];

const blockedIPv4 = new net.BlockList();
BLOCKED_IPV4.forEach(([network, prefix]) =>
  blockedIPv4.addSubnet(network, prefix, 'ipv4')
);

const blockedIPv6 = new net.BlockList();
BLOCKED_IPV6.forEach(([network, prefix]) =>
  blockedIPv6.addSubnet(network, prefix, 'ipv6')
);

// Expands a valid IPv6 address into its eight 16-bit groups, including the
// dotted IPv4 tail form (::ffff:127.0.0.1)
function ipv6Groups(ip: string): number[] {
  const address = ip.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) =>
      `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`
  );
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill =
    tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');

  return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

function embeddedIPv4(high: number, low: number) {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

// Malformed input is treated as blocked
export function isBlockedIPv4(ip: string): boolean {
  return !net.isIPv4(ip) || blockedIPv4.check(ip, 'ipv4');
}

export function isBlockedIPv6(ip: string): boolean {
  const address = ip.split('%')[0];
  if (!net.isIPv6(address)) {
    return true;
  }

  const groups = ipv6Groups(address);
  const zeroUntil = (end: number) =>
    groups.slice(0, end).every((group) => group === 0);

  // ::ffff:0:0/96 IPv4-mapped, judged by the IPv4 it points at
  if (zeroUntil(5) && groups[5] === 0xffff) {
    return isBlockedIPv4(embeddedIPv4(groups[6], groups[7]));
  }

  // ::/96 IPv4-compatible (deprecated), also covers :: and ::1
  if (zeroUntil(6)) {
    return true;
  }

  // 64:ff9b::/96 NAT64, judged by the IPv4 it translates to
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isBlockedIPv4(embeddedIPv4(groups[6], groups[7]));
  }

  // 2002::/16 6to4, judged by the IPv4 it tunnels to
  if (groups[0] === 0x2002) {
    return isBlockedIPv4(embeddedIPv4(groups[1], groups[2]));
  }

  return blockedIPv6.check(address, 'ipv6');
}

export function isBlockedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return isBlockedIPv4(ip);
  }
  if (version === 6) {
    return isBlockedIPv6(ip);
  }
  return true;
}

export async function isSafePublicHttpsUrl(value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  if (!parsed.hostname) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (hostname === 'localhost') {
    return false;
  }

  // If user supplied a literal IP directly, validate it immediately
  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion) {
    return !isBlockedIp(hostname);
  }

  try {
    const records = await dns.lookup(hostname, { all: true });

    if (!records.length) {
      return false;
    }

    for (const record of records) {
      if (isBlockedIp(record.address)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: 'IsSafeWebhookUrl', async: true })
export class IsSafeWebhookUrlConstraint implements ValidatorConstraintInterface {
  async validate(value: unknown, _args: ValidationArguments): Promise<boolean> {
    return isSafePublicHttpsUrl(value);
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'URL must be a public HTTPS URL and must not resolve to localhost, private, loopback, or link-local addresses';
  }
}

export function IsSafeWebhookUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsSafeWebhookUrlConstraint,
    });
  };
}