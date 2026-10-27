import { GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CloudflareStoredMediaReader,
  isPathInside,
  LocalStoredMediaReader,
  StoredMediaReadError,
  UnavailableStoredMediaReader,
} from '@gitroom/nestjs-libraries/upload/stored.media.reader';

const FRONTEND = 'https://app.example.com';
const MAX = 1024;

// A temporary upload directory laid out like LocalStorage writes it, with a
// secret file beside it that no Media path may reach
const setupLocal = () => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'p405-media-'))
  );
  const uploads = path.join(base, 'uploads');
  fs.mkdirSync(path.join(uploads, '2026', '10', '16'), { recursive: true });
  const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  fs.writeFileSync(path.join(uploads, '2026/10/16/abc123.png'), photo);
  fs.writeFileSync(path.join(base, 'secret.txt'), 'SECRET_OUTSIDE_UPLOADS');
  const reader = new LocalStoredMediaReader(uploads, FRONTEND);
  return { base, uploads, photo, reader };
};

const refusedLocal = async (
  reader: LocalStoredMediaReader,
  location: string,
  max = MAX
) => {
  const error = await reader.readStoredMediaBytes(location, max).then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(StoredMediaReadError);
  expect((error as Error).message).toBe(
    'The stored media file could not be read'
  );
};

// UX review 02: a local clone of another installation keeps that
// installation's Media paths. With a mirror (a copy of its upload folder,
// configured explicitly for local development), those paths are read from
// the copy with exactly the checks of the own upload folder. Nothing is ever
// fetched over HTTP, so loopback, private and redirecting addresses cannot
// be reached through it
const MIRRORED = 'https://socialmedia.example.org/uploads';
const setupMirror = () => {
  const local = setupLocal();
  const mirror = path.join(local.base, 'prod-uploads');
  fs.mkdirSync(path.join(mirror, '2026', '08', '14'), { recursive: true });
  const old = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  fs.writeFileSync(path.join(mirror, '2026/08/14/bd075ad4.jpg'), old);
  fs.symlinkSync(
    path.join(local.base, 'secret.txt'),
    path.join(mirror, '2026/08/14/link.png')
  );
  const reader = new LocalStoredMediaReader(local.uploads, FRONTEND, {
    url: MIRRORED,
    directory: mirror,
  });
  return { ...local, mirror, old, reader };
};

describe('LocalStoredMediaReader with a mirror of another installation', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network');
    });
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('MM1 reads a Media path of the mirrored installation from the local copy', async () => {
    const { reader, old } = setupMirror();
    const bytes = await reader.readStoredMediaBytes(
      `${MIRRORED}/2026/08/14/bd075ad4.jpg`,
      MAX
    );
    expect(bytes.equals(old)).toBe(true);
  });

  it('MM2 still reads its own uploads as before', async () => {
    const { reader, photo } = setupMirror();
    const bytes = await reader.readStoredMediaBytes(
      `${FRONTEND}/uploads/2026/10/16/abc123.png`,
      MAX
    );
    expect(bytes.equals(photo)).toBe(true);
  });

  it('MM3 refuses loopback, private, metadata and other hosts: no URL is fetched', async () => {
    const { reader } = setupMirror();
    for (const location of [
      'http://127.0.0.1/uploads/2026/08/14/bd075ad4.jpg',
      'http://localhost:3000/uploads/2026/08/14/bd075ad4.jpg',
      'http://10.0.0.5/uploads/2026/08/14/bd075ad4.jpg',
      'http://169.254.169.254/latest/meta-data/iam',
      'http://[::1]/uploads/2026/08/14/bd075ad4.jpg',
      'http://socialmedia.example.org/uploads/2026/08/14/bd075ad4.jpg',
      'https://socialmedia.example.org.evil.test/uploads/2026/08/14/bd075ad4.jpg',
      'https://evil.test/redirect?to=https://socialmedia.example.org/uploads/a.png',
    ]) {
      await refusedLocal(reader, location);
    }
  });

  it('MM4 refuses malformed paths, traversal and links out of the copy', async () => {
    const { reader } = setupMirror();
    for (const location of [
      'not a url',
      `${MIRRORED}`,
      `${MIRRORED}/`,
      `${MIRRORED}/../secret.txt`,
      `${MIRRORED}/2026/08/14/%2e%2e/secret.txt`,
      `${MIRRORED}/2026/08/14/bd075ad4.jpg?x=1`,
      `${MIRRORED}/2026/08/14/bd075ad4.jpg#x`,
      `${MIRRORED}/2026/08/14/link.png`,
      `${MIRRORED}/2026/08/14/missing.png`,
    ]) {
      await refusedLocal(reader, location);
    }
  });

  it('MM5 holds a mirrored file to the same size limit', async () => {
    const { reader } = setupMirror();
    await refusedLocal(reader, `${MIRRORED}/2026/08/14/bd075ad4.jpg`, 3);
  });

  it('MM6 ignores a mirror without an absolute directory', async () => {
    const { uploads, base } = setupLocal();
    fs.mkdirSync(path.join(base, 'rel', '2026'), { recursive: true });
    const reader = new LocalStoredMediaReader(uploads, FRONTEND, {
      url: MIRRORED,
      directory: 'rel',
    });
    await refusedLocal(reader, `${MIRRORED}/2026/x.png`);
  });
});

describe('LocalStoredMediaReader', () => {
  it('LST1/MR4/MR10 maps the exact stored URL to its file and returns its exact bytes', async () => {
    const { reader, photo } = setupLocal();
    const bytes = await reader.readStoredMediaBytes(
      `${FRONTEND}/uploads/2026/10/16/abc123.png`,
      MAX
    );
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.equals(photo)).toBe(true);
  });

  it('LST2 refuses another origin, scheme or port', async () => {
    const { reader } = setupLocal();
    for (const origin of [
      'http://app.example.com',
      'https://evil.example.com',
      'https://app.example.com:8443',
      'https://app.example.com.evil.test',
      'https://user:pass@app.example.com',
    ]) {
      await refusedLocal(reader, `${origin}/uploads/2026/10/16/abc123.png`);
    }
  });

  it('LST3 refuses anything but the /uploads/ prefix', async () => {
    const { reader } = setupLocal();
    for (const location of [
      `${FRONTEND}/upload/2026/10/16/abc123.png`,
      `${FRONTEND}/uploadsx/2026/10/16/abc123.png`,
      `${FRONTEND}/api/uploads/2026/10/16/abc123.png`,
      `${FRONTEND}/uploads`,
      `${FRONTEND}/uploads/`,
      `/uploads/2026/10/16/abc123.png`,
      `uploads/2026/10/16/abc123.png`,
    ]) {
      await refusedLocal(reader, location);
    }
  });

  it('LST4/LST5/LST6/MR5 refuses dot segments, escapes and backslashes, decoded or not', async () => {
    const { reader } = setupLocal();
    for (const location of [
      `${FRONTEND}/uploads/../secret.txt`,
      `${FRONTEND}/uploads/2026/../../secret.txt`,
      `${FRONTEND}/uploads/2026/10/16/../16/abc123.png`,
      `${FRONTEND}/uploads/./2026/10/16/abc123.png`,
      `${FRONTEND}/uploads/%2e%2e/secret.txt`,
      `${FRONTEND}/uploads/%2E%2E/secret.txt`,
      `${FRONTEND}/uploads/2026%2F10%2F16%2Fabc123.png`,
      `${FRONTEND}/uploads/..%2fsecret.txt`,
      `${FRONTEND}/uploads/..%5csecret.txt`,
      `${FRONTEND}/uploads/..\\secret.txt`,
      `${FRONTEND}/uploads\\..\\secret.txt`,
      `${FRONTEND}/uploads//2026/10/16/abc123.png`,
      `${FRONTEND}/uploads/2026/10/16/abc%31%32%33.png`,
    ]) {
      await refusedLocal(reader, location);
    }
  });

  it('LST7/LST8 refuses an absolute file path, another scheme and NUL', async () => {
    const { reader, base } = setupLocal();
    for (const location of [
      path.join(base, 'secret.txt'),
      `file://${path.join(base, 'secret.txt')}`,
      `${FRONTEND}/uploads/2026/10/16/abc123.png\u0000`,
      `${FRONTEND}/uploads/2026/10/16/abc123.png%00`,
      `${FRONTEND}/uploads/2026/10/16/abc123.png?x=1`,
      `${FRONTEND}/uploads/2026/10/16/abc123.png#x`,
    ]) {
      await refusedLocal(reader, location);
    }
  });

  it('LST9/MR6 refuses a file or folder that links out of the upload directory', async () => {
    const { reader, uploads, base } = setupLocal();
    fs.symlinkSync(
      path.join(base, 'secret.txt'),
      path.join(uploads, '2026/10/16/link.png')
    );
    fs.symlinkSync(base, path.join(uploads, 'escape'));
    await refusedLocal(reader, `${FRONTEND}/uploads/2026/10/16/link.png`);
    await refusedLocal(reader, `${FRONTEND}/uploads/escape/secret.txt`);
  });

  it('refuses a missing file, a folder, a file over the limit and a missing configuration', async () => {
    const { reader, uploads } = setupLocal();
    await refusedLocal(reader, `${FRONTEND}/uploads/2026/10/16/missing.png`);
    await refusedLocal(reader, `${FRONTEND}/uploads/2026/10/16`);
    await refusedLocal(reader, `${FRONTEND}/uploads/2026/10/16/abc123.png`, 4);
    for (const unconfigured of [
      new LocalStoredMediaReader(undefined, FRONTEND),
      new LocalStoredMediaReader('relative/uploads', FRONTEND),
      new LocalStoredMediaReader(uploads, undefined),
    ]) {
      await refusedLocal(
        unconfigured,
        `${FRONTEND}/uploads/2026/10/16/abc123.png`
      );
    }
  });

  it('compares folders by path, not by text prefix', () => {
    expect(isPathInside('/srv/uploads', '/srv/uploads/a/b')).toBe(true);
    expect(isPathInside('/srv/uploads', '/srv/uploads')).toBe(true);
    expect(isPathInside('/srv/uploads', '/srv/uploads-private/a')).toBe(false);
    expect(isPathInside('/srv/uploads', '/srv')).toBe(false);
    expect(isPathInside('/srv/uploads', '/etc/passwd')).toBe(false);
  });
});

const BUCKET_URL = 'https://media.example.com';
const BUCKET = 'postiz-public';

const fakeS3 = (bytes = Buffer.from('R2_BYTES'), length?: number) => {
  const commands: GetObjectCommand[] = [];
  const client = {
    send: jest.fn(async (command: GetObjectCommand) => {
      commands.push(command);
      return {
        ContentLength: length ?? bytes.length,
        Body: { transformToByteArray: async () => new Uint8Array(bytes) },
      };
    }),
  };
  return { client, commands };
};

const refusedR2 = async (
  reader: CloudflareStoredMediaReader,
  location: string,
  max = MAX
) => {
  await expect(reader.readStoredMediaBytes(location, max)).rejects.toThrow(
    StoredMediaReadError
  );
};

describe('CloudflareStoredMediaReader', () => {
  it('R2T1/R2T6/R2T7/MR7 reads the exact key of the public Media bucket through the S3 API', async () => {
    const { client, commands } = fakeS3();
    const reader = new CloudflareStoredMediaReader(
      () => client,
      BUCKET,
      BUCKET_URL
    );
    const bytes = await reader.readStoredMediaBytes(
      `${BUCKET_URL}/AbC123xYz9.png`,
      MAX
    );
    expect(bytes.equals(Buffer.from('R2_BYTES'))).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetObjectCommand);
    expect(commands[0].input).toEqual({
      Bucket: BUCKET,
      Key: 'AbC123xYz9.png',
    });
  });

  it('R2T2/R2T3/MR8 refuses another host, scheme and look-alike prefixes before any request', async () => {
    const { client } = fakeS3();
    const reader = new CloudflareStoredMediaReader(
      () => client,
      BUCKET,
      BUCKET_URL
    );
    for (const location of [
      'https://evil.example.com/AbC123xYz9.png',
      'http://media.example.com/AbC123xYz9.png',
      'https://media.example.com.evil.test/AbC123xYz9.png',
      'https://media.example.comx/AbC123xYz9.png',
      'https://user@media.example.com/AbC123xYz9.png',
      'AbC123xYz9.png',
    ]) {
      await refusedR2(reader, location);
    }
    expect(client.send).not.toHaveBeenCalled();
  });

  it('R2T4/R2T5/MR9 refuses an empty, nested or escaped key, a query and a fragment', async () => {
    const { client } = fakeS3();
    const reader = new CloudflareStoredMediaReader(
      () => client,
      BUCKET,
      BUCKET_URL
    );
    for (const location of [
      `${BUCKET_URL}/`,
      `${BUCKET_URL}/a/b.png`,
      `${BUCKET_URL}/../b.png`,
      `${BUCKET_URL}/%2e%2e.png`,
      `${BUCKET_URL}/AbC123xYz9.png?versionId=1`,
      `${BUCKET_URL}/AbC123xYz9.png#x`,
      `${BUCKET_URL}/noextension`,
      `${BUCKET_URL}/.png`,
    ]) {
      await refusedR2(reader, location);
    }
    expect(client.send).not.toHaveBeenCalled();
  });

  it('refuses an object over the limit, a failed request and a missing configuration', async () => {
    const big = fakeS3(Buffer.alloc(10), MAX + 1);
    await refusedR2(
      new CloudflareStoredMediaReader(() => big.client, BUCKET, BUCKET_URL),
      `${BUCKET_URL}/AbC123xYz9.png`
    );
    const failing = {
      send: jest.fn().mockRejectedValue(new Error('R2_PRIVATE_MARKER')),
    };
    const error = await new CloudflareStoredMediaReader(
      () => failing,
      BUCKET,
      BUCKET_URL
    )
      .readStoredMediaBytes(`${BUCKET_URL}/AbC123xYz9.png`, MAX)
      .catch((err: Error) => err);
    expect((error as Error).message).not.toContain('R2_PRIVATE_MARKER');
    await refusedR2(
      new CloudflareStoredMediaReader(() => big.client, undefined, BUCKET_URL),
      `${BUCKET_URL}/AbC123xYz9.png`
    );
    await refusedR2(
      new CloudflareStoredMediaReader(() => big.client, BUCKET, undefined),
      `${BUCKET_URL}/AbC123xYz9.png`
    );
  });

  it('R2T8/MR11 never fetches over HTTP', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { client } = fakeS3();
    await new CloudflareStoredMediaReader(
      () => client,
      BUCKET,
      BUCKET_URL
    ).readStoredMediaBytes(`${BUCKET_URL}/AbC123xYz9.png`, MAX);
    const { reader } = setupLocal();
    await reader.readStoredMediaBytes(
      `${FRONTEND}/uploads/2026/10/16/abc123.png`,
      MAX
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const source = fs.readFileSync(
      path.join(__dirname, 'stored.media.reader.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\bfetch\(|axios|undici|from 'https?'/);
  });

  it('reads nothing for an unknown storage provider', async () => {
    await expect(
      new UnavailableStoredMediaReader().readStoredMediaBytes()
    ).rejects.toThrow(StoredMediaReadError);
  });
});
