import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioRenderFontRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.repository';
import {
  ContentStudioDesignRenderBrandProvenance,
  ContentStudioDesignRenderRepository,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.repository';
import { ContentStudioRenderMediaBridge } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-media.bridge';
import { renderFontStorageUnavailable } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioBrandKitIntegrityError,
  parseVerifiedContentStudioBrandKitRevision,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import { ContentStudioDesignDocumentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignIntegrityError,
  parseVerifiedContentStudioDesignRevision,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { ContentStudioDesignFontSpec } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import { renderContentStudioDesignPage } from '@gitroom/nestjs-libraries/content-studio/design/render/design.renderer';
import {
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderResult,
  ContentStudioRenderFontAsset,
  DESIGN_RENDER_IMAGE_MAX_BYTES,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';
import {
  collectContentStudioDesignRenderFontRequests,
  CONTENT_STUDIO_LAYOUT_VERSION,
  CONTENT_STUDIO_RENDERER_VERSION,
  ContentStudioRenderAssetSnapshotFont,
  storedContentStudioRenderAssetSnapshot,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.snapshot';
import { ContentStudioPrivateFontStorageError } from '@gitroom/nestjs-libraries/upload/content-studio.private-font.storage';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';

// Fixed messages only: never design text, ids, hashes, font names, paths or
// a renderer, storage or Prisma message. A design or revision of another
// organization (or another design) is a plain 404
const notFound = () =>
  new HttpException({ msg: 'Design not found.', code: 'CS_NOT_FOUND' }, 404);
const revisionNotFound = () =>
  new HttpException(
    { msg: 'Design revision not found.', code: 'CS_DESIGN_REVISION_NOT_FOUND' },
    404
  );
const pageInvalid = () =>
  new HttpException(
    {
      msg: 'The selected design page is not available.',
      code: 'CS_DESIGN_RENDER_PAGE_INVALID',
    },
    400
  );
const designIntegrityError = () =>
  new HttpException(
    {
      msg: 'Stored design data could not be read safely.',
      code: 'CS_DESIGN_INTEGRITY_ERROR',
    },
    500
  );
const brandIntegrityError = () =>
  new HttpException(
    {
      msg: 'Stored Brand Kit data could not be read safely.',
      code: 'CS_DESIGN_RENDER_BRAND_INTEGRITY_ERROR',
    },
    500
  );
const assetUnavailable = () =>
  new HttpException(
    {
      msg: 'A design render asset is unavailable.',
      code: 'CS_DESIGN_RENDER_ASSET_UNAVAILABLE',
    },
    409
  );
const assetIntegrityError = () =>
  new HttpException(
    {
      msg: 'Stored design render asset data could not be verified.',
      code: 'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR',
    },
    500
  );
const renderFailed = () =>
  new HttpException(
    {
      msg: 'The design could not be rendered.',
      code: 'CS_DESIGN_RENDER_FAILED',
    },
    500
  );
const storageFailed = () =>
  new HttpException(
    {
      msg: 'The rendered design could not be stored.',
      code: 'CS_DESIGN_RENDER_STORAGE_FAILED',
    },
    500
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Why a render failed, as stored on the render: a renderer code, or one of
// these. Never a message
type RenderFailureCode =
  | ContentStudioDesignRenderError['code']
  | 'FONT_STORAGE_UNAVAILABLE'
  | 'FONT_ASSET_READ_FAILED'
  | 'SNAPSHOT_INTEGRITY_ERROR'
  | 'STORAGE_FAILED'
  | 'FINALIZATION_FAILED';

class RenderFailure extends Error {
  constructor(readonly code: RenderFailureCode) {
    super('The design render failed');
    this.name = 'RenderFailure';
  }
}

const failureResponse = (code: RenderFailureCode) => {
  switch (code) {
    case 'PAGE_NOT_FOUND':
      return pageInvalid();
    case 'FONT_ASSET_UNAVAILABLE':
    case 'IMAGE_ASSET_UNAVAILABLE':
      return assetUnavailable();
    case 'FONT_ASSET_INTEGRITY_ERROR':
    case 'IMAGE_ASSET_INTEGRITY_ERROR':
    case 'SNAPSHOT_INTEGRITY_ERROR':
      return assetIntegrityError();
    case 'FONT_STORAGE_UNAVAILABLE':
      return renderFontStorageUnavailable();
    case 'STORAGE_FAILED':
      return storageFailed();
    default:
      return renderFailed();
  }
};

const fontRequest = (font: { family: string; weight: number; style: string }) =>
  JSON.stringify([font.family, font.weight, font.style]);
const imageLookup = (image: { mediaId: string; sha256: string }) =>
  JSON.stringify([image.mediaId, image.sha256]);

// A font loaded for one render: the bytes it was given and what the
// snapshot records about them
interface PreloadedFont {
  asset: ContentStudioRenderFontAsset;
  snapshot: ContentStudioRenderAssetSnapshotFont;
}

// Renders one page of one exact, explicitly chosen design revision to a PNG
// stored as a Media of the organization, and records the render with the
// exact inputs it used. Any member may render (no role, plan, billing or
// credit check), an archived design and an older revision included; nothing
// ever falls back to the latest revision or to the current Brand Kit
// revision. Order:
// 1. preflight, before anything is stored: the design and revision of this
//    organization, the revision intact, the page in it, the exact Brand Kit
//    revision the design names intact and matching, and the fonts the
//    layout will ask for;
// 2. a running render with that provenance;
// 3. those fonts loaded through their current enabled mappings, each from
//    its immutable private font asset and checked against its SHA-256 (the
//    renderer's font resolver is synchronous; an unmapped font is left to
//    the renderer to report). Mappings of unused fonts are never read;
// 4. the renderer, called once, with images read from Media on demand;
// 5. the asset snapshot from what the rendered page actually used, mapped
//    back to what step 3 captured (never read again);
// 6. the PNG stored as a new Media, then the render completed with all of it
//    in one update.
// A failure in 3-6 fails the render with a code and is never retried. When
// the PNG is stored but the render cannot be completed, that Media stays
// unreferenced. No transaction spans storage, the renderer or Media
@Injectable()
export class ContentStudioDesignRenderService {
  private _fontStorage =
    StoredAssetFactory.createContentStudioPrivateFontStorage();

  constructor(
    private _contentStudioDesignRepository: ContentStudioDesignRepository,
    private _contentStudioBrandKitRepository: ContentStudioBrandKitRepository,
    private _contentStudioRenderFontRepository: ContentStudioRenderFontRepository,
    private _contentStudioDesignRenderRepository: ContentStudioDesignRenderRepository,
    private _contentStudioRenderMediaBridge: ContentStudioRenderMediaBridge
  ) {}

  async renderPage(input: {
    organizationId: string;
    userId: string;
    designId: string;
    revisionId: string;
    pageId: string;
  }) {
    const { organizationId } = input;
    const { project, revision, document } = await this.designRevision(input);
    if (
      typeof input.pageId !== 'string' ||
      !document.pages.some((page) => page.id === input.pageId)
    ) {
      throw pageInvalid();
    }
    const brand = await this.brandRevision(organizationId, document);
    let fontRequests: ContentStudioDesignFontSpec[];
    try {
      fontRequests = collectContentStudioDesignRenderFontRequests(
        document,
        brand?.content ?? null
      );
    } catch {
      throw brandIntegrityError();
    }

    const renderId = randomUUID();
    const running =
      await this._contentStudioDesignRenderRepository.createRunningRender({
        id: renderId,
        organizationId,
        createdById: input.userId,
        designProjectId: project.id,
        designRevisionId: revision.id,
        designRevisionNumber: revision.revisionNumber,
        designContentHash: revision.contentHash,
        pageId: input.pageId,
        brand: brand?.provenance ?? null,
        rendererVersion: CONTENT_STUDIO_RENDERER_VERSION,
        layoutVersion: CONTENT_STUDIO_LAYOUT_VERSION,
      });

    let completed: {
      result: ContentStudioDesignRenderResult;
      assetSnapshot: string;
      assetSnapshotHash: string;
      renderedMediaId: string;
    };
    try {
      completed = await this.execute({
        organizationId,
        renderId,
        document,
        brand,
        pageId: input.pageId,
        fontRequests,
      });
    } catch (err) {
      const code = err instanceof RenderFailure ? err.code : 'RENDER_FAILED';
      await this.fail(organizationId, renderId, code);
      throw failureResponse(code);
    }

    const completedAt = new Date();
    let count: number;
    try {
      ({ count } =
        await this._contentStudioDesignRenderRepository.completeRender({
          organizationId,
          id: renderId,
          assetSnapshot: completed.assetSnapshot,
          assetSnapshotHash: completed.assetSnapshotHash,
          renderedMediaId: completed.renderedMediaId,
          renderedSha256: completed.result.sha256,
          width: completed.result.width,
          height: completed.result.height,
          mimeType: completed.result.mimeType,
          completedAt,
        }));
    } catch {
      count = 0;
    }
    if (count !== 1) {
      // nothing is rendered or stored again
      await this.fail(organizationId, renderId, 'FINALIZATION_FAILED');
      throw renderFailed();
    }
    return {
      id: renderId,
      designProjectId: project.id,
      designRevisionId: revision.id,
      designRevisionNumber: revision.revisionNumber,
      pageId: input.pageId,
      status: 'completed' as const,
      width: completed.result.width,
      height: completed.result.height,
      mimeType: completed.result.mimeType,
      renderedMediaId: completed.renderedMediaId,
      renderedSha256: completed.result.sha256,
      assetSnapshotHash: completed.assetSnapshotHash,
      createdAt: running.createdAt,
      completedAt,
    };
  }

  private async execute(input: {
    organizationId: string;
    renderId: string;
    document: ContentStudioDesignDocumentV1;
    brand: {
      content: ContentStudioBrandKitContentV1;
    } | null;
    pageId: string;
    fontRequests: ContentStudioDesignFontSpec[];
  }) {
    const { organizationId, document } = input;
    const fonts = await this.preloadFonts(organizationId, input.fontRequests);
    const byKey = new Map(
      Array.from(fonts.values()).map((font) => [font.asset.key, font])
    );

    // the SHA-256 of the bytes each image actually had
    const images = new Map<string, string>();
    let result: ContentStudioDesignRenderResult;
    try {
      result = await renderContentStudioDesignPage({
        document,
        brandKit:
          document.brandKit && input.brand
            ? { ref: document.brandKit, content: input.brand.content }
            : null,
        pageId: input.pageId,
        // only what was loaded before: a font the layout asks for that was
        // not collected is unavailable, never loaded late
        fonts: {
          resolveFont: (font) => fonts.get(fontRequest(font))?.asset ?? null,
        },
        images: {
          resolveImage: async (image) => {
            const bytes =
              await this._contentStudioRenderMediaBridge.readMediaBytesForOrganization(
                organizationId,
                image.mediaId,
                DESIGN_RENDER_IMAGE_MAX_BYTES
              );
            if (!bytes) {
              return null;
            }
            const sha256 = designRenderSha256(bytes);
            images.set(imageLookup(image), sha256);
            return { bytes, sha256 };
          },
        },
      });
    } catch (err) {
      throw new RenderFailure(
        err instanceof ContentStudioDesignRenderError
          ? err.code
          : 'RENDER_FAILED'
      );
    }

    const page = document.pages.find((entry) => entry.id === input.pageId);
    if (
      !page ||
      result.pageId !== input.pageId ||
      result.width !== page.width ||
      result.height !== page.height ||
      result.mimeType !== 'image/png' ||
      designRenderSha256(result.bytes) !== result.sha256
    ) {
      throw new RenderFailure('RENDER_FAILED');
    }

    // exactly what the page was drawn with, in the renderer's first-use
    // order, from what was captured when it was loaded
    let stored: { assetSnapshot: string; assetSnapshotHash: string };
    try {
      stored = storedContentStudioRenderAssetSnapshot({
        schemaVersion: 1,
        fonts: result.assets.fonts.map((used) => {
          const font = byKey.get(used.key);
          if (!font || font.snapshot.sha256 !== used.sha256) {
            throw new RenderFailure('SNAPSHOT_INTEGRITY_ERROR');
          }
          return { ...font.snapshot };
        }),
        images: result.assets.images.map((used) => {
          if (images.get(imageLookup(used)) !== used.sha256) {
            throw new RenderFailure('SNAPSHOT_INTEGRITY_ERROR');
          }
          return { mediaId: used.mediaId, sha256: used.sha256 };
        }),
      });
    } catch {
      throw new RenderFailure('SNAPSHOT_INTEGRITY_ERROR');
    }

    let media: { id: string };
    try {
      media = await this._contentStudioRenderMediaBridge.createRenderedMedia({
        organizationId,
        renderId: input.renderId,
        bytes: result.bytes,
      });
    } catch {
      throw new RenderFailure('STORAGE_FAILED');
    }
    return {
      result,
      assetSnapshot: stored.assetSnapshot,
      assetSnapshotHash: stored.assetSnapshotHash,
      renderedMediaId: media.id,
    };
  }

  // One after the other, in the order the layout asks, so the first failure
  // is always the same one. A font without an enabled mapping is left out
  // (the renderer reports it where the layout needs it); a mapped font must
  // be readable and exactly its asset's bytes
  private async preloadFonts(
    organizationId: string,
    requests: ContentStudioDesignFontSpec[]
  ) {
    const fonts = new Map<string, PreloadedFont>();
    for (const request of requests) {
      const mapping =
        await this._contentStudioRenderFontRepository.getActiveMappingBySpec(
          organizationId,
          request
        );
      if (!mapping) {
        continue;
      }
      const asset = mapping.fontAsset;
      let bytes: Buffer;
      try {
        bytes = await this._fontStorage.readFontAsset({
          organizationId,
          storageKey: asset.storageKey,
        });
      } catch (err) {
        const code =
          err instanceof ContentStudioPrivateFontStorageError ? err.code : null;
        throw new RenderFailure(
          code === 'UNAVAILABLE'
            ? 'FONT_STORAGE_UNAVAILABLE'
            : code === 'NOT_FOUND' || code === 'INVALID_KEY'
            ? 'FONT_ASSET_INTEGRITY_ERROR'
            : 'FONT_ASSET_READ_FAILED'
        );
      }
      if (
        bytes.length !== asset.byteSize ||
        designRenderSha256(bytes) !== asset.sha256
      ) {
        throw new RenderFailure('FONT_ASSET_INTEGRITY_ERROR');
      }
      fonts.set(fontRequest(request), {
        asset: {
          // one key per mapping and asset: a later file of the same mapping
          // is another font
          key: `${mapping.id}:${asset.id}`,
          bytes,
          sha256: asset.sha256,
        },
        snapshot: {
          mappingId: mapping.id,
          fontAssetId: asset.id,
          family: request.family,
          weight: request.weight,
          style: request.style,
          sha256: asset.sha256,
        },
      });
    }
    return fonts;
  }

  // Best effort: when the render cannot be marked failed either, it stays
  // running; nothing is retried
  private async fail(
    organizationId: string,
    id: string,
    errorCode: RenderFailureCode
  ) {
    try {
      await this._contentStudioDesignRenderRepository.failRender({
        organizationId,
        id,
        errorCode,
        completedAt: new Date(),
      });
    } catch {
      // the response already says the render failed
    }
  }

  // The exact revision asked for, of a design of this organization; an
  // archived design and an older revision included. Never the latest one
  private async designRevision(input: {
    organizationId: string;
    designId: string;
    revisionId: string;
  }) {
    if (typeof input.designId !== 'string' || !UUID.test(input.designId)) {
      throw notFound();
    }
    const project =
      await this._contentStudioDesignRepository.getProjectForOrganization(
        input.organizationId,
        input.designId
      );
    if (!project) {
      throw notFound();
    }
    if (typeof input.revisionId !== 'string' || !UUID.test(input.revisionId)) {
      throw revisionNotFound();
    }
    const revision =
      await this._contentStudioDesignRepository.getRevisionForProject(
        input.organizationId,
        project.id,
        input.revisionId
      );
    if (!revision) {
      throw revisionNotFound();
    }
    let document: ContentStudioDesignDocumentV1;
    try {
      document = parseVerifiedContentStudioDesignRevision(revision);
    } catch (err) {
      if (err instanceof ContentStudioDesignIntegrityError) {
        throw designIntegrityError();
      }
      throw err;
    }
    return { project, revision, document };
  }

  // Exactly the Brand Kit revision the design names: this organization's
  // kit, that revision, intact, with the same number and hash. A design that
  // was saved can always find it, so anything else is stored data that no
  // longer holds
  private async brandRevision(
    organizationId: string,
    document: ContentStudioDesignDocumentV1
  ): Promise<{
    content: ContentStudioBrandKitContentV1;
    provenance: ContentStudioDesignRenderBrandProvenance;
  } | null> {
    const reference = document.brandKit;
    if (!reference) {
      return null;
    }
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        organizationId
      );
    if (!brandKit || brandKit.id !== reference.brandKitId) {
      throw brandIntegrityError();
    }
    const revision =
      await this._contentStudioBrandKitRepository.getRevisionForBrandKit(
        organizationId,
        brandKit.id,
        reference.revisionId
      );
    if (!revision) {
      throw brandIntegrityError();
    }
    let content: ContentStudioBrandKitContentV1;
    try {
      content = parseVerifiedContentStudioBrandKitRevision(revision);
    } catch (err) {
      if (err instanceof ContentStudioBrandKitIntegrityError) {
        throw brandIntegrityError();
      }
      throw err;
    }
    if (
      revision.id !== reference.revisionId ||
      revision.revisionNumber !== reference.revisionNumber ||
      revision.contentHash !== reference.contentHash
    ) {
      throw brandIntegrityError();
    }
    return {
      content,
      provenance: {
        brandKitId: brandKit.id,
        brandKitRevisionId: revision.id,
        brandKitRevisionNumber: revision.revisionNumber,
        brandKitContentHash: revision.contentHash,
      },
    };
  }
}
