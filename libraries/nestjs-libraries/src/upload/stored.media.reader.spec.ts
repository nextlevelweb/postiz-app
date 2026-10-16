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
