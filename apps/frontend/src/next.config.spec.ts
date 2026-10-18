import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// allowedDevOrigins of the frontend Next config: localhost and 127.0.0.1
// always, plus the hostnames in POSTIZ_ALLOWED_DEV_ORIGINS. The real config
// is loaded by Node itself (it is an ES module), once per value, in one child
// process; the rest of the config must come through unchanged. Local env files
// are only ever checked by path through Git, never read

// this spec lives in apps/frontend/src; the config in apps/frontend
const FRONTEND = join(__dirname, '..');
const ROOT = join(__dirname, '../../..');
const CONFIG = readFileSync(join(FRONTEND, 'next.config.js'), 'utf8');

type Loaded = {
  origins: string[];
  keys: string[];
  headers: number;
  redirects: number;
  rewrites: number;
};

// each value is a fresh module instance (?case=n), with its own environment
const load = (values: Array<string | null>): Loaded[] => {
  const script = `
    const values = JSON.parse(process.env.DEV_ORIGIN_CASES);
    const out = [];
    for (const [i, value] of values.entries()) {
      if (value === null) delete process.env.POSTIZ_ALLOWED_DEV_ORIGINS;
      else process.env.POSTIZ_ALLOWED_DEV_ORIGINS = value;
      const config = (await import('./next.config.js?case=' + i)).default;
      out.push({
        origins: config.allowedDevOrigins,
        keys: Object.keys(config).sort(),
        headers: (await config.headers()).length,
        redirects: (await config.redirects()).length,
        rewrites: (await config.rewrites()).length,
      });
    }
    console.log('RESULT ' + JSON.stringify(out));
  `;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEV_ORIGIN_CASES: JSON.stringify(values),
  };
  delete env.POSTIZ_ALLOWED_DEV_ORIGINS;
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: FRONTEND, env, encoding: 'utf8', timeout: 60_000 }
  );
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  return JSON.parse((line as string).slice('RESULT '.length));
};

const git = (args: string[]) => {
  try {
    return {
      code: 0,
      out: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }),
    };
  } catch (err) {
    return { code: (err as { status: number }).status, out: '' };
  }
};

describe('Next config: allowed development origins', () => {
  let results: Loaded[];
  beforeAll(() => {
    results = load([
      null,
      '',
      'lan-host.local',
      '10.0.0.5,dev-box',
      ' 10.0.0.5,dev-box,10.0.0.5 ,, ',
      'LOCALHOST, 127.0.0.1 ,Dev-Box',
      '*.example.test,http://10.0.0.6:4200,10.0.0.7:4200,10.0.0.8/path,ok-host',
    ]);
  }, 60_000);

  it('DEVORIGIN1/DEVORIGIN2/DEVORIGIN3 without the variable (or empty) only localhost and 127.0.0.1', () => {
    expect(results[0].origins).toEqual(['localhost', '127.0.0.1']);
    expect(results[1].origins).toEqual(['localhost', '127.0.0.1']);
  });

  it('DEVORIGIN4/DEVORIGIN5 one or several hostnames are appended, in order', () => {
    expect(results[2].origins).toEqual([
      'localhost',
      '127.0.0.1',
      'lan-host.local',
    ]);
    expect(results[3].origins).toEqual([
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      'dev-box',
    ]);
  });

  it('DEVORIGIN6/DEVORIGIN7/DEVORIGIN8 entries are trimmed, empty ones dropped, each kept once (case-insensitively)', () => {
    expect(results[4].origins).toEqual([
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      'dev-box',
    ]);
    expect(results[5].origins).toEqual(['localhost', '127.0.0.1', 'dev-box']);
  });

  it('DEVORIGIN9 no wildcards, schemes, ports or paths: Next would treat them as patterns or never match them', () => {
    expect(results[6].origins).toEqual(['localhost', '127.0.0.1', 'ok-host']);
  });

  it('the rest of the config is unchanged: same keys, headers, redirects and rewrites, still wrapped by Sentry', () => {
    for (const result of results) {
      expect(result.keys).toEqual([
        'allowedDevOrigins',
        'env',
        'experimental',
        'headers',
        'productionBrowserSourceMaps',
        'reactStrictMode',
        'redirects',
        'rewrites',
        'serverExternalPackages',
        'transpilePackages',
        'webpack',
      ]);
      expect([result.headers, result.redirects, result.rewrites]).toEqual([
        1, 1, 1,
      ]);
    }
    expect(CONFIG).toContain('export default withSentryConfig(nextConfig, {');
    // the only source of extra hosts; nothing probes the network or runs a command
    expect(
      CONFIG.match(/process\.env\.POSTIZ_ALLOWED_DEV_ORIGINS/g)
    ).toHaveLength(1);
    expect(CONFIG).not.toMatch(
      /networkInterfaces|child_process|execSync|from 'os'|from 'node:os'/
    );
  });

  it('DEVORIGIN10 no workstation address is committed in the config or the env example', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const text of [CONFIG, example]) {
      expect(text).not.toMatch(
        /192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/
      );
    }
    expect(example).toMatch(/^POSTIZ_ALLOWED_DEV_ORIGINS=""$/m);
  });

  it('DEVORIGIN11/DEVORIGIN12 .env.example stays tracked and unignored; local env files and backups are ignored', () => {
    expect(git(['ls-files', '--error-unmatch', '.env.example']).code).toBe(0);
    expect(git(['check-ignore', '-q', '--no-index', '.env.example']).code).toBe(
      1
    );
    for (const path of [
      '.env',
      '.env.content-studio.backup',
      '.env.local',
      'apps/frontend/.env.backup',
    ]) {
      expect([
        path,
        git(['check-ignore', '-q', '--no-index', path]).code,
      ]).toEqual([path, 0]);
    }
    // the config is tracked normally again: no skip-worktree or assume-unchanged
    expect(git(['ls-files', '-v', 'apps/frontend/next.config.js']).out).toMatch(
      /^H apps\/frontend\/next\.config\.js$/m
    );
  });
});
