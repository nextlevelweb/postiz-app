import { S3Client } from '@aws-sdk/client-s3';
import {
  CloudflareStoredMediaReader,
  IStoredMediaReader,
  LocalStoredMediaReader,
  UnavailableStoredMediaReader,
} from './stored.media.reader';
import {
  CloudflareContentStudioPrivateFontStorage,
  ContentStudioPrivateFontStorage,
  LocalContentStudioPrivateFontStorage,
  UnavailableContentStudioPrivateFontStorage,
} from './content-studio.private-font.storage';

// Server-side access to stored files, for the provider STORAGE_PROVIDER names
// (as UploadFactory chooses it). Nothing is checked or connected here, so the
// app starts whatever is configured; a missing setting fails on use
export class StoredAssetFactory {
  // Reads back the bytes of a stored Media file from its Media row's path,
  // through the same provider that stored it (see stored.media.reader)
  static createStoredMediaReader(): IStoredMediaReader {
    switch (process.env.STORAGE_PROVIDER || 'local') {
      case 'local':
        return new LocalStoredMediaReader(
          process.env.UPLOAD_DIRECTORY,
          process.env.FRONTEND_URL,
          // local development with a clone of another installation's data
          // only (scripts/content-studio-dev-db.sh sets both); unset in
          // every deployment
          process.env.CONTENT_STUDIO_MEDIA_MIRROR_URL &&
          process.env.CONTENT_STUDIO_MEDIA_MIRROR_DIRECTORY
            ? {
                url: process.env.CONTENT_STUDIO_MEDIA_MIRROR_URL,
                directory: process.env.CONTENT_STUDIO_MEDIA_MIRROR_DIRECTORY,
              }
            : undefined
        );
      case 'cloudflare':
        return new CloudflareStoredMediaReader(
          StoredAssetFactory.cloudflareClient,
          process.env.CLOUDFLARE_BUCKETNAME,
          process.env.CLOUDFLARE_BUCKET_URL
        );
      default:
        return new UnavailableStoredMediaReader();
    }
  }

  // Content Studio render fonts are kept apart from Media, in private
  // storage of the active provider: CONTENT_STUDIO_PRIVATE_ASSET_DIRECTORY for
  // local storage, CONTENT_STUDIO_PRIVATE_R2_BUCKET (a separate bucket with
  // public access disabled) for Cloudflare. Without it, using fonts fails
  static createContentStudioPrivateFontStorage(): ContentStudioPrivateFontStorage {
    switch (process.env.STORAGE_PROVIDER || 'local') {
      case 'local':
        return new LocalContentStudioPrivateFontStorage(
          process.env.CONTENT_STUDIO_PRIVATE_ASSET_DIRECTORY,
          process.env.UPLOAD_DIRECTORY
        );
      case 'cloudflare':
        return new CloudflareContentStudioPrivateFontStorage(
          StoredAssetFactory.cloudflareClient,
          process.env.CONTENT_STUDIO_PRIVATE_R2_BUCKET,
          process.env.CLOUDFLARE_BUCKETNAME
        );
      default:
        return new UnavailableContentStudioPrivateFontStorage();
    }
  }

  // The authenticated R2 S3 API with the existing Cloudflare credentials,
  // created on first use. Checksums only where the API requires them, which
  // R2 accepts (CloudflareStorage strips them by hand instead)
  private static _cloudflareClient: S3Client | null = null;
  private static cloudflareClient() {
    if (!StoredAssetFactory._cloudflareClient) {
      StoredAssetFactory._cloudflareClient = new S3Client({
        endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        region: process.env.CLOUDFLARE_REGION || 'auto',
        credentials: {
          accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY!,
          secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY!,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    }
    return StoredAssetFactory._cloudflareClient;
  }
}
