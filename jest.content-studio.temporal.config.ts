import { readFileSync } from 'fs';
import { join } from 'path';
import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import { contentStudioPostgresUrlFromEnv } from './jest.content-studio.postgres.guard';
import { contentStudioTemporalAddressFromEnv } from './jest.content-studio.temporal.guard';

// The opt-in Content Studio Temporal integration suite (P8-C2): the feed
// capture workflows on a real Temporal server, with the orchestrator's own
// Workers, and the captures on the disposable PostgreSQL database. It needs
// both disposable servers described in jest.content-studio.temporal.guard.ts
// and jest.content-studio.postgres.guard.ts and refuses to start without them:
//
//   CONTENT_STUDIO_TEMPORAL_INTEGRATION_ADDRESS='127.0.0.1:57233' \
//   CONTENT_STUDIO_POSTGRES_INTEGRATION_URL='postgresql://p306:p306_local_only@127.0.0.1:55434/postiz_content_studio_p306' \
//   node_modules/.bin/jest --config jest.content-studio.temporal.config.ts --runInBand
//
// pnpm test:unit never runs it (jest.unit.config.ts ignores *.integration.spec.ts)
contentStudioTemporalAddressFromEnv();
contentStudioPostgresUrlFromEnv();

const tsconfig = JSON.parse(
  readFileSync(join(__dirname, 'tsconfig.base.json'), 'utf8')
);

const gitroomPaths = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).filter(([alias]) =>
    alias.startsWith('@gitroom/')
  )
) as Record<string, string[]>;

const config: Config = {
  rootDir: __dirname,
  displayName: 'content-studio-temporal',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/orchestrator'],
  testMatch: ['**/*.temporal.integration.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: join(__dirname, 'tsconfig.spec.json') },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: pathsToModuleNameMapper(gitroomPaths, {
    prefix: '<rootDir>/',
  }),
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/apps/.*/dist/'],
  // the feed workflows, bundled outside the test sandbox
  globalSetup: '<rootDir>/jest.content-studio.temporal.setup.ts',
  globalTeardown: '<rootDir>/jest.content-studio.temporal.teardown.ts',
  // one worker: the tests share one Temporal server and one database
  maxWorkers: 1,
  testTimeout: 120_000,
  clearMocks: true,
  restoreMocks: true,
};

export default config;
