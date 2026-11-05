import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { DiscordProvider } from '@gitroom/nestjs-libraries/integrations/social/discord.provider';
import { LocalStorage } from '@gitroom/nestjs-libraries/upload/local.storage';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

// Published as ES modules only, which Node loads and Jest does not
jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
  fileTypeStream: jest.fn(),
}));
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: jest.fn() },
}));
jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  finalizeEvent: jest.fn(),
  Relay: { connect: jest.fn() },
  SimplePool: class {},
}));

// A media path that is not a web address is read from the worker's disk, so
// only a file inside UPLOAD_DIRECTORY may ever be opened (CVE-2026-115932)
const UPLOAD_DIRECTORY = process.env.UPLOAD_DIRECTORY;

const setup = () => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'local-media-'))
  );
  const uploads = path.join(base, 'uploads');
  fs.mkdirSync(path.join(uploads, '2026', '11', '05'), { recursive: true });
  const photo = path.join(uploads, '2026/11/05/photo.png');
  fs.writeFileSync(photo, 'PHOTO');
  const secret = path.join(base, 'secret.env');
  fs.writeFileSync(secret, 'JWT_SECRET=never');
  // a sibling directory whose name starts like the upload directory
  fs.mkdirSync(path.join(base, 'uploads-evil'));
  const sibling = path.join(base, 'uploads-evil', 'x.png');
  fs.writeFileSync(sibling, 'SIBLING');
  process.env.UPLOAD_DIRECTORY = uploads;
  return { base, uploads, photo, secret, sibling };
};

const provider = () => new DiscordProvider() as any;

const OUTSIDE = (s: ReturnType<typeof setup>) => [
  s.secret,
  path.join(s.uploads, '..', 'secret.env'),
  `${s.uploads}/2026/../../secret.env`,
  s.sibling,
  s.uploads,
  '/etc/hosts',
  'secret.env',
];

afterEach(() => {
  if (UPLOAD_DIRECTORY === undefined) {
    delete process.env.UPLOAD_DIRECTORY;
  } else {
    process.env.UPLOAD_DIRECTORY = UPLOAD_DIRECTORY;
  }
});

describe('SocialAbstract local media', () => {
  it('reads a file inside the upload directory', async () => {
    const s = setup();
    const discord = provider();
    expect(discord.localMediaPath(s.photo)).toBe(s.photo);
    await expect(discord.readOrFetch(s.photo)).resolves.toEqual(
      Buffer.from('PHOTO')
    );
    await expect(discord.mediaSize(s.photo)).resolves.toBe(5);
    await expect(discord.mediaChunk(s.photo, 1, 3)).resolves.toEqual(
      Buffer.from('HOT')
    );
  });

  it('refuses every path outside the upload directory', async () => {
    const s = setup();
    const discord = provider();
    for (const outside of OUTSIDE(s)) {
      expect(() => discord.localMediaPath(outside, 'discord')).toThrow(BadBody);
      await expect(discord.readOrFetch(outside)).rejects.toBeInstanceOf(
        BadBody
      );
      await expect(discord.mediaSize(outside)).rejects.toBeInstanceOf(BadBody);
      await expect(discord.mediaChunk(outside, 0, 3)).rejects.toBeInstanceOf(
        BadBody
      );
      await expect(discord.mediaStream(outside)).rejects.toBeInstanceOf(
        BadBody
      );
    }
  });

  it('refuses local reads when UPLOAD_DIRECTORY is not set', async () => {
    const s = setup();
    delete process.env.UPLOAD_DIRECTORY;
    await expect(provider().readOrFetch(s.photo)).rejects.toBeInstanceOf(
      BadBody
    );
  });

  it('fails the post without a retry', () => {
    const s = setup();
    let failure: any;
    try {
      provider().localMediaPath(s.secret, 'discord');
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(BadBody);
    expect(failure.nonRetryable).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('JWT_SECRET');
  });
});

describe('LocalStorage.removeFile', () => {
  it('deletes a file of the upload directory, by path or public url', async () => {
    const s = setup();
    const storage = new LocalStorage(s.uploads);
    await storage.removeFile(s.photo);
    expect(fs.existsSync(s.photo)).toBe(false);

    const again = path.join(s.uploads, '2026/11/05/again.png');
    fs.writeFileSync(again, 'AGAIN');
    const frontend = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://app.example.com';
    try {
      await storage.removeFile(
        'https://app.example.com/uploads/2026/11/05/again.png'
      );
    } finally {
      if (frontend === undefined) {
        delete process.env.FRONTEND_URL;
      } else {
        process.env.FRONTEND_URL = frontend;
      }
    }
    expect(fs.existsSync(again)).toBe(false);
  });

  it('never deletes outside the upload directory', async () => {
    const s = setup();
    const storage = new LocalStorage(s.uploads);
    for (const outside of [
      s.secret,
      `${s.uploads}/../secret.env`,
      s.sibling,
      s.uploads,
    ]) {
      await expect(storage.removeFile(outside)).rejects.toThrow(
        'Unsafe file path'
      );
    }
    expect(fs.existsSync(s.secret)).toBe(true);
    expect(fs.existsSync(s.sibling)).toBe(true);
  });
});

describe('PostsService media list', () => {
  // the check is private and needs no injected service
  const allowed = (value: unknown) =>
    (Object.create(PostsService.prototype) as any).isAllowedMediaPath(value);

  it('keeps remote urls and files of the upload directory', () => {
    setup();
    expect(allowed('https://cdn.example.com/a.png')).toBe(true);
    expect(allowed('http://cdn.example.com/a.png')).toBe(true);
    expect(allowed('/2026/11/05/photo.png')).toBe(true);
  });

  it('drops local paths that leave the upload directory', () => {
    setup();
    expect(allowed('/../secret.env')).toBe(false);
    expect(allowed('/2026/../../../etc/passwd')).toBe(false);
    expect(allowed('-evil/x.png')).toBe(false);
    // "http" anywhere would skip the UPLOAD_DIRECTORY prefix in the providers
    expect(allowed('/../../http/../etc/passwd')).toBe(false);
    expect(allowed('file:///etc/passwd#http')).toBe(false);
  });
});
