import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignStylePresetRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-style-preset.repository';
import { ContentStudioDesignStylePresetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-style-preset.service';
import { storedContentStudioDesignStylePreset } from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset.stored';
import { listContentStudioSystemDesignStylePresets } from '@gitroom/nestjs-libraries/content-studio/design/design.system.style.presets';

// Design style presets (P4-13) over the real repository and service. No
// database: a small in-memory Prisma applies where clauses like Prisma
// (equality, not; undefined is no condition). The PostgreSQL constraints
// themselves are pinned in the schema section

const MARKER = 'STYLE_PRESET_PRIVATE_MARKER_789';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const T0 = new Date('2026-10-18T10:00:00.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, '');

type Row = Record<string, any>;
const lit = (value: string) => ({ type: 'literal', value });
const TEXT = {
  schemaVersion: 1,
  kind: 'text',
  style: {
    font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
    fontSize: 64,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: lit('#112233'),
    align: 'left',
    verticalAlign: 'top',
    opacity: 1,
  },
};
const SHAPE = {
  schemaVersion: 1,
  kind: 'shape',
  style: {
    fill: { type: 'brand', tokenId: 'primary' },
    cornerRadius: 8,
    opacity: 0.5,
  },
};

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
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
  const rows: Row[] = [];
  let clock = 0;
  const delegate = {
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = rows.find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
    findMany: jest.fn(
      async (args: {
        where: Row;
        select?: Row;
        skip?: number;
        take?: number;
      }) =>
        rows
          .filter((r) => matches(r, args.where))
          .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1000))
          .map((r) => pick(r, args.select))
    ),
    count: jest.fn(
      async (args: { where: Row }) =>
        rows.filter((r) => matches(r, args.where)).length
    ),
    create: jest.fn(async (args: { data: Row; select?: Row }) => {
      const at = new Date(T0.getTime() + ++clock * 1000);
      const row = {
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        ...args.data,
      };
      rows.push(row);
      return pick(row, args.select);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const found = rows.filter((r) => matches(r, args.where));
      for (const row of found) {
        Object.assign(row, args.data, {
          updatedAt: new Date(T0.getTime() + ++clock * 1000),
        });
      }
      return { count: found.length };
    }),
    update: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const repository = new ContentStudioDesignStylePresetRepository({
    model: { contentStudioDesignStylePreset: delegate },
  } as unknown as PrismaRepository<'contentStudioDesignStylePreset'>);
  const presets = new ContentStudioDesignStylePresetService(repository);
  return { rows, delegate, presets };
};

const status = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const response = (err as HttpException).getResponse() as Row;
    expect(inspect(response)).not.toContain(MARKER);
    return [(err as HttpException).getStatus(), response.code];
  }
  throw new Error('expected an HttpException');
};
const create = (
  presets: ContentStudioDesignStylePresetService,
  overrides: Row = {}
) =>
  presets.createPreset({
    organizationId: ORG,
    userId: USER,
    name: '  Brand heading  ',
    description: 'For titles',
    content: TEXT,
    ...overrides,
  });

// ============================================================================
describe('Design style presets: catalog and writes', () => {
  it('creates a preset with canonical content and its hash, kind from the content', async () => {
    const { presets, rows } = setup();
    const created = await create(presets);
    expect(created).toMatchObject({
      source: 'organization',
      name: 'Brand heading',
      description: 'For titles',
      kind: 'text',
      archivedAt: null,
      content: TEXT,
    });
    const stored = storedContentStudioDesignStylePreset(TEXT as never);
    expect(rows[0]).toMatchObject({
      organizationId: ORG,
      createdById: USER,
      kind: 'text',
      schemaVersion: 1,
      content: stored.content,
      contentHash: stored.contentHash,
    });
    expect(Object.keys(created).sort()).toEqual([
      'archivedAt',
      'content',
      'contentHash',
      'createdAt',
      'description',
      'id',
      'kind',
      'name',
      'source',
      'updatedAt',
    ]);
  });

  it('lists built-ins (by kind) and one page of the organization’s, active or archived', async () => {
    const { presets } = setup();
    const text = await create(presets);
    const shape = await create(presets, { name: 'Panel', content: SHAPE });
    const all = await presets.listPresets({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(all.system.map((p) => p.id)).toEqual(
      listContentStudioSystemDesignStylePresets().map((p) => p.id)
    );
    expect(all.results.map((p) => p.id).sort()).toEqual(
      [text.id, shape.id].sort()
    );
    const shapes = await presets.listPresets({
      organizationId: ORG,
      kind: 'shape',
      archived: false,
      page: 1,
    });
    expect(shapes.system.every((p) => p.kind === 'shape')).toBe(true);
    expect(shapes.results.map((p) => p.id)).toEqual([shape.id]);
    await presets.archivePreset(ORG, text.id);
    const active = await presets.listPresets({
      organizationId: ORG,
      kind: 'text',
      archived: false,
      page: 1,
    });
    expect(active.results).toEqual([]);
    const archived = await presets.listPresets({
      organizationId: ORG,
      kind: 'text',
      archived: true,
      page: 1,
    });
    expect(archived.system).toEqual([]);
    expect(archived.results.map((p) => p.id)).toEqual([text.id]);
    expect(
      await status(() =>
        presets.listPresets({
          organizationId: ORG,
          kind: 'image',
          archived: false,
          page: 1,
        })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
  });

  it('PSEC6/PSEC7/PSEC8 invalid content, smuggled layer fields, a bad name or a long description store nothing', async () => {
    const { presets, rows } = setup();
    for (const content of [
      { ...TEXT, style: { ...TEXT.style, x: 0 } },
      { ...TEXT, style: { ...TEXT.style, text: MARKER } },
      { ...TEXT, style: { ...TEXT.style, id: 'l1', pageId: 'p1' } },
      {
        ...SHAPE,
        style: {
          ...SHAPE.style,
          imageRef: { type: 'media', mediaId: 'm', sha256: 'a'.repeat(64) },
        },
      },
      { ...SHAPE, kind: 'image' },
      { schemaVersion: 1, brandKit: null, pages: [] },
      MARKER,
    ]) {
      expect(await status(() => create(presets, { content }))).toEqual([
        400,
        'CS_DESIGN_STYLE_PRESET_INVALID',
      ]);
    }
    for (const overrides of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { description: 'd'.repeat(501) },
      { name: 'a\u0000b' },
    ]) {
      expect(await status(() => create(presets, overrides))).toEqual([
        400,
        'CS_INVALID_REQUEST',
      ]);
    }
    expect(rows).toEqual([]);
  });

  it('a preset changes in place: name, description and style of its own kind; later reads see it', async () => {
    const { presets, rows } = setup();
    const created = await create(presets);
    const style = { ...TEXT.style, fontSize: 72 };
    const updated = await presets.updatePreset(ORG, created.id, {
      name: 'Bigger',
      description: '',
      content: { ...TEXT, style },
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'Bigger',
      description: null,
      content: { ...TEXT, style },
    });
    expect(updated.contentHash).not.toBe(created.contentHash);
    expect(rows).toHaveLength(1);
    expect(
      await status(() =>
        presets.updatePreset(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: SHAPE,
        })
      )
    ).toEqual([400, 'CS_DESIGN_STYLE_PRESET_KIND_MISMATCH']);
    expect(
      await status(() =>
        presets.updatePreset(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
    expect(rows[0].content).toBe(
      storedContentStudioDesignStylePreset({ ...TEXT, style } as never).content
    );
  });

  it('archive and restore are idempotent; an archived preset is read-only', async () => {
    const { presets } = setup();
    const created = await create(presets);
    const archived = await presets.archivePreset(ORG, created.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await presets.archivePreset(ORG, created.id)).archivedAt).toEqual(
      archived.archivedAt
    );
    expect(
      await status(() =>
        presets.updatePreset(ORG, created.id, {
          name: 'x',
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([409, 'CS_DESIGN_STYLE_PRESET_ARCHIVED']);
    expect(
      (await presets.restorePreset(ORG, created.id)).archivedAt
    ).toBeNull();
    expect(
      (await presets.restorePreset(ORG, created.id)).archivedAt
    ).toBeNull();
  });

  it('stored content that no longer matches its hash or kind is an integrity error, never repaired', async () => {
    const { presets, rows } = setup();
    await create(presets);
    rows[0].contentHash = '0'.repeat(64);
    expect(
      await status(() =>
        presets.listPresets({ organizationId: ORG, archived: false, page: 1 })
      )
    ).toEqual([500, 'CS_DESIGN_STYLE_PRESET_INTEGRITY_ERROR']);
  });
});

// ============================================================================
describe('Design style presets: tenant isolation', () => {
  it('PSEC1/M17 another organization’s presets are never listed', async () => {
    const { presets } = setup();
    await create(presets);
    const theirs = await presets.listPresets({
      organizationId: OTHER_ORG,
      archived: false,
      page: 1,
    });
    expect(theirs.results).toEqual([]);
    expect(theirs.pages).toBe(0);
  });

  it('PSEC2/PSEC3 another organization’s preset cannot be changed, archived or restored', async () => {
    const { presets, rows } = setup();
    const created = await create(presets);
    const before = JSON.stringify(rows);
    for (const run of [
      () =>
        presets.updatePreset(OTHER_ORG, created.id, {
          name: MARKER,
          description: undefined,
          content: undefined,
        }),
      () => presets.archivePreset(OTHER_ORG, created.id),
      () => presets.restorePreset(OTHER_ORG, created.id),
    ]) {
      expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('PSEC4/M18 a built-in id, or an id that cannot exist, reaches no row', async () => {
    const { presets, delegate } = setup();
    for (const id of ['system:text-heading-bold', 'not-a-uuid', '']) {
      for (const run of [
        () =>
          presets.updatePreset(ORG, id, {
            name: 'x',
            description: undefined,
            content: undefined,
          }),
        () => presets.archivePreset(ORG, id),
        () => presets.restorePreset(ORG, id),
      ]) {
        expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
      }
    }
    expect(delegate.updateMany).not.toHaveBeenCalled();
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('every query names the organization', async () => {
    const { presets, delegate } = setup();
    const created = await create(presets);
    await presets.listPresets({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    await presets.updatePreset(ORG, created.id, {
      name: 'x',
      description: undefined,
      content: undefined,
    });
    await presets.archivePreset(ORG, created.id);
    await presets.restorePreset(ORG, created.id);
    for (const method of [
      'findFirst',
      'findMany',
      'count',
      'updateMany',
    ] as const) {
      expect(delegate[method]).toHaveBeenCalled();
      for (const [args] of delegate[method].mock.calls) {
        expect((args as Row).where.organizationId).toBe(ORG);
      }
    }
  });
});

// ============================================================================
describe('Design style presets: source boundaries', () => {
  const SERVICE =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-style-preset.service.ts';
  const REPOSITORY =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-style-preset.repository.ts';
  const DTO =
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design-style-preset.dto.ts';
  const PURE =
    'libraries/nestjs-libraries/src/content-studio/design/design.style.preset.ts';
  const STORED =
    'libraries/nestjs-libraries/src/content-studio/design/design.style.preset.stored.ts';
  const SYSTEM =
    'libraries/nestjs-libraries/src/content-studio/design/design.system.style.presets.ts';
  const FILES = [SERVICE, REPOSITORY, DTO, PURE, STORED, SYSTEM];
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const model = (name: string) =>
    schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

  it('P413-6/P413-7/P413-8/P413-11/P413-12 no Fabric, render, Media, fetch, AI, sharing or browser state', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /fabric|toJSON\(|loadFromJSON|render|MediaService|readMedia|\bfetch\(|safeFetch|openai|anthropic|@ai-sdk|AIWriting|generate\(|marketplace|public|share|localStorage|process\.env/i
        ),
      ]);
    }
  });

  it('P413-9 no Brand Kit is looked up: a preset names tokens, the editor checks them against the design’s exact revision', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /BrandKitRepository|BrandKitService|getLatestRevision|getCurrentRevision|latest/i
        ),
      ]);
    }
  });

  it('P413-4/P413-5/P413-13 one mutable preset table: no revisions, instances, links, tags or seeded built-ins', () => {
    const preset = model('ContentStudioDesignStylePreset');
    expect(preset).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(preset).toMatch(/@@index\(\[organizationId, kind, archivedAt\]\)/);
    expect(preset).toMatch(/content\s+String\n/);
    expect(preset).toMatch(/contentHash\s+String\n/);
    expect(preset).not.toMatch(/onDelete: Cascade|template|design\w*Id/i);
    expect(schema).not.toMatch(
      /model ContentStudioDesignStylePreset(Revision|Instance|Link|Tag|Folder|Share)\b/
    );
    for (const name of [
      'ContentStudioDesignProject',
      'ContentStudioDesignRevision',
      'ContentStudioDesignTemplate',
      'ContentStudioDesignTemplateRevision',
    ]) {
      expect([name, model(name)]).not.toEqual([
        name,
        expect.stringMatching(/preset/i),
      ]);
    }
    expect(schema).not.toMatch(/system:text-heading-bold/);
    expect(code(REPOSITORY)).not.toMatch(
      /\.delete(Many)?\(|\.upsert\(|\$queryRaw|\$executeRaw/
    );
  });

  it('P413-1/P413-2/P413-3 Design Document v1 and template guidance know nothing of presets', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts',
      'libraries/nestjs-libraries/src/content-studio/design/design.template.guidance.ts',
      'libraries/nestjs-libraries/src/content-studio/design/design.system.templates.ts',
    ]) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /preset|linkedStyle|inheritedStyle|componentRef|symbolRef/i
        ),
      ]);
    }
    expect(
      code(
        'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      )
    ).toContain('export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;');
  });

  it('P413-10 the design revision body is still exactly a base revision number and a document', () => {
    const dto = code(
      'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design.dto.ts'
    );
    const body = dto.slice(
      dto.indexOf('class CreateContentStudioDesignRevisionDto'),
      dto.indexOf('class ListContentStudioDesignRevisionsDto')
    );
    expect(body.match(/^\s+(\w+)\??:/gm)?.map((line) => line.trim())).toEqual([
      'baseRevisionNumber:',
      'content:',
    ]);
  });

  it('the DTOs take no organization, user, layer, design, kind or hash field', () => {
    const dto = code(DTO);
    for (const name of [
      'CreateContentStudioDesignStylePresetDto',
      'UpdateContentStudioDesignStylePresetDto',
    ]) {
      const start = dto.indexOf(`class ${name}`);
      const body = dto.slice(start, dto.indexOf('\n}', start));
      expect(body.match(/^\s+(\w+)\??:/gm)?.map((line) => line.trim())).toEqual(
        [
          name.startsWith('Create') ? 'name:' : 'name?:',
          'description?:',
          name.startsWith('Create') ? 'content:' : 'content?:',
        ]
      );
    }
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(
      module.match(/ContentStudioDesignStylePresetRepository\b/g)
    ).toHaveLength(2);
    expect(
      module.match(/ContentStudioDesignStylePresetService\b/g)
    ).toHaveLength(2);
  });
});
