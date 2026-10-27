import fs from 'fs';
import path from 'path';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  classifyContentStudioSourceCaptureTransition,
  isContentStudioSourcePageChange,
  isSameContentStudioSourceCapture,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import {
  assertContentStudioSourceVersionRetentionPolicy,
  assertContentStudioSourceVersionRetentionScale,
  buildContentStudioSourceVersionRetentionDryRun,
  classifyContentStudioSourceVersionRetentionCandidates,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_MAX_VERSIONS,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_VALIDITY_MS,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MODES,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE,
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceVersionRetentionPolicy,
  contentStudioSourceVersionRetentionDryRunHash,
  contentStudioSourceVersionRetentionErrorCode,
  evaluateContentStudioSourceVersionRetention,
  groupContentStudioSourceVersionRuns,
  simulateContentStudioSourcePageChangeStateAfterRetention,
  summarizeContentStudioSourceVersionProtections,
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
  batchContentStudioSourceVersionRetentionCandidates,
  checkContentStudioSourceAfterRetention,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DELETE_BATCH_SIZE,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_ERRORS,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_FORMAT_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_MAX_CANDIDATES,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_STATUSES,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_TERMINAL,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_MAX_BYTES,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS,
  ContentStudioSourceVersionRetentionExecutionError,
  contentStudioSourceVersionRetainedRuns,
  contentStudioSourceVersionRetentionReadyAt,
  isContentStudioSourceVersionRetentionExecutionTerminal,
  parseContentStudioSourceVersionRetentionPlan,
  planContentStudioSourceVersionRetention,
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
    const all = fs
      .readFileSync(path.join(__dirname, 'source.retention.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // P8-R1C: the retention execution's section, at the end, pinned below
    const execution = all.indexOf(
      'export const CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_FORMAT_VERSION'
    );
    expect(execution).toBeGreaterThan(0);
    const text = all.slice(0, execution);
    // P8-R1B: one Date is made, never from the clock: the dry run's
    // validUntil, from the time the caller passed
    expect(
      text.replace(
        /new Date\(\n    input\.evaluationNow\.getTime\(\) \+\n      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_VALIDITY_MS\n  \)/,
        ''
      )
    ).not.toMatch(
      /Date\.now|new Date\(|Math\.random|randomUUID|process\.env|@prisma|prisma|@nestjs|fetch\(|require\(/
    );
    expect(text.match(/new Date\(/g)).toHaveLength(1);
    // P8-R1B: the canonical JSON and sha256 of the dry-run hash
    expect(
      [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    ).toEqual([
      '@gitroom/nestjs-libraries/content-studio/sources/source.change',
      '@gitroom/nestjs-libraries/content-studio/sources/source.version',
      '@gitroom/nestjs-libraries/content-studio/canonical.json',
    ]);
    expect(text).not.toMatch(/deletable|safeToDelete|deleteCandidate|delete/i);
    // P8-R1C: the execution's own rules are as pure: the Dates it makes are
    // a plan's times read from its text and the end of the wait after the
    // last hold, never the clock; it names a removal only by its batch size
    const own = all.slice(execution);
    expect(own).not.toMatch(
      /Date\.now|Math\.random|randomUUID|process\.env|@prisma|prisma|@nestjs|fetch\(|require\(|\bimport\b/
    );
    expect(own.match(/new Date\([^)]*/g)).toEqual([
      'new Date(value',
      'new Date(\n    Math.max(...pendingAt.map((time',
    ]);
    expect(
      own.replace(
        /CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DELETE_BATCH_SIZE/g,
        ''
      )
    ).not.toMatch(/delete|remove\(|purge|prune/i);
  });
});

// --- the retention dry run (P8-R1B) ---

// Captures by letter: A, then one thing different each, N without a title,
// F all three different
const IDENTITY: Record<string, Capture> = {
  A: {},
  B: { text: 'B' },
  C: { title: 'T2' },
  D: { ex: X1 },
  N: { title: null },
  F: { text: 'B', title: 'T2', ex: X1 },
};

// The page-change backfill and the change view, written out here as the
// oracle the dry run is checked against (content-studio.source.service.ts:
// lastPageChange and getVersionChanges)
const oracleState = (
  versions: ContentStudioSourceVersionProtectionVersion[]
) => {
  let previous: ContentStudioSourceVersionProtectionVersion | null = null;
  let state: [number, number, string, number] | null = null;
  for (const v of versions) {
    const transition = classifyContentStudioSourceCaptureTransition(
      previous,
      v
    );
    if (previous && isContentStudioSourcePageChange(transition)) {
      state = [
        v.fetchedAt.getTime(),
        v.versionNumber,
        transition,
        previous.fetchedAt.getTime(),
      ];
    }
    previous = v;
  }
  return state;
};
const oracleChanges = (
  versions: ContentStudioSourceVersionProtectionVersion[]
) => {
  const firstOf = (i: number) => {
    let first = i;
    while (
      first > 0 &&
      isSameContentStudioSourceCapture(versions[first - 1], versions[i])
    ) {
      first--;
    }
    return first;
  };
  return new Map(
    versions.map((v, i) => {
      const first = firstOf(i);
      const previous = first - 1;
      const before = previous >= 0 ? versions[firstOf(previous)] : null;
      return [
        v.id,
        JSON.stringify({
          before: before?.id ?? null,
          repeatOf: first < i ? versions[first].id : null,
          change: before
            ? classifyContentStudioSourceCaptureTransition(before, v)
            : 'no_earlier_change',
          titleChanged: before ? before.title !== v.title : false,
        }),
      ];
    })
  );
};

// One page from letters, at these numbers (1, 2, 3... unless given), its
// last page change stored as the backfill finds it
const lettered = (
  id: string,
  letters: string,
  numbers?: number[],
  over: (n: number) => Capture = () => ({})
) => {
  const versions = [...letters].map((letter, i) =>
    version(id, numbers ? numbers[i] : i + 1, {
      ...IDENTITY[letter],
      ...over(numbers ? numbers[i] : i + 1),
    })
  );
  const state = oracleState(versions);
  return {
    source: source(id, {
      latestVersionNumber: versions[versions.length - 1]?.versionNumber ?? 0,
      ...(state
        ? {
            lastPageChangeAt: new Date(state[0]),
            lastPageChangeVersionNumber: state[1],
            lastPageChangeKind: state[2],
            lastPageChangePreviousCaptureAt: new Date(state[3]),
          }
        : {}),
    }),
    versions,
    n: (k: number) => versions.find((v) => v.versionNumber === k)!,
  };
};

const POLICY: ContentStudioSourceVersionRetentionPolicy = {
  mode: 'compact_repeats',
  olderThan: new Date(
    NOW.getTime() - CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS
  ),
};
const policyError = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioSourceRetentionDryRunError);
    return (err as ContentStudioSourceRetentionDryRunError).code;
  }
  throw new Error('expected a dry-run error');
};

// The dry run of these pages; picker window 1 unless given, so the policy
// is seen on short histories
const dryRun = (
  pages: Array<{
    source: ContentStudioSourceVersionProtectionSource;
    versions: ContentStudioSourceVersionProtectionVersion[];
  }>,
  options: {
    references?: ContentStudioSourceVersionReference[];
    pickerWindow?: number;
    policy?: ContentStudioSourceVersionRetentionPolicy;
    now?: Date;
  } = {}
) =>
  evaluateContentStudioSourceVersionRetention({
    organizationId: ORG,
    sources: pages.map((p) => p.source),
    versions: pages.flatMap((p) => p.versions),
    references: options.references ?? [],
    now: options.now ?? NOW,
    inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
    pickerWindow: options.pickerWindow ?? 1,
    policy: options.policy ?? POLICY,
  });
const numbers = (
  result: ReturnType<typeof dryRun>,
  sourceId: string
): number[] =>
  result.sources
    .find((s) => s.sourceId === sourceId)!
    .candidates.map((c) => c.versionNumber);
const report = (
  result: ReturnType<typeof dryRun>,
  over: { now?: Date; policy?: ContentStudioSourceVersionRetentionPolicy } = {}
) =>
  buildContentStudioSourceVersionRetentionDryRun({
    organizationId: ORG,
    evaluationNow: over.now ?? NOW,
    policy: over.policy ?? POLICY,
    snapshot: {
      sourceCount: result.sources.length,
      versionCount: result.sources.reduce((t, s) => t + s.totalVersions, 0),
    },
    protectionSummary: summarizeContentStudioSourceVersionProtections([
      result.protections,
    ]),
    sources: result.sources,
    logicalContentBytes: new Map(
      result.sources.flatMap((s) =>
        s.candidates.map((c) => [c.id, 100 + c.versionNumber] as const)
      )
    ),
  });
const simulate = (
  p: ReturnType<typeof lettered>,
  candidates: number[],
  pickerWindow = 1
) =>
  simulateContentStudioSourcePageChangeStateAfterRetention({
    source: p.source,
    versions: p.versions,
    candidateIds: new Set(candidates.map((k) => p.n(k).id)),
    now: NOW,
    inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
    pickerWindow,
  });

describe('P8-R1B capture runs', () => {
  const runs = (p: ReturnType<typeof lettered>) =>
    groupContentStudioSourceVersionRuns(p.versions).map((run) =>
      run.versionIds.map(
        (id) => p.versions.find((v) => v.id === id)!.versionNumber
      )
    );

  it('D1/D2 one run, several runs: the first and last of each', () => {
    expect(runs(lettered(SOURCE, 'AAAA'))).toEqual([[1, 2, 3, 4]]);
    expect(runs(lettered(SOURCE, 'AABBBA'))).toEqual([[1, 2], [3, 4, 5], [6]]);
    const p = lettered(SOURCE, 'AAB');
    expect(groupContentStudioSourceVersionRuns(p.versions)).toEqual([
      {
        firstVersionId: p.n(1).id,
        lastVersionId: p.n(2).id,
        versionIds: [p.n(1).id, p.n(2).id],
      },
      {
        firstVersionId: p.n(3).id,
        lastVersionId: p.n(3).id,
        versionIds: [p.n(3).id],
      },
    ]);
  });

  it('D3 gaps never split a run (v1 A, v2 A, v4 A, v9 B, v11 B); the input order does not matter', () => {
    const p = lettered(SOURCE, 'AAABB', [1, 2, 4, 9, 11]);
    expect(runs(p)).toEqual([
      [1, 2, 4],
      [9, 11],
    ]);
    expect(
      groupContentStudioSourceVersionRuns(p.versions.slice().reverse())
    ).toEqual(groupContentStudioSourceVersionRuns(p.versions));
  });

  it('D4 no title is a title like any other: N N is one run, A N two', () => {
    expect(runs(lettered(SOURCE, 'NNN'))).toEqual([[1, 2, 3]]);
    expect(runs(lettered(SOURCE, 'ANNA'))).toEqual([[1], [2, 3], [4]]);
  });

  it('D5/D6/D7 another extraction, title or content splits a run: never the content hash alone', () => {
    expect(runs(lettered(SOURCE, 'AADAA'))).toEqual([[1, 2], [3], [4, 5]]);
    expect(runs(lettered(SOURCE, 'AACAA'))).toEqual([[1, 2], [3], [4, 5]]);
    expect(runs(lettered(SOURCE, 'AABAA'))).toEqual([[1, 2], [3], [4, 5]]);
    // the same blocks with another title or extraction are other captures
    expect(runs(lettered(SOURCE, 'ACDN'))).toEqual([[1], [2], [3], [4]]);
  });
});

describe('P8-R1B compact_repeats candidates', () => {
  it('I1 the interior of a run: 1 -> 0, 2 -> 0, 3 -> 1, 10 -> 8, 100 -> 98 (a B after each run)', () => {
    for (const [length, expected] of [
      [1, 0],
      [2, 0],
      [3, 1],
      [10, 8],
      [100, 98],
    ]) {
      const p = lettered(SOURCE, `${'A'.repeat(length)}B`);
      const result = dryRun([p]);
      expect([length, numbers(result, SOURCE)]).toEqual([
        length,
        Array.from({ length: expected }, (_, i) => i + 2),
      ]);
    }
  });

  it('I2 the first and last of a run are never candidates, even when nothing protects them', () => {
    const p = lettered(SOURCE, 'AAAABBBBC');
    const result = dryRun([p]);
    expect(numbers(result, SOURCE)).toEqual([2, 3, 6, 7]);
    const classified = classifyContentStudioSourceVersionRetentionCandidates({
      source: p.source,
      versions: p.versions,
      protections: new Map(),
      policy: POLICY,
      now: NOW,
    });
    expect(
      classified.policyRetained.RUN_BOUNDARY.map(
        (id) => p.versions.find((v) => v.id === id)!.versionNumber
      )
    ).toEqual([1, 4, 5, 8, 9]);
    expect(classified.candidates.map((c) => c.versionNumber)).toEqual([
      2, 3, 6, 7,
    ]);
  });

  it('I3 an interior with any protection is kept; the others of its run still go', () => {
    // A1 A2 A3 A4 B5: A2 named by each kind of stored record in turn
    const p = lettered(SOURCE, 'AAAAB');
    for (const reference of [
      ref(p.n(2)),
      ref(p.n(2), {
        reason: 'REVISION_EVIDENCE',
        referenceType: 'ContentPackageRevision',
      }),
      ref(p.n(2), {
        reason: 'REVIEW_EVIDENCE',
        referenceType: 'ContentStudioReview',
      }),
      ref(p.n(2), {
        reason: 'AI_OPERATION',
        referenceType: 'ContentStudioAIOperation',
      }),
    ]) {
      expect([
        reference.reason,
        numbers(dryRun([p], { references: [reference] }), SOURCE),
      ]).toEqual([reference.reason, [3]]);
    }
    // IN_FLIGHT: made an hour ago, or in the picker window
    const recent = lettered(SOURCE, 'AAAAB', undefined, (n) =>
      n === 2 ? { createdAt: new Date(NOW.getTime() - HOUR) } : {}
    );
    expect(numbers(dryRun([recent]), SOURCE)).toEqual([3]);
    expect(numbers(dryRun([p], { pickerWindow: 3 }), SOURCE)).toEqual([2]);
    // LATEST and PAGE_CHANGE are always run boundaries in data that holds
    // together: their override is shown on a map given directly
    for (const reason of CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS) {
      const classified = classifyContentStudioSourceVersionRetentionCandidates({
        source: p.source,
        versions: p.versions,
        protections: new Map([
          [
            p.n(2).id,
            [
              {
                organizationId: ORG,
                sourceVersionId: p.n(2).id,
                reason,
                referenceType: 'ContentStudioSource',
                referenceId: SOURCE,
              },
            ],
          ],
        ]),
        policy: POLICY,
        now: NOW,
      });
      expect([
        reason,
        classified.candidates.map((c) => c.versionNumber),
      ]).toEqual([reason, [3]]);
      expect(classified.protectedVersionIds).toEqual([p.n(2).id]);
    }
  });

  it('I4 the age: made a millisecond before olderThan is a candidate; at it exactly, or after, TOO_RECENT', () => {
    const at = (offset: number) =>
      lettered(SOURCE, 'AAAB', undefined, (n) =>
        n === 2
          ? { createdAt: new Date(POLICY.olderThan.getTime() + offset) }
          : {}
      );
    for (const [offset, candidate] of [
      [-1, true],
      [0, false],
      [1, false],
      [DAY, false],
    ] as const) {
      const p = at(offset);
      const classified = classifyContentStudioSourceVersionRetentionCandidates({
        source: p.source,
        versions: p.versions,
        protections: new Map(),
        policy: POLICY,
        now: NOW,
      });
      expect([offset, classified.candidates.length]).toEqual([
        offset,
        candidate ? 1 : 0,
      ]);
      expect([offset, classified.policyRetained.TOO_RECENT]).toEqual([
        offset,
        candidate ? [] : [p.n(2).id],
      ]);
    }
  });

  it('I5 the age is when the version was made (createdAt), never when it was fetched', () => {
    const p = lettered(SOURCE, 'AAAB', undefined, (n) =>
      n === 2 ? { createdAt: new Date(POLICY.olderThan.getTime()) } : {}
    );
    // fetched long ago, made at olderThan: kept
    expect(p.n(2).fetchedAt.getTime()).toBeLessThan(POLICY.olderThan.getTime());
    expect(numbers(dryRun([p]), SOURCE)).toEqual([]);
    const fetchedLate = lettered(SOURCE, 'AAAB');
    fetchedLate.versions[1] = {
      ...fetchedLate.versions[1],
      fetchedAt: new Date(NOW.getTime()),
    };
    // made long ago, fetched now (a fetch time that cannot be, only to
    // show which time counts): a candidate
    expect(
      classifyContentStudioSourceVersionRetentionCandidates({
        source: fetchedLate.source,
        versions: fetchedLate.versions,
        protections: new Map(),
        policy: POLICY,
        now: NOW,
      }).candidates.map((c) => c.versionNumber)
    ).toEqual([2]);
  });
});

describe('P8-R1B the policy', () => {
  it('P1 olderThan at now - 7 days exactly is valid, a millisecond later is not; the minimum is 7 days', () => {
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS).toBe(
      7 * 24 * 60 * 60 * 1000
    );
    expect(
      assertContentStudioSourceVersionRetentionPolicy(
        { mode: 'compact_repeats', olderThan: POLICY.olderThan },
        NOW
      )
    ).toEqual(POLICY);
    expect(
      policyError(() =>
        assertContentStudioSourceVersionRetentionPolicy(
          {
            mode: 'compact_repeats',
            olderThan: new Date(POLICY.olderThan.getTime() + 1),
          },
          NOW
        )
      )
    ).toBe('RETENTION_POLICY_INVALID');
  });

  it('P2 an olderThan or now that is not a valid Date is invalid', () => {
    for (const olderThan of [
      new Date('nope'),
      POLICY.olderThan.toISOString(),
      POLICY.olderThan.getTime(),
      null,
      undefined,
    ]) {
      expect(
        policyError(() =>
          assertContentStudioSourceVersionRetentionPolicy(
            { mode: 'compact_repeats', olderThan },
            NOW
          )
        )
      ).toBe('RETENTION_POLICY_INVALID');
    }
    expect(
      policyError(() =>
        assertContentStudioSourceVersionRetentionPolicy(POLICY, new Date('x'))
      )
    ).toBe('RETENTION_POLICY_INVALID');
  });

  it('P3 compact_repeats is the only mode: all_unprotected and anything else is not enabled', () => {
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MODES).toEqual([
      'compact_repeats',
    ]);
    for (const mode of [
      'all_unprotected',
      'COMPACT_REPEATS',
      'duplicate_only',
      '',
      undefined,
      null,
    ]) {
      expect(
        policyError(() =>
          assertContentStudioSourceVersionRetentionPolicy(
            { mode, olderThan: POLICY.olderThan },
            NOW
          )
        )
      ).toBe('RETENTION_POLICY_NOT_ENABLED');
    }
    // the classifier refuses a policy that is not valid too
    const p = lettered(SOURCE, 'AAAB');
    expect(
      policyError(() =>
        classifyContentStudioSourceVersionRetentionCandidates({
          source: p.source,
          versions: p.versions,
          protections: new Map(),
          policy: { ...POLICY, olderThan: NOW },
          now: NOW,
        })
      )
    ).toBe('RETENTION_POLICY_INVALID');
  });

  it('P4 the scale guard: 1,000,000 versions read, 1,000,001 refused', () => {
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_MAX_VERSIONS).toBe(
      1_000_000
    );
    expect(() =>
      assertContentStudioSourceVersionRetentionScale(1_000_000)
    ).not.toThrow();
    expect(
      policyError(() =>
        assertContentStudioSourceVersionRetentionScale(1_000_001)
      )
    ).toBe('RETENTION_DRY_RUN_SCALE_LIMIT');
    expect(() =>
      assertContentStudioSourceVersionRetentionScale(5, 5)
    ).not.toThrow();
    expect(
      policyError(() => assertContentStudioSourceVersionRetentionScale(6, 5))
    ).toBe('RETENTION_DRY_RUN_SCALE_LIMIT');
  });

  it('P5 the error codes: a dry-run code, an integrity error, nothing else', () => {
    expect(
      contentStudioSourceVersionRetentionErrorCode(
        new ContentStudioSourceRetentionDryRunError(
          'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
        )
      )
    ).toBe('RETENTION_DRY_RUN_SNAPSHOT_FAILED');
    expect(
      contentStudioSourceVersionRetentionErrorCode(
        new ContentStudioSourceRetentionIntegrityError({
          type: 'ContentPackage',
          id: 'x',
        })
      )
    ).toBe('RETENTION_INTEGRITY_ERROR');
    expect(contentStudioSourceVersionRetentionErrorCode(new Error('x'))).toBe(
      null
    );
    expect(
      new ContentStudioSourceRetentionDryRunError('RETENTION_POLICY_INVALID')
        .message
    ).toBe(
      'The source version retention dry run failed: RETENTION_POLICY_INVALID'
    );
  });
});

describe('P8-R1B the retained-set simulation', () => {
  it('S1 compact_repeats keeps every page change, comparison and run: the named fixtures', () => {
    for (const [letters, at] of [
      ['AAB', undefined],
      ['AABB', undefined],
      ['ABA', undefined],
      ['AADAA', undefined],
      ['AACCC', undefined],
      ['AAABBBA', [3, 6, 9, 10, 11, 15, 18]],
      ['AAAAABBBBB', undefined],
      ['AAAAAAAAAACCCCCCDDDDDA', undefined],
    ] as const) {
      const p = lettered(SOURCE, letters, at ? [...at] : undefined);
      const result = dryRun([p]);
      const source = result.sources[0];
      expect([letters, source.blocker]).toEqual([letters, null]);
      const removed = new Set(source.candidates.map((c) => c.id));
      const retained = p.versions.filter((v) => !removed.has(v.id));
      expect([letters, oracleState(retained)]).toEqual([
        letters,
        oracleState(p.versions),
      ]);
      const before = oracleChanges(p.versions);
      const after = oracleChanges(retained);
      for (const v of retained) {
        expect([letters, v.versionNumber, after.get(v.id)]).toEqual([
          letters,
          v.versionNumber,
          before.get(v.id),
        ]);
      }
    }
    // the gapped one: v6 and v11 go, the runs keep their ends
    expect(
      numbers(
        dryRun([lettered(SOURCE, 'AAABBBA', [3, 6, 9, 10, 11, 15, 18])]),
        SOURCE
      )
    ).toEqual([6, 11]);
  });

  it('S2 a candidate set with a run first, a run last or a changed version is refused', () => {
    // A1 A2 A3 B4 B5 B6 A7: its change is v7 against v6
    const p = lettered(SOURCE, 'AAABBBA');
    expect(simulate(p, [2, 5])).toBeNull();
    // the first of a run: what v2, v3 are compared with
    expect(simulate(p, [1])).toBe('RETAINED_SET_INVARIANT_CHANGED');
    // the first of the B run: v7's comparison baseline
    expect(simulate(p, [4])).toBe('RETAINED_SET_INVARIANT_CHANGED');
    // the last of a run: v4 was found against it
    expect(simulate(p, [3])).toBe('RETAINED_SET_INVARIANT_CHANGED');
    // the last change's predecessor, the changed version (the latest)
    expect(simulate(p, [6])).toBe('RETAINED_SET_INVARIANT_CHANGED');
    expect(simulate(p, [7])).toBe('RETAINED_SET_INVARIANT_CHANGED');
    // one bad member spoils the whole set
    expect(simulate(p, [2, 5, 4])).toBe('RETAINED_SET_INVARIANT_CHANGED');
    // a change in the middle of A B A: without B there is no change
    expect(simulate(lettered(SOURCE, 'ABA'), [2])).toBe(
      'RETAINED_SET_INVARIANT_CHANGED'
    );
    // an extraction flip-flop: A B D B without v2 loses content_changed@v2
    expect(simulate(lettered(SOURCE, 'ABDB'), [2])).toBe(
      'RETAINED_SET_INVARIANT_CHANGED'
    );
    // a run's first that nothing stored needs: only the runs see it
    expect(simulate(lettered(SOURCE, 'AAADAAA'), [1])).toBe(
      'RETAINED_SET_INVARIANT_CHANGED'
    );
    // a version that is not the source's is a caller error
    expect(() =>
      simulateContentStudioSourcePageChangeStateAfterRetention({
        source: p.source,
        versions: p.versions,
        candidateIds: new Set([vid(SOURCE_2, 1)]),
        now: NOW,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: 1,
      })
    ).toThrow(RangeError);
  });

  it('S3 a stored last page change that is not the one the versions show: PAGE_CHANGE_STATE_STALE', () => {
    // A A B C: the versions show title_changed at v4; the stored change is
    // the older content change at v3 (valid-looking: R1A accepts it)
    const p = lettered(SOURCE, 'AAABBC');
    const stale = {
      ...p,
      source: {
        ...p.source,
        lastPageChangeAt: p.n(4).fetchedAt,
        lastPageChangeVersionNumber: 4,
        lastPageChangeKind: 'content_changed',
        lastPageChangePreviousCaptureAt: p.n(3).fetchedAt,
      },
    };
    expect(() => derive([stale.source], stale.versions)).not.toThrow();
    expect(simulate(stale, [])).toBe('PAGE_CHANGE_STATE_STALE');
    expect(simulate(stale, [2])).toBe('PAGE_CHANGE_STATE_STALE');
    // no change stored at all, while the versions show one
    expect(
      simulate({ ...p, source: source(SOURCE, { latestVersionNumber: 6 }) }, [])
    ).toBe('PAGE_CHANGE_STATE_STALE');
  });

  it('S4 a blocked source holds back all its candidates and is reported; the others go on', () => {
    const blocked = lettered(SOURCE, 'AAAABBC');
    blocked.source = {
      ...blocked.source,
      lastPageChangeAt: blocked.n(5).fetchedAt,
      lastPageChangeVersionNumber: 5,
      lastPageChangeKind: 'content_changed',
      lastPageChangePreviousCaptureAt: blocked.n(4).fetchedAt,
    };
    const fine = lettered(SOURCE_2, 'AAAAB');
    const result = dryRun([blocked, fine]);
    expect(result.sources).toEqual([
      {
        sourceId: SOURCE,
        totalVersions: 7,
        protectedVersions: 4,
        policyRetainedByRule: { RUN_BOUNDARY: 1, TOO_RECENT: 0 },
        candidates: [],
        blocker: 'PAGE_CHANGE_STATE_STALE',
        blockedCandidateVersions: 2,
      },
      expect.objectContaining({
        sourceId: SOURCE_2,
        blocker: null,
        blockedCandidateVersions: 0,
      }),
    ]);
    expect(numbers(result, SOURCE_2)).toEqual([2, 3]);
    const r = report(result);
    expect(r.blockedSources).toEqual([
      {
        sourceId: SOURCE,
        blocker: 'PAGE_CHANGE_STATE_STALE',
        suppressedCandidates: 2,
      },
    ]);
    expect(r.candidateSummary).toEqual(
      expect.objectContaining({
        candidateVersions: 2,
        blockedCandidateVersions: 2,
        blockedSources: 1,
      })
    );
    // a stale source with nothing to select is not blocked
    const nothing = lettered(SOURCE, 'ABC');
    nothing.source = { ...nothing.source, latestVersionNumber: 3 };
    nothing.source.lastPageChangeAt = null;
    nothing.source.lastPageChangeVersionNumber = null;
    nothing.source.lastPageChangeKind = null;
    nothing.source.lastPageChangePreviousCaptureAt = null;
    expect(dryRun([nothing]).sources[0].blocker).toBeNull();
  });

  it('S5 stored data that does not hold together fails the whole dry run, never one source', () => {
    const p = lettered(SOURCE, 'AAAB');
    const other = lettered(SOURCE_2, 'AAAB');
    expect(
      failure(() =>
        dryRun([p, other], {
          references: [ref(p.n(2), { contentHash: sha256Hex('other') })],
        })
      )
    ).toEqual({ type: 'ContentPackage', id: uuid(0x9001, 1) });
    expect(
      failure(() =>
        dryRun([
          p,
          { ...other, source: { ...other.source, latestVersionNumber: 9 } },
        ])
      )
    ).toEqual({ type: 'ContentStudioSource', id: SOURCE_2 });
  });
});

describe('P8-R1B the bounded exhaustive check', () => {
  // Every sequence of up to 6 captures of A B C D N F, numbered 1, 2, 3...
  // and with gaps: every subset of its run interiors (all of them unless
  // LATEST or PAGE_CHANGE needs one) keeps the stored page change and every
  // retained version's comparison; and wherever the simulation lets a
  // single version go, nothing it would change shows
  it('X1 up to 6 captures over six identities: no counterexample', () => {
    const letters = 'ABCDNF';
    let sequences = 0;
    let subsets = 0;
    let singlesRefused = 0;
    const all = (length: number, prefix = ''): string[] =>
      length === 0
        ? [prefix]
        : [...letters].flatMap((l) => all(length - 1, prefix + l));
    for (let length = 1; length <= 6; length++) {
      for (const seq of all(length)) {
        for (const gaps of [false, true]) {
          sequences++;
          const p = lettered(
            SOURCE,
            seq,
            gaps ? [...seq].map((_, i) => i * 3 + (i % 2) + 1) : undefined
          );
          const state = oracleState(p.versions);
          const before = oracleChanges(p.versions);
          const protectedIds = new Set(
            derive([p.source], p.versions)
              .filter(
                (e) => e.reason === 'LATEST' || e.reason === 'PAGE_CHANGE'
              )
              .map((e) => e.sourceVersionId)
          );
          const interiors = groupContentStudioSourceVersionRuns(p.versions)
            .flatMap((run) => run.versionIds.slice(1, -1))
            .filter((id) => !protectedIds.has(id));
          expect(protectedIds.size).toBeGreaterThan(0);
          for (let mask = 0; mask < 1 << interiors.length; mask++) {
            subsets++;
            const ids = new Set(interiors.filter((_, i) => mask & (1 << i)));
            const retained = p.versions.filter((v) => !ids.has(v.id));
            const after = oracleChanges(retained);
            const verdict =
              simulateContentStudioSourcePageChangeStateAfterRetention({
                source: p.source,
                versions: p.versions,
                candidateIds: ids,
                now: NOW,
                inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
                pickerWindow: 1,
              });
            if (
              verdict !== null ||
              JSON.stringify(oracleState(retained)) !== JSON.stringify(state) ||
              retained.some((v) => after.get(v.id) !== before.get(v.id))
            ) {
              throw new Error(`counterexample ${seq} ${gaps} ${mask}`);
            }
          }
          // soundness: a single version the simulation lets go changes
          // nothing the oracle sees
          for (const v of p.versions) {
            const retained = p.versions.filter((w) => w.id !== v.id);
            const verdict =
              simulateContentStudioSourcePageChangeStateAfterRetention({
                source: p.source,
                versions: p.versions,
                candidateIds: new Set([v.id]),
                now: NOW,
                inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
                pickerWindow: 1,
              });
            if (verdict !== null) {
              singlesRefused++;
              continue;
            }
            const after = oracleChanges(retained);
            if (
              JSON.stringify(oracleState(retained)) !== JSON.stringify(state) ||
              retained.some((w) => after.get(w.id) !== before.get(w.id))
            ) {
              throw new Error(`unsound ${seq} ${gaps} v${v.versionNumber}`);
            }
          }
        }
      }
    }
    // 6 + 36 + ... + 46,656 sequences, each contiguous and with gaps
    expect(sequences).toBe(2 * 55_986);
    expect(subsets).toBeGreaterThan(sequences);
    // the negative controls: the simulation does refuse versions
    expect(singlesRefused).toBeGreaterThan(sequences);
  }, 120_000);
});

describe('P8-R1B the report and its hash', () => {
  const pages = () => [
    lettered(SOURCE, 'AAAABBBBC'),
    lettered(SOURCE_2, 'AAAB', undefined, (n) =>
      n === 2 ? { createdAt: new Date(NOW.getTime() - 3 * DAY) } : {}
    ),
  ];
  const hashOf = (
    over: Partial<
      Parameters<typeof contentStudioSourceVersionRetentionDryRunHash>[0]
    > = {}
  ) => {
    const r = report(dryRun(pages()));
    return contentStudioSourceVersionRetentionDryRunHash({
      organizationId: ORG,
      evaluationNow: NOW,
      validUntil: new Date(
        NOW.getTime() +
          CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_VALIDITY_MS
      ),
      policy: POLICY,
      candidates: r.candidates,
      blockedSources: r.blockedSources,
      ...over,
    });
  };

  it('R1 the exact report: counts that add up, sources, candidates in order, no content', () => {
    const r = report(dryRun(pages()));
    expect(Object.keys(r)).toEqual([
      'format',
      'dryRunFormatVersion',
      'protectionVersion',
      'policyVersion',
      'organizationId',
      'evaluationNow',
      'validUntil',
      'policy',
      'snapshot',
      'protectionSummary',
      'candidateSummary',
      'sources',
      'blockedSources',
      'candidates',
      'dryRunHash',
    ]);
    expect(r.format).toBe('content-studio.source-version-retention-dry-run');
    expect([
      r.dryRunFormatVersion,
      r.protectionVersion,
      r.policyVersion,
    ]).toEqual([1, 1, 1]);
    expect(r.evaluationNow).toBe('2026-10-26T12:00:00.000Z');
    expect(r.validUntil).toBe('2026-10-26T13:00:00.000Z');
    expect(r.policy).toEqual({
      mode: 'compact_repeats',
      olderThan: '2026-10-19T12:00:00.000Z',
    });
    expect(r.snapshot).toEqual({
      isolation: 'repeatable_read',
      sourceCount: 2,
      versionCount: 13,
    });
    // A1-A4 B5-B8 C9: v5, v8, v9 protected (the change against the B run
    // and the latest), v1 and v4 kept, v2 v3 v6 v7 candidates; A1 A2 A3 B4:
    // v1, v3, v4 protected, v2 too recent
    expect(r.candidateSummary).toEqual({
      totalVersions: 13,
      protectedVersions: 6,
      technicallyUnprotectedVersions: 7,
      policyRetainedVersions: 3,
      policyRetainedByRule: { RUN_BOUNDARY: 2, TOO_RECENT: 1 },
      candidateVersions: 4,
      blockedCandidateVersions: 0,
      blockedSources: 0,
      logicalContentBytes: 102 + 103 + 106 + 107,
      oldestCandidateCreatedAt: '2026-01-01T00:02:00.000Z',
      newestCandidateCreatedAt: '2026-01-01T00:07:00.000Z',
    });
    expect(r.protectionSummary.protectedVersions).toBe(6);
    expect(r.sources.map((s) => [s.sourceId, s.candidateVersions])).toEqual([
      [SOURCE, 4],
      [SOURCE_2, 0],
    ]);
    expect(r.candidates[0]).toEqual({
      id: vid(SOURCE, 2),
      sourceId: SOURCE,
      versionNumber: 2,
      contentHash: sha256Hex('A'),
      createdAt: '2026-01-01T00:02:00.000Z',
      fetchedAt: '2026-01-01T00:02:00.000Z',
      candidateReason: 'REPEAT_RUN_INTERIOR',
      logicalContentBytes: 102,
    });
    expect(r.candidates.map((c) => c.versionNumber)).toEqual([2, 3, 6, 7]);
    // plain JSON: canonical JSON takes it as it is
    expect(JSON.parse(canonicalJson(r))).toEqual(r);
    expect(JSON.stringify(r)).not.toMatch(/content"|quote|title|Url|url"/);
  });

  it('R2 the partitions hold for the organization and each source; reasons are never summed', () => {
    const many = [
      lettered(SOURCE, 'AAAAAABBBBBBBBC'),
      lettered(
        SOURCE_2,
        'ANNNNNFFFFF',
        [1, 2, 5, 6, 9, 10, 20, 21, 22, 23, 24]
      ),
    ];
    const result = dryRun(many, {
      references: [
        ref(many[0].n(3)),
        ref(many[0].n(3), { referenceId: uuid(0x9001, 2) }),
      ],
      pickerWindow: 4,
    });
    const r = report(result);
    const c = r.candidateSummary;
    expect(c.totalVersions).toBe(
      c.protectedVersions + c.technicallyUnprotectedVersions
    );
    expect(c.technicallyUnprotectedVersions).toBe(
      c.policyRetainedVersions +
        c.candidateVersions +
        c.blockedCandidateVersions
    );
    expect(c.policyRetainedVersions).toBe(
      c.policyRetainedByRule.RUN_BOUNDARY + c.policyRetainedByRule.TOO_RECENT
    );
    for (const s of r.sources) {
      expect(s.totalVersions).toBe(
        s.protectedVersions +
          s.policyRetainedVersions +
          s.candidateVersions +
          s.blockedCandidateVersions
      );
    }
    const p = r.protectionSummary;
    expect(p.protectedVersions).toBe(result.protections.size);
    expect(Object.values(p.edgesByReason).reduce((a, b) => a + b, 0)).toBe(
      p.protectionEdges
    );
    // v15 is LATEST and in the picker window: one version, two reasons
    expect(
      Object.values(p.versionsByReason).reduce((a, b) => a + b, 0)
    ).toBeGreaterThan(p.protectedVersions);
    expect(p.edgesByReason.DRAFT_EVIDENCE).toBe(2);
    expect(p.versionsByReason.DRAFT_EVIDENCE).toBe(1);
    // a report whose counts do not add up is never made
    expect(() =>
      buildContentStudioSourceVersionRetentionDryRun({
        organizationId: ORG,
        evaluationNow: NOW,
        policy: POLICY,
        snapshot: { sourceCount: 2, versionCount: c.totalVersions + 1 },
        protectionSummary: summarizeContentStudioSourceVersionProtections([
          result.protections,
        ]),
        sources: result.sources,
        logicalContentBytes: new Map(
          r.candidates.map((x) => [x.id, x.logicalContentBytes])
        ),
      })
    ).toThrow(RangeError);
  });

  it('H1/H11 the same input, in any order, is the same hash; it is the hash of exactly the pinned payload', () => {
    const r = report(dryRun(pages()));
    expect(report(dryRun(pages().reverse())).dryRunHash).toBe(r.dryRunHash);
    expect(
      report(
        dryRun(
          pages().map((p) => ({ ...p, versions: p.versions.slice().reverse() }))
        )
      ).dryRunHash
    ).toBe(r.dryRunHash);
    expect(hashOf()).toBe(r.dryRunHash);
    expect(hashOf({ candidates: r.candidates.slice().reverse() })).toBe(
      r.dryRunHash
    );
    expect(r.dryRunHash).toBe(
      sha256Hex(
        canonicalJson({
          format: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT,
          dryRunFormatVersion: 1,
          protectionVersion: 1,
          policyVersion: 1,
          organizationId: ORG,
          evaluationNow: '2026-10-26T12:00:00.000Z',
          validUntil: '2026-10-26T13:00:00.000Z',
          policy: {
            mode: 'compact_repeats',
            olderThan: '2026-10-19T12:00:00.000Z',
          },
          candidates: r.candidates.map((c) => [
            c.sourceId,
            c.versionNumber,
            c.id,
            c.contentHash,
          ]),
          blockedSources: [],
        })
      )
    );
  });

  it('H2-H10/H13 every part of the plan changes the hash', () => {
    const r = report(dryRun(pages()));
    const base = hashOf();
    const first = r.candidates[0];
    const changed = (c: typeof first) => [c, ...r.candidates.slice(1)];
    const variants: Array<[string, string]> = [
      [
        'id',
        hashOf({ candidates: changed({ ...first, id: vid(SOURCE, 99) }) }),
      ],
      [
        'sourceId',
        hashOf({ candidates: changed({ ...first, sourceId: SOURCE_2 }) }),
      ],
      [
        'versionNumber',
        hashOf({ candidates: changed({ ...first, versionNumber: 99 }) }),
      ],
      [
        'contentHash',
        hashOf({
          candidates: changed({ ...first, contentHash: sha256Hex('Z') }),
        }),
      ],
      [
        'policy',
        hashOf({
          policy: {
            ...POLICY,
            olderThan: new Date(POLICY.olderThan.getTime() - 1000),
          },
        }),
      ],
      [
        'evaluationNow',
        hashOf({ evaluationNow: new Date(NOW.getTime() + 1000) }),
      ],
      [
        'validUntil',
        hashOf({ validUntil: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) }),
      ],
      [
        'protectionVersion',
        hashOf({ versions: { format: 1, protection: 2, policy: 1 } }),
      ],
      [
        'policyVersion',
        hashOf({ versions: { format: 1, protection: 1, policy: 2 } }),
      ],
      [
        'formatVersion',
        hashOf({ versions: { format: 2, protection: 1, policy: 1 } }),
      ],
      [
        'blockedSources',
        hashOf({
          blockedSources: [
            {
              sourceId: SOURCE_2,
              blocker: 'PAGE_CHANGE_STATE_STALE',
              suppressedCandidates: 1,
            },
          ],
        }),
      ],
      [
        'blocker',
        hashOf({
          blockedSources: [
            {
              sourceId: SOURCE_2,
              blocker: 'RETAINED_SET_INVARIANT_CHANGED',
              suppressedCandidates: 1,
            },
          ],
        }),
      ],
      ['fewer', hashOf({ candidates: r.candidates.slice(1) })],
      ['organization', hashOf({ organizationId: OTHER_ORG })],
    ];
    const hashes = variants.map(([, h]) => h);
    expect(new Set([base, ...hashes]).size).toBe(variants.length + 1);
    // the versions in use are 1, 1, 1
    expect(hashOf({ versions: { format: 1, protection: 1, policy: 1 } })).toBe(
      base
    );
    expect([
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION,
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION,
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION,
    ]).toEqual([1, 1, 1]);
  });

  it('H12 the sizes, times and counts are reported, never hashed', () => {
    const result = dryRun(pages());
    const r = report(result);
    const other = buildContentStudioSourceVersionRetentionDryRun({
      organizationId: ORG,
      evaluationNow: NOW,
      policy: POLICY,
      snapshot: { sourceCount: 2, versionCount: 13 },
      protectionSummary: summarizeContentStudioSourceVersionProtections([
        result.protections,
      ]),
      sources: result.sources.map((s) => ({
        ...s,
        candidates: s.candidates.map((c) => ({
          ...c,
          createdAt: new Date(c.createdAt.getTime() - DAY),
          fetchedAt: new Date(c.fetchedAt.getTime() - DAY),
        })),
      })),
      logicalContentBytes: new Map(r.candidates.map((c) => [c.id, 9_999])),
    });
    expect(other.candidateSummary.logicalContentBytes).toBe(4 * 9_999);
    expect(other.candidates[0].createdAt).not.toBe(r.candidates[0].createdAt);
    expect(other.dryRunHash).toBe(r.dryRunHash);
  });

  it('H14 no candidate: a valid report with its own stable hash', () => {
    const r = report(dryRun([lettered(SOURCE, 'AB')]));
    expect(r.candidates).toEqual([]);
    expect(r.candidateSummary.candidateVersions).toBe(0);
    expect(r.candidateSummary.oldestCandidateCreatedAt).toBeNull();
    expect(r.dryRunHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report(dryRun([lettered(SOURCE, 'AB')])).dryRunHash).toBe(
      r.dryRunHash
    );
    const empty = report(dryRun([]));
    expect(empty.sources).toEqual([]);
    expect(empty.dryRunHash).toBe(r.dryRunHash);
  });

  it('H15 the order is code units, never the locale: source, number, id', () => {
    // 'a' sorts after 'B' in code units, before it in most locales
    const lower = 'a0000000-0000-4000-8000-000000000001';
    const upper = 'B0000000-0000-4000-8000-000000000001';
    const candidate = (
      sourceId: string,
      versionNumber: number,
      id: string
    ) => ({
      sourceId,
      versionNumber,
      id,
      contentHash: sha256Hex('A'),
    });
    expect(
      hashOf({
        candidates: [
          candidate(lower, 2, 'x'),
          candidate(upper, 10, 'y'),
          candidate(upper, 9, 'z'),
        ],
      })
    ).toBe(
      sha256Hex(
        canonicalJson({
          format: CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT,
          dryRunFormatVersion: 1,
          protectionVersion: 1,
          policyVersion: 1,
          organizationId: ORG,
          evaluationNow: NOW.toISOString(),
          validUntil: '2026-10-26T13:00:00.000Z',
          policy: {
            mode: 'compact_repeats',
            olderThan: POLICY.olderThan.toISOString(),
          },
          candidates: [
            [upper, 9, 'z', sha256Hex('A')],
            [upper, 10, 'y', sha256Hex('A')],
            [lower, 2, 'x', sha256Hex('A')],
          ],
          blockedSources: [],
        })
      )
    );
  });
});

describe('P8-R1B batches', () => {
  // Many pages with gaps, repeats, changes, references of every kind
  // (some across sources), recent versions: evaluated whole and in batches
  // of every size, the protections, candidates, blocked sources and hash
  // are the same
  it('B1 a batch is the organization: the same map, candidates and hash however the sources are batched', () => {
    let seed = 20261026;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pages = Array.from({ length: 450 }, (_, s) => {
      const id = uuid(0x5100 + (s % 7), s + 1);
      let seq = 'ABCDNF'[Math.floor(rnd() * 6)];
      const length = 1 + Math.floor(rnd() * 30);
      while (seq.length < length) {
        seq +=
          rnd() < 0.7 ? seq[seq.length - 1] : 'ABCDNF'[Math.floor(rnd() * 6)];
      }
      let n = 0;
      return lettered(
        id,
        seq,
        [...seq].map(() => (n += 1 + Math.floor(rnd() * 3))),
        () =>
          rnd() < 0.05 ? { createdAt: new Date(NOW.getTime() - HOUR) } : {}
      );
    });
    // a stale one
    pages[7].source = {
      ...pages[7].source,
      lastPageChangeAt: null,
      lastPageChangeVersionNumber: null,
      lastPageChangeKind: null,
      lastPageChangePreviousCaptureAt: null,
    };
    const references: ContentStudioSourceVersionReference[] = [];
    const reasons = [
      ['DRAFT_EVIDENCE', 'ContentPackage'],
      ['REVISION_EVIDENCE', 'ContentPackageRevision'],
      ['REVIEW_EVIDENCE', 'ContentStudioReview'],
      ['AI_OPERATION', 'ContentStudioAIOperation'],
    ] as const;
    for (let r = 0; r < 600; r++) {
      const [reason, referenceType] = reasons[r % 4];
      // one record naming versions of two sources, as a prompt or a draft can
      for (const p of [pages[r % 450], pages[(r * 7 + 3) % 450]]) {
        const v = p.versions[Math.floor(rnd() * p.versions.length)];
        references.push(
          ref(v, { reason, referenceType, referenceId: uuid(0x9100, r + 1) })
        );
      }
    }
    const evaluate = (
      batch: typeof pages,
      refs: ContentStudioSourceVersionReference[]
    ) =>
      evaluateContentStudioSourceVersionRetention({
        organizationId: ORG,
        sources: batch.map((p) => p.source),
        versions: batch.flatMap((p) => p.versions),
        references: refs,
        now: NOW,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: 3,
        policy: POLICY,
      });
    const whole = evaluate(pages, references);
    const wholeReport = report(whole);
    expect(wholeReport.candidateSummary.candidateVersions).toBeGreaterThan(500);
    expect(wholeReport.candidateSummary.blockedSources).toBe(1);
    for (const size of [
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_SOURCE_BATCH_SIZE,
      1,
      7,
      449,
    ]) {
      const sorted = pages
        .slice()
        .sort((a, b) => (a.source.id < b.source.id ? -1 : 1));
      const batches = [];
      for (let i = 0; i < sorted.length; i += size) {
        const batch = sorted.slice(i, i + size);
        const ids = new Set(batch.map((p) => p.source.id));
        batches.push(
          evaluate(
            batch,
            references.filter((x) => ids.has(x.sourceId))
          )
        );
      }
      const merged = buildContentStudioSourceVersionProtectionMap(
        batches.flatMap((b) => [...b.protections.values()].flat())
      );
      expect([size, serialized(merged)]).toEqual([
        size,
        serialized(whole.protections),
      ]);
      const batched = buildContentStudioSourceVersionRetentionDryRun({
        organizationId: ORG,
        evaluationNow: NOW,
        policy: POLICY,
        snapshot: wholeReport.snapshot,
        protectionSummary: summarizeContentStudioSourceVersionProtections(
          batches.map((b) => b.protections)
        ),
        sources: batches.flatMap((b) => b.sources),
        logicalContentBytes: new Map(
          wholeReport.candidates.map((c) => [c.id, c.logicalContentBytes])
        ),
      });
      expect([size, canonicalJson(batched)]).toEqual([
        size,
        canonicalJson(wholeReport),
      ]);
    }
  });
});

// --- the retention execution (P8-R1C) ---

// A reviewed plan: the report of a dry run, as its command prints it
const reviewed = () => {
  const pages = [lettered(SOURCE, 'AAAAB'), lettered(SOURCE_2, 'AAAAAAB')];
  return JSON.parse(canonicalJson(report(dryRun(pages))));
};
type Plan = ReturnType<typeof reviewed>;
// the plan with its hash made again after a change, what a forger would
// do; a value that cannot be hashed keeps the old hash
const rehashed = (plan: Plan) => {
  try {
    return {
      ...plan,
      dryRunHash: contentStudioSourceVersionRetentionDryRunHash({
        organizationId: plan.organizationId,
        evaluationNow: new Date(plan.evaluationNow),
        validUntil: new Date(plan.validUntil),
        policy: {
          mode: plan.policy.mode,
          olderThan: new Date(plan.policy.olderThan),
        },
        candidates: plan.candidates,
        blockedSources: plan.blockedSources,
      }),
    };
  } catch {
    return plan;
  }
};
const executionError = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(
      ContentStudioSourceVersionRetentionExecutionError
    );
    return (err as ContentStudioSourceVersionRetentionExecutionError).code;
  }
  throw new Error('expected an execution error');
};
const parse = (plan: unknown, organizationId = ORG) =>
  parseContentStudioSourceVersionRetentionPlan(
    typeof plan === 'string' ? plan : JSON.stringify(plan),
    organizationId
  );
const invalid = (plan: unknown, organizationId = ORG) =>
  executionError(() => parse(plan, organizationId));

describe('P8-R1C the plan of an execution', () => {
  it('E1 the report of a dry run is read back as its plan: what its hash covers, in canonical order', () => {
    const plan = reviewed();
    expect(plan.candidates).toHaveLength(2 + 4);
    const parsed = parse(plan);
    expect(parsed).toEqual({
      organizationId: ORG,
      planHash: plan.dryRunHash,
      evaluationNow: NOW,
      validUntil: new Date(NOW.getTime() + HOUR),
      policy: POLICY,
      candidates: plan.candidates.map(
        (c: {
          id: string;
          sourceId: string;
          versionNumber: number;
          contentHash: string;
        }) => ({
          id: c.id,
          sourceId: c.sourceId,
          versionNumber: c.versionNumber,
          contentHash: c.contentHash,
        })
      ),
      sourceCount: 2,
      logicalContentBytes: plan.candidateSummary.logicalContentBytes,
    });
    // the input order does not matter
    const shuffled = { ...plan, candidates: [...plan.candidates].reverse() };
    expect(parse(shuffled).candidates).toEqual(parsed.candidates);
    // the canonical text or any JSON of it
    expect(parse(canonicalJson(plan))).toEqual(parsed);
  });

  it('E2/E15 its hash is the hash of exactly what it says: any edit of what is hashed fails, an edit of what is shown does not', () => {
    const plan = reviewed();
    const edits: Array<(p: Plan) => void> = [
      (p) => p.candidates.pop(),
      (p) => (p.candidates[0].contentHash = 'f'.repeat(64)),
      (p) => (p.candidates[0].versionNumber += 100),
      (p) => (p.candidates[0].sourceId = SOURCE_2),
      (p) => (p.policy.olderThan = '2026-01-01T00:00:00.000Z'),
      (p) => (p.evaluationNow = '2026-10-26T11:00:00.000Z'),
      (p) => (p.dryRunHash = 'a'.repeat(64)),
      (p) => (p.dryRunHash = p.dryRunHash.toUpperCase()),
    ];
    for (const edit of edits) {
      const copy = JSON.parse(JSON.stringify(plan));
      edit(copy);
      expect([String(edit), invalid(copy)]).toEqual([
        String(edit),
        'RETENTION_EXECUTION_PLAN_INVALID',
      ]);
    }
    const shown = JSON.parse(JSON.stringify(plan));
    shown.candidateSummary.logicalContentBytes = 1;
    shown.candidates[0].createdAt = '2000-01-01T00:00:00.000Z';
    shown.candidates[0].logicalContentBytes = 0;
    shown.sources = [];
    shown.protectionSummary = null;
    expect(parse(shown).planHash).toBe(plan.dryRunHash);
    expect(parse(shown).logicalContentBytes).toBe(1);
    shown.candidateSummary = null;
    expect(parse(shown).logicalContentBytes).toBeNull();
  });

  it('E3/E4/E14 its times are those of a dry run: whole seconds in UTC, valid for exactly one hour', () => {
    const plan = reviewed();
    for (const evaluationNow of [
      '2026-10-26T12:00:00Z',
      '2026-10-26T12:00:00.001Z',
      '2026-10-26T12:00:00.000+00:00',
      '2026-10-26 12:00:00.000Z',
      '2026-02-30T12:00:00.000Z',
      1793016000000,
      null,
    ]) {
      expect([
        evaluationNow,
        invalid(rehashed({ ...plan, evaluationNow })),
      ]).toEqual([evaluationNow, 'RETENTION_EXECUTION_PLAN_INVALID']);
    }
    // validUntil one hour after, exactly
    for (const validUntil of [
      '2026-10-26T13:00:01.000Z',
      '2026-10-26T12:59:59.000Z',
      '2026-10-26T12:00:00.000Z',
    ]) {
      expect(invalid(rehashed({ ...plan, validUntil }))).toBe(
        'RETENTION_EXECUTION_PLAN_INVALID'
      );
    }
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_VALIDITY_MS).toBe(
      HOUR
    );
  });

  it('E5 a plan holding a source back is refused: BLOCKED_SOURCES', () => {
    const plan = reviewed();
    expect(
      invalid(
        rehashed({
          ...plan,
          blockedSources: [
            {
              sourceId: SOURCE_2,
              blocker: 'PAGE_CHANGE_STATE_STALE',
              suppressedCandidates: 1,
            },
          ],
        })
      )
    ).toBe('RETENTION_EXECUTION_BLOCKED_SOURCES');
    expect(invalid({ ...plan, blockedSources: null })).toBe(
      'RETENTION_EXECUTION_PLAN_INVALID'
    );
  });

  it('E6 a plan with no candidates is read as one: nothing to remove', () => {
    const plan = rehashed({ ...reviewed(), candidates: [] });
    expect(parse(plan)).toEqual(
      expect.objectContaining({ candidates: [], sourceCount: 0 })
    );
  });

  it('E7 only the current format and rule versions', () => {
    const plan = reviewed();
    for (const [key, value] of [
      ['format', 'content-studio.source-version-retention-dry-run-v2'],
      ['dryRunFormatVersion', 2],
      ['protectionVersion', 2],
      ['policyVersion', 2],
      ['dryRunFormatVersion', '1'],
      ['protectionVersion', 0],
      ['policyVersion', null],
    ] as const) {
      expect([key, value, invalid({ ...plan, [key]: value })]).toEqual([
        key,
        value,
        'RETENTION_EXECUTION_PLAN_INVALID',
      ]);
    }
    expect(
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_FORMAT_VERSION
    ).toBe(1);
  });

  it('E8 compact_repeats only, at least the minimum age before the plan', () => {
    const plan = reviewed();
    for (const mode of ['all_unprotected', 'COMPACT_REPEATS']) {
      expect(
        invalid(rehashed({ ...plan, policy: { ...plan.policy, mode } }))
      ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    }
    expect(
      invalid({ ...plan, policy: { olderThan: plan.policy.olderThan } })
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    // six days and 23 hours: too recent, even with its own hash
    expect(
      invalid(
        rehashed({
          ...plan,
          policy: {
            ...plan.policy,
            olderThan: new Date(
              NOW.getTime() -
                CONTENT_STUDIO_SOURCE_VERSION_RETENTION_MIN_AGE_MS +
                HOUR
            ).toISOString(),
          },
        })
      )
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
  });

  it('E9 at most 10,000 candidates: a larger plan is refused whole, TOO_LARGE', () => {
    expect(
      CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_MAX_CANDIDATES
    ).toBe(10_000);
    const many = (count: number) =>
      rehashed({
        ...reviewed(),
        candidates: Array.from({ length: count }, (_, i) => ({
          id: uuid(0x9000, i + 1),
          sourceId: SOURCE,
          versionNumber: i + 2,
          contentHash: sha256Hex('A'),
          candidateReason: 'REPEAT_RUN_INTERIOR',
        })),
      });
    expect(parse(many(10_000)).candidates).toHaveLength(10_000);
    expect(invalid(many(10_001))).toBe('RETENTION_EXECUTION_TOO_LARGE');
  });

  it('E10/E11/E12 every candidate a distinct run interior, as the dry run names it', () => {
    const plan = reviewed();
    const candidate = plan.candidates[0];
    const variants: Array<Record<string, unknown>> = [
      // a uuid in capitals
      { id: `A${candidate.id.slice(1)}` },
      { id: 'v-1' },
      { sourceId: 'source' },
      { versionNumber: 0 },
      { versionNumber: 1.5 },
      { versionNumber: '3' },
      { contentHash: candidate.contentHash.toUpperCase() },
      { contentHash: 'abc' },
      { candidateReason: 'RUN_BOUNDARY' },
      { candidateReason: undefined },
    ];
    for (const variant of variants) {
      expect([
        variant,
        invalid(
          rehashed({
            ...plan,
            candidates: [
              { ...candidate, ...variant },
              ...plan.candidates.slice(1),
            ],
          })
        ),
      ]).toEqual([variant, 'RETENTION_EXECUTION_PLAN_INVALID']);
    }
    // the same id twice, or the same source and number twice
    expect(
      invalid(
        rehashed({
          ...plan,
          candidates: [...plan.candidates, { ...candidate, versionNumber: 99 }],
        })
      )
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    expect(
      invalid(
        rehashed({
          ...plan,
          candidates: [
            ...plan.candidates,
            { ...candidate, id: uuid(0x9999, 1) },
          ],
        })
      )
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    expect(invalid(rehashed({ ...plan, candidates: [null] }))).toBe(
      'RETENTION_EXECUTION_PLAN_INVALID'
    );
  });

  it('E13 of the organization named, an organization id', () => {
    const plan = reviewed();
    expect(invalid(plan, OTHER_ORG)).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    expect(invalid(plan, ORG.toUpperCase())).toBe(
      'RETENTION_EXECUTION_PLAN_INVALID'
    );
    expect(invalid(rehashed({ ...plan, organizationId: OTHER_ORG }))).toBe(
      'RETENTION_EXECUTION_PLAN_INVALID'
    );
  });

  it('E16 not JSON, not a report, or larger than 64 MiB: refused before anything is decided', () => {
    for (const text of ['', '{', 'null', '[]', '"plan"', '{}']) {
      expect([text, invalid(text)]).toEqual([
        text,
        'RETENTION_EXECUTION_PLAN_INVALID',
      ]);
    }
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_MAX_BYTES).toBe(
      64 * 1024 * 1024
    );
    const parseSpy = jest.spyOn(JSON, 'parse');
    expect(
      invalid(
        ' '.repeat(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_MAX_BYTES + 1)
      )
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
    // bytes, not characters: 'é' is two
    const text = canonicalJson(reviewed());
    expect(
      invalid(
        text +
          'é'.repeat(
            Math.ceil(
              (CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PLAN_MAX_BYTES -
                Buffer.byteLength(text)) /
                2
            ) + 1
          )
      )
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
  });

  it('the execution codes, statuses and ends', () => {
    expect([
      ...CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_ERRORS,
    ]).toEqual([
      'RETENTION_EXECUTION_PLAN_INVALID',
      'RETENTION_EXECUTION_PLAN_EXPIRED',
      'RETENTION_EXECUTION_HASH_MISMATCH',
      'RETENTION_EXECUTION_BLOCKED_SOURCES',
      'RETENTION_EXECUTION_TOO_LARGE',
      'RETENTION_EXECUTION_ALREADY_ACTIVE',
      'RETENTION_EXECUTION_ALREADY_RUN',
      'RETENTION_EXECUTION_NOT_READY',
      'RETENTION_EXECUTION_STATE_INVALID',
      'RETENTION_EXECUTION_QUARANTINE_FAILED',
      'RETENTION_EXECUTION_RECHECK_FAILED',
      'RETENTION_EXECUTION_BATCH_FAILED',
      'RETENTION_EXECUTION_INTEGRITY_FAILED',
      'RETENTION_EXECUTION_CLEANUP_REQUIRED',
    ]);
    expect([
      ...CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_STATUSES,
    ]).toEqual([
      'preparing',
      'prepared',
      'executing',
      'completed',
      'cancelled',
      'aborted',
      'partial',
    ]);
    expect([
      ...CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_TERMINAL,
    ]).toEqual(['completed', 'cancelled', 'aborted', 'partial']);
    for (const status of CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_STATUSES) {
      expect([
        status,
        isContentStudioSourceVersionRetentionExecutionTerminal(status),
      ]).toEqual([
        status,
        ['completed', 'cancelled', 'aborted', 'partial'].includes(status),
      ]);
    }
    // a fixed message with the code only
    const err = new ContentStudioSourceVersionRetentionExecutionError(
      'RETENTION_EXECUTION_RECHECK_FAILED',
      'CANDIDATE_CHANGED'
    );
    expect(err.message).toBe(
      'The source version retention execution failed: RETENTION_EXECUTION_RECHECK_FAILED'
    );
    expect(err.detail).toBe('CANDIDATE_CHANGED');
  });

  it('the plan made again is the report: one derivation of what is selected, held back and hashed', () => {
    const pages = [lettered(SOURCE, 'AAAAB'), lettered(SOURCE_2, 'AAAAAAB')];
    // a stale page: held back
    const stale = lettered(uuid(0x5001, 3), 'AAAAB');
    stale.source.lastPageChangeAt = null;
    stale.source.lastPageChangeVersionNumber = null;
    stale.source.lastPageChangeKind = null;
    stale.source.lastPageChangePreviousCaptureAt = null;
    const result = dryRun([...pages, stale]);
    const full = report(result);
    const replayed = planContentStudioSourceVersionRetention({
      organizationId: ORG,
      evaluationNow: NOW,
      policy: POLICY,
      sources: result.sources,
    });
    expect(full.blockedSources).toHaveLength(1);
    expect(replayed.dryRunHash).toBe(full.dryRunHash);
    expect(replayed.validUntil.toISOString()).toBe(full.validUntil);
    expect(replayed.blockedSources).toEqual(full.blockedSources);
    expect(replayed.candidates.map((c) => c.id)).toEqual(
      full.candidates.map((c) => c.id)
    );
  });
});

describe('P8-R1C batches, the wait and each source after', () => {
  const candidate = (sourceId: string, n: number) => ({
    id: uuid(0x9100 + Number.parseInt(sourceId.slice(-4), 16), n),
    sourceId,
    versionNumber: n,
  });
  const S = [1, 2, 3, 4].map((n) => uuid(0x5100, n));
  const shape = (
    batches: Array<Array<{ sourceId: string; versionNumber: number }>>
  ) =>
    batches.map((batch) =>
      batch.map((c) => `${S.indexOf(c.sourceId)}:${c.versionNumber}`)
    );

  it('canonical order; whole small sources packed up to the size; a larger source fills batches of its own', () => {
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DELETE_BATCH_SIZE).toBe(100);
    const list = [
      ...[5, 3, 4].map((n) => candidate(S[2], n)),
      ...[2, 3].map((n) => candidate(S[0], n)),
      ...Array.from({ length: 7 }, (_, i) => candidate(S[1], i + 2)),
      candidate(S[3], 9),
    ];
    expect(
      shape(batchContentStudioSourceVersionRetentionCandidates(list, 4))
    ).toEqual([
      ['0:2', '0:3'],
      ['1:2', '1:3', '1:4', '1:5'],
      ['1:6', '1:7', '1:8'],
      ['2:3', '2:4', '2:5', '3:9'],
    ]);
    // whatever the input order
    expect(
      shape(
        batchContentStudioSourceVersionRetentionCandidates(
          [...list].reverse(),
          4
        )
      )
    ).toEqual(
      shape(batchContentStudioSourceVersionRetentionCandidates(list, 4))
    );
    // by default 100: 101 of one source are 100 and 1, then the next
    const big = [
      ...Array.from({ length: 101 }, (_, i) => candidate(S[0], i + 2)),
      ...[2, 3].map((n) => candidate(S[1], n)),
    ];
    expect(
      batchContentStudioSourceVersionRetentionCandidates(big).map(
        (b) => b.length
      )
    ).toEqual([100, 1, 2]);
    expect(batchContentStudioSourceVersionRetentionCandidates([])).toEqual([]);
    for (const size of [0, -1, 1.5]) {
      expect(() =>
        batchContentStudioSourceVersionRetentionCandidates(list, size)
      ).toThrow(RangeError);
    }
  });

  it('a source never shares a batch once it is split, and no batch is larger than the size', () => {
    for (let seed = 1; seed < 200; seed++) {
      let x = seed;
      const random = () =>
        (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      const list = S.flatMap((sourceId) =>
        Array.from({ length: Math.floor(random() * 12) }, (_, i) =>
          candidate(sourceId, i + 2)
        )
      );
      const size = 1 + Math.floor(random() * 6);
      const batches = batchContentStudioSourceVersionRetentionCandidates(
        list,
        size
      );
      expect(
        batches
          .flat()
          .map((c) => c.id)
          .sort()
      ).toEqual(list.map((c) => c.id).sort());
      for (const batch of batches) {
        expect(batch.length).toBeLessThanOrEqual(size);
        const sources = new Set(batch.map((c) => c.sourceId));
        for (const sourceId of sources) {
          const all = list.filter((c) => c.sourceId === sourceId).length;
          if (all > size) {
            expect([seed, sources.size]).toEqual([seed, 1]);
          } else {
            // a small source is whole in one batch
            expect(batch.filter((c) => c.sourceId === sourceId)).toHaveLength(
              all
            );
          }
        }
      }
    }
  });

  it('ready a minute after the LAST hold', () => {
    expect(CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS).toBe(
      60_000
    );
    const holds = [
      new Date('2026-10-26T12:00:05.000Z'),
      new Date('2026-10-26T12:00:01.000Z'),
      new Date('2026-10-26T12:00:09.500Z'),
    ];
    expect(contentStudioSourceVersionRetentionReadyAt(holds)).toEqual(
      new Date('2026-10-26T12:01:09.500Z')
    );
    expect(() => contentStudioSourceVersionRetentionReadyAt([])).toThrow(
      RangeError
    );
    expect(() =>
      contentStudioSourceVersionRetentionReadyAt([new Date('x')])
    ).toThrow(RangeError);
  });

  it('each source after its candidates are removed: none left, its latest its newest, its change state whole, the runs the recheck kept', () => {
    // A A A A B: v2 and v3 removed
    const p = lettered(SOURCE, 'AAAAB');
    const removed = new Set([p.n(2).id, p.n(3).id]);
    const expected = contentStudioSourceVersionRetainedRuns(
      p.versions,
      removed
    );
    expect(expected).toEqual({
      versionIds: [1, 4, 5].map((k) => p.n(k).id).sort(),
      runs: [
        [p.n(1).id, p.n(4).id],
        [p.n(5).id, p.n(5).id],
      ],
    });
    const check = (
      versions: ContentStudioSourceVersionProtectionVersion[],
      over: Partial<ContentStudioSourceVersionProtectionSource> = {}
    ) =>
      checkContentStudioSourceAfterRetention({
        source: { ...p.source, ...over },
        versions,
        removedIds: removed,
        expected,
        now: NOW,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: 1,
      });
    const after = p.versions.filter((v) => !removed.has(v.id));
    expect(check(after)).toBeNull();
    // a capture since, a repeat of B: allowed
    const repeat = version(SOURCE, 6, IDENTITY.B);
    expect(check([...after, repeat], { latestVersionNumber: 6 })).toBeNull();
    // a candidate still there
    expect(check(p.versions)).toBe('CANDIDATE_LEFT');
    // the latest is not the newest
    expect(check(after, { latestVersionNumber: 4 })).toBe('LATEST_CHANGED');
    // the stored change is not the one the versions show
    expect(
      check(after, {
        lastPageChangeVersionNumber: null,
        lastPageChangeAt: null,
        lastPageChangeKind: null,
        lastPageChangePreviousCaptureAt: null,
      })
    ).toBe('PAGE_CHANGE_STATE_STALE');
    // a version the recheck kept is gone
    expect(check(after.filter((v) => v.versionNumber !== 4))).not.toBeNull();
    expect(
      checkContentStudioSourceAfterRetention({
        source: p.source,
        versions: after,
        removedIds: removed,
        expected: {
          ...expected,
          runs: [[p.n(1).id, p.n(1).id], ...expected.runs.slice(1)],
        },
        now: NOW,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: 1,
      })
    ).toBe('RUNS_CHANGED');
  });
});
