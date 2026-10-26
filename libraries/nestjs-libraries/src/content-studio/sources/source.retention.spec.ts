import fs from 'fs';
import path from 'path';
import { sha256Hex } from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  buildContentStudioSourceVersionProtectionMap,
  computeContentStudioSourceVersionProtectionMap,
  CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
  CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
  CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionProtection,
  ContentStudioSourceVersionProtectionMap,
  ContentStudioSourceVersionProtectionSource,
  ContentStudioSourceVersionProtectionVersion,
  ContentStudioSourceVersionReference,
  deriveContentStudioSourceVersionProtections,
  explainContentStudioSourceVersionProtection,
  resolveContentStudioSourceVersionReferences,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// Source version protection (P8-R1A), the pure rules: which versions the
// stored state and references protect, deterministic and fail-closed. The
// service reads the rows (content-studio.source-retention.service.spec.ts,
// the PostgreSQL suite); nothing here removes or decides removing anything

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'b0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const X1 = 'content-studio-source-v1';
const X2 = 'content-studio-source-v2';

const uuid = (group: number, n: number) =>
  `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${n
    .toString(16)
    .padStart(12, '0')}`;
const SOURCE = uuid(0x5001, 1);
const SOURCE_2 = uuid(0x5001, 2);
const FEED = uuid(0x5001, 9);
const vid = (sourceId: string, n: number) =>
  uuid(0x7000 + Number.parseInt(sourceId.slice(-4), 16), n);

type Capture = {
  text?: string;
  title?: string | null;
  ex?: string;
  createdAt?: Date;
};

// a version made long ago unless said otherwise, fetched a minute per number
const version = (
  sourceId: string,
  n: number,
  capture: Capture = {}
): ContentStudioSourceVersionProtectionVersion => ({
  id: vid(sourceId, n),
  organizationId: ORG,
  sourceId,
  versionNumber: n,
  contentHash: sha256Hex(capture.text ?? 'A'),
  title: capture.title === undefined ? 'T' : capture.title,
  extractionVersion: capture.ex ?? X2,
  fetchedAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000),
  createdAt: capture.createdAt ?? new Date(Date.UTC(2026, 0, 1) + n * 60_000),
});

const source = (
  id: string,
  over: Partial<ContentStudioSourceVersionProtectionSource> = {}
): ContentStudioSourceVersionProtectionSource => ({
  id,
  organizationId: ORG,
  kind: 'url',
  latestVersionNumber: 0,
  lastPageChangeAt: null,
  lastPageChangeVersionNumber: null,
  lastPageChangeKind: null,
  lastPageChangePreviousCaptureAt: null,
  ...over,
});

// a page with these captures at these numbers, its latest the last one, and
// its last page change as captures store it (the last content or title
// change against the capture before it that exists)
const page = (
  id: string,
  captures: Array<[number, Capture?]>,
  change?: { n: number; kind?: 'content_changed' | 'title_changed' }
) => {
  const versions = captures.map(([n, capture]) => version(id, n, capture));
  const at = (n: number) => versions.find((v) => v.versionNumber === n)!;
  const before = change
    ? versions
        .filter((v) => v.versionNumber < change.n)
        .sort((a, b) => b.versionNumber - a.versionNumber)[0]
    : undefined;
  return {
    source: source(id, {
      latestVersionNumber: Math.max(0, ...captures.map(([n]) => n)),
      ...(change
        ? {
            lastPageChangeAt: at(change.n).fetchedAt,
            lastPageChangeVersionNumber: change.n,
            lastPageChangeKind: change.kind ?? 'content_changed',
            lastPageChangePreviousCaptureAt: before!.fetchedAt,
          }
        : {}),
    }),
    versions,
  };
};

const derive = (
  sources: ContentStudioSourceVersionProtectionSource[],
  versions: ContentStudioSourceVersionProtectionVersion[],
  now = NOW
) =>
  deriveContentStudioSourceVersionProtections({
    organizationId: ORG,
    sources,
    versions,
    now,
    inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
    pickerWindow: CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
  });

const label = (p: ContentStudioSourceVersionProtection) =>
  [p.reason, p.referenceType, p.referenceId, p.role].filter(Boolean).join(':');
// version number -> what protects it, for one source's protections
const byNumber = (
  protections: readonly ContentStudioSourceVersionProtection[],
  versions: ContentStudioSourceVersionProtectionVersion[],
  reason?: string
) => {
  const map = buildContentStudioSourceVersionProtectionMap(
    protections.filter((p) => !reason || p.reason === reason)
  );
  return Object.fromEntries(
    versions
      .filter((v) => map.has(v.id))
      .sort((a, b) => a.versionNumber - b.versionNumber)
      .map((v) => [
        v.versionNumber,
        map.get(v.id)!.map((p) => [p.reason, p.role].filter(Boolean).join(':')),
      ])
  );
};
const roles = (
  protections: readonly ContentStudioSourceVersionProtection[],
  versions: ContentStudioSourceVersionProtectionVersion[],
  reason: string
) =>
  Object.fromEntries(
    Object.entries(byNumber(protections, versions, reason)).map(([n, list]) => [
      n,
      list.map((entry) => entry.split(':')[1]),
    ])
  );

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioSourceRetentionIntegrityError);
    return (err as ContentStudioSourceRetentionIntegrityError).reference;
  }
  throw new Error('expected an integrity error');
};

const edge = (
  over: Partial<ContentStudioSourceVersionProtection> = {}
): ContentStudioSourceVersionProtection => ({
  organizationId: ORG,
  sourceVersionId: vid(SOURCE, 1),
  reason: 'DRAFT_EVIDENCE',
  referenceType: 'ContentPackage',
  referenceId: uuid(0x9001, 1),
  ...over,
});
const serialized = (map: ContentStudioSourceVersionProtectionMap) =>
  JSON.stringify([...map]);

describe('P8-R1A the protection map', () => {
  it('M1 one protection protects one version', () => {
    const map = buildContentStudioSourceVersionProtectionMap([edge()]);
    expect([...map.keys()]).toEqual([vid(SOURCE, 1)]);
    expect(map.get(vid(SOURCE, 1))).toEqual([edge()]);
  });

  it('M2 an exact repeat is kept once', () => {
    const map = buildContentStudioSourceVersionProtectionMap([
      edge(),
      edge(),
      { ...edge() },
    ]);
    expect(map.get(vid(SOURCE, 1))).toHaveLength(1);
  });

  it('M3 two reasons for one version both stay', () => {
    const map = buildContentStudioSourceVersionProtectionMap([
      edge({
        reason: 'REVIEW_EVIDENCE',
        referenceType: 'ContentStudioReview',
      }),
      edge({
        reason: 'REVISION_EVIDENCE',
        referenceType: 'ContentPackageRevision',
      }),
    ]);
    expect(map.get(vid(SOURCE, 1))!.map((p) => p.reason)).toEqual([
      'REVISION_EVIDENCE',
      'REVIEW_EVIDENCE',
    ]);
  });

  it('M4 one reason held by two records both stay', () => {
    const map = buildContentStudioSourceVersionProtectionMap([
      edge({ referenceId: uuid(0x9001, 2) }),
      edge({ referenceId: uuid(0x9001, 1) }),
    ]);
    expect(map.get(vid(SOURCE, 1))!.map((p) => p.referenceId)).toEqual([
      uuid(0x9001, 1),
      uuid(0x9001, 2),
    ]);
  });

  it('M5/M6/M7 any input order gives the same map: versions in id order, reasons in their order, then model, record and role', () => {
    const all: ContentStudioSourceVersionProtection[] = [
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'IN_FLIGHT',
        referenceType: 'ContentStudioSourceVersion',
        referenceId: vid(SOURCE, 2),
        role: 'age',
      }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'IN_FLIGHT',
        referenceType: 'ContentStudioSource',
        referenceId: SOURCE,
        role: 'picker_window',
      }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'AI_OPERATION',
        referenceType: 'ContentStudioAIOperation',
      }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'PAGE_CHANGE',
        referenceType: 'ContentStudioSource',
        referenceId: SOURCE,
        role: 'predecessor',
      }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'PAGE_CHANGE',
        referenceType: 'ContentStudioSource',
        referenceId: SOURCE,
        role: 'comparison_baseline',
      }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'LATEST',
        referenceType: 'ContentStudioSource',
        referenceId: SOURCE,
        role: 'latest',
      }),
      edge({ sourceVersionId: vid(SOURCE, 1) }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'DRAFT_EVIDENCE',
        referenceId: uuid(0x9001, 3),
      }),
      edge({
        sourceVersionId: vid(SOURCE, 2),
        reason: 'DRAFT_EVIDENCE',
        referenceId: uuid(0x9001, 1),
      }),
    ];
    const expected = buildContentStudioSourceVersionProtectionMap(all);
    expect([...expected.keys()]).toEqual([vid(SOURCE, 1), vid(SOURCE, 2)]);
    expect(expected.get(vid(SOURCE, 2))!.map(label)).toEqual([
      `LATEST:ContentStudioSource:${SOURCE}:latest`,
      `PAGE_CHANGE:ContentStudioSource:${SOURCE}:comparison_baseline`,
      `PAGE_CHANGE:ContentStudioSource:${SOURCE}:predecessor`,
      `DRAFT_EVIDENCE:ContentPackage:${uuid(0x9001, 1)}`,
      `DRAFT_EVIDENCE:ContentPackage:${uuid(0x9001, 3)}`,
      `AI_OPERATION:ContentStudioAIOperation:${uuid(0x9001, 1)}`,
      `IN_FLIGHT:ContentStudioSource:${SOURCE}:picker_window`,
      `IN_FLIGHT:ContentStudioSourceVersion:${vid(SOURCE, 2)}:age`,
    ]);
    // every rotation and the reverse, with repeats
    for (let shift = 0; shift < all.length; shift++) {
      const rotated = [...all.slice(shift), ...all.slice(0, shift)];
      expect(
        serialized(buildContentStudioSourceVersionProtectionMap(rotated))
      ).toBe(serialized(expected));
    }
    expect(
      serialized(
        buildContentStudioSourceVersionProtectionMap([
          ...all.slice().reverse(),
          ...all,
        ])
      )
    ).toBe(serialized(expected));
    // the order is fixed: the reasons as listed
    expect(CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS).toEqual([
      'LATEST',
      'PAGE_CHANGE',
      'DRAFT_EVIDENCE',
      'REVISION_EVIDENCE',
      'REVIEW_EVIDENCE',
      'AI_OPERATION',
      'IN_FLIGHT',
    ]);
  });

  it('M8 a protection of no known shape, or of two organizations, is refused', () => {
    for (const bad of [
      edge({ reason: 'DELETABLE' as never }),
      edge({ referenceType: 'ContentStudioReview' }),
      edge({ role: 'latest' }),
      edge({ reason: 'LATEST', referenceType: 'ContentStudioSource' }),
      edge({
        reason: 'PAGE_CHANGE',
        referenceType: 'ContentStudioSource',
        role: 'age',
      }),
      edge({
        reason: 'IN_FLIGHT',
        referenceType: 'ContentStudioSource',
        role: 'age',
      }),
      edge({ sourceVersionId: '' }),
      edge({ referenceId: '' }),
    ]) {
      expect(() => buildContentStudioSourceVersionProtectionMap([bad])).toThrow(
        RangeError
      );
    }
    expect(() =>
      buildContentStudioSourceVersionProtectionMap([
        edge(),
        edge({ organizationId: OTHER_ORG }),
      ])
    ).toThrow(RangeError);
    expect(buildContentStudioSourceVersionProtectionMap([]).size).toBe(0);
  });

  it('M9 the map hands out copies: changing one changes nothing it holds', () => {
    const input = edge();
    const map = buildContentStudioSourceVersionProtectionMap([input]);
    (input as { referenceId: string }).referenceId = 'changed';
    expect(map.get(vid(SOURCE, 1))![0].referenceId).toBe(uuid(0x9001, 1));
    expect(Object.isFrozen(map.get(vid(SOURCE, 1)))).toBe(true);
    expect(Object.isFrozen(map.get(vid(SOURCE, 1))![0])).toBe(true);
  });
});

describe('P8-R1A LATEST', () => {
  it('L1 a page source protects its current version, and only that one', () => {
    const { source: s, versions } = page(SOURCE, [[1], [2], [3]]);
    expect(roles(derive([s], versions), versions, 'LATEST')).toEqual({
      3: ['latest'],
    });
    expect(derive([s], versions).filter((p) => p.reason === 'LATEST')).toEqual([
      {
        organizationId: ORG,
        sourceVersionId: vid(SOURCE, 3),
        reason: 'LATEST',
        referenceType: 'ContentStudioSource',
        referenceId: SOURCE,
        role: 'latest',
      },
    ]);
  });

  it('L2 a source without versions protects nothing, and is valid', () => {
    expect(derive([source(SOURCE)], [])).toEqual([]);
    expect(derive([], [])).toEqual([]);
  });

  it('L3 a current version that is not there fails the organization', () => {
    const { source: s, versions } = page(SOURCE, [[1], [2], [3]]);
    expect(failure(() => derive([s], versions.slice(0, 2)))).toEqual({
      type: 'ContentStudioSource',
      id: SOURCE,
    });
    // versions, but a source that says it has none
    expect(
      failure(() => derive([{ ...s, latestVersionNumber: 0 }], versions))
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
    for (const latestVersionNumber of [-1, 2.5, Number.NaN]) {
      expect(
        failure(() => derive([{ ...s, latestVersionNumber }], versions))
      ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
    }
  });

  it('L4 a feed with a version, a current version or a page change fails', () => {
    const feed = source(FEED, { kind: 'feed' });
    expect(failure(() => derive([feed], [version(FEED, 1)]))).toEqual({
      type: 'ContentStudioSource',
      id: FEED,
    });
    expect(
      failure(() => derive([{ ...feed, latestVersionNumber: 1 }], []))
    ).toEqual({ type: 'ContentStudioSource', id: FEED });
    expect(
      failure(() =>
        derive(
          [
            {
              ...feed,
              latestVersionNumber: 2,
              lastPageChangeAt: NOW,
              lastPageChangeVersionNumber: 2,
              lastPageChangeKind: 'content_changed',
              lastPageChangePreviousCaptureAt: NOW,
            },
          ],
          []
        )
      )
    ).toEqual({ type: 'ContentStudioSource', id: FEED });
    expect(derive([feed], [])).toEqual([]);
  });

  it('L5 an archived source still protects its current version (archiving keeps history)', () => {
    const { source: s, versions } = page(SOURCE, [[1], [2]]);
    const archived = { ...s, archivedAt: new Date('2026-02-01') };
    expect(roles(derive([archived], versions), versions, 'LATEST')).toEqual({
      2: ['latest'],
    });
  });

  it('L6 a version newer than the current one fails: the history is not what the source says', () => {
    const { source: s, versions } = page(SOURCE, [[1], [2], [3]]);
    expect(
      failure(() => derive([{ ...s, latestVersionNumber: 2 }], versions))
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
  });

  it('L7 a version of an unknown source, of another organization, twice, or without a number or times fails', () => {
    const { source: s, versions } = page(SOURCE, [[1], [2]]);
    const orphan = version(SOURCE_2, 1);
    expect(failure(() => derive([s], [...versions, orphan]))).toEqual({
      type: 'ContentStudioSourceVersion',
      id: orphan.id,
    });
    expect(
      failure(() =>
        derive(
          [s],
          [versions[0], { ...versions[1], organizationId: OTHER_ORG }]
        )
      )
    ).toEqual({ type: 'ContentStudioSourceVersion', id: versions[1].id });
    expect(failure(() => derive([s], [...versions, versions[1]]))).toEqual({
      type: 'ContentStudioSourceVersion',
      id: versions[1].id,
    });
    expect(
      failure(() =>
        derive(
          [s],
          [
            versions[0],
            { ...versions[1], id: uuid(0x7777, 1), versionNumber: 1 },
          ]
        )
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
    for (const broken of [
      { versionNumber: 0 },
      { versionNumber: 1.5 },
      { fetchedAt: new Date(Number.NaN) },
      { createdAt: new Date(Number.NaN) },
      { createdAt: null as unknown as Date },
    ]) {
      expect(
        failure(() => derive([s], [versions[0], { ...versions[1], ...broken }]))
      ).toEqual({ type: 'ContentStudioSourceVersion', id: versions[1].id });
    }
    expect(
      failure(() => derive([{ ...s, organizationId: OTHER_ORG }], versions))
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
    expect(failure(() => derive([s, s], versions))).toEqual({
      type: 'ContentStudioSource',
      id: SOURCE,
    });
  });
});

describe('P8-R1A PAGE_CHANGE', () => {
  it('C1/C2/C4 the changed version, the capture before it and the first capture of that run (v1 A, v2 A, v3 B)', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [2], [3, { text: 'B' }]],
      { n: 3 }
    );
    expect(roles(derive([s], versions), versions, 'PAGE_CHANGE')).toEqual({
      1: ['comparison_baseline'],
      2: ['predecessor'],
      3: ['changed'],
    });
  });

  it('C3 a predecessor that is the first of its run holds both roles', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1, { text: 'Z' }], [2], [3, { text: 'B' }]],
      { n: 3 }
    );
    expect(roles(derive([s], versions), versions, 'PAGE_CHANGE')).toEqual({
      2: ['comparison_baseline', 'predecessor'],
      3: ['changed'],
    });
  });

  it('C4 the run is the same capture as the predecessor: blocks, title and extraction, never the hash alone', () => {
    // v1 to v4 all have blocks A; v2 another title, v3 another extraction
    const captures: Array<[number, Capture?]> = [
      [1],
      [2, { title: 'Other' }],
      [3, { ex: X1 }],
      [4, { ex: X1 }],
      [5, { ex: X1 }],
      [6, { text: 'B', ex: X1 }],
    ];
    const { source: s, versions } = page(SOURCE, captures, { n: 6 });
    expect(roles(derive([s], versions), versions, 'PAGE_CHANGE')).toEqual({
      3: ['comparison_baseline'],
      5: ['predecessor'],
      6: ['changed'],
    });
    // a null title is a value of its own
    const nulls = page(
      SOURCE,
      [
        [1, { title: 'T' }],
        [2, { title: null }],
        [3, { title: null }],
        [4, { text: 'B', title: null }],
      ],
      { n: 4 }
    );
    expect(
      roles(
        derive([nulls.source], nulls.versions),
        nulls.versions,
        'PAGE_CHANGE'
      )
    ).toEqual({
      2: ['comparison_baseline'],
      3: ['predecessor'],
      4: ['changed'],
    });
    // a title change of the page
    const title = page(SOURCE, [[1], [2], [3, { title: 'New' }]], {
      n: 3,
      kind: 'title_changed',
    });
    expect(
      roles(
        derive([title.source], title.versions),
        title.versions,
        'PAGE_CHANGE'
      )
    ).toEqual({
      1: ['comparison_baseline'],
      2: ['predecessor'],
      3: ['changed'],
    });
  });

  it('C5 gaps in the numbers: only the versions that exist count (v1 A, v3 A, v7 B)', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [3], [7, { text: 'B' }]],
      { n: 7 }
    );
    expect(roles(derive([s], versions), versions, 'PAGE_CHANGE')).toEqual({
      1: ['comparison_baseline'],
      3: ['predecessor'],
      7: ['changed'],
    });
    // 1, 3, 5, 9 with a change at 9 against 5
    const gaps = page(
      SOURCE,
      [[1, { text: 'Z' }], [3], [5], [9, { text: 'B' }]],
      { n: 9 }
    );
    expect(
      roles(derive([gaps.source], gaps.versions), gaps.versions, 'PAGE_CHANGE')
    ).toEqual({
      3: ['comparison_baseline'],
      5: ['predecessor'],
      9: ['changed'],
    });
  });

  it('C5b the change is found against the version that exists before it, never number - 1', () => {
    // v6 is gone: the predecessor of v7 is v5, and the stored time says so
    const { source: s, versions } = page(
      SOURCE,
      [[4], [5], [7, { text: 'B' }]],
      { n: 7 }
    );
    expect(s.lastPageChangePreviousCaptureAt).toEqual(versions[1].fetchedAt);
    expect(roles(derive([s], versions), versions, 'PAGE_CHANGE')).toEqual({
      4: ['comparison_baseline'],
      5: ['predecessor'],
      7: ['changed'],
    });
  });

  it('C6 a changed version that is not there fails', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [2], [3, { text: 'B' }], [4, { text: 'B' }]],
      { n: 3 }
    );
    expect(
      failure(() =>
        derive(
          [s],
          versions.filter((v) => v.versionNumber !== 3)
        )
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
  });

  it('C7 a change without a capture before it fails', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [2], [3, { text: 'B' }]],
      { n: 3 }
    );
    expect(
      failure(() =>
        derive(
          [s],
          versions.filter((v) => v.versionNumber === 3)
        )
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
  });

  it('C8 a predecessor whose time is not the stored one fails (a missing one in between, or a corrupt time)', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [2], [3, { text: 'B' }]],
      { n: 3 }
    );
    expect(
      failure(() =>
        derive(
          [s],
          versions.filter((v) => v.versionNumber !== 2)
        )
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
    expect(
      failure(() =>
        derive(
          [{ ...s, lastPageChangePreviousCaptureAt: new Date(NOW.getTime()) }],
          versions
        )
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
  });

  it('C9 a changed version whose time is not the stored one fails', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [2], [3, { text: 'B' }]],
      { n: 3 }
    );
    expect(
      failure(() =>
        derive([{ ...s, lastPageChangeAt: versions[1].fetchedAt }], versions)
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE });
  });

  it('C9b a stored change that its two versions do not show fails (a repeat, another extraction or the other kind)', () => {
    for (const [captures, kind] of [
      [[[1], [2], [3]], 'content_changed'],
      [[[1], [2], [3, { text: 'B', ex: X1 }]], 'content_changed'],
      [[[1], [2], [3, { text: 'B' }]], 'title_changed'],
    ] as Array<
      [Array<[number, Capture?]>, 'content_changed' | 'title_changed']
    >) {
      const { source: s, versions } = page(SOURCE, captures, { n: 3, kind });
      expect(failure(() => derive([s], versions))).toEqual({
        type: 'ContentStudioSource',
        id: SOURCE,
      });
    }
  });

  it('C10 a partial or impossible change state fails, as the Changes list reads it', () => {
    const { source: s, versions } = page(
      SOURCE,
      [[1], [2], [3, { text: 'B' }]],
      { n: 3 }
    );
    for (const broken of [
      { lastPageChangeAt: null },
      { lastPageChangeVersionNumber: null },
      { lastPageChangeKind: null },
      { lastPageChangePreviousCaptureAt: null },
      { lastPageChangeKind: 'extraction_changed' },
      { lastPageChangeVersionNumber: 1 },
      { lastPageChangeVersionNumber: 4 },
    ]) {
      expect(failure(() => derive([{ ...s, ...broken }], versions))).toEqual({
        type: 'ContentStudioSource',
        id: SOURCE,
      });
    }
  });

  it('C11 no change state, no PAGE_CHANGE; only the last change is protected, never an earlier one', () => {
    const none = page(SOURCE, [[1], [2, { text: 'B' }]]);
    expect(
      derive([none.source], none.versions).filter(
        (p) => p.reason === 'PAGE_CHANGE'
      )
    ).toEqual([]);
    // changes at v2 and v4: only v4 (against v3) and its run back to v2
    const two = page(
      SOURCE,
      [
        [1],
        [2, { text: 'B' }],
        [3, { text: 'B' }],
        [4, { text: 'C' }],
        [5, { text: 'C' }],
      ],
      { n: 4 }
    );
    expect(
      roles(derive([two.source], two.versions), two.versions, 'PAGE_CHANGE')
    ).toEqual({
      2: ['comparison_baseline'],
      3: ['predecessor'],
      4: ['changed'],
    });
  });
});

describe('P8-R1A IN_FLIGHT', () => {
  const thirty = (createdAt?: (n: number) => Date | undefined) =>
    page(
      SOURCE,
      Array.from({ length: 30 }, (_, i) => [
        i + 1,
        { createdAt: createdAt?.(i + 1) },
      ])
    );

  it('I1/I2/I3 made at or after now - 24h: protected for its age; a millisecond older: not', () => {
    const cutoff = NOW.getTime() - DAY;
    const { source: s, versions } = page(SOURCE, [
      [1, { createdAt: new Date(cutoff - 1) }],
      [2, { createdAt: new Date(cutoff) }],
      [3, { createdAt: new Date(cutoff + 1) }],
      [4, { createdAt: NOW }],
    ]);
    expect(
      derive([s], versions)
        .filter((p) => p.role === 'age')
        .map((p) => [p.sourceVersionId, p.referenceType, p.referenceId])
    ).toEqual(
      [2, 3, 4].map((n) => [
        vid(SOURCE, n),
        'ContentStudioSourceVersion',
        vid(SOURCE, n),
      ])
    );
    expect(CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS).toBe(DAY);
  });

  it('I4/I5 the newest 20 versions are in the picker window, the 21st newest is not', () => {
    const { source: s, versions } = thirty();
    const window = derive([s], versions)
      .filter((p) => p.role === 'picker_window')
      .map((p) => p.sourceVersionId);
    expect(window).toEqual(
      Array.from({ length: 20 }, (_, i) => vid(SOURCE, i + 11))
    );
    expect(CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW).toBe(20);
  });

  it('I6 a source with 7 versions has all 7 in the picker window', () => {
    const { source: s, versions } = page(
      SOURCE,
      Array.from({ length: 7 }, (_, i) => [i + 1] as [number])
    );
    expect(roles(derive([s], versions), versions, 'IN_FLIGHT')).toEqual(
      Object.fromEntries(
        versions.map((v) => [v.versionNumber, ['picker_window']])
      )
    );
  });

  it('I7 with gaps, the newest 20 versions that exist, never the numbers above latest - 20', () => {
    // every other number: 2, 4, ... 60
    const { source: s, versions } = page(
      SOURCE,
      Array.from({ length: 30 }, (_, i) => [2 * (i + 1)] as [number])
    );
    const window = derive([s], versions)
      .filter((p) => p.role === 'picker_window')
      .map(
        (p) => versions.find((v) => v.id === p.sourceVersionId)!.versionNumber
      );
    expect(window).toHaveLength(20);
    expect(window).toEqual(Array.from({ length: 20 }, (_, i) => 22 + 2 * i));
  });

  it('I8 a new version can be in both: its age and the window', () => {
    const { source: s, versions } = thirty((n) =>
      n === 30 ? new Date(NOW.getTime() - HOUR) : undefined
    );
    expect(byNumber(derive([s], versions), versions)[30]).toEqual([
      'LATEST:latest',
      'IN_FLIGHT:picker_window',
      'IN_FLIGHT:age',
    ]);
  });

  it("I9 the time and windows are the caller's, and must be real", () => {
    const { source: s, versions } = thirty();
    const later = new Date(NOW.getTime() + 365 * DAY);
    expect(
      serialized(
        buildContentStudioSourceVersionProtectionMap(
          derive([s], versions, later)
        )
      )
    ).toBe(
      serialized(
        buildContentStudioSourceVersionProtectionMap(derive([s], versions))
      )
    );
    for (const bad of [
      { now: new Date(Number.NaN) },
      { now: '2026-10-26' as unknown as Date },
      { inFlightMs: 0 },
      { inFlightMs: 1.5 },
      { pickerWindow: 0 },
      { pickerWindow: Number.POSITIVE_INFINITY },
    ]) {
      expect(() =>
        deriveContentStudioSourceVersionProtections({
          organizationId: ORG,
          sources: [s],
          versions,
          now: NOW,
          inFlightMs: DAY,
          pickerWindow: 20,
          ...bad,
        })
      ).toThrow(RangeError);
    }
  });
});

const ref = (
  v: ContentStudioSourceVersionProtectionVersion,
  over: Partial<ContentStudioSourceVersionReference> = {}
): ContentStudioSourceVersionReference => ({
  reason: 'DRAFT_EVIDENCE',
  referenceType: 'ContentPackage',
  referenceId: uuid(0x9001, 1),
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
  ...over,
});

describe('P8-R1A stored references', () => {
  const { versions } = page(SOURCE, [[1], [2], [3, { text: 'B' }]]);
  const resolve = (references: ContentStudioSourceVersionReference[]) =>
    resolveContentStudioSourceVersionReferences({
      organizationId: ORG,
      versions,
      references,
    });

  it('R1 an exact reference protects its version for its record; a repeat of the same record is one protection', () => {
    expect(
      resolve([ref(versions[0]), ref(versions[0]), ref(versions[1])])
    ).toEqual([
      {
        organizationId: ORG,
        sourceVersionId: versions[0].id,
        reason: 'DRAFT_EVIDENCE',
        referenceType: 'ContentPackage',
        referenceId: uuid(0x9001, 1),
      },
      {
        organizationId: ORG,
        sourceVersionId: versions[1].id,
        reason: 'DRAFT_EVIDENCE',
        referenceType: 'ContentPackage',
        referenceId: uuid(0x9001, 1),
      },
    ]);
    // other records and other reasons are other protections
    expect(
      resolve([
        ref(versions[0]),
        ref(versions[0], { referenceId: uuid(0x9001, 2) }),
        ref(versions[0], {
          reason: 'REVISION_EVIDENCE',
          referenceType: 'ContentPackageRevision',
        }),
      ])
    ).toHaveLength(3);
  });

  it('R2 a missing version, or one of another source, number, hash or organization, fails with the record that names it', () => {
    const named = { type: 'ContentPackage', id: uuid(0x9001, 1) };
    for (const broken of [
      { versionId: uuid(0x7999, 1) },
      { sourceId: SOURCE_2 },
      { versionNumber: 2 },
      { contentHash: sha256Hex('other') },
    ]) {
      expect(failure(() => resolve([ref(versions[0], broken)]))).toEqual(named);
    }
    expect(
      failure(() =>
        resolveContentStudioSourceVersionReferences({
          organizationId: ORG,
          versions: [{ ...versions[0], organizationId: OTHER_ORG }],
          references: [ref(versions[0])],
        })
      )
    ).toEqual(named);
    expect(
      failure(() =>
        resolve([
          ref(versions[0], {
            reason: 'AI_OPERATION',
            referenceType: 'ContentStudioAIOperation',
            referenceId: uuid(0x9002, 7),
            contentHash: sha256Hex('other'),
          }),
        ])
      )
    ).toEqual({ type: 'ContentStudioAIOperation', id: uuid(0x9002, 7) });
  });

  it('R3 only the four kinds of stored reference, each held by its own model', () => {
    for (const bad of [
      { reason: 'LATEST' },
      { reason: 'IN_FLIGHT' },
      { reason: 'DRAFT_EVIDENCE', referenceType: 'ContentStudioReview' },
      { reason: 'APPROVAL_EVIDENCE' },
    ] as Array<Partial<ContentStudioSourceVersionReference>>) {
      expect(() => resolve([ref(versions[0], bad)])).toThrow(RangeError);
    }
  });
});

// One page with every kind of protection, and one version nothing protects
describe('P8-R1A the whole organization', () => {
  const PACKAGE = uuid(0x9001, 1);
  const REVISION = uuid(0x9002, 1);
  const REVIEW = uuid(0x9003, 1);
  const OPERATION = uuid(0x9004, 1);
  // 30 versions: a change at v5 (v4 its predecessor, v2 the first of its
  // run, v1 another capture), a new v30 made an hour ago
  const fixture = () => {
    const captures: Array<[number, Capture?]> = Array.from(
      { length: 30 },
      (_, i) => {
        const n = i + 1;
        return [
          n,
          {
            text: n === 1 ? 'Z' : n < 5 ? 'A' : 'B',
            createdAt: n === 30 ? new Date(NOW.getTime() - HOUR) : undefined,
          },
        ];
      }
    );
    const { source: s, versions } = page(SOURCE, captures, { n: 5 });
    const at = (n: number) => versions.find((v) => v.versionNumber === n)!;
    const references: ContentStudioSourceVersionReference[] = [
      ref(at(6)),
      ref(at(7), {
        reason: 'REVISION_EVIDENCE',
        referenceType: 'ContentPackageRevision',
        referenceId: REVISION,
      }),
      ref(at(7), {
        reason: 'REVIEW_EVIDENCE',
        referenceType: 'ContentStudioReview',
        referenceId: REVIEW,
      }),
      ref(at(8), {
        reason: 'AI_OPERATION',
        referenceType: 'ContentStudioAIOperation',
        referenceId: OPERATION,
      }),
    ];
    return { sources: [s], versions, references, at };
  };
  const compute = (f: ReturnType<typeof fixture>, now = NOW) =>
    computeContentStudioSourceVersionProtectionMap({
      organizationId: ORG,
      sources: f.sources,
      versions: f.versions,
      references: f.references,
      now,
      inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
      pickerWindow: CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
    });

  it('COMPLETE every kind of protection, exactly; v1, v3, v9 and v10 are eligible in principle', () => {
    const f = fixture();
    const map = compute(f);
    const summary = Object.fromEntries(
      f.versions
        .filter((v) => map.has(v.id))
        .map((v) => [
          v.versionNumber,
          map
            .get(v.id)!
            .map((p) => [p.reason, p.role].filter(Boolean).join(':')),
        ])
    );
    const window = Object.fromEntries(
      Array.from({ length: 19 }, (_, i) => [
        i + 11,
        ['IN_FLIGHT:picker_window'],
      ])
    );
    expect(summary).toEqual({
      2: ['PAGE_CHANGE:comparison_baseline'],
      4: ['PAGE_CHANGE:predecessor'],
      5: ['PAGE_CHANGE:changed'],
      6: ['DRAFT_EVIDENCE'],
      7: ['REVISION_EVIDENCE', 'REVIEW_EVIDENCE'],
      8: ['AI_OPERATION'],
      ...window,
      30: ['LATEST:latest', 'IN_FLIGHT:picker_window', 'IN_FLIGHT:age'],
    });
    // the versions nothing names: old, not current, not the change's, out
    // of the window
    expect(
      f.versions.filter((v) => !map.has(v.id)).map((v) => v.versionNumber)
    ).toEqual([1, 3, 9, 10]);
    // every reason is in this fixture
    expect(
      [...new Set([...map.values()].flat().map((p) => p.reason))].sort()
    ).toEqual([...CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS].sort());
  });

  it('NEGATIVE v9 is eligible in principle, and only means no protection is known', () => {
    const f = fixture();
    const map = compute(f);
    expect(
      explainContentStudioSourceVersionProtection(map, f.at(9).id)
    ).toEqual({
      sourceVersionId: f.at(9).id,
      eligibleInPrinciple: true,
      protections: [],
    });
    expect(
      explainContentStudioSourceVersionProtection(map, f.at(7).id)
    ).toEqual({
      sourceVersionId: f.at(7).id,
      eligibleInPrinciple: false,
      protections: [
        {
          organizationId: ORG,
          sourceVersionId: f.at(7).id,
          reason: 'REVISION_EVIDENCE',
          referenceType: 'ContentPackageRevision',
          referenceId: REVISION,
        },
        {
          organizationId: ORG,
          sourceVersionId: f.at(7).id,
          reason: 'REVIEW_EVIDENCE',
          referenceType: 'ContentStudioReview',
          referenceId: REVIEW,
        },
      ],
    });
  });

  it('DET the same rows in any order give the same map, and one corrupt reference fails it all', () => {
    const f = fixture();
    const expected = serialized(compute(f));
    expect(
      serialized(
        compute({
          ...f,
          versions: f.versions.slice().reverse(),
          references: f.references.slice().reverse(),
        })
      )
    ).toBe(expected);
    expect(
      failure(() =>
        compute({
          ...f,
          references: [
            ...f.references,
            ref(f.at(9), { referenceId: PACKAGE, versionNumber: 10 }),
          ],
        })
      )
    ).toEqual({ type: 'ContentPackage', id: PACKAGE });
  });

  it('PD2 the first version is protected by nothing of its own', () => {
    const f = fixture();
    expect(compute(f).has(f.at(1).id)).toBe(false);
  });
});

describe('P8-R1A the module stays pure', () => {
  it('R1-11 no clock, randomness, environment, database or network in source.retention.ts', () => {
    const text = fs
      .readFileSync(path.join(__dirname, 'source.retention.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(text).not.toMatch(
      /Date\.now|new Date\(|Math\.random|randomUUID|process\.env|@prisma|prisma|@nestjs|fetch\(|require\(/
    );
    expect(
      [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    ).toEqual([
      '@gitroom/nestjs-libraries/content-studio/sources/source.change',
      '@gitroom/nestjs-libraries/content-studio/sources/source.version',
    ]);
    expect(text).not.toMatch(/deletable|safeToDelete|deleteCandidate|delete/i);
  });
});
