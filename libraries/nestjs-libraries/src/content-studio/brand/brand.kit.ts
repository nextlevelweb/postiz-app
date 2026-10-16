import { z } from 'zod';
import {
  distinctList,
  isPlainData,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// Brand Kit v1: the visual identity of an organization as structured, bounded
// data, entered by hand. Later design documents read it from an exact
// revision and refer to its colors and type styles by token id, never to the
// "current" kit. It holds descriptions only: no asset, logo, font file, Media
// id or URL field, and no CSS, HTML or SVG. A typography family is a name, not
// a font the renderer can use. Lengths count UTF-16 code units after line
// endings are normalized, like the editorial profiles. Like those parsers this
// file uses no Node-only module

export const BRAND_KIT_SCHEMA_VERSION = 1;

export const BRAND_NAME_MAX = 200;
export const BRAND_TAGLINE_MAX = 300;
export const BRAND_DESCRIPTION_MAX = 2000;
export const BRAND_COLORS_MAX = 16;
export const BRAND_TYPOGRAPHY_MAX = 8;
export const BRAND_TOKEN_NAME_MAX = 80;
export const BRAND_FONT_FAMILY_MAX = 200;
export const BRAND_KEYWORDS_MAX = 20;
export const BRAND_KEYWORD_MAX = 60;
export const BRAND_RULES_MAX = 20;
export const BRAND_RULE_MAX = 300;
// UTF-8 bytes of the normalized kit as JSON. canonicalJson writes the same
// keys and strings in another order only, so this is its size too
export const BRAND_KIT_CONTENT_MAX_BYTES = 32_768;

// A token id names a color or type style inside one revision: a short
// lowercase word chosen by the organization, not a database id. Colors and
// typography are separate namespaces
export const BRAND_TOKEN_ID = /^[a-z][a-z0-9_-]{0,31}$/;
// exactly #rrggbb: no shorthand, alpha, functions, names or variables.
// Stored lowercase
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const BRAND_COLOR_ROLES = [
  'primary',
  'secondary',
  'accent',
  'background',
  'surface',
  'text',
  'muted',
  'custom',
] as const;
export const BRAND_TYPOGRAPHY_ROLES = [
  'heading',
  'body',
  'accent',
  'custom',
] as const;
export const BRAND_FONT_WEIGHTS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900,
] as const;
export const BRAND_FONT_STYLES = ['normal', 'italic'] as const;

// Token ids are unique within their list, and every role but custom is used
// at most once, so a role names one token. Nothing is merged or reordered
const tokenList = (token: z.ZodTypeAny, max: number) =>
  z
    .array(token)
    .max(max)
    .superRefine((tokens: Array<{ id: string; role: string }>, context) => {
      const ids = new Set<string>();
      const roles = new Set<string>();
      tokens.forEach((entry, index) => {
        if (ids.has(entry.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: 'Duplicate token id',
          });
        }
        ids.add(entry.id);
        if (entry.role !== 'custom') {
          if (roles.has(entry.role)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'role'],
              message: 'Role already used',
            });
          }
          roles.add(entry.role);
        }
      });
    });

const tokenId = z.string().regex(BRAND_TOKEN_ID);

const colorSchema = z
  .object({
    id: tokenId,
    name: trimmedText(BRAND_TOKEN_NAME_MAX, 1),
    value: z
      .string()
      .regex(HEX_COLOR)
      .transform((value) => value.toLowerCase()),
    role: z.enum(BRAND_COLOR_ROLES),
  })
  .strict();

const typographySchema = z
  .object({
    id: tokenId,
    name: trimmedText(BRAND_TOKEN_NAME_MAX, 1),
    // a family name as text, never parsed as CSS or resolved to a font
    family: trimmedText(BRAND_FONT_FAMILY_MAX, 1),
    weight: z
      .number()
      .refine(
        (weight) => (BRAND_FONT_WEIGHTS as readonly number[]).includes(weight),
        'Unsupported weight'
      ),
    style: z.enum(BRAND_FONT_STYLES),
    role: z.enum(BRAND_TYPOGRAPHY_ROLES),
  })
  .strict();

// Every key is required; empty texts and lists are valid, so a kit can be
// filled in step by step
const contentSchema = z
  .object({
    schemaVersion: z.literal(BRAND_KIT_SCHEMA_VERSION),
    identity: z
      .object({
        brandName: trimmedText(BRAND_NAME_MAX),
        tagline: trimmedText(BRAND_TAGLINE_MAX),
        description: trimmedText(BRAND_DESCRIPTION_MAX),
      })
      .strict(),
    colors: tokenList(colorSchema, BRAND_COLORS_MAX),
    typography: tokenList(typographySchema, BRAND_TYPOGRAPHY_MAX),
    // visual guidance only; the same text in two lists is allowed
    visualDirection: z
      .object({
        keywords: distinctList(
          trimmedText(BRAND_KEYWORD_MAX, 1),
          BRAND_KEYWORDS_MAX
        ),
        dos: distinctList(trimmedText(BRAND_RULE_MAX, 1), BRAND_RULES_MAX),
        donts: distinctList(trimmedText(BRAND_RULE_MAX, 1), BRAND_RULES_MAX),
      })
      .strict(),
  })
  .strict();

export type ContentStudioBrandColorRole = (typeof BRAND_COLOR_ROLES)[number];
export type ContentStudioBrandTypographyRole =
  (typeof BRAND_TYPOGRAPHY_ROLES)[number];

export interface ContentStudioBrandColorToken {
  id: string;
  name: string;
  value: string;
  role: ContentStudioBrandColorRole;
}

export interface ContentStudioBrandTypographyToken {
  id: string;
  name: string;
  family: string;
  weight: (typeof BRAND_FONT_WEIGHTS)[number];
  style: (typeof BRAND_FONT_STYLES)[number];
  role: ContentStudioBrandTypographyRole;
}

export interface ContentStudioBrandKitContentV1 {
  schemaVersion: 1;
  identity: { brandName: string; tagline: string; description: string };
  colors: ContentStudioBrandColorToken[];
  typography: ContentStudioBrandTypographyToken[];
  visualDirection: { keywords: string[]; dos: string[]; donts: string[] };
}

export type ContentStudioBrandKitErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioBrandKitIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioBrandKitErrorCode, string> = {
  INVALID: 'The Brand Kit does not match schema version 1',
  TOO_LARGE: 'The Brand Kit is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value
export class ContentStudioBrandKitError extends Error {
  readonly issues?: ContentStudioBrandKitIssue[];

  constructor(
    readonly code: ContentStudioBrandKitErrorCode,
    issues?: ContentStudioBrandKitIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioBrandKitError';
    this.issues = issues;
  }
}

export class ContentStudioBrandKitTooLargeError extends ContentStudioBrandKitError {
  constructor() {
    super('TOO_LARGE');
    this.name = 'ContentStudioBrandKitTooLargeError';
  }
}

// Validates and normalizes a Brand Kit (from a request or read back from the
// database) into a new object: line endings normalized, texts trimmed, color
// values lowercased. The input is never changed. Anything else is refused,
// never repaired: no token or entry is dropped, merged or reordered
export function parseContentStudioBrandKitContent(
  input: unknown
): ContentStudioBrandKitContentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioBrandKitError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = contentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioBrandKitError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  if (
    utf8ByteLength(JSON.stringify(result.data)) > BRAND_KIT_CONTENT_MAX_BYTES
  ) {
    throw new ContentStudioBrandKitTooLargeError();
  }
  return result.data as ContentStudioBrandKitContentV1;
}

// A kit with nothing filled in yet
export const emptyContentStudioBrandKitContent =
  (): ContentStudioBrandKitContentV1 =>
    parseContentStudioBrandKitContent({
      schemaVersion: BRAND_KIT_SCHEMA_VERSION,
      identity: { brandName: '', tagline: '', description: '' },
      colors: [],
      typography: [],
      visualDirection: { keywords: [], dos: [], donts: [] },
    });
