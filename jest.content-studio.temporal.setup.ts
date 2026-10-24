import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bundleWorkflowCode } from '@temporalio/worker';

// Global setup of the Content Studio Temporal integration suite (P8-C2): the
// feed workflows bundled from their source, outside the test sandbox (where
// webpack's loaders cannot run), into a temporary file the suite reads. On a
// server the orchestrator bundles its built files, where the @gitroom
// aliases are already resolved; here webpack resolves them, and uses the
// Temporal SDK's own TypeScript settings rather than apps/orchestrator/.swcrc
export const CONTENT_STUDIO_TEMPORAL_BUNDLE_ENV =
  'CONTENT_STUDIO_TEMPORAL_WORKFLOW_BUNDLE';

const silent = (): void => undefined;

export default async function setup() {
  const bundle = await bundleWorkflowCode({
    workflowsPath: join(
      __dirname,
      'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts'
    ),
    webpackConfigHook: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...(config.resolve?.alias as Record<string, string>),
          '@gitroom/nestjs-libraries': join(
            __dirname,
            'libraries/nestjs-libraries/src'
          ),
          '@gitroom/orchestrator': join(__dirname, 'apps/orchestrator/src'),
        },
      },
      module: {
        ...config.module,
        rules: config.module!.rules!.map((rule) =>
          rule &&
          typeof rule === 'object' &&
          typeof rule.use === 'object' &&
          !Array.isArray(rule.use) &&
          String(rule.use.loader).includes('swc-loader')
            ? {
                ...rule,
                use: {
                  ...rule.use,
                  options: {
                    ...(rule.use.options as Record<string, unknown>),
                    swcrc: false,
                  },
                },
              }
            : rule
        ),
      },
    }),
    logger: {
      log: silent,
      trace: silent,
      debug: silent,
      info: silent,
      warn: silent,
      error: silent,
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'content-studio-p8c2-'));
  const file = join(dir, 'workflow-bundle.js');
  writeFileSync(file, bundle.code);
  process.env[CONTENT_STUDIO_TEMPORAL_BUNDLE_ENV] = file;
}

export function teardown() {
  const file = process.env[CONTENT_STUDIO_TEMPORAL_BUNDLE_ENV];
  if (file) {
    rmSync(join(file, '..'), { recursive: true, force: true });
  }
}
