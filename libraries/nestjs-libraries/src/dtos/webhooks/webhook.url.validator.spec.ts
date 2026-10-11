import {
  isBlockedIp,
  isBlockedIPv4,
  isBlockedIPv6,
  isSafePublicHttpsUrl,
} from './webhook.url.validator';

describe('isBlockedIPv4', () => {
  it.each([
    ['0.0.0.0'],
    ['0.255.255.255'],
    ['10.0.0.1'],
    ['100.64.0.1'],
    ['100.127.255.255'],
    ['127.0.0.1'],
    ['127.255.255.254'],
    ['169.254.169.254'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.0.0.1'],
    ['192.0.2.1'],
    ['192.88.99.1'],
    ['192.168.1.1'],
    ['198.18.0.1'],
    ['198.19.255.255'],
    ['198.51.100.1'],
    ['203.0.113.1'],
    ['224.0.0.1'],
    ['239.255.255.255'],
    ['240.0.0.1'],
    ['255.255.255.255'],
  ])('blocks %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(true);
  });

  it.each([
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['93.184.215.14'],
    ['100.63.255.255'],
    ['100.128.0.0'],
    ['172.15.255.255'],
    ['172.32.0.0'],
    ['192.0.1.1'],
    ['198.17.255.255'],
    ['198.20.0.0'],
    ['223.255.255.255'],
  ])('allows %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(false);
  });

  it.each([[''], ['1.2.3'], ['256.1.1.1'], ['not-an-ip'], ['::1']])(
    'fails closed on malformed input %p',
    (ip) => {
      expect(isBlockedIPv4(ip)).toBe(true);
    }
  );
});

describe('isBlockedIPv6', () => {
  it.each([
    ['::'],
    ['::1'],
    ['fc00::1'],
    ['fd00::1'],
    ['fe80::1'],
    ['fe90::1'],
    ['febf::1'],
    ['fec0::1'],
    ['ff02::1'],
    ['100::1'],
    ['2001:db8::1'],
    ['2001:10::1'],
    ['2001::1'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['64:ff9b:1::1'],
    ['fe80::1%eth0'],
  ])('blocks %s', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(true);
  });

  it.each([
    ['2606:4700:4700::1111'],
    ['2001:4860:4860::8888'],
    ['2a00:1450:4001::200e'],
  ])('allows %s', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(false);
  });

  it.each([
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:a9fe:a9fe', true],
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
  ])('IPv4-mapped %s blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv6(ip)).toBe(blocked);
  });

  it.each([['::127.0.0.1'], ['::7f00:1'], ['::8.8.8.8'], ['::808:808']])(
    'blocks IPv4-compatible %s',
    (ip) => {
      expect(isBlockedIPv6(ip)).toBe(true);
    }
  );

  it.each([
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::127.0.0.1', true],
    ['64:ff9b::a9fe:a9fe', true],
    ['64:ff9b::808:808', false],
    ['64:ff9b::8.8.8.8', false],
  ])('NAT64 %s blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv6(ip)).toBe(blocked);
  });

  it.each([
    ['2002:7f00:1::1', true],
    ['2002:a00:1::', true],
    ['2002:c0a8:101::1', true],
    ['2002:808:808::1', false],
  ])('6to4 %s blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv6(ip)).toBe(blocked);
  });

  it.each([[''], ['not-an-ip'], ['1.1.1.1'], ['::g']])(
    'fails closed on malformed input %p',
    (ip) => {
      expect(isBlockedIPv6(ip)).toBe(true);
    }
  );
});

describe('isBlockedIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:7f00:1', true],
    ['1.1.1.1', false],
    ['2606:4700:4700::1111', false],
    ['example.com', true],
    ['', true],
  ])('%p blocked=%s', (ip, blocked) => {
    expect(isBlockedIp(ip)).toBe(blocked);
  });
});

describe('literal hosts after WHATWG URL normalization', () => {
  it.each([
    ['http://0x7f.1/', '127.0.0.1'],
    ['http://2130706433/', '127.0.0.1'],
    ['http://017700000001/', '127.0.0.1'],
    ['http://127.1/', '127.0.0.1'],
    ['http://0/', '0.0.0.0'],
    ['http://0xa9fea9fe/', '169.254.169.254'],
    ['http://[::ffff:127.0.0.1]/', '[::ffff:7f00:1]'],
    ['http://[0:0:0:0:0:0:0:1]/', '[::1]'],
    ['http://[64:ff9b::127.0.0.1]/', '[64:ff9b::7f00:1]'],
  ])('%s normalizes to blocked %s', (url, hostname) => {
    const parsed = new URL(url);
    expect(parsed.hostname).toBe(hostname);
    expect(isBlockedIp(parsed.hostname.replace(/^\[|\]$/g, ''))).toBe(true);
  });
});

describe('isSafePublicHttpsUrl (literal hosts only, no DNS)', () => {
  it.each([
    ['https://127.0.0.1/'],
    ['https://0x7f.1/'],
    ['https://2130706433/'],
    ['https://[::1]/'],
    ['https://[::ffff:7f00:1]/'],
    ['https://[64:ff9b::7f00:1]/'],
    ['https://[2002:a00:1::1]/'],
    ['https://[fe90::1]/'],
    ['https://169.254.169.254/latest/meta-data/'],
    ['https://localhost/'],
    ['http://8.8.8.8/'],
    ['not a url'],
    [''],
  ])('rejects %p', async (url) => {
    await expect(isSafePublicHttpsUrl(url)).resolves.toBe(false);
  });

  it.each([
    ['https://8.8.8.8/'],
    ['https://[2606:4700:4700::1111]/'],
    ['https://[64:ff9b::808:808]/'],
  ])('accepts public literal %s', async (url) => {
    await expect(isSafePublicHttpsUrl(url)).resolves.toBe(true);
  });
});
