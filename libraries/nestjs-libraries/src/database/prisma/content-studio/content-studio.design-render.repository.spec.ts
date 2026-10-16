import fs from 'fs';
import path from 'path';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignRenderRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.repository';

// No database: the delegate is mocked over in-memory rows with Prisma-like
// where clauses. Real constraints come with the PostgreSQL integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const RENDER = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-16T10:00:00.000Z');
const LATER = new Date('2026-10-16T10:00:05.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

const setup = () => {
  const rows: Row[] = [];
  const delegate = {
    create: jest.fn(async (args: { data: Row; select?: Row }) => {
      const row = { createdAt: NOW, completedAt: null, ...args.data };
      for (const key of [
        'assetSnapshot',
        'assetSnapshotHash',
        'renderedMediaId',
        'renderedSha256',
        'width',
        'height',
        'mimeType',
        'errorCode',
      ]) {
        row[key] = row[key] ?? null;
      }
      rows.push(row);
      return args.select
        ? Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]))
        : row;
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const found = rows.filter((row) => matches(row, args.where));
      for (const row of found) {
        Object.assign(row, args.data);
      }
      return { count: found.length };
    }),
    findFirst: jest.fn(async (args: { where: Row; select: Row }) => {
      const row = rows.find((r) => matches(r, args.where));
      return row
        ? Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]))
        : null;
    }),
  };
  const repository = new ContentStudioDesignRenderRepository({
    model: { contentStudioDesignRender: delegate },
  } as unknown as PrismaRepository<'contentStudioDesignRender'>);
  return { repository, rows, delegate };
};

const BRAND = {
  brandKitId: '66666666-6666-4666-8666-666666666666',
  brandKitRevisionId: '77777777-7777-4777-8777-777777777777',
  brandKitRevisionNumber: 3,
  brandKitContentHash: 'c'.repeat(64),
};

const running = (
  repository: ContentStudioDesignRenderRepository,
  brand: typeof BRAND | null = BRAND
) =>
  repository.createRunningRender({
    id: RENDER,
    organizationId: ORG,
    createdById: USER,
    designProjectId: '88888888-8888-4888-8888-888888888888',
    designRevisionId: '99999999-9999-4999-8999-999999999999',
    designRevisionNumber: 2,
    designContentHash: 'd'.repeat(64),
    pageId: 'cover',
    brand,
    rendererVersion: 'content-studio-renderer-v1',
    layoutVersion: 'content-studio-layout-v1',
  });

const completion = (extra: Row = {}) => ({
  organizationId: ORG,
  id: RENDER,
  assetSnapshot: '{"fonts":[],"images":[],"schemaVersion":1}',
  assetSnapshotHash: 'e'.repeat(64),
  renderedMediaId: 'media-out',
  renderedSha256: 'f'.repeat(64),
  width: 1080,
  height: 1350,
  mimeType: 'image/png',
  completedAt: LATER,
  ...extra,
});

describe('ContentStudioDesignRenderRepository', () => {
  it('RPR1/RPR2/RPR3/RPR4 creates a running render with the exact design, Brand Kit and contract provenance', async () => {
    const { repository, rows } = setup();
    expect(await running(repository)).toEqual({ id: RENDER, createdAt: NOW });
    expect(rows[0]).toEqual({
      id: RENDER,
      organizationId: ORG,
      createdById: USER,
      designProjectId: '88888888-8888-4888-8888-888888888888',
      designRevisionId: '99999999-9999-4999-8999-999999999999',
      designRevisionNumber: 2,
      designContentHash: 'd'.repeat(64),
      pageId: 'cover',
      ...BRAND,
      rendererVersion: 'content-studio-renderer-v1',
      layoutVersion: 'content-studio-layout-v1',
      // a single-page render belongs to no batch (P4-06)
      batchId: null,
      batchPageIndex: null,
      status: 'running',
      assetSnapshot: null,
      assetSnapshotHash: null,
      renderedMediaId: null,
      renderedSha256: null,
      width: null,
      height: null,
      mimeType: null,
      errorCode: null,
      createdAt: NOW,
      completedAt: null,
    });
  });

  it('109/BRB14 a page of a batch stores the batch and its page index', async () => {
    const { repository, rows } = setup();
    await repository.createRunningRender({
      id: RENDER,
      organizationId: ORG,
      createdById: USER,
      designProjectId: '88888888-8888-4888-8888-888888888888',
      designRevisionId: '99999999-9999-4999-8999-999999999999',
      designRevisionNumber: 2,
      designContentHash: 'd'.repeat(64),
      pageId: 'cover',
      brand: null,
      rendererVersion: 'content-studio-renderer-v1',
      layoutVersion: 'content-studio-layout-v1',
      batch: {
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        batchPageIndex: 0,
      },
    });
    expect(rows[0]).toMatchObject({
      batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      batchPageIndex: 0,
    });
    const read = await repository.getRenderForOrganization(ORG, RENDER);
    expect(read).toMatchObject({
      batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      batchPageIndex: 0,
    });
  });

  it('RPR3 stores all four Brand Kit fields as null without a Brand Kit', async () => {
    const { repository, rows } = setup();
    await running(repository, null);
    expect(rows[0]).toMatchObject({
      brandKitId: null,
      brandKitRevisionId: null,
      brandKitRevisionNumber: null,
      brandKitContentHash: null,
    });
  });

  it('RPR5/RPR6 completes a running render of the organization in one update', async () => {
    const { repository, rows, delegate } = setup();
    await running(repository);
    expect(
      (
        await repository.completeRender(
          completion({ organizationId: OTHER_ORG })
        )
      ).count
    ).toBe(0);
    expect((await repository.completeRender(completion())).count).toBe(1);
    expect(delegate.updateMany).toHaveBeenLastCalledWith({
      where: { id: RENDER, organizationId: ORG, status: 'running' },
      data: {
        status: 'completed',
        assetSnapshot: '{"fonts":[],"images":[],"schemaVersion":1}',
        assetSnapshotHash: 'e'.repeat(64),
        renderedMediaId: 'media-out',
        renderedSha256: 'f'.repeat(64),
        width: 1080,
        height: 1350,
        mimeType: 'image/png',
        errorCode: null,
        completedAt: LATER,
      },
    });
    expect(rows[0].status).toBe('completed');
  });

  it('RPR7/RPR8 fails a running render with a code only', async () => {
    const { repository, rows, delegate } = setup();
    await running(repository);
    expect(
      (
        await repository.failRender({
          organizationId: ORG,
          id: RENDER,
          errorCode: 'IMAGE_ASSET_UNAVAILABLE',
          completedAt: LATER,
        })
      ).count
    ).toBe(1);
    expect(delegate.updateMany).toHaveBeenLastCalledWith({
      where: { id: RENDER, organizationId: ORG, status: 'running' },
      data: {
        status: 'failed',
        errorCode: 'IMAGE_ASSET_UNAVAILABLE',
        completedAt: LATER,
      },
    });
    expect(rows[0]).toMatchObject({
      status: 'failed',
      assetSnapshot: null,
      assetSnapshotHash: null,
      renderedMediaId: null,
      renderedSha256: null,
    });
  });

  it('RPR9/RPR13 finalizes once: a completed or failed render never changes again', async () => {
    const { repository, rows } = setup();
    await running(repository);
    await repository.completeRender(completion());
    const after = { ...rows[0] };
    expect(
      (await repository.completeRender(completion({ renderedMediaId: 'x' })))
        .count
    ).toBe(0);
    expect(
      (
        await repository.failRender({
          organizationId: ORG,
          id: RENDER,
          errorCode: 'RENDER_FAILED',
          completedAt: LATER,
        })
      ).count
    ).toBe(0);
    expect(rows[0]).toEqual(after);
  });

  it('RPR10/RPR11 reads a render of the organization only', async () => {
    const { repository } = setup();
    await running(repository);
    const row = await repository.getRenderForOrganization(ORG, RENDER);
    expect(row).toMatchObject({
      id: RENDER,
      status: 'running',
      pageId: 'cover',
    });
    expect(row).not.toHaveProperty('organizationId');
    expect(row).not.toHaveProperty('createdById');
    expect(
      await repository.getRenderForOrganization(OTHER_ORG, RENDER)
    ).toBeNull();
  });

  it('RPR12 has no delete or free update', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioDesignRenderRepository.prototype
      ).sort()
    ).toEqual([
      'completeRender',
      'constructor',
      'createRunningRender',
      'failRender',
      'getRenderForOrganization',
    ]);
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.design-render.repository.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(source.match(/status: 'running',\n\s+\},\n\s+data/g)).toHaveLength(
      2
    );
  });

  it('RPR14/P405-9 pins the tenant relations and holds no content, bytes, URL or storage key', () => {
    const schema = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
      ),
      'utf8'
    );
    const block = schema.match(
      /\nmodel ContentStudioDesignRender \{([\s\S]*?)\n\}/
    )?.[1] as string;
    const fields = Object.fromEntries(
      block
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([field]) => field && !field.startsWith('@@'))
        .map(([field, type]) => [field, type])
    );
    expect(fields).toEqual({
      id: 'String',
      organizationId: 'String',
      designProjectId: 'String',
      designRevisionId: 'String',
      designRevisionNumber: 'Int',
      designContentHash: 'String',
      pageId: 'String',
      brandKitId: 'String?',
      brandKitRevisionId: 'String?',
      brandKitRevisionNumber: 'Int?',
      brandKitContentHash: 'String?',
      rendererVersion: 'String',
      layoutVersion: 'String',
      status: 'String',
      assetSnapshot: 'String?',
      assetSnapshotHash: 'String?',
      renderedMediaId: 'String?',
      renderedSha256: 'String?',
      width: 'Int?',
      height: 'Int?',
      mimeType: 'String?',
      errorCode: 'String?',
      createdById: 'String',
      createdAt: 'DateTime',
      // P4-06: the batch and the page's index in the design
      batchId: 'String?',
      batchPageIndex: 'Int?',
      completedAt: 'DateTime?',
      organization: 'Organization',
      designProject: 'ContentStudioDesignProject',
      designRevision: 'ContentStudioDesignRevision',
      brandKitRevision: 'ContentStudioBrandKitRevision?',
      batch: 'ContentStudioDesignRenderBatch?',
      createdBy: 'User',
    });
    expect(block).toMatch(
      /designProject\s+ContentStudioDesignProject\s+@relation\(fields: \[designProjectId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(block).toMatch(
      /designRevision\s+ContentStudioDesignRevision\s+@relation\(fields: \[designRevisionId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(block).toMatch(
      /brandKitRevision\s+ContentStudioBrandKitRevision\?\s+@relation\(fields: \[brandKitRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(block).toMatch(/@@unique\(\[id, organizationId\]\)/);
    // P4-06: a page points to a batch of its own organization, once per index
    expect(block).toMatch(
      /batch\s+ContentStudioDesignRenderBatch\?\s+@relation\(fields: \[batchId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(block).toMatch(/@@unique\(\[batchId, batchPageIndex\]\)/);
    expect(block).not.toMatch(
      /updatedAt|content\s|svg|png\s|bytes|url|storageKey|text/i
    );
  });
});
