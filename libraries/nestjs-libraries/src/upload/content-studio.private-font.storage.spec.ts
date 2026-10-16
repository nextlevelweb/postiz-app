import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CloudflareContentStudioPrivateFontStorage,
  contentStudioPrivateFontStorageKey,
  ContentStudioPrivateFontStorageError,
  LocalContentStudioPrivateFontStorage,
  UnavailableContentStudioPrivateFontStorage,
} from '@gitroom/nestjs-libraries/upload/content-studio.private-font.storage';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';
import {
  CloudflareStoredMediaReader,
  LocalStoredMediaReader,
  UnavailableStoredMediaReader,
} from '@gitroom/nestjs-libraries/upload/stored.media.reader';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const ASSET_2 = '44444444-4444-4444-8444-444444444444';
const FONT = Buffer.from('\u0000\u0001\u0000\u0000FONT_BYTES', 'latin1');

const codeOf = async (run: () => Promise<unknown>) => {
  const error = await run().then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(ContentStudioPrivateFontStorageError);
  return (error as ContentStudioPrivateFontStorageError).code;
};

const tempBase = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p405-fonts-')));

// a private root and a public upload directory side by side
const setupLocal = () => {
  const base = tempBase();
  const uploads = path.join(base, 'uploads');
  fs.mkdirSync(uploads);
  const root = path.join(base, 'uploads-private');
  return {
    base,
    uploads,
    root,
    storage: new LocalContentStudioPrivateFontStorage(root, uploads),
  };
};

const write = (
  storage:
    | LocalContentStudioPrivateFontStorage
    | CloudflareContentStudioPrivateFontStorage,
  extra: Record<string, unknown> = {}
) =>
  storage.writeFontAsset({
    organizationId: ORG,
    assetId: ASSET,
    bytes: FONT,
    extension: 'ttf',
    ...extra,
  } as never);

describe('private font storage keys', () => {
  it('LP1/LP2/PS1 are built from server ids only', () => {
    expect(contentStudioPrivateFontStorageKey(ORG, ASSET, 'ttf')).toBe(
      `fonts/${ORG}/${ASSET}.ttf`
    );
    expect(contentStudioPrivateFontStorageKey(ORG, ASSET, 'otf')).toBe(
      `fonts/${ORG}/${ASSET}.otf`
    );
    for (const [org, asset, ext] of [
      ['../x', ASSET, 'ttf'],
      [ORG, '../../etc/passwd', 'ttf'],
      [ORG, 'ABCDEF00-3333-4333-8333-333333333333', 'ttf'],
      [ORG, ASSET, 'woff'],
      [ORG, ASSET, 'ttf/../x'],
    ]) {
      expect(() =>
        contentStudioPrivateFontStorageKey(org, asset, ext as never)
      ).toThrow(ContentStudioPrivateFontStorageError);
    }
  });
});

describe('LocalContentStudioPrivateFontStorage', () => {
  it('CF11 is created without touching the disk', () => {
    const base = tempBase();
    const root = path.join(base, 'private');
    new LocalContentStudioPrivateFontStorage(root, path.join(base, 'uploads'));
    new LocalContentStudioPrivateFontStorage(undefined, undefined);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('CF1/CF2/CF10 is unavailable without an absolute private directory, saying nothing about it', async () => {
    const { uploads, base } = setupLocal();
    for (const storage of [
      new LocalContentStudioPrivateFontStorage(undefined, uploads),
      new LocalContentStudioPrivateFontStorage('', uploads),
      new LocalContentStudioPrivateFontStorage('private-fonts', uploads),
      new LocalContentStudioPrivateFontStorage(`${base}/p\u0000x`, uploads),
      new LocalContentStudioPrivateFontStorage('/', uploads),
      new LocalContentStudioPrivateFontStorage(path.join(base, 'p'), undefined),
    ]) {
      expect(await codeOf(() => write(storage))).toBe('UNAVAILABLE');
      const error = await storage
        .readFontAsset({
          organizationId: ORG,
          storageKey: `fonts/${ORG}/${ASSET}.ttf`,
        })
        .catch((err: Error) => err);
      expect((error as Error).message).toBe(
        'Private font storage is not configured'
      );
      expect((error as Error).message).not.toContain(base);
    }
    expect(fs.existsSync(path.join(process.cwd(), 'private-fonts'))).toBe(
      false
    );
  });

  it('CF3/CF4/CF5/LP11 refuses a private directory that is, lies in or contains the upload directory', async () => {
    const { uploads, base } = setupLocal();
    for (const root of [
      uploads,
      `${uploads}/`,
      path.join(uploads, 'private'),
      path.join(uploads, 'a/b/private'),
      base,
    ]) {
      const storage = new LocalContentStudioPrivateFontStorage(root, uploads);
      expect(await codeOf(() => write(storage))).toBe('UNAVAILABLE');
    }
    expect(fs.readdirSync(uploads)).toEqual([]);
  });

  it('CF3/LP11 compares real paths: a link to the upload directory is refused', async () => {
    const { uploads, base } = setupLocal();
    fs.symlinkSync(uploads, path.join(base, 'alias'));
    const storage = new LocalContentStudioPrivateFontStorage(
      path.join(base, 'alias', 'fonts-root'),
      uploads
    );
    expect(await codeOf(() => write(storage))).toBe('UNAVAILABLE');
    expect(fs.readdirSync(uploads)).toEqual([]);
  });

  it('CF6/LP4/PS3/PS5/LP12 writes and reads the exact bytes under a disjoint root, returning the key only', async () => {
    const { storage, root, uploads } = setupLocal();
    const result = await write(storage);
    expect(result).toEqual({ storageKey: `fonts/${ORG}/${ASSET}.ttf` });
    expect(
      fs.readFileSync(path.join(root, result.storageKey)).equals(FONT)
    ).toBe(true);
    const read = await storage.readFontAsset({
      organizationId: ORG,
      storageKey: result.storageKey,
    });
    expect(read.equals(FONT)).toBe(true);
    // nothing in the public tree, no temporary file left
    expect(fs.readdirSync(uploads)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'fonts', ORG))).toEqual([
      `${ASSET}.ttf`,
    ]);
    expect(JSON.stringify(result)).not.toMatch(/https?:|uploads/);
  });

  it('LP3 keeps each organization in its own folder', async () => {
    const { storage, root } = setupLocal();
    await write(storage);
    await write(storage, { organizationId: OTHER_ORG, assetId: ASSET_2 });
    expect(fs.readdirSync(path.join(root, 'fonts')).sort()).toEqual(
      [ORG, OTHER_ORG].sort()
    );
  });

  it('LP5/PS6 never overwrites a stored font', async () => {
    const { storage, root } = setupLocal();
    await write(storage);
    expect(
      await codeOf(() => write(storage, { bytes: Buffer.from('OTHER') }))
    ).toBe('CONFLICT');
    expect(
      fs.readFileSync(path.join(root, `fonts/${ORG}/${ASSET}.ttf`)).equals(FONT)
    ).toBe(true);
    expect(fs.readdirSync(path.join(root, 'fonts', ORG))).toEqual([
      `${ASSET}.ttf`,
    ]);
  });

  it('LP6/PS4/PF7 reads no key of another organization', async () => {
    const { storage } = setupLocal();
    const { storageKey } = await write(storage);
    expect(
      await codeOf(() =>
        storage.readFontAsset({ organizationId: OTHER_ORG, storageKey })
      )
    ).toBe('INVALID_KEY');
  });

  it('LP7/LP9/LP10/PS2/PS9 takes no key of another shape', async () => {
    const { storage } = setupLocal();
    await write(storage);
    for (const storageKey of [
      `fonts/${ORG}/../${OTHER_ORG}/${ASSET}.ttf`,
      `fonts/${ORG}/${ASSET}.ttf/..`,
      `/fonts/${ORG}/${ASSET}.ttf`,
      `fonts\\${ORG}\\${ASSET}.ttf`,
      `fonts/${ORG}/${ASSET}.ttf\u0000`,
      `fonts/${ORG}/${ASSET}.woff`,
      `fonts/${ORG}/%2e%2e/${ASSET}.ttf`,
      `../fonts/${ORG}/${ASSET}.ttf`,
      `content-studio/fonts/${ORG}/${ASSET}.ttf`,
      42,
    ]) {
      expect(
        await codeOf(() =>
          storage.readFontAsset({
            organizationId: ORG,
            storageKey: storageKey as string,
          })
        )
      ).toBe('INVALID_KEY');
    }
  });

  it('LP8/PS9 refuses a font file or folder that is a link', async () => {
    const { storage, root, base } = setupLocal();
    fs.writeFileSync(path.join(base, 'outside.ttf'), 'OUTSIDE');
    fs.mkdirSync(path.join(root, 'fonts', ORG), { recursive: true });
    fs.symlinkSync(
      path.join(base, 'outside.ttf'),
      path.join(root, 'fonts', ORG, `${ASSET}.ttf`)
    );
    expect(
      await codeOf(() =>
        storage.readFontAsset({
          organizationId: ORG,
          storageKey: `fonts/${ORG}/${ASSET}.ttf`,
        })
      )
    ).toBe('NOT_FOUND');
    const linked = setupLocal();
    fs.mkdirSync(path.join(linked.root, 'fonts'), { recursive: true });
    fs.mkdirSync(path.join(linked.base, 'elsewhere'));
    fs.symlinkSync(
      path.join(linked.base, 'elsewhere'),
      path.join(linked.root, 'fonts', ORG)
    );
    expect(await codeOf(() => write(linked.storage))).toBe('FAILED');
    expect(fs.readdirSync(path.join(linked.base, 'elsewhere'))).toEqual([]);
  });

  it('reads a missing font as NOT_FOUND', async () => {
    const { storage } = setupLocal();
    expect(
      await codeOf(() =>
        storage.readFontAsset({
          organizationId: ORG,
          storageKey: `fonts/${ORG}/${ASSET}.otf`,
        })
      )
    ).toBe('NOT_FOUND');
  });
});

const PRIVATE_BUCKET = 'postiz-content-studio-private';
const PUBLIC_BUCKET = 'postiz-public';

const fakeS3 = (respond?: (command: unknown) => unknown) => {
  const commands: Array<PutObjectCommand | GetObjectCommand> = [];
  const factory = jest.fn();
  const client = {
    send: jest.fn(async (command: PutObjectCommand | GetObjectCommand) => {
      commands.push(command);
      if (respond) {
        return respond(command);
      }
      return {
        Body: { transformToByteArray: async () => new Uint8Array(FONT) },
      };
    }),
  };
  factory.mockReturnValue(client);
  return { client, commands, factory };
};

describe('CloudflareContentStudioPrivateFontStorage', () => {
  it('PR21/PR23/PR24/PR26 writes the exact bytes to the private bucket once, conditionally, with no URL', async () => {
    const { commands, factory } = fakeS3();
    const storage = new CloudflareContentStudioPrivateFontStorage(
      factory,
      PRIVATE_BUCKET,
      PUBLIC_BUCKET
    );
    const result = await write(storage, { extension: 'otf' });
    expect(result).toEqual({ storageKey: `fonts/${ORG}/${ASSET}.otf` });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    const input = (commands[0] as PutObjectCommand).input;
    expect(input).toEqual({
      Bucket: PRIVATE_BUCKET,
      Key: `content-studio/fonts/${ORG}/${ASSET}.otf`,
      Body: FONT,
      ContentType: 'font/otf',
      IfNoneMatch: '*',
    });
    expect((input.Body as Buffer).equals(FONT)).toBe(true);
    expect(input).not.toHaveProperty('ACL');
    expect(JSON.stringify(result)).not.toMatch(/https?:/);
  });

  it('PR22/PR25 reads the exact key from the private bucket, never the public one', async () => {
    const { commands, factory } = fakeS3();
    const storage = new CloudflareContentStudioPrivateFontStorage(
      factory,
      PRIVATE_BUCKET,
      PUBLIC_BUCKET
    );
    const bytes = await storage.readFontAsset({
      organizationId: ORG,
      storageKey: `fonts/${ORG}/${ASSET}.ttf`,
    });
    expect(bytes.equals(FONT)).toBe(true);
    expect(commands[0]).toBeInstanceOf(GetObjectCommand);
    expect(commands[0].input).toEqual({
      Bucket: PRIVATE_BUCKET,
      Key: `content-studio/fonts/${ORG}/${ASSET}.ttf`,
    });
    expect(
      commands.every((command) => command.input.Bucket !== PUBLIC_BUCKET)
    ).toBe(true);
  });

  it('PR29/CF7/CF8/CF9 is unavailable without a distinct valid private bucket, before any request', async () => {
    for (const [privateBucket, publicBucket] of [
      [undefined, PUBLIC_BUCKET],
      ['', PUBLIC_BUCKET],
      [PUBLIC_BUCKET, PUBLIC_BUCKET],
      ['Upper_Case', PUBLIC_BUCKET],
      ['ab', PUBLIC_BUCKET],
      ['https://bucket.example', PUBLIC_BUCKET],
      [PRIVATE_BUCKET, undefined],
    ]) {
      const { factory } = fakeS3();
      const storage = new CloudflareContentStudioPrivateFontStorage(
        factory,
        privateBucket,
        publicBucket
      );
      expect(await codeOf(() => write(storage))).toBe('UNAVAILABLE');
      expect(
        await codeOf(() =>
          storage.readFontAsset({
            organizationId: ORG,
            storageKey: `fonts/${ORG}/${ASSET}.ttf`,
          })
        )
      ).toBe('UNAVAILABLE');
      expect(factory).not.toHaveBeenCalled();
    }
    const { factory } = fakeS3();
    await write(
      new CloudflareContentStudioPrivateFontStorage(
        factory,
        PRIVATE_BUCKET,
        PUBLIC_BUCKET
      )
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('PR27/PR28 refuses keys of another organization or shape before any request', async () => {
    const { factory } = fakeS3();
    const storage = new CloudflareContentStudioPrivateFontStorage(
      factory,
      PRIVATE_BUCKET,
      PUBLIC_BUCKET
    );
    for (const [organizationId, storageKey] of [
      [OTHER_ORG, `fonts/${ORG}/${ASSET}.ttf`],
      [ORG, `fonts/${ORG}/../${OTHER_ORG}/${ASSET}.ttf`],
      [ORG, `content-studio/fonts/${ORG}/${ASSET}.ttf`],
      [ORG, `AbC123xYz9.png`],
    ]) {
      expect(
        await codeOf(() =>
          storage.readFontAsset({ organizationId, storageKey })
        )
      ).toBe('INVALID_KEY');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('PS6/PS10 maps a refused overwrite to CONFLICT and every provider error to a fixed code', async () => {
    const precondition = Object.assign(new Error('R2_PRIVATE_MARKER'), {
      $metadata: { httpStatusCode: 412 },
    });
    const conflict = fakeS3(() => {
      throw precondition;
    });
    expect(
      await codeOf(() =>
        write(
          new CloudflareContentStudioPrivateFontStorage(
            conflict.factory,
            PRIVATE_BUCKET,
            PUBLIC_BUCKET
          )
        )
      )
    ).toBe('CONFLICT');
    const missing = fakeS3(() => {
      throw Object.assign(new Error('R2_PRIVATE_MARKER'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      });
    });
    const storage = new CloudflareContentStudioPrivateFontStorage(
      missing.factory,
      PRIVATE_BUCKET,
      PUBLIC_BUCKET
    );
    const error = await storage
      .readFontAsset({
        organizationId: ORG,
        storageKey: `fonts/${ORG}/${ASSET}.ttf`,
      })
      .catch((err: ContentStudioPrivateFontStorageError) => err);
    expect((error as ContentStudioPrivateFontStorageError).code).toBe(
      'NOT_FOUND'
    );
    expect((error as Error).message).not.toContain('R2_PRIVATE_MARKER');
    const broken = fakeS3(() => {
      throw new Error('R2_PRIVATE_MARKER');
    });
    expect(
      await codeOf(() =>
        write(
          new CloudflareContentStudioPrivateFontStorage(
            broken.factory,
            PRIVATE_BUCKET,
            PUBLIC_BUCKET
          )
        )
      )
    ).toBe('FAILED');
  });

  it('PR210 states that the operator keeps the private bucket private, and never uses the public URL', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.private-font.storage.ts'),
      'utf8'
    );
    expect(source).toContain(
      'The operator must keep public access (r2.dev and any'
    );
    expect(source).not.toMatch(/process\.env|publicUrl|_uploadUrl|ACL|fetch\(/);
    const example = fs.readFileSync(
      path.join(__dirname, '../../../../.env.example'),
      'utf8'
    );
    expect(example).toContain('#CONTENT_STUDIO_PRIVATE_R2_BUCKET=""');
    expect(example).toContain('#CONTENT_STUDIO_PRIVATE_ASSET_DIRECTORY=""');
    expect(example).toMatch(/public access \(r2\.dev\) disabled/);
  });

  it('is unavailable for an unknown provider', async () => {
    const storage = new UnavailableContentStudioPrivateFontStorage();
    expect(await codeOf(() => storage.writeFontAsset())).toBe('UNAVAILABLE');
    expect(await codeOf(() => storage.readFontAsset())).toBe('UNAVAILABLE');
  });
});

describe('StoredAssetFactory', () => {
  const NAMES = [
    'STORAGE_PROVIDER',
    'CONTENT_STUDIO_PRIVATE_ASSET_DIRECTORY',
    'CONTENT_STUDIO_PRIVATE_R2_BUCKET',
    'UPLOAD_DIRECTORY',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
    for (const name of NAMES) {
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it('CF11 picks the active provider and never fails without its settings', () => {
    expect(
      StoredAssetFactory.createContentStudioPrivateFontStorage()
    ).toBeInstanceOf(LocalContentStudioPrivateFontStorage);
    expect(StoredAssetFactory.createStoredMediaReader()).toBeInstanceOf(
      LocalStoredMediaReader
    );
    process.env.STORAGE_PROVIDER = 'cloudflare';
    expect(
      StoredAssetFactory.createContentStudioPrivateFontStorage()
    ).toBeInstanceOf(CloudflareContentStudioPrivateFontStorage);
    expect(StoredAssetFactory.createStoredMediaReader()).toBeInstanceOf(
      CloudflareStoredMediaReader
    );
    process.env.STORAGE_PROVIDER = 'other';
    expect(
      StoredAssetFactory.createContentStudioPrivateFontStorage()
    ).toBeInstanceOf(UnavailableContentStudioPrivateFontStorage);
    expect(StoredAssetFactory.createStoredMediaReader()).toBeInstanceOf(
      UnavailableStoredMediaReader
    );
  });

  it('CF1/CF7 a storage without its setting answers UNAVAILABLE on use', async () => {
    const local = StoredAssetFactory.createContentStudioPrivateFontStorage();
    expect(await codeOf(() => write(local as never))).toBe('UNAVAILABLE');
    process.env.STORAGE_PROVIDER = 'cloudflare';
    const cloudflare =
      StoredAssetFactory.createContentStudioPrivateFontStorage();
    expect(await codeOf(() => write(cloudflare as never))).toBe('UNAVAILABLE');
  });
});
