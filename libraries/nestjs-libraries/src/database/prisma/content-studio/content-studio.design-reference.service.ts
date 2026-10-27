import { HttpException, Injectable } from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ContentStudioRenderMediaBridge } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-media.bridge';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import {
  ContentStudioBrandKitIntegrityError,
  parseVerifiedContentStudioBrandKitRevision,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import {
  DESIGN_RENDER_IMAGE_MAX_BYTES,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// Fixed messages only: never a Media name, path, storage message or Brand
// Kit content. Another organization's Media or Brand Kit revision is a
// plain 404
const notFound = () =>
  new HttpException({ msg: 'Not found.', code: 'CS_NOT_FOUND' }, 404);
const mediaUnavailable = () =>
  new HttpException(
    {
      msg: 'This media item cannot be used in a design.',
      code: 'CS_DESIGN_MEDIA_UNAVAILABLE',
    },
    409
  );
const mediaReadFailed = () =>
  new HttpException(
    {
      msg: 'The media item could not be read safely.',
      code: 'CS_DESIGN_MEDIA_READ_FAILED',
    },
    500
  );
const mediaUnsupported = () =>
  new HttpException(
    {
      msg: 'Only PNG, JPEG and WebP images can be used in a design.',
      code: 'CS_DESIGN_MEDIA_UNSUPPORTED',
    },
    409
  );
const brandIntegrityError = () =>
  new HttpException(
    {
      msg: 'Stored Brand Kit data could not be read safely.',
      code: 'CS_BRAND_KIT_INTEGRITY_ERROR',
    },
    500
  );

// The formats a render decodes (DESIGN_RENDER_IMAGE_FORMATS), by their
// first bytes: PNG, JPEG, and WebP (RIFF....WEBP)
export const isContentStudioDesignImageBytes = (bytes: Buffer) =>
  bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
  (bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP');

// the Design Document image rule (the Content Package media id rule)
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The references a Design Document stores, made by the server so the editor
// never has to supply or trust a hash: an image is a Media id with the
// SHA-256 of the bytes stored for it now, read through the render Media
// bridge (the organization's ready Media, from its own row path); a Brand Kit
// is the exact verified revision of the organization's kit. Read-only: no
// Media, kit or design changes, and no URL, path, content or creator leaves.
// The render verifies image bytes again, and the design service checks the
// Brand Kit reference again, when a revision is saved. Any member may ask
@Injectable()
export class ContentStudioDesignReferenceService {
  constructor(
    private _mediaService: MediaService,
    private _contentStudioRenderMediaBridge: ContentStudioRenderMediaBridge,
    private _contentStudioBrandKitRepository: ContentStudioBrandKitRepository
  ) {}

  async getMediaReference(organizationId: string, mediaId: string) {
    if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) {
      throw notFound();
    }
    const media = await this._mediaService.getMediaByIdForOrganization(
      organizationId,
      mediaId
    );
    if (!media) {
      throw notFound();
    }
    if (media.status !== 'ready') {
      throw mediaUnavailable();
    }
    const bytes =
      await this._contentStudioRenderMediaBridge.readMediaBytesForOrganization(
        organizationId,
        media.id,
        DESIGN_RENDER_IMAGE_MAX_BYTES
      );
    if (!bytes || !bytes.length) {
      throw mediaReadFailed();
    }
    if (!isContentStudioDesignImageBytes(bytes)) {
      throw mediaUnsupported();
    }
    return { mediaId: media.id, sha256: designRenderSha256(bytes) };
  }

  // Exactly the revision asked for, never the kit's latest
  async getBrandKitReference(organizationId: string, revisionId: string) {
    if (typeof revisionId !== 'string' || !UUID.test(revisionId)) {
      throw notFound();
    }
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        organizationId
      );
    if (!brandKit) {
      throw notFound();
    }
    const revision =
      await this._contentStudioBrandKitRepository.getRevisionForBrandKit(
        organizationId,
        brandKit.id,
        revisionId
      );
    if (!revision) {
      throw notFound();
    }
    try {
      parseVerifiedContentStudioBrandKitRevision(revision);
    } catch (err) {
      if (err instanceof ContentStudioBrandKitIntegrityError) {
        throw brandIntegrityError();
      }
      throw err;
    }
    return {
      brandKitId: brandKit.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      contentHash: revision.contentHash,
    };
  }
}
