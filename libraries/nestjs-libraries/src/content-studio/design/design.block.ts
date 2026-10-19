import {
  ContentStudioDesignLayoutPatternContentV1,
  ContentStudioDesignLayoutPatternError,
  DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX,
  DESIGN_LAYOUT_PATTERN_LAYERS_MAX,
  DESIGN_LAYOUT_PATTERN_MAX_BYTES,
  DESIGN_LAYOUT_PATTERN_NAME_MAX,
  extractContentStudioDesignLayoutPattern,
  instantiateContentStudioDesignLayoutPattern,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';

// Design Block v1 (P4-18): a reusable creative asset, some styled layers of
// one page saved to be used again as they are (a CTA, a quote card, a logo
// with its strapline), copied into a page when it is used and never linked
// to it. Its content is exactly the Layout Pattern v1 layer snapshot (P4-15):
// a box and its layers back to front, Design Document v1 layers without
// their ids, x and y measured from the box, every value checked by the
// Design Document v1 parser. A layout pattern and a block are different
// things to the person using them (an arrangement to start from, a finished
// piece to reuse) and are stored, listed and managed apart, but they share
// this one format, its parser, extraction, placement and canonical hash, so
// there is a single place where a reusable layer snapshot is defined. No
// page, layer id, Brand Kit reference, guidance, template, preset, pattern
// or block id is ever part of it. Like the other content parsers this file
// uses no Node-only module (storage and hashing: design.block.stored.ts)

export type ContentStudioDesignBlockContentV1 =
  ContentStudioDesignLayoutPatternContentV1;

export const DESIGN_BLOCK_SCHEMA_VERSION = 1;
export const DESIGN_BLOCK_LAYERS_MAX = DESIGN_LAYOUT_PATTERN_LAYERS_MAX;
export const DESIGN_BLOCK_MAX_BYTES = DESIGN_LAYOUT_PATTERN_MAX_BYTES;
export const DESIGN_BLOCK_NAME_MAX = DESIGN_LAYOUT_PATTERN_NAME_MAX;
export const DESIGN_BLOCK_DESCRIPTION_MAX =
  DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX;

// INVALID or TOO_LARGE, as for a layout pattern
export const ContentStudioDesignBlockError =
  ContentStudioDesignLayoutPatternError;

export const parseContentStudioDesignBlockContent =
  parseContentStudioDesignLayoutPatternContent;
export const extractContentStudioDesignBlock =
  extractContentStudioDesignLayoutPattern;
export const instantiateContentStudioDesignBlock =
  instantiateContentStudioDesignLayoutPattern;
