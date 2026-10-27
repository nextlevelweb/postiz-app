import { GetObjectCommand } from '@aws-sdk/client-s3';
import { constants } from 'fs';
import { open, realpath } from 'fs/promises';
import path from 'path';

// Reads back the exact bytes of a file the Media library stored, for server
// code that has already loaded the Media row for its organization. The only
// input is that row's own `path` (the URL the storage provider returned when
// it saved the file): never a URL, path or key from a request. The location
// is mapped back to the provider's own object only when it has exactly the
// shape that provider writes; anything else is refused. It never fetches the
// URL over HTTP, follows a link out of the upload folder or reads another
// bucket. Errors carry a fixed message only
export interface IStoredMediaReader {
  readStoredMediaBytes(
    storedLocation: string,
    maxBytes: number
  ): Promise<Buffer>;
}

export class StoredMediaReadError extends Error {
  constructor() {
    super('The stored media file could not be read');
    this.name = 'StoredMediaReadError';
  }
}

const refused = () => new StoredMediaReadError();

// One path segment as the providers name files and folders: letters,
// digits, '_' and '-', with dot-separated parts (an extension). No '.', '..',
// empty part, '%' escape, backslash, space or control character
const SEGMENT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
// CloudflareStorage, the R2 uploader and the media processor all write flat
// keys: a random id and an extension
const R2_KEY = /^[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9]{1,16}$/;

// The location must be an absolute URL that parses to itself (so no dot
// segment, escape or backslash was normalized away), on exactly the origin
// of the configured base, without credentials, query or fragment, and start
// with exactly `${base}/` the way the provider builds it. Returns what
// follows that prefix
function relativeToBase(storedLocation: unknown, base: string) {
  if (
    typeof storedLocation !== 'string' ||
    !base ||
    !storedLocation.startsWith(`${base}/`)
  ) {
    throw refused();
  }
  let location: URL;
  let origin: URL;
  try {
    location = new URL(storedLocation);
    origin = new URL(base);
  } catch {
    throw refused();
  }
  if (
    location.href !== storedLocation ||
    location.origin !== origin.origin ||
    location.protocol !== origin.protocol ||
    location.username ||
    location.password ||
    location.search ||
    location.hash
  ) {
    throw refused();
  }
  return storedLocation.slice(base.length + 1);
}

// Whether `target` is `root` itself or below it, by path semantics
// ('/uploads-private' is not below '/uploads')
export const isPathInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      relative.split(path.sep)[0] !== '..')
  );
};

// A copy of another installation's upload folder, for Media rows whose
// path was written there (a local clone of that installation's database):
// `${url}/<folders>/<file>` is read as `<directory>/<folders>/<file>` with
// exactly the checks of the own upload folder. Local development only; it is
// configured explicitly and nothing is ever fetched from that URL
export interface StoredMediaMirror {
  url: string;
  directory: string;
}

// LocalStorage: `${FRONTEND_URL}/uploads/<folders>/<file>` is the file
// `<UPLOAD_DIRECTORY>/<folders>/<file>`. The file's real path, links
// resolved, must still be inside the real upload directory, and it is opened
// without following a link
export class LocalStoredMediaReader implements IStoredMediaReader {
  constructor(
    private _uploadDirectory: string | undefined,
    private _frontendUrl: string | undefined,
    private _mirror?: StoredMediaMirror
  ) {}

  async readStoredMediaBytes(storedLocation: string, maxBytes: number) {
    const mirror = this._mirror;
    if (
      mirror &&
      mirror.url &&
      path.isAbsolute(mirror.directory || '') &&
      typeof storedLocation === 'string' &&
      storedLocation.startsWith(`${mirror.url}/`)
    ) {
      return readFromFolder(
        mirror.directory,
        relativeToBase(storedLocation, mirror.url),
        maxBytes
      );
    }
    if (
      !this._uploadDirectory ||
      !path.isAbsolute(this._uploadDirectory) ||
      !this._frontendUrl
    ) {
      throw refused();
    }
    return readFromFolder(
      this._uploadDirectory,
      relativeToBase(storedLocation, `${this._frontendUrl}/uploads`),
      maxBytes
    );
  }
}

async function readFromFolder(
  directory: string,
  relative: string,
  maxBytes: number
) {
  const segments = relative.split('/');
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    throw refused();
  }

  let file: Buffer;
  try {
    const root = await realpath(directory);
    const target = await realpath(path.join(root, ...segments));
    if (target === root || !isPathInside(root, target)) {
      throw refused();
    }
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) {
        throw refused();
      }
      file = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    throw refused();
  }
  if (file.length > maxBytes) {
    throw refused();
  }
  return file;
}

// The parts of an S3 client used here
export interface StoredMediaS3Client {
  send(command: GetObjectCommand): Promise<{
    ContentLength?: number;
    Body?: { transformToByteArray(): Promise<Uint8Array> };
  }>;
}

// CloudflareStorage: `${CLOUDFLARE_BUCKET_URL}/<key>` is the object <key>
// of CLOUDFLARE_BUCKETNAME, read through the authenticated S3 API (never the
// public URL). Only the flat keys the providers write are accepted
export class CloudflareStoredMediaReader implements IStoredMediaReader {
  constructor(
    private _client: () => StoredMediaS3Client,
    private _bucketName: string | undefined,
    private _bucketUrl: string | undefined
  ) {}

  async readStoredMediaBytes(storedLocation: string, maxBytes: number) {
    if (!this._bucketName || !this._bucketUrl) {
      throw refused();
    }
    const key = relativeToBase(storedLocation, this._bucketUrl);
    if (!R2_KEY.test(key)) {
      throw refused();
    }
    let bytes: Uint8Array;
    try {
      const object = await this._client().send(
        new GetObjectCommand({ Bucket: this._bucketName, Key: key })
      );
      if (
        !object.Body ||
        (typeof object.ContentLength === 'number' &&
          object.ContentLength > maxBytes)
      ) {
        throw refused();
      }
      bytes = await object.Body.transformToByteArray();
    } catch {
      throw refused();
    }
    if (bytes.length > maxBytes) {
      throw refused();
    }
    return Buffer.from(bytes);
  }
}

// A storage provider this reader does not know: nothing can be read
export class UnavailableStoredMediaReader implements IStoredMediaReader {
  async readStoredMediaBytes(): Promise<Buffer> {
    throw refused();
  }
}
