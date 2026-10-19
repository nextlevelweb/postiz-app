import fs from 'fs';
import path from 'path';
import {
  ContentPackageRevisionIntegrityError,
  getReviewableClaimsFromContentPackageRevision,
  hashContentPackageClaim,
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

// P3-11: a v2 revision holds its grounding in the same canonical, hashed
// content as its copy. getReviewableClaimsFromContentPackageRevision is what a
// later review (P5-03B) reads as the claims of exactly that revision
const SOURCE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const VERSION = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const GROUNDED = {
  schemaVersion: 2,
  copy: DRAFT.copy,
  grounding: {
    claims: [
      {
        id: 'c_claim0001',
        threadItemId: 'main',
        text: 'Sales grew in spring.',
        evidence: [
          {
            sourceId: SOURCE,
            versionId: VERSION,
            versionNumber: 3,
            contentHash: 'a'.repeat(64),
            blockId: 'b2',
            quote: 'grew',
          },
        ],
      },
    ],
  },
};
const v2Revision = (draft: unknown = GROUNDED) => {
  const content = canonicalJson(draft);
  return { content, contentHash: sha256Hex(content), schemaVersion: 2 };
};

describe('v2 revisions (P3-11)', () => {
  it('IR1 stores and reads the claims exactly', () => {
    expect(parseVerifiedContentPackageRevision(v2Revision())).toEqual(GROUNDED);
  });

  it('IR2 claims and evidence are part of the content hash; the copy alone is not the hash', () => {
    const base = v2Revision();
    const changed = (patch: (draft: typeof GROUNDED) => void) => {
      const draft = JSON.parse(JSON.stringify(GROUNDED));
      patch(draft);
      return v2Revision(draft).contentHash;
    };
    const hashes = [
      base.contentHash,
      changed((d) => (d.grounding.claims[0].text = 'Sales grew a lot.')),
      changed((d) => (d.grounding.claims[0].id = 'c_claim0002')),
      changed((d) => (d.grounding.claims[0].evidence[0].blockId = 'b3')),
      changed((d) => (d.grounding.claims[0].evidence[0].quote = null)),
      changed((d) => (d.grounding.claims = [])),
      revision().contentHash,
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('V2-1/V2-5 a v1 revision keeps its exact bytes and hash and reads as v1', () => {
    const stored = revision();
    expect(stored.contentHash).toBe(sha256Hex(canonicalJson(DRAFT)));
    const parsed = parseVerifiedContentPackageRevision(stored);
    expect(parsed).toEqual(DRAFT);
    expect(canonicalJson(parsed)).toBe(stored.content);
    expect(stored).toEqual(revision());
  });

  it.each([
    [
      'IR4 a claim text changed after hashing',
      () => {
        const stored = v2Revision();
        return {
          ...stored,
          content: stored.content.replace('Sales grew', 'Sales fell'),
        };
      },
    ],
    [
      'IR4 evidence changed after hashing',
      () => {
        const stored = v2Revision();
        return { ...stored, content: stored.content.replace('"b2"', '"b3"') };
      },
    ],
    [
      'a v2 revision stored with schema version 1',
      () => ({
        ...v2Revision(),
        schemaVersion: 1,
      }),
    ],
    [
      'a v1 revision stored with schema version 2',
      () => ({
        ...revision(),
        schemaVersion: 2,
      }),
    ],
    [
      'IR4 a claim of an item the revision does not have, hashed as stored',
      () =>
        v2Revision({
          ...GROUNDED,
          grounding: {
            claims: [{ ...GROUNDED.grounding.claims[0], threadItemId: 'x' }],
          },
        }),
    ],
  ])('refuses %s', (_label, make) => {
    expect(() => parseVerifiedContentPackageRevision(make())).toThrow(
      ContentPackageRevisionIntegrityError
    );
  });

  it('IR5 v1 and v2 revisions read side by side', () => {
    expect(parseVerifiedContentPackageRevision(revision()).schemaVersion).toBe(
      1
    );
    expect(
      parseVerifiedContentPackageRevision(v2Revision()).schemaVersion
    ).toBe(2);
  });
});

describe('getReviewableClaimsFromContentPackageRevision (P5-03B contract)', () => {
  it('RC1 a v1 revision has no claims', () => {
    expect(getReviewableClaimsFromContentPackageRevision(revision())).toEqual(
      []
    );
  });

  it('RC2 a v2 revision without claims has none', () => {
    expect(
      getReviewableClaimsFromContentPackageRevision(
        v2Revision({ ...GROUNDED, grounding: { claims: [] } })
      )
    ).toEqual([]);
  });

  it('RC3/RC4 a v2 revision answers exactly its claims and evidence, as copies', () => {
    const stored = v2Revision();
    const claims = getReviewableClaimsFromContentPackageRevision(stored);
    expect(claims).toEqual(GROUNDED.grounding.claims);
    claims[0].evidence[0].blockId = 'changed';
    expect(getReviewableClaimsFromContentPackageRevision(stored)).toEqual(
      GROUNDED.grounding.claims
    );
  });

  it('a corrupt revision throws the integrity error, never answers claims', () => {
    const stored = v2Revision();
    expect(() =>
      getReviewableClaimsFromContentPackageRevision({
        ...stored,
        contentHash: 'b'.repeat(64),
      })
    ).toThrow(ContentPackageRevisionIntegrityError);
  });

  it('RC5/RC6 reads the revision only: no AI operation, source or database', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'content.package.revision.ts'),
      'utf8'
    );
    expect(text).not.toMatch(
      /AIOperation|aiOperation|ai\.operation|Source(Version)?Repository|latestVersion|prisma|Prisma|fetch\(/
    );
    const imports = text.match(/from '[^']+'/g);
    expect(imports).toEqual([
      "from '@gitroom/nestjs-libraries/content-studio/content.package.draft'",
      "from '@gitroom/nestjs-libraries/content-studio/canonical.json'",
    ]);
  });

  it('hashContentPackageClaim hashes the canonical claim: any change is another hash', () => {
    const [first] = GROUNDED.grounding.claims;
    const hash = hashContentPackageClaim(first as never);
    expect(hash).toBe(sha256Hex(canonicalJson(first)));
    expect(
      hashContentPackageClaim({ ...first, text: 'Other.' } as never)
    ).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
