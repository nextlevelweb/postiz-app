import { readFileSync } from 'fs';
import { join } from 'path';
import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import { contentStudioPostgresUrlFromEnv } from './jest.content-studio.postgres.guard';

// The opt-in Content Studio PostgreSQL integration suite. It needs the
// disposable local database described in jest.content-studio.postgres.guard.ts
// and refuses to start without it:
//
//   CONTENT_STUDIO_POSTGRES_INTEGRATION_URL='postgresql://p211:p211_local_only@127.0.0.1:55433/postiz_content_studio_p211' \
//   node_modules/.bin/jest --config jest.content-studio.integration.config.ts --runInBand
//
// pnpm test:unit never runs it (jest.unit.config.ts ignores *.integration.spec.ts)
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
  displayName: 'content-studio-postgres',
  testEnvironment: 'node',
  roots: ['<rootDir>/libraries'],
  testMatch: ['**/*.postgres.integration.spec.ts'],
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
  // one worker: the tests share one database; concurrency is inside tests
  maxWorkers: 1,
  testTimeout: 30_000,
  clearMocks: true,
  restoreMocks: true,
};

export default config;
