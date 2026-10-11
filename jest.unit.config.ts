import { readFileSync } from 'fs';
import { join } from 'path';
import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';

// Standalone unit tests, independent of the Nx based jest.config.ts.
// Runs `*.spec.ts(x)` files only, with no database, services or .env loading
const tsconfig = JSON.parse(
  readFileSync(join(__dirname, 'tsconfig.base.json'), 'utf8')
);

// Only the @gitroom/* aliases are mapped; the remaining entries point at type
// declarations and must keep resolving through node_modules at runtime
const gitroomPaths = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).filter(([alias]) =>
    alias.startsWith('@gitroom/')
  )
) as Record<string, string[]>;

type ProjectConfig = Exclude<NonNullable<Config['projects']>[number], string>;

const shared: ProjectConfig = {
  rootDir: __dirname,
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
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/\\.next/',
    '/e2e/',
    '\\.e2e\\.spec\\.tsx?$',
    '\\.integration\\.spec\\.tsx?$',
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/apps/.*/dist/'],
  clearMocks: true,
  restoreMocks: true,
};

const config: Config = {
  projects: [
    {
      ...shared,
      displayName: 'node',
      testEnvironment: 'node',
      roots: [
        '<rootDir>/libraries',
        '<rootDir>/apps/backend',
        '<rootDir>/apps/orchestrator',
      ],
      testMatch: ['**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'jsdom',
      testEnvironment: join(__dirname, 'jest.unit.jsdom.environment.js'),
      roots: ['<rootDir>/apps/frontend'],
      testMatch: ['**/*.spec.ts', '**/*.spec.tsx'],
    },
  ],
};

export default config;
