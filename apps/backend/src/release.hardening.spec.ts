import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';

// Release safety of the image, pinned on the files that make it: which tags
// publish an image and which may move :latest (build-containers.yml), what
// the build context may hold (.dockerignore) and what the image runs before
// the apps start (the pm2-run chain in package.json). The tag rules and the
// start chain are run for real: the workflow's own validation script in
// bash, the start chain in sh with pnpm and pm2 stubbed. Destructive schema
// pushes failing closed is proven against PostgreSQL by the release gate
const REPO_ROOT = path.resolve(__dirname, '../../..');
const raw = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  shell?: string;
  run?: string;
};
type Job = {
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps: Step[];
};
const WORKFLOW_FILE = '.github/workflows/build-containers.yml';
const workflow = parse(raw(WORKFLOW_FILE)) as {
  on: {
    push: { tags: string[]; branches?: string[] };
    workflow_dispatch: {
      inputs: Record<
        string,
        { required: boolean; type: string; default?: unknown }
      >;
    };
  };
  jobs: Record<string, Job>;
};
const job = (name: string) => workflow.jobs[name];
const step = (jobName: string, stepName: string) => {
  const found = job(jobName).steps.find((s) => s.name === stepName);
  if (!found) throw new Error(`${jobName}: no step ${stepName}`);
  return found;
};
const VERSION = step('build-containers-common', 'Get Container Version');

// the workflow's validation step, run as GitHub runs a `shell: bash` step
type Resolved = { code: number; outputs: Record<string, string>; out: string };
const resolveTag = (input: {
  event: 'push' | 'workflow_dispatch';
  ref: string;
  tag?: string;
  latest?: string;
}): Resolved => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'));
  try {
    const script = path.join(dir, 'step.sh');
    const output = path.join(dir, 'output');
    fs.writeFileSync(script, VERSION.run!);
    fs.writeFileSync(output, '');
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', script],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          EVENT_NAME: input.event,
          REF_NAME: input.ref,
          // GitHub renders a missing input as an empty string
          INPUT_TAG: input.tag ?? '',
          INPUT_LATEST: input.latest ?? '',
        },
      }
    );
    const outputs = Object.fromEntries(
      fs
        .readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ])
    );
    return {
      code: result.status ?? -1,
      outputs,
      out: `${result.stdout}${result.stderr}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const pushed = (ref: string) => resolveTag({ event: 'push', ref });
const dispatched = (tag: string, latest = 'false', ref = 'main') =>
  resolveTag({ event: 'workflow_dispatch', ref, tag, latest });

// GitHub's filter glob for tags: `*` is any run of characters but `/`
const tagFilterMatches = (tag: string) =>
  workflow.on.push.tags.some((glob) =>
    new RegExp(
      `^${glob
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')}$`
    ).test(tag)
  );

describe('image tags and :latest (build-containers.yml)', () => {
  it('W1/W2 only nlw-* tags start a build; upstream tags never do', () => {
    expect(workflow.on.push).toEqual({ tags: ['nlw-*'] });
    for (const tag of ['v2.25.0', 'v1.0.0', 'latest', 'main', 'release-1']) {
      expect([tag, tagFilterMatches(tag)]).toEqual([tag, false]);
    }
    for (const tag of [
      'nlw-v1.1.0',
      'nlw-v1.1.0-rc.1',
      'nlw-mobile-polish-pre-v2.25',
    ]) {
      expect([tag, tagFilterMatches(tag)]).toEqual([tag, true]);
    }
    // and an upstream tag that reaches the script anyway publishes nothing
    const upstream = pushed('v2.25.0');
    expect(upstream.code).not.toBe(0);
    expect(upstream.outputs).toEqual({});
  });

  it('W8 a stable nlw-vX.Y.Z tag publishes its exact tag and moves :latest', () => {
    for (const tag of ['nlw-v1.1.0', 'nlw-v1.0.2', 'nlw-v10.20.30']) {
      expect([tag, pushed(tag)]).toMatchObject([
        tag,
        { code: 0, outputs: { containerver: tag, latest: 'true' } },
      ]);
    }
  });

  it('W3/W4 pre-release and snapshot tags publish their exact tag only', () => {
    for (const tag of [
      'nlw-v1.1.0-rc.1',
      'nlw-v1.1.0-rc1',
      'nlw-v1.1.0.1',
      'nlw-v1.1',
      'nlw-v1x1x0',
      'nlw-pre-foo',
      'nlw-mobile-polish-pre-v2.25',
      'nlw-pre-cleanup-main-2026-10-09',
      'nlw-1.1.0',
      'nlw-V1.1.0',
    ]) {
      expect([tag, pushed(tag)]).toMatchObject([
        tag,
        { code: 0, outputs: { containerver: tag, latest: 'false' } },
      ]);
    }
  });

  it('W5 a manual run names its tag and never moves :latest by default', () => {
    expect(workflow.on.workflow_dispatch.inputs).toEqual({
      tag: expect.objectContaining({ required: true, type: 'string' }),
      latest: expect.objectContaining({
        required: false,
        type: 'boolean',
        default: false,
      }),
    });
    expect(dispatched('nlw-v1.1.0')).toMatchObject({
      code: 0,
      outputs: { containerver: 'nlw-v1.1.0', latest: 'false' },
    });
    // an empty or unexpected value is no
    for (const latest of ['', 'yes', 'TRUE', '1']) {
      expect([latest, dispatched('nlw-v1.1.0', latest).outputs]).toEqual([
        latest,
        { containerver: 'nlw-v1.1.0', latest: 'false' },
      ]);
    }
    expect(dispatched('nlw-v1.1.0', 'true')).toMatchObject({
      code: 0,
      outputs: { containerver: 'nlw-v1.1.0', latest: 'true' },
    });
  });

  it('W4 a manual run cannot move :latest to a pre-release or snapshot tag', () => {
    for (const tag of ['nlw-v1.1.0-rc.1', 'nlw-pre-foo']) {
      const result = dispatched(tag, 'true');
      expect([tag, result.code === 0, result.outputs]).toEqual([
        tag,
        false,
        {},
      ]);
      expect(result.out).toContain(
        'Only a stable nlw-vX.Y.Z tag can move :latest'
      );
    }
  });

  it('W6 a manual run publishes the tag it was given, never the branch it ran on', () => {
    expect(dispatched('nlw-pre-foo', 'false', 'main').outputs).toEqual({
      containerver: 'nlw-pre-foo',
      latest: 'false',
    });
    expect(
      dispatched('nlw-pre-foo', 'false', 'nlw-v9.9.9').outputs.containerver
    ).toBe('nlw-pre-foo');
    expect(
      resolveTag({ event: 'workflow_dispatch', ref: 'nlw/content-studio' }).code
    ).not.toBe(0);
    // github.ref_name is read once, as the pushed tag, and nowhere else
    expect(raw(WORKFLOW_FILE).match(/github\.ref_name/g)).toEqual([
      'github.ref_name',
    ]);
    expect(VERSION.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      REF_NAME: '${{ github.ref_name }}',
      INPUT_TAG: '${{ inputs.tag }}',
      INPUT_LATEST: '${{ inputs.latest }}',
    });
    expect(VERSION.shell).toBe('bash');
  });

  it('W7 the tag is an nlw- Docker tag: no branch, slash, space, newline or flag', () => {
    for (const tag of [
      '',
      'main',
      'nlw/content-studio',
      'nlw-a/b',
      'nlw-',
      'nlw-a b',
      'nlw-a\nmain',
      'nlw-a;rm',
      'nlw-$(id)',
      '--push',
      'v2.25.0',
      `nlw-${'a'.repeat(125)}`,
    ]) {
      const result = dispatched(tag);
      expect([tag, result.code === 0, result.outputs]).toEqual([
        tag,
        false,
        {},
      ]);
    }
    // the longest Docker tag, 128 characters
    expect(dispatched(`nlw-${'a'.repeat(124)}`).code).toBe(0);
  });

  it('W9 the exact manifest waits for both architectures; :latest comes after it, only when allowed', () => {
    expect(job('build-containers').needs).toBe('build-containers-common');
    expect(job('build-container-manifest').needs).toEqual([
      'build-containers',
      'build-containers-common',
    ]);
    expect(job('build-containers-common').outputs).toEqual({
      containerver: '${{ steps.getcontainerver.outputs.containerver }}',
      latest: '${{ steps.getcontainerver.outputs.latest }}',
      sha: '${{ steps.getsha.outputs.sha }}',
    });
    const names = job('build-container-manifest').steps.map((s) => s.name);
    expect(names).toEqual([
      'Login to ghcr',
      'Create Docker Manifest',
      'Verify Manifest',
      'Create Latest Manifest',
    ]);
    const steps = job('build-container-manifest').steps;
    // no step but the guarded one touches :latest
    for (const s of steps.filter((s) => s.name !== 'Create Latest Manifest')) {
      expect([s.name, /:latest/.test(s.run ?? '')]).toEqual([s.name, false]);
      expect(s.if).toBeUndefined();
    }
    const latest = step('build-container-manifest', 'Create Latest Manifest');
    expect(latest.if).toBe(
      "needs.build-containers-common.outputs.latest == 'true'"
    );
    expect(latest.run).toMatch(
      /docker manifest push ghcr\.io\/nextlevelweb\/postiz-app:latest/
    );
    const exact = step('build-container-manifest', 'Create Docker Manifest')
      .run!;
    expect(
      exact.indexOf(
        'imagetools inspect "ghcr.io/nextlevelweb/postiz-app:$CONTAINERVER-amd64"'
      )
    ).toBeGreaterThan(-1);
    expect(
      exact.indexOf(
        'imagetools inspect "ghcr.io/nextlevelweb/postiz-app:$CONTAINERVER-arm64"'
      )
    ).toBeLessThan(
      exact.indexOf(
        'docker manifest push "ghcr.io/nextlevelweb/postiz-app:$CONTAINERVER"'
      )
    );
  });

  it('W10 both architectures build the commit of the git tag the image is named after', () => {
    expect(step('build-containers-common', 'Checkout Tag')).toMatchObject({
      uses: 'actions/checkout@v4',
      with: {
        ref: 'refs/tags/${{ steps.getcontainerver.outputs.containerver }}',
      },
    });
    expect(step('build-containers', 'Checkout').with).toEqual({
      ref: '${{ needs.build-containers-common.outputs.sha }}',
      'fetch-depth': 0,
    });
    const build = step('build-containers', 'Build and Push Image');
    expect(build.env).toEqual({
      CONTAINERVER: '${{ needs.build-containers-common.outputs.containerver }}',
      NEXT_PUBLIC_VERSION:
        '${{ needs.build-containers-common.outputs.containerver }}',
    });
    // the tag reaches the shell only as an environment variable
    for (const name of Object.keys(workflow.jobs)) {
      for (const s of job(name).steps) {
        expect([s.name, /\$\{\{\s*(env|inputs)\./.test(s.run ?? '')]).toEqual([
          s.name,
          false,
        ]);
      }
    }
  });
});

// .dockerignore as Docker reads it: one pattern per line, a leading `!`
// re-includes, the last matching pattern wins, and a pattern that matches a
// directory covers everything below it
const DOCKERIGNORE = raw('.dockerignore');
const dockerPatterns = DOCKERIGNORE.split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).replace(/^\/+/, '');
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
      if (pattern.startsWith('**/', i)) {
        source += '(?:.*/)?';
        i += 2;
      } else if (pattern.startsWith('**', i)) {
        source += '.*';
        i += 1;
      } else if (pattern[i] === '*') {
        source += '[^/]*';
      } else if (pattern[i] === '?') {
        source += '[^/]';
      } else {
        source += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return { negated, test: new RegExp(`^${source}(?:/.*)?$`) };
  });
const inBuildContext = (file: string) =>
  !dockerPatterns.reduce(
    (excluded, pattern) =>
      pattern.test.test(file) ? !pattern.negated : excluded,
    false
  );

describe('the Docker build context (.dockerignore)', () => {
  it('D1/D2/D3 local env files never reach the context; the tracked example does', () => {
    expect(DOCKERIGNORE).toContain(
      '\n.env\n.env.*\n**/.env\n**/.env.*\n!.env.example\n'
    );
    for (const file of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.content-studio.backup',
      'apps/frontend/.env',
      'apps/frontend/.env.local',
      'apps/backend/.env.backup',
    ]) {
      expect([file, inBuildContext(file)]).toEqual([file, false]);
    }
    for (const file of [
      '.env.example',
      'package.json',
      'pnpm-lock.yaml',
      'Dockerfile.dev',
      'var/docker/nginx.conf',
      'libraries/nestjs-libraries/src/database/prisma/schema.prisma',
      'apps/commands/src/main.ts',
    ]) {
      expect([file, inBuildContext(file)]).toEqual([file, true]);
    }
    // the matcher reads the existing rules the way Docker does too
    for (const file of [
      'node_modules/prisma/package.json',
      'apps/frontend/node_modules/x/index.js',
      'apps/commands/dist/apps/commands/src/main.js',
      '.git/HEAD',
      '.github/workflows/build-containers.yml',
      'README.md',
      'apps/frontend/README.md',
    ]) {
      expect([file, inBuildContext(file)]).toEqual([file, false]);
    }
  });

  it('D8 the image copies the whole context, so .dockerignore is what keeps env files out', () => {
    const dockerfile = raw('Dockerfile.dev');
    expect(dockerfile.match(/^COPY .*$/gm)).toEqual([
      'COPY . /app',
      'COPY var/docker/nginx.conf /etc/nginx/nginx.conf',
    ]);
    expect(dockerfile).not.toMatch(/\.env|--secret|ARG .*(SECRET|KEY|TOKEN)/);
  });
});

const scripts = JSON.parse(raw('package.json')).scripts as Record<
  string,
  string
>;
const SCHEMA = './libraries/nestjs-libraries/src/database/prisma/schema.prisma';

// the image's start chain in sh, with pnpm and pm2 stubbed: pnpm runs the
// package scripts it is asked for, except the schema push, which exits as
// told; every call is logged in order
const start = (env: { pushExit: number; skip?: string }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-start-'));
  try {
    const log = path.join(dir, 'log');
    fs.writeFileSync(log, '');
    fs.writeFileSync(
      path.join(dir, 'pnpm'),
      `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'pnpm ' + args.join(' ') + '\\n');
if (args.join(' ') === 'run prisma-db-push') process.exit(Number(process.env.FAKE_PUSH_EXIT));
if (args[0] === 'run' && args.length === 2) {
  const script = JSON.parse(fs.readFileSync(process.env.FAKE_PACKAGE, 'utf8')).scripts[args[1]];
  process.exit(spawnSync('sh', ['-c', script], { stdio: 'inherit' }).status ?? 1);
}
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(dir, 'pm2'),
      '#!/bin/sh\necho "pm2 $*" >> "$FAKE_LOG"\n',
      { mode: 0o755 }
    );
    const childEnv: NodeJS.ProcessEnv = {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_PACKAGE: path.join(REPO_ROOT, 'package.json'),
      FAKE_PUSH_EXIT: String(env.pushExit),
    };
    if (env.skip !== undefined) childEnv.SKIP_PRISMA_DB_PUSH = env.skip;
    const result = spawnSync('sh', ['-c', scripts['pm2-run']], {
      encoding: 'utf8',
      env: childEnv,
    });
    return {
      code: result.status,
      calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
      out: result.stdout,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const STARTED = [
  'pm2 delete all',
  'pnpm run prisma-db-push-on-start',
  'pnpm run prisma-db-push',
  'pnpm run --parallel pm2',
  'pm2 logs',
];

describe('the schema push on start (package.json)', () => {
  it('DBH1/DBH2/DBH3 the image pushes the schema with the installed Prisma CLI, never accepting data loss', () => {
    expect(scripts['prisma-db-push']).toBe(
      `pnpm exec prisma db push --schema ${SCHEMA}`
    );
    expect(scripts.pm2).toBe('pnpm run pm2-run');
    for (const name of [
      'pm2',
      'pm2-run',
      'prisma-db-push',
      'prisma-db-push-on-start',
    ]) {
      expect([
        name,
        /accept-data-loss|force-reset|migrate reset|dlx/.test(scripts[name]),
      ]).toEqual([name, false]);
    }
    // the CLI is the one the lockfile pins, installed with the image
    const pkg = JSON.parse(raw('package.json'));
    expect(pkg.devDependencies.prisma).toBe('6.5.0');
    expect(pkg.dependencies['@prisma/client']).toBe('6.5.0');
    expect(raw('Dockerfile.dev')).toMatch(/\nRUN pnpm install\n/);
    expect(raw('Dockerfile.dev')).not.toMatch(/--prod|NODE_ENV=production/);
  });

  it('DBH4 the push runs before any app process, and the apps start after it', () => {
    expect(scripts['pm2-run']).toBe(
      'pm2 delete all || true && pnpm run prisma-db-push-on-start && pnpm run --parallel pm2 && pm2 logs'
    );
    expect(start({ pushExit: 0 })).toEqual({
      code: 0,
      calls: STARTED,
      out: '',
    });
  });

  it('DBH5 a failed push (a destructive change) stops the start: no app process runs', () => {
    for (const pushExit of [1, 2]) {
      const result = start({ pushExit });
      expect(result.code).not.toBe(0);
      expect(result.calls).toEqual(STARTED.slice(0, 3));
    }
  });

  it('DBH6 without SKIP_PRISMA_DB_PUSH=true the push always runs, and its failure still stops the start', () => {
    expect(start({ pushExit: 0, skip: 'false' }).calls).toEqual(STARTED);
    for (const skip of [undefined, '', 'false', '1', 'TRUE', 'yes', ' true']) {
      expect([skip, start({ pushExit: 1, skip }).calls]).toEqual([
        skip,
        STARTED.slice(0, 3),
      ]);
    }
  });

  it('DBH7 SKIP_PRISMA_DB_PUSH=true skips only the push', () => {
    const result = start({ pushExit: 1, skip: 'true' });
    expect(result).toEqual({
      code: 0,
      calls: STARTED.filter((call) => call !== 'pnpm run prisma-db-push'),
      out: 'SKIP_PRISMA_DB_PUSH=true: schema push skipped\n',
    });
    expect(scripts['prisma-db-push-on-start']).toBe(
      'if [ "$SKIP_PRISMA_DB_PUSH" = true ]; then echo \'SKIP_PRISMA_DB_PUSH=true: schema push skipped\'; else pnpm run prisma-db-push; fi'
    );
    // documented, and off unless set
    expect(raw('.env.example')).toMatch(/^#SKIP_PRISMA_DB_PUSH="true"$/m);
    expect(raw('.env.example')).not.toMatch(/^SKIP_PRISMA_DB_PUSH/m);
  });

  it('DBH8 the image starts through the chain, and the commands app is never part of it', () => {
    expect(raw('Dockerfile.dev')).toMatch(
      /\nCMD \["sh", "-c", "nginx && pnpm run pm2"\]\n?$/
    );
    for (const name of [
      'pm2',
      'pm2-run',
      'prisma-db-push',
      'prisma-db-push-on-start',
    ]) {
      expect([name, /commands|backfill/.test(scripts[name])]).toEqual([
        name,
        false,
      ]);
    }
  });
});
