import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const RENDER_DETAIL = {
  id: true,
  designProjectId: true,
  designRevisionId: true,
  designRevisionNumber: true,
  designContentHash: true,
  pageId: true,
  brandKitId: true,
  brandKitRevisionId: true,
  brandKitRevisionNumber: true,
  brandKitContentHash: true,
  rendererVersion: true,
  layoutVersion: true,
  status: true,
  assetSnapshot: true,
  assetSnapshotHash: true,
  renderedMediaId: true,
  renderedSha256: true,
  width: true,
  height: true,
  mimeType: true,
  errorCode: true,
  createdAt: true,
  completedAt: true,
} as const;

// The exact Brand Kit revision a render used: all four, or none
export interface ContentStudioDesignRenderBrandProvenance {
  brandKitId: string;
  brandKitRevisionId: string;
  brandKitRevisionNumber: number;
  brandKitContentHash: string;
}

// Design renders of an organization. A render is created running with its
// exact design and Brand Kit provenance and finalized once: completed (asset
// snapshot and rendered Media together) or failed (an error code only). The
// finalizing update only matches a running render of the organization, so a
// render is never finalized twice and a finalized one never changes again.
// Every query filters on organizationId itself; nothing is deleted
@Injectable()
export class ContentStudioDesignRenderRepository {
  constructor(private _render: PrismaRepository<'contentStudioDesignRender'>) {}

  createRunningRender(input: {
    id: string;
    organizationId: string;
    createdById: string;
    designProjectId: string;
    designRevisionId: string;
    designRevisionNumber: number;
    designContentHash: string;
    pageId: string;
    brand: ContentStudioDesignRenderBrandProvenance | null;
    rendererVersion: string;
    layoutVersion: string;
  }) {
    return this._render.model.contentStudioDesignRender.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        createdById: input.createdById,
        designProjectId: input.designProjectId,
        designRevisionId: input.designRevisionId,
        designRevisionNumber: input.designRevisionNumber,
        designContentHash: input.designContentHash,
        pageId: input.pageId,
        brandKitId: input.brand?.brandKitId ?? null,
        brandKitRevisionId: input.brand?.brandKitRevisionId ?? null,
        brandKitRevisionNumber: input.brand?.brandKitRevisionNumber ?? null,
        brandKitContentHash: input.brand?.brandKitContentHash ?? null,
        rendererVersion: input.rendererVersion,
        layoutVersion: input.layoutVersion,
        status: 'running',
      },
      select: { id: true, createdAt: true },
    });
  }

  // Everything a completed render records, in one update of a running render
  completeRender(input: {
    organizationId: string;
    id: string;
    assetSnapshot: string;
    assetSnapshotHash: string;
    renderedMediaId: string;
    renderedSha256: string;
    width: number;
    height: number;
    mimeType: string;
    completedAt: Date;
  }) {
    return this._render.model.contentStudioDesignRender.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        status: 'running',
      },
      data: {
        status: 'completed',
        assetSnapshot: input.assetSnapshot,
        assetSnapshotHash: input.assetSnapshotHash,
        renderedMediaId: input.renderedMediaId,
        renderedSha256: input.renderedSha256,
        width: input.width,
        height: input.height,
        mimeType: input.mimeType,
        errorCode: null,
        completedAt: input.completedAt,
      },
    });
  }

  // A failed render keeps no snapshot and no output
  failRender(input: {
    organizationId: string;
    id: string;
    errorCode: string;
    completedAt: Date;
  }) {
    return this._render.model.contentStudioDesignRender.updateMany({
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

  getRenderForOrganization(organizationId: string, id: string) {
    return this._render.model.contentStudioDesignRender.findFirst({
      where: {
        id,
        organizationId,
      },
      select: RENDER_DETAIL,
    });
  }
}
