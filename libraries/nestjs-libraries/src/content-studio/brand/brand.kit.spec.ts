import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { createHash } from 'crypto';
import {
  BRAND_KIT_CONTENT_MAX_BYTES,
  ContentStudioBrandKitError,
  ContentStudioBrandKitTooLargeError,
  emptyContentStudioBrandKitContent,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioBrandKitIntegrityError,
  parseVerifiedContentStudioBrandKitRevision,
  storedContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';

const MARKER = 'BRAND_KIT_PRIVATE_MARKER_123';

const color = (overrides: Record<string, unknown> = {}) => ({
  id: 'primary',
  name: 'Blue',
  value: '#0057ff',
  role: 'primary',
  ...overrides,
});
const font = (overrides: Record<string, unknown> = {}) => ({
  id: 'heading',
  name: 'Heading',
  family: 'Inter',
  weight: 700,
  style: 'normal',
  role: 'heading',
  ...overrides,
});
const kit = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  identity: {
    brandName: 'Northwind',
    tagline: 'Tools that last',
    description: `Calm, precise and practical. ${MARKER}`,
  },
  colors: [
    color(),
    color({ id: 'paper', name: 'Paper', value: '#FAFAF7', role: 'background' }),
    color({ id: 'ink', name: 'Ink', value: '#111111', role: 'text' }),
    color({ id: 'accent_2', name: 'Lime', value: '#a3e635', role: 'custom' }),
  ],
  typography: [
    font(),
    font({
      id: 'body',
      name: 'Body',
      family: 'Source Serif 4',
      weight: 400,
      role: 'body',
    }),
    font({ id: 'quote', name: 'Quote', style: 'italic', role: 'custom' }),
  ],
  visualDirection: {
    keywords: ['calm', 'precise'],
    dos: [`Use generous whitespace. ${MARKER}`],
    donts: ['No gradients'],
  },
  ...overrides,
});
const withIdentity = (identity: Record<string, unknown>) =>
  kit({ identity: { ...kit().identity, ...identity } });
const withVisual = (visual: Record<string, unknown>) =>
  kit({ visualDirection: { ...kit().visualDirection, ...visual } });

const parse = parseContentStudioBrandKitContent;
// The refusal of the parser: always the fixed error, never the input
const refused = (input: unknown) => {
  let error: unknown;
  try {
    parse(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioBrandKitError);
  expect(inspect(error, { depth: 8 })).not.toContain(MARKER);
  return error as ContentStudioBrandKitError;
};
const invalid = (input: unknown) => expect(refused(input).code).toBe('INVALID');
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const stored = (input: unknown) =>
  storedContentStudioBrandKitContent(parse(input));

// ============================================================================
describe('Brand Kit v1: shape', () => {
  it('BK1 the empty kit is valid', () => {
    expect(emptyContentStudioBrandKitContent()).toEqual({
      schemaVersion: 1,
      identity: { brandName: '', tagline: '', description: '' },
      colors: [],
      typography: [],
      visualDirection: { keywords: [], dos: [], donts: [] },
    });
  });

  it('BK2 a full representative kit is valid and returned as a new object', () => {
    const input = kit();
    const parsed = parse(input);
    expect(parsed).not.toBe(input);
    expect(parsed.colors[1]).toEqual({
      id: 'paper',
      name: 'Paper',
      value: '#fafaf7',
      role: 'background',
    });
    expect(parsed.typography).toEqual(input.typography);
    // the input is not changed
    expect((input.colors as Array<{ value: string }>)[1].value).toBe('#FAFAF7');
  });

  it('BK3/70 has exactly these keys at every level', () => {
    const parsed = parse(kit());
    expect(Object.keys(parsed).sort()).toEqual([
      'colors',
      'identity',
      'schemaVersion',
      'typography',
      'visualDirection',
    ]);
    expect(Object.keys(parsed.identity).sort()).toEqual([
      'brandName',
      'description',
      'tagline',
    ]);
    expect(Object.keys(parsed.colors[0]).sort()).toEqual([
      'id',
      'name',
      'role',
      'value',
    ]);
    expect(Object.keys(parsed.typography[0]).sort()).toEqual([
      'family',
      'id',
      'name',
      'role',
      'style',
      'weight',
    ]);
    expect(Object.keys(parsed.visualDirection).sort()).toEqual([
      'donts',
      'dos',
      'keywords',
    ]);
  });

  it.each([
    'identity',
    'colors',
    'typography',
    'visualDirection',
    'schemaVersion',
  ])('BK3 needs %s', (key) => {
    const input: Record<string, unknown> = kit();
    delete input[key];
    invalid(input);
  });

  it('refuses another schema version', () => {
    invalid(kit({ schemaVersion: 2 }));
    invalid(kit({ schemaVersion: '1' }));
  });

  it.each([
    'css',
    'html',
    'svg',
    'markup',
    'template',
    'logo',
    'logoUrl',
    'mediaId',
    'assets',
    'pages',
    'layers',
    'fonts',
    'name',
  ])('BK4/70/43 refuses a top-level %s field', (key) => {
    invalid(kit({ [key]: MARKER }));
  });

  it.each(['logoUrl', 'website', 'name', 'html'])(
    'BK5 refuses an identity %s field',
    (key) => invalid(withIdentity({ [key]: MARKER }))
  );

  it.each([
    'mediaId',
    'css',
    'opacity',
    'alpha',
    'gradient',
    'className',
    'width',
  ])('BK6 refuses a color %s field', (key) =>
    invalid(kit({ colors: [color({ [key]: MARKER })] }))
  );

  it.each([
    'fontUrl',
    'fontFile',
    'fontMediaId',
    'src',
    'css',
    'size',
    'lineHeight',
    'url',
  ])('BK7 refuses a typography %s field', (key) =>
    invalid(kit({ typography: [font({ [key]: MARKER })] }))
  );

  it.each(['moodboard', 'imageUrl', 'palette', 'voice'])(
    'BK8 refuses a visualDirection %s field',
    (key) => invalid(withVisual({ [key]: [MARKER] }))
  );

  it('BK9 refuses class instances, at the top and inside', () => {
    class Kit {
      schemaVersion = 1;
    }
    invalid(new Kit());
    invalid(Object.assign(Object.create({ inherited: true }), kit()));
    invalid(withIdentity({ brandName: new String('x') }));
  });

  it('BK10 refuses Date, Map, Set, functions and arrays where an object belongs', () => {
    invalid(kit({ identity: new Date() }));
    invalid(kit({ colors: new Set([color()]) }));
    invalid(kit({ visualDirection: new Map() }));
    invalid(kit({ identity: () => ({}) }));
    invalid(kit({ identity: [] }));
    invalid(kit({ colors: {} }));
    invalid(withVisual({ dos: 'one' }));
    invalid([]);
    invalid(null);
    invalid(MARKER);
  });

  it('accepts an object without a prototype', () => {
    const input = Object.assign(Object.create(null), kit());
    expect(parse(input).identity.brandName).toBe('Northwind');
  });
});

// ============================================================================
describe('Brand Kit v1: identity', () => {
  it('BI1/BI2/BI3 normalizes line endings and trims the outside only', () => {
    const parsed = parse(
      withIdentity({
        brandName: '  North\twind  ',
        tagline: '\r\nTools  that last\r\n',
        description: '  First line\r\nSecond line\rThird  ',
      })
    );
    expect(parsed.identity).toEqual({
      brandName: 'North\twind',
      tagline: 'Tools  that last',
      description: 'First line\nSecond line\nThird',
    });
  });

  it('BI4 empty and blank texts are valid and stored empty', () => {
    expect(
      parse(withIdentity({ brandName: '', tagline: '   ', description: '\n' }))
        .identity
    ).toEqual({ brandName: '', tagline: '', description: '' });
  });

  it.each([
    ['BI5 brandName', 'brandName', 200],
    ['BI6 tagline', 'tagline', 300],
    ['BI7 description', 'description', 2000],
  ])('%s takes up to %s characters', (_name, field, max) => {
    expect(
      parse(withIdentity({ [field as string]: 'a'.repeat(max as number) }))
        .identity[field as 'brandName']
    ).toHaveLength(max as number);
    invalid(
      withIdentity({ [field as string]: 'a'.repeat((max as number) + 1) })
    );
    // counted after trimming
    expect(
      parse(
        withIdentity({ [field as string]: ` ${'a'.repeat(max as number)} ` })
      ).identity[field as 'brandName']
    ).toHaveLength(max as number);
  });

  it('refuses identity values that are not text', () => {
    invalid(withIdentity({ brandName: null }));
    invalid(withIdentity({ tagline: 3 }));
    invalid(withIdentity({ description: undefined }));
  });

  it('BI8 refuses NUL anywhere', () => {
    invalid(withIdentity({ brandName: `A\u0000${MARKER}` }));
    invalid(withIdentity({ description: `\u0000` }));
  });

  it('BI9 refuses lone surrogates anywhere', () => {
    invalid(withIdentity({ brandName: `\ud800${MARKER}` }));
    invalid(withIdentity({ tagline: 'x\udc00' }));
    invalid(withIdentity({ description: '\udbffA' }));
  });

  it('BI10 keeps Unicode as written: no NFC normalization', () => {
    const decomposed = 'Café 🚀 漢字';
    expect(
      parse(withIdentity({ brandName: decomposed })).identity.brandName
    ).toBe(decomposed);
    expect(decomposed.normalize('NFC')).not.toBe(decomposed);
  });
});

// ============================================================================
describe('Brand Kit v1: colors', () => {
  const colors = (list: unknown[]) => kit({ colors: list });
  const customs = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      color({ id: `c${i}`, name: `Color ${i}`, role: 'custom' })
    );

  it('BC1/BC2/BC3 takes zero to sixteen colors', () => {
    expect(parse(colors([])).colors).toEqual([]);
    expect(parse(colors(customs(16))).colors).toHaveLength(16);
    invalid(colors(customs(17)));
  });

  it.each([
    'primary',
    'brand-blue',
    'accent_2',
    'a',
    'x'.padEnd(32, '0'),
    'constructor',
  ])('BC4 accepts the token id %s', (id) => {
    expect(parse(colors([color({ id })])).colors[0].id).toBe(id);
  });

  it.each([
    'Primary',
    '1primary',
    '-primary',
    '_primary',
    'brand blue',
    'brand.blue',
    'brand/blue',
    'blüe',
    '',
    'x'.padEnd(33, '0'),
    '__proto__',
    ' primary',
  ])('BC5 refuses the token id %j', (id) => {
    invalid(colors([color({ id })]));
  });

  it('BC6 refuses a token id used twice, never merges', () => {
    const error = refused(
      colors([
        color({ id: 'blue', role: 'custom' }),
        color({ id: 'blue', role: 'custom', name: MARKER }),
      ])
    );
    expect(error.issues).toEqual([
      expect.objectContaining({ path: ['colors', 1, 'id'] }),
    ]);
  });

  it('BC7/BC8 a name takes 1 to 80 characters, trimmed', () => {
    expect(
      parse(colors([color({ name: ` ${'n'.repeat(80)} ` })])).colors[0].name
    ).toHaveLength(80);
    invalid(colors([color({ name: 'n'.repeat(81) })]));
    invalid(colors([color({ name: '' })]));
    invalid(colors([color({ name: '   ' })]));
    invalid(colors([color({ name: `a\u0000` })]));
  });

  it('BC9/BC10/48 takes #rrggbb and stores it lowercase', () => {
    expect(parse(colors([color({ value: '#0057ff' })])).colors[0].value).toBe(
      '#0057ff'
    );
    expect(parse(colors([color({ value: '#AABBCC' })])).colors[0].value).toBe(
      '#aabbcc'
    );
    expect(stored(colors([color({ value: '#AABBCC' })]))).toEqual(
      stored(colors([color({ value: '#aabbcc' })]))
    );
  });

  it.each([
    ['BC11 shorthand', '#fff'],
    ['BC12 alpha', '#0057ffcc'],
    ['BC12 short alpha', '#fffa'],
    ['BC13 rgb()', 'rgb(0, 87, 255)'],
    ['BC13 hsl()', 'hsl(220, 100%, 50%)'],
    ['BC13 a name', 'blue'],
    ['a variable', 'var(--brand)'],
    ['a gradient', 'linear-gradient(#000, #fff)'],
    ['no hash', '0057ff'],
    ['spaces', ' #0057ff'],
    ['not hex', '#0057fg'],
    ['a number', 0x0057ff],
  ])('refuses %s', (_name, value) => {
    invalid(colors([color({ value })]));
  });

  it('BC14/BC15 takes exactly these roles', () => {
    const roles = [
      'primary',
      'secondary',
      'accent',
      'background',
      'surface',
      'text',
      'muted',
      'custom',
    ];
    expect(
      parse(
        colors(roles.map((role, i) => color({ id: `c${i}`, role })))
      ).colors.map((c) => c.role)
    ).toEqual(roles);
    for (const role of ['Primary', 'brand', 'logo', '', null]) {
      invalid(colors([color({ role })]));
    }
  });

  it.each([
    'primary',
    'secondary',
    'accent',
    'background',
    'surface',
    'text',
    'muted',
  ])('BC16/BC17 refuses a second %s color', (role) => {
    const error = refused(
      colors([
        color({ id: 'one', role }),
        color({ id: 'two', role, value: '#000000' }),
      ])
    );
    expect(error.issues).toEqual([
      expect.objectContaining({ path: ['colors', 1, 'role'] }),
    ]);
  });

  it('BC18/BC19 allows many custom colors, and repeated names and values', () => {
    const parsed = parse(
      colors([
        color({ id: 'extra-a', role: 'custom', name: 'Same' }),
        color({ id: 'extra-b', role: 'custom', name: 'Same' }),
        color({ id: 'main', role: 'primary' }),
      ])
    );
    expect(parsed.colors.map((c) => c.value)).toEqual([
      '#0057ff',
      '#0057ff',
      '#0057ff',
    ]);
  });

  it('BC20/49 keeps the order of the colors', () => {
    const list = [
      color({ id: 'b', role: 'custom' }),
      color({ id: 'a', role: 'custom' }),
      color({ id: 'c', role: 'primary' }),
    ];
    expect(parse(colors(list)).colors.map((c) => c.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});

// ============================================================================
describe('Brand Kit v1: typography', () => {
  const typography = (list: unknown[]) => kit({ typography: list });
  const customs = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      font({ id: `t${i}`, name: `Type ${i}`, role: 'custom' })
    );

  it('BT1/BT2/BT3 takes zero to eight type styles', () => {
    expect(parse(typography([])).typography).toEqual([]);
    expect(parse(typography(customs(8))).typography).toHaveLength(8);
    invalid(typography(customs(9)));
  });

  it('BT4 uses the same token id rules as colors, in its own namespace', () => {
    expect(parse(typography([font({ id: 'body_2' })])).typography[0].id).toBe(
      'body_2'
    );
    for (const id of ['Body', '2body', 'body.text', '', 'x'.padEnd(33, '0')]) {
      invalid(typography([font({ id })]));
    }
    // a color and a type style may share an id
    const parsed = parse(
      kit({
        colors: [color({ id: 'accent', role: 'accent' })],
        typography: [font({ id: 'accent', role: 'accent' })],
      })
    );
    expect([parsed.colors[0].id, parsed.typography[0].id]).toEqual([
      'accent',
      'accent',
    ]);
  });

  it('BT5 refuses a type style id used twice', () => {
    const error = refused(
      typography([
        font({ id: 'same', role: 'custom' }),
        font({ id: 'same', role: 'custom' }),
      ])
    );
    expect(error.issues).toEqual([
      expect.objectContaining({ path: ['typography', 1, 'id'] }),
    ]);
  });

  it('BT6 a name takes 1 to 80 characters', () => {
    expect(
      parse(typography([font({ name: 'n'.repeat(80) })])).typography[0].name
    ).toHaveLength(80);
    invalid(typography([font({ name: 'n'.repeat(81) })]));
    invalid(typography([font({ name: ' ' })]));
  });

  it('BT7/17 a family takes 1 to 200 characters and stays plain text', () => {
    const family = `"Inter", system-ui, url(https://evil.example/f.woff2) ${MARKER}`;
    // descriptive text only: never parsed as CSS or resolved
    expect(parse(typography([font({ family })])).typography[0].family).toBe(
      family
    );
    expect(
      parse(typography([font({ family: 'f'.repeat(200) })])).typography[0]
        .family
    ).toHaveLength(200);
    invalid(typography([font({ family: 'f'.repeat(201) })]));
    invalid(typography([font({ family: '' })]));
    invalid(typography([font({ family: '\u0000' })]));
  });

  it('BT8/BT9 takes the weights 100 to 900 in steps of 100 only', () => {
    for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(parse(typography([font({ weight })])).typography[0].weight).toBe(
        weight
      );
    }
    for (const weight of [450, 0, 1000, 50, 400.5, -400, '400', null, NaN]) {
      invalid(typography([font({ weight })]));
    }
  });

  it('BT10 takes normal or italic only', () => {
    expect(
      parse(typography([font({ style: 'italic' })])).typography[0].style
    ).toBe('italic');
    for (const style of ['oblique', 'Italic', 'bold', '', null]) {
      invalid(typography([font({ style })]));
    }
  });

  it('BT11 takes exactly these roles', () => {
    const roles = ['heading', 'body', 'accent', 'custom'];
    expect(
      parse(
        typography(roles.map((role, i) => font({ id: `t${i}`, role })))
      ).typography.map((t) => t.role)
    ).toEqual(roles);
    for (const role of ['display', 'Heading', 'caption', '']) {
      invalid(typography([font({ role })]));
    }
  });

  it.each(['heading', 'body', 'accent'])(
    'BT12/BT13/BT14 refuses a second %s style',
    (role) => {
      invalid(
        typography([font({ id: 'one', role }), font({ id: 'two', role })])
      );
    }
  );

  it('BT15/BT16 allows many custom styles and repeated families and names', () => {
    expect(
      parse(
        typography([
          font({ id: 'a', role: 'custom', name: 'Same' }),
          font({ id: 'b', role: 'custom', name: 'Same' }),
          font({ id: 'c', role: 'body' }),
        ])
      ).typography.map((t) => t.family)
    ).toEqual(['Inter', 'Inter', 'Inter']);
  });

  it('BT17/50 keeps the order of the type styles', () => {
    expect(
      parse(
        typography([
          font({ id: 'z', role: 'custom' }),
          font({ id: 'a', role: 'heading' }),
        ])
      ).typography.map((t) => t.id)
    ).toEqual(['z', 'a']);
  });
});

// ============================================================================
describe('Brand Kit v1: visual direction', () => {
  const many = (count: number, length = 5) =>
    Array.from({ length: count }, (_, i) => `${i}`.padEnd(length, 'x'));

  it('BV1 empty lists are valid', () => {
    expect(
      parse(withVisual({ keywords: [], dos: [], donts: [] })).visualDirection
    ).toEqual({ keywords: [], dos: [], donts: [] });
  });

  it('BV2/BV3/BV4 keywords: up to 20, each 1 to 60 characters', () => {
    expect(
      parse(withVisual({ keywords: many(20) })).visualDirection.keywords
    ).toHaveLength(20);
    invalid(withVisual({ keywords: many(21) }));
    expect(
      parse(withVisual({ keywords: ['k'.repeat(60)] })).visualDirection
        .keywords[0]
    ).toHaveLength(60);
    invalid(withVisual({ keywords: ['k'.repeat(61)] }));
  });

  it.each(['dos', 'donts'])(
    'BV5/BV6/BV7 %s: up to 20, each 1 to 300 characters',
    (list) => {
      expect(
        parse(withVisual({ [list]: many(20) })).visualDirection[list as 'dos']
      ).toHaveLength(20);
      invalid(withVisual({ [list]: many(21) }));
      expect(
        parse(withVisual({ [list]: ['r'.repeat(300)] })).visualDirection[
          list as 'dos'
        ][0]
      ).toHaveLength(300);
      invalid(withVisual({ [list]: ['r'.repeat(301)] }));
    }
  );

  it('BV8 trims entries and refuses blank ones', () => {
    expect(
      parse(withVisual({ keywords: ['  calm\r\n'] })).visualDirection.keywords
    ).toEqual(['calm']);
    for (const list of ['keywords', 'dos', 'donts']) {
      invalid(withVisual({ [list]: ['  '] }));
      invalid(withVisual({ [list]: [''] }));
      invalid(withVisual({ [list]: [`\ud800${MARKER}`] }));
    }
  });

  it('BV9 refuses an entry twice within a list, compared after trimming and case-sensitively', () => {
    invalid(withVisual({ keywords: ['calm', ' calm '] }));
    invalid(withVisual({ dos: [MARKER, MARKER] }));
    expect(
      parse(withVisual({ keywords: ['Calm', 'calm'] })).visualDirection.keywords
    ).toEqual(['Calm', 'calm']);
  });

  it('BV10 allows the same text across the lists', () => {
    expect(
      parse(withVisual({ keywords: ['Bold'], dos: ['Bold'], donts: ['Bold'] }))
        .visualDirection
    ).toEqual({ keywords: ['Bold'], dos: ['Bold'], donts: ['Bold'] });
  });

  it('BV11 keeps the order of each list', () => {
    expect(
      parse(withVisual({ dos: ['b', 'a', 'c'] })).visualDirection.dos
    ).toEqual(['b', 'a', 'c']);
  });
});

// ============================================================================
describe('Brand Kit v1: size', () => {
  // A kit whose canonical JSON is exactly `target` UTF-8 bytes: list entries
  // of 3-byte characters, then single-byte description characters for the rest
  const sized = (target: number) => {
    const input = {
      schemaVersion: 1,
      identity: { brandName: '', tagline: '', description: '' },
      colors: [],
      typography: [],
      visualDirection: {
        keywords: [] as string[],
        dos: [] as string[],
        donts: [] as string[],
      },
    };
    const size = () =>
      bytes(storedContentStudioBrandKitContent(input as never).content);
    for (const list of ['dos', 'donts'] as const) {
      for (let i = 0; i < 20; i++) {
        const entry = `${String(i).padStart(2, '0')}${'€'.repeat(298)}`;
        input.visualDirection[list].push(entry);
        if (size() > target) {
          input.visualDirection[list].pop();
          break;
        }
      }
    }
    const gap = target - size();
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(2000);
    input.identity.description = 'a'.repeat(gap);
    expect(size()).toBe(target);
    return input;
  };

  it('BS1 a kit below 32 KiB is valid', () => {
    expect(bytes(stored(kit()).content)).toBeLessThan(
      BRAND_KIT_CONTENT_MAX_BYTES
    );
  });

  it('BS2 exactly 32768 bytes is accepted', () => {
    expect(BRAND_KIT_CONTENT_MAX_BYTES).toBe(32_768);
    const input = sized(32_768);
    expect(bytes(stored(input).content)).toBe(32_768);
  });

  it('BS3/BS4 32769 bytes is refused, counted in UTF-8 bytes, not characters', () => {
    const input = sized(32_769);
    // far fewer JavaScript characters than bytes
    expect(JSON.stringify(input).length).toBeLessThan(20_000);
    const error = refused(input);
    expect(error).toBeInstanceOf(ContentStudioBrandKitTooLargeError);
    expect(error.code).toBe('TOO_LARGE');
    expect(error.message).toBe('The Brand Kit is larger than allowed');
  });

  it('BS5 too many entries is invalid, not too large', () => {
    const error = refused(
      withVisual({
        dos: Array.from({ length: 21 }, (_, i) => `${i}${'€'.repeat(299)}`),
      })
    );
    expect(error.code).toBe('INVALID');
    expect(error).not.toBeInstanceOf(ContentStudioBrandKitTooLargeError);
  });
});

// ============================================================================
describe('Brand Kit revisions: canonical storage and verified reads', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const row = (input: unknown = kit()) => stored(input);

  it('BR1 stores canonical JSON with its SHA-256', () => {
    const value = row();
    expect(value.schemaVersion).toBe(1);
    expect(value.content.startsWith('{"colors":[')).toBe(true);
    expect(value.content).not.toMatch(/\n| {2}/);
    expect(value.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(value.contentHash).toBe(sha(value.content));
    expect(JSON.parse(value.content)).toEqual(parse(kit()));
  });

  it('BR2 an uppercase color is lowercased before hashing', () => {
    const upper = row(kit({ colors: [color({ value: '#0057FF' })] }));
    const lower = row(kit({ colors: [color({ value: '#0057ff' })] }));
    expect(upper).toEqual(lower);
  });

  it('BR3 the order of object keys does not matter', () => {
    const input = kit();
    const reordered = {
      visualDirection: {
        donts: input.visualDirection.donts,
        dos: input.visualDirection.dos,
        keywords: input.visualDirection.keywords,
      },
      typography: input.typography.map((t) => ({
        role: t.role,
        style: t.style,
        weight: t.weight,
        family: t.family,
        name: t.name,
        id: t.id,
      })),
      identity: {
        description: input.identity.description,
        tagline: input.identity.tagline,
        brandName: input.identity.brandName,
      },
      colors: input.colors,
      schemaVersion: 1,
    };
    expect(row(reordered)).toEqual(row(input));
  });

  it('BR4/BR5/BR6 the order of colors, type styles and list entries matters', () => {
    const base = row();
    const input = kit();
    expect(
      row(kit({ colors: [...input.colors].reverse() })).contentHash
    ).not.toBe(base.contentHash);
    expect(
      row(kit({ typography: [...input.typography].reverse() })).contentHash
    ).not.toBe(base.contentHash);
    expect(
      row(withVisual({ keywords: ['precise', 'calm'] })).contentHash
    ).not.toBe(base.contentHash);
  });

  it('BR7 reads a stored revision back exactly', () => {
    const value = row();
    expect(parseVerifiedContentStudioBrandKitRevision(value)).toEqual(
      parse(kit())
    );
  });

  const corrupt = (change: Partial<ReturnType<typeof row>>) => {
    let error: unknown;
    try {
      parseVerifiedContentStudioBrandKitRevision({ ...row(), ...change });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContentStudioBrandKitIntegrityError);
    expect((error as Error).message).toBe(
      'A stored Brand Kit revision failed its integrity check'
    );
    expect(inspect(error, { depth: 8 })).not.toContain(MARKER);
    return error;
  };

  it('BR8 malformed JSON', () => {
    corrupt({ content: `{"identity":"${MARKER}"` });
  });

  it('BR9 valid but not canonical JSON', () => {
    const value = row();
    const pretty = JSON.stringify(JSON.parse(value.content), null, 2);
    corrupt({ content: pretty, contentHash: sha(pretty) });
  });

  it('BR10 a content hash that does not match', () => {
    corrupt({ contentHash: 'f'.repeat(64) });
    corrupt({ contentHash: row().contentHash.toUpperCase() });
  });

  it('BR11 another schema version on the row', () => {
    corrupt({ schemaVersion: 2 });
  });

  it('BR12/BR13 an unknown stored field, never repeating it', () => {
    const value = row();
    const extra = JSON.stringify({
      ...JSON.parse(value.content),
      logoUrl: MARKER,
    });
    corrupt({ content: extra, contentHash: sha(extra) });
    const lowered = value.content.replace('#fafaf7', '#FAFAF7');
    // stored content is never normalized on read
    corrupt({ content: lowered, contentHash: sha(lowered) });
  });
});

// ============================================================================
describe('Brand Kit P4-01 scope boundary', () => {
  const ROOT = path.resolve(__dirname, '../../../../..');
  const FILES = [
    'libraries/nestjs-libraries/src/content-studio/brand/brand.kit.ts',
    'libraries/nestjs-libraries/src/content-studio/brand/brand.kit.revision.ts',
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.brand-kit.repository.ts',
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.brand-kit.service.ts',
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.brand-kit.dto.ts',
  ];
  // code only: the comments explain the boundary and may name it
  const code = (file: string) =>
    fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const sources = FILES.map((file) => [file, code(file)] as const);
  const identifiers = (text: string) =>
    new Set(Array.from(text.matchAll(/[A-Za-z_$][\w$]*/g)).map((m) => m[0]));

  it('69/43/47 no asset, Media, logo, font file, URL or encoded data field or import', () => {
    for (const [file, text] of sources) {
      const names = identifiers(text);
      for (const name of [
        'logo',
        'logoUrl',
        'image',
        'imageUrl',
        'mediaId',
        'mediaIds',
        'assetId',
        'assetIds',
        'fontUrl',
        'fontFile',
        'fontMediaId',
        'base64',
        'dataUrl',
        'url',
        'href',
        'src',
        'ContentStudioMediaRepository',
        'ContentStudioMediaService',
        'MediaService',
      ]) {
        expect([file, name, names.has(name)]).toEqual([file, name, false]);
      }
      expect(text).not.toMatch(/from '[^']*media[^']*'/i);
    }
  });

  it('69/46 no renderer, canvas or design document code', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /from '(sharp|fontkit|fabric|canvas|@napi-rs\/canvas|svg[^']*)'/
        ),
      ]);
    }
    // the content schema: the history list of the service has its own pages
    for (const [file, text] of sources.slice(0, 2)) {
      const names = identifiers(text);
      for (const name of [
        'pages',
        'layers',
        'width',
        'height',
        'x',
        'y',
        'css',
        'className',
        'html',
        'svg',
        'markup',
        'templateHtml',
        'styleCss',
      ]) {
        expect([file, name, names.has(name)]).toEqual([file, name, false]);
      }
    }
  });

  it('45 no AI, provider, generation, inference or website analysis', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /AIExecution|ai\.execution|ai\.provider|AIConnection|AIWriting|generateText|from 'openai'|@anthropic-ai|@ai-sdk|safeFetch|\bfetch\(|\b(generate|infer|extract|analy[sz]e)[A-Z]\w*\(/
        ),
      ]);
    }
  });

  it('54 never reads or writes the organization name', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /organization\.(name|update)|\.organization\b|contentStudioOrganization/
        ),
      ]);
    }
  });

  it('42 style is only the typography style, with its two values', () => {
    const domain = sources[0][1];
    // the schema field and its type
    expect(domain.match(/\bstyle\b/g)).toHaveLength(2);
    expect(domain).toContain('style: z.enum(BRAND_FONT_STYLES),');
    expect(domain).toContain(
      "export const BRAND_FONT_STYLES = ['normal', 'italic'] as const;"
    );
  });

  it('55/56/76 AI writing, prompts and operation contexts do not know the Brand Kit', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-writing.service.ts',
      'libraries/nestjs-libraries/src/content-studio/ai/ai.writing.prompt.ts',
      'libraries/nestjs-libraries/src/content-studio/ai/ai.operation.types.ts',
      'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.ai-writing.dto.ts',
    ]) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(/brand.?kit/i),
      ]);
    }
  });

  // P4-08: the design editor lists the revisions to pin one exactly, and
  // asks the server for that revision's reference; still no write
  it('75 the frontend reads Brand Kit revisions for Creative Studio only, and never writes', () => {
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(`${dir}/${entry.name}`)
            : [`${dir}/${entry.name}`]
        );
    const frontend = [
      ...walk('apps/frontend/src/components/content-studio'),
      ...walk('apps/frontend/src/app/(app)/(site)/content-studio'),
    ].filter((file) => /\.tsx?$/.test(file) && !/\.spec\.tsx?$/.test(file));
    expect(frontend.length).toBeGreaterThan(10);
    const CS = 'apps/frontend/src/components/content-studio';
    expect(
      frontend
        .filter((file) => /brand-kit|brandKit|BrandKit/.test(code(file)))
        .sort()
    ).toEqual([
      // P4-12: template cards resolve tokens from the exact revisions their
      // documents name (through the same revision route), and a guided use
      // may name another exact revision; neither writes
      // P4-13: style preset samples and apply use the exact revision's
      // content the design view already holds; nothing is fetched there
      `${CS}/content-studio.design-style-presets.tsx`,
      `${CS}/content-studio.design-template.workspace.tsx`,
      `${CS}/content-studio.design-templates.api.ts`,
      `${CS}/content-studio.design-templates.tsx`,
      // P4-09: the canvas is handed the resolved Brand Kit content to draw
      `${CS}/content-studio.design.canvas.tsx`,
      `${CS}/content-studio.design.editing.tsx`,
      `${CS}/content-studio.design.editor.ts`,
      `${CS}/content-studio.design.preview.tsx`,
      `${CS}/content-studio.design.workspace.tsx`,
      `${CS}/content-studio.designs.api.ts`,
    ]);
    const routes = frontend.flatMap((file) =>
      Array.from(
        code(file).matchAll(/['`](\/content-studio\/brand-kit[^'`]*)['`]/g),
        (m) => m[1]
      )
    );
    expect(routes.sort()).toEqual([
      '/content-studio/brand-kit',
      '/content-studio/brand-kit/revisions/${encodeURIComponent(revisionId)}',
    ]);
    expect(
      frontend.filter((file) =>
        /brand-kit[^'`]*['`],\s*\{\s*method/.test(code(file))
      )
    ).toEqual([]);
    for (const file of frontend) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /brand\.kit\.revision|storedContentStudioBrandKitContent/
        ),
      ]);
    }
  });
});
