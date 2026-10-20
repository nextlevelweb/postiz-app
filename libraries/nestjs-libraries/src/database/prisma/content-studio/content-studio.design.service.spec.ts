import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';

// No database: both repositories are mocked; the design and Brand Kit
// parsers, canonical JSON and hashing run for real
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});
const uuid = jest.mocked(randomUUID);

const MARKER = 'DESIGN_DOCUMENT_PRIVATE_MARKER_123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const DESIGN = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const REVISION = '66666666-6666-4666-8666-666666666666';
const NEW_ID = '77777777-7777-4777-8777-777777777777';
const KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KIT_REV1 = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KIT_REV2 = '9b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const T0 = new Date('2026-10-15T10:00:00.000Z');

type Obj = Record<string, unknown>;

// --- Brand Kit revisions of ORG ---
const kitContent = (extra: Obj = {}) => ({
  schemaVersion: 1,
  identity: { brandName: 'Northwind', tagline: '', description: '' },
  colors: [
    { id: 'primary', name: 'Blue', value: '#0057ff', role: 'primary' },
    { id: 'extra-1', name: 'Lime', value: '#a3e635', role: 'custom' },
  ],
  typography: [
    {
      id: 'heading',
      name: 'Heading',
      family: 'Inter',
      weight: 700,
      style: 'normal',
      role: 'heading',
    },
    {
      id: 'quote',
      name: 'Quote',
      family: 'Lora',
      weight: 400,
      style: 'italic',
      role: 'custom',
    },
  ],
  visualDirection: { keywords: [], dos: [], donts: [] },
  ...extra,
});
const kitRevision = (
  id: string,
  revisionNumber: number,
  content: Obj = kitContent()
) => ({
  id,
  revisionNumber,
  createdAt: T0,
  ...storedContentStudioBrandKitContent(
    parseContentStudioBrandKitContent(content)
  ),
});
const REV1 = kitRevision(KIT_REV1, 1);
const REV2 = kitRevision(
  KIT_REV2,
  2,
  kitContent({
    colors: [
      { id: 'paper', name: 'Paper', value: '#ffffff', role: 'background' },
    ],
    typography: [],
  })
);
const kitRef = (overrides: Obj = {}) => ({
  brandKitId: KIT,
  revisionId: KIT_REV1,
  revisionNumber: 1,
  contentHash: REV1.contentHash,
  ...overrides,
});

// --- design documents ---
const textLayer = (overrides: Obj = {}) => ({
  id: 'title',
  type: 'text',
  name: '',
  x: 40,
  y: 40,
  width: 1000,
  height: 200,
  rotation: 0,
  opacity: 1,
  visible: true,
  text: `Spring sale ${MARKER}`,
  font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
  fontSize: 64,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: { type: 'literal', value: '#111111' },
  align: 'left',
  verticalAlign: 'top',
  overflow: 'shrink',
  ...overrides,
});
const shapeLayer = (overrides: Obj = {}) => ({
  id: 'panel',
  type: 'shape',
  name: '',
  x: 0,
  y: 0,
  width: 1080,
  height: 300,
  rotation: 0,
  opacity: 0.9,
  visible: true,
  shape: 'rectangle',
  fill: { type: 'literal', value: '#0057ff' },
  cornerRadius: 0,
  ...overrides,
});
const imageLayer = () => ({
  id: 'photo',
  type: 'image',
  name: '',
  x: -40,
  y: 0,
  width: 1200,
  height: 800,
  rotation: 0,
  opacity: 1,
  visible: true,
  imageRef: {
    type: 'media',
    mediaId: 'media-of-another-org',
    sha256: 'e'.repeat(64),
  },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
});
const document = (
  overrides: Obj = {},
  layers: unknown[] = [imageLayer(), shapeLayer(), textLayer()],
  background: Obj = { type: 'literal', value: '#FFFFFF' }
) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: 'cover',
      name: 'Cover',
      width: 1080,
      height: 1350,
      background: { type: 'solid', color: background },
      layers,
    },
  ],
  ...overrides,
});
const branded = (layers?: unknown[], ref: Obj = kitRef()) =>
  document(
    { brandKit: ref },
    layers ?? [
      shapeLayer({ fill: { type: 'brand', tokenId: 'primary' } }),
      textLayer({
        font: { type: 'brand', tokenId: 'heading' },
        color: { type: 'brand', tokenId: 'extra-1' },
      }),
    ]
  );
const normalized = (input: unknown = document()) =>
  parseContentStudioDesignDocument(input);
const storedOf = (input: unknown = document()) =>
  storedContentStudioDesignDocument(normalized(input));

const projectRow = (overrides: Obj = {}) => ({
  id: DESIGN,
  name: 'Spring campaign',
  latestRevisionNumber: 2,
  archivedAt: null as Date | null,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});
const revisionRow = (overrides: Obj = {}) => ({
  id: REVISION,
  revisionNumber: 2,
  createdAt: T0,
  ...storedOf(),
  ...overrides,
});
const summaryOf = (row: Obj) => ({
  id: row.id,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  createdAt: row.createdAt,
});

const setup = (
  project: ReturnType<typeof projectRow> | null = projectRow(),
  kit: { id: string; latestRevisionNumber: number } | null = {
    id: KIT,
    latestRevisionNumber: 2,
  }
) => {
  const designs = {
    listProjectsForOrganization: jest.fn(async () => [projectRow()]),
    countProjectsForOrganization: jest.fn(async () => 41),
    getProjectForOrganization: jest.fn(
      async (organizationId: string, id: string): Promise<unknown> =>
        organizationId === ORG && id === DESIGN ? project : null
    ),
    createProjectWithFirstRevision: jest.fn(
      async (input: {
        designProjectId: string;
        revisionId: string;
        name: string;
      }) => ({
        project: projectRow({
          id: input.designProjectId,
          name: input.name,
          latestRevisionNumber: 1,
        }),
        revision: summaryOf(
          revisionRow({ id: input.revisionId, revisionNumber: 1 })
        ),
      })
    ),
    updateProjectName: jest.fn(async () => ({
      count: project && !project.archivedAt ? 1 : 0,
    })),
    archiveProject: jest.fn(async () => ({ count: 1 })),
    restoreProject: jest.fn(async () => ({ count: 1 })),
    createRevisionWithCompareAndSwap: jest.fn(
      async (input: {
        expectedLatestRevisionNumber: number;
        revisionId: string;
      }): Promise<unknown> => ({
        status: 'created',
        revision: summaryOf(
          revisionRow({
            id: input.revisionId,
            revisionNumber: input.expectedLatestRevisionNumber + 1,
          })
        ),
      })
    ),
    listRevisionsForProject: jest.fn(async () => [summaryOf(revisionRow())]),
    countRevisionsForProject: jest.fn(async () => 2),
    getRevisionForProject: jest.fn(
      async (
        organizationId: string,
        designProjectId: string,
        id: string
      ): Promise<unknown> =>
        organizationId === ORG && designProjectId === DESIGN && id === REVISION
          ? revisionRow()
          : null
    ),
    getRevisionByNumber: jest.fn(async (): Promise<unknown> => revisionRow()),
  };
  const kits = {
    getBrandKitForOrganization: jest.fn(
      async (organizationId: string): Promise<unknown> =>
        organizationId === ORG ? kit : null
    ),
    getRevisionForBrandKit: jest.fn(
      async (
        organizationId: string,
        brandKitId: string,
        id: string
      ): Promise<unknown> =>
        organizationId === ORG && brandKitId === KIT
          ? [REV1, REV2].find((r) => r.id === id) ?? null
          : null
    ),
    getRevisionByNumber: jest.fn(),
  };
  // approval binding (P5-05) is the review service's: a revision without a
  // review unless a test says otherwise
  const reviews = {
    getRevisionApprovalStatuses: jest.fn(
      async (input: { revisionIds: string[] }) =>
        new Map(input.revisionIds.map((id) => [id, NOT_REVIEWED_SUMMARY]))
    ),
    getRevisionApprovalStatus: jest.fn(
      async (input: { targetRevisionId: string }) =>
        notReviewedStatus(input.targetRevisionId)
    ),
  };
  const service = new ContentStudioDesignService(
    designs as unknown as ContentStudioDesignRepository,
    kits as unknown as ContentStudioBrandKitRepository,
    reviews as unknown as ContentStudioReviewService
  );
  return { designs, kits, reviews, service };
};
type Designs = ReturnType<typeof setup>['designs'];
const NOT_REVIEWED_SUMMARY = { approved: false, state: 'NOT_REVIEWED' };
const notReviewedStatus = (id: string) => ({
  targetType: 'DESIGN_REVISION',
  targetRevisionId: id,
  targetRevisionNumber: 1,
  targetContentHash: 'a'.repeat(64),
  approved: false,
  state: 'NOT_REVIEWED',
  reviewId: null,
  approvalVersion: 0,
  currentDecision: null,
});
const writes = (designs: Designs) =>
  [
    designs.createProjectWithFirstRevision,
    designs.createRevisionWithCompareAndSwap,
    designs.updateProjectName,
    designs.archiveProject,
    designs.restoreProject,
  ].flatMap((fn) => (fn as jest.Mock).mock.calls);

const httpError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const text = [
    String(err),
    JSON.stringify((err as HttpException).getResponse()),
    inspect(err, { depth: 6 }),
  ].join('\n');
  expect(text).not.toContain(MARKER);
  expect(text).not.toMatch(
    /[0-9a-f]{64}|zod|Prisma|P200|organizationId|0f8fad5b|33333333|media-of/
  );
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse() as Obj,
  };
};

const NOT_FOUND = { msg: 'Design not found.', code: 'CS_NOT_FOUND' };
const INVALID = {
  msg: 'The design document is invalid.',
  code: 'CS_DESIGN_INVALID',
};
const TOO_LARGE = {
  msg: 'The design document is too large.',
  code: 'CS_DESIGN_TOO_LARGE',
};
const ARCHIVED = {
  msg: 'This design is archived.',
  code: 'CS_DESIGN_ARCHIVED',
};
const INTEGRITY = {
  msg: 'Stored design data could not be read safely.',
  code: 'CS_DESIGN_INTEGRITY_ERROR',
};
const BRAND_NOT_FOUND = {
  msg: 'The selected Brand Kit revision is not available.',
  code: 'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND',
};
const BRAND_INVALID = {
  msg: 'The design contains an invalid Brand Kit reference.',
  code: 'CS_DESIGN_BRAND_REFERENCE_INVALID',
};
const BRAND_INTEGRITY = {
  msg: 'Stored Brand Kit data could not be read safely.',
  code: 'CS_DESIGN_BRAND_REFERENCE_INTEGRITY_ERROR',
};
const conflict = (currentRevisionNumber: number) => ({
  msg: 'The design changed. Reload it and try again.',
  code: 'CS_DESIGN_REVISION_CONFLICT',
  currentRevisionNumber,
});

const create = (service: ContentStudioDesignService, overrides: Obj = {}) =>
  service.createDesign({
    organizationId: ORG,
    userId: USER,
    name: `Spring campaign`,
    content: document(),
    ...overrides,
  });
const save = (service: ContentStudioDesignService, overrides: Obj = {}) =>
  service.createRevision({
    organizationId: ORG,
    designId: DESIGN,
    userId: USER,
    baseRevisionNumber: 2,
    content: document(),
    ...overrides,
  });

beforeEach(() => {
  let next = 0;
  uuid.mockImplementation(
    () => [NEW_ID, REVISION][next++ % 2] as ReturnType<typeof randomUUID>
  );
});

// ============================================================================
describe('ContentStudioDesignService: create', () => {
  it('DPS1/DB1 creates the project with revision 1 for the request organization and user, Brand Kit not needed', async () => {
    const { designs, kits, service } = setup(null);
    const result = await create(service, { name: '  Spring\r\ncampaign  ' });
    expect(designs.createProjectWithFirstRevision).toHaveBeenCalledWith({
      designProjectId: NEW_ID,
      revisionId: REVISION,
      organizationId: ORG,
      name: 'Spring\ncampaign',
      createdById: USER,
      revision: storedOf(),
    });
    expect(kits.getBrandKitForOrganization).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: NEW_ID,
      name: 'Spring\ncampaign',
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
      currentRevision: {
        id: REVISION,
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: storedOf().contentHash,
        createdAt: T0,
        content: normalized(),
      },
    });
    // image references are not looked up in Media
    expect(JSON.stringify(result)).toContain('media-of-another-org');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'n'.repeat(201)],
    ['NUL', `a\u0000${MARKER}`],
    ['lone surrogate', `\ud800${MARKER}`],
    ['not text', 3],
  ])('DPS2 refuses a %s name with a 400 and no write', async (_name, name) => {
    const { designs, service } = setup(null);
    expect(await httpError(create(service, { name }))).toMatchObject({
      status: 400,
      body: { code: 'CS_INVALID_REQUEST' },
    });
    expect(writes(designs)).toEqual([]);
  });

  it('takes a name of 200 characters', async () => {
    const { service } = setup(null);
    expect(
      (await create(service, { name: 'n'.repeat(200) })).name
    ).toHaveLength(200);
  });

  it('DPS3/DPS4/DPS22 refuses invalid and oversized documents without repeating them', async () => {
    const { designs, service } = setup(null);
    expect(
      await httpError(
        create(service, { content: { ...document(), fabric: MARKER } })
      )
    ).toEqual({ status: 400, body: INVALID });
    expect(
      await httpError(
        create(service, {
          content: document({}, [textLayer({ html: MARKER })]),
        })
      )
    ).toEqual({
      status: 400,
      body: INVALID,
    });
    // within every count limit, but more than 1 MiB of UTF-8
    const layers: unknown[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        textLayer({ id: `t${i}`, text: MARKER.padEnd(10000, '€') })
      ),
      ...Array.from({ length: 975 }, (_, i) =>
        shapeLayer({ id: `s${i}`, name: '€'.repeat(100) })
      ),
    ];
    const pages = [];
    for (let i = 0; i < layers.length; i += 200) {
      pages.push({
        ...(document().pages[0] as Obj),
        id: `p${i}`,
        layers: layers.slice(i, i + 200),
      });
    }
    expect(
      await httpError(create(service, { content: document({ pages }) }))
    ).toEqual({ status: 413, body: TOO_LARGE });
    expect(writes(designs)).toEqual([]);
  });

  it('DPS5/61 checks the Brand Kit reference before anything is written', async () => {
    const { designs, kits, service } = setup(null);
    const order: string[] = [];
    kits.getBrandKitForOrganization.mockImplementation(async () => {
      order.push('brand-kit');
      return { id: KIT, latestRevisionNumber: 2 };
    });
    designs.createProjectWithFirstRevision.mockImplementation(async (input) => {
      order.push('create');
      return {
        project: projectRow({
          id: input.designProjectId,
          latestRevisionNumber: 1,
        }),
        revision: summaryOf(
          revisionRow({ id: input.revisionId, revisionNumber: 1 })
        ),
      };
    });
    await create(service, { content: branded() });
    expect(order).toEqual(['brand-kit', 'create']);
    order.length = 0;
    expect(
      await httpError(
        create(service, {
          content: branded(undefined, kitRef({ contentHash: 'd'.repeat(64) })),
        })
      )
    ).toEqual({
      status: 400,
      body: BRAND_INVALID,
    });
    expect(order).toEqual(['brand-kit']);
  });

  it('takes nothing from the caller but the name and the content', async () => {
    const { designs, service } = setup(null);
    await create(service, {
      ...({
        designProjectId: 'theirs',
        createdById: 'someone',
        latestRevisionNumber: 9,
      } as object),
    });
    const [[input]] = designs.createProjectWithFirstRevision.mock
      .calls as unknown as [[Obj]];
    expect(Object.keys(input).sort()).toEqual([
      'createdById',
      'designProjectId',
      'name',
      'organizationId',
      'revision',
      'revisionId',
    ]);
    expect(input).toMatchObject({
      organizationId: ORG,
      createdById: USER,
      designProjectId: NEW_ID,
    });
  });
});

// ============================================================================
describe('ContentStudioDesignService: Brand Kit references', () => {
  const refusal = async (
    content: unknown,
    kit: { id: string; latestRevisionNumber: number } | null = {
      id: KIT,
      latestRevisionNumber: 2,
    }
  ) => {
    const { designs, service } = setup(null, kit);
    const result = await httpError(create(service, { content }));
    expect(writes(designs)).toEqual([]);
    return result;
  };

  it('DB2/DB3/92 refuses a brand color or font token without a Brand Kit reference', async () => {
    expect(
      await refusal(
        document({}, [
          shapeLayer({ fill: { type: 'brand', tokenId: 'primary' } }),
        ])
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
    expect(
      await refusal(document({}, [], { type: 'brand', tokenId: 'primary' }))
    ).toEqual({ status: 400, body: BRAND_INVALID });
    expect(
      await refusal(
        document({}, [
          textLayer({ font: { type: 'brand', tokenId: 'heading' } }),
        ])
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
    expect(
      await refusal(
        document({}, [
          textLayer({ color: { type: 'brand', tokenId: 'primary' } }),
        ])
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
  });

  it('DB4/DB14/DB15 takes an exact revision with existing tokens, custom ones included', async () => {
    const { designs, kits, service } = setup(null);
    const result = await create(service, { content: branded() });
    expect(kits.getBrandKitForOrganization).toHaveBeenCalledWith(ORG);
    expect(kits.getRevisionForBrandKit).toHaveBeenCalledWith(
      ORG,
      KIT,
      KIT_REV1
    );
    expect(designs.createProjectWithFirstRevision).toHaveBeenCalledTimes(1);
    expect(result.currentRevision.content.brandKit).toEqual(kitRef());
    // nothing of the Brand Kit is copied into the document
    expect(JSON.stringify(result.currentRevision.content)).not.toMatch(
      /Northwind|#a3e635|Inter"/
    );
    await create(service, {
      content: branded([
        textLayer({
          font: { type: 'brand', tokenId: 'quote' },
          color: { type: 'brand', tokenId: 'extra-1' },
        }),
      ]),
    });
  });

  it('DB5 the organization has no Brand Kit', async () => {
    expect(await refusal(branded(), null)).toEqual({
      status: 400,
      body: BRAND_NOT_FOUND,
    });
  });

  it('DB6/DB7 another Brand Kit id (another organization, or not this one) is not found', async () => {
    expect(
      await refusal(
        branded(
          undefined,
          kitRef({ brandKitId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })
        )
      )
    ).toEqual({
      status: 400,
      body: BRAND_NOT_FOUND,
    });
    const { kits, service } = setup(null);
    expect(
      await httpError(
        service.createDesign({
          organizationId: OTHER_ORG,
          userId: USER,
          name: 'x',
          content: branded(),
        })
      )
    ).toEqual({
      status: 400,
      body: BRAND_NOT_FOUND,
    });
    expect(kits.getBrandKitForOrganization).toHaveBeenCalledWith(OTHER_ORG);
    expect(kits.getRevisionForBrandKit).not.toHaveBeenCalled();
  });

  it('DB8 a revision that is not one of this kit is not found', async () => {
    expect(
      await refusal(
        branded(
          undefined,
          kitRef({ revisionId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })
        )
      )
    ).toEqual({
      status: 400,
      body: BRAND_NOT_FOUND,
    });
  });

  it('DB9 a stored Brand Kit revision that fails its check is an integrity error', async () => {
    const { designs, kits, service } = setup(null);
    kits.getRevisionForBrandKit.mockResolvedValueOnce({
      ...REV1,
      content: `{"identity":"${MARKER}"}`,
    });
    expect(await httpError(create(service, { content: branded() }))).toEqual({
      status: 500,
      body: BRAND_INTEGRITY,
    });
    expect(writes(designs)).toEqual([]);
  });

  it('DB10/DB11/46 a wrong revision number or hash is refused, never repaired', async () => {
    expect(
      await refusal(branded(undefined, kitRef({ revisionNumber: 2 })))
    ).toEqual({ status: 400, body: BRAND_INVALID });
    expect(
      await refusal(
        branded(undefined, kitRef({ contentHash: REV2.contentHash }))
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
  });

  it('DB12/DB13 a token missing from that revision is refused', async () => {
    expect(
      await refusal(
        branded([shapeLayer({ fill: { type: 'brand', tokenId: 'paper' } })])
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
    expect(
      await refusal(
        branded([textLayer({ font: { type: 'brand', tokenId: 'body' } })])
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
    // a color id is not a type style id
    expect(
      await refusal(
        branded([textLayer({ font: { type: 'brand', tokenId: 'primary' } })])
      )
    ).toEqual({ status: 400, body: BRAND_INVALID });
    expect(
      await refusal(
        document({ brandKit: kitRef() }, [], {
          type: 'brand',
          tokenId: 'missing',
        })
      )
    ).toEqual({
      status: 400,
      body: BRAND_INVALID,
    });
  });

  it('DB16/49 a later current revision changes nothing: the exact older one is used, and the newer one must be named to be used', async () => {
    const { designs, kits, service } = setup(null, {
      id: KIT,
      latestRevisionNumber: 2,
    });
    await create(service, { content: branded() });
    expect(kits.getRevisionForBrandKit).toHaveBeenCalledWith(
      ORG,
      KIT,
      KIT_REV1
    );
    expect(kits.getRevisionByNumber).not.toHaveBeenCalled();
    const [[input]] = designs.createProjectWithFirstRevision.mock
      .calls as unknown as [[{ revision: { content: string } }]];
    expect(JSON.parse(input.revision.content).brandKit).toEqual(kitRef());
    // 'paper' exists only in revision 2: usable when revision 2 is named
    const paper = [shapeLayer({ fill: { type: 'brand', tokenId: 'paper' } })];
    await create(service, {
      content: branded(
        paper,
        kitRef({
          revisionId: KIT_REV2,
          revisionNumber: 2,
          contentHash: REV2.contentHash,
        })
      ),
    });
    expect(
      await httpError(create(service, { content: branded(paper) }))
    ).toEqual({ status: 400, body: BRAND_INVALID });
  });

  it('DB17/91 an unused reference is accepted and kept', async () => {
    const { service } = setup(null);
    const result = await create(service, {
      content: document({ brandKit: kitRef() }),
    });
    expect(result.currentRevision.content.brandKit).toEqual(kitRef());
  });

  it('94 image references need no Brand Kit and are not checked', async () => {
    const { kits, service } = setup(null);
    await create(service, { content: document({}, [imageLayer()]) });
    expect(kits.getBrandKitForOrganization).not.toHaveBeenCalled();
  });
});

// ============================================================================
describe('ContentStudioDesignService: projects', () => {
  it('DPS6 lists summaries of the organization by page', async () => {
    const { designs, service } = setup();
    const list = await service.listDesigns({
      organizationId: ORG,
      archived: true,
      page: 2,
    });
    expect(list).toEqual({ pages: 3, results: [projectRow()] });
    expect(designs.listProjectsForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      archived: true,
      skip: 20,
      take: 20,
    });
    expect(designs.countProjectsForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      archived: true,
    });
    expect(Object.keys(list.results[0]).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'id',
      'latestRevisionNumber',
      'name',
      'updatedAt',
    ]);
  });

  it('DPS7 reads the design with its verified current revision', async () => {
    const { designs, service } = setup();
    const design = await service.getDesign(ORG, DESIGN);
    expect(designs.getRevisionByNumber).toHaveBeenCalledWith(ORG, DESIGN, 2);
    expect(design).toEqual({
      ...projectRow(),
      currentRevision: { ...summaryOf(revisionRow()), content: normalized() },
    });
    expect(JSON.stringify(design)).not.toMatch(/11111111|55555555/);
  });

  it('DPS8 an archived design stays readable', async () => {
    const { service } = setup(projectRow({ archivedAt: T0 }));
    expect((await service.getDesign(ORG, DESIGN)).archivedAt).toEqual(T0);
  });

  it('DPS9/DPS10 a missing or corrupted current revision is an integrity error', async () => {
    const { designs, service } = setup();
    designs.getRevisionByNumber.mockResolvedValueOnce(null);
    expect(await httpError(service.getDesign(ORG, DESIGN))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
    for (const change of [
      { contentHash: 'f'.repeat(64) },
      { content: `{"pages":"${MARKER}"}` },
      { schemaVersion: 2 },
    ]) {
      designs.getRevisionByNumber.mockResolvedValueOnce(revisionRow(change));
      expect(await httpError(service.getDesign(ORG, DESIGN))).toEqual({
        status: 500,
        body: INTEGRITY,
      });
    }
  });

  it('58 a stored revision naming a Brand Kit is read without the Brand Kit', async () => {
    const { designs, kits, service } = setup();
    const stored = storedOf(branded());
    designs.getRevisionByNumber.mockResolvedValueOnce(revisionRow(stored));
    // even when the kit is gone
    kits.getBrandKitForOrganization.mockResolvedValue(null);
    expect(
      (await service.getDesign(ORG, DESIGN)).currentRevision.content.brandKit
    ).toEqual(kitRef());
    expect(kits.getBrandKitForOrganization).not.toHaveBeenCalled();
  });

  it('DPS11 renames an active design, without a revision', async () => {
    const { designs, service } = setup();
    expect(await service.renameDesign(ORG, DESIGN, '  New name ')).toEqual(
      projectRow()
    );
    expect(designs.updateProjectName).toHaveBeenCalledWith(
      ORG,
      DESIGN,
      'New name'
    );
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('DPS12 an archived design cannot be renamed', async () => {
    const { service } = setup(projectRow({ archivedAt: T0 }));
    expect(await httpError(service.renameDesign(ORG, DESIGN, 'New'))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
  });

  it('DPS17/72 archives and restores without touching revisions', async () => {
    const { designs, service } = setup();
    expect(await service.archiveDesign(ORG, DESIGN)).toEqual(projectRow());
    expect(designs.archiveProject).toHaveBeenCalledWith(
      ORG,
      DESIGN,
      expect.any(Date)
    );
    expect(await service.restoreDesign(ORG, DESIGN)).toEqual(projectRow());
    expect(designs.restoreProject).toHaveBeenCalledWith(ORG, DESIGN);
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('DPS20 another organization gets 404 everywhere and nothing changes', async () => {
    const { designs, service } = setup();
    for (const call of [
      () => service.getDesign(OTHER_ORG, DESIGN),
      () => service.renameDesign(OTHER_ORG, DESIGN, 'Taken'),
      () => service.archiveDesign(OTHER_ORG, DESIGN),
      () => service.restoreDesign(OTHER_ORG, DESIGN),
      () =>
        service.listRevisions({
          organizationId: OTHER_ORG,
          designId: DESIGN,
          page: 1,
        }),
      () =>
        service.getRevision({
          organizationId: OTHER_ORG,
          designId: DESIGN,
          revisionId: REVISION,
        }),
      () => save(service, { organizationId: OTHER_ORG }),
    ]) {
      expect(await httpError(call())).toEqual({ status: 404, body: NOT_FOUND });
    }
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('DPS21 a malformed id is a 404 without a query', async () => {
    const { designs, service } = setup();
    for (const id of [
      'not-a-uuid',
      DESIGN.toUpperCase().replace(/3/g, 'A'),
      `${DESIGN} `,
      '',
    ]) {
      expect(await httpError(service.getDesign(ORG, id))).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
      expect(
        await httpError(
          service.getRevision({
            organizationId: ORG,
            designId: DESIGN,
            revisionId: id,
          })
        )
      ).toEqual({
        status: 404,
        body: NOT_FOUND,
      });
    }
    expect(designs.getProjectForOrganization).not.toHaveBeenCalled();
    expect(designs.getRevisionForProject).not.toHaveBeenCalled();
  });
});

// ============================================================================
describe('ContentStudioDesignService: revisions', () => {
  it('DPS13 saves changed content as the next revision, by the request user', async () => {
    const { designs, service } = setup();
    const changed = document({}, [shapeLayer({ x: 10.5 })]);
    const result = await save(service, { content: changed });
    expect(designs.createRevisionWithCompareAndSwap).toHaveBeenCalledWith({
      organizationId: ORG,
      designProjectId: DESIGN,
      expectedLatestRevisionNumber: 2,
      revisionId: NEW_ID,
      revision: storedOf(changed),
      createdById: USER,
    });
    expect(result).toEqual({
      created: true,
      revision: {
        id: NEW_ID,
        revisionNumber: 3,
        schemaVersion: 1,
        contentHash: storedOf().contentHash,
        createdAt: T0,
        content: normalized(changed),
      },
    });
  });

  it('DPS14 a stale base is a conflict before the Brand Kit is read', async () => {
    const { designs, kits, service } = setup(
      projectRow({ latestRevisionNumber: 5 })
    );
    expect(
      await httpError(
        save(service, { baseRevisionNumber: 4, content: branded() })
      )
    ).toEqual({ status: 409, body: conflict(5) });
    expect(kits.getBrandKitForOrganization).not.toHaveBeenCalled();
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('DPS14 a conflict found by the compare-and-swap reports the current number', async () => {
    const { designs, service } = setup();
    designs.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'conflict',
      currentRevisionNumber: 3,
    });
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: conflict(3),
    });
    designs.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'changed',
    });
    designs.getProjectForOrganization
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce(projectRow({ latestRevisionNumber: 4 }));
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: conflict(4),
    });
    designs.createRevisionWithCompareAndSwap.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(`Unique ${MARKER}`, {
        code: 'P2002',
        clientVersion: '6.5.0',
      })
    );
    expect((await httpError(save(service))).status).toBe(409);
  });

  it('DPS15 the same content at the current base answers the verified current revision', async () => {
    const { designs, service } = setup();
    designs.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'unchanged',
      revision: revisionRow(),
    });
    expect(await save(service)).toEqual({
      created: false,
      revision: { ...summaryOf(revisionRow()), content: normalized() },
    });
    designs.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'unchanged',
      revision: revisionRow({ content: `{"x":"${MARKER}"}` }),
    });
    expect(await httpError(save(service))).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });

  it('DPS16 the same content at a stale base is still a conflict', async () => {
    const { designs, service } = setup(projectRow({ latestRevisionNumber: 3 }));
    expect(await httpError(save(service, { baseRevisionNumber: 2 }))).toEqual({
      status: 409,
      body: conflict(3),
    });
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('an archived design takes no revision', async () => {
    const { designs, service } = setup(projectRow({ archivedAt: T0 }));
    expect(await httpError(save(service))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
    const live = setup();
    live.designs.createRevisionWithCompareAndSwap.mockResolvedValueOnce({
      status: 'archived',
    });
    expect(await httpError(save(live.service))).toEqual({
      status: 409,
      body: ARCHIVED,
    });
  });

  it('checks the Brand Kit reference of a new revision too', async () => {
    const { designs, service } = setup();
    expect(
      await httpError(
        save(service, {
          content: document({}, [
            shapeLayer({ fill: { type: 'brand', tokenId: 'primary' } }),
          ]),
        })
      )
    ).toEqual({
      status: 400,
      body: BRAND_INVALID,
    });
    expect(designs.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
    await save(service, { content: branded() });
    expect(designs.createRevisionWithCompareAndSwap).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['0', 0],
    ['a negative base', -1],
    ['a fraction', 1.5],
    ['a base past int4', 2 ** 31],
    ['text', '2'],
  ])(
    'refuses %s as base with a 400 and no write',
    async (_name, baseRevisionNumber) => {
      const { designs, service } = setup();
      expect(
        await httpError(save(service, { baseRevisionNumber }))
      ).toMatchObject({ status: 400, body: { code: 'CS_INVALID_REQUEST' } });
      expect(writes(designs)).toEqual([]);
    }
  );

  it('DPS18 lists the history, archived included, metadata only', async () => {
    const { designs, service } = setup(projectRow({ archivedAt: T0 }));
    const list = await service.listRevisions({
      organizationId: ORG,
      designId: DESIGN,
      page: 1,
    });
    expect(list).toEqual({
      pages: 1,
      results: [
        { ...summaryOf(revisionRow()), approval: NOT_REVIEWED_SUMMARY },
      ],
    });
    expect(designs.listRevisionsForProject).toHaveBeenCalledWith({
      organizationId: ORG,
      designProjectId: DESIGN,
      skip: 0,
      take: 20,
    });
    expect(Object.keys(list.results[0])).not.toContain('content');
  });

  it('DPS19 reads one verified revision of the design', async () => {
    const { designs, service } = setup();
    expect(
      await service.getRevision({
        organizationId: ORG,
        designId: DESIGN,
        revisionId: REVISION,
      })
    ).toEqual({
      ...summaryOf(revisionRow()),
      content: normalized(),
      approval: notReviewedStatus(REVISION),
    });
    expect(designs.getRevisionForProject).toHaveBeenCalledWith(
      ORG,
      DESIGN,
      REVISION
    );
    expect(
      await httpError(
        service.getRevision({
          organizationId: ORG,
          designId: DESIGN,
          revisionId: NEW_ID,
        })
      )
    ).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    designs.getRevisionForProject.mockResolvedValueOnce(
      revisionRow({ content: `{"pages":"${MARKER}"}` })
    );
    expect(
      await httpError(
        service.getRevision({
          organizationId: ORG,
          designId: DESIGN,
          revisionId: REVISION,
        })
      )
    ).toEqual({
      status: 500,
      body: INTEGRITY,
    });
  });
});

// ============================================================================
describe('ContentStudioDesignService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.design.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('DPS23/42/47/87 has no role, billing, AI, renderer, Media or Brand Kit service dependency', () => {
    expect(text).not.toMatch(
      /Role\.|assertManager|CheckPolicies|Sections\.|subscription|stripe|credit|billing|AIExecution|ai\.execution|ai\.provider|AIConnection|AIWriting|generateText|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|Media|sharp|fontkit|fabric|canvas|ContentStudioBrandKitService/i
    );
    const constructor = text.slice(
      text.indexOf('constructor('),
      text.indexOf(') {}')
    );
    // P5-05: the review service, for whether a revision is approved
    expect(constructor.match(/private _\w+: \w+/g)).toEqual([
      'private _contentStudioDesignRepository: ContentStudioDesignRepository',
      'private _contentStudioBrandKitRepository: ContentStudioBrandKitRepository',
      'private _contentStudioReviewService: ContentStudioReviewService',
    ]);
  });

  it('logs nothing and never serializes a design for a message', () => {
    expect(text).not.toMatch(/console\.|Logger|JSON\.stringify|\.message\b/);
  });

  it('never writes a revision or a Brand Kit itself', () => {
    expect(text).not.toMatch(
      /contentStudioDesignRevision|\.update\(|\.delete\(|\.upsert\(|createBrandKit|createRevisionWithCompareAndSwap\(\{\s*organizationId[^}]*brandKit/
    );
    expect(text).not.toMatch(
      /_contentStudioBrandKitRepository\.(create|update|archive|restore)/
    );
  });
});

describe('ContentStudioDesignService revision approval binding (P5-05)', () => {
  it('AS2 the revision view carries the full binding of exactly that revision', async () => {
    const { reviews, service } = setup();
    const status = {
      ...notReviewedStatus(REVISION),
      approved: true,
      state: 'APPROVED',
    };
    reviews.getRevisionApprovalStatus.mockResolvedValue(status);
    const revision = await service.getRevision({
      organizationId: ORG,
      designId: DESIGN,
      revisionId: REVISION,
    });
    expect(revision.approval).toEqual(status);
    expect(reviews.getRevisionApprovalStatus.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          targetType: 'DESIGN_REVISION',
          targetRevisionId: REVISION,
        },
      ],
    ]);
  });

  it('AS4/BQ1 a page of history asks for the binding of all its revisions once, each row its own', async () => {
    const { designs, reviews, service } = setup();
    const second = '77777777-7777-4777-8777-777777777777';
    designs.listRevisionsForProject.mockResolvedValueOnce([
      summaryOf(revisionRow({ id: second, revisionNumber: 2 })),
      summaryOf(revisionRow()),
    ]);
    reviews.getRevisionApprovalStatuses.mockResolvedValueOnce(
      new Map([
        [REVISION, { approved: true, state: 'APPROVED' }],
        [second, { approved: false, state: 'REFUSED' }],
      ])
    );
    const list = await service.listRevisions({
      organizationId: ORG,
      designId: DESIGN,
      page: 1,
    });
    expect(list.results.map((row) => [row.id, row.approval])).toEqual([
      [second, { approved: false, state: 'REFUSED' }],
      [REVISION, { approved: true, state: 'APPROVED' }],
    ]);
    expect(reviews.getRevisionApprovalStatuses.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          targetType: 'DESIGN_REVISION',
          revisionIds: [second, REVISION],
        },
      ],
    ]);
    expect(reviews.getRevisionApprovalStatus).not.toHaveBeenCalled();
  });

  it('AS5 a row keeps every existing field', async () => {
    const { service } = setup();
    const list = await service.listRevisions({
      organizationId: ORG,
      designId: DESIGN,
      page: 1,
    });
    expect(Object.keys(list.results[0]).sort()).toEqual([
      'approval',
      'contentHash',
      'createdAt',
      'id',
      'revisionNumber',
      'schemaVersion',
    ]);
  });

  it('a foreign or corrupt revision is answered before any binding is read', async () => {
    const { designs, reviews, service } = setup();
    await httpError(
      service.getRevision({
        organizationId: OTHER_ORG,
        designId: DESIGN,
        revisionId: REVISION,
      })
    );
    designs.getRevisionForProject.mockResolvedValueOnce(
      revisionRow({ content: '{"pages":[]}' })
    );
    expect(
      (
        await httpError(
          service.getRevision({
            organizationId: ORG,
            designId: DESIGN,
            revisionId: REVISION,
          })
        )
      ).status
    ).toBe(500);
    expect(reviews.getRevisionApprovalStatus).not.toHaveBeenCalled();
  });

  it('a stored revision read for a template carries no binding and reads none', async () => {
    const { reviews, service } = setup();
    const revision = await service.getStoredRevision({
      organizationId: ORG,
      designId: DESIGN,
      revisionId: REVISION,
    });
    expect(revision).not.toHaveProperty('approval');
    expect(reviews.getRevisionApprovalStatus).not.toHaveBeenCalled();
  });
});
