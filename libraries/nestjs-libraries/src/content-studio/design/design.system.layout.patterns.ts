import { collectContentStudioDesignBrandTokenRefs } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignLayoutPatternContentV1,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';
import { storedContentStudioDesignLayoutPattern } from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern.stored';

// The built-in layout patterns: version-controlled data, the same for every
// organization, never rows of any. Text and shapes with literal colors and
// the Inter family only (as the built-in templates and presets), no image
// and no Brand Kit token: they mean the same thing everywhere. Each is
// checked by the Layout Pattern v1 parser before it is offered: an invalid
// one throws, it is never skipped or repaired. The hash is of the canonical
// content, as for a custom pattern

export const DESIGN_SYSTEM_LAYOUT_PATTERN_ID =
  /^system:[a-z0-9][a-z0-9-]{0,62}$/;

interface SystemLayoutPatternDefinition {
  id: string;
  name: string;
  description: string;
  content: unknown;
}

const lit = (value: string) => ({ type: 'literal' as const, value });
const common = {
  name: '',
  rotation: 0,
  opacity: 1,
  visible: true,
};
const words = (
  name: string,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  style: {
    size: number;
    weight?: number;
    italic?: boolean;
    color: string;
    align?: 'left' | 'center' | 'right';
    lineHeight?: number;
  }
) => ({
  ...common,
  name,
  ...box,
  type: 'text',
  text,
  font: {
    type: 'family',
    family: 'Inter',
    weight: style.weight ?? 400,
    style: style.italic ? 'italic' : 'normal',
  },
  fontSize: style.size,
  lineHeight: style.lineHeight ?? 1.25,
  letterSpacing: 0,
  color: lit(style.color),
  align: style.align ?? 'left',
  verticalAlign: 'top',
  overflow: 'shrink',
});
const card = (
  box: { x: number; y: number; width: number; height: number },
  fill: string,
  cornerRadius: number
) => ({
  ...common,
  name: 'Card',
  ...box,
  type: 'shape',
  shape: 'rectangle',
  fill: lit(fill),
  cornerRadius,
});
const pattern = (width: number, height: number, layers: unknown[]) => ({
  schemaVersion: 1,
  width,
  height,
  layers,
});

const DEFINITIONS: SystemLayoutPatternDefinition[] = [
  {
    id: 'system:layout-title-body',
    name: 'Title and body',
    description: 'A headline over a short paragraph.',
    content: pattern(840, 420, [
      words(
        'Title',
        'Your headline',
        { x: 0, y: 0, width: 840, height: 200 },
        {
          size: 80,
          weight: 700,
          color: '#111827',
        }
      ),
      words(
        'Body',
        'Add a short supporting paragraph here.',
        { x: 0, y: 240, width: 840, height: 180 },
        { size: 36, color: '#374151', lineHeight: 1.4 }
      ),
    ]),
  },
  {
    id: 'system:layout-title-subtitle-body',
    name: 'Title, subtitle and body',
    description: 'A headline, a subtitle and a paragraph.',
    content: pattern(840, 540, [
      words(
        'Title',
        'Your headline',
        { x: 0, y: 0, width: 840, height: 180 },
        {
          size: 76,
          weight: 700,
          color: '#111827',
        }
      ),
      words(
        'Subtitle',
        'A subtitle',
        { x: 0, y: 200, width: 840, height: 80 },
        {
          size: 40,
          weight: 500,
          color: '#4b5563',
        }
      ),
      words(
        'Body',
        'Add a short supporting paragraph here.',
        { x: 0, y: 320, width: 840, height: 220 },
        { size: 32, color: '#374151', lineHeight: 1.45 }
      ),
    ]),
  },
  {
    id: 'system:layout-two-column-text',
    name: 'Two columns',
    description: 'Two text blocks side by side.',
    content: pattern(880, 400, [
      words(
        'Left column',
        'First point',
        { x: 0, y: 0, width: 420, height: 400 },
        {
          size: 34,
          color: '#1f2937',
          lineHeight: 1.4,
        }
      ),
      words(
        'Right column',
        'Second point',
        { x: 460, y: 0, width: 420, height: 400 },
        { size: 34, color: '#1f2937', lineHeight: 1.4 }
      ),
    ]),
  },
  {
    id: 'system:layout-quote',
    name: 'Quote',
    description: 'A large quote with its attribution.',
    content: pattern(840, 480, [
      words(
        'Quote',
        '“Add a memorable quote here.”',
        { x: 0, y: 0, width: 840, height: 360 },
        { size: 60, italic: true, color: '#111827', align: 'center' }
      ),
      words(
        'Attribution',
        '— Name, role',
        { x: 0, y: 400, width: 840, height: 80 },
        { size: 30, color: '#6b7280', align: 'center' }
      ),
    ]),
  },
  {
    id: 'system:layout-callout-card',
    name: 'Callout card',
    description: 'A rounded card with a heading and a line of text.',
    content: pattern(760, 400, [
      card({ x: 0, y: 0, width: 760, height: 400 }, '#f3f4f6', 32),
      words(
        'Heading',
        'Did you know?',
        { x: 60, y: 60, width: 640, height: 110 },
        {
          size: 52,
          weight: 700,
          color: '#111827',
        }
      ),
      words(
        'Text',
        'Add one interesting fact here.',
        { x: 60, y: 200, width: 640, height: 140 },
        { size: 32, color: '#374151', lineHeight: 1.4 }
      ),
    ]),
  },
];

export interface ContentStudioSystemDesignLayoutPattern {
  id: string;
  name: string;
  description: string;
  contentHash: string;
  content: ContentStudioDesignLayoutPatternContentV1;
}

// A fixed message only: a built-in pattern that is not valid Layout Pattern
// v1, or not safe to share between organizations
export class ContentStudioSystemDesignLayoutPatternError extends Error {
  constructor(readonly patternId: string) {
    super(`The built-in layout pattern ${patternId} is invalid`);
    this.name = 'ContentStudioSystemDesignLayoutPatternError';
  }
}

// built-ins name no organization's Media or Brand Kit
const neutral = (content: ContentStudioDesignLayoutPatternContentV1) => {
  const { colorTokenIds, typographyTokenIds } =
    collectContentStudioDesignBrandTokenRefs({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'p',
          name: '',
          width: 64,
          height: 64,
          background: { type: 'solid', color: lit('#ffffff') },
          layers: content.layers.map((layer, index) => ({
            ...layer,
            id: `l${index}`,
          })) as never,
        },
      ],
    });
  return (
    !colorTokenIds.length &&
    !typographyTokenIds.length &&
    content.layers.every((layer) => layer.type !== 'image')
  );
};

const build = (
  definitions: SystemLayoutPatternDefinition[]
): ContentStudioSystemDesignLayoutPattern[] => {
  const ids = new Set<string>();
  return definitions.map((definition) => {
    if (
      !DESIGN_SYSTEM_LAYOUT_PATTERN_ID.test(definition.id) ||
      ids.has(definition.id) ||
      !definition.name ||
      !definition.description
    ) {
      throw new ContentStudioSystemDesignLayoutPatternError(definition.id);
    }
    ids.add(definition.id);
    let content: ContentStudioDesignLayoutPatternContentV1;
    try {
      content = parseContentStudioDesignLayoutPatternContent(
        definition.content
      );
    } catch {
      throw new ContentStudioSystemDesignLayoutPatternError(definition.id);
    }
    if (!neutral(content)) {
      throw new ContentStudioSystemDesignLayoutPatternError(definition.id);
    }
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      contentHash: storedContentStudioDesignLayoutPattern(content).contentHash,
      content,
    };
  });
};

// Checked once, on first use; every caller gets its own copy
let built: ContentStudioSystemDesignLayoutPattern[] | null = null;
const all = () => (built ??= build(DEFINITIONS));
const copy = (entry: ContentStudioSystemDesignLayoutPattern) => ({
  ...entry,
  content: JSON.parse(
    JSON.stringify(entry.content)
  ) as ContentStudioDesignLayoutPatternContentV1,
});

export const listContentStudioSystemDesignLayoutPatterns = () =>
  all().map(copy);

// for the tests: the same checks on other definitions
export const buildContentStudioSystemDesignLayoutPatterns = build;
