import fs from 'fs';
import path from 'path';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import {
  ContentStudioRenderMediaBridge,
  ContentStudioRenderMediaStorageError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-media.bridge';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';
import { StoredMediaReadError } from '@gitroom/nestjs-libraries/upload/stored.media.reader';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// only the scoped lookup and the generated-file save are used, mocked below
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const RENDER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MARKER = 'RENDER_MEDIA_PRIVATE_MARKER_789';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-more'),
]);
const STORED = Buffer.from('STORED_IMAGE_BYTES');

const setup = (
  rows: Record<string, { org: string; status?: string; path: string }> = {
    'photo-1': {
      org: ORG,
      path: 'https://app.example.com/uploads/2026/10/16/a.png',
    },
  }
) => {
  const calls: string[] = [];
  const reader = {
    readStoredMediaBytes: jest.fn(async (location: string) => {
      calls.push(`read ${location}`);
      return Buffer.from(STORED);
    }),
  };
  jest
    .spyOn(StoredAssetFactory, 'createStoredMediaReader')
    .mockReturnValue(reader);
  const media = {
    getMediaByIdForOrganization: jest.fn(async (org: string, id: string) => {
      calls.push(`lookup ${org} ${id}`);
      const row = rows[id];
      return row && row.org === org
        ? {
            id,
            path: row.path,
            status: row.status ?? 'ready',
            name: 'x',
            thumbnail: null,
            alt: null,
          }
        : null;
    }),
    // the unscoped lookup the real service also has; never to be used here
    getMediaById: jest.fn(async (id: string) =>
      rows[id]
        ? { id, path: rows[id].path, status: rows[id].status ?? 'ready' }
        : null
    ),
    saveGeneratedFile: jest.fn(async () => ({ id: 'media-out', path: 'p' })),
  };
  const bridge = new ContentStudioRenderMediaBridge(
    media as unknown as MediaService
  );
  return { bridge, media, reader, calls };
};

describe('ContentStudioRenderMediaBridge reads', () => {
  it('MB1/MB4/MB6/MR1/MR10 looks the Media up for the organization first, then reads its stored file from the row path', async () => {
    const { bridge, calls, reader } = setup();
    const bytes = await bridge.readMediaBytesForOrganization(
      ORG,
      'photo-1',
      1000
    );
    expect(bytes?.equals(STORED)).toBe(true);
    expect(calls).toEqual([
      `lookup ${ORG} photo-1`,
      'read https://app.example.com/uploads/2026/10/16/a.png',
    ]);
    expect(reader.readStoredMediaBytes).toHaveBeenCalledWith(
      'https://app.example.com/uploads/2026/10/16/a.png',
      1000
    );
  });

  it('MB2/MR2/MB3/MR3 reads nothing for a Media of another organization or a missing one', async () => {
    const { bridge, reader, media } = setup();
    expect(
      await bridge.readMediaBytesForOrganization(OTHER_ORG, 'photo-1', 1000)
    ).toBeNull();
    expect(
      await bridge.readMediaBytesForOrganization(ORG, 'missing', 1000)
    ).toBeNull();
    expect(reader.readStoredMediaBytes).not.toHaveBeenCalled();
    expect(media.getMediaById).not.toHaveBeenCalled();
  });

  it('reads nothing for a Media that is not ready or an id outside the Design rule', async () => {
    const { bridge, reader, media } = setup({
      busy: { org: ORG, status: 'processing', path: 'x' },
      failed: { org: ORG, status: 'failed', path: 'x' },
    });
    expect(
      await bridge.readMediaBytesForOrganization(ORG, 'busy', 1000)
    ).toBeNull();
    expect(
      await bridge.readMediaBytesForOrganization(ORG, 'failed', 1000)
    ).toBeNull();
    for (const id of ['../x', 'https://evil.test/x.png', '', 'a/b']) {
      expect(
        await bridge.readMediaBytesForOrganization(ORG, id, 1000)
      ).toBeNull();
    }
    expect(media.getMediaByIdForOrganization).toHaveBeenCalledTimes(2);
    expect(reader.readStoredMediaBytes).not.toHaveBeenCalled();
  });

  it('MB13/MB14 a storage error reads as null, quoting nothing', async () => {
    const { bridge, reader } = setup();
    reader.readStoredMediaBytes.mockRejectedValueOnce(
      new StoredMediaReadError()
    );
    reader.readStoredMediaBytes.mockRejectedValueOnce(new Error(MARKER));
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(
      await bridge.readMediaBytesForOrganization(ORG, 'photo-1', 1000)
    ).toBeNull();
    expect(
      await bridge.readMediaBytesForOrganization(ORG, 'photo-1', 1000)
    ).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('MB5/MR12 takes an organization, a Media id and a size limit: no URL, path or key', () => {
    expect(
      ContentStudioRenderMediaBridge.prototype.readMediaBytesForOrganization
        .length
    ).toBe(3);
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.render-media.bridge.ts'),
      'utf8'
    );
    expect(source).toMatch(
      /readMediaBytesForOrganization\(\n\s+organizationId: string,\n\s+mediaId: string,\n\s+maxBytes: number\n/
    );
    expect(source).not.toMatch(/\b(url|href|src|storageKey)\s*:/i);
  });

  it('MB12/MR11 never fetches over HTTP', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { bridge } = setup();
    await bridge.readMediaBytesForOrganization(ORG, 'photo-1', 1000);
    expect(fetchSpy).not.toHaveBeenCalled();
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.render-media.bridge.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /\bfetch\(|axios|undici|safe\.fetch|from 'https?'/
    );
  });
});

describe('ContentStudioRenderMediaBridge writes', () => {
  it('MB7/MB8/MB9/MB10/MB11 stores the exact PNG once as a Media of the organization, under a fixed name', async () => {
    const { bridge, media } = setup();
    const bytes = Buffer.from(PNG);
    expect(
      await bridge.createRenderedMedia({
        organizationId: ORG,
        renderId: RENDER,
        bytes,
      })
    ).toEqual({ id: 'media-out' });
    expect(media.saveGeneratedFile).toHaveBeenCalledTimes(1);
    expect(media.saveGeneratedFile).toHaveBeenCalledWith(
      ORG,
      bytes,
      'image/png',
      'png',
      'content-studio-design-0f8fad5b.png'
    );
    expect((media.saveGeneratedFile.mock.calls[0] as unknown[])[1]).toBe(bytes);
    expect(bytes.equals(PNG)).toBe(true);
  });

  it('refuses anything but PNG bytes for a render id, before storing', async () => {
    const { bridge, media } = setup();
    for (const input of [
      { renderId: 'not-a-uuid', bytes: PNG },
      { renderId: RENDER, bytes: Buffer.from('GIF89a') },
      { renderId: RENDER, bytes: 'png' as unknown as Buffer },
    ]) {
      await expect(
        bridge.createRenderedMedia({ organizationId: ORG, ...input })
      ).rejects.toThrow(ContentStudioRenderMediaStorageError);
    }
    expect(media.saveGeneratedFile).not.toHaveBeenCalled();
  });

  it('MB13/MB14 a storage failure is one fixed error, quoting nothing', async () => {
    const { bridge, media } = setup();
    media.saveGeneratedFile.mockRejectedValueOnce(new Error(MARKER));
    const error = await bridge
      .createRenderedMedia({
        organizationId: ORG,
        renderId: RENDER,
        bytes: PNG,
      })
      .catch((err: Error) => err);
    expect(error).toBeInstanceOf(ContentStudioRenderMediaStorageError);
    expect((error as Error).message).toBe(
      'The rendered design could not be stored'
    );
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(media.saveGeneratedFile).toHaveBeenCalledTimes(1);
  });

  it('stores through the Media service the way uploads are stored', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../media/media.service.ts'),
      'utf8'
    );
    const method = source.slice(
      source.indexOf('async saveGeneratedFile('),
      source.indexOf('async generateImage(')
    );
    expect(method).toContain('this.storage.uploadStream(');
    expect(method).toContain('Readable.from([body])');
    expect(method).toContain(
      'return this.saveFile(org, uploaded.filename, uploaded.path, originalName);'
    );
  });
});
