import fs from 'fs';
import path from 'path';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignRenderBatchRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render-batch.repository';

// No database: the delegates are mocked over in-memory rows with Prisma-like
// where clauses. Real constraints come with the PostgreSQL integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-16T10:00:00.000Z');
const LATER = new Date('2026-10-16T10:00:09.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => row[key] === value);
const pick = (row: Row, select: Row) =>
  Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));

const setup = () => {
  const batches: Row[] = [];
  const renders: Row[] = [];
  const batch = {
    create: jest.fn(async (args: { data: Row; select: Row }) => {
      const row = {
        createdAt: NOW,
        completedAt: null,
        errorCode: null,
        ...args.data,
      };
      batches.push(row);
      return pick(row, args.select);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const found = batches.filter((row) => matches(row, args.where));
      for (const row of found) {
        Object.assign(row, args.data);
      }
      return { count: found.length };
    }),
    findFirst: jest.fn(async (args: { where: Row; select: Row }) => {
      const row = batches.find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
  };
  const render = {
    findMany: jest.fn(async (args: { where: Row; select: Row; orderBy: Row }) =>
      renders
        .filter((r) => matches(r, args.where))
        .sort(
          (a, b) => (a.batchPageIndex as number) - (b.batchPageIndex as number)
        )
        .map((r) => pick(r, args.select))
    ),
  };
  const repository = new ContentStudioDesignRenderBatchRepository(
    {
      model: { contentStudioDesignRenderBatch: batch },
    } as unknown as PrismaRepository<'contentStudioDesignRenderBatch'>,
    {
      model: { contentStudioDesignRender: render },
    } as unknown as PrismaRepository<'contentStudioDesignRender'>
  );
  return { repository, batches, renders, batch, render };
};

const BRAND = {
  brandKitId: '66666666-6666-4666-8666-666666666666',
  brandKitRevisionId: '77777777-7777-4777-8777-777777777777',
  brandKitRevisionNumber: 3,
  brandKitContentHash: 'c'.repeat(64),
};

const running = (
  repository: ContentStudioDesignRenderBatchRepository,
  brand: typeof BRAND | null = BRAND
) =>
  repository.createRunningBatch({
    id: BATCH,
    organizationId: ORG,
    createdById: USER,
    designProjectId: '88888888-8888-4888-8888-888888888888',
    designRevisionId: '99999999-9999-4999-8999-999999999999',
    designRevisionNumber: 2,
    designContentHash: 'd'.repeat(64),
    brand,
    rendererVersion: 'content-studio-renderer-v1',
    layoutVersion: 'content-studio-layout-v1',
    pageCount: 3,
  });

describe('ContentStudioDesignRenderBatchRepository', () => {
  it('BRB1/BRB2/BRB3/BRB4/BRB5 creates a running batch with exact provenance, versions and page count', async () => {
    const { repository, batches } = setup();
    expect(await running(repository)).toEqual({ id: BATCH, createdAt: NOW });
    expect(batches[0]).toEqual({
      id: BATCH,
      organizationId: ORG,
      createdById: USER,
      designProjectId: '88888888-8888-4888-8888-888888888888',
      designRevisionId: '99999999-9999-4999-8999-999999999999',
      designRevisionNumber: 2,
      designContentHash: 'd'.repeat(64),
      ...BRAND,
      rendererVersion: 'content-studio-renderer-v1',
      layoutVersion: 'content-studio-layout-v1',
      pageCount: 3,
      status: 'running',
      errorCode: null,
      createdAt: NOW,
      completedAt: null,
    });
  });

  it('BRB3 stores all four Brand Kit fields as null without a Brand Kit', async () => {
    const { repository, batches } = setup();
    await running(repository, null);
    expect(batches[0]).toMatchObject({
      brandKitId: null,
      brandKitRevisionId: null,
      brandKitRevisionNumber: null,
      brandKitContentHash: null,
    });
  });

  it('BRB6/BRB11 completes a running batch of the organization once', async () => {
    const { repository, batches, batch } = setup();
    await running(repository);
    expect(
      (
        await repository.completeBatch({
          organizationId: OTHER_ORG,
          id: BATCH,
          completedAt: LATER,
        })
      ).count
    ).toBe(0);
    expect(
      (
        await repository.completeBatch({
          organizationId: ORG,
          id: BATCH,
          completedAt: LATER,
        })
      ).count
    ).toBe(1);
    expect(batch.updateMany).toHaveBeenLastCalledWith({
      where: { id: BATCH, organizationId: ORG, status: 'running' },
      data: { status: 'completed', errorCode: null, completedAt: LATER },
    });
    const after = { ...batches[0] };
    expect(
      (
        await repository.completeBatch({
          organizationId: ORG,
          id: BATCH,
          completedAt: NOW,
        })
      ).count
    ).toBe(0);
    expect(
      (
        await repository.failBatch({
          organizationId: ORG,
          id: BATCH,
          errorCode: 'RENDER_FAILED',
          completedAt: NOW,
        })
      ).count
    ).toBe(0);
    expect(batches[0]).toEqual(after);
  });

  it('BRB7 fails a running batch of the organization with a code only', async () => {
    const { repository, batches, batch } = setup();
    await running(repository);
    expect(
      (
        await repository.failBatch({
          organizationId: OTHER_ORG,
          id: BATCH,
          errorCode: 'X',
          completedAt: LATER,
        })
      ).count
    ).toBe(0);
    expect(
      (
        await repository.failBatch({
          organizationId: ORG,
          id: BATCH,
          errorCode: 'STORAGE_FAILED',
          completedAt: LATER,
        })
      ).count
    ).toBe(1);
    expect(batch.updateMany).toHaveBeenLastCalledWith({
      where: { id: BATCH, organizationId: ORG, status: 'running' },
      data: {
        status: 'failed',
        errorCode: 'STORAGE_FAILED',
        completedAt: LATER,
      },
    });
    expect(batches[0].status).toBe('failed');
  });

  it('BRB8/BRB9 reads a batch and its pages, in page order, for the organization only', async () => {
    const { repository, renders } = setup();
    await running(repository);
    for (const [batchPageIndex, id] of [
      [2, 'r-2'],
      [0, 'r-0'],
      [1, 'r-1'],
    ] as const) {
      renders.push({
        id,
        organizationId: ORG,
        batchId: BATCH,
        batchPageIndex,
        pageId: `p${batchPageIndex}`,
        status: 'completed',
        assetSnapshot: '{"secret":true}',
      });
    }
    renders.push({
      id: 'foreign',
      organizationId: OTHER_ORG,
      batchId: BATCH,
      batchPageIndex: 0,
    });
    const read = await repository.getBatchForOrganization(ORG, BATCH);
    expect(read).toMatchObject({ id: BATCH, status: 'running', pageCount: 3 });
    expect(read).not.toHaveProperty('organizationId');
    expect(
      await repository.getBatchForOrganization(OTHER_ORG, BATCH)
    ).toBeNull();
    const pages = await repository.listBatchRendersForOrganization(ORG, BATCH);
    expect(pages.map((p) => p.id)).toEqual(['r-0', 'r-1', 'r-2']);
    expect(pages[0]).not.toHaveProperty('assetSnapshot');
    expect(
      await repository.listBatchRendersForOrganization(OTHER_ORG, BATCH)
    ).toHaveLength(1);
  });

  it('48 asks the database for page order, never relying on its default order', async () => {
    const { repository, render } = setup();
    await repository.listBatchRendersForOrganization(ORG, BATCH);
    expect(render.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORG, batchId: BATCH },
      orderBy: { batchPageIndex: 'asc' },
    });
  });

  it('BRB10/BRB11 has no delete and no free update', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioDesignRenderBatchRepository.prototype
      ).sort()
    ).toEqual([
      'completeBatch',
      'constructor',
      'createRunningBatch',
      'failBatch',
      'getBatchForOrganization',
      'listBatchRendersForOrganization',
    ]);
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.design-render-batch.repository.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(source.match(/status: 'running',\n\s+\},\n\s+data/g)).toHaveLength(
      2
    );
  });

  it('BRB12/BRB13/167 pins tenant relations, page-index uniqueness, and no copied pages, snapshots, Media or content', () => {
    const schema = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
      ),
      'utf8'
    );
    const block = schema.match(
      /\nmodel ContentStudioDesignRenderBatch \{([\s\S]*?)\n\}/
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
      brandKitId: 'String?',
      brandKitRevisionId: 'String?',
      brandKitRevisionNumber: 'Int?',
      brandKitContentHash: 'String?',
      rendererVersion: 'String',
      layoutVersion: 'String',
      pageCount: 'Int',
      status: 'String',
      errorCode: 'String?',
      createdById: 'String',
      createdAt: 'DateTime',
      completedAt: 'DateTime?',
      organization: 'Organization',
      designProject: 'ContentStudioDesignProject',
      designRevision: 'ContentStudioDesignRevision',
      brandKitRevision: 'ContentStudioBrandKitRevision?',
      createdBy: 'User',
      renders: 'ContentStudioDesignRender[]',
    });
    expect(block).toMatch(
      /designProject\s+ContentStudioDesignProject\s+@relation\(fields: \[designProjectId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(block).toMatch(
      /designRevision\s+ContentStudioDesignRevision\s+@relation\(fields: \[designRevisionId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(block).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block).not.toMatch(
      /snapshot|Media|output|content\s|svg|png|bytes|url|storageKey|updatedAt/i
    );
    const render = schema.match(
      /\nmodel ContentStudioDesignRender \{([\s\S]*?)\n\}/
    )?.[1] as string;
    expect(render).toMatch(
      /batch\s+ContentStudioDesignRenderBatch\?\s+@relation\(fields: \[batchId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(render).toMatch(/@@unique\(\[batchId, batchPageIndex\]\)/);
    expect(render).toMatch(/\n\s+batchId\s+String\?\n/);
    expect(render).toMatch(/\n\s+batchPageIndex\s+Int\?\n/);
  });
});
