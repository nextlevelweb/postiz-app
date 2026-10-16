import fs from 'fs';
import path from 'path';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { designRenderSha256 } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';
import { ContentStudioRenderFontRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.repository';
import {
  ContentStudioRenderFontActor,
  ContentStudioRenderFontService,
  RENDER_FONT_ACTIVE_MAX,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import {
  ContentStudioPrivateFontStorage,
  ContentStudioPrivateFontStorageError,
} from '@gitroom/nestjs-libraries/upload/content-studio.private-font.storage';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';

// Geist Regular from next (a direct dependency), read at test time only
const GEIST = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('next/package.json')),
    'dist/compiled/@vercel/og/Geist-Regular.ttf'
  )
);
const tagged = (tag: string) => {
  const bytes = Buffer.from(GEIST);
  bytes.write(tag, 0, 'latin1');
  return bytes;
};
const OTF = tagged('OTTO');

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const MAPPING = '66666666-6666-4666-8666-666666666666';
const MARKER = 'RENDER_FONT_STORAGE_PRIVATE_MARKER_321';
const NOW = new Date('2026-10-16T10:00:00.000Z');

const actor = (role = 'ADMIN', extra: Record<string, unknown> = {}) =>
  ({
    organization: {
      id: ORG,
      users: [{ role, disabled: false, userId: USER, ...extra }],
    },
    user: { id: USER },
  } as ContentStudioRenderFontActor);

type Row = Record<string, unknown>;

const setup = () => {
  const state = { assets: [] as Row[], mappings: [] as Row[] };
  const summary = (row: Row) => ({
    id: row.id,
    family: row.family,
    weight: row.weight,
    style: row.style,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const tupleOf = (font: Row) => (row: Row) =>
    row.family === font.family &&
    row.weight === font.weight &&
    row.style === font.style;
  const repository = {
    listMappingsForOrganization: jest.fn(async () =>
      state.mappings.map(summary)
    ),
    getMappingForOrganization: jest.fn(async (org: string, id: string) => {
      const row = state.mappings.find((m) => m.id === id && org === ORG);
      return row ? summary(row) : null;
    }),
    getMappingBySpec: jest.fn(async (org: string, font: Row) => {
      const row = org === ORG ? state.mappings.find(tupleOf(font)) : undefined;
      return row ? summary(row) : null;
    }),
    countActiveMappings: jest.fn(
      async () => state.mappings.filter((m) => !m.disabledAt).length
    ),
    createAssetAndSetMapping: jest.fn(async (input: Row) => {
      const font = input.font as Row;
      const current = state.mappings.find(tupleOf(font));
      if (
        (!current || current.disabledAt) &&
        state.mappings.filter((m) => !m.disabledAt).length >=
          (input.activeLimit as number)
      ) {
        return { status: 'limit' as const };
      }
      state.assets.push({
        ...(input.asset as Row),
        organizationId: input.organizationId,
      });
      if (current) {
        Object.assign(current, {
          fontAssetId: (input.asset as Row).id,
          disabledAt: null,
          updatedAt: new Date(NOW.getTime() + 1),
        });
        return { status: 'set' as const, mapping: summary(current) };
      }
      const row = {
        id: input.mappingId,
        ...font,
        fontAssetId: (input.asset as Row).id,
        disabledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      state.mappings.push(row);
      return { status: 'set' as const, mapping: summary(row) };
    }),
    disableMapping: jest.fn(async (org: string, id: string, at: Date) => {
      const row = state.mappings.find((m) => m.id === id && !m.disabledAt);
      if (row && org === ORG) {
        row.disabledAt = at;
        return { count: 1 };
      }
      return { count: 0 };
    }),
    enableMapping: jest.fn(async (org: string, id: string, limit: number) => {
      const row = state.mappings.find((m) => m.id === id);
      if (!row || org !== ORG) {
        return { status: 'not-found' as const };
      }
      if (!row.disabledAt) {
        return { status: 'unchanged' as const };
      }
      if (state.mappings.filter((m) => !m.disabledAt).length >= limit) {
        return { status: 'limit' as const };
      }
      row.disabledAt = null;
      return { status: 'enabled' as const };
    }),
  };
  const objects = new Map<string, Buffer>();
  const storage = {
    writeFontAsset: jest.fn(
      async (input: {
        organizationId: string;
        assetId: string;
        bytes: Uint8Array;
        extension: string;
      }) => {
        const storageKey = `fonts/${input.organizationId}/${input.assetId}.${input.extension}`;
        if (objects.has(storageKey)) {
          throw new ContentStudioPrivateFontStorageError('CONFLICT');
        }
        objects.set(storageKey, Buffer.from(input.bytes));
        return { storageKey };
      }
    ),
    readFontAsset: jest.fn(),
  };
  jest
    .spyOn(StoredAssetFactory, 'createContentStudioPrivateFontStorage')
    .mockReturnValue(storage as unknown as ContentStudioPrivateFontStorage);
  const service = new ContentStudioRenderFontService(
    repository as unknown as ContentStudioRenderFontRepository
  );
  return { service, repository, storage, state, objects };
};

const upload = (
  service: ContentStudioRenderFontService,
  extra: Record<string, unknown> = {},
  who = actor()
) =>
  service.uploadFont(who, {
    family: 'Inter',
    weight: 400,
    style: 'normal',
    file: {
      buffer: GEIST,
      originalname: 'whatever.woff2',
      mimetype: 'image/png',
    } as never,
    ...extra,
  });

const errorOf = async (run: () => Promise<unknown>) => {
  const error = await run().then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return {
    status: http.getStatus(),
    ...(http.getResponse() as Row),
  } as { status: number; code?: unknown; msg?: unknown };
};

const SUMMARY_KEYS = [
  'createdAt',
  'disabledAt',
  'family',
  'id',
  'style',
  'updatedAt',
  'weight',
];

describe('ContentStudioRenderFontService upload', () => {
  it('FU1/FMS9 refuses a USER, a disabled or foreign membership, before anything is read or stored', async () => {
    for (const who of [
      actor('USER'),
      actor('ADMIN', { disabled: true }),
      actor('ADMIN', { userId: 'someone-else' }),
      { organization: { id: ORG, users: [] }, user: { id: USER } },
      { organization: { id: ORG }, user: { id: USER } },
    ]) {
      const { service, storage, repository } = setup();
      expect(await errorOf(() => upload(service, {}, who as never))).toEqual({
        status: 403,
        msg: 'Only organization administrators can manage render fonts.',
        code: 'CS_RENDER_FONT_ADMIN_REQUIRED',
      });
      expect(storage.writeFontAsset).not.toHaveBeenCalled();
      expect(repository.createAssetAndSetMapping).not.toHaveBeenCalled();
    }
  });

  it('FU2/FU3/FMS10/FMS11/FU4/FU11/FU15/FMS1 ADMIN and SUPERADMIN store a TrueType font with the server hash', async () => {
    for (const role of ['ADMIN', 'SUPERADMIN']) {
      const { service, storage, repository, objects } = setup();
      const result = await upload(service, {}, actor(role));
      expect(Object.keys(result).sort()).toEqual(SUMMARY_KEYS);
      expect(result).toMatchObject({
        family: 'Inter',
        weight: 400,
        style: 'normal',
        disabledAt: null,
      });
      expect(storage.writeFontAsset).toHaveBeenCalledTimes(1);
      const write = storage.writeFontAsset.mock.calls[0][0];
      expect(write.organizationId).toBe(ORG);
      expect(write.extension).toBe('ttf');
      expect(Buffer.from(write.bytes).equals(GEIST)).toBe(true);
      const set = repository.createAssetAndSetMapping.mock.calls[0][0] as Row;
      expect(set).toMatchObject({
        organizationId: ORG,
        createdById: USER,
        font: { family: 'Inter', weight: 400, style: 'normal' },
        activeLimit: RENDER_FONT_ACTIVE_MAX,
      });
      expect(set.asset).toEqual({
        id: write.assetId,
        storageKey: `fonts/${ORG}/${write.assetId}.ttf`,
        sha256: designRenderSha256(GEIST),
        byteSize: GEIST.length,
        format: 'ttf',
      });
      expect(objects.size).toBe(1);
    }
  });

  it('FU5/FU13/FU14 an OTTO font is otf: the file name and declared type are ignored', async () => {
    const { service, storage, repository } = setup();
    await upload(service, {
      file: { buffer: OTF, originalname: 'font.ttf', mimetype: 'font/ttf' },
    });
    expect(storage.writeFontAsset.mock.calls[0][0].extension).toBe('otf');
    expect(
      (repository.createAssetAndSetMapping.mock.calls[0][0] as { asset: Row })
        .asset.format
    ).toBe('otf');
    expect(
      JSON.stringify(repository.createAssetAndSetMapping.mock.calls)
    ).not.toContain('font.ttf');
  });

  it('FU6/FU7/FU8/FMS6 refuses WOFF, WOFF2 and collections as unsupported', async () => {
    for (const tag of ['wOFF', 'wOF2', 'ttcf']) {
      const { service, storage } = setup();
      expect(
        await errorOf(() => upload(service, { file: { buffer: tagged(tag) } }))
      ).toEqual({
        status: 400,
        msg: 'The font file format is not supported.',
        code: 'CS_RENDER_FONT_UNSUPPORTED',
      });
      expect(storage.writeFontAsset).not.toHaveBeenCalled();
    }
  });

  it('FU9/FU10/FMS5/FU12 refuses PNG, damaged and empty files, and files over 32 MiB', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
    ]);
    const cases: Array<[unknown, number, string]> = [
      [{ buffer: png }, 400, 'CS_RENDER_FONT_INVALID'],
      [{ buffer: GEIST.subarray(0, 100) }, 400, 'CS_RENDER_FONT_INVALID'],
      [{ buffer: Buffer.alloc(0) }, 400, 'CS_RENDER_FONT_INVALID'],
      [undefined, 400, 'CS_RENDER_FONT_INVALID'],
      [{ buffer: 'AAEAAA==' }, 400, 'CS_RENDER_FONT_INVALID'],
      [{ buffer: Buffer.alloc(33_554_433) }, 413, 'CS_RENDER_FONT_TOO_LARGE'],
    ];
    for (const [file, status, code] of cases) {
      const { service, storage } = setup();
      const error = await errorOf(() => upload(service, { file }));
      expect([error.status, error.code]).toEqual([status, code]);
      expect(storage.writeFontAsset).not.toHaveBeenCalled();
    }
  });

  it('FMS2 takes exactly the Design font tuple rules, keeping case and trimming', async () => {
    for (const extra of [
      { family: '' },
      { family: '   ' },
      { family: 'x'.repeat(201) },
      { family: 'A\u0000B' },
      { family: 42 },
      { weight: 450 },
      { weight: '400' },
      { style: 'oblique' },
    ]) {
      const { service, storage } = setup();
      expect((await errorOf(() => upload(service, extra))).code).toBe(
        'CS_INVALID_REQUEST'
      );
      expect(storage.writeFontAsset).not.toHaveBeenCalled();
    }
    const { service, repository } = setup();
    await upload(service, { family: '  inter Display \r\n' });
    expect(
      (repository.createAssetAndSetMapping.mock.calls[0][0] as { font: Row })
        .font
    ).toEqual({
      family: 'inter Display',
      weight: 400,
      style: 'normal',
    });
  });

  it('FU16/FU17/FU18/FU19/FMS7/FMS8 every upload is a new asset; the mapping moves and the earlier object stays', async () => {
    const { service, state, objects } = setup();
    const first = await upload(service);
    const before = JSON.parse(JSON.stringify(state.assets[0]));
    const firstObject = Buffer.from(
      objects.get(state.assets[0].storageKey as string) as Buffer
    );
    // the same bytes again are a new asset too (no dedupe in P4-05)
    const second = await upload(service);
    const third = await upload(service, { file: { buffer: OTF } });
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(state.assets).toHaveLength(3);
    expect(new Set(state.assets.map((a) => a.id)).size).toBe(3);
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].fontAssetId).toBe(state.assets[2].id);
    expect(JSON.parse(JSON.stringify(state.assets[0]))).toEqual(before);
    expect(
      objects.get(state.assets[0].storageKey as string)?.equals(firstObject)
    ).toBe(true);
    expect(objects.size).toBe(3);
  });

  it('FU20/FMS18 answers the safe summary: no asset, hash, size, key or URL', async () => {
    const { service } = setup();
    const result = await upload(service);
    expect(Object.keys(result).sort()).toEqual(SUMMARY_KEYS);
    expect(JSON.stringify(result)).not.toMatch(
      /fonts\/|[0-9a-f]{64}|https?:|ttf|otf/
    );
  });

  it('FU21 fails with the fixed 503 when private storage is not configured, writing no row', async () => {
    const { service, storage, repository } = setup();
    storage.writeFontAsset.mockRejectedValueOnce(
      new ContentStudioPrivateFontStorageError('UNAVAILABLE')
    );
    expect(await errorOf(() => upload(service))).toEqual({
      status: 503,
      msg: 'Private render font storage is not configured.',
      code: 'CS_RENDER_FONT_STORAGE_UNAVAILABLE',
    });
    expect(repository.createAssetAndSetMapping).not.toHaveBeenCalled();
  });

  it('FMS19 a storage failure is a fixed 500, quoting nothing', async () => {
    const { service, storage, repository } = setup();
    storage.writeFontAsset.mockRejectedValueOnce(new Error(MARKER));
    const error = await errorOf(() => upload(service));
    expect(error).toEqual({
      status: 500,
      msg: 'The render font could not be stored.',
      code: 'CS_RENDER_FONT_STORAGE_FAILED',
    });
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(repository.createAssetAndSetMapping).not.toHaveBeenCalled();
  });

  it('FMS15/FMS16/FMS17 refuses a 65th enabled tuple before storing; a replacement or a disabled tuple does not count', async () => {
    const { service, state, storage } = setup();
    for (let n = 0; n < RENDER_FONT_ACTIVE_MAX; n += 1) {
      state.mappings.push({
        id: `m-${n}`,
        family: `F${n}`,
        weight: 400,
        style: 'normal',
        disabledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    expect(await errorOf(() => upload(service))).toEqual({
      status: 409,
      msg: 'The organization has too many active render fonts.',
      code: 'CS_RENDER_FONT_LIMIT',
    });
    expect(storage.writeFontAsset).not.toHaveBeenCalled();
    await upload(service, { family: 'F3' });
    expect(storage.writeFontAsset).toHaveBeenCalledTimes(1);
    state.mappings[0].disabledAt = NOW;
    await upload(service, { family: 'Inter' });
    expect(state.mappings.filter((m) => !m.disabledAt)).toHaveLength(
      RENDER_FONT_ACTIVE_MAX
    );
  });

  it('answers the limit or a concurrent tuple from the transaction, and passes other errors on', async () => {
    const { service, repository } = setup();
    repository.createAssetAndSetMapping.mockResolvedValueOnce({
      status: 'limit',
    } as never);
    expect((await errorOf(() => upload(service))).code).toBe(
      'CS_RENDER_FONT_LIMIT'
    );
    repository.createAssetAndSetMapping.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    expect(await errorOf(() => upload(service))).toEqual({
      status: 409,
      msg: 'The render font changed. Try again.',
      code: 'CS_RENDER_FONT_CONFLICT',
    });
  });

  it('FU22 leaves the Media upload rules without fonts', () => {
    const upload = path.join(__dirname, '../../../upload');
    for (const file of [
      'local.storage.ts',
      'cloudflare.storage.ts',
      'r2.uploader.ts',
      'custom.upload.validation.ts',
    ]) {
      expect(fs.readFileSync(path.join(upload, file), 'utf8')).not.toMatch(
        /font\/|\.ttf|\.otf/
      );
    }
  });
});

describe('ContentStudioRenderFontService mappings', () => {
  const seed = (state: { mappings: Row[] }, extra: Row = {}) =>
    state.mappings.push({
      id: MAPPING,
      family: 'Inter',
      weight: 400,
      style: 'normal',
      fontAssetId: 'asset-1',
      disabledAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    });

  it('FMS12/RF-AUTH1 any member lists the safe summaries of the organization', async () => {
    const { service, state, repository } = setup();
    seed(state);
    const listed = await service.listFonts(ORG);
    expect(repository.listMappingsForOrganization).toHaveBeenCalledWith(ORG);
    expect(listed).toEqual([
      {
        id: MAPPING,
        family: 'Inter',
        weight: 400,
        style: 'normal',
        disabledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  it('FMS13/FMS14 disables and enables idempotently, keeping the asset', async () => {
    const { service, state } = setup();
    seed(state);
    expect(
      (await service.disableFont(actor(), MAPPING)).disabledAt
    ).toBeInstanceOf(Date);
    expect(
      (await service.disableFont(actor(), MAPPING)).disabledAt
    ).toBeInstanceOf(Date);
    expect(state.mappings[0].fontAssetId).toBe('asset-1');
    expect(
      (await service.enableFont(actor('SUPERADMIN'), MAPPING)).disabledAt
    ).toBeNull();
    expect((await service.enableFont(actor(), MAPPING)).disabledAt).toBeNull();
  });

  it('RF-AUTH3/RF-AUTH4 a USER cannot disable or enable', async () => {
    const { service, state, repository } = setup();
    seed(state);
    for (const run of [
      () => service.disableFont(actor('USER'), MAPPING),
      () => service.enableFont(actor('USER'), MAPPING),
    ]) {
      expect((await errorOf(run)).code).toBe('CS_RENDER_FONT_ADMIN_REQUIRED');
    }
    expect(repository.disableMapping).not.toHaveBeenCalled();
    expect(repository.enableMapping).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed, missing or foreign mapping', async () => {
    const { service, state } = setup();
    seed(state);
    for (const id of ['nope', '77777777-7777-4777-8777-777777777777']) {
      expect(await errorOf(() => service.disableFont(actor(), id))).toEqual({
        status: 404,
        msg: 'Render font not found.',
        code: 'CS_NOT_FOUND',
      });
      expect(
        (await errorOf(() => service.enableFont(actor(), id))).status
      ).toBe(404);
    }
    const foreign = {
      organization: { id: 'org-b', users: [{ role: 'ADMIN', userId: USER }] },
      user: { id: USER },
    };
    expect(
      (await errorOf(() => service.disableFont(foreign, MAPPING))).status
    ).toBe(404);
  });

  it('FMS16 refuses to enable past the limit', async () => {
    const { service, state } = setup();
    seed(state, { disabledAt: NOW });
    for (let n = 0; n < RENDER_FONT_ACTIVE_MAX; n += 1) {
      state.mappings.push({
        id: `m-${n}`,
        family: `F${n}`,
        weight: 400,
        style: 'normal',
        disabledAt: null,
      });
    }
    expect(
      (await errorOf(() => service.enableFont(actor(), MAPPING))).code
    ).toBe('CS_RENDER_FONT_LIMIT');
    expect(state.mappings[0].disabledAt).toEqual(NOW);
  });

  it('FMS20 the service fetches nothing and takes no URL or path', () => {
    // code only, not the comments
    const source = fs
      .readFileSync(
        path.join(__dirname, 'content-studio.render-font.service.ts'),
        'utf8'
      )
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(source).not.toMatch(
      /\bfetch\(|axios|undici|safe\.fetch|from 'fs'|originalname|mimetype|CheckPolicies|Sections\./
    );
  });
});
