import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  applyContentStudioDesignStylePreset,
  collectContentStudioDesignStylePresetBrandTokens,
  ContentStudioDesignStylePresetApplyError,
  ContentStudioDesignStylePresetError,
  extractContentStudioDesignStylePreset,
  parseContentStudioDesignStylePresetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import {
  ContentStudioDesignStylePresetIntegrityError,
  parseVerifiedContentStudioDesignStylePreset,
  storedContentStudioDesignStylePreset,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset.stored';
import {
  buildContentStudioSystemDesignStylePresets,
  ContentStudioSystemDesignStylePresetError,
  listContentStudioSystemDesignStylePresets,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.style.presets';

// Style Preset v1 (P4-13), pure: parsing, extraction, application and the
// built-ins. No database, Brand Kit, Media or network

type Row = Record<string, any>;
const lit = (value: string) => ({ type: 'literal', value });
const textStyle = (extra: Row = {}) => ({
  font: { type: 'family', family: '  Inter ', weight: 700, style: 'normal' },
  fontSize: 64,
  lineHeight: 1.25,
  letterSpacing: -0.5,
  color: lit('#AABBCC'),
  align: 'center',
  verticalAlign: 'middle',
  opacity: 0.75,
  ...extra,
});
const shapeStyle = (extra: Row = {}) => ({
  fill: { type: 'brand', tokenId: 'primary' },
  cornerRadius: 12,
  opacity: 0.5,
  ...extra,
});
const textPreset = (style: Row = textStyle()) => ({
  schemaVersion: 1,
  kind: 'text',
  style,
});
const shapePreset = (style: Row = shapeStyle()) => ({
  schemaVersion: 1,
  kind: 'shape',
  style,
});
const parse = parseContentStudioDesignStylePresetContent;
const refused = (input: unknown) => {
  expect(() => parse(input)).toThrow(ContentStudioDesignStylePresetError);
};

const base = {
  x: 10.5,
  y: 20,
  width: 300,
  height: 120,
  rotation: 15,
  opacity: 1,
  visible: false,
};
const TEXT = {
  ...base,
  id: 'headline',
  name: 'Headline',
  type: 'text',
  text: '  Hello\nworld ',
  font: { type: 'brand', tokenId: 'heading' },
  fontSize: 24,
  lineHeight: 1,
  letterSpacing: 0,
  color: { type: 'brand', tokenId: 'ink' },
  align: 'left',
  verticalAlign: 'top',
  overflow: 'shrink',
};
const RECT = {
  ...base,
  id: 'card',
  name: 'Card',
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#000000'),
  cornerRadius: 0,
};
const ELLIPSE = { ...RECT, id: 'dot', shape: 'ellipse' };
const IMAGE = {
  ...base,
  id: 'photo',
  name: 'Photo',
  type: 'image',
  imageRef: { type: 'media', mediaId: 'm1', sha256: 'a'.repeat(64) },
  fit: 'cover',
  focalPoint: { x: 0.2, y: 0.8 },
};
const DOCUMENT = parseContentStudioDesignDocument({
  schemaVersion: 1,
  brandKit: {
    brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    revisionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    revisionNumber: 1,
    contentHash: 'b'.repeat(64),
  },
  pages: [
    {
      id: 'p1',
      name: '',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [TEXT, RECT, ELLIPSE, IMAGE],
    },
  ],
});
const layer = (id: string) =>
  DOCUMENT.pages[0].layers.find((entry) => entry.id === id) as any;

// ============================================================================
describe('Style Preset v1', () => {
  it('SP1 a text preset parses and normalizes like Design Document v1', () => {
    expect(parse(textPreset())).toEqual({
      schemaVersion: 1,
      kind: 'text',
      style: textStyle({
        font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
        color: lit('#aabbcc'),
      }),
    });
  });

  it('SP2/EX8 a shape preset parses; exact Brand Kit tokens are kept as tokens', () => {
    expect(parse(shapePreset())).toEqual(shapePreset());
    expect(
      parse(
        textPreset(textStyle({ font: { type: 'brand', tokenId: 'heading' } }))
      ).style
    ).toMatchObject({ font: { type: 'brand', tokenId: 'heading' } });
  });

  it('SP3 unknown keys anywhere are refused', () => {
    refused({ ...textPreset(), extra: 1 });
    refused(textPreset({ ...textStyle(), shadow: '0 0 4px #000' }));
    refused(
      textPreset({ ...textStyle(), color: { ...lit('#000000'), alpha: 1 } })
    );
    refused(shapePreset({ ...shapeStyle(), stroke: lit('#000000') }));
    refused(shapePreset({ ...shapeStyle(), strokeWidth: 2 }));
  });

  it('SP4 a wrong kind, a kind of the other style, a wrong version or missing fields are refused', () => {
    refused({ ...textPreset(), kind: 'image' });
    // a kind of its own, with a style that would fit a shape, is refused too
    for (const kind of ['image', 'Shape', 'shapes', '', 1, null]) {
      refused({ ...shapePreset(), kind });
    }
    refused({ ...textPreset(), kind: 'shape' });
    refused({ ...shapePreset(), kind: 'text' });
    refused({ ...textPreset(), schemaVersion: 2 });
    const { opacity, ...noOpacity } = shapeStyle();
    expect(opacity).toBe(0.5);
    refused(shapePreset(noOpacity));
    refused({ schemaVersion: 1, kind: 'text' });
    refused(null);
    refused([]);
    refused(new Date());
  });

  it('SP5/SP6/SP7/PSEC6/PSEC7/PSEC8/M1/M2 geometry, text, ids, names, images, visibility or a Brand Kit reference never pass', () => {
    for (const [key, value] of Object.entries({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      visible: true,
      id: 'l1',
      name: 'n',
      text: 'smuggled',
      type: 'text',
      pageId: 'p1',
      layerId: 'l1',
      overflow: 'clip',
      imageRef: IMAGE.imageRef,
      mediaId: 'm1',
      brandKit: DOCUMENT.brandKit,
      shape: 'ellipse',
      fit: 'cover',
    })) {
      expect(() => parse(textPreset({ ...textStyle(), [key]: value }))).toThrow(
        ContentStudioDesignStylePresetError
      );
      expect(() =>
        parse(shapePreset({ ...shapeStyle(), [key]: value }))
      ).toThrow(ContentStudioDesignStylePresetError);
    }
  });

  it('values are held to the Design Document v1 limits; no CSS, url() or var()', () => {
    for (const style of [
      textStyle({ fontSize: 0 }),
      textStyle({ fontSize: Number.NaN }),
      textStyle({ fontSize: Infinity }),
      textStyle({ lineHeight: 11 }),
      textStyle({ letterSpacing: 101 }),
      textStyle({ opacity: 1.5 }),
      textStyle({ align: 'justify' }),
      textStyle({ color: lit('red') }),
      textStyle({ color: lit('url(x)') }),
      textStyle({ color: lit('var(--x)') }),
      textStyle({ color: lit('#fff') }),
      textStyle({
        font: { type: 'family', family: 'Inter', weight: 450, style: 'normal' },
      }),
      textStyle({
        font: {
          type: 'family',
          family: 'Inter',
          weight: 400,
          style: 'oblique',
        },
      }),
      textStyle({ font: { type: 'brand', tokenId: 'Bad Token' } }),
      textStyle({ fontSize: '64' }),
    ]) {
      refused(textPreset(style));
    }
    refused(shapePreset(shapeStyle({ cornerRadius: -1 })));
    refused(shapePreset(shapeStyle({ cornerRadius: 4097 })));
    refused(
      shapePreset(shapeStyle({ fill: lit('linear-gradient(red, blue)') }))
    );
  });

  it('SP8/SP9/M4 the stored text is canonical JSON with its hash, whatever the key order', () => {
    const one = storedContentStudioDesignStylePreset(parse(textPreset()));
    const reordered = storedContentStudioDesignStylePreset(
      parse({
        style: Object.fromEntries(Object.entries(textStyle()).reverse()),
        kind: 'text',
        schemaVersion: 1,
      })
    );
    expect(reordered).toEqual(one);
    expect(
      one.content.startsWith(
        '{"kind":"text","schemaVersion":1,"style":{"align":"center","color":'
      )
    ).toBe(true);
    expect(one.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(one.kind).toBe('text');
  });

  it('a stored preset reads back exactly and fails closed on anything else', () => {
    const stored = storedContentStudioDesignStylePreset(parse(shapePreset()));
    expect(parseVerifiedContentStudioDesignStylePreset(stored)).toEqual(
      shapePreset()
    );
    for (const row of [
      { ...stored, contentHash: '0'.repeat(64) },
      { ...stored, kind: 'text' },
      { ...stored, schemaVersion: 2 },
      { ...stored, content: ` ${stored.content}` },
      { ...stored, content: '{' },
    ]) {
      expect(() => parseVerifiedContentStudioDesignStylePreset(row)).toThrow(
        ContentStudioDesignStylePresetIntegrityError
      );
    }
  });

  it('the input is never changed', () => {
    const input = textPreset();
    const before = JSON.stringify(input);
    parse(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ============================================================================
describe('Style extraction', () => {
  it('EX1/EX2/EX3/EX4/M5/M6/M7 a text layer gives its style fields only', () => {
    const content = extractContentStudioDesignStylePreset(layer('headline'));
    expect(content).toEqual({
      schemaVersion: 1,
      kind: 'text',
      style: {
        font: { type: 'brand', tokenId: 'heading' },
        fontSize: 24,
        lineHeight: 1,
        letterSpacing: 0,
        color: { type: 'brand', tokenId: 'ink' },
        align: 'left',
        verticalAlign: 'top',
        opacity: 1,
      },
    });
    expect(parse(content)).toEqual(content);
    expect(JSON.stringify(content)).not.toMatch(
      /headline|Hello|"x"|"y"|width|height|rotation|visible|overflow|"name"|"id"/
    );
  });

  it('EX5/EX6 a shape layer gives fill, corner radius and opacity only; images give none', () => {
    const content = extractContentStudioDesignStylePreset(layer('card'));
    expect(content).toEqual({
      schemaVersion: 1,
      kind: 'shape',
      style: { fill: lit('#000000'), cornerRadius: 0, opacity: 1 },
    });
    expect(JSON.stringify(content)).not.toMatch(/card|rectangle|"x"|width/);
    expect(extractContentStudioDesignStylePreset(layer('photo'))).toBeNull();
  });

  it('EX7 extraction deep-copies', () => {
    const source = JSON.parse(JSON.stringify(layer('headline')));
    const content = extractContentStudioDesignStylePreset(source) as Row;
    content.style.font.tokenId = 'changed';
    expect(source.font.tokenId).toBe('heading');
  });
});

// ============================================================================
describe('Style application (pure)', () => {
  const heading = parse(textPreset());
  const panel = parse(shapePreset(shapeStyle({ fill: lit('#123456') })));

  it('AP1/AP2/AP3/M8/M9 a text preset writes its style only; text, geometry, id and overflow stay', () => {
    const next = applyContentStudioDesignStylePreset(
      layer('headline'),
      heading
    );
    expect(next).toEqual({ ...layer('headline'), ...heading.style });
    expect(next.text).toBe('  Hello\nworld ');
    expect([next.id, next.x, next.y, next.width, next.height]).toEqual([
      'headline',
      10.5,
      20,
      300,
      120,
    ]);
    expect([next.rotation, next.visible, next.overflow, next.name]).toEqual([
      15,
      false,
      'shrink',
      'Headline',
    ]);
  });

  it('AP4/AP5/AP6/M12 a shape preset writes fill, corner radius and opacity; geometry and shape stay', () => {
    const next = applyContentStudioDesignStylePreset(layer('card'), panel);
    expect(next).toEqual({ ...layer('card'), ...panel.style });
    expect(next.shape).toBe('rectangle');
    // an ellipse keeps a corner radius of 0
    const dot = applyContentStudioDesignStylePreset(layer('dot'), panel);
    expect(dot).toEqual({
      ...layer('dot'),
      fill: lit('#123456'),
      opacity: 0.5,
      cornerRadius: 0,
    });
    expect(dot.shape).toBe('ellipse');
  });

  it('AP7/M10/M11 a preset of another kind, or any preset for an image, is refused', () => {
    for (const [target, content] of [
      ['card', heading],
      ['headline', panel],
      ['photo', heading],
      ['photo', panel],
    ] as const) {
      expect(() =>
        applyContentStudioDesignStylePreset(layer(target), content)
      ).toThrow(ContentStudioDesignStylePresetApplyError);
    }
  });

  it('AP8/AP11 neither the preset nor the layer is changed; the result is Design Document v1', () => {
    const before = [JSON.stringify(heading), JSON.stringify(layer('headline'))];
    const next = applyContentStudioDesignStylePreset(
      layer('headline'),
      heading
    );
    expect([
      JSON.stringify(heading),
      JSON.stringify(layer('headline')),
    ]).toEqual(before);
    next.font = { type: 'family', family: 'X', weight: 400, style: 'normal' };
    expect((heading.style as Row).font).toMatchObject({ family: 'Inter' });
    const document = {
      ...DOCUMENT,
      pages: [{ ...DOCUMENT.pages[0], layers: [next] }],
    };
    expect(parseContentStudioDesignDocument(document)).toEqual(document);
  });

  it('the Brand Kit tokens a preset uses, for the caller to check', () => {
    expect(
      collectContentStudioDesignStylePresetBrandTokens(
        parse(
          textPreset(
            textStyle({
              font: { type: 'brand', tokenId: 'heading' },
              color: { type: 'brand', tokenId: 'ink' },
            })
          )
        )
      )
    ).toEqual({ colorTokenIds: ['ink'], typographyTokenIds: ['heading'] });
    expect(
      collectContentStudioDesignStylePresetBrandTokens(parse(shapePreset()))
    ).toEqual({ colorTokenIds: ['primary'], typographyTokenIds: [] });
    expect(collectContentStudioDesignStylePresetBrandTokens(heading)).toEqual({
      colorTokenIds: [],
      typographyTokenIds: [],
    });
  });
});

// ============================================================================
describe('Built-in style presets', () => {
  const all = listContentStudioSystemDesignStylePresets();

  it('SP10/SP11 a few valid presets with stable unique ids, text and shape', () => {
    expect(all.map((preset) => [preset.id, preset.kind])).toEqual([
      ['system:text-heading-bold', 'text'],
      ['system:text-heading-elegant', 'text'],
      ['system:text-body-clean', 'text'],
      ['system:text-caption-subtle', 'text'],
      ['system:shape-solid-card', 'shape'],
      ['system:shape-soft-panel', 'shape'],
      ['system:shape-accent-block', 'shape'],
    ]);
    for (const preset of all) {
      expect(parse(preset.content)).toEqual(preset.content);
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
      // literal only: no organization's Brand Kit
      expect(JSON.stringify(preset.content)).not.toMatch(/tokenId|brand/);
    }
  });

  it('SP12 hashes are canonical and pinned: a change needs a deliberate update', () => {
    for (const preset of all) {
      expect(preset.contentHash).toBe(
        storedContentStudioDesignStylePreset(preset.content).contentHash
      );
    }
    expect(all.map((preset) => `${preset.id}:${preset.contentHash}`)).toEqual(
      PINNED
    );
  });

  it('every caller gets its own copy; an invalid or duplicate built-in fails loudly', () => {
    (
      listContentStudioSystemDesignStylePresets()[0].content.style as Row
    ).fontSize = 1;
    expect(
      (listContentStudioSystemDesignStylePresets()[0].content.style as Row)
        .fontSize
    ).toBe(96);
    const good = {
      id: 'system:a',
      name: 'A',
      description: 'A',
      content: all[4].content,
    };
    expect(buildContentStudioSystemDesignStylePresets([good])).toHaveLength(1);
    for (const definitions of [
      [good, { ...good }],
      [{ ...good, id: 'a' }],
      [{ ...good, content: { ...all[4].content, kind: 'text' } }],
      [{ ...good, content: shapePreset() }],
    ]) {
      expect(() =>
        buildContentStudioSystemDesignStylePresets(definitions as never)
      ).toThrow(ContentStudioSystemDesignStylePresetError);
    }
  });
});

// pinned: a change to a built-in preset is a deliberate update here
const PINNED = [
  'system:text-heading-bold:0538a5896fdc22b09c612286e0aacc73f427849c248c46feeb98128ccbf2b069',
  'system:text-heading-elegant:79f9c47f399d2a5ec1e0ca922c752e676681bc7201550ca58b9e882e6e01c453',
  'system:text-body-clean:24d0564075772cb27406fa96cd43d2c21021a8cc60cb4e37235988512c3356d3',
  'system:text-caption-subtle:15f91b34e1cccb2b74832510930365c19615d07979a055d3a7e394a86c5e52ba',
  'system:shape-solid-card:1f399edb86eb1ac3f3877c449d3ec754db54222e5fd5dd1de607010e79664f50',
  'system:shape-soft-panel:2b5c266ede02c61d7c9716ec12e99a3f94c5966ba16effcc742acb916f48dd04',
  'system:shape-accent-block:8d07bb86c94d6fe0faff16da8878dcdb73a45cba9b26dc0a1bc7bf399501a390',
];
