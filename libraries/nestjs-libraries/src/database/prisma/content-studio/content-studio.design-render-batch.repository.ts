import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { ContentStudioDesignRenderBrandProvenance } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.repository';

const BATCH_DETAIL = {
  id: true,
  designProjectId: true,
  designRevisionId: true,
  designRevisionNumber: true,
  designContentHash: true,
  brandKitId: true,
  brandKitRevisionId: true,
  brandKitRevisionNumber: true,
  brandKitContentHash: true,
  rendererVersion: true,
  layoutVersion: true,
  pageCount: true,
  status: true,
  errorCode: true,
  createdAt: true,
  completedAt: true,
} as const;

// What a page of a batch recorded; never its snapshot body
const BATCH_PAGE = {
  id: true,
  pageId: true,
  batchPageIndex: true,
  status: true,
  renderedMediaId: true,
  renderedSha256: true,
  assetSnapshotHash: true,
  width: true,
  height: true,
  mimeType: true,
  errorCode: true,
} as const;

// Render-all batches of an organization. A batch is created running with
// its exact design and Brand Kit provenance and page count, and finalized
// once: completed or failed (an error code only). The finalizing update only
// matches a running batch of the organization, so a batch is never
// finalized twice. Its pages are design renders that name it; they are
// created and finalized by the render repository. Every query filters on
// organizationId itself; nothing is deleted
@Injectable()
export class ContentStudioDesignRenderBatchRepository {
  constructor(
    private _batch: PrismaRepository<'contentStudioDesignRenderBatch'>,
    private _render: PrismaRepository<'contentStudioDesignRender'>
  ) {}

  createRunningBatch(input: {
    id: string;
    organizationId: string;
    createdById: string;
    designProjectId: string;
    designRevisionId: string;
    designRevisionNumber: number;
    designContentHash: string;
    brand: ContentStudioDesignRenderBrandProvenance | null;
    rendererVersion: string;
    layoutVersion: string;
    pageCount: number;
  }) {
    return this._batch.model.contentStudioDesignRenderBatch.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        createdById: input.createdById,
        designProjectId: input.designProjectId,
        designRevisionId: input.designRevisionId,
        designRevisionNumber: input.designRevisionNumber,
        designContentHash: input.designContentHash,
        brandKitId: input.brand?.brandKitId ?? null,
        brandKitRevisionId: input.brand?.brandKitRevisionId ?? null,
        brandKitRevisionNumber: input.brand?.brandKitRevisionNumber ?? null,
        brandKitContentHash: input.brand?.brandKitContentHash ?? null,
        rendererVersion: input.rendererVersion,
        layoutVersion: input.layoutVersion,
        pageCount: input.pageCount,
        status: 'running',
      },
      select: { id: true, createdAt: true },
    });
  }

  completeBatch(input: {
    organizationId: string;
    id: string;
    completedAt: Date;
  }) {
    return this._batch.model.contentStudioDesignRenderBatch.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        status: 'running',
      },
      data: {
        status: 'completed',
        errorCode: null,
        completedAt: input.completedAt,
      },
    });
  }

  failBatch(input: {
    organizationId: string;
    id: string;
    errorCode: string;
    completedAt: Date;
  }) {
    return this._batch.model.contentStudioDesignRenderBatch.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        status: 'running',
      },
      data: {
        status: 'failed',
        errorCode: input.errorCode,
        completedAt: input.completedAt,
      },
    });
  }

  getBatchForOrganization(organizationId: string, id: string) {
    return this._batch.model.contentStudioDesignRenderBatch.findFirst({
      where: {
        id,
        organizationId,
      },
      select: BATCH_DETAIL,
    });
  }

  // The batch's pages in design page order
  listBatchRendersForOrganization(organizationId: string, batchId: string) {
    return this._render.model.contentStudioDesignRender.findMany({
      where: {
        organizationId,
        batchId,
      },
      orderBy: {
        batchPageIndex: 'asc',
      },
      select: BATCH_PAGE,
    });
  }
}
