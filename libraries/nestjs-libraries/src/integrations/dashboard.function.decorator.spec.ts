import fs from 'fs';
import path from 'path';
import {
  IntegrationManager,
  socialIntegrationList,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';

// ESM-only dependency of the Nostr provider, which jest cannot load
jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  finalizeEvent: jest.fn(),
  Relay: { connect: jest.fn() },
  SimplePool: class {},
}));

// POST /integrations/function runs a provider method by name with the
// channel's token (CVE-2026-115931). Only @Tool methods and the ones marked
// @DashboardFunction may run that way; internal helpers never can
const manager = new IntegrationManager();
const callable = (identifier: string, method: string) =>
  manager.isDashboardCallable(manager.getSocialIntegration(identifier), method);

// Every provider function the dashboard calls through
// useCustomProviderFunction, the continue-provider endpoints and the
// LinkedIn company lookup, keyed by the provider that serves it
const DASHBOARD_CALLS: Array<[string, string]> = [
  ['devto', 'organizations'],
  ['devto', 'tags'],
  ['discord', 'channels'],
  ['dribbble', 'teams'],
  ['facebook', 'pages'],
  ['gmb', 'pages'],
  ['hashnode', 'publications'],
  ['hashnode', 'tags'],
  ['instagram', 'audioSearch'],
  ['instagram', 'pages'],
  ['lemmy', 'subreddits'],
  ['linkedin', 'company'],
  ['linkedin-page', 'companies'],
  ['listmonk', 'list'],
  ['listmonk', 'templates'],
  ['medium', 'publications'],
  ['mewe', 'groups'],
  ['pinterest', 'boards'],
  ['reddit', 'restrictions'],
  ['reddit', 'subreddits'],
  ['skool', 'groups'],
  ['skool', 'label'],
  ['slack', 'channels'],
  ['tiktok-business', 'locationSearch'],
  ['tumblr', 'pages'],
  ['whop', 'companies'],
  ['wordpress', 'postTypes'],
  ['youtube', 'pages'],
];

const FRONTEND = path.resolve(__dirname, '../../../../apps/frontend/src');
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });

describe('DashboardFunction', () => {
  it('runs every provider function the dashboard calls', () => {
    const refused = DASHBOARD_CALLS.filter(
      ([identifier, method]) => !callable(identifier, method)
    );
    expect(refused).toEqual([]);
  });

  it('keeps the list in step with the frontend calls', () => {
    const called = new Set<string>();
    sources(FRONTEND).forEach((file) => {
      const code = fs.readFileSync(file, 'utf8');
      const patterns = [
        /\b(?:customFunc|func|call)\.get\(\s*'([a-zA-Z]+)'/g,
        /\bendpoint: '([a-zA-Z]+)'/g,
        /fetch\('\/integrations\/function'[\s\S]{0,200}?name: '([a-zA-Z]+)'/g,
      ];
      patterns.forEach((pattern) => {
        for (const match of code.matchAll(pattern)) {
          called.add(match[1]);
        }
      });
    });

    const listed = new Set(DASHBOARD_CALLS.map(([, method]) => method));
    expect([...called].filter((method) => !listed.has(method))).toEqual([]);
  });

  it('runs mention, which /integrations/mentions always asks for', () => {
    expect(callable('linkedin', 'mention')).toBe(true);
    expect(callable('x', 'mention')).toBe(true);
  });

  it('refuses internal helpers and unknown names on every provider', () => {
    const helpers = [
      'readOrFetch',
      'mediaSize',
      'localMediaPath',
      'fetch',
      'refreshToken',
      'authenticate',
      'post',
      'constructor',
      'toString',
      '__proto__',
      'doesNotExist',
    ];
    const allowed = socialIntegrationList.flatMap(({ identifier }) =>
      helpers
        .filter((method) => callable(identifier, method))
        .map((method) => `${identifier}.${method}`)
    );
    expect(allowed).toEqual([]);
  });

  it('runs the @Tool methods the public API and MCP may run', () => {
    const tools = manager.getAllTools();
    const refused = Object.entries(tools).flatMap(([identifier, list]) =>
      list
        .filter(({ methodName }) => !callable(identifier, methodName))
        .map(({ methodName }) => `${identifier}.${methodName}`)
    );
    expect(Object.keys(tools).length).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });
});
