import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Content Studio may only use explicitly resolved organization AI
// connections. This guard parses Content Studio production code (and nothing
// else: legacy Postiz AI is deliberately out of scope) and fails on the ways a
// global, environment-backed credential could sneak in.

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const ROOTS = [
  'libraries/nestjs-libraries/src/content-studio',
  'apps/backend/src/api/routes/content-studio',
  'apps/frontend/src/components/content-studio',
  'libraries/helpers/src/content-studio',
];
// The orchestrator has no fixed folder yet: any file or folder under its src
// whose name contains `content-studio` is in scope
const ORCHESTRATOR_SRC = 'apps/orchestrator/src';

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  'generated',
  '__generated__',
]);
const TEST_FILE = /\.(spec|test)\.tsx?$/;

type Rule =
  | 'CS_NO_PROCESS_ENV'
  | 'CS_NO_HARDCODED_AI_KEY'
  | 'CS_NO_GLOBAL_AI_CLIENT'
  | 'CS_NO_DEFAULT_PROVIDER_CLIENT'
  | 'CS_NO_LEGACY_AI_SERVICE'
  | 'CS_NO_SAFEFETCH_FACTORY';

// Fixed messages: a violation never echoes source text, so a committed key
// does not end up in CI logs a second time
const MESSAGES: Record<Rule, string> = {
  CS_NO_PROCESS_ENV:
    'Content Studio code must not access process.env directly; configuration arrives through injected services',
  CS_NO_HARDCODED_AI_KEY:
    'Content Studio code must not contain a hard-coded AI provider key',
  CS_NO_GLOBAL_AI_CLIENT:
    'AI provider clients must be created per operation inside a function, never at module or class-field scope',
  CS_NO_DEFAULT_PROVIDER_CLIENT:
    'Import the provider factory (e.g. createOpenAI) instead of the env-backed default provider',
  CS_NO_LEGACY_AI_SERVICE:
    'Content Studio must not use the environment-keyed Postiz AI services; use the organization AI connection',
  CS_NO_SAFEFETCH_FACTORY:
    'createSafeFetch is a test seam; production Content Studio code must use safeFetch',
};

// OpenAI (sk-, sk-proj-, sk-svcacct-, ...) and Anthropic (sk-ant-) keys need at
// least 20 key characters, so prose like "sk-test" never matches. Google API
// keys have a fixed AIza + 35 character shape
const KEY_PATTERNS = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bAIza[0-9A-Za-z_-]{35}\b/];

// Constructing one of these at module scope or in a class field creates a
// shared client that reads its key from the environment when none is passed
const CLIENT_CLASSES = new Set([
  'OpenAI',
  'AzureOpenAI',
  'ChatOpenAI',
  'OpenAIEmbeddings',
  'DallEAPIWrapper',
  'OpenAIAdapter',
  'Anthropic',
  'ChatAnthropic',
  'GoogleGenerativeAI',
  'ChatGoogleGenerativeAI',
]);
const CLIENT_FACTORIES = new Set([
  'createOpenAI',
  'createAnthropic',
  'createGoogleGenerativeAI',
  'createGoogleVertex',
  'createMistral',
  'createGroq',
  'createOpenAICompatible',
]);

// Default provider instances that read their key from the environment. Only
// SDKs that are installed are listed; their factories stay importable
const DEFAULT_PROVIDERS: Record<string, string[]> = {
  '@ai-sdk/openai': ['openai'],
};

// Valid legacy Postiz modules, but their credentials come from global
// environment variables (OPENAI_API_KEY, FAL_KEY, DEEPGRAM_API_KEY, ...), so
// Content Studio may not use them; it goes through organization AI
// connections instead
const LEGACY_AI_MODULES = [
  '@gitroom/nestjs-libraries/openai/openai.service',
  '@gitroom/nestjs-libraries/openai/fal.service',
  '@gitroom/nestjs-libraries/agent/agent.module',
  '@gitroom/nestjs-libraries/agent/agent.graph.service',
  '@gitroom/nestjs-libraries/agent/agent.graph.insert.service',
  '@gitroom/nestjs-libraries/chat/chat.module',
  '@gitroom/nestjs-libraries/chat/mastra.service',
  '@gitroom/nestjs-libraries/chat/load.tools.service',
  '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service',
  '@gitroom/nestjs-libraries/deepgram/deepgram.service',
  '@gitroom/nestjs-libraries/videos/video.module',
  '@gitroom/nestjs-libraries/videos/video.manager',
  '@gitroom/nestjs-libraries/videos/images-slides',
  '@gitroom/nestjs-libraries/videos/seedance',
  '@copilotkit/runtime',
];

const SAFE_FETCH_MODULE = /(^|\/)safe\.fetch$/;

interface Violation {
  file: string;
  line: number;
  column: number;
  rule: Rule;
}

// Relative imports are mapped onto the alias they point at, so
// `../openai/openai.service` and the @gitroom path are judged the same
const ALIASES: Array<[string, string]> = [
  ['libraries/nestjs-libraries/src/', '@gitroom/nestjs-libraries/'],
  ['libraries/helpers/src/', '@gitroom/helpers/'],
];

function normalizeModule(file: string, specifier: string) {
  let target = specifier;
  if (specifier.startsWith('.')) {
    target = path
      .relative(REPO_ROOT, path.resolve(path.dirname(file), specifier))
      .split(path.sep)
      .join('/');
    for (const [folder, alias] of ALIASES) {
      if (target.startsWith(folder)) {
        target = alias + target.slice(folder.length);
      }
    }
  }
  return target.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
}

const matchesModule = (target: string, entry: string) =>
  target === entry ||
  target.startsWith(`${entry}/`) ||
  target.startsWith(`${entry}.`);

function isProcess(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === 'process';
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'process' &&
    ts.isIdentifier(node.expression) &&
    ['globalThis', 'global', 'window'].includes(node.expression.text)
  );
}

function memberName(node: ts.Node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function calleeName(node: ts.Expression) {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return undefined;
}

// A function only isolates its body when it is not invoked while the module
// loads; class fields and static blocks run with the class, so they count as
// module scope too
function runsPerCall(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isPropertyDeclaration(current) ||
      ts.isClassStaticBlockDeclaration(current)
    ) {
      return false;
    }
    if (ts.isFunctionLike(current)) {
      let callee: ts.Node = current;
      while (ts.isParenthesizedExpression(callee.parent)) {
        callee = callee.parent;
      }
      const iife =
        ts.isCallExpression(callee.parent) &&
        callee.parent.expression === callee;
      if (!iife) {
        return true;
      }
    }
  }
  return false;
}

// Module specifier and imported names of every static import, re-export,
// require() and import() in the file
function moduleReferences(node: ts.Node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    const names: string[] = [];
    let wholeModule = false;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      wholeModule = !!clause?.name;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        wholeModule = true;
      } else if (bindings && ts.isNamedImports(bindings)) {
        bindings.elements.forEach((element) =>
          names.push((element.propertyName || element.name).text)
        );
      }
    } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      node.exportClause.elements.forEach((element) =>
        names.push((element.propertyName || element.name).text)
      );
    } else {
      wholeModule = true;
    }
    return { specifier: node.moduleSpecifier.text, names, wholeModule };
  }

  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === 'require')) &&
    node.arguments.length &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return { specifier: node.arguments[0].text, names: [], wholeModule: true };
  }
  return undefined;
}

function checkSource(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const violations: Violation[] = [];
  const report = (node: ts.Node, rule: Rule) => {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source)
    );
    violations.push({
      file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      line: line + 1,
      column: character + 1,
      rule,
    });
  };

  const visit = (node: ts.Node) => {
    // process.env, process['env'], globalThis.process.env
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      memberName(node) === 'env' &&
      isProcess(node.expression)
    ) {
      report(node, 'CS_NO_PROCESS_ENV');
    }
    // const { env } = process
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isProcess(node.initializer) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) =>
          ((element.propertyName || element.name) as ts.Identifier).text ===
          'env'
      )
    ) {
      report(node, 'CS_NO_PROCESS_ENV');
    }

    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      KEY_PATTERNS.some((pattern) => pattern.test(node.text))
    ) {
      report(node, 'CS_NO_HARDCODED_AI_KEY');
    }

    if (
      ts.isNewExpression(node) &&
      CLIENT_CLASSES.has(calleeName(node.expression) || '') &&
      !runsPerCall(node)
    ) {
      report(node, 'CS_NO_GLOBAL_AI_CLIENT');
    }
    if (
      ts.isCallExpression(node) &&
      CLIENT_FACTORIES.has(calleeName(node.expression) || '') &&
      !runsPerCall(node)
    ) {
      report(node, 'CS_NO_GLOBAL_AI_CLIENT');
    }

    const reference = moduleReferences(node);
    if (reference) {
      const target = normalizeModule(file, reference.specifier);
      if (target === 'process' || target === 'node:process') {
        report(node, 'CS_NO_PROCESS_ENV');
      }
      const defaults = DEFAULT_PROVIDERS[target];
      if (
        defaults &&
        (reference.wholeModule ||
          reference.names.some((name) => defaults.includes(name)))
      ) {
        report(node, 'CS_NO_DEFAULT_PROVIDER_CLIENT');
      }
      if (LEGACY_AI_MODULES.some((entry) => matchesModule(target, entry))) {
        report(node, 'CS_NO_LEGACY_AI_SERVICE');
      }
      if (
        SAFE_FETCH_MODULE.test(target) &&
        (reference.wholeModule || reference.names.includes('createSafeFetch'))
      ) {
        report(node, 'CS_NO_SAFEFETCH_FACTORY');
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

const format = (violation: Violation) =>
  `${violation.file}:${violation.line}:${violation.column} [${
    violation.rule
  }] ${MESSAGES[violation.rule]}`;

function listFiles(
  directory: string,
  keep: (file: string) => boolean
): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listFiles(full, keep);
      }
      return entry.isFile() && keep(full) ? [full] : [];
    });
}

const isSource = (file: string) =>
  /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
const isProduction = (file: string) => isSource(file) && !TEST_FILE.test(file);

function contentStudioFiles(keep = isProduction) {
  return [
    ...ROOTS.flatMap((root) => listFiles(path.join(REPO_ROOT, root), keep)),
    ...listFiles(path.join(REPO_ROOT, ORCHESTRATOR_SRC), keep).filter((file) =>
      path.relative(REPO_ROOT, file).includes('content-studio')
    ),
  ];
}

// Fixtures are checked in memory under a Content Studio path; nothing is
// written to the tree
const FIXTURE = path.join(REPO_ROOT, ROOTS[0], 'fixture.ts');
const rules = (text: string, file = FIXTURE) =>
  checkSource(file, text).map((violation) => violation.rule);

describe('Content Studio architecture guard', () => {
  describe('CS_NO_PROCESS_ENV', () => {
    it.each([
      ['const key = process.env.OPENAI_API_KEY;'],
      ["const key = process.env['OPENAI_API_KEY'];"],
      ["const key = process['env'].OPENAI_API_KEY;"],
      ['const read = (name: string) => process.env[name];'],
      ["const read = (name: string) => process['env'][name];"],
      ['const all = process.env;'],
      ['const key = globalThis.process.env.ANTHROPIC_API_KEY;'],
      ['const { env } = process;'],
      ["import { env } from 'node:process';"],
    ])('rejects %s', (text) => {
      expect(rules(text)).toContain('CS_NO_PROCESS_ENV');
    });

    it('allows other uses of process', () => {
      expect(
        rules('const cwd = process.cwd(); const environment = "env";')
      ).toEqual([]);
    });
  });

  describe('CS_NO_HARDCODED_AI_KEY', () => {
    it.each([
      ["const key = 'sk-proj-this-is-clearly-a-fake-test-key-123456';"],
      ['const key = "sk-abcdefghijklmnopqrstuvwxyz0123";'],
      ['const key = `sk-ant-api03-abcdefghijklmnopqrstuvwxyz`;'],
      ['const header = `Bearer sk-proj-abcdefghijklmnopqrstuv${suffix}`;'],
      ["const key = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';"],
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual(['CS_NO_HARDCODED_AI_KEY']);
    });

    it.each([
      ["const label = 'sk-test';"],
      ["const text = 'Ask-me-anything about the task-list';"],
      ["const prefix = 'sk-';"],
      ["const docs = 'Keys look like sk-...';"],
    ])('allows %s', (text) => {
      expect(rules(text)).toEqual([]);
    });

    it('never prints the key it found', () => {
      const key = 'sk-proj-this-is-clearly-a-fake-test-key-123456';
      const report = checkSource(FIXTURE, `\n  const key = '${key}';`).map(
        format
      );

      expect(report).toEqual([
        `${ROOTS[0]}/fixture.ts:2:15 [CS_NO_HARDCODED_AI_KEY] ${MESSAGES.CS_NO_HARDCODED_AI_KEY}`,
      ]);
      expect(report.join('\n')).not.toContain('fake-test-key');
    });
  });

  describe('CS_NO_GLOBAL_AI_CLIENT', () => {
    it.each([
      ['const client = new OpenAI({ apiKey: key });'],
      ['export const model = new ChatOpenAI({ model: "gpt" });'],
      ['const dalle = new DallEAPIWrapper({});'],
      ['const adapter = new OpenAIAdapter({ openai });'],
      ['const client = new Anthropic({ apiKey: key });'],
      ['const client = new sdk.OpenAI({ apiKey: key });'],
      ['const clients = { main: new OpenAI({ apiKey: key }) };'],
      ['const client = createOpenAI({ apiKey: key });'],
      ['const client = createOpenAICompatible({ baseURL: url });'],
      ['const client = (() => new OpenAI({ apiKey: key }))();'],
      ['const client = (function () { return createOpenAI({}); })();'],
      ['class Service { client = new OpenAI({ apiKey: key }); }'],
      ['class Service { static client = createOpenAI({}); }'],
      ['class Service { static { const c = new OpenAI({}); } }'],
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual(['CS_NO_GLOBAL_AI_CLIENT']);
    });

    it.each([
      [
        'function makeClient(key: string) { return new OpenAI({ apiKey: key }); }',
      ],
      [
        'function makeClient(key: string) { return createOpenAI({ apiKey: key }); }',
      ],
      ['const makeClient = (key: string) => new ChatOpenAI({ apiKey: key });'],
      [
        'class Adapter { run(key: string) { return createOpenAI({ apiKey: key }); } }',
      ],
      [
        'class Adapter { constructor(key: string) { this.c = new OpenAI({ apiKey: key }); } }',
      ],
      [
        'const adapters = { openai: (key: string) => new OpenAI({ apiKey: key }) };',
      ],
      [
        "import OpenAI from 'openai'; type Client = OpenAI; let client: OpenAI;",
      ],
    ])('allows %s', (text) => {
      expect(rules(text)).toEqual([]);
    });
  });

  describe('CS_NO_DEFAULT_PROVIDER_CLIENT', () => {
    it.each([
      ["import { openai } from '@ai-sdk/openai';"],
      ["import { openai as llm } from '@ai-sdk/openai';"],
      ["import * as sdk from '@ai-sdk/openai';"],
      ["export { openai } from '@ai-sdk/openai';"],
      ["const sdk = require('@ai-sdk/openai');"],
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual(['CS_NO_DEFAULT_PROVIDER_CLIENT']);
    });

    it.each([
      ["import { createOpenAI } from '@ai-sdk/openai';"],
      ["import type { OpenAIProvider } from '@ai-sdk/openai';"],
    ])('allows %s', (text) => {
      expect(rules(text)).toEqual([]);
    });
  });

  describe('CS_NO_LEGACY_AI_SERVICE', () => {
    it.each([
      [
        "import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';",
      ],
      [
        "import { FalService } from '@gitroom/nestjs-libraries/openai/fal.service';",
      ],
      [
        "import { AgentGraphService } from '@gitroom/nestjs-libraries/agent/agent.graph.service';",
      ],
      [
        "import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';",
      ],
      [
        "import { AutopostService } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.service';",
      ],
      [
        "import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';",
      ],
      [
        "import { ImagesSlides } from '@gitroom/nestjs-libraries/videos/images-slides/images.slides';",
      ],
      ["import { CopilotRuntime } from '@copilotkit/runtime';"],
      ["import { OpenaiService } from '../openai/openai.service';"],
      [
        "const lazy = () => import('@gitroom/nestjs-libraries/chat/load.tools.service');",
      ],
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual(['CS_NO_LEGACY_AI_SERVICE']);
    });

    it.each([
      [
        "import { generationError } from '@gitroom/nestjs-libraries/openai/generation.error';",
      ],
      [
        "import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';",
      ],
      [
        "import { secretBox } from '@gitroom/nestjs-libraries/services/secret.box';",
      ],
      [
        "import { agentCategories } from '@gitroom/nestjs-libraries/agent/agent.categories';",
      ],
    ])('allows %s', (text) => {
      expect(rules(text)).toEqual([]);
    });
  });

  describe('CS_NO_SAFEFETCH_FACTORY', () => {
    it.each([
      [
        "import { createSafeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
      ],
      [
        "import { safeFetch, createSafeFetch } from '../dtos/webhooks/safe.fetch';",
      ],
      [
        "import * as fetching from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
      ],
      [
        "export { createSafeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
      ],
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual(['CS_NO_SAFEFETCH_FACTORY']);
    });

    it.each([
      [
        "import { safeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
      ],
      [
        "import { safeFetch, SafeFetchError } from '../dtos/webhooks/safe.fetch';",
      ],
    ])('allows %s', (text) => {
      expect(rules(text)).toEqual([]);
    });
  });

  it('reports every violation in a file with its location', () => {
    const text = [
      "import { openai } from '@ai-sdk/openai';",
      "import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';",
      "import { createSafeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
      'const key = process.env.OPENAI_API_KEY;',
      "const fallback = 'sk-proj-this-is-clearly-a-fake-test-key-123456';",
      'const client = new OpenAI({ apiKey: key });',
      'export const run = (k: string) => createOpenAI({ apiKey: k });',
    ].join('\n');

    expect(
      checkSource(FIXTURE, text).map(({ line, column, rule }) => ({
        line,
        column,
        rule,
      }))
    ).toEqual([
      { line: 1, column: 1, rule: 'CS_NO_DEFAULT_PROVIDER_CLIENT' },
      { line: 2, column: 1, rule: 'CS_NO_LEGACY_AI_SERVICE' },
      { line: 3, column: 1, rule: 'CS_NO_SAFEFETCH_FACTORY' },
      { line: 4, column: 13, rule: 'CS_NO_PROCESS_ENV' },
      { line: 5, column: 18, rule: 'CS_NO_HARDCODED_AI_KEY' },
      { line: 6, column: 16, rule: 'CS_NO_GLOBAL_AI_CLIENT' },
    ]);
  });

  // The rules match the patterns legacy Postiz really uses; read-only, these
  // files are judged as if they lived in Content Studio
  it.each([
    [
      'libraries/nestjs-libraries/src/openai/openai.service.ts',
      ['CS_NO_PROCESS_ENV', 'CS_NO_GLOBAL_AI_CLIENT'],
    ],
    [
      'libraries/nestjs-libraries/src/agent/agent.graph.service.ts',
      ['CS_NO_PROCESS_ENV', 'CS_NO_GLOBAL_AI_CLIENT'],
    ],
    [
      'libraries/nestjs-libraries/src/chat/load.tools.service.ts',
      ['CS_NO_DEFAULT_PROVIDER_CLIENT'],
    ],
    [
      'libraries/nestjs-libraries/src/videos/images-slides/images.slides.ts',
      ['CS_NO_PROCESS_ENV', 'CS_NO_LEGACY_AI_SERVICE'],
    ],
  ])('would reject legacy %s', (file, expected) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    expect(rules(text)).toEqual(expect.arrayContaining(expected));
  });

  describe('real Content Studio tree', () => {
    const files = contentStudioFiles();

    it('resolves the roots from the repository', () => {
      expect(fs.existsSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(REPO_ROOT, ORCHESTRATOR_SRC))).toBe(true);
      // the walker does see this folder; only spec files are left out
      expect(contentStudioFiles(isSource)).toContain(__filename);
      expect(files).not.toContain(__filename);
    });

    it('walks nested folders and leaves out spec and declaration files', () => {
      const dtos = path.join(REPO_ROOT, 'libraries/nestjs-libraries/src/dtos');
      const found = listFiles(dtos, isProduction).map((file) =>
        path.relative(dtos, file).split(path.sep).join('/')
      );

      expect(found).toContain('webhooks/safe.fetch.ts');
      expect(found).not.toContain('webhooks/safe.fetch.spec.ts');
      expect(found.every((file) => !file.endsWith('.d.ts'))).toBe(true);
    });

    it(`has no violations in ${files.length} production file(s) under ${
      ROOTS.length + 1
    } roots`, () => {
      const violations = files.flatMap((file) =>
        checkSource(file, fs.readFileSync(file, 'utf8'))
      );
      expect(violations.map(format)).toEqual([]);
    });
  });
});
