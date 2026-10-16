import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { link, mkdir, open, realpath, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { isPathInside } from '@gitroom/nestjs-libraries/upload/stored.media.reader';

// Private storage for Content Studio render fonts: the exact bytes of one
// uploaded font file, written once under a key the server generates and
// read back by that key. It is not Media and not the upload folder or the
// public bucket: nothing here builds a URL, and no route serves these files.
// Keys are `fonts/<organizationId>/<fontAssetId>.<ttf|otf>` (lowercase
// UUIDs); a key of another organization, or of any other shape, is refused
// before storage is touched. Objects are never overwritten and there is no
// delete. The configuration is checked when storage is first used, never at
// startup: without it every call fails with UNAVAILABLE and nothing falls
// back to another place. Errors carry a code and a fixed message only (no
// path, bucket, key or provider message)

export const PRIVATE_FONT_EXTENSIONS = ['ttf', 'otf'] as const;
export type ContentStudioPrivateFontExtension =
  (typeof PRIVATE_FONT_EXTENSIONS)[number];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOWER_UUID = new RegExp(`^${UUID}$`);
const STORAGE_KEY = new RegExp(`^fonts/(${UUID})/(${UUID})\\.(ttf|otf)$`);
// R2 bucket names: 3-63 lowercase letters, digits and hyphens
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// where the font keys live inside the private bucket
const R2_PREFIX = 'content-studio/';

export type ContentStudioPrivateFontStorageErrorCode =
  // no usable private storage is configured for the active provider
  | 'UNAVAILABLE'
  // the key is not a font key of this organization
  | 'INVALID_KEY'
  // nothing is stored under the key
  | 'NOT_FOUND'
  // something is already stored under the key; it was not replaced
  | 'CONFLICT'
  // the storage itself failed
  | 'FAILED';

const ERROR_MESSAGES: Record<ContentStudioPrivateFontStorageErrorCode, string> =
  {
    UNAVAILABLE: 'Private font storage is not configured',
    INVALID_KEY: 'The private font storage key is invalid',
    NOT_FOUND: 'The private font file is not stored',
    CONFLICT: 'A private font file is already stored under this key',
    FAILED: 'The private font storage failed',
  };

export class ContentStudioPrivateFontStorageError extends Error {
  constructor(readonly code: ContentStudioPrivateFontStorageErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioPrivateFontStorageError';
  }
}

const failure = (code: ContentStudioPrivateFontStorageErrorCode) =>
  new ContentStudioPrivateFontStorageError(code);

export interface ContentStudioPrivateFontStorage {
  writeFontAsset(input: {
    organizationId: string;
    assetId: string;
    bytes: Uint8Array;
    extension: ContentStudioPrivateFontExtension;
  }): Promise<{ storageKey: string }>;
  readFontAsset(input: {
    organizationId: string;
    storageKey: string;
  }): Promise<Buffer>;
}

// The key of one asset, built only from server-side ids
export function contentStudioPrivateFontStorageKey(
  organizationId: string,
  assetId: string,
  extension: ContentStudioPrivateFontExtension
) {
  if (
    !LOWER_UUID.test(organizationId) ||
    !LOWER_UUID.test(assetId) ||
    !(PRIVATE_FONT_EXTENSIONS as readonly string[]).includes(extension)
  ) {
    throw failure('INVALID_KEY');
  }
  return `fonts/${organizationId}/${assetId}.${extension}`;
}

// A stored key, accepted only when it is exactly a font key of this
// organization
export function checkContentStudioPrivateFontStorageKey(
  organizationId: string,
  storageKey: unknown
) {
  const match =
    typeof storageKey === 'string' ? STORAGE_KEY.exec(storageKey) : null;
  if (!match || match[1] !== organizationId) {
    throw failure('INVALID_KEY');
  }
  return storageKey as string;
}

// The real path of a folder that may not exist yet: its nearest existing
// ancestor resolved, links included, with the rest appended
async function realPathOf(folder: string): Promise<string> {
  const absolute = path.resolve(folder);
  try {
    return await realpath(absolute);
  } catch (error) {
    const parent = path.dirname(absolute);
    if (
      (error as NodeJS.ErrnoException)?.code !== 'ENOENT' ||
      parent === absolute
    ) {
      throw error;
    }
    return path.join(await realPathOf(parent), path.basename(absolute));
  }
}

const errorCode = (error: unknown) =>
  error instanceof ContentStudioPrivateFontStorageError ? error.code : 'FAILED';

// STORAGE_PROVIDER=local: CONTENT_STUDIO_PRIVATE_ASSET_DIRECTORY, an
// absolute directory on a persistent volume that the web server does not
// serve. It must not be, contain or lie inside UPLOAD_DIRECTORY (which is
// public under /uploads), compared by real paths. A file is written to a
// temporary name and linked to its final name, which fails if that exists,
// so a font is never replaced or seen half written. Reads accept only the
// key's own path inside the root, with no link anywhere on the way
export class LocalContentStudioPrivateFontStorage
  implements ContentStudioPrivateFontStorage
{
  private _root: Promise<string> | null = null;

  constructor(
    private _privateDirectory: string | undefined,
    private _uploadDirectory: string | undefined
  ) {}

  private root() {
    if (!this._root) {
      const root = this.checkedRoot();
      // a failed check is not kept: the next call checks again
      root.catch(() => {
        this._root = null;
      });
      this._root = root;
    }
    return this._root;
  }

  private async checkedRoot() {
    const configured = this._privateDirectory;
    const uploads = this._uploadDirectory;
    if (
      !configured ||
      !uploads ||
      configured.includes('\u0000') ||
      uploads.includes('\u0000') ||
      !path.isAbsolute(configured) ||
      !path.isAbsolute(uploads) ||
      path.resolve(configured) === path.parse(path.resolve(configured)).root
    ) {
      throw failure('UNAVAILABLE');
    }
    // the roots are compared as given and as their real paths
    const disjoint = (a: string, b: string) =>
      !isPathInside(a, b) && !isPathInside(b, a);
    if (!disjoint(path.resolve(configured), path.resolve(uploads))) {
      throw failure('UNAVAILABLE');
    }
    let root: string;
    try {
      const realUploads = await realPathOf(uploads);
      // checked before the folder is created (a link on the way could lead
      // into the upload directory) and again once it exists
      if (!disjoint(await realPathOf(configured), realUploads)) {
        throw failure('UNAVAILABLE');
      }
      await mkdir(configured, { recursive: true, mode: 0o700 });
      root = await realpath(configured);
      if (!disjoint(root, realUploads)) {
        throw failure('UNAVAILABLE');
      }
    } catch {
      throw failure('UNAVAILABLE');
    }
    return root;
  }

  async writeFontAsset(input: {
    organizationId: string;
    assetId: string;
    bytes: Uint8Array;
    extension: ContentStudioPrivateFontExtension;
  }) {
    const storageKey = contentStudioPrivateFontStorageKey(
      input.organizationId,
      input.assetId,
      input.extension
    );
    const root = await this.root();
    const folder = path.join(root, 'fonts', input.organizationId);
    let temporary: string | null = null;
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if ((await realpath(folder)) !== folder) {
        throw failure('FAILED');
      }
      temporary = path.join(folder, `.${randomUUID()}.tmp`);
      await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
      await link(temporary, path.join(root, storageKey));
    } catch (error) {
      throw failure(
        (error as NodeJS.ErrnoException)?.code === 'EEXIST'
          ? 'CONFLICT'
          : errorCode(error)
      );
    } finally {
      if (temporary) {
        await unlink(temporary).catch(() => undefined);
      }
    }
    return { storageKey };
  }

  async readFontAsset(input: { organizationId: string; storageKey: string }) {
    const storageKey = checkContentStudioPrivateFontStorageKey(
      input.organizationId,
      input.storageKey
    );
    const root = await this.root();
    const file = path.join(root, storageKey);
    try {
      // a link anywhere below the root makes the real path differ
      if ((await realpath(file)) !== file) {
        throw failure('NOT_FOUND');
      }
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        if (!(await handle.stat()).isFile()) {
          throw failure('NOT_FOUND');
        }
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw failure(
        (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? 'NOT_FOUND'
          : errorCode(error)
      );
    }
  }
}

// The parts of an S3 client used here
export interface PrivateFontS3Client {
  send(command: PutObjectCommand | GetObjectCommand): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
  }>;
}

const statusOf = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;

// STORAGE_PROVIDER=cloudflare: CONTENT_STUDIO_PRIVATE_R2_BUCKET, a separate
// R2 bucket reached with the existing Cloudflare account credentials through
// the authenticated S3 API only. It must differ from CLOUDFLARE_BUCKETNAME,
// whose objects are public through CLOUDFLARE_BUCKET_URL, and that URL is
// never used here. The operator must keep public access (r2.dev and any
// custom domain) disabled on that bucket: the S3 API cannot tell, so this
// code does not pretend to check it. Writes are conditional
// (If-None-Match: *), which R2 applies atomically, so an existing object is
// never replaced
export class CloudflareContentStudioPrivateFontStorage
  implements ContentStudioPrivateFontStorage
{
  constructor(
    private _client: () => PrivateFontS3Client,
    private _privateBucket: string | undefined,
    private _publicBucket: string | undefined
  ) {}

  private bucket() {
    const bucket = this._privateBucket;
    if (
      !bucket ||
      !R2_BUCKET.test(bucket) ||
      !this._publicBucket ||
      bucket === this._publicBucket
    ) {
      throw failure('UNAVAILABLE');
    }
    return bucket;
  }

  async writeFontAsset(input: {
    organizationId: string;
    assetId: string;
    bytes: Uint8Array;
    extension: ContentStudioPrivateFontExtension;
  }) {
    const storageKey = contentStudioPrivateFontStorageKey(
      input.organizationId,
      input.assetId,
      input.extension
    );
    const bucket = this.bucket();
    try {
      await this._client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: R2_PREFIX + storageKey,
          Body: Buffer.from(input.bytes),
          ContentType: `font/${input.extension}`,
          IfNoneMatch: '*',
        })
      );
    } catch (error) {
      throw failure(statusOf(error) === 412 ? 'CONFLICT' : 'FAILED');
    }
    return { storageKey };
  }

  async readFontAsset(input: { organizationId: string; storageKey: string }) {
    const storageKey = checkContentStudioPrivateFontStorageKey(
      input.organizationId,
      input.storageKey
    );
    const bucket = this.bucket();
    try {
      const object = await this._client().send(
        new GetObjectCommand({ Bucket: bucket, Key: R2_PREFIX + storageKey })
      );
      if (!object.Body) {
        throw failure('NOT_FOUND');
      }
      return Buffer.from(await object.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof ContentStudioPrivateFontStorageError) {
        throw error;
      }
      throw failure(
        statusOf(error) === 404 || (error as Error)?.name === 'NoSuchKey'
          ? 'NOT_FOUND'
          : 'FAILED'
      );
    }
  }
}

// A storage provider without private font storage
export class UnavailableContentStudioPrivateFontStorage
  implements ContentStudioPrivateFontStorage
{
  async writeFontAsset(): Promise<{ storageKey: string }> {
    throw failure('UNAVAILABLE');
  }

  async readFontAsset(): Promise<Buffer> {
    throw failure('UNAVAILABLE');
  }
}
