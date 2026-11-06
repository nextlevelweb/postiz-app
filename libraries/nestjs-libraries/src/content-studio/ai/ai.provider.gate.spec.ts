import fs from 'fs';
import path from 'path';
import {
  ContentStudioAIProviderGate,
  contentStudioCodexEnabled,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.gate';
import { listContentStudioAIProviders } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

describe('Content Studio AI provider gate', () => {
  it('CG7 switches Codex on for exactly "true": unset, empty and every other value leave it off', () => {
    expect(contentStudioCodexEnabled('true')).toBe(true);
    for (const value of [
      undefined,
      '',
      'false',
      'TRUE',
      'True',
      '1',
      'yes',
      'on',
      ' true',
    ]) {
      expect(contentStudioCodexEnabled(value)).toBe(false);
    }
  });

  it('CG8 offers every other catalog provider either way, in catalog order', () => {
    const off = new ContentStudioAIProviderGate({ codex: false });
    const on = new ContentStudioAIProviderGate({ codex: true });
    expect(off.listProviders().map((p) => p.provider)).toEqual([
      'openai',
      'openrouter',
      'anthropic',
    ]);
    expect(on.listProviders()).toEqual(listContentStudioAIProviders());
    for (const gate of [off, on]) {
      for (const provider of ['openai', 'openrouter', 'anthropic']) {
        expect(gate.isEnabled(provider)).toBe(true);
      }
      for (const value of ['gemini', '', null, undefined, 1, {}]) {
        expect(gate.isEnabled(value)).toBe(false);
      }
    }
    expect(off.isEnabled('codex')).toBe(false);
    expect(on.isEnabled('codex')).toBe(true);
  });

  it('CG9 the server reads CONTENT_STUDIO_ENABLE_CODEX once, in the database module, never NODE_ENV', () => {
    const module = fs.readFileSync(
      path.join(__dirname, '../../database/prisma/database.module.ts'),
      'utf8'
    );
    expect(module).toContain(
      'contentStudioCodexEnabled(\n            process.env.CONTENT_STUDIO_ENABLE_CODEX\n          )'
    );
    const gate = fs.readFileSync(
      path.join(__dirname, 'ai.provider.gate.ts'),
      'utf8'
    );
    expect(gate).not.toMatch(/process\.env|NODE_ENV/);
    const example = fs.readFileSync(
      path.join(__dirname, '../../../../../.env.example'),
      'utf8'
    );
    expect(example).toMatch(/^#CONTENT_STUDIO_ENABLE_CODEX="false"$/m);
  });
});
