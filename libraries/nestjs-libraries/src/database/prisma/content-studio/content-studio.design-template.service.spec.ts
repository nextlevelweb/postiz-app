import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioDesignTemplateRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.repository';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  parseVerifiedContentStudioDesignRevision,
  storedContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import {
  buildContentStudioSystemDesignTemplates,
  ContentStudioSystemDesignTemplateError,
  findContentStudioSystemDesignTemplate,
  listContentStudioSystemDesignTemplates,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.templates';

// Design templates (P4-11) end to end over the real repositories and
// services. No database: one small in-memory Prisma stands in for every
// table they use. It applies where clauses like Prisma (equality, not, OR;
// undefined is no condition), enforces the unique revision numbers, and its
// transactions put every table back when the callback throws, like a
// rollback. The Brand Kit repository is a fixture of exact revisions. The
// PostgreSQL constraints themselves are pinned in the schema section

const MARKER = 'DESIGN_TEMPLATE_PRIVATE_MARKER_123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KIT_REV1 = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KIT_REV2 = '9b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const T0 = new Date('2026-10-15T10:00:00.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, '');

type Row = Record<string, any>;

// --- Brand Kit fixture: one kit of ORG with two exact revisions ---
const kitContent = (colors: string[]) =>
  parseContentStudioBrandKitContent({
    schemaVersion: 1,
    identity: { brandName: 'Northwind', tagline: '', description: '' },
    colors: colors.map((id) => ({
      id,
      name: id,
      value: '#0057ff',
      role: 'custom',
    })),
    typography: [],
    visualDirection: { keywords: [], dos: [], donts: [] },
  });
const kitRevision = (id: string, revisionNumber: number, colors: string[]) => ({
  id,
  revisionNumber,
  createdAt: T0,
  ...storedContentStudioBrandKitContent(kitContent(colors)),
});
const BRAND_REVISIONS = [
  kitRevision(KIT_REV1, 1, ['primary']),
  kitRevision(KIT_REV2, 2, ['primary', 'accent']),
];
const kitRef = () => ({
  brandKitId: KIT,
  revisionId: KIT_REV1,
  revisionNumber: 1,
  contentHash: BRAND_REVISIONS[0].contentHash,
});

// --- documents ---
const layers = (prefix = '') => [
  {
    id: `${prefix}panel`,
    type: 'shape',
    name: '',
    x: 0.5,
    y: 0,
    width: 1080,
    height: 300.25,
    rotation: 12.5,
    opacity: 0.9,
    visible: true,
    shape: 'rectangle',
    fill: { type: 'brand', tokenId: 'primary' },
    cornerRadius: 0,
  },
  {
    id: `${prefix}title`,
    type: 'text',
    name: `Title ${MARKER}`,
    x: 40,
    y: 400,
    width: 1000,
    height: 200,
    rotation: 0,
    opacity: 1,
    visible: true,
    text: `  Spring sale\n${MARKER} `,
    font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
    fontSize: 64,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: { type: 'literal', value: '#111111' },
    align: 'left',
    verticalAlign: 'top',
    overflow: 'shrink',
  },
  {
    id: `${prefix}photo`,
    type: 'image',
    name: '',
    x: -40,
    y: 600,
    width: 400,
    height: 300,
    rotation: 0,
    opacity: 1,
    visible: true,
    imageRef: { type: 'media', mediaId: 'media-photo-1', sha256: SHA('a') },
    fit: 'cover',
    focalPoint: { x: 0.25, y: 0.75 },
  },
];
const brandedDocument = (prefix = '') =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit: kitRef(),
    pages: [
      {
        id: 'p_one',
        name: 'One',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#ffffff' },
        },
        layers: layers(prefix),
      },
    ],
  });
const plainDocument = (text: string) =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit: null,
    pages: [
      {
        id: 'p_one',
        name: '',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#ffffff' },
        },
        layers: [{ ...layers()[1], text }],
      },
    ],
  });

// --- the in-memory Prisma ---
const UNIQUE: Record<string, string[][]> = {
  contentStudioDesignProject: [['id']],
  contentStudioDesignRevision: [['id'], ['designProjectId', 'revisionNumber']],
  contentStudioDesignTemplate: [['id']],
  contentStudioDesignTemplateRevision: [
    ['id'],
    ['templateId', 'revisionNumber'],
  ],
};
class UniqueConstraintError extends Error {}

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (key === 'OR') {
      return (value as Row[]).some((entry) => matches(row, entry));
    }
    if (value && typeof value === 'object' && 'not' in value) {
      return row[key] !== value.not;
    }
    return row[key] === value;
  });
const pick = (row: Row, select?: Row) =>
  select
    ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
    : { ...row };

const setup = () => {
  const state: Record<string, Row[]> = Object.fromEntries(
    Object.keys(UNIQUE).map((table) => [table, []])
  );
  const calls: string[] = [];
  let clock = 0;
  const delegate = (table: string) => ({
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      calls.push(`${table}.findFirst`);
      const row = state[table].find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
    findMany: jest.fn(
      async (args: {
        where: Row;
        select?: Row;
        skip?: number;
        take?: number;
      }) => {
        calls.push(`${table}.findMany`);
        return state[table]
          .filter((r) => matches(r, args.where))
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1000))
          .map((r) => pick(r, args.select));
      }
    ),
    count: jest.fn(async (args: { where: Row }) => {
      calls.push(`${table}.count`);
      return state[table].filter((r) => matches(r, args.where)).length;
    }),
    create: jest.fn(async (args: { data: Row; select?: Row }) => {
      calls.push(`${table}.create`);
      for (const keys of UNIQUE[table]) {
        if (
          state[table].some((r) =>
            keys.every((key) => r[key] === args.data[key])
          )
        ) {
          throw new UniqueConstraintError(
            `Unique constraint ${keys.join(',')}`
          );
        }
      }
      const at = new Date(T0.getTime() + ++clock * 1000);
      const row = {
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        ...args.data,
      };
      state[table].push(row);
      return pick(row, args.select);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      calls.push(`${table}.updateMany`);
      const rows = state[table].filter((r) => matches(r, args.where));
      for (const row of rows) {
        for (const [key, value] of Object.entries(args.data)) {
          row[key] =
            value && typeof value === 'object' && 'increment' in value
              ? row[key] + value.increment
              : value;
        }
        row.updatedAt = new Date(T0.getTime() + ++clock * 1000);
      }
      return { count: rows.length };
    }),
    update: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });
  const client: Row = Object.fromEntries(
    Object.keys(UNIQUE).map((table) => [table, delegate(table)])
  );
  const transaction = {
    $transaction: jest.fn(async (fn: (tx: Row) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state), (key, value) =>
        /At$/.test(key) && typeof value === 'string' ? new Date(value) : value
      );
      try {
        return await fn(client);
      } catch (err) {
        for (const table of Object.keys(state)) {
          state[table] = snapshot[table];
        }
        throw err;
      }
    }),
  };
  const model = { model: client };
  const designRepository = new ContentStudioDesignRepository(
    model as unknown as PrismaRepository<'contentStudioDesignProject'>,
    model as unknown as PrismaRepository<'contentStudioDesignRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  const templateRepository = new ContentStudioDesignTemplateRepository(
    model as unknown as PrismaRepository<'contentStudioDesignTemplate'>,
    model as unknown as PrismaRepository<'contentStudioDesignTemplateRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  const brandKits = {
    getBrandKitForOrganization: jest.fn(async (organizationId: string) =>
      organizationId === ORG ? { id: KIT } : null
    ),
    getRevisionForBrandKit: jest.fn(
      async (organizationId: string, brandKitId: string, revisionId: string) =>
        organizationId === ORG && brandKitId === KIT
          ? BRAND_REVISIONS.find((r) => r.id === revisionId) ?? null
          : null
    ),
    // never used: a template never follows a later Brand Kit revision
    getCurrentRevision: jest.fn(),
    getLatestRevision: jest.fn(),
  };
  const designs = new ContentStudioDesignService(
    designRepository,
    brandKits as unknown as ContentStudioBrandKitRepository
  );
  const templates = new ContentStudioDesignTemplateService(
    templateRepository,
    designs
  );
  return { state, calls, client, transaction, designs, templates, brandKits };
};

const status = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const response = (err as HttpException).getResponse() as Row;
    // a fixed message only: no stored text, id or marker
    expect(inspect(response)).not.toContain(MARKER);
    return [(err as HttpException).getStatus(), response.code];
  }
  throw new Error('expected an HttpException');
};

const createTemplate = (
  templates: ContentStudioDesignTemplateService,
  overrides: Row = {}
) =>
  templates.createTemplate({
    organizationId: ORG,
    userId: USER,
    name: '  Launch post  ',
    description: 'For launches',
    content: brandedDocument(),
    ...overrides,
  });
const createDesign = (
  designs: ContentStudioDesignService,
  organizationId = ORG
) =>
  designs.createDesign({
    organizationId,
    userId: USER,
    name: 'Source design',
    content:
      organizationId === ORG ? brandedDocument() : plainDocument('other'),
  });
const storedRow = (state: Record<string, Row[]>, table: string, id: string) =>
  state[table].find((r) => r.id === id) as Row;

// ============================================================================
describe('Built-in design templates', () => {
  const all = listContentStudioSystemDesignTemplates();

  it('ST1/ST2 are a few valid Design Document v1 with stable unique ids and revisions', () => {
    expect(
      all.map((t) => [
        t.id,
        t.revisionNumber,
        t.content.pages[0].width,
        t.content.pages[0].height,
      ])
    ).toEqual([
      ['system:square-post', 1, 1080, 1080],
      ['system:portrait-post', 1, 1080, 1350],
      ['system:story', 1, 1080, 1920],
    ]);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    for (const template of all) {
      expect(template.schemaVersion).toBe(1);
      expect(template.content.schemaVersion).toBe(1);
      expect(parseContentStudioDesignDocument(template.content)).toEqual(
        template.content
      );
      const layerIds = template.content.pages.flatMap((p) =>
        p.layers.map((l) => l.id)
      );
      expect(new Set(layerIds).size).toBe(layerIds.length);
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
    }
  });

  it('ST3/P411-4/P411-5/P411-6/M16/M17 carry no Brand Kit reference, no image, no Media id and no URL', () => {
    for (const template of all) {
      expect(template.content.brandKit).toBeNull();
      const text = JSON.stringify(template.content);
      expect(text).not.toMatch(
        /"image"|mediaId|sha256|tokenId|brandKitId|revisionId|https?:|www\.|data:/i
      );
    }
  });

  it('ST4 the hash is the canonical document hash, stable across calls', () => {
    for (const template of all) {
      expect(template.contentHash).toBe(
        storedContentStudioDesignDocument(template.content).contentHash
      );
      expect(template.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(
      listContentStudioSystemDesignTemplates().map((t) => t.contentHash)
    ).toEqual(all.map((t) => t.contentHash));
    // pinned: a change to a built-in needs a new revision number
    expect(
      all.map((t) => `${t.id}@${t.revisionNumber}:${t.contentHash}`)
    ).toEqual([
      'system:square-post@1:9c2f3553e421c56f85e18cb68ba1b1cad691bed7a52b90b4b2831cbc82933fc4',
      'system:portrait-post@1:b112da5d4c2d7a168220de0c4db963ae8c49063e1ebb5716c34597ca11dfb8f0',
      'system:story@1:b41ec7c4877b1a96b7ad4668988347292825571272130a15602856ceea6479f6',
    ]);
  });

  it('ST5 every caller gets its own copy', () => {
    const one = findContentStudioSystemDesignTemplate('system:square-post');
    (one?.content.pages[0].layers[0] as Row).x = 999;
    expect(
      findContentStudioSystemDesignTemplate('system:square-post')?.content
        .pages[0].layers[0].x
    ).toBe(0);
    expect(findContentStudioSystemDesignTemplate('system:nope')).toBeNull();
    expect(findContentStudioSystemDesignTemplate(42)).toBeNull();
  });

  it('ST6/M18/M19 an invalid, shared-unsafe or duplicate built-in fails loudly, never skipped', () => {
    const square = {
      id: 'system:a',
      revisionNumber: 1,
      name: 'A',
      description: 'A',
      document: all[0].content,
    };
    expect(buildContentStudioSystemDesignTemplates([square])).toHaveLength(1);
    const bad = (definition: Row) => () =>
      buildContentStudioSystemDesignTemplates([definition as never]);
    expect(() =>
      buildContentStudioSystemDesignTemplates([square, { ...square }])
    ).toThrow(ContentStudioSystemDesignTemplateError);
    expect(bad({ ...square, id: 'square' })).toThrow(
      ContentStudioSystemDesignTemplateError
    );
    expect(bad({ ...square, revisionNumber: 0 })).toThrow(
      ContentStudioSystemDesignTemplateError
    );
    expect(
      bad({ ...square, document: { ...all[0].content, schemaVersion: 2 } })
    ).toThrow(ContentStudioSystemDesignTemplateError);
    expect(
      bad({ ...square, document: { ...all[0].content, brandKit: kitRef() } })
    ).toThrow(ContentStudioSystemDesignTemplateError);
    const withImage = JSON.parse(JSON.stringify(all[0].content));
    withImage.pages[0].layers.push(layers()[2]);
    expect(bad({ ...square, document: withImage })).toThrow(
      ContentStudioSystemDesignTemplateError
    );
  });
});

// ============================================================================
describe('Design templates: create, read and metadata', () => {
  it('TC1/P411-10 creates the template and revision 1 together, with the canonical hash of the parsed document', async () => {
    const { templates, state } = setup();
    const created = await createTemplate(templates);
    expect(created).toMatchObject({
      source: 'organization',
      name: 'Launch post',
      description: 'For launches',
      latestRevisionNumber: 1,
      archivedAt: null,
      currentRevision: { revisionNumber: 1, schemaVersion: 1 },
    });
    const row = storedRow(
      state,
      'contentStudioDesignTemplateRevision',
      created.currentRevision.id
    );
    const stored = storedContentStudioDesignDocument(brandedDocument());
    expect([
      row.content,
      row.contentHash,
      row.organizationId,
      row.templateId,
    ]).toEqual([stored.content, stored.contentHash, ORG, created.id]);
    expect(created.currentRevision.contentHash).toBe(stored.contentHash);
    expect(state.contentStudioDesignTemplate[0]).toMatchObject({
      organizationId: ORG,
      createdById: USER,
      latestRevisionNumber: 1,
    });
  });

  it('TC2/M1 an invalid document, a token without Brand Kit, a foreign Brand Kit revision or a bad name is refused; nothing is stored', async () => {
    const { templates, state } = setup();
    const invalid = { ...brandedDocument(), pages: [] };
    expect(
      await status(() => createTemplate(templates, { content: invalid }))
    ).toEqual([400, 'CS_DESIGN_INVALID']);
    expect(
      await status(() =>
        createTemplate(templates, {
          content: { ...brandedDocument(), brandKit: null },
        })
      )
    ).toEqual([400, 'CS_DESIGN_BRAND_REFERENCE_INVALID']);
    expect(
      await status(() =>
        createTemplate(templates, { organizationId: OTHER_ORG })
      )
    ).toEqual([400, 'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND']);
    expect(
      await status(() =>
        createTemplate(templates, {
          content: {
            ...brandedDocument(),
            brandKit: { ...kitRef(), contentHash: SHA('f') },
          },
        })
      )
    ).toEqual([400, 'CS_DESIGN_BRAND_REFERENCE_INVALID']);
    for (const name of ['', '   ', 'x'.repeat(201), 'a\u0000b', 42]) {
      expect(await status(() => createTemplate(templates, { name }))).toEqual([
        400,
        'CS_INVALID_REQUEST',
      ]);
    }
    expect(
      await status(() =>
        createTemplate(templates, { description: 'x'.repeat(1001) })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
    expect(state.contentStudioDesignTemplate).toHaveLength(0);
    expect(state.contentStudioDesignTemplateRevision).toHaveLength(0);
  });

  it('TC3/TC4 reads, lists with current documents, renames and describes; metadata makes no revision', async () => {
    const { templates, state } = setup();
    const created = await createTemplate(templates, { description: '' });
    expect(created.description).toBeNull();
    const renamed = await templates.updateTemplate(ORG, created.id, {
      name: ' Renamed ',
      description: undefined,
    });
    expect(renamed).toMatchObject({
      name: 'Renamed',
      description: null,
      latestRevisionNumber: 1,
    });
    await templates.updateTemplate(ORG, created.id, {
      name: undefined,
      description: '  Better  ',
    });
    const read = await templates.getTemplate(ORG, created.id);
    expect(read).toMatchObject({
      name: 'Renamed',
      description: 'Better',
      latestRevisionNumber: 1,
    });
    expect(read.currentRevision.content).toEqual(brandedDocument());
    expect(state.contentStudioDesignTemplateRevision).toHaveLength(1);
    expect(
      await status(() =>
        templates.updateTemplate(ORG, created.id, {
          name: undefined,
          description: undefined,
        })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
    const list = await templates.listTemplates({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(list.system.map((t) => t.id)).toEqual([
      'system:square-post',
      'system:portrait-post',
      'system:story',
    ]);
    expect(list.system[0]).toMatchObject({
      source: 'system',
      archivedAt: null,
      latestRevisionNumber: 1,
    });
    expect(list.results).toHaveLength(1);
    expect(list.results[0]).toMatchObject({
      source: 'organization',
      id: created.id,
      currentRevision: { revisionNumber: 1 },
    });
    expect(list.results[0].currentRevision.content).toEqual(brandedDocument());
  });

  it('TC5 the list loads the current revision of every listed template in one query, never their history', async () => {
    const { templates, calls } = setup();
    for (let i = 0; i < 3; i++) {
      const t = await createTemplate(templates, { name: `T${i}` });
      await templates.createRevision({
        organizationId: ORG,
        templateId: t.id,
        userId: USER,
        baseRevisionNumber: 1,
        content: brandedDocument('v2_'),
      });
    }
    calls.length = 0;
    const list = await templates.listTemplates({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(list.results.map((r) => r.currentRevision.revisionNumber)).toEqual([
      2, 2, 2,
    ]);
    expect(
      calls.filter((c) => c.startsWith('contentStudioDesignTemplateRevision'))
    ).toEqual(['contentStudioDesignTemplateRevision.findMany']);
  });

  it('TC6 archive and restore touch the template only; archived ones are listed apart and read-only', async () => {
    const { templates, state } = setup();
    const created = await createTemplate(templates);
    const archived = await templates.archiveTemplate(ORG, created.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(
      (
        await templates.listTemplates({
          organizationId: ORG,
          archived: false,
          page: 1,
        })
      ).results
    ).toHaveLength(0);
    const archivedList = await templates.listTemplates({
      organizationId: ORG,
      archived: true,
      page: 1,
    });
    expect(archivedList.results.map((r) => r.id)).toEqual([created.id]);
    expect(archivedList.system).toEqual([]);
    expect(
      await status(() =>
        templates.updateTemplate(ORG, created.id, {
          name: 'x',
          description: undefined,
        })
      )
    ).toEqual([409, 'CS_DESIGN_TEMPLATE_ARCHIVED']);
    expect(
      await status(() =>
        templates.createRevision({
          organizationId: ORG,
          templateId: created.id,
          userId: USER,
          baseRevisionNumber: 1,
          content: brandedDocument(),
        })
      )
    ).toEqual([409, 'CS_DESIGN_TEMPLATE_ARCHIVED']);
    // history stays readable
    expect(
      (
        await templates.listRevisions({
          organizationId: ORG,
          templateId: created.id,
          page: 1,
        })
      ).results
    ).toHaveLength(1);
    expect(
      (await templates.getTemplate(ORG, created.id)).currentRevision.content
    ).toEqual(brandedDocument());
    const restored = await templates.restoreTemplate(ORG, created.id);
    expect(restored.archivedAt).toBeNull();
    expect(state.contentStudioDesignTemplateRevision).toHaveLength(1);
  });

  it('a stored revision that no longer matches its hash is reported, never repaired', async () => {
    const { templates, state } = setup();
    const created = await createTemplate(templates);
    state.contentStudioDesignTemplateRevision[0].contentHash = SHA('0');
    expect(await status(() => templates.getTemplate(ORG, created.id))).toEqual([
      500,
      'CS_DESIGN_TEMPLATE_INTEGRITY_ERROR',
    ]);
  });
});

// ============================================================================
describe('Design templates: immutable revisions and compare-and-swap', () => {
  const revise = (
    templates: ContentStudioDesignTemplateService,
    templateId: string,
    base: number,
    text: string
  ) =>
    templates.createRevision({
      organizationId: ORG,
      templateId,
      userId: USER,
      baseRevisionNumber: base,
      content: plainDocument(text),
    });

  it('TCAS1/TCAS2/TCAS3/TCAS5/M4/M6/M30 a save over the current revision makes the next one; a stale base is a conflict that changes nothing', async () => {
    const { templates, state } = setup();
    const created = await createTemplate(templates);
    const first = { ...state.contentStudioDesignTemplateRevision[0] };
    const next = await revise(templates, created.id, 1, 'second');
    expect(next).toMatchObject({
      created: true,
      revision: { revisionNumber: 2 },
    });
    expect(next.revision.content).toEqual(plainDocument('second'));
    const before = JSON.stringify(state.contentStudioDesignTemplateRevision);
    const conflict = await status(() =>
      revise(templates, created.id, 1, 'stale')
    );
    expect(conflict).toEqual([409, 'CS_DESIGN_TEMPLATE_REVISION_CONFLICT']);
    expect(JSON.stringify(state.contentStudioDesignTemplateRevision)).toBe(
      before
    );
    // revision 1 is exactly what it was: content, hash, number, id
    expect(state.contentStudioDesignTemplateRevision[0]).toEqual(first);
    const old = await templates.getRevision({
      organizationId: ORG,
      templateId: created.id,
      revisionId: first.id,
    });
    expect(old.content).toEqual(brandedDocument());
    expect(old.contentHash).toBe(first.contentHash);
    expect(
      storedRow(state, 'contentStudioDesignTemplate', created.id)
        .latestRevisionNumber
    ).toBe(2);
  });

  it('TCAS4/M3/M5 two saves from the same base: one revision 2, one conflict, no retry, numbers contiguous', async () => {
    const { templates, state, transaction } = setup();
    const created = await createTemplate(templates);
    const results = await Promise.allSettled([
      revise(templates, created.id, 1, 'left'),
      revise(templates, created.id, 1, 'right'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect((rejected.reason as HttpException).getStatus()).toBe(409);
    expect(
      state.contentStudioDesignTemplateRevision
        .map((r) => r.revisionNumber)
        .sort()
    ).toEqual([1, 2]);
    // creation and the one successful save; the losing save tried once
    expect(transaction.$transaction).toHaveBeenCalledTimes(3);
    await revise(templates, created.id, 2, 'third');
    expect(
      state.contentStudioDesignTemplateRevision.map((r) => r.revisionNumber)
    ).toEqual([1, 2, 3]);
  });

  it('TCAS6 content equal to the current revision makes no new one; an invalid document is refused before any write', async () => {
    const { templates, state, transaction } = setup();
    const created = await createTemplate(templates);
    const same = await templates.createRevision({
      organizationId: ORG,
      templateId: created.id,
      userId: USER,
      baseRevisionNumber: 1,
      content: brandedDocument(),
    });
    expect(same).toMatchObject({
      created: false,
      revision: { revisionNumber: 1 },
    });
    const calls = transaction.$transaction.mock.calls.length;
    expect(
      await status(() =>
        templates.createRevision({
          organizationId: ORG,
          templateId: created.id,
          userId: USER,
          baseRevisionNumber: 1,
          content: { schemaVersion: 1 },
        })
      )
    ).toEqual([400, 'CS_DESIGN_INVALID']);
    for (const base of [0, 1.5, '1', -1, 2_147_483_648]) {
      expect(
        await status(() =>
          templates.createRevision({
            organizationId: ORG,
            templateId: created.id,
            userId: USER,
            baseRevisionNumber: base,
            content: brandedDocument(),
          })
        )
      ).toEqual([400, 'CS_INVALID_REQUEST']);
    }
    expect(transaction.$transaction.mock.calls.length).toBe(calls);
    expect(state.contentStudioDesignTemplateRevision).toHaveLength(1);
  });

  it('M2 the stored text is the canonical JSON of the parsed document, whatever the key order sent', async () => {
    const { templates, state } = setup();
    const reordered = JSON.parse(JSON.stringify(brandedDocument()));
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    const created = await createTemplate(templates, { content: shuffled });
    const row = storedRow(
      state,
      'contentStudioDesignTemplateRevision',
      created.currentRevision.id
    );
    expect(row.content).toBe(
      storedContentStudioDesignDocument(brandedDocument()).content
    );
    expect(parseVerifiedContentStudioDesignRevision(row as never)).toEqual(
      brandedDocument()
    );
  });

  it('TI10/SAT8 a template whose first revision cannot be written is not created at all', async () => {
    const { templates, state, client } = setup();
    client.contentStudioDesignTemplateRevision.create.mockRejectedValueOnce(
      new Error('write failed')
    );
    await expect(createTemplate(templates)).rejects.toThrow('write failed');
    expect(state.contentStudioDesignTemplate).toHaveLength(0);
    expect(state.contentStudioDesignTemplateRevision).toHaveLength(0);
  });
});

// ============================================================================
describe('Design templates: tenant isolation', () => {
  const fixture = async () => {
    const env = setup();
    const theirs = await env.templates.createTemplate({
      organizationId: OTHER_ORG,
      userId: USER,
      name: 'Theirs',
      description: undefined,
      content: plainDocument(`their ${MARKER}`),
    });
    const ours = await createTemplate(env.templates);
    return { ...env, theirs, ours };
  };

  it('TSEC1/TSEC2/M7/M8 another organization’s template and its revisions read as missing', async () => {
    const { templates, theirs } = await fixture();
    expect(await status(() => templates.getTemplate(ORG, theirs.id))).toEqual([
      404,
      'CS_NOT_FOUND',
    ]);
    expect(
      await status(() =>
        templates.listRevisions({
          organizationId: ORG,
          templateId: theirs.id,
          page: 1,
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(
      await status(() =>
        templates.getRevision({
          organizationId: ORG,
          templateId: theirs.id,
          revisionId: theirs.currentRevision.id,
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    const list = await templates.listTemplates({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(list.results.map((r) => r.id)).not.toContain(theirs.id);
  });

  it('TSEC3/TSEC4 another organization’s template cannot be revised, renamed, archived or restored', async () => {
    const { templates, theirs, state } = await fixture();
    const before = JSON.stringify(state);
    expect(
      await status(() =>
        templates.createRevision({
          organizationId: ORG,
          templateId: theirs.id,
          userId: USER,
          baseRevisionNumber: 1,
          content: plainDocument('x'),
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(
      await status(() =>
        templates.updateTemplate(ORG, theirs.id, {
          name: 'Mine',
          description: undefined,
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(
      await status(() => templates.archiveTemplate(ORG, theirs.id))
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(
      await status(() => templates.restoreTemplate(ORG, theirs.id))
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('TSEC5/M9 another organization’s template cannot be used', async () => {
    const { templates, theirs, state } = await fixture();
    expect(
      await status(() =>
        templates.instantiateTemplate({
          organizationId: ORG,
          userId: USER,
          source: 'organization',
          templateId: theirs.id,
          revisionId: theirs.currentRevision.id,
          revisionNumber: undefined,
          name: 'Stolen',
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(state.contentStudioDesignProject).toHaveLength(0);
  });

  it('TSEC6/SAT6 another organization’s design revision cannot be saved as a template', async () => {
    const { templates, designs, state } = await fixture();
    const theirDesign = await createDesign(designs, OTHER_ORG);
    const count = state.contentStudioDesignTemplate.length;
    expect(
      await status(() =>
        templates.saveDesignRevisionAsTemplate({
          organizationId: ORG,
          userId: USER,
          designId: theirDesign.id,
          revisionId: theirDesign.currentRevision.id,
          name: 'Stolen',
          description: undefined,
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(state.contentStudioDesignTemplate).toHaveLength(count);
  });

  it('TSEC7 a revision id of another template never pairs with one’s own template', async () => {
    const { templates, ours, state } = await fixture();
    const second = await createTemplate(templates, { name: 'Second' });
    expect(
      await status(() =>
        templates.getRevision({
          organizationId: ORG,
          templateId: ours.id,
          revisionId: second.currentRevision.id,
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(
      await status(() =>
        templates.instantiateTemplate({
          organizationId: ORG,
          userId: USER,
          source: 'organization',
          templateId: ours.id,
          revisionId: second.currentRevision.id,
          revisionNumber: undefined,
          name: 'Mixed',
        })
      )
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(state.contentStudioDesignProject).toHaveLength(0);
  });

  it('TSEC8 a built-in id reaches no custom route: nothing is read or changed', async () => {
    const { templates, state, calls } = await fixture();
    const before = JSON.stringify(state);
    calls.length = 0;
    for (const run of [
      () => templates.getTemplate(ORG, 'system:square-post'),
      () =>
        templates.updateTemplate(ORG, 'system:square-post', {
          name: 'Mine',
          description: undefined,
        }),
      () => templates.archiveTemplate(ORG, 'system:square-post'),
      () => templates.restoreTemplate(ORG, 'system:square-post'),
      () =>
        templates.listRevisions({
          organizationId: ORG,
          templateId: 'system:story',
          page: 1,
        }),
      () =>
        templates.createRevision({
          organizationId: ORG,
          templateId: 'system:story',
          userId: USER,
          baseRevisionNumber: 1,
          content: plainDocument('x'),
        }),
      () =>
        templates.instantiateTemplate({
          organizationId: ORG,
          userId: USER,
          source: 'organization',
          templateId: 'system:story',
          revisionId: undefined,
          revisionNumber: 1,
          name: 'x',
        }),
    ]) {
      expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
    }
    expect(calls).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ============================================================================
describe('Design templates: using a template', () => {
  it('TI1/TI2/TI3/TI4/M10/M11/M12 a custom template revision becomes an ordinary design with revision 1, its document exactly the template’s', async () => {
    const { templates, designs, state, brandKits } = setup();
    const created = await createTemplate(templates);
    brandKits.getRevisionForBrandKit.mockClear();
    const design = await templates.instantiateTemplate({
      organizationId: ORG,
      userId: USER,
      source: 'organization',
      templateId: created.id,
      revisionId: created.currentRevision.id,
      revisionNumber: undefined,
      name: ' New launch ',
    });
    expect(design).toMatchObject({
      name: 'New launch',
      latestRevisionNumber: 1,
      currentRevision: { revisionNumber: 1 },
    });
    const project = storedRow(state, 'contentStudioDesignProject', design.id);
    expect(project).toMatchObject({
      organizationId: ORG,
      createdById: USER,
      latestRevisionNumber: 1,
    });
    const revision = state.contentStudioDesignRevision.find(
      (r) => r.designProjectId === design.id
    ) as Row;
    const template = state.contentStudioDesignTemplateRevision[0];
    // byte for byte the template's canonical document, so the same hash
    expect([revision.content, revision.contentHash]).toEqual([
      template.content,
      template.contentHash,
    ]);
    const content = (await designs.getDesign(ORG, design.id)).currentRevision
      .content;
    expect(content).toEqual(brandedDocument());
    expect(content.brandKit).toEqual(kitRef());
    expect(content.pages[0].layers[2]).toMatchObject({
      id: 'photo',
      imageRef: { type: 'media', mediaId: 'media-photo-1', sha256: SHA('a') },
    });
    expect(content.pages[0].layers.map((l) => l.id)).toEqual([
      'panel',
      'title',
      'photo',
    ]);
    // the exact Brand Kit revision was checked, never a later one
    expect(brandKits.getRevisionForBrandKit).toHaveBeenCalledWith(
      ORG,
      KIT,
      KIT_REV1
    );
    expect(brandKits.getCurrentRevision).not.toHaveBeenCalled();
    expect(brandKits.getLatestRevision).not.toHaveBeenCalled();
    // nothing links the design to the template
    expect(Object.keys(project)).not.toEqual(
      expect.arrayContaining(['templateId'])
    );
  });

  it('TI1b an older revision of a template is used exactly when asked for', async () => {
    const { templates, designs } = setup();
    const created = await createTemplate(templates);
    await templates.createRevision({
      organizationId: ORG,
      templateId: created.id,
      userId: USER,
      baseRevisionNumber: 1,
      content: plainDocument('v2'),
    });
    const design = await templates.instantiateTemplate({
      organizationId: ORG,
      userId: USER,
      source: 'organization',
      templateId: created.id,
      revisionId: created.currentRevision.id,
      revisionNumber: undefined,
      name: 'From v1',
    });
    expect(
      (await designs.getDesign(ORG, design.id)).currentRevision.content
    ).toEqual(brandedDocument());
  });

  it('TI5/TI6/M13/M14 template and design are independent after the copy', async () => {
    const { templates, designs, state } = setup();
    const created = await createTemplate(templates);
    const design = await templates.instantiateTemplate({
      organizationId: ORG,
      userId: USER,
      source: 'organization',
      templateId: created.id,
      revisionId: created.currentRevision.id,
      revisionNumber: undefined,
      name: 'Copy',
    });
    const templateRevisionBefore = JSON.stringify(
      state.contentStudioDesignTemplateRevision
    );
    // editing the design leaves the template as it was
    await designs.createRevision({
      organizationId: ORG,
      designId: design.id,
      userId: USER,
      baseRevisionNumber: 1,
      content: plainDocument('edited design'),
    });
    expect(JSON.stringify(state.contentStudioDesignTemplateRevision)).toBe(
      templateRevisionBefore
    );
    // a later template revision leaves the design as it was
    await templates.createRevision({
      organizationId: ORG,
      templateId: created.id,
      userId: USER,
      baseRevisionNumber: 1,
      content: plainDocument('edited template'),
    });
    const first = await designs.getRevision({
      organizationId: ORG,
      designId: design.id,
      revisionId: design.currentRevision.id,
    });
    expect(first.content).toEqual(brandedDocument());
    expect(
      (await designs.getDesign(ORG, design.id)).currentRevision.content
    ).toEqual(plainDocument('edited design'));
    // the response document is a copy: changing it changes no stored row
    (design.currentRevision.content as Row).pages[0].name = 'changed';
    expect(
      (await templates.getTemplate(ORG, created.id)).currentRevision.content
    ).toEqual(plainDocument('edited template'));
  });

  it('TI7 a built-in template becomes an ordinary design', async () => {
    const { templates, designs, state } = setup();
    const design = await templates.instantiateTemplate({
      organizationId: ORG,
      userId: USER,
      source: 'system',
      templateId: 'system:story',
      revisionId: undefined,
      revisionNumber: 1,
      name: 'My story',
    });
    const content = (await designs.getDesign(ORG, design.id)).currentRevision
      .content;
    expect(content).toEqual(
      findContentStudioSystemDesignTemplate('system:story')?.content
    );
    expect(content.pages[0].height).toBe(1920);
    expect(state.contentStudioDesignTemplate).toHaveLength(0);
  });

  it('TI8 an unknown built-in, a wrong built-in revision, a bad source or missing ids are refused', async () => {
    const { templates, state } = setup();
    const use = (overrides: Row) =>
      templates.instantiateTemplate({
        organizationId: ORG,
        userId: USER,
        source: 'system',
        templateId: 'system:story',
        revisionId: undefined,
        revisionNumber: 1,
        name: 'x',
        ...overrides,
      });
    expect(await status(() => use({ templateId: 'system:nope' }))).toEqual([
      404,
      'CS_NOT_FOUND',
    ]);
    expect(await status(() => use({ revisionNumber: 2 }))).toEqual([
      404,
      'CS_NOT_FOUND',
    ]);
    expect(await status(() => use({ revisionNumber: undefined }))).toEqual([
      404,
      'CS_NOT_FOUND',
    ]);
    expect(await status(() => use({ source: 'public' }))).toEqual([
      400,
      'CS_INVALID_REQUEST',
    ]);
    expect(
      await status(() => use({ source: 'organization', templateId: undefined }))
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(await status(() => use({ name: '' }))).toEqual([
      400,
      'CS_INVALID_REQUEST',
    ]);
    expect(state.contentStudioDesignProject).toHaveLength(0);
  });

  it('TI9 an archived template is not used; restored, it is', async () => {
    const { templates, state } = setup();
    const created = await createTemplate(templates);
    await templates.archiveTemplate(ORG, created.id);
    const use = () =>
      templates.instantiateTemplate({
        organizationId: ORG,
        userId: USER,
        source: 'organization',
        templateId: created.id,
        revisionId: created.currentRevision.id,
        revisionNumber: undefined,
        name: 'x',
      });
    expect(await status(use)).toEqual([409, 'CS_DESIGN_TEMPLATE_ARCHIVED']);
    expect(state.contentStudioDesignProject).toHaveLength(0);
    await templates.restoreTemplate(ORG, created.id);
    await use();
    expect(state.contentStudioDesignProject).toHaveLength(1);
  });

  it('TI10 a design whose first revision cannot be written is not created at all', async () => {
    const { templates, state, client } = setup();
    client.contentStudioDesignRevision.create.mockRejectedValueOnce(
      new Error('write failed')
    );
    await expect(
      templates.instantiateTemplate({
        organizationId: ORG,
        userId: USER,
        source: 'system',
        templateId: 'system:square-post',
        revisionId: undefined,
        revisionNumber: 1,
        name: 'x',
      })
    ).rejects.toThrow('write failed');
    expect(state.contentStudioDesignProject).toHaveLength(0);
  });
});

// ============================================================================
describe('Design templates: saving a design revision as a template', () => {
  it('SAT1/SAT2/SAT3/SAT4/SAT9/M20 the stored revision becomes revision 1 of a new template; the design is unchanged', async () => {
    const { templates, designs, state } = setup();
    const design = await createDesign(designs);
    const designBefore = JSON.stringify([
      state.contentStudioDesignProject,
      state.contentStudioDesignRevision,
    ]);
    const template = await templates.saveDesignRevisionAsTemplate({
      organizationId: ORG,
      userId: USER,
      designId: design.id,
      revisionId: design.currentRevision.id,
      name: 'From design',
      description: 'Saved',
    });
    expect(template).toMatchObject({
      source: 'organization',
      name: 'From design',
      description: 'Saved',
      latestRevisionNumber: 1,
    });
    const stored = state.contentStudioDesignTemplateRevision[0];
    const source = state.contentStudioDesignRevision[0];
    expect([stored.content, stored.contentHash]).toEqual([
      source.content,
      source.contentHash,
    ]);
    expect(template.currentRevision.content.brandKit).toEqual(kitRef());
    expect(template.currentRevision.content.pages[0].layers[2]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'media-photo-1', sha256: SHA('a') },
    });
    expect(
      JSON.stringify([
        state.contentStudioDesignProject,
        state.contentStudioDesignRevision,
      ])
    ).toBe(designBefore);
  });

  it('SAT5 an older design revision can be saved, exactly as it was', async () => {
    const { templates, designs } = setup();
    const design = await createDesign(designs);
    await designs.createRevision({
      organizationId: ORG,
      designId: design.id,
      userId: USER,
      baseRevisionNumber: 1,
      content: plainDocument('newer'),
    });
    const template = await templates.saveDesignRevisionAsTemplate({
      organizationId: ORG,
      userId: USER,
      designId: design.id,
      revisionId: design.currentRevision.id,
      name: 'Old one',
      description: undefined,
    });
    expect(template.currentRevision.content).toEqual(brandedDocument());
  });

  it('SAT7 a revision of another design, or ids that cannot exist, are refused', async () => {
    const { templates, designs, state } = setup();
    const one = await createDesign(designs);
    const two = await createDesign(designs);
    const save = (designId: string, revisionId: string) =>
      templates.saveDesignRevisionAsTemplate({
        organizationId: ORG,
        userId: USER,
        designId,
        revisionId,
        name: 'x',
        description: undefined,
      });
    expect(await status(() => save(one.id, two.currentRevision.id))).toEqual([
      404,
      'CS_NOT_FOUND',
    ]);
    expect(
      await status(() => save('not-a-uuid', one.currentRevision.id))
    ).toEqual([404, 'CS_NOT_FOUND']);
    expect(await status(() => save(one.id, 'system:story'))).toEqual([
      404,
      'CS_NOT_FOUND',
    ]);
    expect(state.contentStudioDesignTemplate).toHaveLength(0);
  });

  it('a stored design revision that fails its integrity check is not copied', async () => {
    const { templates, designs, state } = setup();
    const design = await createDesign(designs);
    state.contentStudioDesignRevision[0].content =
      state.contentStudioDesignRevision[0].content.replace('Spring', 'Autumn');
    expect(
      await status(() =>
        templates.saveDesignRevisionAsTemplate({
          organizationId: ORG,
          userId: USER,
          designId: design.id,
          revisionId: design.currentRevision.id,
          name: 'x',
          description: undefined,
        })
      )
    ).toEqual([500, 'CS_DESIGN_INTEGRITY_ERROR']);
    expect(state.contentStudioDesignTemplate).toHaveLength(0);
  });
});

// ============================================================================
describe('Design templates: source boundaries', () => {
  const SERVICE =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-template.service.ts';
  const REPOSITORY =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-template.repository.ts';
  const SYSTEM =
    'libraries/nestjs-libraries/src/content-studio/design/design.system.templates.ts';
  const DTO =
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design-template.dto.ts';
  const FILES = [SERVICE, REPOSITORY, SYSTEM, DTO];

  it('P411-1/P411-2/P411-3/P411-13 no Fabric, clipboard, browser storage, AI, environment, logging or fetch', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /fabric|toJSON\(|toObject\(|loadFromJSON|navigator|localStorage|sessionStorage|process\.env|console\.|Logger|\bfetch\(|safe\.fetch|safeFetch|openai|anthropic|@ai-sdk|ai\.execution|ai\.provider|AIWriting|generate\(/i
        ),
      ]);
    }
  });

  it('P411-7/P411-8/M15 using or saving a template renders nothing and reads no Media', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /render|layout|MediaService|RenderMediaBridge|readMedia|design-reference|DesignReference|sharp|fontkit/i
        ),
      ]);
    }
  });

  it('P411-9/M20 saving a design revision as a template takes no document from the request', () => {
    const service = code(SERVICE);
    const method = service.slice(
      service.indexOf('async saveDesignRevisionAsTemplate'),
      service.indexOf('async getTemplate')
    );
    expect(method).toContain('this._contentStudioDesignService.getRevision({');
    expect(method).toContain('revision.content');
    expect(method).not.toMatch(/input\.content/);
    const dto = code(DTO);
    const body = dto.slice(
      dto.indexOf('class SaveContentStudioDesignAsTemplateDto')
    );
    const fields =
      /^\s+(content|document|revisionId|designId|organizationId|userId)\??:/m;
    expect(body).toContain('name: string;');
    expect(body).not.toMatch(fields);
    const instantiate = dto.slice(
      dto.indexOf('class InstantiateContentStudioDesignTemplateDto'),
      dto.indexOf('class SaveContentStudioDesignAsTemplateDto')
    );
    expect(instantiate).toContain('templateId: string;');
    expect(instantiate).not.toMatch(
      /^\s+(content|document|organizationId|userId)\??:/m
    );
  });

  it('P411-10 every template document goes through the Design Document v1 checks of the design service', () => {
    const service = code(SERVICE);
    expect(service.match(/parseDocumentForOrganization\(/g)).toHaveLength(3);
    expect(service).toContain('storedContentStudioDesignDocument(');
    expect(service).toContain('parseVerifiedContentStudioDesignRevision(row)');
    expect(service).not.toMatch(/JSON\.stringify|sha256Hex|createHash/);
  });

  it('P411-11 no later or current Brand Kit revision is ever looked up', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /BrandKitRepository|getCurrentRevision|getLatestRevision|latestBrand|currentBrand/
        ),
      ]);
    }
  });

  it('P411-12/P411-14 no sharing, public, marketplace or seeded built-in rows', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(/marketplace|public|share|token\b|seed|upsert/i),
      ]);
    }
    const schema = read(
      'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
    );
    expect(schema).not.toMatch(
      /model ContentStudioDesignTemplate(Share|Public|Tag|Folder|Marketplace|Instance|Link)/
    );
    expect(schema).not.toMatch(/system:square-post/);
  });

  it('TR1/M30 the repository only ever creates revisions and deletes nothing', () => {
    const text = code(REPOSITORY);
    expect(text).not.toMatch(
      /contentStudioDesignTemplateRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(
      text.match(/contentStudioDesignTemplateRevision\.create\(/g)
    ).toHaveLength(2);
    expect(text.match(/organizationId/g)?.length).toBeGreaterThanOrEqual(20);
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(
      module.match(/ContentStudioDesignTemplateRepository\b/g)
    ).toHaveLength(2);
    expect(module.match(/ContentStudioDesignTemplateService\b/g)).toHaveLength(
      2
    );
  });
});

describe('ContentStudioDesignTemplate schema', () => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const model = (name: string) => {
    const match = schema.match(
      new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`)
    );
    return match ? match[1] : '';
  };

  it('TS1 a template row holds no document; its revisions are bound to a template of their own organization, numbered once', () => {
    const template = model('ContentStudioDesignTemplate');
    expect(template).not.toMatch(/\bcontent\b|contentHash|schemaVersion/);
    expect(template).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(template).toMatch(/@@index\(\[organizationId, archivedAt\]\)/);
    expect(template).toMatch(/description\s+String\?/);
    const revision = model('ContentStudioDesignTemplateRevision');
    expect(revision).toMatch(
      /@relation\(fields: \[templateId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(revision).toMatch(/@@unique\(\[templateId, revisionNumber\]\)/);
    expect(revision).toMatch(/content\s+String\n/);
    expect(revision).toMatch(/contentHash\s+String\n/);
    expect(revision).not.toMatch(/updatedAt|archivedAt|onDelete: Cascade/);
    // no link from a design to the template it came from
    expect(model('ContentStudioDesignProject')).not.toMatch(/template/i);
    expect(model('ContentStudioDesignRevision')).not.toMatch(/template/i);
  });
});
