import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioBrandKitContentV1,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  applyContentStudioDesignAIProposal,
  ContentStudioDesignAIIntent,
  ContentStudioDesignAIProposalError,
  contentStudioDesignAIReferences,
  describeContentStudioDesignAIProposal,
  DESIGN_AI_INTENT_OPERATIONS,
  DESIGN_AI_INTENTS,
  DESIGN_AI_OPERATIONS_MAX,
  isContentStudioDesignAIIntent,
  parseContentStudioDesignAIProposal,
  resolveContentStudioDesignAIProposal,
} from '@gitroom/nestjs-libraries/content-studio/design/design.ai.proposal';

// P6-02: the pure Design Creative AI proposal. The model's answer is
// untrusted text; these tests feed it exactly as a provider could and check
// that only allowed operations on tokens of this document ever become a
// proposal, and that applying one changes exactly what it says

const KIT = '11111111-1111-4111-8111-111111111111';
const KIT_REVISION = '22222222-2222-4222-8222-222222222222';
const MEDIA = 'media_hero_1';
const SHA = 'a'.repeat(64);

const brand = (): ContentStudioBrandKitContentV1 =>
  parseContentStudioBrandKitContent({
    schemaVersion: 1,
    identity: { brandName: 'Acme', tagline: 'Make it', description: '' },
    colors: [
      { id: 'primary', name: 'Acme Red', value: '#CC0000', role: 'primary' },
      { id: 'ink', name: 'Ink', value: '#111111', role: 'text' },
    ],
    typography: [
      {
        id: 'heading',
        name: 'Heading',
        family: 'Inter',
        weight: 700,
        style: 'normal',
        role: 'heading',
      },
    ],
    visualDirection: { keywords: ['bold'], dos: [], donts: [] },
  });

const text = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  name,
  type: 'text',
  x: 100,
  y: 100,
  width: 800,
  height: 200,
  rotation: 0,
  opacity: 1,
  visible: true,
  text: 'Hello',
  font: { type: 'family', family: 'Arial', weight: 400, style: 'normal' },
  fontSize: 48,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: { type: 'literal', value: '#000000' },
  align: 'left',
  verticalAlign: 'top',
  overflow: 'shrink',
  ...extra,
});

const documentWith = (brandKit: boolean): ContentStudioDesignDocumentV1 =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit: brandKit
      ? {
          brandKitId: KIT,
          revisionId: KIT_REVISION,
          revisionNumber: 3,
          contentHash: 'b'.repeat(64),
        }
      : null,
    pages: [
      {
        id: 'page_main',
        name: 'Cover',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#ffffff' },
        },
        layers: [
          {
            id: 'l_background',
            name: 'Background',
            type: 'shape',
            shape: 'rectangle',
            x: 0,
            y: 0,
            width: 1080,
            height: 1080,
            rotation: 0,
            opacity: 1,
            visible: true,
            fill: { type: 'literal', value: '#eeeeee' },
            cornerRadius: 0,
          },
          text('l_headline', 'Headline', {
            text: 'Big news',
            fontSize: 96,
            ...(brandKit
              ? { font: { type: 'brand', tokenId: 'heading' } }
              : {}),
          }),
          text('l_body', 'Body', { y: 400, text: 'Line one\nLine two  ' }),
          {
            id: 'l_photo',
            name: 'Photo',
            type: 'image',
            x: 600,
            y: 600,
            width: 400,
            height: 400,
            rotation: 0,
            opacity: 1,
            visible: true,
            imageRef: { type: 'media', mediaId: MEDIA, sha256: SHA },
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.5 },
          },
        ],
      },
      {
        id: 'page_two',
        name: '',
        width: 1080,
        height: 1350,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#000000' },
        },
        layers: [
          text('l_cta', '', { text: 'Buy now' }),
          {
            id: 'l_dot',
            name: 'Dot',
            type: 'shape',
            shape: 'ellipse',
            x: 10,
            y: 10,
            width: 50,
            height: 50,
            rotation: 0,
            opacity: 1,
            visible: true,
            fill: { type: 'literal', value: '#ff0000' },
            cornerRadius: 0,
          },
        ],
      },
    ],
  });

const answer = (operations: unknown[], summary = 'Clearer copy.') =>
  JSON.stringify({ summary, operations });

const resolve = (
  intent: ContentStudioDesignAIIntent,
  raw: unknown,
  withKit = false
) =>
  resolveContentStudioDesignAIProposal({
    document: documentWith(withKit),
    brand: withKit ? brand() : null,
    intent,
    raw,
  });

const refused = (fn: () => unknown) =>
  expect(fn).toThrow(ContentStudioDesignAIProposalError);

// a deep freeze: any write to the input throws
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};

describe('Design Creative AI: tokens', () => {
  it('TK1 names pages, layers per type, fonts and Brand Kit colors by position, never by id', () => {
    const refs = contentStudioDesignAIReferences(documentWith(true), brand());
    expect(refs.pages).toEqual([
      { token: 'PAGE_1', pageId: 'page_main' },
      { token: 'PAGE_2', pageId: 'page_two' },
    ]);
    expect(refs.layers.map((entry) => [entry.token, entry.layerId])).toEqual([
      ['SHAPE_1', 'l_background'],
      ['TEXT_1', 'l_headline'],
      ['TEXT_2', 'l_body'],
      ['IMAGE_1', 'l_photo'],
      ['TEXT_3', 'l_cta'],
      ['SHAPE_2', 'l_dot'],
    ]);
    // the kit's typography first, then each family font of the document once
    expect(refs.fonts).toEqual([
      { token: 'FONT_1', font: { type: 'brand', tokenId: 'heading' } },
      {
        token: 'FONT_2',
        font: { type: 'family', family: 'Arial', weight: 400, style: 'normal' },
      },
    ]);
    expect(refs.colors).toEqual([
      { token: 'COLOR_1', tokenId: 'primary' },
      { token: 'COLOR_2', tokenId: 'ink' },
    ]);
  });

  it('TK2 without a kit there are no color tokens and only the document fonts', () => {
    const refs = contentStudioDesignAIReferences(documentWith(false), null);
    expect(refs.colors).toEqual([]);
    expect(refs.fonts.map((entry) => entry.token)).toEqual(['FONT_1']);
  });
});

describe('Design Creative AI: the model answer (OV)', () => {
  it('OV1 maps a text operation on a token to the exact layer id and text', () => {
    const proposal = resolve(
      'improve_copy',
      answer([{ type: 'set_text', layer: 'TEXT_2', text: 'New body\r\ntext' }])
    );
    expect(proposal).toEqual({
      schemaVersion: 1,
      intent: 'improve_copy',
      summary: 'Clearer copy.',
      operations: [
        { type: 'set_text', layerId: 'l_body', text: 'New body\ntext' },
      ],
    });
  });

  it('OV2/SEC6 refuses an unknown token, a raw layer id and a page id where a layer goes', () => {
    for (const layer of ['TEXT_9', 'l_body', 'PAGE_1', 'text_1', '']) {
      refused(() =>
        resolve(
          'improve_copy',
          answer([{ type: 'set_text', layer, text: 'x' }])
        )
      );
    }
    refused(() =>
      resolve(
        'restyle',
        answer([
          { type: 'set_page_background', page: 'page_main', color: '#000000' },
        ])
      )
    );
  });

  it('OV3 refuses an operation on a layer of another type', () => {
    refused(() =>
      resolve(
        'improve_copy',
        answer([{ type: 'set_text', layer: 'SHAPE_1', text: 'x' }])
      )
    );
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_shape_style', layer: 'TEXT_1', fill: '#000000' }])
      )
    );
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_text_style', layer: 'IMAGE_1', fontSize: 20 }])
      )
    );
  });

  it('OV4 refuses an unknown operation: no delete, add, reorder, page or image operation exists', () => {
    for (const type of [
      'delete_layer',
      'add_layer',
      'add_text_layer',
      'add_image_layer',
      'reorder_layers',
      'add_page',
      'delete_page',
      'set_image',
      'set_media',
      'set_mask',
      'set_document',
    ]) {
      refused(() =>
        resolve('restyle', answer([{ type, layer: 'IMAGE_1', page: 'PAGE_1' }]))
      );
    }
  });

  it('OV5 refuses any field the operation or answer does not have', () => {
    refused(() =>
      resolve(
        'improve_copy',
        answer([
          { type: 'set_text', layer: 'TEXT_1', text: 'x', id: 'l_headline' },
        ])
      )
    );
    refused(() =>
      resolve(
        'rebalance_layout',
        answer([
          {
            type: 'set_bounds',
            layer: 'TEXT_1',
            x: 1,
            y: 1,
            width: 10,
            height: 10,
            rotation: 45,
          },
        ])
      )
    );
    refused(() =>
      resolve(
        'restyle',
        answer([
          {
            type: 'set_text_style',
            layer: 'TEXT_1',
            fontSize: 20,
            overflow: 'clip',
          },
        ])
      )
    );
    refused(() =>
      resolve(
        'improve_copy',
        JSON.stringify({
          summary: 'x',
          operations: [{ type: 'set_text', layer: 'TEXT_1', text: 'x' }],
          document: documentWith(false),
        })
      )
    );
    refused(() =>
      resolve(
        'improve_copy',
        JSON.stringify({
          schemaVersion: 1,
          summary: 'x',
          operations: [{ type: 'set_text', layer: 'TEXT_1', text: 'x' }],
        })
      )
    );
  });

  it(`OV6 refuses more than ${DESIGN_AI_OPERATIONS_MAX} operations and none at all`, () => {
    const many = Array.from({ length: DESIGN_AI_OPERATIONS_MAX + 1 }, () => ({
      type: 'set_text',
      layer: 'TEXT_1',
      text: 'x',
    }));
    refused(() => resolve('improve_copy', answer(many)));
    refused(() => resolve('improve_copy', answer([])));
  });

  it('OV7 refuses a text over the layer text limit, blank, with NUL or a lone surrogate', () => {
    for (const value of [
      'x'.repeat(10_001),
      '   \n ',
      'a\u0000b',
      'a\uD800b',
    ]) {
      refused(() =>
        resolve(
          'improve_copy',
          answer([{ type: 'set_text', layer: 'TEXT_1', text: value }])
        )
      );
    }
    expect(
      resolve(
        'improve_copy',
        answer([
          { type: 'set_text', layer: 'TEXT_1', text: 'x'.repeat(10_000) },
        ])
      ).operations
    ).toHaveLength(1);
  });

  it('OV8 refuses numbers that are not finite, out of range, numeric text or a box off its page', () => {
    const bounds = (box: Record<string, unknown>) =>
      `{"summary":"x","operations":[{"type":"set_bounds","layer":"TEXT_1","x":${box.x},"y":${box.y},"width":${box.width},"height":${box.height}}]}`;
    for (const box of [
      { x: '1e400', y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 0.5, height: 10 },
      { x: 0, y: 0, width: 10, height: -5 },
      { x: 0, y: 0, width: 40000, height: 10 },
      { x: -40000, y: 0, width: 10, height: 10 },
      // entirely outside the 1080 x 1080 page
      { x: 1080, y: 0, width: 10, height: 10 },
      { x: -20, y: 0, width: 20, height: 10 },
      { x: 0, y: 2000, width: 10, height: 10 },
      { x: '"10"', y: 0, width: 10, height: 10 },
      { x: 'null', y: 0, width: 10, height: 10 },
    ]) {
      refused(() => resolve('rebalance_layout', bounds(box)));
    }
    for (const style of [
      { fontSize: 0 },
      { fontSize: 2000 },
      { lineHeight: 0.1 },
      { letterSpacing: 500 },
      { fontSize: '56' },
    ]) {
      refused(() =>
        resolve(
          'improve_hierarchy',
          answer([{ type: 'set_text_style', layer: 'TEXT_1', ...style }])
        )
      );
    }
    refused(() =>
      resolve(
        'restyle',
        answer([
          { type: 'set_shape_style', layer: 'SHAPE_1', cornerRadius: -1 },
        ])
      )
    );
    // an ellipse keeps a radius of 0: the final document check refuses it
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_shape_style', layer: 'SHAPE_2', cornerRadius: 4 }])
      )
    );
  });

  it('OV9/SEC7 no operation can name Media: an image keeps its exact reference', () => {
    refused(() =>
      resolve(
        'restyle',
        answer([
          {
            type: 'set_bounds',
            layer: 'IMAGE_1',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            mediaId: 'evil',
          },
        ])
      )
    );
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_shape_style', layer: 'IMAGE_1', fill: '#000000' }])
      )
    );
    const proposal = resolve(
      'rebalance_layout',
      answer([
        {
          type: 'set_bounds',
          layer: 'IMAGE_1',
          x: 500,
          y: 500,
          width: 300,
          height: 300,
        },
      ])
    );
    const after = applyContentStudioDesignAIProposal(
      documentWith(false),
      proposal
    );
    expect(after.pages[0].layers[3]).toMatchObject({
      imageRef: { type: 'media', mediaId: MEDIA, sha256: SHA },
      x: 500,
      width: 300,
    });
    expect(JSON.stringify(proposal)).not.toMatch(/media|sha|imageRef/i);
  });

  it('OV10 refuses URLs, CSS and anything but #rrggbb or a kit token as a color', () => {
    for (const color of [
      'url(https://evil.test/x.png)',
      'https://evil.test',
      'red',
      '#fff',
      '#ff000080',
      'rgb(0,0,0)',
      'var(--x)',
      'COLOR_9',
    ]) {
      refused(() =>
        resolve(
          'restyle',
          answer([{ type: 'set_text_style', layer: 'TEXT_1', color }]),
          true
        )
      );
      refused(() =>
        resolve(
          'restyle',
          answer([{ type: 'set_page_background', page: 'PAGE_1', color }]),
          true
        )
      );
    }
    expect(
      resolve(
        'restyle',
        answer([
          { type: 'set_page_background', page: 'PAGE_1', color: '#ABCDEF' },
        ])
      ).operations
    ).toEqual([
      {
        type: 'set_page_background',
        pageId: 'page_main',
        color: { type: 'literal', value: '#abcdef' },
      },
    ]);
  });

  it('OV11 refuses a font that is not a kit token or a font the document already uses', () => {
    for (const font of [
      'Comic Sans',
      'FONT_9',
      'Inter',
      'https://fonts.test/a.woff',
    ]) {
      refused(() =>
        resolve(
          'improve_hierarchy',
          answer([{ type: 'set_text_style', layer: 'TEXT_2', font }]),
          true
        )
      );
    }
    expect(
      resolve(
        'improve_hierarchy',
        answer([{ type: 'set_text_style', layer: 'TEXT_2', font: 'FONT_1' }]),
        true
      ).operations[0]
    ).toEqual({
      type: 'set_text_style',
      layerId: 'l_body',
      font: { type: 'brand', tokenId: 'heading' },
    });
    // without a kit, a kit token cannot exist
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_text_style', layer: 'TEXT_1', color: 'COLOR_1' }])
      )
    );
  });

  it('OV12 refuses anything but one clean JSON object: fences, prose, arrays, non-strings', () => {
    const valid = answer([{ type: 'set_text', layer: 'TEXT_1', text: 'x' }]);
    for (const raw of [
      '',
      'not json',
      '```json\n' + valid + '\n```',
      'Here you go: ' + valid,
      '[' + valid + ']',
      'null',
      '{"summary":"x"',
      undefined,
      42,
      { summary: 'x', operations: [] },
    ]) {
      refused(() => resolve('improve_copy', raw));
    }
  });

  it('OV13/M8 one invalid operation refuses the whole answer, never a part of it', () => {
    refused(() =>
      resolve(
        'improve_copy',
        answer([
          { type: 'set_text', layer: 'TEXT_1', text: 'Fine' },
          { type: 'set_text', layer: 'TEXT_2', text: 'Fine too' },
          { type: 'set_text', layer: 'TEXT_99', text: 'Not a layer' },
        ])
      )
    );
  });

  it('refuses a second operation of the same kind on the same target, a blank or long summary and an empty style', () => {
    refused(() =>
      resolve(
        'improve_copy',
        answer([
          { type: 'set_text', layer: 'TEXT_1', text: 'a' },
          { type: 'set_text', layer: 'TEXT_1', text: 'b' },
        ])
      )
    );
    refused(() =>
      resolve(
        'improve_copy',
        answer([{ type: 'set_text', layer: 'TEXT_1', text: 'a' }], '  ')
      )
    );
    refused(() =>
      resolve(
        'improve_copy',
        answer(
          [{ type: 'set_text', layer: 'TEXT_1', text: 'a' }],
          'x'.repeat(1001)
        )
      )
    );
    refused(() =>
      resolve('restyle', answer([{ type: 'set_text_style', layer: 'TEXT_1' }]))
    );
  });
});

describe('Design Creative AI: intents (INT)', () => {
  it('pins the operations of every intent', () => {
    expect(DESIGN_AI_INTENTS).toEqual([
      'improve_copy',
      'tighten_copy',
      'adapt_tone',
      'improve_hierarchy',
      'restyle',
      'rebalance_layout',
    ]);
    expect(DESIGN_AI_INTENT_OPERATIONS).toEqual({
      improve_copy: { set_text: ['text'] },
      tighten_copy: { set_text: ['text'] },
      adapt_tone: { set_text: ['text'] },
      improve_hierarchy: { set_text_style: ['text'], set_bounds: ['text'] },
      restyle: {
        set_text_style: ['text'],
        set_shape_style: ['shape'],
        set_page_background: [],
        set_bounds: ['text', 'shape', 'image'],
      },
      rebalance_layout: { set_bounds: ['text', 'shape', 'image'] },
    });
  });

  it('INT1 a copy intent changes texts only: no box, style or background', () => {
    for (const intent of [
      'improve_copy',
      'tighten_copy',
      'adapt_tone',
    ] as const) {
      refused(() =>
        resolve(
          intent,
          answer([
            {
              type: 'set_bounds',
              layer: 'TEXT_1',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
            },
          ])
        )
      );
      refused(() =>
        resolve(
          intent,
          answer([{ type: 'set_text_style', layer: 'TEXT_1', fontSize: 20 }])
        )
      );
      refused(() =>
        resolve(
          intent,
          answer([
            { type: 'set_page_background', page: 'PAGE_1', color: '#000000' },
          ])
        )
      );
    }
  });

  it('INT2 layout and style intents never rewrite text; hierarchy moves text layers only', () => {
    for (const intent of [
      'improve_hierarchy',
      'restyle',
      'rebalance_layout',
    ] as const) {
      refused(() =>
        resolve(
          intent,
          answer([{ type: 'set_text', layer: 'TEXT_1', text: 'Rewritten' }])
        )
      );
    }
    refused(() =>
      resolve(
        'rebalance_layout',
        answer([{ type: 'set_text_style', layer: 'TEXT_1', fontSize: 20 }])
      )
    );
    refused(() =>
      resolve(
        'improve_hierarchy',
        answer([
          {
            type: 'set_bounds',
            layer: 'SHAPE_1',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          },
        ])
      )
    );
  });

  it('INT3 restyle cannot touch an image beyond its box', () => {
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_text_style', layer: 'IMAGE_1', color: '#000000' }])
      )
    );
    refused(() =>
      resolve(
        'restyle',
        answer([{ type: 'set_shape_style', layer: 'IMAGE_1', fill: '#000000' }])
      )
    );
  });

  it('INT4 an unknown intent is refused', () => {
    expect(isContentStudioDesignAIIntent('delete_everything')).toBe(false);
    expect(isContentStudioDesignAIIntent('IMPROVE_COPY')).toBe(false);
    refused(() =>
      resolveContentStudioDesignAIProposal({
        document: documentWith(false),
        brand: null,
        intent: 'delete_everything' as ContentStudioDesignAIIntent,
        raw: answer([{ type: 'set_text', layer: 'TEXT_1', text: 'x' }]),
      })
    );
  });
});

describe('Design Creative AI: apply (AP)', () => {
  const proposal = () =>
    resolve(
      'restyle',
      answer([
        {
          type: 'set_text_style',
          layer: 'TEXT_1',
          fontSize: 120,
          color: 'COLOR_1',
          align: 'center',
        },
        {
          type: 'set_shape_style',
          layer: 'SHAPE_1',
          fill: 'COLOR_2',
          cornerRadius: 24,
        },
        {
          type: 'set_bounds',
          layer: 'TEXT_2',
          x: 120,
          y: 520,
          width: 840,
          height: 300,
        },
        { type: 'set_page_background', page: 'PAGE_2', color: '#202020' },
      ]),
      true
    );

  it('AP1/M12 never changes the base document or the proposal', () => {
    const base = frozen(documentWith(true));
    const value = frozen(proposal());
    const before = JSON.stringify(base);
    const after = applyContentStudioDesignAIProposal(base, value, brand());
    expect(JSON.stringify(base)).toBe(before);
    expect(after).not.toBe(base);
    expect(after.pages[0]).not.toBe(base.pages[0]);
  });

  it('AP2-AP6 applies every operation exactly, and the result is valid Design Document v1', () => {
    const after = applyContentStudioDesignAIProposal(
      documentWith(true),
      proposal(),
      brand()
    );
    expect(parseContentStudioDesignDocument(after)).toEqual(after);
    const [shape, headline, body, image] = after.pages[0].layers;
    expect(headline).toMatchObject({
      fontSize: 120,
      color: { type: 'brand', tokenId: 'primary' },
      align: 'center',
      text: 'Big news',
    });
    expect(shape).toMatchObject({
      fill: { type: 'brand', tokenId: 'ink' },
      cornerRadius: 24,
    });
    expect(body).toMatchObject({ x: 120, y: 520, width: 840, height: 300 });
    expect(after.pages[1].background.color).toEqual({
      type: 'literal',
      value: '#202020',
    });
    // AP7: everything else is exactly as it was
    const base = documentWith(true);
    expect(image).toEqual(base.pages[0].layers[3]);
    expect(after.pages[1].layers).toEqual(base.pages[1].layers);
    expect(after.brandKit).toEqual(base.brandKit);
    expect(after.pages.map((page) => page.id)).toEqual(
      base.pages.map((page) => page.id)
    );
    expect(after.schemaVersion).toBe(1);
  });

  it('AP8 a proposal for another document is refused: an unknown layer or page id applies nothing', () => {
    const other = parseContentStudioDesignDocument({
      ...documentWith(false),
      pages: [{ ...documentWith(false).pages[1], id: 'page_other' }],
    });
    refused(() =>
      applyContentStudioDesignAIProposal(
        other,
        resolve(
          'improve_copy',
          answer([{ type: 'set_text', layer: 'TEXT_1', text: 'x' }])
        )
      )
    );
    refused(() =>
      applyContentStudioDesignAIProposal(
        other,
        resolve(
          'restyle',
          answer([
            { type: 'set_page_background', page: 'PAGE_1', color: '#000000' },
          ])
        )
      )
    );
  });

  it('with a kit, refuses kit tokens it does not have; a proposal is parsed strictly before it applies', () => {
    const value = proposal();
    refused(() =>
      applyContentStudioDesignAIProposal(documentWith(true), value, {
        ...brand(),
        colors: [],
      })
    );
    for (const changed of [
      { ...value, schemaVersion: 2 },
      { ...value, intent: 'anything' },
      { ...value, extra: true },
      { ...value, operations: [] },
      {
        ...value,
        operations: [
          { type: 'set_text', layerId: 'l_headline', text: 'x', mediaId: 'm' },
        ],
      },
      {
        ...value,
        operations: [
          {
            type: 'set_bounds',
            layerId: 'l_headline',
            x: Number.NaN,
            y: 0,
            width: 10,
            height: 10,
          },
        ],
      },
    ]) {
      refused(() =>
        applyContentStudioDesignAIProposal(
          documentWith(true),
          changed as never,
          brand()
        )
      );
    }
    expect(parseContentStudioDesignAIProposal(value)).toEqual(value);
  });

  it('applies operations in order, and the same text twice in a row is no change', () => {
    const first = resolve(
      'improve_copy',
      answer([
        { type: 'set_text', layer: 'TEXT_3', text: 'Shop today' },
        { type: 'set_text', layer: 'TEXT_1', text: 'Big news' },
      ])
    );
    const changes = describeContentStudioDesignAIProposal(
      documentWith(false),
      first
    );
    // TEXT_1 already says that: not a change
    expect(changes).toEqual([
      {
        kind: 'text',
        pageId: 'page_two',
        layerId: 'l_cta',
        layerName: '',
        layerType: 'text',
        before: 'Buy now',
        after: 'Shop today',
      },
    ]);
  });
});

describe('Design Creative AI: changes (diff)', () => {
  it('describes every changed value from the documents, in the order of the operations, never from the summary', () => {
    const value = resolve(
      'restyle',
      answer(
        [
          {
            type: 'set_bounds',
            layer: 'SHAPE_1',
            x: 0,
            y: 0,
            width: 1080,
            height: 540,
          },
          {
            type: 'set_text_style',
            layer: 'TEXT_1',
            fontSize: 96,
            lineHeight: 1.4,
            font: 'FONT_2',
          },
          { type: 'set_page_background', page: 'PAGE_1', color: '#ffffff' },
        ],
        'I changed the text of every layer'
      ),
      true
    );
    expect(
      describeContentStudioDesignAIProposal(documentWith(true), value, brand())
    ).toEqual([
      {
        kind: 'bounds',
        pageId: 'page_main',
        layerId: 'l_background',
        layerName: 'Background',
        layerType: 'shape',
        before: { x: 0, y: 0, width: 1080, height: 1080 },
        after: { x: 0, y: 0, width: 1080, height: 540 },
      },
      // fontSize 96 is what it was: left out
      {
        kind: 'style',
        pageId: 'page_main',
        layerId: 'l_headline',
        layerName: 'Headline',
        layerType: 'text',
        field: 'lineHeight',
        before: 1.2,
        after: 1.4,
      },
      {
        kind: 'style',
        pageId: 'page_main',
        layerId: 'l_headline',
        layerName: 'Headline',
        layerType: 'text',
        field: 'font',
        before: { type: 'brand', tokenId: 'heading' },
        after: {
          type: 'family',
          family: 'Arial',
          weight: 400,
          style: 'normal',
        },
      },
      // the background is already white: no change
    ]);
  });
});
