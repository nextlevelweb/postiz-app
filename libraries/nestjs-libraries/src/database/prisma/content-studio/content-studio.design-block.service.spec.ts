import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignBlockRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-block.repository';
import { ContentStudioDesignBlockService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-block.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { storedContentStudioDesignBlock } from '@gitroom/nestjs-libraries/content-studio/design/design.block.stored';
import { storedContentStudioDesignLayoutPattern } from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern.stored';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the design reference service is a stand-in here
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// Design blocks (P4-18) over the real repository and service. No
// database: a small in-memory Prisma applies where clauses like Prisma
// (equality, not; undefined is no condition). The PostgreSQL constraints
// themselves are pinned in the schema section

const MARKER = 'DESIGN_BLOCK_PRIVATE_MARKER_321';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const T0 = new Date('2026-10-18T10:00:00.000Z');
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (file: string) => read(file).replace(/^\s*\/\/.*$/gm, '');

type Row = Record<string, any>;
const lit = (value: string) => ({ type: 'literal', value });
const box = {
  name: 'Layer',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
};
const CARD = {
  ...box,
  type: 'shape',
  shape: 'rectangle',
  fill: { type: 'brand', tokenId: 'primary' },
  cornerRadius: 8,
};
const TITLE = {
  ...box,
  y: 20,
  type: 'text',
  text: 'Hello',
  font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
  fontSize: 40,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: lit('#112233'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
};
const photo = (mediaId: string, sha256: string) => ({
  ...box,
  type: 'image',
  imageRef: { type: 'media', mediaId, sha256 },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
});
const BLOCK = {
  schemaVersion: 1,
  width: 200,
  height: 120,
  layers: [CARD, TITLE],
};
const WITH_PHOTO = {
  ...BLOCK,
  layers: [CARD, photo('media-1', SHA('a')), TITLE],
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

// the organization's ready Media and the SHA-256 of their bytes now
const MEDIA: Record<string, Record<string, string>> = {
  [ORG]: { 'media-1': SHA('a'), 'media-2': SHA('b') },
  [OTHER_ORG]: { 'media-9': SHA('c') },
};

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
  const references = {
    getMediaReference: jest.fn(
      async (organizationId: string, mediaId: string) => {
        const sha256 = MEDIA[organizationId]?.[mediaId];
        if (!sha256) {
          throw new HttpException(
            { msg: 'Not found.', code: 'CS_NOT_FOUND' },
            404
          );
        }
        return { mediaId, sha256 };
      }
    ),
  };
  const repository = new ContentStudioDesignBlockRepository({
    model: { contentStudioDesignBlock: delegate },
  } as unknown as PrismaRepository<'contentStudioDesignBlock'>);
  const blocks = new ContentStudioDesignBlockService(
    repository,
    references as unknown as ContentStudioDesignReferenceService
  );
  return { rows, delegate, references, blocks };
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
const create = (blocks: ContentStudioDesignBlockService, overrides: Row = {}) =>
  blocks.createBlock({
    organizationId: ORG,
    userId: USER,
    name: '  Title card  ',
    description: 'For covers',
    content: BLOCK,
    ...overrides,
  });

// ============================================================================
describe('Design blocks: catalog and writes', () => {
  it('creates a block with canonical content and its hash', async () => {
    const { blocks, rows } = setup();
    const created = await create(blocks);
    expect(created).toMatchObject({
      source: 'organization',
      name: 'Title card',
      description: 'For covers',
      archivedAt: null,
      content: BLOCK,
    });
    const stored = storedContentStudioDesignBlock(BLOCK as never);
    expect(rows[0]).toMatchObject({
      organizationId: ORG,
      createdById: USER,
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
      'name',
      'source',
      'updatedAt',
    ]);
  });

  it('lists one page of the organization’s blocks, active or archived; there are no built-ins', async () => {
    const { blocks } = setup();
    const one = await create(blocks);
    const two = await create(blocks, { name: 'Second' });
    const all = await blocks.listBlocks({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(all.system).toEqual([]);
    expect(all.results.map((p) => p.id).sort()).toEqual(
      [one.id, two.id].sort()
    );
    expect(all.pages).toBe(1);
    await blocks.archiveBlock(ORG, one.id);
    const active = await blocks.listBlocks({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(active.results.map((p) => p.id)).toEqual([two.id]);
    const archived = await blocks.listBlocks({
      organizationId: ORG,
      archived: true,
      page: 1,
    });
    expect(archived.system).toEqual([]);
    expect(archived.results.map((p) => p.id)).toEqual([one.id]);
  });

  it('DBSEC5/DBSEC6/DBP6/DBP7/DBP8/DBP9 invalid content, layer ids, a page, guidance, a bad name or a long description store nothing', async () => {
    const { blocks, rows } = setup();
    for (const content of [
      { ...BLOCK, layers: [{ ...CARD, id: 'l_1' }] },
      { ...BLOCK, layers: [{ ...TITLE, text: 1 }] },
      { ...BLOCK, layers: [] },
      { ...BLOCK, pages: [] },
      { ...BLOCK, guidance: { fields: [] } },
      { ...BLOCK, layers: [{ ...CARD, stylePresetId: 'p' }] },
      { ...BLOCK, designBlockId: 'b' },
      { ...BLOCK, templateId: 't' },
      { ...BLOCK, brandKit: null },
      { ...BLOCK, layers: [{ ...CARD, type: 'group', children: [] }] },
      { ...BLOCK, layers: [{ ...CARD, constraints: { left: 0 } }] },
      { schemaVersion: 1, brandKit: null, pages: [] },
      MARKER,
    ]) {
      expect(await status(() => create(blocks, { content }))).toEqual([
        400,
        'CS_DESIGN_BLOCK_INVALID',
      ]);
    }
    for (const overrides of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { description: 'd'.repeat(501) },
      { name: 'a\u0000b' },
    ]) {
      expect(await status(() => create(blocks, overrides))).toEqual([
        400,
        'CS_INVALID_REQUEST',
      ]);
    }
    expect(rows).toEqual([]);
  });

  it('DBP11 content larger than allowed is 413 and stores nothing', async () => {
    const { blocks, rows } = setup();
    const long = '€'.repeat(10_000);
    expect(
      await status(() =>
        create(blocks, {
          content: {
            ...BLOCK,
            layers: Array.from({ length: 20 }, () => ({
              ...TITLE,
              text: long,
            })),
          },
        })
      )
    ).toEqual([413, 'CS_DESIGN_BLOCK_TOO_LARGE']);
    expect(rows).toEqual([]);
  });

  it('a block changes in place: name, description and layers; later reads see it', async () => {
    const { blocks, rows } = setup();
    const created = await create(blocks);
    const content = { ...BLOCK, width: 300 };
    const updated = await blocks.updateBlock(ORG, created.id, {
      name: 'Wider',
      description: '',
      content,
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'Wider',
      description: null,
      content,
    });
    expect(updated.contentHash).not.toBe(created.contentHash);
    expect(rows).toHaveLength(1);
    expect(
      await status(() =>
        blocks.updateBlock(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
    expect(rows[0].content).toBe(
      storedContentStudioDesignBlock(content as never).content
    );
  });

  it('archive and restore are idempotent; an archived block is read-only', async () => {
    const { blocks } = setup();
    const created = await create(blocks);
    const archived = await blocks.archiveBlock(ORG, created.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await blocks.archiveBlock(ORG, created.id)).archivedAt).toEqual(
      archived.archivedAt
    );
    expect(
      await status(() =>
        blocks.updateBlock(ORG, created.id, {
          name: 'x',
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([409, 'CS_DESIGN_BLOCK_ARCHIVED']);
    expect((await blocks.restoreBlock(ORG, created.id)).archivedAt).toBeNull();
    expect((await blocks.restoreBlock(ORG, created.id)).archivedAt).toBeNull();
  });

  it('DBSEC9 stored content that no longer matches its hash is an integrity error, never repaired', async () => {
    const { blocks, rows } = setup();
    await create(blocks);
    rows[0].contentHash = '0'.repeat(64);
    expect(
      await status(() =>
        blocks.listBlocks({
          organizationId: ORG,
          archived: false,
          page: 1,
        })
      )
    ).toEqual([500, 'CS_DESIGN_BLOCK_INTEGRITY_ERROR']);
    expect(rows[0].contentHash).toBe('0'.repeat(64));
  });
});

// ============================================================================
describe('Design blocks: Media', () => {
  it('DBM1 an image of the organization’s ready Media with its exact SHA-256 is accepted', async () => {
    const { blocks, references } = setup();
    const created = await create(blocks, { content: WITH_PHOTO });
    expect(created.content.layers[1]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
    });
    expect(references.getMediaReference).toHaveBeenCalledWith(ORG, 'media-1');
  });

  it('DBM2/DBSEC7 another organization’s or a missing Media item is refused, and nothing is stored', async () => {
    const { blocks, rows } = setup();
    for (const mediaId of ['media-9', 'missing']) {
      expect(
        await status(() =>
          create(blocks, {
            content: { ...BLOCK, layers: [photo(mediaId, SHA('c'))] },
          })
        )
      ).toEqual([400, 'CS_DESIGN_BLOCK_MEDIA_INVALID']);
    }
    expect(rows).toEqual([]);
  });

  it('DBM3 other bytes than the Media item has now are refused', async () => {
    const { blocks, rows } = setup();
    expect(
      await status(() =>
        create(blocks, {
          content: { ...BLOCK, layers: [photo('media-1', SHA('b'))] },
        })
      )
    ).toEqual([400, 'CS_DESIGN_BLOCK_MEDIA_INVALID']);
    expect(rows).toEqual([]);
  });

  it('DBM-once each distinct Media item is read once; one item under two hashes is refused', async () => {
    const { blocks, references } = setup();
    await create(blocks, {
      content: {
        ...BLOCK,
        layers: [
          photo('media-1', SHA('a')),
          photo('media-1', SHA('a')),
          photo('media-2', SHA('b')),
        ],
      },
    });
    expect(references.getMediaReference.mock.calls.map(([, id]) => id)).toEqual(
      ['media-1', 'media-2']
    );
    expect(
      await status(() =>
        create(blocks, {
          content: {
            ...BLOCK,
            layers: [photo('media-1', SHA('a')), photo('media-1', SHA('b'))],
          },
        })
      )
    ).toEqual([400, 'CS_DESIGN_BLOCK_MEDIA_INVALID']);
  });

  it('DBM-update changed layers are checked again; a name change reads no Media', async () => {
    const { blocks, references, rows } = setup();
    const created = await create(blocks);
    expect(references.getMediaReference).not.toHaveBeenCalled();
    await blocks.updateBlock(ORG, created.id, {
      name: 'Renamed',
      description: undefined,
      content: undefined,
    });
    expect(references.getMediaReference).not.toHaveBeenCalled();
    const before = rows[0].content;
    expect(
      await status(() =>
        blocks.updateBlock(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: { ...BLOCK, layers: [photo('media-9', SHA('c'))] },
        })
      )
    ).toEqual([400, 'CS_DESIGN_BLOCK_MEDIA_INVALID']);
    expect(rows[0].content).toBe(before);
  });

  it('DBM-errors a failure other than a missing item is not hidden', async () => {
    const { blocks, references } = setup();
    references.getMediaReference.mockRejectedValueOnce(
      new HttpException(
        {
          msg: 'The media item could not be read safely.',
          code: 'CS_DESIGN_MEDIA_READ_FAILED',
        },
        500
      )
    );
    expect(await status(() => create(blocks, { content: WITH_PHOTO }))).toEqual(
      [500, 'CS_DESIGN_MEDIA_READ_FAILED']
    );
  });
});

// ============================================================================
describe('Design blocks: tenant isolation', () => {
  it('DBSEC1/DBSEC2/DBSEC3 another organization’s blocks are never listed, changed, archived or restored', async () => {
    const { blocks, rows } = setup();
    const created = await create(blocks);
    const theirs = await blocks.listBlocks({
      organizationId: OTHER_ORG,
      archived: false,
      page: 1,
    });
    expect(theirs.results).toEqual([]);
    expect(theirs.pages).toBe(0);
    const before = JSON.stringify(rows);
    for (const run of [
      () =>
        blocks.updateBlock(OTHER_ORG, created.id, {
          name: MARKER,
          description: undefined,
          content: undefined,
        }),
      () => blocks.archiveBlock(OTHER_ORG, created.id),
      () => blocks.restoreBlock(OTHER_ORG, created.id),
    ]) {
      expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('a "system:" id, or an id that cannot exist, reaches no row', async () => {
    const { blocks, delegate } = setup();
    for (const id of ['system:layout-title-body', 'not-a-uuid', '']) {
      for (const run of [
        () =>
          blocks.updateBlock(ORG, id, {
            name: 'x',
            description: undefined,
            content: undefined,
          }),
        () => blocks.archiveBlock(ORG, id),
        () => blocks.restoreBlock(ORG, id),
      ]) {
        expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
      }
    }
    expect(delegate.updateMany).not.toHaveBeenCalled();
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('every query names the organization; Media is read for the request organization', async () => {
    const { blocks, delegate, references } = setup();
    const created = await create(blocks, { content: WITH_PHOTO });
    await blocks.listBlocks({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    await blocks.updateBlock(ORG, created.id, {
      name: 'x',
      description: undefined,
      content: undefined,
    });
    await blocks.archiveBlock(ORG, created.id);
    await blocks.restoreBlock(ORG, created.id);
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
    for (const [organizationId] of references.getMediaReference.mock.calls) {
      expect(organizationId).toBe(ORG);
    }
  });
});

// ============================================================================
describe('Design blocks: source boundaries', () => {
  const SERVICE =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-block.service.ts';
  const REPOSITORY =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-block.repository.ts';
  const DTO =
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design-block.dto.ts';
  const PURE =
    'libraries/nestjs-libraries/src/content-studio/design/design.block.ts';
  const STORED =
    'libraries/nestjs-libraries/src/content-studio/design/design.block.stored.ts';
  const FILES = [SERVICE, REPOSITORY, DTO, PURE, STORED];
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const model = (name: string) =>
    schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

  it('P418-8/P418-9/P418-12/P418-13 no Fabric, render, fetch, AI, sharing or browser state', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /fabric|toJSON\(|loadFromJSON|render\(|readMedia|\bfetch\(|safeFetch|openai|anthropic|@ai-sdk|AIWriting|generate\(|marketplace|public|share|localStorage|process\.env/i
        ),
      ]);
    }
  });

  it('P418-10/P418-11 Media is checked only through the design reference service; no Brand Kit is looked up', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /MediaService|MediaRepository|RenderMediaBridge|BrandKitRepository|BrandKitService|getBrandKitReference|latest/i
        ),
      ]);
    }
    expect(code(SERVICE)).toContain('getMediaReference(');
  });

  it('P418-3/P418-4/P418-5 one mutable block table: no revisions, instances, links, library items, tags or folders', () => {
    const block = model('ContentStudioDesignBlock');
    expect(block).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block).toMatch(/@@index\(\[organizationId, archivedAt\]\)/);
    expect(block).toMatch(/@@index\(\[createdById\]\)/);
    expect(block).toMatch(/content\s+String\n/);
    expect(block).toMatch(/contentHash\s+String\n/);
    expect(block).not.toMatch(
      /onDelete: Cascade|template|design\w*Id|page|guidance|brandKit|tag|folder/i
    );
    expect(schema).not.toMatch(
      /model \w*(Block(Revision|Instance|Link|Tag|Folder|Share)|LibraryItem|Component|Symbol)\w* \{/
    );
    for (const name of [
      'ContentStudioDesignProject',
      'ContentStudioDesignRevision',
      'ContentStudioDesignTemplate',
      'ContentStudioDesignTemplateRevision',
      'ContentStudioDesignLayoutPattern',
    ]) {
      expect([name, model(name)]).not.toEqual([
        name,
        expect.stringMatching(/block/i),
      ]);
    }
    expect(code(REPOSITORY)).not.toMatch(
      /\.delete(Many)?\(|\.upsert\(|\$queryRaw|\$executeRaw/
    );
  });

  it('P418-1/P418-2/P418-6/P418-7 Design Document v1 knows nothing of blocks; a block is the layout pattern snapshot', () => {
    const document = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
    );
    expect(document).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(document).not.toMatch(
      /designBlock|blockId|componentId|symbolId|instance/i
    );
    const pure = code(PURE);
    expect(pure).toContain(
      'export const parseContentStudioDesignBlockContent =\n  parseContentStudioDesignLayoutPatternContent;'
    );
    expect(pure).not.toMatch(/stylePresetId|guidance|pageSetId|templateId/);
  });

  it('P418-15 a block is stored exactly as a layout pattern would be: the P4-15 format and hashes are unchanged', () => {
    const stored = storedContentStudioDesignBlock(BLOCK as never);
    expect(stored).toEqual(
      storedContentStudioDesignLayoutPattern(BLOCK as never)
    );
  });

  it('the DTOs take no organization, user, design, page, Brand Kit or hash field', () => {
    const dto = code(DTO);
    for (const name of [
      'CreateContentStudioDesignBlockDto',
      'UpdateContentStudioDesignBlockDto',
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
    expect(module.match(/ContentStudioDesignBlockRepository\b/g)).toHaveLength(
      2
    );
    expect(module.match(/ContentStudioDesignBlockService\b/g)).toHaveLength(2);
  });
});
