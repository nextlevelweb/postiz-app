import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { HttpException } from '@nestjs/common';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import * as rendererModule from '@gitroom/nestjs-libraries/content-studio/design/render/design.renderer';
import {
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderErrorCode,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';
import { parseVerifiedContentStudioRenderAssetSnapshot } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.snapshot';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioRenderFontRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.repository';
import { ContentStudioDesignRenderRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.repository';
import { ContentStudioRenderMediaBridge } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-media.bridge';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import {
  ContentStudioRenderFontActor,
  ContentStudioRenderFontService,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import {
  checkContentStudioPrivateFontStorageKey,
  ContentStudioPrivateFontStorage,
  ContentStudioPrivateFontStorageError,
} from '@gitroom/nestjs-libraries/upload/content-studio.private-font.storage';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';
import { IStoredMediaReader } from '@gitroom/nestjs-libraries/upload/stored.media.reader';

// The render service against the real layout engine and renderer (Geist
// from next, images made by Sharp), with every repository, the private font
// storage and the Media storage in memory. The real Media bridge runs over a
// fake Media service (the real one pulls in uploads, Redis and Temporal)
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

const GEIST = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('next/package.json')),
    'dist/compiled/@vercel/og/Geist-Regular.ttf'
  )
);
// the same outlines under another valid sfnt tag: another file, another hash
const GEIST_B = Buffer.from(GEIST);
GEIST_B.write('true', 0, 'latin1');

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const REV_1 = 'a1111111-1111-4111-8111-111111111111';
const REV_2 = 'a2222222-2222-4222-8222-222222222222';
const FOREIGN_REV = 'a3333333-3333-4333-8333-333333333333';
const KIT = 'b1111111-1111-4111-8111-111111111111';
const KIT_REV_3 = 'b3333333-3333-4333-8333-333333333333';
const KIT_REV_7 = 'b7777777-7777-4777-8777-777777777777';
const MARKER = 'DESIGN_RENDER_PRIVATE_MARKER_654';
const MEMBER = (role: string) =>
  ({
    organization: { id: ORG, users: [{ role, userId: USER }] },
    user: { id: USER },
  } as ContentStudioRenderFontActor);

type Row = Record<string, unknown>;

const literal = (value: string) => ({ type: 'literal', value });
const GEIST_FONT = {
  type: 'family',
  family: 'Geist',
  weight: 400,
  style: 'normal',
};
const base = (id: string, extra: Row = {}) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 60,
  height: 40,
  rotation: 0,
  opacity: 1,
  visible: true,
  ...extra,
});
const text = (id: string, value: string, extra: Row = {}) =>
  base(id, {
    type: 'text',
    text: value,
    font: GEIST_FONT,
    fontSize: 20,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: literal('#111111'),
    align: 'left',
    verticalAlign: 'top',
    overflow: 'clip',
    ...extra,
  });
const image = (id: string, mediaId: string, sha256: string, extra: Row = {}) =>
  base(id, {
    type: 'image',
    imageRef: { type: 'media', mediaId, sha256 },
    fit: 'cover',
    focalPoint: { x: 0.5, y: 0.5 },
    ...extra,
  });
const shape = (id: string) =>
  base(id, {
    type: 'shape',
    shape: 'rectangle',
    fill: literal('#ff0000'),
    cornerRadius: 0,
  });
const page = (id: string, layers: unknown[], extra: Row = {}) => ({
  id,
  name: '',
  width: 120,
  height: 80,
  background: { type: 'solid', color: literal('#ffffff') },
  layers,
  ...extra,
});
const document = (pages: unknown[], brandKit: unknown = null) =>
  parseContentStudioDesignDocument({ schemaVersion: 1, brandKit, pages });

const brandContent = (family: string) =>
  parseContentStudioBrandKitContent({
    schemaVersion: 1,
    identity: { brandName: 'Acme', tagline: '', description: '' },
    colors: [{ id: 'ink', name: 'Ink', value: '#1A1A1A', role: 'text' }],
    typography: [
      {
        id: 'heading',
        name: 'Heading',
        family,
        weight: 400,
        style: 'normal',
        role: 'heading',
      },
    ],
    visualDirection: { keywords: [], dos: [], donts: [] },
  });
const KIT_V3 = brandContent('Geist');
const KIT_V7 = brandContent('Later Family');
const KIT_REF = {
  brandKitId: KIT,
  revisionId: KIT_REV_3,
  revisionNumber: 3,
  contentHash: storedContentStudioBrandKitContent(KIT_V3).contentHash,
};

let RED: Buffer;
let BLUE: Buffer;
beforeAll(async () => {
  const solid = (r: number, g: number, b: number) =>
    sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r, g, b, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  RED = await solid(255, 0, 0);
  BLUE = await solid(0, 0, 255);
});

const sha = (bytes: Buffer) => designRenderSha256(bytes);

interface World {
  projects: Row[];
  revisions: Row[];
  kits: Row[];
  kitRevisions: Row[];
  assets: Row[];
  mappings: Row[];
  objects: Map<string, Buffer>;
  media: Row[];
  stored: Map<string, Buffer>;
  renders: Row[];
  savedMedia: Row[];
}

const setup = (options: { fontStorage?: 'ok' | 'unavailable' } = {}) => {
  const world: World = {
    projects: [],
    revisions: [],
    kits: [],
    kitRevisions: [],
    assets: [],
    mappings: [],
    objects: new Map(),
    media: [],
    stored: new Map(),
    renders: [],
    savedMedia: [],
  };
  const calls: string[] = [];
  const pick = (row: Row | undefined, keys: string[]) =>
    row ? Object.fromEntries(keys.map((key) => [key, row[key]])) : null;

  const designs = {
    getProjectForOrganization: jest.fn(async (org: string, id: string) =>
      pick(
        world.projects.find((p) => p.id === id && p.organizationId === org),
        [
          'id',
          'name',
          'latestRevisionNumber',
          'archivedAt',
          'createdAt',
          'updatedAt',
        ]
      )
    ),
    getRevisionForProject: jest.fn(
      async (org: string, projectId: string, revisionId: string) =>
        pick(
          world.revisions.find(
            (r) =>
              r.id === revisionId &&
              r.designProjectId === projectId &&
              r.organizationId === org
          ),
          [
            'id',
            'revisionNumber',
            'schemaVersion',
            'contentHash',
            'createdAt',
            'content',
          ]
        )
    ),
    getRevisionByNumber: jest.fn(
      async (org: string, projectId: string, revisionNumber: number) =>
        pick(
          world.revisions.find(
            (r) =>
              r.revisionNumber === revisionNumber &&
              r.designProjectId === projectId &&
              r.organizationId === org
          ),
          [
            'id',
            'revisionNumber',
            'schemaVersion',
            'contentHash',
            'createdAt',
            'content',
          ]
        )
    ),
  };
  const brands = {
    getBrandKitForOrganization: jest.fn(async (org: string) =>
      pick(
        world.kits.find((k) => k.organizationId === org),
        ['id', 'latestRevisionNumber']
      )
    ),
    getRevisionForBrandKit: jest.fn(
      async (org: string, kitId: string, revisionId: string) =>
        pick(
          world.kitRevisions.find(
            (r) =>
              r.id === revisionId &&
              r.brandKitId === kitId &&
              r.organizationId === org
          ),
          [
            'id',
            'revisionNumber',
            'schemaVersion',
            'contentHash',
            'createdAt',
            'content',
          ]
        )
    ),
    getRevisionByNumber: jest.fn(
      async (org: string, kitId: string, revisionNumber: number) =>
        pick(
          world.kitRevisions.find(
            (r) =>
              r.revisionNumber === revisionNumber &&
              r.brandKitId === kitId &&
              r.organizationId === org
          ),
          [
            'id',
            'revisionNumber',
            'schemaVersion',
            'contentHash',
            'createdAt',
            'content',
          ]
        )
    ),
  };
  const summary = (row: Row) =>
    pick(row, [
      'id',
      'family',
      'weight',
      'style',
      'disabledAt',
      'createdAt',
      'updatedAt',
    ]);
  const tuple = (font: Row) => (row: Row) =>
    row.family === font.family &&
    row.weight === font.weight &&
    row.style === font.style;
  const fonts = {
    getActiveMappingBySpec: jest.fn(async (org: string, font: Row) => {
      calls.push(`mapping ${font.family}`);
      const row = world.mappings.find(
        (m) => m.organizationId === org && !m.disabledAt && tuple(font)(m)
      );
      if (!row) {
        return null;
      }
      const asset = world.assets.find(
        (a) => a.id === row.fontAssetId && a.organizationId === org
      ) as Row;
      return {
        id: row.id,
        family: row.family,
        weight: row.weight,
        style: row.style,
        fontAsset: pick(asset, [
          'id',
          'storageKey',
          'sha256',
          'byteSize',
          'format',
        ]),
      };
    }),
    listMappingsForOrganization: jest.fn(async (org: string) =>
      world.mappings.filter((m) => m.organizationId === org).map(summary)
    ),
    getMappingBySpec: jest.fn(async (org: string, font: Row) => {
      const row = world.mappings.find(
        (m) => m.organizationId === org && tuple(font)(m)
      );
      return row ? summary(row) : null;
    }),
    countActiveMappings: jest.fn(
      async (org: string) =>
        world.mappings.filter((m) => m.organizationId === org && !m.disabledAt)
          .length
    ),
    createAssetAndSetMapping: jest.fn(async (input: Row) => {
      world.assets.push({
        ...(input.asset as Row),
        organizationId: input.organizationId,
      });
      const font = input.font as Row;
      const current = world.mappings.find(
        (m) => m.organizationId === input.organizationId && tuple(font)(m)
      );
      if (current) {
        current.fontAssetId = (input.asset as Row).id;
        current.disabledAt = null;
        return { status: 'set', mapping: summary(current) };
      }
      const row = {
        id: input.mappingId,
        organizationId: input.organizationId,
        ...font,
        fontAssetId: (input.asset as Row).id,
        disabledAt: null,
      };
      world.mappings.push(row);
      return { status: 'set', mapping: summary(row) };
    }),
  };
  const renders = {
    createRunningRender: jest.fn(async (input: Row) => {
      const row = { ...input, status: 'running', createdAt: new Date() };
      world.renders.push(row);
      return { id: input.id, createdAt: row.createdAt };
    }),
    completeRender: jest.fn(async (input: Row) => {
      const row = world.renders.find(
        (r) =>
          r.id === input.id &&
          r.organizationId === input.organizationId &&
          r.status === 'running'
      );
      if (!row) {
        return { count: 0 };
      }
      Object.assign(row, input, { status: 'completed' });
      return { count: 1 };
    }),
    failRender: jest.fn(async (input: Row) => {
      const row = world.renders.find(
        (r) =>
          r.id === input.id &&
          r.organizationId === input.organizationId &&
          r.status === 'running'
      );
      if (!row) {
        return { count: 0 };
      }
      Object.assign(row, input, { status: 'failed' });
      return { count: 1 };
    }),
  };
  const fontStorage = {
    writeFontAsset: jest.fn(
      async (input: {
        organizationId: string;
        assetId: string;
        bytes: Uint8Array;
        extension: string;
      }) => {
        if (options.fontStorage === 'unavailable') {
          throw new ContentStudioPrivateFontStorageError('UNAVAILABLE');
        }
        const storageKey = `fonts/${input.organizationId}/${input.assetId}.${input.extension}`;
        world.objects.set(storageKey, Buffer.from(input.bytes));
        return { storageKey };
      }
    ),
    readFontAsset: jest.fn(
      async (input: { organizationId: string; storageKey: string }) => {
        calls.push(`font ${input.storageKey}`);
        if (options.fontStorage === 'unavailable') {
          throw new ContentStudioPrivateFontStorageError('UNAVAILABLE');
        }
        const key = checkContentStudioPrivateFontStorageKey(
          input.organizationId,
          input.storageKey
        );
        const bytes = world.objects.get(key);
        if (!bytes) {
          throw new ContentStudioPrivateFontStorageError('NOT_FOUND');
        }
        return Buffer.from(bytes);
      }
    ),
  };
  const reader: IStoredMediaReader = {
    readStoredMediaBytes: jest.fn(async (location: string) => {
      calls.push(`media ${location}`);
      const bytes = world.stored.get(location);
      if (!bytes) {
        throw new Error(MARKER);
      }
      return Buffer.from(bytes);
    }),
  };
  const mediaService = {
    getMediaByIdForOrganization: jest.fn(async (org: string, id: string) =>
      pick(
        world.media.find((m) => m.id === id && m.organizationId === org),
        ['id', 'name', 'path', 'thumbnail', 'alt', 'status']
      )
    ),
    // the unscoped lookup the real service also has; never to be used here
    getMediaById: jest.fn(async (id: string) =>
      pick(
        world.media.find((m) => m.id === id),
        ['id', 'name', 'path', 'thumbnail', 'alt', 'status', 'organizationId']
      )
    ),
    saveGeneratedFile: jest.fn(
      async (
        org: string,
        body: Buffer,
        mimetype: string,
        ext: string,
        originalName: string
      ) => {
        const row = {
          id: `out-${world.savedMedia.length + 1}`,
          org,
          body: Buffer.from(body),
          mimetype,
          ext,
          originalName,
        };
        world.savedMedia.push(row);
        return { id: row.id };
      }
    ),
  };
  jest
    .spyOn(StoredAssetFactory, 'createContentStudioPrivateFontStorage')
    .mockReturnValue(fontStorage as unknown as ContentStudioPrivateFontStorage);
  jest
    .spyOn(StoredAssetFactory, 'createStoredMediaReader')
    .mockReturnValue(reader);
  // one spy per test: a second setup in the same test starts counting again
  const render = jest.spyOn(rendererModule, 'renderContentStudioDesignPage');
  render.mockClear();
  const bridge = new ContentStudioRenderMediaBridge(
    mediaService as unknown as MediaService
  );
  const service = new ContentStudioDesignRenderService(
    designs as unknown as ContentStudioDesignRepository,
    brands as unknown as ContentStudioBrandKitRepository,
    fonts as unknown as ContentStudioRenderFontRepository,
    renders as unknown as ContentStudioDesignRenderRepository,
    bridge
  );
  const fontService = new ContentStudioRenderFontService(
    fonts as unknown as ContentStudioRenderFontRepository
  );

  // stored data
  const addDesign = (
    content: ReturnType<typeof document>,
    extra: {
      id?: string;
      organizationId?: string;
      revisionId?: string;
      revisionNumber?: number;
      projectId?: string;
      archivedAt?: Date | null;
      latest?: number;
    } = {}
  ) => {
    const projectId = extra.projectId ?? PROJECT;
    const organizationId = extra.organizationId ?? ORG;
    if (!world.projects.some((p) => p.id === projectId)) {
      world.projects.push({
        id: projectId,
        organizationId,
        name: MARKER,
        latestRevisionNumber: extra.latest ?? extra.revisionNumber ?? 1,
        archivedAt: extra.archivedAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const stored = storedContentStudioDesignDocument(content);
    world.revisions.push({
      id: extra.revisionId ?? REV_1,
      organizationId,
      designProjectId: projectId,
      revisionNumber: extra.revisionNumber ?? 1,
      ...stored,
      createdAt: new Date(),
    });
    return stored;
  };
  const addKit = () => {
    world.kits.push({ id: KIT, organizationId: ORG, latestRevisionNumber: 7 });
    for (const [id, number, content] of [
      [KIT_REV_3, 3, KIT_V3],
      [KIT_REV_7, 7, KIT_V7],
    ] as const) {
      world.kitRevisions.push({
        id,
        organizationId: ORG,
        brandKitId: KIT,
        revisionNumber: number,
        ...storedContentStudioBrandKitContent(content),
        createdAt: new Date(),
      });
    }
  };
  const addMedia = (id: string, bytes: Buffer, extra: Row = {}) => {
    const location = `https://app.example.com/uploads/2026/10/16/${id}.png`;
    world.media.push({
      id,
      organizationId: ORG,
      path: location,
      status: 'ready',
      name: id,
      thumbnail: null,
      alt: null,
      ...extra,
    });
    world.stored.set(location, bytes);
  };
  const addFont = async (
    family = 'Geist',
    bytes: Buffer = GEIST,
    organizationId = ORG
  ) => {
    const who = MEMBER('ADMIN');
    return fontService.uploadFont(
      { ...who, organization: { ...who.organization, id: organizationId } },
      { family, weight: 400, style: 'normal', file: { buffer: bytes } }
    );
  };
  const run = (extra: Row = {}) =>
    service.renderPage({
      organizationId: ORG,
      userId: USER,
      designId: PROJECT,
      revisionId: REV_1,
      pageId: 'p1',
      ...extra,
    } as never);
  return {
    world,
    calls,
    service,
    designs,
    brands,
    fonts,
    renders,
    fontStorage,
    reader,
    mediaService,
    render,
    addDesign,
    addKit,
    addMedia,
    addFont,
    run,
  };
};

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), ...(http.getResponse() as Row) } as {
    status: number;
    code: string;
    msg: string;
  };
};

type Setup = ReturnType<typeof setup>;
const nothingStarted = (s: Setup) => {
  expect(s.world.renders).toEqual([]);
  expect(s.render).not.toHaveBeenCalled();
  expect(s.world.savedMedia).toEqual([]);
};

const textDesign = () => document([page('p1', [text('t1', 'Hi')])]);

describe('ContentStudioDesignRenderService preflight', () => {
  it('RDS1/RDS2 a malformed or foreign design is a plain 404, before anything starts', async () => {
    const s = setup();
    s.addDesign(textDesign(), { organizationId: OTHER_ORG });
    for (const designId of ['nope', PROJECT, OTHER_PROJECT]) {
      expect(await failure(s.run({ designId }))).toEqual({
        status: 404,
        msg: 'Design not found.',
        code: 'CS_NOT_FOUND',
      });
    }
    nothingStarted(s);
  });

  it('RDS3/RDS4/RDS5 a malformed, missing, foreign or other design revision is not found', async () => {
    const s = setup();
    s.addDesign(textDesign());
    s.addDesign(textDesign(), {
      projectId: OTHER_PROJECT,
      revisionId: FOREIGN_REV,
    });
    for (const revisionId of [
      'nope',
      REV_2,
      FOREIGN_REV,
      REV_1.toUpperCase(),
    ]) {
      expect(await failure(s.run({ revisionId }))).toEqual({
        status: 404,
        msg: 'Design revision not found.',
        code: 'CS_DESIGN_REVISION_NOT_FOUND',
      });
    }
    expect(s.designs.getRevisionForProject).toHaveBeenCalledWith(
      ORG,
      PROJECT,
      FOREIGN_REV
    );
    nothingStarted(s);
  });

  it('RDS6 a corrupted revision is a design integrity error', async () => {
    const s = setup();
    s.addDesign(textDesign());
    s.world.revisions[0].contentHash = 'f'.repeat(64);
    expect(await failure(s.run())).toEqual({
      status: 500,
      msg: 'Stored design data could not be read safely.',
      code: 'CS_DESIGN_INTEGRITY_ERROR',
    });
    nothingStarted(s);
  });

  it('RDS7 a page that is not in the revision is refused, never another page', async () => {
    const s = setup();
    s.addDesign(document([page('p1', []), page('p2', [])]));
    for (const pageId of ['p3', 'P1', '', undefined]) {
      expect(await failure(s.run({ pageId }))).toEqual({
        status: 400,
        msg: 'The selected design page is not available.',
        code: 'CS_DESIGN_RENDER_PAGE_INVALID',
      });
    }
    nothingStarted(s);
  });

  it('RDS8/RDS9 renders an archived design and an older revision, exactly as asked', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]), {
      archivedAt: new Date(),
      latest: 2,
    });
    s.addDesign(document([page('p1', [])]), {
      revisionId: REV_2,
      revisionNumber: 2,
    });
    const result = await s.run();
    expect(result).toMatchObject({
      status: 'completed',
      designRevisionId: REV_1,
      designRevisionNumber: 1,
    });
    expect(s.world.renders[0]).toMatchObject({
      designRevisionId: REV_1,
      designRevisionNumber: 1,
    });
    expect(s.designs.getRevisionByNumber).not.toHaveBeenCalled();
  });

  it('RDS10 a design without a Brand Kit stores no Brand Kit provenance', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]));
    await s.run();
    expect(s.brands.getBrandKitForOrganization).not.toHaveBeenCalled();
    expect(s.world.renders[0].brand).toBeNull();
    expect(s.render.mock.calls[0][0].brandKit).toBeNull();
  });

  it('RDS11/M18 uses exactly the Brand Kit revision the design names, not the current one', async () => {
    const s = setup();
    s.addKit();
    await s.addFont('Geist');
    s.addDesign(
      document(
        [
          page('p1', [
            text('t1', 'Hi', { font: { type: 'brand', tokenId: 'heading' } }),
          ]),
        ],
        KIT_REF
      )
    );
    await s.run();
    expect(s.world.renders[0].brand).toEqual({
      brandKitId: KIT,
      brandKitRevisionId: KIT_REV_3,
      brandKitRevisionNumber: 3,
      brandKitContentHash: KIT_REF.contentHash,
    });
    expect(s.render.mock.calls[0][0].brandKit).toEqual({
      ref: KIT_REF,
      content: KIT_V3,
    });
    expect(s.fonts.getActiveMappingBySpec).toHaveBeenCalledWith(ORG, {
      family: 'Geist',
      weight: 400,
      style: 'normal',
    });
  });

  it('RDS12/RDS13/RDS14/RDS15 a missing, foreign, corrupted or mismatching Brand Kit revision is a Brand Kit integrity error', async () => {
    const cases: Array<(s: Setup) => void> = [
      () => undefined,
      (s) => {
        s.addKit();
        s.world.kits[0].organizationId = OTHER_ORG;
      },
      (s) => {
        s.addKit();
        s.world.kitRevisions = s.world.kitRevisions.filter(
          (r) => r.id !== KIT_REV_3
        );
      },
      (s) => {
        s.addKit();
        s.world.kitRevisions[0].content = '{}';
      },
      (s) => {
        s.addKit();
        s.world.kitRevisions[0].revisionNumber = 4;
      },
      (s) => {
        s.addKit();
        s.world.kits[0].id = 'b9999999-9999-4999-8999-999999999999';
      },
    ];
    for (const prepare of cases) {
      const s = setup();
      prepare(s);
      s.addDesign(document([page('p1', [shape('s1')])], KIT_REF));
      expect(await failure(s.run())).toEqual({
        status: 500,
        msg: 'Stored Brand Kit data could not be read safely.',
        code: 'CS_DESIGN_RENDER_BRAND_INTEGRITY_ERROR',
      });
      nothingStarted(s);
    }
  });

  it('FC8 a type style the Brand Kit revision lacks is caught before anything starts', async () => {
    const s = setup();
    s.addKit();
    s.addDesign(
      document(
        [
          page('p1', [
            text('t1', 'x', { font: { type: 'brand', tokenId: 'caption' } }),
          ]),
        ],
        KIT_REF
      )
    );
    expect((await failure(s.run())).code).toBe(
      'CS_DESIGN_RENDER_BRAND_INTEGRITY_ERROR'
    );
    nothingStarted(s);
  });
});

describe('ContentStudioDesignRenderService fonts', () => {
  it('RFT1/ROK12 a family font comes from its mapping, keyed by mapping and asset, and is snapshotted from what was captured', async () => {
    const s = setup();
    const mapping = await s.addFont('Geist');
    s.addDesign(textDesign());
    const result = await s.run();
    const asset = s.world.assets[0];
    const input = s.render.mock.calls[0][0];
    const resolved = input.fonts.resolveFont({
      family: 'Geist',
      weight: 400,
      style: 'normal',
    });
    expect(resolved?.key).toBe(`${mapping.id}:${asset.id}`);
    expect(Buffer.from(resolved!.bytes).equals(GEIST)).toBe(true);
    const snapshot = parseVerifiedContentStudioRenderAssetSnapshot(
      s.world.renders[0] as never
    );
    expect(snapshot.fonts).toEqual([
      {
        mappingId: mapping.id,
        fontAssetId: asset.id,
        family: 'Geist',
        weight: 400,
        style: 'normal',
        sha256: sha(GEIST),
      },
    ]);
    expect(result.assetSnapshotHash).toBe(s.world.renders[0].assetSnapshotHash);
  });

  it('RFT3/RFT4/RFT5/M10 a missing, disabled or foreign mapping fails the render as an unavailable asset', async () => {
    for (const prepare of [
      async () => undefined,
      async (s: Setup) => {
        await s.addFont('Geist');
        s.world.mappings[0].disabledAt = new Date();
      },
      async (s: Setup) => {
        await s.addFont('Geist', GEIST, OTHER_ORG);
      },
    ]) {
      const s = setup();
      await prepare(s);
      s.addDesign(textDesign());
      expect(await failure(s.run())).toEqual({
        status: 409,
        msg: 'A design render asset is unavailable.',
        code: 'CS_DESIGN_RENDER_ASSET_UNAVAILABLE',
      });
      expect(s.world.renders[0]).toMatchObject({
        status: 'failed',
        errorCode: 'FONT_ASSET_UNAVAILABLE',
      });
      expect(s.render).toHaveBeenCalledTimes(1);
      expect(s.world.savedMedia).toEqual([]);
    }
  });

  it('RFT7/49 a mapped font whose stored object is gone is an asset integrity error', async () => {
    const s = setup();
    await s.addFont('Geist');
    s.world.objects.clear();
    s.addDesign(textDesign());
    expect(await failure(s.run())).toEqual({
      status: 500,
      msg: 'Stored design render asset data could not be verified.',
      code: 'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR',
    });
    expect(s.world.renders[0]).toMatchObject({
      status: 'failed',
      errorCode: 'FONT_ASSET_INTEGRITY_ERROR',
    });
    expect(s.render).not.toHaveBeenCalled();
  });

  it('RFT6 an asset row of another organization is never read with this organization', async () => {
    const s = setup();
    await s.addFont('Geist');
    // a stored key naming another organization
    s.world.assets[0].storageKey = `fonts/${OTHER_ORG}/${s.world.assets[0].id}.ttf`;
    s.addDesign(textDesign());
    expect((await failure(s.run())).code).toBe(
      'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR'
    );
    expect(s.render).not.toHaveBeenCalled();
  });

  it('RFT8/74/M6 font bytes that are not the asset hash fail as integrity, with no output', async () => {
    const s = setup();
    await s.addFont('Geist');
    s.world.objects.set(s.world.assets[0].storageKey as string, GEIST_B);
    s.addDesign(textDesign());
    expect((await failure(s.run())).code).toBe(
      'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR'
    );
    expect(s.world.renders[0]).toMatchObject({
      status: 'failed',
      errorCode: 'FONT_ASSET_INTEGRITY_ERROR',
    });
    expect(s.world.renders[0].assetSnapshot).toBeUndefined();
    expect(s.world.savedMedia).toEqual([]);
    // refused while loading, before the renderer runs
    expect(s.render).not.toHaveBeenCalled();
  });

  it('48 a mapped font without private storage configured fails with the fixed 503', async () => {
    const s = setup({ fontStorage: 'unavailable' });
    s.world.assets.push({
      id: 'c1111111-1111-4111-8111-111111111111',
      organizationId: ORG,
      storageKey: `fonts/${ORG}/c1111111-1111-4111-8111-111111111111.ttf`,
      sha256: sha(GEIST),
      byteSize: GEIST.length,
      format: 'ttf',
    });
    s.world.mappings.push({
      id: 'd1111111-1111-4111-8111-111111111111',
      organizationId: ORG,
      family: 'Geist',
      weight: 400,
      style: 'normal',
      fontAssetId: 'c1111111-1111-4111-8111-111111111111',
      disabledAt: null,
    });
    s.addDesign(textDesign());
    expect(await failure(s.run())).toEqual({
      status: 503,
      msg: 'Private render font storage is not configured.',
      code: 'CS_RENDER_FONT_STORAGE_UNAVAILABLE',
    });
    expect(s.world.renders[0]).toMatchObject({
      status: 'failed',
      errorCode: 'FONT_STORAGE_UNAVAILABLE',
    });
  });

  it('CF12 a design without visible text never touches private font storage', async () => {
    const s = setup({ fontStorage: 'unavailable' });
    s.addMedia('photo', RED);
    s.addDesign(
      document([
        page('p1', [
          shape('s1'),
          image('i1', 'photo', sha(RED)),
          text('t1', 'x', { visible: false }),
        ]),
      ])
    );
    expect((await s.run()).status).toBe('completed');
    expect(s.fontStorage.readFontAsset).not.toHaveBeenCalled();
    expect(s.fonts.getActiveMappingBySpec).not.toHaveBeenCalled();
  });

  it('RFT9/RFT10/M8/M9 only the fonts the layout needs are loaded: not hidden ones, not unrelated broken mappings', async () => {
    const s = setup();
    await s.addFont('Geist');
    await s.addFont('Hidden Family');
    await s.addFont('Unused Broken');
    s.world.objects.delete(s.world.assets[1].storageKey as string);
    s.world.objects.delete(s.world.assets[2].storageKey as string);
    s.addDesign(
      document([
        page('p1', [
          text('t1', 'Hi'),
          text('t2', 'x', {
            visible: false,
            font: {
              type: 'family',
              family: 'Hidden Family',
              weight: 400,
              style: 'normal',
            },
          }),
        ]),
      ])
    );
    expect((await s.run()).status).toBe('completed');
    expect(
      s.fonts.getActiveMappingBySpec.mock.calls.map((c) => (c[1] as Row).family)
    ).toEqual(['Geist']);
    expect(s.fontStorage.readFontAsset).toHaveBeenCalledTimes(1);
  });

  it('RFT11/RFT12 a visible font on another page is loaded too, and each tuple once', async () => {
    const s = setup();
    await s.addFont('Geist');
    s.addDesign(
      document([
        page('p1', [shape('s1')]),
        page('p2', [text('t1', 'a'), text('t2', 'b')]),
      ])
    );
    const result = await s.run();
    expect(s.fonts.getActiveMappingBySpec).toHaveBeenCalledTimes(1);
    expect(s.fontStorage.readFontAsset).toHaveBeenCalledTimes(1);
    // page p1 itself uses no font
    expect(
      parseVerifiedContentStudioRenderAssetSnapshot(s.world.renders[0] as never)
        .fonts
    ).toEqual([]);
    expect(result.status).toBe('completed');
  });

  it('RFT13 the first required font in layout order decides the failure, and loading stops there', async () => {
    const s = setup();
    await s.addFont('Second');
    await s.addFont('First');
    s.world.objects.clear();
    s.addDesign(
      document([
        page('p1', [
          text('t1', 'a', {
            font: {
              type: 'family',
              family: 'First',
              weight: 400,
              style: 'normal',
            },
          }),
          text('t2', 'b', {
            font: {
              type: 'family',
              family: 'Second',
              weight: 400,
              style: 'normal',
            },
          }),
        ]),
      ])
    );
    await failure(s.run());
    expect(
      s.calls.filter((c) => c.startsWith('mapping') || c.startsWith('font'))
    ).toEqual(['mapping First', `font ${s.world.assets[1].storageKey}`]);
  });

  it('RFT14/73/M7 a mapping replaced during the render does not change what this render used or recorded', async () => {
    const s = setup();
    const mapping = await s.addFont('Geist');
    const assetA = s.world.assets[0];
    s.addMedia('photo', RED);
    s.addDesign(
      document([page('p1', [text('t1', 'Hi'), image('i1', 'photo', sha(RED))])])
    );
    // the image is read during the render, after the fonts were loaded
    (s.reader.readStoredMediaBytes as jest.Mock).mockImplementationOnce(
      async () => {
        await s.addFont('Geist', GEIST_B);
        return Buffer.from(RED);
      }
    );
    await s.run();
    expect(s.world.mappings[0].fontAssetId).not.toBe(assetA.id);
    expect(s.fonts.getActiveMappingBySpec).toHaveBeenCalledTimes(1);
    const snapshot = parseVerifiedContentStudioRenderAssetSnapshot(
      s.world.renders[0] as never
    );
    expect(snapshot.fonts).toEqual([
      expect.objectContaining({
        mappingId: mapping.id,
        fontAssetId: assetA.id,
        sha256: sha(GEIST),
      }),
    ]);
  });

  it('RFT15 a mapping disabled after the fonts were loaded does not stop the render', async () => {
    const s = setup();
    await s.addFont('Geist');
    s.addMedia('photo', RED);
    s.addDesign(
      document([page('p1', [text('t1', 'Hi'), image('i1', 'photo', sha(RED))])])
    );
    (s.reader.readStoredMediaBytes as jest.Mock).mockImplementationOnce(
      async () => {
        s.world.mappings[0].disabledAt = new Date();
        return Buffer.from(RED);
      }
    );
    expect((await s.run()).status).toBe('completed');
  });

  it('72 the central provenance case: a render before a replacement keeps asset A, the next one uses asset B', async () => {
    const s = setup();
    const mapping = await s.addFont('Geist', GEIST);
    s.addDesign(textDesign());
    const first = await s.run();
    const assetA = s.world.assets[0];
    await s.addFont('Geist', GEIST_B);
    const assetB = s.world.assets[1];
    const second = await s.run();
    const [renderA, renderB] = s.world.renders;
    const fontsA = parseVerifiedContentStudioRenderAssetSnapshot(
      renderA as never
    ).fonts;
    const fontsB = parseVerifiedContentStudioRenderAssetSnapshot(
      renderB as never
    ).fonts;
    expect(fontsA).toEqual([
      expect.objectContaining({
        mappingId: mapping.id,
        fontAssetId: assetA.id,
        sha256: sha(GEIST),
      }),
    ]);
    expect(fontsB).toEqual([
      expect.objectContaining({
        mappingId: mapping.id,
        fontAssetId: assetB.id,
        sha256: sha(GEIST_B),
      }),
    ]);
    expect(first.assetSnapshotHash).not.toBe(second.assetSnapshotHash);
    // the earlier asset and its bytes are untouched
    expect(
      s.world.objects.get(assetA.storageKey as string)?.equals(GEIST)
    ).toBe(true);
    expect(s.world.assets).toHaveLength(2);
  });
});

describe('ContentStudioDesignRenderService images', () => {
  it('RIM1/RIM5 an image of the organization is read once from its stored bytes', async () => {
    const s = setup();
    s.addMedia('photo', RED);
    s.addDesign(
      document([
        page('p1', [
          image('i1', 'photo', sha(RED)),
          image('i2', 'photo', sha(RED)),
        ]),
      ])
    );
    await s.run();
    expect(s.reader.readStoredMediaBytes).toHaveBeenCalledTimes(1);
    expect(s.mediaService.getMediaByIdForOrganization).toHaveBeenCalledWith(
      ORG,
      'photo'
    );
    expect(
      parseVerifiedContentStudioRenderAssetSnapshot(s.world.renders[0] as never)
        .images
    ).toEqual([{ mediaId: 'photo', sha256: sha(RED) }]);
  });

  it('RIM2/RIM3/M2 a Media of another organization or a missing one is an unavailable asset', async () => {
    for (const prepare of [
      (s: Setup) => {
        s.addMedia('photo', RED);
        s.world.media[0].organizationId = OTHER_ORG;
      },
      () => undefined,
    ]) {
      const s = setup();
      prepare(s);
      s.addDesign(document([page('p1', [image('i1', 'photo', sha(RED))])]));
      expect((await failure(s.run())).code).toBe(
        'CS_DESIGN_RENDER_ASSET_UNAVAILABLE'
      );
      expect(s.world.renders[0]).toMatchObject({
        status: 'failed',
        errorCode: 'IMAGE_ASSET_UNAVAILABLE',
      });
      expect(s.reader.readStoredMediaBytes).not.toHaveBeenCalled();
    }
  });

  it('RIM4/M13 stored bytes that are not the design hash fail as integrity', async () => {
    const s = setup();
    s.addMedia('photo', BLUE);
    s.addDesign(document([page('p1', [image('i1', 'photo', sha(RED))])]));
    const error = await failure(s.run());
    expect(error).toEqual({
      status: 500,
      msg: 'Stored design render asset data could not be verified.',
      code: 'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR',
    });
    expect(JSON.stringify(error)).not.toMatch(/[0-9a-f]{64}/);
    expect(s.world.renders[0]).toMatchObject({
      errorCode: 'IMAGE_ASSET_INTEGRITY_ERROR',
    });
  });

  it('RIM6 the same Media id under another hash is another image', async () => {
    const s = setup();
    s.addMedia('photo', RED);
    s.addDesign(
      document([
        page('p1', [
          image('i1', 'photo', sha(RED)),
          image('i2', 'photo', sha(BLUE), { visible: false }),
        ]),
      ])
    );
    await s.run();
    expect(s.reader.readStoredMediaBytes).toHaveBeenCalledTimes(1);
    s.world.renders = [];
    const t = setup();
    t.addMedia('photo', RED);
    t.addDesign(
      document([
        page('p1', [
          image('i1', 'photo', sha(RED)),
          image('i2', 'photo', sha(BLUE)),
        ]),
      ])
    );
    expect((await failure(t.run())).code).toBe(
      'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR'
    );
    expect(t.reader.readStoredMediaBytes).toHaveBeenCalledTimes(2);
  });

  it('RIM7/M16 a hidden image is never read or recorded', async () => {
    const s = setup();
    s.addDesign(
      document([
        page('p1', [
          shape('s1'),
          image('i1', 'missing', sha(RED), { visible: false }),
        ]),
      ])
    );
    expect((await s.run()).status).toBe('completed');
    expect(s.mediaService.getMediaByIdForOrganization).not.toHaveBeenCalled();
    expect(
      parseVerifiedContentStudioRenderAssetSnapshot(s.world.renders[0] as never)
        .images
    ).toEqual([]);
  });

  it('RIM8 a missing visible image on another page fails this page too (the renderer lays out the whole design)', async () => {
    const s = setup();
    s.addDesign(
      document([
        page('p1', [shape('s1')]),
        page('p2', [image('i1', 'missing', sha(RED))]),
      ])
    );
    expect((await failure(s.run())).code).toBe(
      'CS_DESIGN_RENDER_ASSET_UNAVAILABLE'
    );
  });

  it('ROK10/M15 the snapshot names only what the selected page used', async () => {
    const s = setup();
    await s.addFont('Geist');
    s.addMedia('red', RED);
    s.addMedia('blue', BLUE);
    s.addDesign(
      document([
        page('p1', [image('i1', 'red', sha(RED))]),
        page('p2', [image('i2', 'blue', sha(BLUE)), text('t1', 'x')]),
      ])
    );
    await s.run();
    const snapshot = parseVerifiedContentStudioRenderAssetSnapshot(
      s.world.renders[0] as never
    );
    expect(snapshot).toEqual({
      schemaVersion: 1,
      fonts: [],
      images: [{ mediaId: 'red', sha256: sha(RED) }],
    });
  });

  it('RIM9 reads no URL itself: every image goes through the bridge and the organization lookup', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const s = setup();
    s.addMedia('photo', RED);
    s.addDesign(document([page('p1', [image('i1', 'photo', sha(RED))])]));
    await s.run();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.calls).toEqual([
      `media https://app.example.com/uploads/2026/10/16/photo.png`,
    ]);
  });
});

describe('ContentStudioDesignRenderService success', () => {
  const full = async () => {
    const s = setup();
    s.addKit();
    const mapping = await s.addFont('Geist');
    s.addMedia('blue', BLUE);
    s.addMedia('red', RED);
    const stored = s.addDesign(
      document(
        [
          page('p1', [
            image('i1', 'blue', sha(BLUE)),
            text('t1', 'Hi', { font: { type: 'brand', tokenId: 'heading' } }),
            image('i2', 'red', sha(RED)),
            image('i3', 'blue', sha(BLUE)),
          ]),
        ],
        KIT_REF
      )
    );
    const result = await s.run();
    return { s, mapping, stored, result };
  };

  it('ROK1/ROK2/ROK3/ROK4 calls the renderer once with the exact revision, Brand Kit revision and page', async () => {
    const { s, stored } = await full();
    expect(s.render).toHaveBeenCalledTimes(1);
    const input = s.render.mock.calls[0][0];
    expect(input.document).toEqual(JSON.parse(stored.content));
    expect(input.brandKit).toEqual({ ref: KIT_REF, content: KIT_V3 });
    expect(input.pageId).toBe('p1');
    expect(Object.keys(input).sort()).toEqual([
      'brandKit',
      'document',
      'fonts',
      'images',
      'pageId',
    ]);
  });

  it('ROK5/ROK6/ROK7/ROK8/ROK9 stores the exact PNG once as a Media of the organization', async () => {
    const { s, result } = await full();
    expect(s.world.savedMedia).toHaveLength(1);
    const saved = s.world.savedMedia[0];
    const output = await s.render.mock.results[0].value;
    expect((saved.body as Buffer).equals(output.bytes)).toBe(true);
    expect(saved).toMatchObject({
      org: ORG,
      mimetype: 'image/png',
      ext: 'png',
      originalName: `content-studio-design-${result.id.slice(0, 8)}.png`,
    });
    expect(result.renderedSha256).toBe(sha(saved.body as Buffer));
    expect(result.renderedMediaId).toBe(saved.id);
    const meta = await sharp(saved.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 120, 80]);
  });

  it('ROK11/ROK13/M27/M28 records the renderer first-use order as canonical JSON with its hash', async () => {
    const { s, mapping, result } = await full();
    const row = s.world.renders[0];
    const snapshot = parseVerifiedContentStudioRenderAssetSnapshot(
      row as never
    );
    expect(snapshot.images).toEqual([
      { mediaId: 'blue', sha256: sha(BLUE) },
      { mediaId: 'red', sha256: sha(RED) },
    ]);
    expect(snapshot.fonts.map((f) => f.mappingId)).toEqual([mapping.id]);
    expect(result.assetSnapshotHash).toBe(row.assetSnapshotHash);
    expect(row.assetSnapshot).toMatch(
      /^\{"fonts":\[\{"family":"Geist","fontAssetId":/
    );
  });

  it('ROK14 completes the render with its exact provenance', async () => {
    const { s, stored, result } = await full();
    expect(s.world.renders).toHaveLength(1);
    expect(s.world.renders[0]).toMatchObject({
      id: result.id,
      organizationId: ORG,
      createdById: USER,
      designProjectId: PROJECT,
      designRevisionId: REV_1,
      designRevisionNumber: 1,
      designContentHash: stored.contentHash,
      pageId: 'p1',
      rendererVersion: 'content-studio-renderer-v1',
      layoutVersion: 'content-studio-layout-v1',
      status: 'completed',
      renderedMediaId: result.renderedMediaId,
      renderedSha256: result.renderedSha256,
      width: 120,
      height: 80,
      mimeType: 'image/png',
    });
  });

  it('ROK15 answers the safe render summary: no snapshot body, font or image detail, storage or URL', async () => {
    const { result } = await full();
    expect(Object.keys(result).sort()).toEqual([
      'assetSnapshotHash',
      'completedAt',
      'createdAt',
      'designProjectId',
      'designRevisionId',
      'designRevisionNumber',
      'height',
      'id',
      'mimeType',
      'pageId',
      'renderedMediaId',
      'renderedSha256',
      'status',
      'width',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /fonts\/|https?:|Geist|"blue"|"red"|uploads|storage/
    );
  });

  it('ROK16 the same explicit render twice is two renders and two Media', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]));
    const a = await s.run();
    const b = await s.run();
    expect(a.id).not.toBe(b.id);
    expect(a.renderedMediaId).not.toBe(b.renderedMediaId);
    expect(a.renderedSha256).toBe(b.renderedSha256);
    expect(s.world.renders).toHaveLength(2);
  });
});

describe('ContentStudioDesignRenderService failures', () => {
  const MAPPED: Array<[ContentStudioDesignRenderErrorCode, number, string]> = [
    ['PAGE_NOT_FOUND', 400, 'CS_DESIGN_RENDER_PAGE_INVALID'],
    ['FONT_ASSET_UNAVAILABLE', 409, 'CS_DESIGN_RENDER_ASSET_UNAVAILABLE'],
    ['IMAGE_ASSET_UNAVAILABLE', 409, 'CS_DESIGN_RENDER_ASSET_UNAVAILABLE'],
    [
      'FONT_ASSET_INTEGRITY_ERROR',
      500,
      'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR',
    ],
    [
      'IMAGE_ASSET_INTEGRITY_ERROR',
      500,
      'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR',
    ],
    ['FONT_ASSET_INVALID', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['FONT_ASSET_UNSUPPORTED', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['FONT_SHAPING_UNSUPPORTED', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['GLYPH_UNAVAILABLE', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['IMAGE_ASSET_INVALID', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['IMAGE_ASSET_UNSUPPORTED', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['BRAND_CONTEXT_ERROR', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['LAYOUT_FAILED', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['RENDER_OUTPUT_TOO_LARGE', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['RENDER_FAILED', 500, 'CS_DESIGN_RENDER_FAILED'],
    ['INVALID_INPUT', 500, 'CS_DESIGN_RENDER_FAILED'],
  ];

  it.each(MAPPED)(
    'RFAIL1/RFAIL2/RFAIL3/RFAIL5/RFAIL6/RFAIL7 renderer %s fails the render once, without output',
    async (code, status, publicCode) => {
      const s = setup();
      s.addDesign(document([page('p1', [shape('s1')])]));
      s.render.mockRejectedValueOnce(new ContentStudioDesignRenderError(code));
      const error = await failure(s.run());
      expect([error.status, error.code]).toEqual([status, publicCode]);
      expect(s.render).toHaveBeenCalledTimes(1);
      expect(s.world.renders).toHaveLength(1);
      expect(s.world.renders[0]).toMatchObject({
        status: 'failed',
        errorCode: code,
      });
      expect(s.world.renders[0].assetSnapshot).toBeUndefined();
      expect(s.world.renders[0].renderedMediaId).toBeUndefined();
      expect(s.world.savedMedia).toEqual([]);
    }
  );

  it('RFAIL10 an unexpected renderer error is RENDER_FAILED, quoting nothing', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]));
    s.render.mockRejectedValueOnce(new Error(MARKER));
    const error = await failure(s.run());
    expect(error.code).toBe('CS_DESIGN_RENDER_FAILED');
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(JSON.stringify(s.world.renders)).not.toContain(MARKER);
    expect(s.world.renders[0].errorCode).toBe('RENDER_FAILED');
  });

  it('RFAIL4/RFAIL9/M26 a Media storage failure fails the render once, without a second write', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]));
    s.mediaService.saveGeneratedFile.mockRejectedValueOnce(new Error(MARKER));
    const error = await failure(s.run());
    expect(error).toEqual({
      status: 500,
      msg: 'The rendered design could not be stored.',
      code: 'CS_DESIGN_RENDER_STORAGE_FAILED',
    });
    expect(s.mediaService.saveGeneratedFile).toHaveBeenCalledTimes(1);
    expect(s.render).toHaveBeenCalledTimes(1);
    expect(s.world.renders[0]).toMatchObject({
      status: 'failed',
      errorCode: 'STORAGE_FAILED',
    });
    expect(s.world.renders[0].assetSnapshot).toBeUndefined();
  });

  it('RFAIL8/RFAIL9/M25 a completion that cannot be written never renders or stores again', async () => {
    for (const fail of [
      (s: Setup) =>
        s.renders.completeRender.mockRejectedValueOnce(new Error(MARKER)),
      (s: Setup) =>
        s.renders.completeRender.mockResolvedValueOnce({ count: 0 }),
    ]) {
      const s = setup();
      s.addDesign(document([page('p1', [shape('s1')])]));
      fail(s);
      const error = await failure(s.run());
      expect(error).toEqual({
        status: 500,
        msg: 'The design could not be rendered.',
        code: 'CS_DESIGN_RENDER_FAILED',
      });
      expect(s.render).toHaveBeenCalledTimes(1);
      expect(s.mediaService.saveGeneratedFile).toHaveBeenCalledTimes(1);
      expect(s.renders.failRender).toHaveBeenCalledTimes(1);
      expect(s.world.renders[0]).toMatchObject({
        status: 'failed',
        errorCode: 'FINALIZATION_FAILED',
      });
      // the stored PNG stays as an unreferenced Media
      expect(s.world.savedMedia).toHaveLength(1);
    }
  });

  it('keeps the response when even marking the render failed fails', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]));
    s.render.mockRejectedValueOnce(
      new ContentStudioDesignRenderError('RENDER_FAILED')
    );
    s.renders.failRender.mockRejectedValueOnce(new Error(MARKER));
    expect((await failure(s.run())).code).toBe('CS_DESIGN_RENDER_FAILED');
    expect(s.world.renders[0].status).toBe('running');
  });

  it('refuses a renderer result that does not match the page or its own hash', async () => {
    for (const change of [
      { width: 999 },
      { pageId: 'other' },
      { sha256: 'f'.repeat(64) },
      { mimeType: 'image/jpeg' },
    ]) {
      const s = setup();
      s.addDesign(document([page('p1', [shape('s1')])]));
      const real = jest.requireActual(
        '@gitroom/nestjs-libraries/content-studio/design/render/design.renderer'
      );
      s.render.mockImplementationOnce(async (input) => ({
        ...(await real.renderContentStudioDesignPage(input)),
        ...change,
      }));
      expect((await failure(s.run())).code).toBe('CS_DESIGN_RENDER_FAILED');
      expect(s.world.savedMedia).toEqual([]);
    }
  });

  it('73/74 a renderer font or image the render did not load fails the snapshot, with no output', async () => {
    for (const assets of [
      { fonts: [{ key: 'x:y', sha256: 'a'.repeat(64) }], images: [] },
      { fonts: [], images: [{ mediaId: 'photo', sha256: 'a'.repeat(64) }] },
    ]) {
      const s = setup();
      s.addDesign(document([page('p1', [shape('s1')])]));
      const real = jest.requireActual(
        '@gitroom/nestjs-libraries/content-studio/design/render/design.renderer'
      );
      s.render.mockImplementationOnce(async (input) => ({
        ...(await real.renderContentStudioDesignPage(input)),
        assets,
      }));
      expect((await failure(s.run())).code).toBe(
        'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR'
      );
      expect(s.world.renders[0]).toMatchObject({
        status: 'failed',
        errorCode: 'SNAPSHOT_INTEGRITY_ERROR',
      });
      expect(s.world.savedMedia).toEqual([]);
    }
  });

  it('RFAIL11 logs nothing', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      (level) => jest.spyOn(console, level).mockImplementation(() => undefined)
    );
    const s = setup();
    s.addDesign(document([page('p1', [image('i1', 'missing', sha(RED))])]));
    await failure(s.run());
    await s.addFont('Geist');
    s.addDesign(textDesign(), { revisionId: REV_2, revisionNumber: 2 });
    await s.run({ revisionId: REV_2 });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('M21 every render that starts has a running row before the renderer runs', async () => {
    const s = setup();
    s.addDesign(document([page('p1', [shape('s1')])]));
    s.render.mockImplementationOnce(async () => {
      expect(s.world.renders).toHaveLength(1);
      expect(s.world.renders[0].status).toBe('running');
      throw new ContentStudioDesignRenderError('RENDER_FAILED');
    });
    await failure(s.run());
    expect(s.renders.createRunningRender).toHaveBeenCalledTimes(1);
  });
});
