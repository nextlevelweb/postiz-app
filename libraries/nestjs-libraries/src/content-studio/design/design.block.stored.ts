import {
  ContentStudioDesignLayoutPatternIntegrityError,
  parseVerifiedContentStudioDesignLayoutPattern,
  storedContentStudioDesignLayoutPattern,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern.stored';

// What a design block row stores and how it is read back: exactly as for a
// layout pattern (canonical JSON of the shared layer snapshot and the
// SHA-256 of that text; a read proves it is still exactly what was written
// and fails closed otherwise)
export const storedContentStudioDesignBlock =
  storedContentStudioDesignLayoutPattern;
export const parseVerifiedContentStudioDesignBlock =
  parseVerifiedContentStudioDesignLayoutPattern;
export const ContentStudioDesignBlockIntegrityError =
  ContentStudioDesignLayoutPatternIntegrityError;
