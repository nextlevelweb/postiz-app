import {
  ContentPackageRevisionIntegrityError,
  parseVerifiedContentPackageRevision,
} from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';

const DRAFT = {
  schemaVersion: 1,
  copy: {
    global: {
      thread: [{ id: 'main', text: 'Secret launch', mediaIds: ['m1'] }],
    },
  },
};
const CONTENT = canonicalJson(DRAFT);
const revision = (overrides: Partial<Record<string, unknown>> = {}) => ({
  content: CONTENT,
  contentHash: sha256Hex(CONTENT),
  schemaVersion: 1,
  ...overrides,
});
// content stored as given, with the hash of exactly that text
const rehashed = (content: string) => ({
  content,
  contentHash: sha256Hex(content),
  schemaVersion: 1,
});

describe('parseVerifiedContentPackageRevision', () => {
  it('returns the parsed draft of an intact revision', () => {
    expect(parseVerifiedContentPackageRevision(revision())).toEqual(DRAFT);
  });

  it.each([
    ['broken JSON', rehashed('{"copy":')],
    ['a draft the schema rejects', rehashed('{"schemaVersion":2}')],
    ['keys out of canonical order', rehashed(JSON.stringify(DRAFT))],
    ['extra whitespace', rehashed(` ${CONTENT}`)],
    [
      'a CRLF the schema would normalize',
      rehashed(CONTENT.replace('Secret', 'Sec\\r\\nret')),
    ],
    ['a different hash', revision({ contentHash: sha256Hex('other') })],
    [
      'an uppercase hash',
      revision({ contentHash: sha256Hex(CONTENT).toUpperCase() }),
    ],
    ['another schema version column', revision({ schemaVersion: 2 })],
  ])('refuses %s', (_name, input) => {
    let error: unknown;
    try {
      parseVerifiedContentPackageRevision(
        input as Parameters<typeof parseVerifiedContentPackageRevision>[0]
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ContentPackageRevisionIntegrityError);
    const { message, name } = error as Error;
    expect(message).toBe(
      'A stored content package revision failed its integrity check'
    );
    expect(name).toBe('ContentPackageRevisionIntegrityError');
    expect(`${message} ${String(error)} ${JSON.stringify(error)}`).not.toMatch(
      /Secret|m1|[0-9a-f]{64}/i
    );
  });
});
