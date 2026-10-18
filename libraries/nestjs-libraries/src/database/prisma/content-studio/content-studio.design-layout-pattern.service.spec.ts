import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { HttpException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignLayoutPatternRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-layout-pattern.repository';
import { ContentStudioDesignLayoutPatternService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-layout-pattern.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { storedContentStudioDesignLayoutPattern } from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern.stored';
import { listContentStudioSystemDesignLayoutPatterns } from '@gitroom/nestjs-libraries/content-studio/design/design.system.layout.patterns';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the design reference service is a stand-in here
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// Design layout patterns (P4-15) over the real repository and service. No
// database: a small in-memory Prisma applies where clauses like Prisma
// (equality, not; undefined is no condition). The PostgreSQL constraints
// themselves are pinned in the schema section

const MARKER = 'LAYOUT_PATTERN_PRIVATE_MARKER_321';
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
const PATTERN = {
  schemaVersion: 1,
  width: 200,
  height: 120,
  layers: [CARD, TITLE],
};
const WITH_PHOTO = {
  ...PATTERN,
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
  const repository = new ContentStudioDesignLayoutPatternRepository({
    model: { contentStudioDesignLayoutPattern: delegate },
  } as unknown as PrismaRepository<'contentStudioDesignLayoutPattern'>);
  const patterns = new ContentStudioDesignLayoutPatternService(
    repository,
    references as unknown as ContentStudioDesignReferenceService
  );
  return { rows, delegate, references, patterns };
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
  patterns: ContentStudioDesignLayoutPatternService,
  overrides: Row = {}
) =>
  patterns.createPattern({
    organizationId: ORG,
    userId: USER,
    name: '  Title card  ',
    description: 'For covers',
    content: PATTERN,
    ...overrides,
  });

// ============================================================================
describe('Design layout patterns: catalog and writes', () => {
  it('creates a pattern with canonical content and its hash', async () => {
    const { patterns, rows } = setup();
    const created = await create(patterns);
    expect(created).toMatchObject({
      source: 'organization',
      name: 'Title card',
      description: 'For covers',
      archivedAt: null,
      content: PATTERN,
    });
    const stored = storedContentStudioDesignLayoutPattern(PATTERN as never);
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

  it('lists the built-ins and one page of the organization’s, active or archived', async () => {
    const { patterns } = setup();
    const one = await create(patterns);
    const two = await create(patterns, { name: 'Second' });
    const all = await patterns.listPatterns({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(all.system.map((p) => p.id)).toEqual(
      listContentStudioSystemDesignLayoutPatterns().map((p) => p.id)
    );
    expect(all.system.every((p) => p.source === 'system')).toBe(true);
    expect(all.results.map((p) => p.id).sort()).toEqual(
      [one.id, two.id].sort()
    );
    expect(all.pages).toBe(1);
    await patterns.archivePattern(ORG, one.id);
    const active = await patterns.listPatterns({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(active.results.map((p) => p.id)).toEqual([two.id]);
    const archived = await patterns.listPatterns({
      organizationId: ORG,
      archived: true,
      page: 1,
    });
    expect(archived.system).toEqual([]);
    expect(archived.results.map((p) => p.id)).toEqual([one.id]);
  });

  it('LSEC7 invalid content, layer ids, a page, guidance, a bad name or a long description store nothing', async () => {
    const { patterns, rows } = setup();
    for (const content of [
      { ...PATTERN, layers: [{ ...CARD, id: 'l_1' }] },
      { ...PATTERN, layers: [{ ...TITLE, text: 1 }] },
      { ...PATTERN, layers: [] },
      { ...PATTERN, pages: [] },
      { ...PATTERN, guidance: { fields: [] } },
      { ...PATTERN, brandKit: null },
      { ...PATTERN, layers: [{ ...CARD, type: 'group', children: [] }] },
      { ...PATTERN, layers: [{ ...CARD, constraints: { left: 0 } }] },
      { schemaVersion: 1, brandKit: null, pages: [] },
      MARKER,
    ]) {
      expect(await status(() => create(patterns, { content }))).toEqual([
        400,
        'CS_DESIGN_LAYOUT_PATTERN_INVALID',
      ]);
    }
    for (const overrides of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { description: 'd'.repeat(501) },
      { name: 'a\u0000b' },
    ]) {
      expect(await status(() => create(patterns, overrides))).toEqual([
        400,
        'CS_INVALID_REQUEST',
      ]);
    }
    expect(rows).toEqual([]);
  });

  it('LSEC8 content larger than allowed is 413 and stores nothing', async () => {
    const { patterns, rows } = setup();
    const long = '€'.repeat(10_000);
    expect(
      await status(() =>
        create(patterns, {
          content: {
            ...PATTERN,
            layers: Array.from({ length: 20 }, () => ({
              ...TITLE,
              text: long,
            })),
          },
        })
      )
    ).toEqual([413, 'CS_DESIGN_LAYOUT_PATTERN_TOO_LARGE']);
    expect(rows).toEqual([]);
  });

  it('a pattern changes in place: name, description and layers; later reads see it', async () => {
    const { patterns, rows } = setup();
    const created = await create(patterns);
    const content = { ...PATTERN, width: 300 };
    const updated = await patterns.updatePattern(ORG, created.id, {
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
        patterns.updatePattern(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([400, 'CS_INVALID_REQUEST']);
    expect(rows[0].content).toBe(
      storedContentStudioDesignLayoutPattern(content as never).content
    );
  });

  it('archive and restore are idempotent; an archived pattern is read-only', async () => {
    const { patterns } = setup();
    const created = await create(patterns);
    const archived = await patterns.archivePattern(ORG, created.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await patterns.archivePattern(ORG, created.id)).archivedAt).toEqual(
      archived.archivedAt
    );
    expect(
      await status(() =>
        patterns.updatePattern(ORG, created.id, {
          name: 'x',
          description: undefined,
          content: undefined,
        })
      )
    ).toEqual([409, 'CS_DESIGN_LAYOUT_PATTERN_ARCHIVED']);
    expect(
      (await patterns.restorePattern(ORG, created.id)).archivedAt
    ).toBeNull();
    expect(
      (await patterns.restorePattern(ORG, created.id)).archivedAt
    ).toBeNull();
  });

  it('stored content that no longer matches its hash is an integrity error, never repaired', async () => {
    const { patterns, rows } = setup();
    await create(patterns);
    rows[0].contentHash = '0'.repeat(64);
    expect(
      await status(() =>
        patterns.listPatterns({
          organizationId: ORG,
          archived: false,
          page: 1,
        })
      )
    ).toEqual([500, 'CS_DESIGN_LAYOUT_PATTERN_INTEGRITY_ERROR']);
    expect(rows[0].contentHash).toBe('0'.repeat(64));
  });
});

// ============================================================================
describe('Design layout patterns: Media', () => {
  it('LM1 an image of the organization’s ready Media with its exact SHA-256 is accepted', async () => {
    const { patterns, references } = setup();
    const created = await create(patterns, { content: WITH_PHOTO });
    expect(created.content.layers[1]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
    });
    expect(references.getMediaReference).toHaveBeenCalledWith(ORG, 'media-1');
  });

  it('LM2 another organization’s or a missing Media item is refused, and nothing is stored', async () => {
    const { patterns, rows } = setup();
    for (const mediaId of ['media-9', 'missing']) {
      expect(
        await status(() =>
          create(patterns, {
            content: { ...PATTERN, layers: [photo(mediaId, SHA('c'))] },
          })
        )
      ).toEqual([400, 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID']);
    }
    expect(rows).toEqual([]);
  });

  it('LM3 other bytes than the Media item has now are refused', async () => {
    const { patterns, rows } = setup();
    expect(
      await status(() =>
        create(patterns, {
          content: { ...PATTERN, layers: [photo('media-1', SHA('b'))] },
        })
      )
    ).toEqual([400, 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID']);
    expect(rows).toEqual([]);
  });

  it('LM4 each distinct Media item is read once; one item under two hashes is refused', async () => {
    const { patterns, references } = setup();
    await create(patterns, {
      content: {
        ...PATTERN,
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
        create(patterns, {
          content: {
            ...PATTERN,
            layers: [photo('media-1', SHA('a')), photo('media-1', SHA('b'))],
          },
        })
      )
    ).toEqual([400, 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID']);
  });

  it('LM5 changed layers are checked again; a name change reads no Media', async () => {
    const { patterns, references, rows } = setup();
    const created = await create(patterns);
    expect(references.getMediaReference).not.toHaveBeenCalled();
    await patterns.updatePattern(ORG, created.id, {
      name: 'Renamed',
      description: undefined,
      content: undefined,
    });
    expect(references.getMediaReference).not.toHaveBeenCalled();
    const before = rows[0].content;
    expect(
      await status(() =>
        patterns.updatePattern(ORG, created.id, {
          name: undefined,
          description: undefined,
          content: { ...PATTERN, layers: [photo('media-9', SHA('c'))] },
        })
      )
    ).toEqual([400, 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID']);
    expect(rows[0].content).toBe(before);
  });

  it('LM6 a failure other than a missing item is not hidden', async () => {
    const { patterns, references } = setup();
    references.getMediaReference.mockRejectedValueOnce(
      new HttpException(
        {
          msg: 'The media item could not be read safely.',
          code: 'CS_DESIGN_MEDIA_READ_FAILED',
        },
        500
      )
    );
    expect(
      await status(() => create(patterns, { content: WITH_PHOTO }))
    ).toEqual([500, 'CS_DESIGN_MEDIA_READ_FAILED']);
  });
});

// ============================================================================
describe('Design layout patterns: tenant isolation', () => {
  it('LSEC9 another organization’s patterns are never listed, changed, archived or restored', async () => {
    const { patterns, rows } = setup();
    const created = await create(patterns);
    const theirs = await patterns.listPatterns({
      organizationId: OTHER_ORG,
      archived: false,
      page: 1,
    });
    expect(theirs.results).toEqual([]);
    expect(theirs.pages).toBe(0);
    const before = JSON.stringify(rows);
    for (const run of [
      () =>
        patterns.updatePattern(OTHER_ORG, created.id, {
          name: MARKER,
          description: undefined,
          content: undefined,
        }),
      () => patterns.archivePattern(OTHER_ORG, created.id),
      () => patterns.restorePattern(OTHER_ORG, created.id),
    ]) {
      expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
    }
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('a built-in id, or an id that cannot exist, reaches no row', async () => {
    const { patterns, delegate } = setup();
    for (const id of ['system:layout-title-body', 'not-a-uuid', '']) {
      for (const run of [
        () =>
          patterns.updatePattern(ORG, id, {
            name: 'x',
            description: undefined,
            content: undefined,
          }),
        () => patterns.archivePattern(ORG, id),
        () => patterns.restorePattern(ORG, id),
      ]) {
        expect(await status(run)).toEqual([404, 'CS_NOT_FOUND']);
      }
    }
    expect(delegate.updateMany).not.toHaveBeenCalled();
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });

  it('every query names the organization; Media is read for the request organization', async () => {
    const { patterns, delegate, references } = setup();
    const created = await create(patterns, { content: WITH_PHOTO });
    await patterns.listPatterns({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    await patterns.updatePattern(ORG, created.id, {
      name: 'x',
      description: undefined,
      content: undefined,
    });
    await patterns.archivePattern(ORG, created.id);
    await patterns.restorePattern(ORG, created.id);
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
describe('Design layout patterns: source boundaries', () => {
  const SERVICE =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-layout-pattern.service.ts';
  const REPOSITORY =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-layout-pattern.repository.ts';
  const DTO =
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design-layout-pattern.dto.ts';
  const PURE =
    'libraries/nestjs-libraries/src/content-studio/design/design.layout.pattern.ts';
  const STORED =
    'libraries/nestjs-libraries/src/content-studio/design/design.layout.pattern.stored.ts';
  const SYSTEM =
    'libraries/nestjs-libraries/src/content-studio/design/design.system.layout.patterns.ts';
  const FILES = [SERVICE, REPOSITORY, DTO, PURE, STORED, SYSTEM];
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const model = (name: string) =>
    schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

  it('P415-1 no Fabric, render, fetch, AI, sharing or browser state', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /fabric|toJSON\(|loadFromJSON|render\(|readMedia|\bfetch\(|safeFetch|openai|anthropic|@ai-sdk|AIWriting|generate\(|marketplace|public|share|localStorage|process\.env/i
        ),
      ]);
    }
  });

  it('P415-2 Media is checked only through the design reference service; no Brand Kit is looked up', () => {
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

  it('P415-3 one mutable pattern table: no revisions, instances, links, groups or seeded built-ins', () => {
    const pattern = model('ContentStudioDesignLayoutPattern');
    expect(pattern).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(pattern).toMatch(/@@index\(\[organizationId, archivedAt\]\)/);
    expect(pattern).toMatch(/@@index\(\[createdById\]\)/);
    expect(pattern).toMatch(/content\s+String\n/);
    expect(pattern).toMatch(/contentHash\s+String\n/);
    expect(pattern).not.toMatch(
      /onDelete: Cascade|template|design\w*Id|page|guidance|brandKit/i
    );
    expect(schema).not.toMatch(
      /model ContentStudioDesignLayoutPattern(Revision|Instance|Link|Tag|Folder|Share|Group)\b/
    );
    for (const name of [
      'ContentStudioDesignProject',
      'ContentStudioDesignRevision',
      'ContentStudioDesignTemplate',
      'ContentStudioDesignTemplateRevision',
      'ContentStudioDesignStylePreset',
    ]) {
      expect([name, model(name)]).not.toEqual([
        name,
        expect.stringMatching(/pattern|layout/i),
      ]);
    }
    expect(schema).not.toMatch(/system:layout-/);
    expect(code(REPOSITORY)).not.toMatch(
      /\.delete(Many)?\(|\.upsert\(|\$queryRaw|\$executeRaw/
    );
  });

  it('P415-4 Design Document v1 and template guidance know nothing of patterns, groups or constraints', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts',
      'libraries/nestjs-libraries/src/content-studio/design/design.template.guidance.ts',
      'libraries/nestjs-libraries/src/content-studio/design/design.system.templates.ts',
    ]) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /pattern(Id|Ref)|layoutPattern|groupId|constraints|autoLayout|componentRef|symbolRef/i
        ),
      ]);
    }
    expect(
      code(
        'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      )
    ).toContain('export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;');
  });

  it('P415-5 the DTOs take no organization, user, design, page, Brand Kit or hash field', () => {
    const dto = code(DTO);
    for (const name of [
      'CreateContentStudioDesignLayoutPatternDto',
      'UpdateContentStudioDesignLayoutPatternDto',
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

  it('P415-6 is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(
      module.match(/ContentStudioDesignLayoutPatternRepository\b/g)
    ).toHaveLength(2);
    expect(
      module.match(/ContentStudioDesignLayoutPatternService\b/g)
    ).toHaveLength(2);
  });
});
