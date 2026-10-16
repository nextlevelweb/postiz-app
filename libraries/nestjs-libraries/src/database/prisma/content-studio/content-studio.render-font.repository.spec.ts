import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  ContentStudioRenderFontRepository,
  RENDER_FONT_MAPPINGS_LIST_MAX,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.repository';

// No database: the Prisma delegates are mocked over in-memory rows that
// apply where clauses like Prisma and roll back a throwing transaction. The
// real constraints come with the PostgreSQL integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = new Date('2026-10-16T10:00:00.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (value && typeof value === 'object' && 'not' in (value as Row)) {
      return row[key] !== (value as Row).not;
    }
    return row[key] === value;
  });

const setup = () => {
  const state = { assets: [] as Row[], mappings: [] as Row[] };
  const pick = (table: 'assets' | 'mappings', row: Row, select?: Row) =>
    select
      ? Object.fromEntries(
          Object.entries(select).map(([key, value]) => {
            if (key === 'fontAsset' && table === 'mappings') {
              const asset = state.assets.find(
                (entry) =>
                  entry.id === row.fontAssetId &&
                  entry.organizationId === row.organizationId
              ) as Row;
              return [
                key,
                Object.fromEntries(
                  Object.keys((value as { select: Row }).select).map((k) => [
                    k,
                    asset[k],
                  ])
                ),
              ];
            }
            return [key, row[key]];
          })
        )
      : { ...row };
  const unique = (table: 'assets' | 'mappings', data: Row) => {
    const rows = state[table];
    const clash =
      table === 'mappings'
        ? rows.some(
            (r) =>
              r.organizationId === data.organizationId &&
              r.family === data.family &&
              r.weight === data.weight &&
              r.style === data.style
          )
        : rows.some(
            (r) =>
              r.id === data.id ||
              (r.organizationId === data.organizationId &&
                r.storageKey === data.storageKey)
          );
    if (clash) {
      throw new Error('Unique constraint failed');
    }
    if (
      table === 'mappings' &&
      !state.assets.some(
        (a) =>
          a.id === data.fontAssetId && a.organizationId === data.organizationId
      )
    ) {
      throw new Error(
        'Foreign key constraint failed (fontAssetId, organizationId)'
      );
    }
  };
  const delegate = (table: 'assets' | 'mappings') => ({
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = state[table].find((r) => matches(r, args.where));
      return row ? pick(table, row, args.select) : null;
    }),
    findMany: jest.fn(
      async (args: {
        where: Row;
        select?: Row;
        take?: number;
        orderBy?: Row[];
      }) =>
        state[table]
          .filter((r) => matches(r, args.where))
          .sort((a, b) =>
            JSON.stringify([a.family, a.weight, a.style, a.id]) <
            JSON.stringify([b.family, b.weight, b.style, b.id])
              ? -1
              : 1
          )
          .slice(0, args.take)
          .map((r) => pick(table, r, args.select))
    ),
    count: jest.fn(
      async (args: { where: Row }) =>
        state[table].filter((r) => matches(r, args.where)).length
    ),
    create: jest.fn(async (args: { data: Row; select?: Row }) => {
      unique(table, args.data);
      const row = {
        createdAt: NOW,
        ...(table === 'mappings' ? { updatedAt: NOW, disabledAt: null } : {}),
        ...args.data,
      };
      state[table].push(row);
      return pick(table, row, args.select);
    }),
    update: jest.fn(async (args: { where: Row; data: Row; select?: Row }) => {
      const row = state[table].find((r) => matches(r, args.where));
      if (!row) {
        throw new Error('Record to update not found');
      }
      Object.assign(row, args.data, { updatedAt: new Date(NOW.getTime() + 1) });
      return pick(table, row, args.select);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const rows = state[table].filter((r) => matches(r, args.where));
      for (const row of rows) {
        Object.assign(row, args.data);
      }
      return { count: rows.length };
    }),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });
  const asset = delegate('assets');
  const mapping = delegate('mappings');
  const tx = {
    contentStudioRenderFontAsset: asset,
    contentStudioRenderFontMapping: mapping,
  };
  const transaction = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(tx);
      } catch (err) {
        state.assets = snapshot.assets;
        state.mappings = snapshot.mappings;
        throw err;
      }
    }),
  };
  const repository = new ContentStudioRenderFontRepository(
    {
      model: { contentStudioRenderFontAsset: asset },
    } as unknown as PrismaRepository<'contentStudioRenderFontAsset'>,
    {
      model: { contentStudioRenderFontMapping: mapping },
    } as unknown as PrismaRepository<'contentStudioRenderFontMapping'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, state, asset, mapping, transaction };
};

const INTER = { family: 'Inter', weight: 400, style: 'normal' };

const upload = (
  repository: ContentStudioRenderFontRepository,
  n: number,
  extra: {
    organizationId?: string;
    font?: typeof INTER;
    activeLimit?: number;
  } = {}
) => {
  const organizationId = extra.organizationId ?? ORG;
  return repository.createAssetAndSetMapping({
    organizationId,
    createdById: USER,
    mappingId: uuid(500 + n),
    font: extra.font ?? INTER,
    asset: {
      id: uuid(n),
      storageKey: `fonts/${organizationId}/${uuid(n)}.ttf`,
      sha256: String(n % 10).repeat(64),
      byteSize: 1000 + n,
      format: 'ttf',
    },
    activeLimit: extra.activeLimit ?? 64,
  });
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

describe('ContentStudioRenderFontRepository', () => {
  it('FMR6/FA1 creates an immutable asset and a mapping to it, returning the safe summary only', async () => {
    const { repository, state } = setup();
    const result = await upload(repository, 1);
    expect(result.status).toBe('set');
    expect(Object.keys((result as { mapping: Row }).mapping).sort()).toEqual(
      SUMMARY_KEYS
    );
    expect(state.assets).toEqual([
      {
        id: uuid(1),
        organizationId: ORG,
        storageKey: `fonts/${ORG}/${uuid(1)}.ttf`,
        sha256: '1'.repeat(64),
        byteSize: 1001,
        format: 'ttf',
        createdById: USER,
        createdAt: NOW,
      },
    ]);
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0]).toMatchObject({
      id: uuid(501),
      organizationId: ORG,
      ...INTER,
      fontAssetId: uuid(1),
      disabledAt: null,
    });
  });

  it('FMR7/FMR8/FU16/FU17 a replacement adds a new asset, keeps the mapping id and leaves the old asset as it was', async () => {
    const { repository, state } = setup();
    await upload(repository, 1);
    const before = JSON.parse(JSON.stringify(state.assets[0]));
    await repository.disableMapping(ORG, uuid(501), NOW);
    const second = await upload(repository, 2);
    expect(second.status).toBe('set');
    expect((second as { mapping: Row }).mapping.id).toBe(uuid(501));
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].fontAssetId).toBe(uuid(2));
    expect(state.mappings[0].disabledAt).toBeNull();
    expect(state.assets).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(state.assets[0]))).toEqual(before);
  });

  it('FMR2/FMR1 keeps tuples per organization and lists for one organization, in tuple order, bounded', async () => {
    const { repository, mapping } = setup();
    await upload(repository, 1, {
      font: { family: 'Lora', weight: 700, style: 'normal' },
    });
    await upload(repository, 2);
    await upload(repository, 3, {
      font: { family: 'Inter', weight: 300, style: 'normal' },
    });
    await upload(repository, 4, { organizationId: OTHER_ORG });
    const listed = await repository.listMappingsForOrganization(ORG);
    expect(listed.map((row) => [row.family, row.weight])).toEqual([
      ['Inter', 300],
      ['Inter', 400],
      ['Lora', 700],
    ]);
    expect(
      listed.every(
        (row) => Object.keys(row).sort().join() === SUMMARY_KEYS.join()
      )
    ).toBe(true);
    const args = mapping.findMany.mock.calls[0][0] as Row;
    expect(args.where).toEqual({ organizationId: ORG });
    expect(args.take).toBe(RENDER_FONT_MAPPINGS_LIST_MAX);
    expect(args.orderBy).toEqual([
      { family: 'asc' },
      { weight: 'asc' },
      { style: 'asc' },
      { id: 'asc' },
    ]);
    expect(
      await repository.listMappingsForOrganization(OTHER_ORG)
    ).toHaveLength(1);
  });

  it('FMR3/FA2/FA3 reads mappings and assets of the organization only', async () => {
    const { repository } = setup();
    await upload(repository, 1);
    expect(
      await repository.getMappingForOrganization(ORG, uuid(501))
    ).not.toBeNull();
    expect(
      await repository.getMappingForOrganization(OTHER_ORG, uuid(501))
    ).toBeNull();
    expect(await repository.getFontAssetForOrganization(ORG, uuid(1))).toEqual({
      id: uuid(1),
      storageKey: `fonts/${ORG}/${uuid(1)}.ttf`,
      sha256: '1'.repeat(64),
      byteSize: 1001,
      format: 'ttf',
    });
    expect(
      await repository.getFontAssetForOrganization(OTHER_ORG, uuid(1))
    ).toBeNull();
  });

  it('FMR4/FMR5 finds the enabled mapping of the exact tuple with its current asset, and not a disabled one', async () => {
    const { repository } = setup();
    await upload(repository, 1);
    const active = await repository.getActiveMappingBySpec(ORG, INTER);
    expect(active).toEqual({
      id: uuid(501),
      family: 'Inter',
      weight: 400,
      style: 'normal',
      fontAsset: {
        id: uuid(1),
        storageKey: `fonts/${ORG}/${uuid(1)}.ttf`,
        sha256: '1'.repeat(64),
        byteSize: 1001,
        format: 'ttf',
      },
    });
    for (const other of [
      { ...INTER, family: 'inter' },
      { ...INTER, family: 'Inter ' },
      { ...INTER, weight: 500 },
      { ...INTER, style: 'italic' },
    ]) {
      expect(await repository.getActiveMappingBySpec(ORG, other)).toBeNull();
    }
    expect(
      await repository.getActiveMappingBySpec(OTHER_ORG, INTER)
    ).toBeNull();
    await repository.disableMapping(ORG, uuid(501), NOW);
    expect(await repository.getActiveMappingBySpec(ORG, INTER)).toBeNull();
    expect(await repository.getMappingBySpec(ORG, INTER)).toMatchObject({
      disabledAt: NOW,
    });
  });

  it('FMR9/FMR10/FMR11 disables and enables within the organization only, and counts enabled mappings', async () => {
    const { repository, state } = setup();
    await upload(repository, 1);
    expect(
      (await repository.disableMapping(OTHER_ORG, uuid(501), NOW)).count
    ).toBe(0);
    expect(await repository.countActiveMappings(ORG)).toBe(1);
    expect((await repository.disableMapping(ORG, uuid(501), NOW)).count).toBe(
      1
    );
    expect((await repository.disableMapping(ORG, uuid(501), NOW)).count).toBe(
      0
    );
    expect(await repository.countActiveMappings(ORG)).toBe(0);
    expect(state.mappings[0].fontAssetId).toBe(uuid(1));
    expect(
      (await repository.enableMapping(OTHER_ORG, uuid(501), 64)).status
    ).toBe('not-found');
    expect((await repository.enableMapping(ORG, uuid(501), 64)).status).toBe(
      'enabled'
    );
    expect((await repository.enableMapping(ORG, uuid(501), 64)).status).toBe(
      'unchanged'
    );
    expect(await repository.countActiveMappings(ORG)).toBe(1);
  });

  it('FMS15/FMS16/FMS17 enables a new tuple only below the limit; a replacement or a disabled one does not count', async () => {
    const { repository, state } = setup();
    await upload(repository, 1, { activeLimit: 2 });
    await upload(repository, 2, {
      font: { family: 'Lora', weight: 400, style: 'normal' },
      activeLimit: 2,
    });
    const third = await upload(repository, 3, {
      font: { family: 'Mono', weight: 400, style: 'normal' },
      activeLimit: 2,
    });
    expect(third.status).toBe('limit');
    expect(state.assets).toHaveLength(2);
    // replacing an enabled tuple does not count
    expect((await upload(repository, 4, { activeLimit: 2 })).status).toBe(
      'set'
    );
    await repository.disableMapping(ORG, uuid(501), NOW);
    expect(
      (
        await upload(repository, 5, {
          font: { family: 'Mono', weight: 400, style: 'normal' },
          activeLimit: 2,
        })
      ).status
    ).toBe('set');
    expect((await repository.enableMapping(ORG, uuid(501), 2)).status).toBe(
      'limit'
    );
    expect(state.mappings.find((m) => m.id === uuid(501))?.disabledAt).toEqual(
      NOW
    );
  });

  it('rolls the asset back when the mapping cannot be written', async () => {
    const { repository, state, mapping } = setup();
    mapping.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(upload(repository, 1)).rejects.toThrow('write failed');
    expect(state.assets).toEqual([]);
    expect(state.mappings).toEqual([]);
  });

  it('FMR14/FA8/FA9 has no method to delete or to change an asset', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioRenderFontRepository.prototype
      ).sort()
    ).toEqual([
      'constructor',
      'countActiveMappings',
      'createAssetAndSetMapping',
      'disableMapping',
      'enableMapping',
      'getActiveMappingBySpec',
      'getFontAssetForOrganization',
      'getMappingBySpec',
      'getMappingForOrganization',
      'listMappingsForOrganization',
    ]);
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.render-font.repository.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\.delete(Many)?\(|\.upsert\(/);
    expect(source).not.toMatch(/contentStudioRenderFontAsset\.update/);
  });

  describe('schema', () => {
    const schema = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
      ),
      'utf8'
    );
    const block = (name: string) => {
      const match = schema.match(
        new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`)
      );
      if (!match) {
        throw new Error(`model ${name} not found`);
      }
      return match[1];
    };
    const fields = (name: string) =>
      Object.fromEntries(
        block(name)
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter(([field]) => field && !field.startsWith('@@'))
          .map(([field, type]) => [field, type])
      );

    it('FA10/FMR13 an asset holds a private key, its hash, size and format: no URL, path, Media or bytes', () => {
      expect(fields('ContentStudioRenderFontAsset')).toEqual({
        id: 'String',
        organizationId: 'String',
        storageKey: 'String',
        sha256: 'String',
        byteSize: 'Int',
        format: 'String',
        createdById: 'String',
        createdAt: 'DateTime',
        organization: 'Organization',
        createdBy: 'User',
        mappings: 'ContentStudioRenderFontMapping[]',
      });
      const asset = block('ContentStudioRenderFontAsset');
      expect(asset).toMatch(/@@unique\(\[id, organizationId\]\)/);
      expect(asset).toMatch(/@@unique\(\[organizationId, storageKey\]\)/);
      expect(asset).not.toMatch(/updatedAt|deletedAt|url|path|mediaId/i);
    });

    it('FMR12/FMR13 a mapping is unique per tuple and organization and points to an asset of its own organization', () => {
      expect(fields('ContentStudioRenderFontMapping')).toEqual({
        id: 'String',
        organizationId: 'String',
        family: 'String',
        weight: 'Int',
        style: 'String',
        fontAssetId: 'String',
        disabledAt: 'DateTime?',
        createdById: 'String',
        createdAt: 'DateTime',
        updatedAt: 'DateTime',
        organization: 'Organization',
        fontAsset: 'ContentStudioRenderFontAsset',
        createdBy: 'User',
      });
      const mapping = block('ContentStudioRenderFontMapping');
      expect(mapping).toMatch(
        /@@unique\(\[organizationId, family, weight, style\]\)/
      );
      expect(mapping).toMatch(/@@unique\(\[id, organizationId\]\)/);
      expect(mapping).toMatch(
        /fontAsset\s+ContentStudioRenderFontAsset\s+@relation\(fields: \[fontAssetId, organizationId\], references: \[id, organizationId\]\)/
      );
    });

    it('leaves the Media model without a font type, hash or render field', () => {
      expect(block('Media')).not.toMatch(/sha256|font|render|contentStudio/i);
    });
  });
});
