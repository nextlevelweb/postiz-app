import fs from 'fs';
import path from 'path';
import {
  buildContentStudioAIFirstPostDraftPrompt,
  buildContentStudioAIFirstPostResearchPrompt,
  CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA,
  ContentStudioFirstPostResearch,
  ContentStudioFirstPostResearchInput,
  parseContentStudioFirstPostDraft,
  parseContentStudioFirstPostResearch,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.activation.prompt';
import { parseContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';

// The first post (activation flow 01): the research prompt carries the
// organization's profile and research preferences, the parser tells found
// sources from invented ones, and the draft is grounded in the research

const policy = parseContentStudioEditorialPolicyContent({
  schemaVersion: 1,
  principles: ['PRINCIPLE_SHOW_EXPERTISE'],
  prohibitedTopics: ['PROHIBITED_POLITICS'],
  claimRules: ['CLAIM_NO_NUMBERS'],
  ctaRules: ['CTA_INVITE_CONVERSATION'],
  formatConventions: [],
  complianceNotes: '',
  research: {
    lookFor: ['LOOK_AI_IN_SME'],
    avoid: ['AVOID_GENERIC_AI_NEWS'],
    freshness: 'week',
    angles: ['practical', 'myth_busting'],
  },
});

const input = (
  patch: Partial<ContentStudioFirstPostResearchInput> = {}
): ContentStudioFirstPostResearchInput => ({
  language: 'nl',
  today: '2026-10-30',
  brand: {
    name: 'Testbedrijf ABC',
    tagline: 'TAGLINE_SMARTER',
    description: 'POSITIONING_WEBSITES_AUTOMATION',
  },
  context: {
    writing: null,
    editorialPolicy: policy,
    audience: {
      schemaVersion: 1,
      description: 'AUDIENCE_SME_OWNERS',
      role: 'Owner',
      knowledgeLevel: 'beginner',
      goals: ['AUDIENCE_GOAL_GROWTH'],
      painPoints: [],
      objections: [],
      preferredTone: null,
      locale: 'nl',
    },
    expertise: {
      schemaVersion: 1,
      subjects: ['EXPERTISE_AUTOMATION'],
      differentiators: [],
      stances: [],
      frameworks: [],
      evidenceExpectations: '',
      avoidTopics: ['EXPERTISE_AVOID_CRYPTO'],
      confidenceBoundaries: '',
    },
  },
  preferences: policy.research ?? null,
  findings: [
    {
      title: 'FINDING_TITLE',
      url: 'https://news.example/ai-sme',
      feed: 'Branche feed',
      publishedAt: '2026-10-28',
    },
  ],
  previousTopics: [],
  webSearch: false,
  ...patch,
});

const answer = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    topic: 'AI in het mkb',
    angle: 'Wat werkt en wat niet',
    summary: 'Een nieuwe studie laat zien...',
    why: {
      audience: 'Eigenaren willen weten wat het oplevert',
      expertise: 'Wij automatiseren dagelijks',
      timing: 'Net verschenen',
    },
    sources: [
      {
        title: 'FINDING_TITLE',
        url: 'https://news.example/ai-sme',
        publisher: null,
        publishedAt: '2026-10-28',
      },
    ],
    ...patch,
  });

const research = (): ContentStudioFirstPostResearch =>
  parseContentStudioFirstPostResearch(answer(), input());

describe('First post research prompt', () => {
  it('RES1 carries the positioning, audience, expertise, goal (principles and CTA rules) and editorial policy', () => {
    const { system, prompt } = buildContentStudioAIFirstPostResearchPrompt(
      input()
    );
    for (const marker of [
      'POSITIONING_WEBSITES_AUTOMATION',
      'TAGLINE_SMARTER',
      'AUDIENCE_SME_OWNERS',
      'AUDIENCE_GOAL_GROWTH',
      'EXPERTISE_AUTOMATION',
      'PRINCIPLE_SHOW_EXPERTISE',
      'CTA_INVITE_CONVERSATION',
      'CLAIM_NO_NUMBERS',
      'FINDING_TITLE',
      'https://news.example/ai-sme',
      'language with the tag nl',
      '2026-10-30',
    ]) {
      expect(prompt).toContain(marker);
    }
    // relevance x recency x expertise x audience x a useful perspective
    expect(prompt).toMatch(/relevant to the audience, recent or current/);
    expect(system).toMatch(/never invent a source, an address/);
  });

  it('RES2 respects what to look for and avoid, freshness and angles, prohibited topics and earlier choices', () => {
    const { prompt } = buildContentStudioAIFirstPostResearchPrompt(
      input({ previousTopics: ['EARLIER_TOPIC'] })
    );
    for (const marker of [
      'LOOK_AI_IN_SME',
      'AVOID_GENERIC_AI_NEWS',
      'developments of the last week',
      'practical advice',
      'myth-busting',
      'PROHIBITED_POLITICS',
      'EXPERTISE_AVOID_CRYPTO',
      'EARLIER_TOPIC',
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toMatch(/never choose a subject that avoid names/);
    // without preferences the profile decides, and says so
    expect(
      buildContentStudioAIFirstPostResearchPrompt(input({ preferences: null }))
        .prompt
    ).toContain('None set yet');
  });

  it('asks to search the web only when the model can; otherwise only the findings may be cited', () => {
    expect(
      buildContentStudioAIFirstPostResearchPrompt(input({ webSearch: true }))
        .prompt
    ).toContain('Search the web for current developments');
    expect(
      buildContentStudioAIFirstPostResearchPrompt(input()).prompt
    ).toContain('You cannot search the web');
  });

  it('is deterministic and carries no id', () => {
    const one = buildContentStudioAIFirstPostResearchPrompt(input());
    expect(buildContentStudioAIFirstPostResearchPrompt(input())).toEqual(one);
    expect(one.prompt).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
    );
  });

  it('has a strict schema: every key required, nothing else', () => {
    expect(CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ['topic', 'angle', 'summary', 'why', 'sources'],
    });
  });
});

describe('First post research answer', () => {
  it('RES3 keeps the provenance of each source and says whether the research is source-backed', () => {
    expect(research()).toEqual({
      topic: 'AI in het mkb',
      angle: 'Wat werkt en wat niet',
      summary: 'Een nieuwe studie laat zien...',
      why: {
        audience: 'Eigenaren willen weten wat het oplevert',
        expertise: 'Wij automatiseren dagelijks',
        timing: 'Net verschenen',
      },
      sources: [
        {
          title: 'FINDING_TITLE',
          url: 'https://news.example/ai-sme',
          publisher: null,
          publishedAt: '2026-10-28',
          origin: 'radar',
        },
      ],
      sourceBacked: true,
    });
    // found by the model's own web search
    const web = parseContentStudioFirstPostResearch(
      answer({
        sources: [
          {
            title: 'Web',
            url: 'https://web.example/a',
            publisher: 'Web Weekly',
            publishedAt: 'yesterday',
          },
        ],
      }),
      input({ webSearch: true })
    );
    expect(web.sources).toEqual([
      {
        title: 'Web',
        url: 'https://web.example/a',
        publisher: 'Web Weekly',
        publishedAt: null,
        origin: 'web',
      },
    ]);
    // nothing current: a lasting subject, honestly without sources
    expect(
      parseContentStudioFirstPostResearch(answer({ sources: [] }), input())
        .sourceBacked
    ).toBe(false);
  });

  it('RES3 refuses an address the model could not have found: without web search only the findings count', () => {
    expect(() =>
      parseContentStudioFirstPostResearch(
        answer({
          sources: [
            {
              title: 'Invented',
              url: 'https://invented.example/x',
              publisher: null,
              publishedAt: null,
            },
          ],
        }),
        input()
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it.each([
    ['not JSON', 'Sure! Here is my research'],
    ['a missing why', answer({ why: undefined })],
    ['an extra key', answer({ extra: 1 })],
    [
      'a non-web address',
      answer({
        sources: [
          {
            title: 'x',
            url: 'javascript:alert(1)',
            publisher: null,
            publishedAt: null,
          },
        ],
      }),
    ],
    ['an empty topic', answer({ topic: '  ' })],
  ])('refuses %s', (_label, text) => {
    expect(() =>
      parseContentStudioFirstPostResearch(text, input({ webSearch: true }))
    ).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });
});

describe('First post draft', () => {
  it('RES4 drafts from the research: its topic, angle, summary and sources are in the prompt', () => {
    const { prompt } = buildContentStudioAIFirstPostDraftPrompt({
      language: 'nl',
      brand: input().brand,
      context: input().context,
      research: research(),
    });
    for (const marker of [
      'AI in het mkb',
      'Wat werkt en wat niet',
      'Een nieuwe studie laat zien...',
      'https://news.example/ai-sme',
      'CTA_INVITE_CONVERSATION',
      'language with the tag nl',
    ]) {
      expect(prompt).toContain(marker);
    }
    const lasting = buildContentStudioAIFirstPostDraftPrompt({
      language: 'nl',
      brand: null,
      context: input().context,
      research: { ...research(), sources: [], sourceBacked: false },
    });
    expect(lasting.prompt).toContain('never as news');
  });

  it('RES4 accepts only the addresses of the research in the post', () => {
    expect(
      parseContentStudioFirstPostDraft(
        JSON.stringify({
          text: 'Lees meer: https://news.example/ai-sme.',
        }),
        research()
      )
    ).toEqual({ text: 'Lees meer: https://news.example/ai-sme.' });
    expect(() =>
      parseContentStudioFirstPostDraft(
        JSON.stringify({ text: 'Zie https://elsewhere.example/x' }),
        research()
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() =>
      parseContentStudioFirstPostDraft(JSON.stringify({ text: '' }), research())
    ).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });
});

describe('First post: no social side effects', () => {
  const read = (file: string) =>
    fs.readFileSync(path.resolve(__dirname, '../../../../..', file), 'utf8');

  it('RES5 research and draft never reach a social provider, integration, post or analytics', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/content-studio/ai/ai.activation.prompt.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.activation.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.activation.repository.ts',
    ]) {
      const text = read(file);
      expect(text).not.toMatch(
        /integrations\/|IntegrationService|IntegrationRepository|PostsService|posts\.service|analytics|social\/|temporal|workflow\.start|refreshToken|accessToken/i
      );
    }
    // the repository only reads posts, never writes one
    const repository = read(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.activation.repository.ts'
    );
    expect(repository).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/);
  });
});
