import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { ContentStudioSourceContentError } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';
import { ContentStudioSourceUrlError } from '@gitroom/nestjs-libraries/content-studio/sources/source.url';
import {
  CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
  CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION_PATTERN,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  ContentStudioSourceVersionError,
  parseContentStudioSourceVersionInput,
  parseVerifiedContentStudioSourceVersion,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';

const MARKER = 'SOURCE_VERSION_SECRET_MARKER_123';
const FETCHED = new Date('2026-10-15T08:30:00.000Z');
const SOURCE_HASH = 'a'.repeat(64);

const content = () => ({
  schemaVersion: 1,
  blocks: [
    { id: 'h1', type: 'heading', text: 'Title', level: 1 },
    { id: 'p1', type: 'paragraph', text: ' Body.\r\n', level: null },
  ],
});
const input = (overrides: Record<string, unknown> = {}) => ({
  requestedUrl: 'https://example.com/news/a',
  finalUrl: 'https://example.com/news/a',
  redirectCount: 0,
  fetchedAt: FETCHED,
  httpStatus: 200,
  contentType: 'text/html; charset=utf-8',
  contentLength: 5120,
  title: 'A title',
  sourceHash: SOURCE_HASH,
  extractionVersion: CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION,
  content: content(),
  ...overrides,
});
const redirected = (overrides: Record<string, unknown> = {}) =>
  input({
    finalUrl: 'https://www.example.com/news/a',
    redirectCount: 1,
    ...overrides,
  });

const parse = parseContentStudioSourceVersionInput;
const refused = (
  value: unknown,
  type:
    | typeof ContentStudioSourceVersionError
    | typeof ContentStudioSourceUrlError
    | typeof ContentStudioSourceContentError = ContentStudioSourceVersionError
) => {
  let error: unknown;
  try {
    parse(value);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(type);
  expect(JSON.stringify(error)).not.toContain(MARKER);
  expect(String(error)).not.toContain(MARKER);
  return error as Error & { fields?: unknown[] };
};

describe('parseContentStudioSourceVersionInput', () => {
  it('SV1 turns a capture into exactly the data of a version', () => {
    const blocks = {
      schemaVersion: 1,
      blocks: [
        { id: 'h1', level: 1, text: 'Title', type: 'heading' },
        { id: 'p1', level: null, text: 'Body.', type: 'paragraph' },
      ],
    };
    expect(parse(input())).toEqual({
      requestedUrl: 'https://example.com/news/a',
      finalUrl: 'https://example.com/news/a',
      redirectCount: 0,
      fetchedAt: FETCHED,
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      contentLength: 5120,
      title: 'A title',
      sourceHash: SOURCE_HASH,
      extractionVersion: 'content-studio-source-v2',
      schemaVersion: 1,
      content: canonicalJson(blocks),
      contentHash: sha256Hex(canonicalJson(blocks)),
    });
  });

  it('SV2/SV3 canonicalizes both URLs and refuses an invalid one', () => {
    const result = parse(
      redirected({
        requestedUrl: 'HTTPS://Example.com:443/news/a#top',
        finalUrl: 'https://WWW.example.com/news/a#x',
      })
    );
    expect(result.requestedUrl).toBe('https://example.com/news/a');
    expect(result.finalUrl).toBe('https://www.example.com/news/a');
    for (const url of [
      'ftp://example.com/a',
      `https://user:${MARKER}@example.com/`,
      'javascript:alert(1)',
      'not a url',
      42,
    ]) {
      refused(
        redirected({ requestedUrl: url }),
        url === 42 ? undefined : ContentStudioSourceUrlError
      );
      refused(
        redirected({ finalUrl: url }),
        url === 42 ? undefined : ContentStudioSourceUrlError
      );
    }
  });

  it('keeps a final URL that differs from the requested one after redirects', () => {
    const result = parse(
      redirected({ finalUrl: 'https://other.example/moved', redirectCount: 3 })
    );
    expect(result.finalUrl).toBe('https://other.example/moved');
    expect(result.requestedUrl).toBe('https://example.com/news/a');
    // without a redirect the answer came from the requested URL
    expect(
      refused(input({ finalUrl: 'https://other.example/moved' })).fields
    ).toEqual(['finalUrl']);
  });

  it('SV4-SV7 takes 0-10 redirects', () => {
    expect(parse(input({ redirectCount: 0 })).redirectCount).toBe(0);
    expect(parse(redirected({ redirectCount: 10 })).redirectCount).toBe(10);
    for (const redirectCount of [11, -1, 1.5, '1', null, NaN]) {
      expect(refused(redirected({ redirectCount })).fields).toEqual([
        'redirectCount',
      ]);
    }
  });

  it('SV8/SV9 needs a valid Date and keeps its own copy', () => {
    const fetchedAt = new Date(FETCHED.getTime());
    const result = parse(input({ fetchedAt }));
    expect(result.fetchedAt).toEqual(FETCHED);
    expect(result.fetchedAt).not.toBe(fetchedAt);
    for (const value of [
      new Date('not a date'),
      FETCHED.toISOString(),
      FETCHED.getTime(),
      null,
    ]) {
      expect(refused(input({ fetchedAt: value })).fields).toEqual([
        'fetchedAt',
      ]);
    }
  });

  it('SV10/SV11 takes a status 100-599 or null, without judging it', () => {
    for (const httpStatus of [100, 200, 304, 404, 599, null]) {
      expect(parse(input({ httpStatus })).httpStatus).toBe(httpStatus);
    }
    for (const httpStatus of [99, 600, 200.5, '200', -200]) {
      expect(refused(input({ httpStatus })).fields).toEqual(['httpStatus']);
    }
  });

  it('SV12/SV13 takes a printable ASCII content type of at most 255 characters', () => {
    expect(parse(input({ contentType: '  text/html  ' })).contentType).toBe(
      'text/html'
    );
    for (const contentType of [null, '', '   ']) {
      expect(parse(input({ contentType })).contentType).toBeNull();
    }
    expect(
      parse(input({ contentType: `text/${'x'.repeat(250)}` })).contentType
    ).toHaveLength(255);
    for (const contentType of [
      `text/${'x'.repeat(251)}`,
      'text/html\r\nX-Injected: 1',
      'text/html\u0000',
      'text/htmé',
      'text/\u0085html',
      42,
    ]) {
      expect(refused(input({ contentType })).fields).toEqual(['contentType']);
    }
  });

  it('SV14-SV16 takes a content length 0 to int4 max or null', () => {
    for (const contentLength of [0, 1, 2_147_483_647, null]) {
      expect(parse(input({ contentLength })).contentLength).toBe(contentLength);
    }
    for (const contentLength of [-1, 1.5, 2_147_483_648, Infinity, '10']) {
      expect(refused(input({ contentLength })).fields).toEqual([
        'contentLength',
      ]);
    }
  });

  it('SV17/SV18 normalizes the title, null when blank, at most 1000', () => {
    expect(parse(input({ title: '  Line\r\nTwo  ' })).title).toBe('Line\nTwo');
    for (const title of [null, '', ' \r\n ']) {
      expect(parse(input({ title })).title).toBeNull();
    }
    expect(parse(input({ title: 't'.repeat(1000) })).title).toHaveLength(1000);
    for (const title of [
      't'.repeat(1001),
      `a\u0000${MARKER}`,
      `a\uD800${MARKER}`,
      42,
    ]) {
      expect(refused(input({ title })).fields).toEqual(['title']);
    }
  });

  it('SV19-SV21 takes a lowercase 64-hex source hash or null, kept apart from the content hash', () => {
    expect(parse(input({ sourceHash: null })).sourceHash).toBeNull();
    const result = parse(input({ sourceHash: SOURCE_HASH }));
    expect(result.sourceHash).toBe(SOURCE_HASH);
    expect(result.contentHash).not.toBe(SOURCE_HASH);
    // a missing sourceHash is never filled in from the blocks
    expect(parse(input({ sourceHash: null })).contentHash).toBe(
      result.contentHash
    );
    for (const sourceHash of [
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      'g'.repeat(64),
      '',
      ` ${'a'.repeat(64)}`,
    ]) {
      expect(refused(input({ sourceHash })).fields).toEqual(['sourceHash']);
    }
  });

  it('SV22/XV5/XV6 takes any extraction version of the safe pattern, current or historical', () => {
    expect(CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION).toBe(
      'content-studio-source-v2'
    );
    expect(CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION).toMatch(
      CONTENT_STUDIO_SOURCE_EXTRACTION_VERSION_PATTERN
    );
    for (const extractionVersion of [
      // XV3 the version P3-02 wrote stays valid
      'content-studio-source-v1',
      'content-studio-source-v2',
      'v2',
      'readability-0.5.1',
      'a',
      'a'.repeat(64),
    ]) {
      expect(parse(input({ extractionVersion })).extractionVersion).toBe(
        extractionVersion
      );
    }
    for (const extractionVersion of [
      '',
      'V1',
      '-v1',
      '.v1',
      'a'.repeat(65),
      'v 1',
      'v1/2',
      '2026-10-15T08:30:00Z',
      null,
    ]) {
      expect(refused(input({ extractionVersion })).fields).toEqual([
        'extractionVersion',
      ]);
    }
  });

  it('SV23 computes the canonical content and its hash itself, and they verify', () => {
    const result = parse(input());
    expect(
      parseVerifiedContentStudioSourceVersion({
        schemaVersion: result.schemaVersion,
        content: result.content,
        contentHash: result.contentHash,
      })
    ).toEqual(JSON.parse(result.content));
    // a caller cannot hand in its own hash or canonical text
    for (const extra of ['contentHash', 'schemaVersion', 'versionNumber']) {
      expect(refused(input({ [extra]: MARKER })).fields).toEqual([]);
    }
  });

  it('refuses invalid or oversized blocks with the content error', () => {
    const invalid = refused(
      input({
        content: {
          schemaVersion: 1,
          blocks: [{ id: 'a', type: 'html', text: MARKER, level: null }],
        },
      }),
      ContentStudioSourceContentError
    );
    expect((invalid as ContentStudioSourceContentError).code).toBe('INVALID');
    const tooLarge = refused(
      input({
        content: {
          schemaVersion: 1,
          blocks: Array.from({ length: 2001 }, () => ({})),
        },
      }),
      ContentStudioSourceContentError
    );
    expect((tooLarge as ContentStudioSourceContentError).code).toBe(
      'TOO_LARGE'
    );
    refused(input({ content: undefined }), ContentStudioSourceContentError);
  });

  it('needs every field, null included, and nothing else', () => {
    for (const key of Object.keys(input())) {
      if (key === 'content') {
        continue;
      }
      const value: Record<string, unknown> = input();
      delete value[key];
      expect(refused(value).fields).toEqual([key]);
    }
    for (const extra of [
      'rawHtml',
      'html',
      'body',
      'headers',
      'redirects',
      'verified',
      'organizationId',
    ]) {
      refused(input({ [extra]: MARKER }));
    }
  });

  it('refuses anything but a plain object, and leaves the input as it was', () => {
    for (const value of [null, undefined, 'x', [], new (class Capture {})()]) {
      refused(value);
    }
    const value = input();
    const before = JSON.stringify(value);
    parse(value);
    expect(JSON.stringify(value)).toBe(before);
  });
});
