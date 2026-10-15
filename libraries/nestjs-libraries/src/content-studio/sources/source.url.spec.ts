import {
  canonicalContentStudioSourceUrl,
  CONTENT_STUDIO_SOURCE_URL_MAX_BYTES,
  ContentStudioSourceUrlError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.url';

const canonical = canonicalContentStudioSourceUrl;
const refused = (input: unknown) => {
  let error: unknown;
  try {
    canonical(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioSourceUrlError);
  // a URL can carry a token: the message never repeats it
  expect((error as Error).message).toBe('The source URL is invalid');
  return error as Error;
};

describe('canonicalContentStudioSourceUrl', () => {
  it('SU1/SU2 accepts https and http URLs', () => {
    expect(canonical('https://example.com/news/item')).toBe(
      'https://example.com/news/item'
    );
    expect(canonical('http://example.com/')).toBe('http://example.com/');
    expect(canonical('https://example.com')).toBe('https://example.com/');
  });

  it('SU3 strips the fragment, an empty one included', () => {
    expect(canonical('https://example.com/a?b=1#section-2')).toBe(
      'https://example.com/a?b=1'
    );
    expect(canonical('https://example.com/a#')).toBe('https://example.com/a');
  });

  it('SU4/SU5 drops the default port and keeps any other', () => {
    expect(canonical('https://example.com:443/a')).toBe(
      'https://example.com/a'
    );
    expect(canonical('http://example.com:80/a')).toBe('http://example.com/a');
    expect(canonical('https://example.com:8443/a')).toBe(
      'https://example.com:8443/a'
    );
    expect(canonical('http://example.com:443/a')).toBe(
      'http://example.com:443/a'
    );
  });

  it('SU6 lowercases the scheme and host as the URL standard does', () => {
    expect(canonical('HTTPS://Example.COM/Path')).toBe(
      'https://example.com/Path'
    );
    expect(canonical('https://bücher.example/')).toBe(
      'https://xn--bcher-kva.example/'
    );
  });

  it('SU7 keeps the case of the path', () => {
    expect(canonical('https://example.com/News/Item-A')).toBe(
      'https://example.com/News/Item-A'
    );
  });

  it('SU8/SU9 keeps every query parameter, tracking ones included, in order', () => {
    expect(canonical('https://example.com/a?z=1&a=2&utm_source=x&a=3')).toBe(
      'https://example.com/a?z=1&a=2&utm_source=x&a=3'
    );
    expect(canonical('https://example.com/a?')).toBe('https://example.com/a?');
  });

  it('SU10 keeps a trailing slash or its absence', () => {
    expect(canonical('https://example.com/a/')).toBe('https://example.com/a/');
    expect(canonical('https://example.com/a')).toBe('https://example.com/a');
  });

  it('serializes like the URL standard: dot segments, spaces and non-ASCII paths', () => {
    expect(canonical('https://example.com/a/../b/./c')).toBe(
      'https://example.com/b/c'
    );
    expect(canonical('https://example.com/a b?q=c d')).toBe(
      'https://example.com/a%20b?q=c%20d'
    );
    expect(canonical('https://example.com/café')).toBe(
      'https://example.com/caf%C3%A9'
    );
    // the canonical form is canonical again
    const once = canonical('HTTPS://Example.com:443/x/../y?b=2#f');
    expect(canonical(once)).toBe(once);
  });

  it('SU11 refuses a username or password', () => {
    refused('https://user@example.com/');
    refused('https://user:secret@example.com/');
    refused('https://:secret@example.com/');
    const error = refused('https://user:TOKEN_MARKER_123@example.com/');
    expect(JSON.stringify(error)).not.toContain('TOKEN_MARKER_123');
    expect(String(error)).not.toContain('TOKEN_MARKER_123');
  });

  it.each([
    ['SU12 ftp', 'ftp://example.com/file.txt'],
    ['SU13 file', 'file:///etc/passwd'],
    ['SU13 file with a host', 'file://server/share/report.txt'],
    ['SU14 data', 'data:text/html,<script>alert(1)</script>'],
    ['SU15 javascript', 'javascript:alert(1)'],
    ['SU16 mailto', 'mailto:someone@example.com'],
    ['SU17 ws', 'ws://example.com/socket'],
    ['SU17 wss', 'wss://example.com/socket'],
    ['blob', 'blob:https://example.com/0f0e'],
    ['gopher', 'gopher://example.com/'],
  ])('refuses %s', (_name, url) => {
    refused(url);
  });

  it('SU18 refuses a URL without a host or without a scheme', () => {
    refused('https://');
    refused('http://');
    refused('//example.com/a');
    refused('/news/item');
    refused('example.com');
    refused('');
    refused('   ');
  });

  it('SU19 allows 2048 UTF-8 bytes and refuses one more', () => {
    const base = 'https://example.com/';
    const fits = base + 'a'.repeat(CONTENT_STUDIO_SOURCE_URL_MAX_BYTES - 20);
    expect(fits).toHaveLength(2048);
    expect(canonical(fits)).toBe(fits);
    refused(fits + 'a');
    // percent encoding makes the stored form longer than the input: the
    // stored form is what counts
    const encoded = base + 'é'.repeat(400);
    expect(encoded.length).toBeLessThan(2048);
    refused(encoded);
  });

  it('SU20 refuses NUL and control characters, also those the parser would drop', () => {
    for (const control of [
      '\u0000',
      '\u0001',
      '\t',
      '\n',
      '\r',
      '\u001f',
      '\u007f',
      '\u0085',
      '\u009f',
    ]) {
      refused(`https://example.com/a${control}b`);
    }
    refused('\nhttps://example.com/');
  });

  it('SU21 refuses an unpaired surrogate and accepts a pair', () => {
    refused('https://example.com/\uD800');
    refused('https://example.com/\uDC00a');
    expect(canonical('https://example.com/😀')).toBe(
      'https://example.com/%F0%9F%98%80'
    );
  });

  it('SU22 is syntax only: private and loopback addresses are valid source URLs here', () => {
    // Fetching them is refused by SafeFetch at ingestion, not by this
    // canonicalizer. Accepting them here is deliberate
    for (const [input, output] of [
      ['http://127.0.0.1/', 'http://127.0.0.1/'],
      ['http://localhost:3000/admin', 'http://localhost:3000/admin'],
      ['http://10.0.0.1/', 'http://10.0.0.1/'],
      ['http://169.254.169.254/latest/', 'http://169.254.169.254/latest/'],
      ['http://[::1]/', 'http://[::1]/'],
      ['http://2130706433/', 'http://127.0.0.1/'],
    ]) {
      expect(canonical(input)).toBe(output);
    }
  });

  it('refuses anything but a string', () => {
    for (const input of [
      undefined,
      null,
      42,
      {},
      new URL('https://example.com/'),
      ['https://example.com/'],
    ]) {
      refused(input);
    }
  });
});
