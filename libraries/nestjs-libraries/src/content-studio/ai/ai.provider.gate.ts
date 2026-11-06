import {
  ContentStudioAIProvider,
  isContentStudioAIProvider,
  listContentStudioAIProviders,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

// The catalog providers this server offers. Codex runs the codex CLI under
// the server's own ChatGPT sign-in, which the release image does not ship,
// so it is offered only where an operator switched it on explicitly
// (CONTENT_STUDIO_ENABLE_CODEX=true, read by the database module and passed
// in: Content Studio reads no environment). Every other catalog provider is
// always offered. Checked when a connection is created and every time one is
// used, so a stored Codex connection cannot run while the gate is off; its
// code stays as it is
export class ContentStudioAIProviderGate {
  constructor(private readonly _options: { codex: boolean }) {}

  isEnabled(provider: unknown): provider is ContentStudioAIProvider {
    return (
      isContentStudioAIProvider(provider) &&
      (provider !== 'codex' || this._options.codex === true)
    );
  }

  // the catalog, in its order, without what is switched off
  listProviders() {
    return listContentStudioAIProviders().filter((info) =>
      this.isEnabled(info.provider)
    );
  }
}

// Exactly 'true' switches Codex on; unset, empty or anything else leaves it
// off (the convention of the other security-relevant opt-in flags)
export const contentStudioCodexEnabled = (value: string | undefined) =>
  value === 'true';
