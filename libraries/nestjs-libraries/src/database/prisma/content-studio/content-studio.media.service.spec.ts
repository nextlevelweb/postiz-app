import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import {
  ContentStudioMediaService,
  ContentStudioMediaUnavailableError,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import {
  ContentPackageDraft,
  parseContentPackageDraft,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// only the scoped lookup is used, and it is mocked below
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

const ORG = 'org-a';

const media = (id: string, status = 'ready') => ({
  id,
  name: `${id}.png`,
  path: `https://uploads.example.com/${id}.png`,
  thumbnail: null as string | null,
  alt: null as string | null,
  status,
});
const preview = (id: string, status = 'ready') => ({
  id,
  path: `https://uploads.example.com/${id}.png`,
  thumbnail: null as string | null,
  alt: null as string | null,
  status,
});
const resolved = (id: string) => ({
  id,
  path: `https://uploads.example.com/${id}.png`,
});

// A draft with one thread item per list of Media ids
const draft = (...items: string[][]): ContentPackageDraft =>
  parseContentPackageDraft({
    schemaVersion: 1,
    copy: {
      global: {
        thread: items.map((mediaIds, i) => ({
          id: `item-${i}`,
          text: `Item ${i}`,
          mediaIds,
        })),
      },
    },
  });

// rows: what the organization-scoped lookup finds per id (null when it
// finds nothing: missing, deleted or another organization's Media)
const setup = (rows: Record<string, ReturnType<typeof media> | null> = {}) => {
  const getMediaByIdForOrganization = jest.fn(
    async (_org: string, id: string) =>
      Object.prototype.hasOwnProperty.call(rows, id) ? rows[id] : null
  );
  const getMediaById = jest.fn();
  const mediaService = { getMediaByIdForOrganization, getMediaById };
  const service = new ContentStudioMediaService(
    mediaService as unknown as MediaService
  );
  return { service, getMediaByIdForOrganization, getMediaById };
};

const unavailable = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(ContentStudioMediaUnavailableError);
  return error as ContentStudioMediaUnavailableError;
};

describe('ContentStudioMediaService.getPreviewMap', () => {
  it('P1 returns {} for a draft without Media and reads nothing', async () => {
    const { service, getMediaByIdForOrganization } = setup();

    await expect(service.getPreviewMap(ORG, draft([], []))).resolves.toEqual(
      {}
    );
    expect(getMediaByIdForOrganization).not.toHaveBeenCalled();
  });

  it('P2 looks a Media up within the organization and keeps safe fields', async () => {
    const { service, getMediaByIdForOrganization, getMediaById } = setup({
      m1: media('m1'),
    });

    await expect(service.getPreviewMap(ORG, draft(['m1']))).resolves.toEqual({
      m1: preview('m1'),
    });
    expect(getMediaByIdForOrganization).toHaveBeenCalledTimes(1);
    expect(getMediaByIdForOrganization).toHaveBeenCalledWith(ORG, 'm1');
    expect(getMediaById).not.toHaveBeenCalled();
  });

  it.each([['processing'], ['failed']])(
    'P3 P4 shows %s Media with its status',
    async (status) => {
      const { service } = setup({ m1: media('m1', status) });

      await expect(service.getPreviewMap(ORG, draft(['m1']))).resolves.toEqual({
        m1: preview('m1', status),
      });
    }
  );

  it('P5 P6 shows a missing, deleted or foreign Media as null', async () => {
    // the scoped lookup answers null in all three cases
    const { service } = setup({ m1: null });

    await expect(service.getPreviewMap(ORG, draft(['m1']))).resolves.toEqual({
      m1: null,
    });
  });

  it('P7 returns every Media of every item', async () => {
    const { service } = setup({
      m1: media('m1'),
      m2: media('m2', 'processing'),
      m3: media('m3'),
    });

    await expect(
      service.getPreviewMap(ORG, draft(['m1', 'm2'], ['m3', 'gone']))
    ).resolves.toEqual({
      m1: preview('m1'),
      m2: preview('m2', 'processing'),
      m3: preview('m3'),
      gone: null,
    });
  });

  it('P8 P9 looks each id up once, in the order ids first appear', async () => {
    const { service, getMediaByIdForOrganization } = setup({
      a: media('a'),
      b: media('b'),
      c: media('c'),
    });

    await service.getPreviewMap(ORG, draft(['b', 'a'], ['a', 'c'], ['c', 'b']));
    expect(getMediaByIdForOrganization.mock.calls).toEqual([
      [ORG, 'b'],
      [ORG, 'a'],
      [ORG, 'c'],
    ]);
  });

  it('P10 leaves out everything but id, path, thumbnail, alt and status', async () => {
    const { service } = setup({
      m1: {
        ...media('m1'),
        thumbnail: 'https://uploads.example.com/m1-thumb.png',
        alt: 'A launch photo',
        organizationId: 'org-b',
        processingError: 'ffmpeg: /var/secret/path',
        originalName: 'private.png',
        deletedAt: null,
      } as ReturnType<typeof media>,
    });

    const map = await service.getPreviewMap(ORG, draft(['m1']));
    expect(map.m1).toStrictEqual({
      id: 'm1',
      path: 'https://uploads.example.com/m1.png',
      thumbnail: 'https://uploads.example.com/m1-thumb.png',
      alt: 'A launch photo',
      status: 'ready',
    });
    expect(JSON.stringify(map)).not.toMatch(/org-b|secret|private|name/);
  });

  it('keeps ids such as __proto__ and constructor as plain keys', async () => {
    // a computed key: a plain __proto__ key in a literal sets the prototype
    const { service } = setup({
      ['__proto__']: media('__proto__'),
      constructor: null,
      prototype: media('prototype', 'failed'),
    } as Record<string, ReturnType<typeof media> | null>);

    const map = await service.getPreviewMap(
      ORG,
      draft(['__proto__', 'constructor'], ['prototype'])
    );
    expect(Object.keys(map)).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(map, '__proto__')?.value).toEqual(
      preview('__proto__')
    );
    expect(map.constructor).toBeNull();
    expect(JSON.parse(JSON.stringify(map))).toEqual(
      JSON.parse(
        JSON.stringify({
          ['__proto__']: preview('__proto__'),
          constructor: null,
          prototype: preview('prototype', 'failed'),
        })
      )
    );
  });

  it('lets a lookup failure through instead of calling the Media unavailable', async () => {
    const { service, getMediaByIdForOrganization } = setup();
    const error = new Error('Connection refused');
    getMediaByIdForOrganization.mockRejectedValue(error);

    await expect(service.getPreviewMap(ORG, draft(['m1']))).rejects.toBe(error);
  });
});

describe('ContentStudioMediaService.resolveForHandoff', () => {
  it('H1 returns an empty list per item for a draft without Media', async () => {
    const { service, getMediaByIdForOrganization } = setup();

    await expect(
      service.resolveForHandoff(ORG, draft([], [], []))
    ).resolves.toEqual([[], [], []]);
    expect(getMediaByIdForOrganization).not.toHaveBeenCalled();
  });

  it('H2 H13 returns the id and the path stored on the Media row', async () => {
    const { service, getMediaByIdForOrganization } = setup({
      m1: { ...media('m1'), path: '/db/path' },
    });

    const result = await service.resolveForHandoff(ORG, draft(['m1']));
    expect(result).toStrictEqual([[{ id: 'm1', path: '/db/path' }]]);
    expect(getMediaByIdForOrganization).toHaveBeenCalledWith(ORG, 'm1');
  });

  it('H3 H4 keeps item and Media order and looks repeated ids up once', async () => {
    const { service, getMediaByIdForOrganization } = setup({
      a: media('a'),
      b: media('b'),
      c: media('c'),
    });

    await expect(
      service.resolveForHandoff(ORG, draft(['c', 'a', 'b'], ['b', 'a'], []))
    ).resolves.toEqual([
      [resolved('c'), resolved('a'), resolved('b')],
      [resolved('b'), resolved('a')],
      [],
    ]);
    expect(getMediaByIdForOrganization).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['H5 missing, deleted or foreign', null, 'unavailable'],
    ['H6 processing', media('m1', 'processing'), 'processing'],
    ['H7 failed', media('m1', 'failed'), 'failed'],
    ['H8 an unknown status', media('m1', 'uploading'), 'unavailable'],
    ['H8 a differently cased status', media('m1', 'READY'), 'unavailable'],
  ])('refuses %s Media', async (_name, row, reason) => {
    const { service } = setup({ ok: media('ok'), m1: row });

    const error = await unavailable(
      service.resolveForHandoff(ORG, draft(['ok'], ['ok', 'm1']))
    );
    expect(error.items).toEqual([{ itemIndex: 1, mediaIndex: 1, reason }]);
  });

  it('H9 H11 reports every position that is not ready, in order, and nothing else', async () => {
    const { service } = setup({
      a: media('a'),
      b: media('b', 'processing'),
      d: media('d', 'failed'),
    });

    const error = await unavailable(
      service.resolveForHandoff(ORG, draft(['a', 'b'], ['c', 'd'], ['a']))
    );
    expect(error.items).toEqual([
      { itemIndex: 0, mediaIndex: 1, reason: 'processing' },
      { itemIndex: 1, mediaIndex: 0, reason: 'unavailable' },
      { itemIndex: 1, mediaIndex: 1, reason: 'failed' },
    ]);
  });

  it('H10 reports every position of a repeated unavailable id after one lookup', async () => {
    const { service, getMediaByIdForOrganization } = setup({ a: media('a') });

    const error = await unavailable(
      service.resolveForHandoff(ORG, draft(['gone', 'a'], ['a', 'gone']))
    );
    expect(error.items).toEqual([
      { itemIndex: 0, mediaIndex: 0, reason: 'unavailable' },
      { itemIndex: 1, mediaIndex: 1, reason: 'unavailable' },
    ]);
    expect(getMediaByIdForOrganization).toHaveBeenCalledTimes(2);
  });

  it('H12 puts no id, path, organization or processing error in the error', async () => {
    const { service } = setup({
      'secret-media': {
        ...media('secret-media', 'failed'),
        processingError: 'ffmpeg failed on /var/data/secret.mov',
      } as ReturnType<typeof media>,
    });

    const error = await unavailable(
      service.resolveForHandoff(ORG, draft(['secret-media', 'missing-media']))
    );
    expect(error.message).toBe('Content Studio media is unavailable');
    expect(error.name).toBe('ContentStudioMediaUnavailableError');
    expect(error.code).toBe('MEDIA_UNAVAILABLE');
    expect(Object.keys(error).sort()).toEqual(['code', 'items', 'name']);
    for (const item of error.items) {
      expect(Object.keys(item).sort()).toEqual([
        'itemIndex',
        'mediaIndex',
        'reason',
      ]);
    }
    for (const output of [
      String(error),
      error.stack ?? '',
      JSON.stringify(error),
      JSON.stringify(error.items),
    ]) {
      expect(output).not.toMatch(/secret|missing-media|org-a|uploads|ffmpeg/);
    }
  });

  it('H14 lets a lookup failure through instead of calling the Media unavailable', async () => {
    const { service, getMediaByIdForOrganization } = setup();
    const error = new Error('Connection refused');
    getMediaByIdForOrganization.mockRejectedValue(error);

    await expect(service.resolveForHandoff(ORG, draft(['m1']))).rejects.toBe(
      error
    );
  });

  it('takes ids only: the paths in the result never come from the draft', async () => {
    const { service } = setup({ m1: { ...media('m1'), path: '/db/path' } });
    const input = draft(['m1']);

    const result = await service.resolveForHandoff(ORG, input);
    // the draft has no field a path could come from
    expect(JSON.stringify(input)).not.toContain('path');
    expect(result[0][0].path).toBe('/db/path');
    expect(input).toEqual(draft(['m1']));
  });
});
