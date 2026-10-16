import { Injectable } from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';

// the Design Document image rule (the Content Package media id rule)
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// A fixed message only: never a path, key or storage message
export class ContentStudioRenderMediaStorageError extends Error {
  constructor() {
    super('The rendered design could not be stored');
    this.name = 'ContentStudioRenderMediaStorageError';
  }
}

// The only place design renders touch Postiz Media. It reads the exact
// bytes of a Media of the organization by its id: the row is found by the
// organization-scoped lookup first, and only then is the file read back
// through the storage provider from that row's own path (no URL, path or
// key ever comes from a caller, and nothing is fetched over HTTP). It stores
// a rendered PNG as an ordinary Media of the organization through the Media
// service, the way uploads are stored. Another organization's, deleted,
// unfinished or missing Media all read as null. Nothing here knows designs,
// fonts or rendering
@Injectable()
export class ContentStudioRenderMediaBridge {
  private _reader = StoredAssetFactory.createStoredMediaReader();

  constructor(private _mediaService: MediaService) {}

  async readMediaBytesForOrganization(
    organizationId: string,
    mediaId: string,
    maxBytes: number
  ): Promise<Buffer | null> {
    if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) {
      return null;
    }
    const media = await this._mediaService.getMediaByIdForOrganization(
      organizationId,
      mediaId
    );
    if (!media || media.status !== 'ready') {
      return null;
    }
    try {
      return await this._reader.readStoredMediaBytes(media.path, maxBytes);
    } catch {
      return null;
    }
  }

  // One new Media for one rendered PNG, named after the render only (no
  // design name or text). Media rows have no creator, as for every upload
  async createRenderedMedia(input: {
    organizationId: string;
    renderId: string;
    bytes: Buffer;
  }) {
    if (
      !UUID.test(input.renderId) ||
      !Buffer.isBuffer(input.bytes) ||
      !input.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw new ContentStudioRenderMediaStorageError();
    }
    let media: { id: string };
    try {
      media = await this._mediaService.saveGeneratedFile(
        input.organizationId,
        input.bytes,
        'image/png',
        'png',
        `content-studio-design-${input.renderId.slice(0, 8)}.png`
      );
    } catch {
      throw new ContentStudioRenderMediaStorageError();
    }
    return { id: media.id };
  }
}
