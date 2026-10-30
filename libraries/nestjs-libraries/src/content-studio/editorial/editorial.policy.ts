import { z } from 'zod';
import {
  distinctList,
  isPlainData,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// Editorial Policy v1: the editorial rules of an organization, as structured,
// bounded data that later AI generation reads from an exact revision and
// later review shows next to a draft. Entered by hand. Its rules are context,
// not enforcement: nothing here checks content against them, verifies a claim
// or promises compliance. The one thing a policy enforces is its optional
// workflow (P5-07): whether a package revision must be approved before it is
// handed off to the composer, judged for exactly that revision when the
// handoff is made, by the policy current then. Lengths count UTF-16 code
// units after line endings are normalized, like the Writing DNA. Like that
// parser this file uses no Node-only module

export const EDITORIAL_POLICY_SCHEMA_VERSION = 1;

export const EDITORIAL_PRINCIPLES_MAX = 20;
export const EDITORIAL_PRINCIPLE_MAX = 500;
export const EDITORIAL_PROHIBITED_TOPICS_MAX = 30;
export const EDITORIAL_PROHIBITED_TOPIC_MAX = 200;
export const EDITORIAL_CLAIM_RULES_MAX = 20;
export const EDITORIAL_CLAIM_RULE_MAX = 500;
export const EDITORIAL_CTA_RULES_MAX = 10;
export const EDITORIAL_CTA_RULE_MAX = 300;
export const EDITORIAL_FORMAT_CONVENTIONS_MAX = 20;
export const EDITORIAL_FORMAT_CONVENTION_MAX = 300;
export const EDITORIAL_COMPLIANCE_NOTES_MAX = 4000;
// UTF-8 bytes of the normalized policy as JSON. canonicalJson writes the same
// keys and strings in another order only, so this is its size too
export const EDITORIAL_POLICY_CONTENT_MAX_BYTES = 32_768;

// What Content Studio researches for the organization (activation flow 01):
// what to look for and stay away from, how fresh a subject should be and
// which angles fit. Context for the first-post research, refined by the
// user; a policy without it (every policy saved before it existed) leaves
// the choice to the profile
export const CONTENT_STUDIO_RESEARCH_FRESHNESS = [
  'breaking',
  'week',
  'month',
  'evergreen',
] as const;
export const CONTENT_STUDIO_RESEARCH_ANGLES = [
  'practical',
  'explainer',
  'opinion',
  'analysis',
  'example',
  'myth_busting',
  'opportunity',
  'industry',
] as const;
export const RESEARCH_FOCUS_MAX = 10;
export const RESEARCH_FOCUS_ENTRY_MAX = 200;

const researchSchema = z
  .object({
    lookFor: distinctList(
      trimmedText(RESEARCH_FOCUS_ENTRY_MAX, 1),
      RESEARCH_FOCUS_MAX
    ),
    avoid: distinctList(
      trimmedText(RESEARCH_FOCUS_ENTRY_MAX, 1),
      RESEARCH_FOCUS_MAX
    ),
    freshness: z.enum(CONTENT_STUDIO_RESEARCH_FRESHNESS),
    angles: z
      .array(z.enum(CONTENT_STUDIO_RESEARCH_ANGLES))
      .max(CONTENT_STUDIO_RESEARCH_ANGLES.length)
      .refine((angles) => new Set(angles).size === angles.length),
  })
  .strict();

export interface ContentStudioResearchPreferences {
  lookFor: string[];
  avoid: string[];
  freshness: (typeof CONTENT_STUDIO_RESEARCH_FRESHNESS)[number];
  angles: Array<(typeof CONTENT_STUDIO_RESEARCH_ANGLES)[number]>;
}

// The workflow of the organization's Content Studio: one switch. A policy
// without it (every policy saved before it existed) requires nothing
const workflowSchema = z
  .object({
    requireApprovalForHandoff: z.boolean(),
  })
  .strict();

// Every key but workflow and research is required. Each list refuses an entry it already
// has; the same text in two different lists is allowed
const contentSchema = z
  .object({
    schemaVersion: z.literal(EDITORIAL_POLICY_SCHEMA_VERSION),
    principles: distinctList(
      trimmedText(EDITORIAL_PRINCIPLE_MAX, 1),
      EDITORIAL_PRINCIPLES_MAX
    ),
    prohibitedTopics: distinctList(
      trimmedText(EDITORIAL_PROHIBITED_TOPIC_MAX, 1),
      EDITORIAL_PROHIBITED_TOPICS_MAX
    ),
    claimRules: distinctList(
      trimmedText(EDITORIAL_CLAIM_RULE_MAX, 1),
      EDITORIAL_CLAIM_RULES_MAX
    ),
    ctaRules: distinctList(
      trimmedText(EDITORIAL_CTA_RULE_MAX, 1),
      EDITORIAL_CTA_RULES_MAX
    ),
    formatConventions: distinctList(
      trimmedText(EDITORIAL_FORMAT_CONVENTION_MAX, 1),
      EDITORIAL_FORMAT_CONVENTIONS_MAX
    ),
    // one free text, trimmed outside and kept as written inside; empty when
    // there is nothing to note
    complianceNotes: trimmedText(EDITORIAL_COMPLIANCE_NOTES_MAX),
    workflow: workflowSchema.optional(),
    research: researchSchema.optional(),
  })
  .strict();

export interface ContentStudioEditorialPolicyContentV1 {
  schemaVersion: 1;
  principles: string[];
  prohibitedTopics: string[];
  claimRules: string[];
  ctaRules: string[];
  formatConventions: string[];
  complianceNotes: string;
  // only ever { requireApprovalForHandoff: true }: off is no workflow at all
  workflow?: { requireApprovalForHandoff: boolean };
  research?: ContentStudioResearchPreferences;
}

export type ContentStudioEditorialPolicyErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioEditorialPolicyIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioEditorialPolicyErrorCode, string> = {
  INVALID: 'The editorial policy does not match schema version 1',
  TOO_LARGE: 'The editorial policy is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value, which may be confidential
export class ContentStudioEditorialPolicyError extends Error {
  readonly issues?: ContentStudioEditorialPolicyIssue[];

  constructor(
    readonly code: ContentStudioEditorialPolicyErrorCode,
    issues?: ContentStudioEditorialPolicyIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioEditorialPolicyError';
    this.issues = issues;
  }
}

// Validates and normalizes an editorial policy (from a request or read back
// from the database) into a new object: line endings normalized, entries and
// notes trimmed, a workflow that requires nothing left out. The input is
// never changed. Anything else is refused, never repaired: no entry is
// dropped or merged
export function parseContentStudioEditorialPolicyContent(
  input: unknown
): ContentStudioEditorialPolicyContentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioEditorialPolicyError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = contentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioEditorialPolicyError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  // off has one form, so a policy saved before the workflow existed and the
  // same policy saved with it off are the same text and hash
  const { workflow, ...rules } = result.data;
  const content = workflow?.requireApprovalForHandoff
    ? { ...rules, workflow: { requireApprovalForHandoff: true } }
    : rules;
  if (
    utf8ByteLength(JSON.stringify(content)) > EDITORIAL_POLICY_CONTENT_MAX_BYTES
  ) {
    throw new ContentStudioEditorialPolicyError('TOO_LARGE');
  }
  return content as ContentStudioEditorialPolicyContentV1;
}

// Whether a policy (null: none saved yet) requires a revision to be approved
// before it is handed off. Anything but an explicit true requires nothing
export const isContentStudioApprovalRequiredForHandoff = (
  policy: Pick<ContentStudioEditorialPolicyContentV1, 'workflow'> | null
) => policy?.workflow?.requireApprovalForHandoff === true;

// A policy with no rules yet
export const emptyContentStudioEditorialPolicyContent =
  (): ContentStudioEditorialPolicyContentV1 =>
    parseContentStudioEditorialPolicyContent({
      schemaVersion: EDITORIAL_POLICY_SCHEMA_VERSION,
      principles: [],
      prohibitedTopics: [],
      claimRules: [],
      ctaRules: [],
      formatConventions: [],
      complianceNotes: '',
    });
