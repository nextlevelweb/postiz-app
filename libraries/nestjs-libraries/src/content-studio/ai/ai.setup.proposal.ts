import { z } from 'zod';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioWritingProfileContentV1,
  parseContentStudioWritingProfileContent,
  WRITING_PERSPECTIVES,
  WRITING_EMOJI_USE,
  WRITING_HASHTAG_USE,
  WRITING_PROFILE_NAME_MAX,
  WRITING_RULE_MAX,
  WRITING_RULES_MAX,
  WRITING_TONE_TAGS_MAX,
  WRITING_VOCABULARY_MAX,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  AUDIENCE_KNOWLEDGE_LEVELS,
  AUDIENCE_LIST_MAX,
  AUDIENCE_PROFILE_NAME_MAX,
  ContentStudioAudienceProfileContentV1,
  parseContentStudioAudienceProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';
import {
  ContentStudioExpertiseProfileContentV1,
  EXPERTISE_AVOID_TOPICS_MAX,
  EXPERTISE_DIFFERENTIATORS_MAX,
  EXPERTISE_FRAMEWORKS_MAX,
  EXPERTISE_PROFILE_NAME_MAX,
  EXPERTISE_STANCES_MAX,
  EXPERTISE_SUBJECTS_MAX,
  parseContentStudioExpertiseProfileContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile';
import {
  ContentStudioEditorialPolicyContentV1,
  EDITORIAL_CLAIM_RULES_MAX,
  EDITORIAL_CTA_RULES_MAX,
  EDITORIAL_FORMAT_CONVENTIONS_MAX,
  EDITORIAL_PRINCIPLES_MAX,
  EDITORIAL_PROHIBITED_TOPICS_MAX,
  parseContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import {
  BRAND_DESCRIPTION_MAX,
  BRAND_TAGLINE_MAX,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';

// What a provider answered for the guided setup, checked before the
// operation counts as succeeded. The answer becomes exactly the content each
// profile, the policy and the Brand Kit identity take, through their own
// parsers: anything those refuse refuses the whole answer. Only list
// housekeeping is done here, because the user reviews every entry before
// anything is saved: blank and repeated entries are left out, lists are cut
// to their limit, and a term or topic that is both used and avoided is kept
// as used only. Texts are never cut or rewritten. Nothing here is stored

export const SETUP_AUDIENCES_MAX = 3;
export const SETUP_AVOID_REASON_MAX = 200;

export interface ContentStudioAISetupProposalV1 {
  brand: { tagline: string; description: string };
  writing: { name: string; content: ContentStudioWritingProfileContentV1 };
  audiences: Array<{
    name: string;
    content: ContentStudioAudienceProfileContentV1;
  }>;
  expertise: { name: string; content: ContentStudioExpertiseProfileContentV1 };
  editorialPolicy: { content: ContentStudioEditorialPolicyContentV1 };
}

// An avoided term with its reason, as a Don't rule of the Writing DNA: the
// term in double quotes, a dash and the reason. The Writing DNA has no field
// for a reason, and its rules are read by every later AI request
export const contentStudioAvoidReasonRule = (term: string, reason: string) =>
  `"${term}" — ${reason}`;

const invalidResponse = () =>
  new ContentStudioAIProviderError('INVALID_RESPONSE');

const text = z.string().transform((value) => value.trim());
const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((value) => (value ? value.trim() : '') || null);
const list = z.array(z.string());

const rawSchema = z
  .object({
    brand: z.object({ tagline: text, description: text }).strict(),
    writing: z
      .object({
        name: text,
        voice: text,
        toneTags: list,
        perspective: z.enum(WRITING_PERSPECTIVES).nullable(),
        emoji: z.enum(WRITING_EMOJI_USE),
        hashtags: z.enum(WRITING_HASHTAG_USE),
        formattingNotes: optionalText,
        prefer: list,
        avoid: z.array(z.object({ term: text, reason: optionalText }).strict()),
        dos: list,
        donts: list,
      })
      .strict(),
    audiences: z
      .array(
        z
          .object({
            name: text,
            description: text,
            role: text,
            knowledgeLevel: z.enum(AUDIENCE_KNOWLEDGE_LEVELS),
            goals: list,
            painPoints: list,
            objections: list,
            preferredTone: optionalText,
          })
          .strict()
      )
      .min(1),
    expertise: z
      .object({
        name: text,
        subjects: list,
        differentiators: list,
        stances: z.array(z.object({ topic: text, position: text }).strict()),
        frameworks: list,
        evidenceExpectations: text,
        avoidTopics: list,
        confidenceBoundaries: text,
      })
      .strict(),
    editorial: z
      .object({
        principles: list,
        prohibitedTopics: list,
        claimRules: list,
        ctaRules: list,
        formatConventions: list,
        complianceNotes: text,
      })
      .strict(),
  })
  .strict();

// Trimmed, without blank or repeated entries and entries of `except`, cut to
// max
const entries = (
  values: string[],
  max: number,
  except: string[] = []
): string[] => {
  const kept: string[] = [];
  for (const value of values.map((entry) => entry.trim())) {
    if (value && !kept.includes(value) && !except.includes(value)) {
      kept.push(value);
    }
  }
  return kept.slice(0, max);
};

const name = (value: string, max: number) => {
  if (!value || value.length > max) {
    throw invalidResponse();
  }
  return value;
};

// A model without JSON output (Claude through the pinned SDK) sometimes
// wraps the whole answer in one Markdown code fence despite the prompt. Only
// that exact shape is unwrapped: text before or after the fence, or a second
// fence, still makes the answer invalid
const JSON_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/;
export const withoutJsonFence = (raw: string) => {
  const fenced = raw.trim().match(JSON_FENCE);
  return fenced && !fenced[1].includes('```') ? fenced[1] : raw;
};

// Strict about everything but list housekeeping; throws INVALID_RESPONSE.
// The audiences are written for the language the setup asked for
export function parseContentStudioAISetupProposal(
  raw: unknown,
  language: string
): ContentStudioAISetupProposalV1 {
  if (typeof raw !== 'string') {
    throw invalidResponse();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutJsonFence(raw));
  } catch {
    throw invalidResponse();
  }
  const result = rawSchema.safeParse(parsed);
  if (!result.success) {
    throw invalidResponse();
  }
  const answer = result.data;

  if (
    answer.brand.tagline.length > BRAND_TAGLINE_MAX ||
    answer.brand.description.length > BRAND_DESCRIPTION_MAX
  ) {
    throw invalidResponse();
  }

  try {
    const prefer = entries(answer.writing.prefer, WRITING_VOCABULARY_MAX);
    const avoided = answer.writing.avoid.filter(
      (entry, index, all) =>
        entry.term &&
        !prefer.includes(entry.term) &&
        all.findIndex((other) => other.term === entry.term) === index
    );
    const avoid = avoided
      .slice(0, WRITING_VOCABULARY_MAX)
      .map((entry) => entry.term);
    // a reason goes with its term as a Don't rule, after the answer's own
    const reasons = avoided
      .slice(0, WRITING_VOCABULARY_MAX)
      .filter((entry) => entry.reason)
      .map((entry) =>
        contentStudioAvoidReasonRule(entry.term, entry.reason as string)
      )
      .filter((rule) => rule.length <= WRITING_RULE_MAX);
    const writing = parseContentStudioWritingProfileContent({
      schemaVersion: 1,
      voice: answer.writing.voice,
      toneTags: entries(answer.writing.toneTags, WRITING_TONE_TAGS_MAX),
      perspective: answer.writing.perspective,
      formatting: {
        emoji: answer.writing.emoji,
        hashtags: answer.writing.hashtags,
        notes: answer.writing.formattingNotes,
      },
      vocabulary: { prefer, avoid },
      dos: entries(answer.writing.dos, WRITING_RULES_MAX),
      donts: entries([...answer.writing.donts, ...reasons], WRITING_RULES_MAX),
      examples: [],
    });

    const audiences = answer.audiences
      .slice(0, SETUP_AUDIENCES_MAX)
      .map((audience) => ({
        name: name(audience.name, AUDIENCE_PROFILE_NAME_MAX),
        content: parseContentStudioAudienceProfileContent({
          schemaVersion: 1,
          description: audience.description,
          role: audience.role,
          knowledgeLevel: audience.knowledgeLevel,
          goals: entries(audience.goals, AUDIENCE_LIST_MAX),
          painPoints: entries(audience.painPoints, AUDIENCE_LIST_MAX),
          objections: entries(audience.objections, AUDIENCE_LIST_MAX),
          preferredTone: audience.preferredTone,
          locale: language,
        }),
      }));
    if (
      new Set(audiences.map((audience) => audience.name)).size !==
      audiences.length
    ) {
      throw invalidResponse();
    }

    const subjects = entries(answer.expertise.subjects, EXPERTISE_SUBJECTS_MAX);
    const stances = answer.expertise.stances
      .filter(
        (stance, index, all) =>
          stance.topic &&
          stance.position &&
          all.findIndex((other) => other.topic === stance.topic) === index
      )
      .slice(0, EXPERTISE_STANCES_MAX);
    const expertise = parseContentStudioExpertiseProfileContent({
      schemaVersion: 1,
      subjects,
      differentiators: entries(
        answer.expertise.differentiators,
        EXPERTISE_DIFFERENTIATORS_MAX
      ),
      stances,
      frameworks: entries(
        answer.expertise.frameworks,
        EXPERTISE_FRAMEWORKS_MAX
      ),
      evidenceExpectations: answer.expertise.evidenceExpectations,
      avoidTopics: entries(
        answer.expertise.avoidTopics,
        EXPERTISE_AVOID_TOPICS_MAX,
        [...subjects, ...stances.map((stance) => stance.topic)]
      ),
      confidenceBoundaries: answer.expertise.confidenceBoundaries,
    });

    const editorial = parseContentStudioEditorialPolicyContent({
      schemaVersion: 1,
      principles: entries(
        answer.editorial.principles,
        EDITORIAL_PRINCIPLES_MAX
      ),
      prohibitedTopics: entries(
        answer.editorial.prohibitedTopics,
        EDITORIAL_PROHIBITED_TOPICS_MAX
      ),
      claimRules: entries(
        answer.editorial.claimRules,
        EDITORIAL_CLAIM_RULES_MAX
      ),
      ctaRules: entries(answer.editorial.ctaRules, EDITORIAL_CTA_RULES_MAX),
      formatConventions: entries(
        answer.editorial.formatConventions,
        EDITORIAL_FORMAT_CONVENTIONS_MAX
      ),
      complianceNotes: answer.editorial.complianceNotes,
    });

    return {
      brand: {
        tagline: answer.brand.tagline,
        description: answer.brand.description,
      },
      writing: {
        name: name(answer.writing.name, WRITING_PROFILE_NAME_MAX),
        content: writing,
      },
      audiences,
      expertise: {
        name: name(answer.expertise.name, EXPERTISE_PROFILE_NAME_MAX),
        content: expertise,
      },
      editorialPolicy: { content: editorial },
    };
  } catch (err) {
    // a profile parser's error names the path only; the answer is refused
    // as a whole
    if (err instanceof ContentStudioAIProviderError) {
      throw err;
    }
    throw invalidResponse();
  }
}
