import {
  ContentStudioDesignCanvasPreset,
  ContentStudioDesignPageSetContentV1,
  DESIGN_CANVAS_PRESETS,
  parseContentStudioDesignPageSetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import { storedContentStudioDesignPageSet } from '@gitroom/nestjs-libraries/content-studio/design/design.page.set.stored';

// The built-in page sets: version-controlled data, the same for every
// organization, never rows of any. Every page is one of the canvas presets,
// named after it (stable English page names, as stored content), white and
// blank. Each is checked by the Page Set v1 parser before it is offered: an
// invalid one throws, it is never skipped or repaired. The hash is of the
// canonical content, as for a custom page set

export const DESIGN_SYSTEM_PAGE_SET_ID = /^system:[a-z0-9][a-z0-9-]{0,62}$/;

interface SystemPageSetDefinition {
  id: string;
  name: string;
  description: string;
  content: unknown;
}

type PresetId = ContentStudioDesignCanvasPreset['id'];
const pagesOf = (...ids: PresetId[]) => ({
  schemaVersion: 1,
  pages: ids.map((id) => {
    const preset = DESIGN_CANVAS_PRESETS.find((entry) => entry.id === id)!;
    return { name: preset.label, width: preset.width, height: preset.height };
  }),
});

const DEFINITIONS: SystemPageSetDefinition[] = [
  {
    id: 'system:page-set-social-core',
    name: 'Social core',
    description: 'Square, portrait and story pages.',
    content: pagesOf('square', 'portrait', 'story'),
  },
  {
    id: 'system:page-set-social-full',
    name: 'Social full',
    description: 'Square, portrait, story and landscape pages.',
    content: pagesOf('square', 'portrait', 'story', 'landscape'),
  },
  {
    id: 'system:page-set-square-portrait',
    name: 'Square and portrait',
    description: 'A square and a portrait page.',
    content: pagesOf('square', 'portrait'),
  },
  {
    id: 'system:page-set-square-story',
    name: 'Square and story',
    description: 'A square and a story page.',
    content: pagesOf('square', 'story'),
  },
];

export interface ContentStudioSystemDesignPageSet {
  id: string;
  name: string;
  description: string;
  contentHash: string;
  content: ContentStudioDesignPageSetContentV1;
}

// A fixed message only: a built-in page set that is not valid Page Set v1
export class ContentStudioSystemDesignPageSetError extends Error {
  constructor(readonly pageSetId: string) {
    super(`The built-in page set ${pageSetId} is invalid`);
    this.name = 'ContentStudioSystemDesignPageSetError';
  }
}

const build = (
  definitions: SystemPageSetDefinition[]
): ContentStudioSystemDesignPageSet[] => {
  const ids = new Set<string>();
  return definitions.map((definition) => {
    if (
      !DESIGN_SYSTEM_PAGE_SET_ID.test(definition.id) ||
      ids.has(definition.id) ||
      !definition.name ||
      !definition.description
    ) {
      throw new ContentStudioSystemDesignPageSetError(definition.id);
    }
    ids.add(definition.id);
    let content: ContentStudioDesignPageSetContentV1;
    try {
      content = parseContentStudioDesignPageSetContent(definition.content);
    } catch {
      throw new ContentStudioSystemDesignPageSetError(definition.id);
    }
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      contentHash: storedContentStudioDesignPageSet(content).contentHash,
      content,
    };
  });
};

// Checked once, on first use; every caller gets its own copy
let built: ContentStudioSystemDesignPageSet[] | null = null;
const all = () => (built ??= build(DEFINITIONS));
const copy = (entry: ContentStudioSystemDesignPageSet) => ({
  ...entry,
  content: JSON.parse(
    JSON.stringify(entry.content)
  ) as ContentStudioDesignPageSetContentV1,
});

export const listContentStudioSystemDesignPageSets = () => all().map(copy);

// One built-in by its id, or null
export const getContentStudioSystemDesignPageSet = (id: string) => {
  const entry = all().find((candidate) => candidate.id === id);
  return entry ? copy(entry) : null;
};

// for the tests: the same checks on other definitions
export const buildContentStudioSystemDesignPageSets = build;
