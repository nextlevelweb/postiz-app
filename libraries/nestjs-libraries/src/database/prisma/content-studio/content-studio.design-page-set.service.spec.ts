import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignPageSetRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.repository';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { storedContentStudioDesignPageSet } from '@gitroom/nestjs-libraries/content-studio/design/design.page.set.stored';
import { listContentStudioSystemDesignPageSets } from '@gitroom/nestjs-libraries/content-studio/design/design.system.page.sets';

// The real MediaService pulls in uploads, Redis and Temporal at import time
// (through the design service's imports); the design service is a stand-in
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// Design page sets (P4-17) over the real repository and service. No
// database: a small in-memory Prisma applies where clauses like Prisma
// (equality, not; undefined is no condition). The PostgreSQL constraints
// themselves are pinned in the schema section

const MARKER = 'PAGE_SET_PRIVATE_MARKER_321';
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
const PAGE_SET = {
  schemaVersion: 1,
  pages: [
    { name: 'Square', width: 1080, height: 1080 },
    {
      name: 'Story',
      width: 1080,
      height: 1920,
      background: { type: 'solid', color: lit('#112233') },
    },
  ],
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
  const designs = {
    createDesign: jest.fn(async (input: Row) => ({
      id: 'design-1',
      name: input.name,
      currentRevision: { revisionNumber: 1, content: input.content },
    })),
  };
  const repository = new ContentStudioDesignPageSetRepository({
    model: { contentStudioDesignPageSet: delegate },
  } as unknown as PrismaRepository<'contentStudioDesignPageSet'>);
  const pageSets = new ContentStudioDesignPageSetService(
    repository,
    designs as unknown as ContentStudioDesignService
  );
  return { rows, delegate, designs, pageSets };
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
  pageSets: ContentStudioDesignPageSetService,
  overrides: Row = {}
) =>
  pageSets.createPageSet({
    organizationId: ORG,
    userId: USER,
    name: '  Social pair  ',
    description: 'For launches',
    content: PAGE_SET,
    ...overrides,
  });

// ============================================================================
describe('Design page sets: catalog and writes', () => {
  it('creates a page set with canonical content and its hash', async () => {
    const { pageSets, rows } = setup();
    const created = await create(pageSets);
    expect(created).toMatchObject({
      source: 'organization',
      name: 'Social pair',
      description: 'For launches',
      pageCount: 2,
      archivedAt: null,
      content: PAGE_SET,
    });
    const stored = storedContentStudioDesignPageSet(PAGE_SET as never);
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
      'pageCount',
      'source',
      'updatedAt',
    ]);
  });

  it('lists the built-ins and one page of the organization’s, active or archived', async () => {
    const { pageSets } = setup();
    const one = await create(pageSets);
    const two = await create(pageSets, { name: 'Second' });
    const all = await pageSets.listPageSets({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(all.system.map((p) => [p.id, p.source, p.pageCount])).toEqual(
      listContentStudioSystemDesignPageSets().map((p) => [
        p.id,
        'system',
        p.content.pages.length,
      ])
    );
    expect(all.results.map((p) => p.id).sort()).toEqual(
      [one.id, two.id].sort()
    );
    await pageSets.archivePageSet(ORG, one.id);
    const active = await pageSets.listPageSets({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(active.results.map((p) => p.id)).toEqual([two.id]);
    const archived = await pageSets.listPageSets({
      organizationId: ORG,
      archived: true,
      page: 1,
    });
    expect(archived.system).toEqual([]);
    expect(archived.results.map((p) => p.id)).toEqual([one.id]);
  });

  it('PSSEC6/PSSEC7/PSSEC8 page ids, layers, Brand or Media in the content, a bad name or a long description store nothing', async () => {
    const { pageSets, rows } = setup();
    const square = PAGE_SET.pages[0];
    for (const content of [
      { ...PAGE_SET, pages: [{ ...square, id: 'p_1' }] },
      { ...PAGE_SET, pages: [{ ...square, layers: [] }] },
      {
        ...PAGE_SET,
        pages: [
          {
            ...square,
            background: {
              type: 'solid',
              color: { type: 'brand', tokenId: 'primary' },
            },
          },
        ],
      },
      {
        ...PAGE_SET,
        pages: [
          {
            ...square,
            imageRef: { type: 'media', mediaId: 'm', sha256: 'a'.repeat(64) },
          },
        ],
      },
      { ...PAGE_SET, brandKit: null },
      { ...PAGE_SET, pages: [] },
      {
        schemaVersion: 1,
        brandKit: null,
        pages: [{ ...square, id: 'p', layers: [] }],
      },
      MARKER,
    ]) {
      expect(await status(() => create(pageSets, { content }))).toEqual([
        400,
        'CS_DESIGN_PAGE_SET_INVALID',
      ]);
    }
    for (const overrides of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { description: 'd'.repeat(501) },
      { name: 'a\u0000b' },
    ]) {
      expect(await status(() => create(pageSets, overrides))).toEqual([
        400,
        'CS_INVALID_REQUEST',
      ]);
    }
    expect(rows).toEqual([]);
  });

  it('a page set changes in place; an archived one is read-only; archive and restore are idempotent', async () => {
    const { pageSets, rows } = setup();
    const created = await create(pageSets);
    const content = { ...PAGE_SET, pages: [PAGE_SET.pages[0]] };
    const updated = await pageSets.updatePageSet(ORG, created.id, {
      name: 'Square only',
      description: '',
      content,
    });
    expect(updated).toMatchObject({
      name: 'Square only',
      description: null,
      pageCount: 1,
      content,
    });
    expect(rows).toHaveLength(1);
    expect(
      await status(() =>
        pageSets.updatePageSet(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
    const archived = await pageSets.archivePageSet(ORG, created.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await pageSets.archivePageSet(ORG, created.id)).archivedAt).toEqual(
      archived.archivedAt
    );
    expect(
      await status(() =>
        pageSets.updatePageSet(ORG, created.id, {
          name: 'x',
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([409, 'CS_DESIGN_PAGE_SET_ARCHIVED']);
    expect(
      (await pageSets.restorePageSet(ORG, created.id)).archivedAt
    ).toBeNull();
    expect(
      (await pageSets.restorePageSet(ORG, created.id)).archivedAt
    ).toBeNull();
  });

  it('PSSEC10 stored content that no longer matches its hash is an integrity error, never repaired', async () => {
    const { pageSets, rows } = setup();
    await create(pageSets);
    rows[0].contentHash = '0'.repeat(64);
    expect(
      await status(() =>
        pageSets.listPageSets({ organizationId: ORG, archived: false, page: 1 })
      )
    ).toEqual([500, 'CS_DESIGN_PAGE_SET_INTEGRITY_ERROR']);
    expect(rows[0].contentHash).toBe('0'.repeat(64));
  });
});

// ============================================================================
describe('Design page sets: a new design from a page set', () => {
  const start = (
    pageSets: ContentStudioDesignPageSetService,
    overrides: Row = {}
  ) =>
    pageSets.createDesignFromPageSet({
      organizationId: ORG,
      userId: USER,
      name: 'Launch',
      pageSetId: 'system:page-set-social-core',
      content: undefined,
      ...overrides,
    });
  const sent = (designs: { createDesign: jest.Mock }) =>
    designs.createDesign.mock.calls[
      designs.createDesign.mock.calls.length - 1
    ][0];

  it('PC1/PC7/PC8 a built-in makes an ordinary Design Document v1 with its pages in order, blank, new ids, nothing of the page set', async () => {
    const { pageSets, designs, delegate } = setup();
    await start(pageSets);
    const input = sent(designs);
    expect(Object.keys(input).sort()).toEqual([
      'content',
      'name',
      'organizationId',
      'userId',
    ]);
    expect(input).toMatchObject({
      organizationId: ORG,
      userId: USER,
      name: 'Launch',
    });
    const document = input.content;
    expect(parseContentStudioDesignDocument(document)).toEqual(document);
    expect(document.brandKit).toBeNull();
    expect(
      document.pages.map((p: Row) => [p.name, p.width, p.height, p.layers])
    ).toEqual([
      ['Square', 1080, 1080, []],
      ['Portrait', 1080, 1350, []],
      ['Story', 1080, 1920, []],
    ]);
    const ids = document.pages.map((p: Row) => p.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^p_[0-9a-f]{20}$/);
    }
    expect(JSON.stringify(document)).not.toMatch(
      /system:|pageSet|page-set|campaign/i
    );
    // a built-in reads no row
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('PC2 an active page set of the organization makes exactly its structure', async () => {
    const { pageSets, designs } = setup();
    const created = await create(pageSets);
    await start(pageSets, { pageSetId: created.id });
    expect(
      sent(designs).content.pages.map((p: Row) => [
        p.name,
        p.width,
        p.height,
        p.background,
      ])
    ).toEqual([
      ['Square', 1080, 1080, { type: 'solid', color: lit('#ffffff') }],
      ['Story', 1080, 1920, { type: 'solid', color: lit('#112233') }],
    ]);
  });

  it('PC3/PSSEC11 another organization’s page set, an unknown built-in or an impossible id is a plain 404', async () => {
    const { pageSets, designs } = setup();
    const created = await create(pageSets);
    for (const overrides of [
      { organizationId: OTHER_ORG, pageSetId: created.id },
      { pageSetId: 'system:page-set-nope' },
      { pageSetId: 'not-a-uuid' },
    ]) {
      expect(await status(() => start(pageSets, overrides))).toEqual([
        404,
        'CS_NOT_FOUND',
      ]);
    }
    expect(designs.createDesign).not.toHaveBeenCalled();
  });

  it('PC4/PSSEC9 an archived page set is not used', async () => {
    const { pageSets, designs } = setup();
    const created = await create(pageSets);
    await pageSets.archivePageSet(ORG, created.id);
    expect(
      await status(() => start(pageSets, { pageSetId: created.id }))
    ).toEqual([409, 'CS_DESIGN_PAGE_SET_ARCHIVED']);
    expect(designs.createDesign).not.toHaveBeenCalled();
  });

  it('PC5 a corrupt page set is not used', async () => {
    const { pageSets, designs, rows } = setup();
    const created = await create(pageSets);
    rows[0].content = rows[0].content.replace('1920', '1921');
    expect(
      await status(() => start(pageSets, { pageSetId: created.id }))
    ).toEqual([500, 'CS_DESIGN_PAGE_SET_INTEGRITY_ERROR']);
    expect(designs.createDesign).not.toHaveBeenCalled();
  });

  it('PC6 pages sent along with a page set, or no page set id, are refused', async () => {
    const { pageSets, designs } = setup();
    for (const overrides of [
      { content: { schemaVersion: 1, brandKit: null, pages: [] } },
      { content: null },
      { pageSetId: undefined },
      { pageSetId: 7 },
    ]) {
      expect(await status(() => start(pageSets, overrides))).toEqual([
        400,
        'CS_INVALID_REQUEST',
      ]);
    }
    expect(designs.createDesign).not.toHaveBeenCalled();
  });
});

// ============================================================================
describe('Design page sets: tenant isolation', () => {
  it('PSSEC1/PSSEC2/PSSEC3 another organization’s page sets are never listed, changed, archived or restored', async () => {
    const { pageSets, rows } = setup();
    const created = await create(pageSets);
    const theirs = await pageSets.listPageSets({
      organizationId: OTHER_ORG,
      archived: false,
      page: 1,
    });
    expect(theirs.results).toEqual([]);
    expect(theirs.pages).toBe(0);
    const before = JSON.stringify(rows);
    for (const run of [
      () =>
        pageSets.updatePageSet(OTHER_ORG, created.id, {
          name: MARKER,
          description: undefined,
          content: undefined,
        }),
      () => pageSets.archivePageSet(OTHER_ORG, created.id),
      () => pageSets.restorePageSet(OTHER_ORG, created.id),
    ]) {
      expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('PSSEC4/PSSEC12 a built-in id, or an id that cannot exist, reaches no row', async () => {
    const { pageSets, delegate } = setup();
    for (const id of ['system:page-set-social-core', 'not-a-uuid', '']) {
      for (const run of [
        () =>
          pageSets.updatePageSet(ORG, id, {
            name: 'x',
            description: undefined,
            content: undefined,
          }),
        () => pageSets.archivePageSet(ORG, id),
        () => pageSets.restorePageSet(ORG, id),
      ]) {
        expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
      }
    }
    expect(delegate.updateMany).not.toHaveBeenCalled();
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('every query names the organization', async () => {
    const { pageSets, delegate } = setup();
    const created = await create(pageSets);
    await pageSets.listPageSets({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    await pageSets.updatePageSet(ORG, created.id, {
      name: 'x',
      description: undefined,
      content: undefined,
    });
    await pageSets.archivePageSet(ORG, created.id);
    await pageSets.restorePageSet(ORG, created.id);
    await pageSets.createDesignFromPageSet({
      organizationId: ORG,
      userId: USER,
      name: 'D',
      pageSetId: created.id,
      content: undefined,
    });
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
describe('Design page sets: source boundaries', () => {
  const SERVICE =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-page-set.service.ts';
  const REPOSITORY =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-page-set.repository.ts';
  const DTO =
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design-page-set.dto.ts';
  const PURE =
    'libraries/nestjs-libraries/src/content-studio/design/design.page.set.ts';
  const STORED =
    'libraries/nestjs-libraries/src/content-studio/design/design.page.set.stored.ts';
  const SYSTEM =
    'libraries/nestjs-libraries/src/content-studio/design/design.system.page.sets.ts';
  const FILES = [SERVICE, REPOSITORY, DTO, PURE, STORED, SYSTEM];
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const model = (name: string) =>
    schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

  it('P417-10/P417-11/P417-12 no Fabric, render, Media, fetch, AI, sharing or browser state', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /fabric|toJSON\(|loadFromJSON|render|MediaService|readMedia|getMediaReference|\bfetch\(|safeFetch|openai|anthropic|@ai-sdk|AIWriting|generate\(|marketplace|public|share|localStorage|process\.env/i
        ),
      ]);
    }
  });

  it('no Brand Kit is looked up: a page set is Brand-neutral', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /BrandKitRepository|BrandKitService|getBrandKitReference|latest/i
        ),
      ]);
    }
  });

  it('P417-3/P417-4/P417-5 one mutable page set table: no revisions, instances, links, campaigns or seeded built-ins', () => {
    const pageSet = model('ContentStudioDesignPageSet');
    expect(pageSet).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(pageSet).toMatch(/@@index\(\[organizationId, archivedAt\]\)/);
    expect(pageSet).toMatch(/@@index\(\[createdById\]\)/);
    expect(pageSet).toMatch(/content\s+String\n/);
    expect(pageSet).toMatch(/contentHash\s+String\n/);
    expect(pageSet).not.toMatch(
      /onDelete: Cascade|template|design\w*Id|guidance|brandKit|campaign/i
    );
    expect(schema).not.toMatch(
      /model \w*(PageSet(Revision|Instance|Link|Tag|Folder|Share)|Campaign)\w* \{/
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
        expect.stringMatching(/pageSet|page_set/i),
      ]);
    }
    expect(schema).not.toMatch(/system:page-set/);
    expect(code(REPOSITORY)).not.toMatch(
      /\.delete(Many)?\(|\.upsert\(|\$queryRaw|\$executeRaw/
    );
  });

  it('P417-1/P417-2/P417-9 Design Document v1 and the design revision body know nothing of page sets', () => {
    const document = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
    );
    expect(document).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(document).not.toMatch(
      /pageSet|page_set|campaign|responsive|breakpoint/i
    );
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
    const create = dto.slice(
      dto.indexOf('class CreateContentStudioDesignDto'),
      dto.indexOf('class UpdateContentStudioDesignDto')
    );
    expect(create.match(/^\s+(\w+)\??:/gm)?.map((line) => line.trim())).toEqual(
      ['name:', 'content?:', 'pageSetId?:']
    );
  });

  it('the DTOs take no organization, user, design, page id, layer or hash field', () => {
    const dto = code(DTO);
    for (const name of [
      'CreateContentStudioDesignPageSetDto',
      'UpdateContentStudioDesignPageSetDto',
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
      module.match(/ContentStudioDesignPageSetRepository\b/g)
    ).toHaveLength(2);
    expect(module.match(/ContentStudioDesignPageSetService\b/g)).toHaveLength(
      2
    );
  });
});
