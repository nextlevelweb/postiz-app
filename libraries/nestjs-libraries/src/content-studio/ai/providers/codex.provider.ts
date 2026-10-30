import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { getContentStudioAIModel } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIProviderAdapter,
  ContentStudioAIProviderErrorCode,
  ContentStudioAITextRequest,
  ContentStudioAITextResult,
  ContentStudioAITextUsage,
  contentStudioAIRequestTimeout,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// The Codex CLI as signed in on the server (`codex login`, with ChatGPT or an
// API key), run in its documented non-interactive mode, `codex exec`
// (https://learn.chatgpt.com/docs/non-interactive-mode): the prompt goes in on
// stdin and the answer comes back as JSON Lines events. Codex reads its own
// sign-in; no key or token passes through Content Studio. Every run gets an
// empty temporary folder, the read-only sandbox, none of the server user's
// Codex config and only the environment below: never the server's own
// variables, and for any command the model would run, none at all

const CODEX_COMMAND = 'codex';
// One attempt per request; a whole answer takes Codex longer than an API
// call, so the default is 60 seconds
const CODEX_TIMEOUT_MS = 60_000;
const CODEX_STATUS_TIMEOUT_MS = 15_000;
// after SIGTERM, the time Codex gets to stop before SIGKILL
const CODEX_KILL_GRACE_MS = 5_000;
// more than any answer Content Studio asks for
const CODEX_OUTPUT_MAX_CHARS = 2_000_000;

// Where Codex finds its sign-in (HOME), node and itself (PATH, the running
// node's folder first) and a temporary folder
const codexEnvironment = () => ({
  HOME: homedir(),
  PATH: [
    path.dirname(process.execPath),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ].join(path.delimiter),
  TMPDIR: tmpdir(),
});

export interface ContentStudioCodexRun {
  // null when the process could not start or was stopped
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  // the codex command is not installed on this server
  missing: boolean;
}

// The process runner, replaceable in tests so no process is started
export type ContentStudioCodexRunner = (
  args: string[],
  options: { stdin: string; cwd?: string; timeoutMs: number }
) => Promise<ContentStudioCodexRun>;

const runCodex: ContentStudioCodexRunner = (args, options) =>
  new Promise((resolve) => {
    const child = spawn(CODEX_COMMAND, args, {
      cwd: options.cwd,
      env: codexEnvironment(),
      // Codex's own progress and diagnostics are never read or logged
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (!killer) {
        child.kill('SIGTERM');
        killer = setTimeout(() => child.kill('SIGKILL'), CODEX_KILL_GRACE_MS);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > CODEX_OUTPUT_MAX_CHARS) {
        stop();
        return;
      }
      stdout += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({
        exitCode: null,
        stdout: '',
        timedOut,
        missing: err.code === 'ENOENT',
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ exitCode, stdout, timedOut, missing: false });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin);
  });

// A failed turn's message, read only to pick a code; it is never kept
const codeForFailure = (message: string): ContentStudioAIProviderErrorCode => {
  if (/usage limit|rate limit|too many requests|\b429\b/i.test(message)) {
    return 'RATE_LIMITED';
  }
  if (/quota|credit|billing/i.test(message)) {
    return 'QUOTA_EXCEEDED';
  }
  if (/unauthori[sz]ed|log ?in|sign ?in|\b401\b|\b403\b/i.test(message)) {
    return 'AUTH_FAILED';
  }
  if (
    /model/i.test(message) &&
    /not (found|supported|available)/i.test(message)
  ) {
    return 'MODEL_UNAVAILABLE';
  }
  return 'PROVIDER_UNAVAILABLE';
};

const tokenCount = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;

// turn.completed usage as Codex reported it
const toUsage = (usage: unknown): ContentStudioAITextUsage | null => {
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const value = usage as Record<string, unknown>;
  const counts: ContentStudioAITextUsage = {
    inputTokens: tokenCount(value.input_tokens),
    cachedInputTokens: tokenCount(value.cached_input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    reasoningTokens: tokenCount(value.reasoning_output_tokens),
  };
  const reported = Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count !== undefined)
  );
  return Object.keys(reported).length ? reported : null;
};

const parseEvent = (line: string): Record<string, unknown> | null => {
  try {
    const event = JSON.parse(line);
    return typeof event === 'object' && event !== null ? event : null;
  } catch {
    return null;
  }
};

// The last agent message and the turn's usage, or the failure as a code
export function toContentStudioCodexResult(
  run: ContentStudioCodexRun
): ContentStudioAITextResult {
  if (run.missing) {
    throw new ContentStudioAIProviderError('PROVIDER_UNAVAILABLE');
  }
  if (run.timedOut) {
    throw new ContentStudioAIProviderError('TIMEOUT');
  }
  let text: string | undefined;
  let usage: ContentStudioAITextUsage | null = null;
  let failure: string | undefined;
  for (const line of run.stdout.split('\n')) {
    const event = parseEvent(line);
    const item = event?.item as { type?: unknown; text?: unknown } | undefined;
    if (
      event?.type === 'item.completed' &&
      item?.type === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      text = item.text;
    } else if (event?.type === 'turn.completed') {
      usage = toUsage(event.usage);
    } else if (event?.type === 'turn.failed' || event?.type === 'error') {
      const error = event.error as { message?: unknown } | undefined;
      failure = String(error?.message ?? event.message ?? '');
    }
  }
  if (failure !== undefined && text === undefined) {
    throw new ContentStudioAIProviderError(codeForFailure(failure));
  }
  if (run.exitCode !== 0 || text === undefined) {
    throw new ContentStudioAIProviderError(
      run.exitCode === 0 ? 'INVALID_RESPONSE' : 'PROVIDER_UNAVAILABLE'
    );
  }
  // Codex reports no finish reason: a cut-off answer fails the parser instead
  return { text, finishReason: 'stop', usage };
}

// Codex has no separate system message in exec mode, so the rules come first
// in the one prompt it reads
const codexPrompt = (request: ContentStudioAITextRequest) =>
  [
    request.system,
    request.webSearch
      ? 'Answer from this message and what you find with web search: do not run commands or read files.'
      : 'Answer from this message alone: do not run commands, read files or search the web.',
    request.prompt,
  ].join('\n\n');

// A Codex connection. There is no key: each call starts its own codex
// process and nothing is kept between calls
export function createCodexProviderAdapter(
  runner: ContentStudioCodexRunner = runCodex
): ContentStudioAIProviderAdapter {
  return {
    provider: 'codex',
    // Codex's own sign-in check; nothing is generated, and a model cannot
    // be checked without generating
    async validateConnection() {
      const run = await runner(['login', 'status'], {
        stdin: '',
        timeoutMs: CODEX_STATUS_TIMEOUT_MS,
      });
      if (run.exitCode === 0) {
        return { ok: true };
      }
      return {
        ok: false,
        code:
          run.missing || run.timedOut ? 'PROVIDER_UNAVAILABLE' : 'AUTH_FAILED',
      };
    },
    async generateText(request) {
      const model = getContentStudioAIModel('codex', request.model);
      if (!model) {
        throw new ContentStudioAIProviderError('MODEL_UNAVAILABLE');
      }
      // Codex takes no output limit or temperature: the length is up to the
      // prompt, and the answer is checked by the caller's parser
      if (
        !Number.isSafeInteger(request.maxOutputTokens) ||
        request.maxOutputTokens < 1 ||
        (request.output.type === 'json' && !model.capabilities.structuredOutput)
      ) {
        throw new ContentStudioAIProviderError('REQUEST_REJECTED');
      }
      const folder = await mkdtemp(
        path.join(tmpdir(), 'content-studio-codex-')
      );
      try {
        const args = [
          'exec',
          '--json',
          '--ephemeral',
          '--skip-git-repo-check',
          '--ignore-user-config',
          '--sandbox',
          'read-only',
          '-c',
          'shell_environment_policy.inherit="none"',
          // Codex's own web search: live only when the request asks for it
          // (a model with the webSearch capability), otherwise off
          '-c',
          request.webSearch ? 'web_search="live"' : 'web_search="disabled"',
          '-m',
          model.id,
        ];
        if (request.output.type === 'json') {
          const schema = path.join(folder, 'schema.json');
          await writeFile(schema, JSON.stringify(request.output.schema));
          args.push('--output-schema', schema);
        }
        args.push('-');
        return toContentStudioCodexResult(
          await runner(args, {
            stdin: codexPrompt(request),
            cwd: folder,
            timeoutMs: contentStudioAIRequestTimeout(request, CODEX_TIMEOUT_MS),
          })
        );
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
