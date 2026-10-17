import {
  ContentStudioDesignDocumentV1,
  ContentStudioDesignLayer,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';

// The built-in design templates: version-controlled data, the same for every
// organization, never rows of any. Each is a plain Design Document v1 with
// no Brand Kit reference, no image and no URL: literal colors, shapes and
// placeholder text only, so it means the same thing everywhere. A built-in
// template changes only by a new revision number here; the hash is of the
// canonical document, as for any design revision. Every document is checked
// by the Design Document v1 parser before it is offered: an invalid one
// throws, it is never skipped or repaired

export const DESIGN_TEMPLATE_DESCRIPTION_MAX = 1000;
export const DESIGN_SYSTEM_TEMPLATE_ID = /^system:[a-z0-9][a-z0-9-]{0,62}$/;

interface SystemTemplateDefinition {
  id: string;
  revisionNumber: number;
  name: string;
  description: string;
  document: unknown;
}

const lit = (value: string) => ({ type: 'literal' as const, value });

const box = (
  id: string,
  name: string,
  geometry: { x: number; y: number; width: number; height: number },
  fill: string
): ContentStudioDesignLayer => ({
  id,
  name,
  ...geometry,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'shape',
  shape: 'rectangle',
  fill: lit(fill),
  cornerRadius: 0,
});

const words = (
  id: string,
  name: string,
  text: string,
  geometry: { x: number; y: number; width: number; height: number },
  style: { fontSize: number; weight: 400 | 700; color: string }
): ContentStudioDesignLayer => ({
  id,
  name,
  ...geometry,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'text',
  text,
  font: {
    type: 'family',
    family: 'Inter',
    weight: style.weight,
    style: 'normal',
  },
  fontSize: style.fontSize,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: lit(style.color),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'shrink',
});

// One page with a band of color, a headline and a line of body text, laid
// out for the page size
const page = (width: number, height: number) => ({
  id: 'page_1',
  name: '',
  width,
  height,
  background: { type: 'solid', color: lit('#ffffff') },
  layers: [
    box(
      'band',
      'Band',
      { x: 0, y: height - height * 0.18, width, height: height * 0.18 },
      '#1f2937'
    ),
    words(
      'headline',
      'Headline',
      'Your headline',
      {
        x: width * 0.08,
        y: height * 0.12,
        width: width * 0.84,
        height: height * 0.3,
      },
      { fontSize: Math.round(width / 11), weight: 700, color: '#111827' }
    ),
    words(
      'body',
      'Body text',
      'Add a short supporting message.',
      {
        x: width * 0.08,
        y: height * 0.46,
        width: width * 0.84,
        height: height * 0.2,
      },
      { fontSize: Math.round(width / 24), weight: 400, color: '#374151' }
    ),
  ],
});

const document = (width: number, height: number) => ({
  schemaVersion: 1,
  brandKit: null as null,
  pages: [page(width, height)],
});

const DEFINITIONS: SystemTemplateDefinition[] = [
  {
    id: 'system:square-post',
    revisionNumber: 1,
    name: 'Square post',
    description:
      'A 1080 × 1080 social post with a headline and a line of text.',
    document: document(1080, 1080),
  },
  {
    id: 'system:portrait-post',
    revisionNumber: 1,
    name: 'Portrait post',
    description:
      'A 1080 × 1350 portrait social post with a headline and a line of text.',
    document: document(1080, 1350),
  },
  {
    id: 'system:story',
    revisionNumber: 1,
    name: 'Story',
    description:
      'A 1080 × 1920 vertical story with a headline and a line of text.',
    document: document(1080, 1920),
  },
];

export interface ContentStudioSystemDesignTemplate {
  id: string;
  revisionNumber: number;
  name: string;
  description: string;
  schemaVersion: number;
  contentHash: string;
  content: ContentStudioDesignDocumentV1;
}

// A fixed message only: a built-in template that is not valid Design
// Document v1, or not safe to share between organizations
export class ContentStudioSystemDesignTemplateError extends Error {
  constructor(readonly templateId: string) {
    super(`The built-in design template ${templateId} is invalid`);
    this.name = 'ContentStudioSystemDesignTemplateError';
  }
}

// Built-ins carry nothing of an organization: no Brand Kit reference and no
// image (an image would be another organization's Media)
const neutral = (content: ContentStudioDesignDocumentV1) =>
  content.brandKit === null &&
  content.pages.every((entry) =>
    entry.layers.every((layer) => layer.type !== 'image')
  ) &&
  !/https?:|mediaId|tokenId/i.test(JSON.stringify(content));

const build = (
  definitions: SystemTemplateDefinition[]
): ContentStudioSystemDesignTemplate[] => {
  const ids = new Set<string>();
  return definitions.map((definition) => {
    if (
      !DESIGN_SYSTEM_TEMPLATE_ID.test(definition.id) ||
      ids.has(definition.id) ||
      !Number.isSafeInteger(definition.revisionNumber) ||
      definition.revisionNumber < 1
    ) {
      throw new ContentStudioSystemDesignTemplateError(definition.id);
    }
    ids.add(definition.id);
    let content: ContentStudioDesignDocumentV1;
    try {
      content = parseContentStudioDesignDocument(definition.document);
    } catch {
      throw new ContentStudioSystemDesignTemplateError(definition.id);
    }
    if (!neutral(content)) {
      throw new ContentStudioSystemDesignTemplateError(definition.id);
    }
    const stored = storedContentStudioDesignDocument(content);
    return {
      id: definition.id,
      revisionNumber: definition.revisionNumber,
      name: definition.name,
      description: definition.description,
      schemaVersion: stored.schemaVersion,
      contentHash: stored.contentHash,
      content,
    };
  });
};

// Checked once, on first use; every caller gets its own copy of a document
let built: ContentStudioSystemDesignTemplate[] | null = null;
const all = () => (built ??= build(DEFINITIONS));
const copy = (template: ContentStudioSystemDesignTemplate) => ({
  ...template,
  content: JSON.parse(
    JSON.stringify(template.content)
  ) as ContentStudioDesignDocumentV1,
});

export const listContentStudioSystemDesignTemplates = () => all().map(copy);

export const findContentStudioSystemDesignTemplate = (id: unknown) => {
  const template =
    typeof id === 'string' ? all().find((entry) => entry.id === id) : undefined;
  return template ? copy(template) : null;
};

// for the tests: the same checks on other definitions
export const buildContentStudioSystemDesignTemplates = build;
