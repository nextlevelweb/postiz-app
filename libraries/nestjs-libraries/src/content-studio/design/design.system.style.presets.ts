import {
  collectContentStudioDesignStylePresetBrandTokens,
  ContentStudioDesignStylePresetContentV1,
  ContentStudioDesignStylePresetKind,
  parseContentStudioDesignStylePresetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import { storedContentStudioDesignStylePreset } from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset.stored';

// The built-in style presets: version-controlled data, the same for every
// organization, never rows of any. Literal colors and the Inter family only
// (the family of the built-in templates), no Brand Kit token: they mean the
// same thing everywhere. Each is checked by the Style Preset v1 parser
// before it is offered: an invalid one throws, it is never skipped or
// repaired. The hash is of the canonical content, as for a custom preset

export const DESIGN_SYSTEM_STYLE_PRESET_ID = /^system:[a-z0-9][a-z0-9-]{0,62}$/;

interface SystemStylePresetDefinition {
  id: string;
  name: string;
  description: string;
  content: unknown;
}

const lit = (value: string) => ({ type: 'literal' as const, value });
const inter = (weight: number, style: 'normal' | 'italic') => ({
  type: 'family' as const,
  family: 'Inter',
  weight,
  style,
});
const text = (style: Record<string, unknown>) => ({
  schemaVersion: 1,
  kind: 'text',
  style,
});
const shape = (style: Record<string, unknown>) => ({
  schemaVersion: 1,
  kind: 'shape',
  style,
});

const DEFINITIONS: SystemStylePresetDefinition[] = [
  {
    id: 'system:text-heading-bold',
    name: 'Heading — Bold',
    description: 'A large, tight, bold heading.',
    content: text({
      font: inter(700, 'normal'),
      fontSize: 96,
      lineHeight: 1.1,
      letterSpacing: -1,
      color: lit('#111827'),
      align: 'left',
      verticalAlign: 'top',
      opacity: 1,
    }),
  },
  {
    id: 'system:text-heading-elegant',
    name: 'Heading — Elegant',
    description: 'A light, airy italic heading, centered.',
    content: text({
      font: inter(300, 'italic'),
      fontSize: 80,
      lineHeight: 1.2,
      letterSpacing: 2,
      color: lit('#1f2937'),
      align: 'center',
      verticalAlign: 'middle',
      opacity: 1,
    }),
  },
  {
    id: 'system:text-body-clean',
    name: 'Body — Clean',
    description: 'Readable body text with open line spacing.',
    content: text({
      font: inter(400, 'normal'),
      fontSize: 40,
      lineHeight: 1.5,
      letterSpacing: 0,
      color: lit('#374151'),
      align: 'left',
      verticalAlign: 'top',
      opacity: 1,
    }),
  },
  {
    id: 'system:text-caption-subtle',
    name: 'Caption — Subtle',
    description: 'A small, muted caption.',
    content: text({
      font: inter(400, 'italic'),
      fontSize: 28,
      lineHeight: 1.4,
      letterSpacing: 0.5,
      color: lit('#6b7280'),
      align: 'left',
      verticalAlign: 'bottom',
      opacity: 0.85,
    }),
  },
  {
    id: 'system:shape-solid-card',
    name: 'Solid card',
    description: 'A white card with rounded corners.',
    content: shape({ fill: lit('#ffffff'), cornerRadius: 24, opacity: 1 }),
  },
  {
    id: 'system:shape-soft-panel',
    name: 'Soft panel',
    description: 'A light grey, slightly transparent panel.',
    content: shape({ fill: lit('#f3f4f6'), cornerRadius: 48, opacity: 0.9 }),
  },
  {
    id: 'system:shape-accent-block',
    name: 'Accent block',
    description: 'A square block of strong blue.',
    content: shape({ fill: lit('#2563eb'), cornerRadius: 0, opacity: 1 }),
  },
];

export interface ContentStudioSystemDesignStylePreset {
  id: string;
  name: string;
  description: string;
  kind: ContentStudioDesignStylePresetKind;
  contentHash: string;
  content: ContentStudioDesignStylePresetContentV1;
}

// A fixed message only: a built-in preset that is not valid Style Preset
// v1, or not safe to share between organizations
export class ContentStudioSystemDesignStylePresetError extends Error {
  constructor(readonly presetId: string) {
    super(`The built-in style preset ${presetId} is invalid`);
    this.name = 'ContentStudioSystemDesignStylePresetError';
  }
}

const build = (
  definitions: SystemStylePresetDefinition[]
): ContentStudioSystemDesignStylePreset[] => {
  const ids = new Set<string>();
  return definitions.map((definition) => {
    if (
      !DESIGN_SYSTEM_STYLE_PRESET_ID.test(definition.id) ||
      ids.has(definition.id) ||
      !definition.name ||
      !definition.description
    ) {
      throw new ContentStudioSystemDesignStylePresetError(definition.id);
    }
    ids.add(definition.id);
    let content: ContentStudioDesignStylePresetContentV1;
    try {
      content = parseContentStudioDesignStylePresetContent(definition.content);
    } catch {
      throw new ContentStudioSystemDesignStylePresetError(definition.id);
    }
    // built-ins name no organization's Brand Kit
    const tokens = collectContentStudioDesignStylePresetBrandTokens(content);
    if (tokens.colorTokenIds.length || tokens.typographyTokenIds.length) {
      throw new ContentStudioSystemDesignStylePresetError(definition.id);
    }
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      kind: content.kind,
      contentHash: storedContentStudioDesignStylePreset(content).contentHash,
      content,
    };
  });
};

// Checked once, on first use; every caller gets its own copy
let built: ContentStudioSystemDesignStylePreset[] | null = null;
const all = () => (built ??= build(DEFINITIONS));
const copy = (preset: ContentStudioSystemDesignStylePreset) => ({
  ...preset,
  content: JSON.parse(
    JSON.stringify(preset.content)
  ) as ContentStudioDesignStylePresetContentV1,
});

export const listContentStudioSystemDesignStylePresets = () => all().map(copy);

// for the tests: the same checks on other definitions
export const buildContentStudioSystemDesignStylePresets = build;
