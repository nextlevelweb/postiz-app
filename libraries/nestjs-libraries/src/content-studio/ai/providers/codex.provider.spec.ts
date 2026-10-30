import childProcess from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import {
  buildContentStudioAISetupPrompt,
  CONTENT_STUDIO_AI_SETUP_SCHEMA,
  CONTENT_STUDIO_AI_SETUP_SCHEMA_NAME,
  ContentStudioAISetupInput,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.prompt';
import { parseContentStudioAISetupProposal } from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.proposal';
import {
  buildContentStudioAIFirstPostDraftPrompt,
  buildContentStudioAIFirstPostResearchPrompt,
  CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA,
  CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA_NAME,
  CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA,
  CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA_NAME,
  parseContentStudioFirstPostDraft,
  parseContentStudioFirstPostResearch,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.activation.prompt';
import { parseContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import { ContentStudioAITextRequest } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  ContentStudioCodexRun,
  createCodexProviderAdapter,
} from '@gitroom/nestjs-libraries/content-studio/ai/providers/codex.provider';

// The Codex adapter runs `codex exec` with the server's own Codex sign-in.
// These tests replace the process runner: no process is started. The last
// test makes one real model call and runs only when asked for
// (CONTENT_STUDIO_CODEX_REAL_TEST=1) on a machine where codex is signed in

const SEMANTIC_INPUT: ContentStudioAISetupInput = {
  companyName: 'Testbedrijf ABC',
  tagline: 'Slimmer groeien zonder marketingbla',
  website: 'https://testbedrijf-abc.example',
  description:
    'We bouwen websites, automatiseren handmatig werk en helpen mkb-bedrijven AI praktisch in hun organisatie toe te passen. We houden niet van opgeblazen claims, termen als "revolutionair" en "gamechanger", of vage marketingtaal. Onze aanpak is direct, deskundig en nuchter.',
  goal: 'Expertise aantonen en relevante gesprekken met ondernemers starten.',
  audience:
    'Eigenaren en marketingverantwoordelijken bij Nederlandse mkb-bedrijven.',
  language: 'nl',
};

// the request the setup service makes for a structured-output model
const setupRequest = (model = 'gpt-6.1-sol'): ContentStudioAITextRequest => {
  const prompt = buildContentStudioAISetupPrompt(SEMANTIC_INPUT);
  return {
    model,
    system: prompt.system,
    prompt: prompt.prompt,
    output: {
      type: 'json',
      schemaName: CONTENT_STUDIO_AI_SETUP_SCHEMA_NAME,
      schema: CONTENT_STUDIO_AI_SETUP_SCHEMA,
    },
    maxOutputTokens: 8192,
    timeoutMs: 150_000,
  };
};

const events = (...lines: unknown[]) =>
  lines.map((line) => JSON.stringify(line)).join('\n');

const run = (overrides: Partial<ContentStudioCodexRun> = {}) => ({
  exitCode: 0,
  stdout: events(
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 100,
        output_tokens: 900,
        reasoning_output_tokens: 300,
      },
    }
  ),
  timedOut: false,
  missing: false,
  ...overrides,
});

const fakeRunner = (result: ContentStudioCodexRun = run()) => {
  const seen: { args: string[]; stdin: string; schema?: unknown }[] = [];
  const runner = jest.fn(
    async (args: string[], options: { stdin: string; timeoutMs: number }) => {
      const at = args.indexOf('--output-schema');
      seen.push({
        args,
        stdin: options.stdin,
        // read while the run lasts: the folder is removed after it
        schema:
          at >= 0
            ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8'))
            : undefined,
      });
      return result;
    }
  );
  return { runner, seen };
};

describe('Codex adapter: codex exec', () => {
  it('T1/T7 sends the whole setup prompt on stdin and the setup schema as the output schema', async () => {
    const { runner, seen } = fakeRunner();
    const result = await createCodexProviderAdapter(runner).generateText(
      setupRequest()
    );
    expect(result).toEqual({
      text: '{}',
      finishReason: 'stop',
      usage: {
        inputTokens: 1200,
        cachedInputTokens: 100,
        outputTokens: 900,
        reasoningTokens: 300,
      },
    });
    const [{ args, stdin, schema }] = seen;
    expect(args.slice(0, 1)).toEqual(['exec']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        'shell_environment_policy.inherit="none"',
      ])
    );
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6.1-sol');
    expect(args[args.length - 1]).toBe('-');
    expect(schema).toEqual(CONTENT_STUDIO_AI_SETUP_SCHEMA);
    // every wizard input reaches the model
    for (const value of Object.values(SEMANTIC_INPUT)) {
      expect(stdin).toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(stdin).toContain('language with the tag nl.');
    expect(stdin.startsWith(setupRequest().system)).toBe(true);
    // the temporary folder is gone after the run
    expect(fs.existsSync(args[args.indexOf('--output-schema') + 1])).toBe(
      false
    );
  });

  it('sends a text request without an output schema', async () => {
    const { runner, seen } = fakeRunner();
    await createCodexProviderAdapter(runner).generateText({
      ...setupRequest(),
      output: { type: 'text' },
    });
    expect(seen[0].args).not.toContain('--output-schema');
  });

  // activation flow 01: the first-post research may search the web; every
  // other request has Codex's web search off
  it('turns web search on only when the request asks for it', async () => {
    const off = fakeRunner();
    await createCodexProviderAdapter(off.runner).generateText(setupRequest());
    expect(off.seen[0].args).toContain('web_search="disabled"');
    expect(off.seen[0].args).not.toContain('web_search="live"');
    expect(off.seen[0].stdin).toContain(
      'do not run commands, read files or search the web'
    );
    const on = fakeRunner();
    await createCodexProviderAdapter(on.runner).generateText({
      ...setupRequest(),
      webSearch: true,
    });
    expect(on.seen[0].args).toContain('web_search="live"');
    expect(on.seen[0].args).not.toContain('web_search="disabled"');
    expect(on.seen[0].stdin).toContain('what you find with web search');
  });

  it('refuses a model outside its catalog before starting a process', async () => {
    const { runner } = fakeRunner();
    await expect(
      createCodexProviderAdapter(runner).generateText(setupRequest('gpt-4o'))
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses an output limit that is not a positive whole number', async () => {
    const { runner } = fakeRunner();
    for (const maxOutputTokens of [0, -1, 1.5, Number.NaN]) {
      await expect(
        createCodexProviderAdapter(runner).generateText({
          ...setupRequest(),
          maxOutputTokens,
        })
      ).rejects.toMatchObject({ code: 'REQUEST_REJECTED' });
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('starts codex with its own small environment, never the server one', async () => {
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), {
          setEncoding: () => undefined,
        }),
        stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
        kill: () => true,
      });
      setImmediate(() =>
        child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
      );
      return child as unknown as childProcess.ChildProcess;
    });
    try {
      await expect(
        createCodexProviderAdapter().generateText(setupRequest())
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await expect(
        createCodexProviderAdapter().validateConnection()
      ).resolves.toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
      for (const [command, , options] of spawn.mock.calls) {
        expect(command).toBe('codex');
        expect(Object.keys(options?.env ?? {}).sort()).toEqual([
          'HOME',
          'PATH',
          'TMPDIR',
        ]);
      }
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      spawn.mockRestore();
    }
  });

  it('T5 maps a missing command, a timeout, a failed turn and an empty answer to provider codes', async () => {
    const cases: [Partial<ContentStudioCodexRun>, string][] = [
      [{ exitCode: null, stdout: '', missing: true }, 'PROVIDER_UNAVAILABLE'],
      [{ exitCode: null, stdout: '', timedOut: true }, 'TIMEOUT'],
      [
        {
          exitCode: 1,
          stdout: events({
            type: 'turn.failed',
            error: { message: "You've hit your usage limit." },
          }),
        },
        'RATE_LIMITED',
      ],
      [
        {
          exitCode: 1,
          stdout: events({ type: 'error', message: '401 Unauthorized' }),
        },
        'AUTH_FAILED',
      ],
      [{ exitCode: 1, stdout: 'not json' }, 'PROVIDER_UNAVAILABLE'],
      [
        { exitCode: 0, stdout: events({ type: 'turn.completed' }) },
        'INVALID_RESPONSE',
      ],
    ];
    for (const [overrides, code] of cases) {
      const { runner } = fakeRunner(run(overrides));
      await expect(
        createCodexProviderAdapter(runner).generateText(setupRequest())
      ).rejects.toMatchObject({ code });
    }
  });

  it('a provider error never carries what Codex said', async () => {
    const { runner } = fakeRunner(
      run({
        exitCode: 1,
        stdout: events({
          type: 'turn.failed',
          error: { message: 'secret-detail usage limit' },
        }),
      })
    );
    const err = await createCodexProviderAdapter(runner)
      .generateText(setupRequest())
      .catch((e) => e);
    expect(JSON.stringify(err)).not.toContain('secret-detail');
    expect(err.message).not.toContain('secret-detail');
  });

  it('T4 an answer that is not a setup proposal fails the strict parser', async () => {
    const { runner } = fakeRunner();
    const { text } = await createCodexProviderAdapter(runner).generateText(
      setupRequest()
    );
    expect(() => parseContentStudioAISetupProposal(text, 'nl')).toThrow();
  });

  it('tests the connection with codex login status, generating nothing', async () => {
    const ok = fakeRunner(run({ stdout: 'Logged in' }));
    await expect(
      createCodexProviderAdapter(ok.runner).validateConnection('gpt-6.1-sol')
    ).resolves.toEqual({ ok: true });
    expect(ok.seen[0].args).toEqual(['login', 'status']);
    for (const [overrides, code] of [
      [{ exitCode: 1 }, 'AUTH_FAILED'],
      [{ exitCode: null, missing: true }, 'PROVIDER_UNAVAILABLE'],
      [{ exitCode: null, timedOut: true }, 'PROVIDER_UNAVAILABLE'],
    ] as [Partial<ContentStudioCodexRun>, string][]) {
      const { runner } = fakeRunner(run(overrides));
      await expect(
        createCodexProviderAdapter(runner).validateConnection()
      ).resolves.toEqual({ ok: false, code });
    }
  });
});

// T7: one real request, through the real setup prompt and the strict parser
const realTest =
  process.env.CONTENT_STUDIO_CODEX_REAL_TEST === '1' ? it : it.skip;

describe('Codex adapter: real model (opt-in)', () => {
  realTest(
    'drafts a Dutch setup proposal from the semantic test input',
    async () => {
      const started = Date.now();
      const result = await createCodexProviderAdapter().generateText(
        setupRequest()
      );
      const proposal = parseContentStudioAISetupProposal(
        result.text,
        SEMANTIC_INPUT.language
      );
      expect(proposal.brand.tagline).toBe(SEMANTIC_INPUT.tagline);
      expect(proposal.audiences.length).toBeGreaterThanOrEqual(1);
      // for the developer's semantic review
      console.log(
        JSON.stringify(
          { latencyMs: Date.now() - started, usage: result.usage, proposal },
          null,
          2
        )
      );
    },
    180_000
  );
});

// Activation flow 01: one real first post (research with web search, then
// the draft) and one refined research, through the real prompts and the
// strict parsers. Opt-in like the test above; nothing is stored
describe('Codex adapter: real first post (opt-in)', () => {
  const profile = {
    language: 'nl',
    today: new Date().toISOString().slice(0, 10),
    brand: {
      name: SEMANTIC_INPUT.companyName,
      tagline: SEMANTIC_INPUT.tagline as string,
      description: SEMANTIC_INPUT.description,
    },
    context: {
      writing: null,
      editorialPolicy: parseContentStudioEditorialPolicyContent({
        schemaVersion: 1,
        principles: ['Toon expertise met concrete uitleg'],
        prohibitedTopics: [],
        claimRules: ['Geen cijfers of klanten verzinnen'],
        ctaRules: ['Nodig uit tot een gesprek over de eigen situatie'],
        formatConventions: [],
        complianceNotes: '',
      }),
      audience: {
        schemaVersion: 1 as const,
        description: SEMANTIC_INPUT.audience as string,
        role: 'Eigenaar of marketingverantwoordelijke',
        knowledgeLevel: 'beginner' as const,
        goals: ['Meer resultaat uit website en marketing'],
        painPoints: ['Te veel handmatig werk'],
        objections: [],
        preferredTone: null,
        locale: 'nl',
      },
      expertise: {
        schemaVersion: 1 as const,
        subjects: [
          'Websites voor mkb',
          'Automatiseren van handmatig werk',
          'Praktische AI',
        ],
        differentiators: [],
        stances: [],
        frameworks: [],
        evidenceExpectations: '',
        avoidTopics: [],
        confidenceBoundaries: '',
      },
    },
    findings: [],
    webSearch: true,
  };
  const ask = async (
    prompt: { system: string; prompt: string },
    schema: { name: string; schema: Record<string, unknown> },
    webSearch: boolean
  ) => {
    const started = Date.now();
    const result = await createCodexProviderAdapter().generateText({
      model: 'gpt-6.1-sol',
      system: prompt.system,
      prompt: prompt.prompt,
      output: { type: 'json', schemaName: schema.name, schema: schema.schema },
      maxOutputTokens: 4096,
      timeoutMs: 180_000,
      ...(webSearch ? { webSearch: true } : {}),
    });
    return { result, latencyMs: Date.now() - started };
  };

  realTest(
    'researches a current topic with sources and drafts a Dutch post from it; refined research finds another',
    async () => {
      const research = await ask(
        buildContentStudioAIFirstPostResearchPrompt({
          ...profile,
          preferences: null,
          previousTopics: [],
        }),
        {
          name: CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA_NAME,
          schema: CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA,
        },
        true
      );
      const found = parseContentStudioFirstPostResearch(
        research.result.text,
        profile
      );
      const draft = await ask(
        buildContentStudioAIFirstPostDraftPrompt({
          ...profile,
          research: found,
        }),
        {
          name: CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA_NAME,
          schema: CONTENT_STUDIO_AI_FIRST_POST_DRAFT_SCHEMA,
        },
        false
      );
      const post = parseContentStudioFirstPostDraft(draft.result.text, found);
      expect(post.text.length).toBeGreaterThan(200);
      // refined: other preferences, steering away from the first subject
      const refined = await ask(
        buildContentStudioAIFirstPostResearchPrompt({
          ...profile,
          preferences: {
            lookFor: [
              'Nieuwe Europese regels voor AI en websites (AI Act, toegankelijkheid)',
            ],
            avoid: ['Algemeen AI-nieuws van grote techbedrijven'],
            freshness: 'month',
            angles: ['practical', 'myth_busting'],
          },
          previousTopics: [found.topic],
        }),
        {
          name: CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA_NAME,
          schema: CONTENT_STUDIO_AI_FIRST_POST_RESEARCH_SCHEMA,
        },
        true
      );
      const second = parseContentStudioFirstPostResearch(
        refined.result.text,
        profile
      );
      // for the developer's review: what was found, not the whole post
      console.log(
        JSON.stringify(
          {
            research: {
              latencyMs: research.latencyMs,
              usage: research.result.usage,
              topic: found.topic,
              angle: found.angle,
              why: found.why,
              sourceBacked: found.sourceBacked,
              sources: found.sources.map((s) => ({
                host: new URL(s.url).host,
                publishedAt: s.publishedAt,
                origin: s.origin,
              })),
            },
            draft: {
              latencyMs: draft.latencyMs,
              usage: draft.result.usage,
              characters: post.text.length,
              opening: post.text.slice(0, 160),
              addresses: post.text.match(/https?:\/\/\S+/g) ?? [],
            },
            refined: {
              latencyMs: refined.latencyMs,
              usage: refined.result.usage,
              topic: second.topic,
              angle: second.angle,
              sourceBacked: second.sourceBacked,
              sources: second.sources.map((s) => ({
                host: new URL(s.url).host,
                publishedAt: s.publishedAt,
              })),
            },
          },
          null,
          2
        )
      );
    },
    600_000
  );
});
