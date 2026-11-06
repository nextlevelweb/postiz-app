import fs from 'fs';
import path from 'path';

// Sentry's own AI integrations record prompts and outputs only when asked
// (recordInputs/recordOutputs, or sendDefaultPii): the server never asks
const mockInit = jest.fn();
const mockOpenAI = jest.fn((options: unknown) => ({
  name: 'OpenAI',
  options,
}));
jest.mock('@sentry/nestjs', () => ({
  init: (options: unknown) => mockInit(options),
  openAIIntegration: (options: unknown) => mockOpenAI(options),
  consoleLoggingIntegration: () => ({ name: 'Console' }),
  setUser: jest.fn(),
  setTag: jest.fn(),
}));
jest.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: () => ({ name: 'Profiling' }),
}));

const { initializeSentry } = require('./initialize.sentry');

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
afterEach(() => {
  if (DSN === undefined) {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  } else {
    process.env.NEXT_PUBLIC_SENTRY_DSN = DSN;
  }
  mockInit.mockClear();
  mockOpenAI.mockClear();
});

describe('initializeSentry AI privacy', () => {
  it('SP1 records no AI prompt or output and no default PII once a DSN is set', () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@sentry.example/1';
    expect(initializeSentry('backend', true)).toBe(true);
    expect(mockOpenAI.mock.calls).toEqual([
      [{ recordInputs: false, recordOutputs: false }],
    ]);
    const [[options]] = mockInit.mock.calls as [[Record<string, unknown>]];
    expect(options.sendDefaultPii).not.toBe(true);
  });

  it('SP2 starts nothing without a DSN', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(initializeSentry('backend', true)).toBeNull();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('SP3 no server code asks Sentry to record AI inputs or outputs', () => {
    const roots = [
      'libraries/nestjs-libraries/src',
      'apps/backend/src',
      'apps/orchestrator/src',
    ];
    const repo = path.join(__dirname, '../../../..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist'].includes(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          /\.ts$/.test(entry.name) &&
          !/\.spec\.ts$/.test(entry.name)
        ) {
          if (
            /record(Inputs|Outputs)\s*:\s*true/.test(
              fs.readFileSync(full, 'utf8')
            )
          ) {
            hits.push(path.relative(repo, full));
          }
        }
      }
    };
    roots.forEach((root) => walk(path.join(repo, root)));
    expect(hits).toEqual([]);
  });

  it('SP4 the AI image prompt, a provider login and generated subtitles are not printed', () => {
    const read = (file: string) =>
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(read('database/prisma/media/media.service.ts')).not.toMatch(
      /console\.log\('Prompt:'/
    );
    expect(read('integrations/social/listmonk.provider.ts')).not.toMatch(
      /console\.log\(body\)/
    );
    expect(read('videos/images-slides/images.slides.ts')).not.toMatch(
      /console\.log\(split\)/
    );
  });
});
