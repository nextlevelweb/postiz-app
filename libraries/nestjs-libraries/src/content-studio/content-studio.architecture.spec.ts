import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Content Studio may only use explicitly resolved organization AI
// connections and must not render raw HTML. This guard parses Content Studio
// production code (and nothing else: legacy Postiz AI is deliberately out of
// scope) and fails on the ways a global, environment-backed credential or an
// HTML injection sink could sneak in.

const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Content Studio code follows the Postiz layout, so it is spread over these
// trees (database/prisma/content-studio, dtos/content-studio, a flat
// routes/content-studio.controller.ts, app/(app)/(site)/content-studio, ...).
// Only paths that name Content Studio are scanned, see isContentStudioPath
const SOURCE_BASES = [
  'libraries/nestjs-libraries/src',
  'libraries/helpers/src',
  'apps/backend/src',
  'apps/frontend/src',
  'apps/orchestrator/src',
];
const CONTENT_STUDIO = 'content-studio';
const FIXTURE_RELATIVE =
  'libraries/nestjs-libraries/src/content-studio/fixture.ts';

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
  | 'CS_NO_SAFEFETCH_FACTORY'
  | 'CS_NO_RAW_HTML_SINK'
  | 'CS_AI_PROVIDER_IMPORT_BOUNDARY'
  | 'CS_AI_EXPLICIT_CLIENT_OPTIONS'
  | 'CS_SOURCE_NETWORK_BOUNDARY';

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
  CS_NO_RAW_HTML_SINK:
    'Content Studio code must not render or assign raw HTML directly',
  CS_AI_PROVIDER_IMPORT_BOUNDARY:
    'Provider SDKs may only be imported by Content Studio provider adapters (content-studio/ai/providers/*.provider.ts); AI frameworks (ai, @ai-sdk/*) not at all',
  CS_AI_EXPLICIT_CLIENT_OPTIONS:
    'A provider SDK client (OpenAI, Anthropic) takes one options literal with exactly its environment backed options: apiKey, a fixed https baseURL of its provider, null for every other credential or account option, logLevel off, maxRetries 0 and a bounded timeout, so nothing falls back to the environment',
  CS_SOURCE_NETWORK_BOUNDARY:
    'Content Studio Source code reaches the network only through safeFetch, and only in the source ingestion service (content-studio/sources/ingestion/source.ingestion.service.ts); no Source file uses fetch, an HTTP client, sockets or DNS directly',
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

// The Source layer (content-studio/sources and the source repository, service
// and DTO) fetches pages, so its network access is held to one path: safeFetch,
// imported by the ingestion service and nowhere else in the layer. No Source
// file, the ingestion service included, may use another HTTP client, sockets,
// DNS or the global fetch. Other Content Studio code is not judged by this rule
const SOURCE_LAYER_FILE =
  /^libraries\/nestjs-libraries\/src\/(content-studio\/sources\/.+|database\/prisma\/content-studio\/content-studio\.source\.[a-z.-]+|dtos\/content-studio\/content-studio\.source\.[a-z.-]+)\.tsx?$/;
const SOURCE_INGESTION_FILE =
  'libraries/nestjs-libraries/src/content-studio/sources/ingestion/source.ingestion.service.ts';
const NETWORK_MODULES = [
  'axios',
  'undici',
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'got',
  'ky',
  'superagent',
  'request',
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dns',
  'dgram',
];
const isNetworkModule = (target: string) => {
  const name = target.replace(/^node:/, '');
  return NETWORK_MODULES.some(
    (entry) => name === entry || name.startsWith(`${entry}/`)
  );
};
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];

// fetch(...), globalThis.fetch(...), new WebSocket(...): the name being called
function networkGlobal(node: ts.Node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
    return undefined;
  }
  const callee = withoutParentheses(node.expression);
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      ['globalThis', 'global', 'window', 'self'].includes(
        callee.expression.text
      )
    ? callee.name.text
    : undefined;
  return name && NETWORK_GLOBALS.includes(name) ? name : undefined;
}

// Direct provider SDKs: only the provider adapters may import them, so every
// call goes through an organization connection and the operation tracking.
// AI frameworks (with their own env-backed providers) are not used at all
const PROVIDER_SDK_MODULES = ['openai', '@anthropic-ai/sdk'];
const isAIFrameworkModule = (target: string) =>
  target === 'ai' || target.startsWith('ai/') || target.startsWith('@ai-sdk/');
const PROVIDER_ADAPTER_FILE =
  /^libraries\/nestjs-libraries\/src\/content-studio\/ai\/providers\/[a-z0-9-]+\.provider\.ts$/;

// The provider SDKs read an environment variable for every option left out
// (OpenAI: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_ORG_ID, OPENAI_PROJECT_ID,
// OPENAI_WEBHOOK_SECRET, OPENAI_LOG; Anthropic: ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_LOG) and retry twice
// with a 10 minute timeout by default. So each client gets all of them, as
// literals (or a module constant for baseURL and timeout), and nothing else:
// no spread, no shorthand, no extra option. The other credential and account
// options are null, and baseURL names one of the SDK's own providers
interface ExplicitClient {
  nullOptions: string[];
  hosts: string[];
}
const EXPLICIT_CLIENTS: Record<string, ExplicitClient> = {
  OpenAI: {
    nullOptions: ['organization', 'project', 'webhookSecret'],
    hosts: ['api.openai.com', 'openrouter.ai'],
  },
  Anthropic: {
    nullOptions: ['authToken'],
    hosts: ['api.anthropic.com'],
  },
};
const COMMON_CLIENT_OPTIONS = [
  'apiKey',
  'baseURL',
  'logLevel',
  'maxRetries',
  'timeout',
];
const CLIENT_TIMEOUT_MAX_MS = 120_000;
const explicitClient = (node: ts.NewExpression) => {
  const name = calleeName(node.expression) || '';
  return Object.prototype.hasOwnProperty.call(EXPLICIT_CLIENTS, name)
    ? EXPLICIT_CLIENTS[name]
    : undefined;
};

// Studio stores plain text and the server builds the composer HTML, so the
// React and DOM ways of injecting markup are never needed in Studio code
const RAW_HTML_PROP = 'dangerouslySetInnerHTML';
const RAW_HTML_PROPERTIES = ['innerHTML', 'outerHTML'];

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

function withoutParentheses(node: ts.Expression) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
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

// The initializer of a top level `const name = ...` of the file
function moduleConstant(source: ts.SourceFile, name: string) {
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer
        ) {
          return withoutParentheses(declaration.initializer);
        }
      }
    }
  }
  return undefined;
}

const numericValue = (node: ts.Expression) =>
  ts.isNumericLiteral(node) ? Number(node.text.replace(/_/g, '')) : NaN;

function hasExplicitClientOptions(
  source: ts.SourceFile,
  node: ts.NewExpression,
  client: ExplicitClient
) {
  const expected = [...COMMON_CLIENT_OPTIONS, ...client.nullOptions];
  const args = node.arguments || [];
  if (args.length !== 1 || !ts.isObjectLiteralExpression(args[0])) {
    return false;
  }
  const values = new Map<string, ts.Expression>();
  for (const property of args[0].properties) {
    const name =
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text
        : undefined;
    if (
      !name ||
      !expected.includes(name) ||
      values.has(name) ||
      !ts.isPropertyAssignment(property)
    ) {
      return false;
    }
    values.set(name, withoutParentheses(property.initializer));
  }
  if (values.size !== expected.length) {
    return false;
  }
  const value = (name: string) => {
    const expression = values.get(name) as ts.Expression;
    return (
      (ts.isIdentifier(expression) &&
        moduleConstant(source, expression.text)) ||
      expression
    );
  };

  const apiKey = values.get('apiKey') as ts.Expression;
  const baseURL = value('baseURL');
  const logLevel = values.get('logLevel') as ts.Expression;
  const timeout = numericValue(value('timeout'));
  return (
    // the credential, never a literal, null or undefined
    !ts.isLiteralExpression(apiKey) &&
    apiKey.kind !== ts.SyntaxKind.NullKeyword &&
    !ts.isVoidExpression(apiKey) &&
    !(ts.isIdentifier(apiKey) && apiKey.text === 'undefined') &&
    ts.isStringLiteralLike(baseURL) &&
    client.hosts.some((host) =>
      new RegExp(
        `^https://${host.replace(/\./g, '\\.')}(/[A-Za-z0-9._/-]*)?$`
      ).test(baseURL.text)
    ) &&
    client.nullOptions.every(
      (name) => values.get(name)?.kind === ts.SyntaxKind.NullKeyword
    ) &&
    ts.isStringLiteralLike(logLevel) &&
    logLevel.text === 'off' &&
    numericValue(values.get('maxRetries') as ts.Expression) === 0 &&
    timeout >= 1 &&
    timeout <= CLIENT_TIMEOUT_MAX_MS
  );
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
  const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const providerAdapter = PROVIDER_ADAPTER_FILE.test(relative);
  const sourceLayer = SOURCE_LAYER_FILE.test(relative);
  const sourceIngestion = relative === SOURCE_INGESTION_FILE;
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
    if (
      ts.isNewExpression(node) &&
      explicitClient(node) &&
      !hasExplicitClientOptions(
        source,
        node,
        explicitClient(node) as ExplicitClient
      )
    ) {
      report(node, 'CS_AI_EXPLICIT_CLIENT_OPTIONS');
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
      if (
        isAIFrameworkModule(target) ||
        (!providerAdapter &&
          PROVIDER_SDK_MODULES.some(
            (entry) => target === entry || target.startsWith(`${entry}/`)
          ))
      ) {
        report(node, 'CS_AI_PROVIDER_IMPORT_BOUNDARY');
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
      if (
        sourceLayer &&
        (isNetworkModule(target) ||
          (SAFE_FETCH_MODULE.test(target) && !sourceIngestion))
      ) {
        report(node, 'CS_SOURCE_NETWORK_BOUNDARY');
      }
    }
    if (sourceLayer && networkGlobal(node)) {
      report(node, 'CS_SOURCE_NETWORK_BOUNDARY');
    }

    // <div dangerouslySetInnerHTML={...} />, on any element or component
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === RAW_HTML_PROP
    ) {
      report(node, 'CS_NO_RAW_HTML_SINK');
    }
    // el.innerHTML = html, el['outerHTML'] += html; reading them is fine
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      RAW_HTML_PROPERTIES.includes(
        memberName(withoutParentheses(node.left)) || ''
      )
    ) {
      report(node, 'CS_NO_RAW_HTML_SINK');
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

// A repo relative path is Content Studio code when it sits under a source base
// and, below that base, a folder is named `content-studio` or the file name's
// first dot separated part is `content-studio` (content-studio.controller.ts).
// Only the part below the base is looked at, so a checkout folder that happens
// to be called content-studio (this worktree is) never pulls in legacy code
function isContentStudioPath(relative: string) {
  const base = SOURCE_BASES.find((entry) => relative.startsWith(`${entry}/`));
  if (!base) {
    return false;
  }
  const segments = relative.slice(base.length + 1).split('/');
  const fileName = segments.pop() || '';
  return (
    segments.includes(CONTENT_STUDIO) ||
    fileName.split('.')[0] === CONTENT_STUDIO
  );
}

const relativePath = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join('/');

// Every base is walked (directory names only), but a file is read and parsed
// only when its path names Content Studio
function contentStudioFiles(root = REPO_ROOT, keep = isProduction) {
  return SOURCE_BASES.flatMap((base) =>
    listFiles(
      path.join(root, base),
      (file) => keep(file) && isContentStudioPath(relativePath(root, file))
    )
  ).sort();
}

// Fixtures are checked in memory under a Content Studio path; nothing is
// written to the tree
const FIXTURE = path.join(REPO_ROOT, FIXTURE_RELATIVE);
const FIXTURE_TSX = FIXTURE.replace(/\.ts$/, '.tsx');
// where P2-03 puts the provider adapters; nothing is written there either
const PROVIDER_FIXTURE = path.join(
  REPO_ROOT,
  'libraries/nestjs-libraries/src/content-studio/ai/providers/openai.provider.ts'
);
// Client options that satisfy CS_AI_EXPLICIT_CLIENT_OPTIONS, so a fixture
// about another rule reports that rule only
const OPTIONS =
  "{ apiKey: key, baseURL: 'https://api.openai.com/v1', organization: null, project: null, webhookSecret: null, logLevel: 'off', maxRetries: 0, timeout: 30_000 }";
const ANTHROPIC_OPTIONS =
  "{ apiKey: key, authToken: null, baseURL: 'https://api.anthropic.com', logLevel: 'off', maxRetries: 0, timeout: 30_000 }";
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
        `${FIXTURE_RELATIVE}:2:15 [CS_NO_HARDCODED_AI_KEY] ${MESSAGES.CS_NO_HARDCODED_AI_KEY}`,
      ]);
      expect(report.join('\n')).not.toContain('fake-test-key');
    });
  });

  describe('CS_NO_GLOBAL_AI_CLIENT', () => {
    it.each([
      [`const client = new OpenAI(${OPTIONS});`],
      ['export const model = new ChatOpenAI({ model: "gpt" });'],
      ['const dalle = new DallEAPIWrapper({});'],
      ['const adapter = new OpenAIAdapter({ openai });'],
      [`const client = new Anthropic(${ANTHROPIC_OPTIONS});`],
      [`const client = new sdk.OpenAI(${OPTIONS});`],
      [`const clients = { main: new OpenAI(${OPTIONS}) };`],
      ['const client = createOpenAI({ apiKey: key });'],
      ['const client = createOpenAICompatible({ baseURL: url });'],
      [`const client = (() => new OpenAI(${OPTIONS}))();`],
      ['const client = (function () { return createOpenAI({}); })();'],
      [`class Service { client = new OpenAI(${OPTIONS}); }`],
      ['class Service { static client = createOpenAI({}); }'],
      [`class Service { static { const c = new OpenAI(${OPTIONS}); } }`],
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual(['CS_NO_GLOBAL_AI_CLIENT']);
    });

    it.each([
      [`function makeClient(key: string) { return new OpenAI(${OPTIONS}); }`],
      [
        'function makeClient(key: string) { return createOpenAI({ apiKey: key }); }',
      ],
      ['const makeClient = (key: string) => new ChatOpenAI({ apiKey: key });'],
      [
        'class Adapter { run(key: string) { return createOpenAI({ apiKey: key }); } }',
      ],
      [
        `class Adapter { constructor(key: string) { this.c = new OpenAI(${OPTIONS}); } }`,
      ],
      [`const adapters = { openai: (key: string) => new OpenAI(${OPTIONS}) };`],
      [
        "import OpenAI from 'openai'; type Client = OpenAI; let client: OpenAI;",
      ],
      // clients are made in the provider adapters, the only files that may
      // import a provider SDK
    ])('allows %s', (text) => {
      expect(rules(text, PROVIDER_FIXTURE)).toEqual([]);
    });
  });

  describe('CS_NO_DEFAULT_PROVIDER_CLIENT', () => {
    it.each([
      ["import { openai } from '@ai-sdk/openai';"],
      ["import { openai as llm } from '@ai-sdk/openai';"],
      ["import * as sdk from '@ai-sdk/openai';"],
      ["export { openai } from '@ai-sdk/openai';"],
      ["const sdk = require('@ai-sdk/openai');"],
      // @ai-sdk/* is outside the provider import boundary as well
    ])('rejects %s', (text) => {
      expect(rules(text)).toEqual([
        'CS_NO_DEFAULT_PROVIDER_CLIENT',
        'CS_AI_PROVIDER_IMPORT_BOUNDARY',
      ]);
    });

    it.each([
      ["import { createOpenAI } from '@ai-sdk/openai';"],
      ["import type { OpenAIProvider } from '@ai-sdk/openai';"],
    ])(
      'does not report the factory import %s as the default provider',
      (text) => {
        expect(rules(text)).toEqual(['CS_AI_PROVIDER_IMPORT_BOUNDARY']);
      }
    );
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

  describe('CS_SOURCE_NETWORK_BOUNDARY', () => {
    const SAFE_FETCH_IMPORT =
      "import { safeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';";
    const at = (relative: string) => path.join(REPO_ROOT, relative);
    const INGESTION = at(SOURCE_INGESTION_FILE);
    const SOURCE_SERVICE = at(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts'
    );
    const SOURCE_REPOSITORY = at(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts'
    );
    const SOURCE_DOMAIN = at(
      'libraries/nestjs-libraries/src/content-studio/sources/source.extract.ts'
    );
    const SOURCE_DTO = at(
      'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts'
    );
    const OTHER_SOURCE_FILE = at(
      'libraries/nestjs-libraries/src/content-studio/sources/research/source.preview.ts'
    );

    it('NG1 lets the ingestion service import safeFetch', () => {
      expect(rules(SAFE_FETCH_IMPORT, INGESTION)).toEqual([]);
      expect(
        rules(
          "import { safeFetch, SafeFetchError } from '../../../dtos/webhooks/safe.fetch';",
          INGESTION
        )
      ).toEqual([]);
    });

    it.each([
      ['NG2 the source service', SOURCE_SERVICE],
      ['NG3 the source repository', SOURCE_REPOSITORY],
      ['NG4 the source domain', SOURCE_DOMAIN],
      ['the source DTO', SOURCE_DTO],
      ['NG9 any other Source file', OTHER_SOURCE_FILE],
    ])('refuses a safeFetch import in %s', (_name, file) => {
      expect(rules(SAFE_FETCH_IMPORT, file)).toEqual([
        'CS_SOURCE_NETWORK_BOUNDARY',
      ]);
      expect(
        rules(
          "export { safeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
          file
        )
      ).toEqual(['CS_SOURCE_NETWORK_BOUNDARY']);
      expect(
        rules(
          "const load = () => import('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch');",
          file
        )
      ).toEqual(['CS_NO_SAFEFETCH_FACTORY', 'CS_SOURCE_NETWORK_BOUNDARY']);
    });

    it('NG5 still refuses createSafeFetch in the ingestion service', () => {
      expect(
        rules(
          "import { createSafeFetch } from '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch';",
          INGESTION
        )
      ).toEqual(['CS_NO_SAFEFETCH_FACTORY']);
    });

    it.each([
      ['NG6 axios', "import axios from 'axios';"],
      ['NG7 undici', "import { request } from 'undici';"],
      ['undici fetch', "import { fetch } from 'undici';"],
      ['node-fetch', "import fetch from 'node-fetch';"],
      ['got', "import got from 'got';"],
      ['node:http', "import http from 'node:http';"],
      ['https', "import * as https from 'https';"],
      ['dns', "import { lookup } from 'node:dns/promises';"],
      ['net', "import net from 'net';"],
      ['a require of axios', "const axios = require('axios');"],
      ['NG8 the global fetch', 'export const run = (u: string) => fetch(u);'],
      [
        'globalThis.fetch',
        'export const run = (u: string) => globalThis.fetch(u);',
      ],
      ['a WebSocket', "export const open = () => new WebSocket('wss://x');"],
      ['an XMLHttpRequest', 'export const open = () => new XMLHttpRequest();'],
    ])(
      'refuses %s in any Source file, the ingestion service included',
      (_name, text) => {
        for (const file of [INGESTION, SOURCE_SERVICE, SOURCE_DOMAIN]) {
          expect(rules(text, file)).toEqual(['CS_SOURCE_NETWORK_BOUNDARY']);
        }
      }
    );

    it('judges Source files only: other Content Studio code and look-alike names are left alone', () => {
      expect(rules(SAFE_FETCH_IMPORT)).toEqual([]);
      expect(rules('export const run = (u: string) => fetch(u);')).toEqual([]);
      expect(
        rules(
          SAFE_FETCH_IMPORT,
          at(
            'libraries/nestjs-libraries/src/content-studio/ai/ai.execution.service.ts'
          )
        )
      ).toEqual([]);
      expect(
        rules(
          [
            '// fetch(url) and axios are named in a comment only',
            "const label = 'fetch(url) through undici';",
            'export const fetched = (refetch: () => void) => refetch();',
            'export const run = (client: { fetch(u: string): void }) => client.fetch("x");',
          ].join('\n'),
          SOURCE_SERVICE
        )
      ).toEqual([]);
    });

    it('never prints the code it found', () => {
      const report = checkSource(
        SOURCE_SERVICE,
        "import axios from 'axios';\nexport const leak = 'SOURCE_GUARD_MARKER';"
      ).map(format);
      expect(report).toEqual([
        `libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts:1:1 [CS_SOURCE_NETWORK_BOUNDARY] ${MESSAGES.CS_SOURCE_NETWORK_BOUNDARY}`,
      ]);
      expect(report.join('\n')).not.toMatch(/axios'|SOURCE_GUARD_MARKER/);
    });
  });

  describe('CS_NO_RAW_HTML_SINK', () => {
    it.each([
      ['const view = <div dangerouslySetInnerHTML={{ __html: html }} />;'],
      ['const view = <Preview dangerouslySetInnerHTML={value} />;'],
      [
        'const view = <section dangerouslySetInnerHTML={props.value}></section>;',
      ],
      ['element.innerHTML = html;'],
      ["element['innerHTML'] = html;"],
      ['element.outerHTML = html;'],
      ['element["outerHTML"] = html;'],
      ['element.innerHTML += moreHtml;'],
      ['(element.innerHTML) = html;'],
      ['document.body.innerHTML = `<p>${text}</p>`;'],
    ])('rejects %s', (text) => {
      expect(rules(text, FIXTURE_TSX)).toEqual(['CS_NO_RAW_HTML_SINK']);
    });

    it.each([
      ['const value = element.innerHTML;'],
      ['const value = element.outerHTML;'],
      ['console.log(element.outerHTML);'],
      ['if (element.innerHTML === "") { reset(); }'],
      ['element.textContent = text;'],
      ["element.setAttribute('data-html', value);"],
      ['element.htmlFor = id; const innerHtml = value;'],
      ['const view = <div>{text}</div>;'],
      ['const view = <textarea value={text} />;'],
      ['const prop = { dangerouslySetInnerHTML: value };'],
      [
        "// element.innerHTML = html\nconst note = 'el.innerHTML = x and dangerouslySetInnerHTML';",
      ],
      ['const content = composerHtml(text); const item = { content };'],
    ])('allows %s', (text) => {
      expect(rules(text, FIXTURE_TSX)).toEqual([]);
    });

    it('reports each sink with its location and never the markup', () => {
      const text = [
        'export const View = ({ html }: { html: string }) => (',
        '  <div dangerouslySetInnerHTML={{ __html: html }} />',
        ');',
        'export function paint(el: HTMLElement, html: string) {',
        "  el.innerHTML = '<img src=x onerror=alert(1)>';",
        "  el['outerHTML'] += html;",
        '  const current = el.innerHTML;',
        '  el.textContent = current;',
        '}',
        'const key = process.env.KEY;',
      ].join('\n');
      const violations = checkSource(FIXTURE_TSX, text);

      expect(
        violations.map(({ line, column, rule }) => ({ line, column, rule }))
      ).toEqual([
        { line: 2, column: 8, rule: 'CS_NO_RAW_HTML_SINK' },
        { line: 5, column: 3, rule: 'CS_NO_RAW_HTML_SINK' },
        { line: 6, column: 3, rule: 'CS_NO_RAW_HTML_SINK' },
        { line: 10, column: 13, rule: 'CS_NO_PROCESS_ENV' },
      ]);
      const report = violations.map(format);
      expect(report[1]).toBe(
        `${FIXTURE_RELATIVE.replace(
          /\.ts$/,
          '.tsx'
        )}:5:3 [CS_NO_RAW_HTML_SINK] ${MESSAGES.CS_NO_RAW_HTML_SINK}`
      );
      expect(report.join('\n')).not.toMatch(/onerror|__html|<img/);
    });
  });

  describe('CS_AI_PROVIDER_IMPORT_BOUNDARY', () => {
    it.each([
      ["import OpenAI from 'openai';"],
      ["import { zodResponseFormat } from 'openai/helpers/zod';"],
      ["import type { ChatCompletion } from 'openai/resources';"],
      ["export * from 'openai';"],
      ["const sdk = require('openai');"],
      ["const load = () => import('openai');"],
      ["import Anthropic from '@anthropic-ai/sdk';"],
      ["import type { Message } from '@anthropic-ai/sdk/resources';"],
      ["import { generateText } from 'ai';"],
      ["import { createStreamableUI } from 'ai/rsc';"],
      ["import { createOpenAI } from '@ai-sdk/openai';"],
      ["import { createAnthropic } from '@ai-sdk/anthropic';"],
    ])('rejects %s outside the provider adapters', (text) => {
      expect(rules(text)).toEqual(['CS_AI_PROVIDER_IMPORT_BOUNDARY']);
    });

    it.each([
      ["import OpenAI from 'openai';"],
      ["import { zodResponseFormat } from 'openai/helpers/zod';"],
      ["import Anthropic from '@anthropic-ai/sdk';"],
    ])('allows %s in a provider adapter', (text) => {
      expect(rules(text, PROVIDER_FIXTURE)).toEqual([]);
    });

    it.each([
      ["import { generateText } from 'ai';"],
      ["import { createOpenAI } from '@ai-sdk/openai';"],
      ["import { createOpenAICompatible } from '@ai-sdk/openai-compatible';"],
    ])('rejects %s even in a provider adapter', (text) => {
      expect(rules(text, PROVIDER_FIXTURE)).toEqual([
        'CS_AI_PROVIDER_IMPORT_BOUNDARY',
      ]);
    });

    it.each([
      [
        "import { parseContentStudioAICredential } from './ai.provider.catalog';",
      ],
      [
        "import { secretBox } from '@gitroom/nestjs-libraries/services/secret.box';",
      ],
      ["import { z } from 'zod';"],
      ["import airtable from 'airtable';"],
      ["import { OpenaiConfig } from './openai.config';"],
    ])('allows %s', (text) => {
      expect(rules(text)).toEqual([]);
    });

    it.each([
      ['libraries/nestjs-libraries/src/content-studio/ai/providers/openai.ts'],
      ['libraries/nestjs-libraries/src/content-studio/ai/openai.provider.ts'],
      [
        'libraries/nestjs-libraries/src/content-studio/ai/providers/nested/openai.provider.ts',
      ],
      ['apps/backend/src/content-studio/ai/providers/openai.provider.ts'],
      [
        'libraries/nestjs-libraries/src/content-studio/ai/providers/openai.provider.tsx',
      ],
    ])('does not treat %s as a provider adapter', (file) => {
      expect(
        rules("import OpenAI from 'openai';", path.join(REPO_ROOT, file))
      ).toEqual(['CS_AI_PROVIDER_IMPORT_BOUNDARY']);
    });

    it('rejects a provider SDK added to the credential module', () => {
      const file = path.join(
        REPO_ROOT,
        'libraries/nestjs-libraries/src/content-studio/ai/ai.credential.ts'
      );
      const text = fs.readFileSync(file, 'utf8');
      expect(rules(text, file)).toEqual([]);
      expect(rules(`import OpenAI from 'openai';\n${text}`, file)).toEqual([
        'CS_AI_PROVIDER_IMPORT_BOUNDARY',
      ]);
    });
  });

  describe('CS_AI_EXPLICIT_CLIENT_OPTIONS', () => {
    const EXPLICIT: Record<string, string> = {
      apiKey: 'apiKey: credential.apiKey,',
      baseURL: 'baseURL: BASE_URL,',
      organization: 'organization: null,',
      project: 'project: null,',
      webhookSecret: 'webhookSecret: null,',
      logLevel: "logLevel: 'off',",
      maxRetries: 'maxRetries: 0,',
      timeout: 'timeout: TIMEOUT_MS,',
    };
    const client = (
      options: Record<string, string> = EXPLICIT,
      callee = 'OpenAI'
    ) =>
      [
        "import OpenAI from 'openai';",
        "const BASE_URL = 'https://api.openai.com/v1';",
        'const TIMEOUT_MS = 30_000;',
        'let MUTABLE_URL = BASE_URL;',
        'export const make = (credential: { apiKey: string }, sdk = { OpenAI }) =>',
        `  new ${callee}({ ${Object.values(options).join(' ')} });`,
      ].join('\n');
    const replaced = (name: string, line: string) => ({
      ...EXPLICIT,
      [name]: line,
    });

    it('allows a client with every option explicit, as module constants or literals', () => {
      expect(rules(client(), PROVIDER_FIXTURE)).toEqual([]);
      expect(rules(client(EXPLICIT, 'sdk.OpenAI'), PROVIDER_FIXTURE)).toEqual(
        []
      );
      expect(
        rules(
          client({
            ...EXPLICIT,
            baseURL: "baseURL: 'https://openrouter.ai/api/v1',",
            timeout: 'timeout: 30000,',
          }),
          PROVIDER_FIXTURE
        )
      ).toEqual([]);
    });

    it.each(Object.keys(EXPLICIT).map((name) => [name]))(
      'rejects a client without %s',
      (name) => {
        const options = { ...EXPLICIT };
        delete options[name];
        expect(rules(client(options), PROVIDER_FIXTURE)).toEqual([
          'CS_AI_EXPLICIT_CLIENT_OPTIONS',
        ]);
        expect(rules(client(options, 'sdk.OpenAI'), PROVIDER_FIXTURE)).toEqual([
          'CS_AI_EXPLICIT_CLIENT_OPTIONS',
        ]);
      }
    );

    it.each([
      ['apiKey', 'apiKey: undefined,'],
      ['apiKey', 'apiKey: void 0,'],
      ['apiKey', 'apiKey: null,'],
      ['apiKey', "apiKey: 'a-literal-key',"],
      ['apiKey', 'apiKey,'],
      ['baseURL', 'baseURL: undefined,'],
      ['baseURL', 'baseURL: null,'],
      ['baseURL', 'baseURL: url,'],
      ['baseURL', 'baseURL: MUTABLE_URL,'],
      ['baseURL', "baseURL: 'http://api.openai.com/v1',"],
      ['baseURL', "baseURL: 'https://evil.example/v1',"],
      ['baseURL', "baseURL: 'https://api.anthropic.com',"],
      ['baseURL', "baseURL: 'https://api.openai.com.evil.test/v1',"],
      ['baseURL', 'baseURL: `https://${host}/v1`,'],
      ['baseURL', "baseURL: BASE_URL + '/x?y',"],
      ['organization', 'organization: undefined,'],
      ['organization', "organization: 'org-1',"],
      ['project', 'project: undefined,'],
      ['project', 'project: credential.project,'],
      ['webhookSecret', 'webhookSecret: undefined,'],
      ['webhookSecret', "webhookSecret: '',"],
      ['logLevel', "logLevel: 'warn',"],
      ['logLevel', 'logLevel: level,'],
      ['logLevel', 'logLevel: undefined,'],
      ['maxRetries', 'maxRetries: 2,'],
      ['maxRetries', 'maxRetries: retries,'],
      ['maxRetries', 'maxRetries: undefined,'],
      ['timeout', 'timeout: 0,'],
      ['timeout', 'timeout: 600_000,'],
      ['timeout', 'timeout: ms,'],
      ['timeout', 'timeout: undefined,'],
    ])('rejects %s given as %s', (name, line) => {
      expect(rules(client(replaced(name, line)), PROVIDER_FIXTURE)).toEqual([
        'CS_AI_EXPLICIT_CLIENT_OPTIONS',
      ]);
    });

    it('rejects a base URL from the environment under both rules', () => {
      expect(
        rules(
          client(replaced('baseURL', 'baseURL: process.env.OPENAI_BASE_URL,')),
          PROVIDER_FIXTURE
        ).sort()
      ).toEqual(['CS_AI_EXPLICIT_CLIENT_OPTIONS', 'CS_NO_PROCESS_ENV']);
    });

    it.each([
      ['a spread', { ...EXPLICIT, spread: '...overrides,' }],
      ['a custom fetch', { ...EXPLICIT, fetch: 'fetch: customFetch,' }],
      ['default headers', { ...EXPLICIT, headers: 'defaultHeaders: {},' }],
      ['a repeated option', { ...EXPLICIT, again: 'maxRetries: 0,' }],
      ['a computed key', { ...EXPLICIT, apiKey: '[key]: credential.apiKey,' }],
    ])('rejects options with %s', (_name, options) => {
      expect(rules(client(options), PROVIDER_FIXTURE)).toEqual([
        'CS_AI_EXPLICIT_CLIENT_OPTIONS',
      ]);
    });

    it.each([
      ['new OpenAI();'],
      ['new OpenAI(options);'],
      ['new OpenAI({ ...options });'],
      [`new OpenAI(${OPTIONS}, extra);`],
    ])('rejects %s', (call) => {
      expect(
        rules(`export const make = (key: string) => ${call}`, PROVIDER_FIXTURE)
      ).toEqual(['CS_AI_EXPLICIT_CLIENT_OPTIONS']);
    });

    it('never prints the options it found', () => {
      const report = checkSource(
        PROVIDER_FIXTURE,
        "export const make = () => new OpenAI({ apiKey: 'sk-never-printed' });"
      ).map(format);
      expect(report).toEqual([
        `libraries/nestjs-libraries/src/content-studio/ai/providers/openai.provider.ts:1:27 [CS_AI_EXPLICIT_CLIENT_OPTIONS] ${MESSAGES.CS_AI_EXPLICIT_CLIENT_OPTIONS}`,
      ]);
    });
  });

  describe('CS_AI_EXPLICIT_CLIENT_OPTIONS for Anthropic', () => {
    const ANTHROPIC_FIXTURE = path.join(
      REPO_ROOT,
      'libraries/nestjs-libraries/src/content-studio/ai/providers/anthropic.provider.ts'
    );
    const EXPLICIT: Record<string, string> = {
      apiKey: 'apiKey: credential.apiKey,',
      authToken: 'authToken: null,',
      baseURL: 'baseURL: BASE_URL,',
      logLevel: "logLevel: 'off',",
      maxRetries: 'maxRetries: 0,',
      timeout: 'timeout: TIMEOUT_MS,',
    };
    const client = (
      options: Record<string, string> = EXPLICIT,
      callee = 'Anthropic'
    ) =>
      [
        "import Anthropic from '@anthropic-ai/sdk';",
        "const BASE_URL = 'https://api.anthropic.com';",
        'const TIMEOUT_MS = 30_000;',
        'let MUTABLE_URL = BASE_URL;',
        'export const make = (credential: { apiKey: string }, sdk = { Anthropic }) =>',
        `  new ${callee}({ ${Object.values(options).join(' ')} });`,
      ].join('\n');
    const replaced = (name: string, line: string) => ({
      ...EXPLICIT,
      [name]: line,
    });

    it('allows a client with every option explicit, as module constants or literals', () => {
      expect(rules(client(), ANTHROPIC_FIXTURE)).toEqual([]);
      expect(
        rules(client(EXPLICIT, 'sdk.Anthropic'), ANTHROPIC_FIXTURE)
      ).toEqual([]);
      expect(
        rules(
          client({
            ...EXPLICIT,
            baseURL: "baseURL: 'https://api.anthropic.com',",
            timeout: 'timeout: 30000,',
          }),
          ANTHROPIC_FIXTURE
        )
      ).toEqual([]);
    });

    it.each(Object.keys(EXPLICIT).map((name) => [name]))(
      'rejects a client without %s',
      (name) => {
        const options = { ...EXPLICIT };
        delete options[name];
        expect(rules(client(options), ANTHROPIC_FIXTURE)).toEqual([
          'CS_AI_EXPLICIT_CLIENT_OPTIONS',
        ]);
        expect(
          rules(client(options, 'sdk.Anthropic'), ANTHROPIC_FIXTURE)
        ).toEqual(['CS_AI_EXPLICIT_CLIENT_OPTIONS']);
      }
    );

    it.each([
      ['apiKey', 'apiKey: undefined,'],
      ['apiKey', 'apiKey: null,'],
      ['apiKey', "apiKey: 'a-literal-key',"],
      ['authToken', 'authToken: undefined,'],
      ['authToken', 'authToken: credential.apiKey,'],
      ['baseURL', 'baseURL: url,'],
      ['baseURL', 'baseURL: MUTABLE_URL,'],
      ['baseURL', "baseURL: 'http://api.anthropic.com',"],
      ['baseURL', "baseURL: 'https://api.openai.com/v1',"],
      ['baseURL', "baseURL: 'https://api.anthropic.com.evil.test',"],
      ['baseURL', 'baseURL: `https://${host}`,'],
      ['logLevel', "logLevel: 'debug',"],
      ['maxRetries', 'maxRetries: 2,'],
      ['timeout', 'timeout: 0,'],
      ['timeout', 'timeout: 600_000,'],
    ])('rejects %s given as %s', (name, line) => {
      expect(rules(client(replaced(name, line)), ANTHROPIC_FIXTURE)).toEqual([
        'CS_AI_EXPLICIT_CLIENT_OPTIONS',
      ]);
    });

    it.each([
      ['apiKey', 'apiKey: process.env.ANTHROPIC_API_KEY,'],
      ['baseURL', 'baseURL: process.env.ANTHROPIC_BASE_URL,'],
      ['authToken', 'authToken: process.env.ANTHROPIC_AUTH_TOKEN,'],
    ])('rejects %s from the environment under both rules', (name, line) => {
      expect(
        rules(client(replaced(name, line)), ANTHROPIC_FIXTURE).sort()
      ).toEqual(
        name === 'apiKey'
          ? ['CS_NO_PROCESS_ENV']
          : ['CS_AI_EXPLICIT_CLIENT_OPTIONS', 'CS_NO_PROCESS_ENV']
      );
    });

    it.each([
      ['a spread', { ...EXPLICIT, spread: '...overrides,' }],
      ['a custom fetch', { ...EXPLICIT, fetch: 'fetch: customFetch,' }],
      ['default headers', { ...EXPLICIT, headers: 'defaultHeaders: {},' }],
      ['an OpenAI only option', { ...EXPLICIT, project: 'project: null,' }],
      ['a repeated option', { ...EXPLICIT, again: 'maxRetries: 0,' }],
      ['a computed key', { ...EXPLICIT, apiKey: '[key]: credential.apiKey,' }],
    ])('rejects options with %s', (_name, options) => {
      expect(rules(client(options), ANTHROPIC_FIXTURE)).toEqual([
        'CS_AI_EXPLICIT_CLIENT_OPTIONS',
      ]);
    });

    it.each([
      ['new Anthropic();'],
      ['new Anthropic(options);'],
      ['new Anthropic({ ...options });'],
    ])('rejects %s', (call) => {
      expect(
        rules(`export const make = (key: string) => ${call}`, ANTHROPIC_FIXTURE)
      ).toEqual(['CS_AI_EXPLICIT_CLIENT_OPTIONS']);
    });

    it('does not accept OpenAI options for an Anthropic client', () => {
      expect(
        rules(
          `export const make = () => new Anthropic(${OPTIONS});`,
          ANTHROPIC_FIXTURE
        )
      ).toEqual(['CS_AI_EXPLICIT_CLIENT_OPTIONS']);
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
      { line: 1, column: 1, rule: 'CS_AI_PROVIDER_IMPORT_BOUNDARY' },
      { line: 2, column: 1, rule: 'CS_NO_LEGACY_AI_SERVICE' },
      { line: 3, column: 1, rule: 'CS_NO_SAFEFETCH_FACTORY' },
      { line: 4, column: 13, rule: 'CS_NO_PROCESS_ENV' },
      { line: 5, column: 18, rule: 'CS_NO_HARDCODED_AI_KEY' },
      { line: 6, column: 16, rule: 'CS_NO_GLOBAL_AI_CLIENT' },
      { line: 6, column: 16, rule: 'CS_AI_EXPLICIT_CLIENT_OPTIONS' },
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

  describe('Content Studio file discovery', () => {
    // Where Phase 1 puts its code, following the Postiz layout
    const included = [
      'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.repository.ts',
      'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.package.dto.ts',
      'libraries/helpers/src/content-studio/limits.ts',
      'apps/backend/src/api/routes/content-studio.controller.ts',
      'apps/backend/src/api/routes/content-studio/handoff.controller.ts',
      'apps/frontend/src/app/(app)/(site)/content-studio/page.tsx',
      'apps/frontend/src/app/(app)/(site)/content-studio/[id]/page.tsx',
      'apps/frontend/src/components/content-studio/package.workspace.tsx',
      'apps/frontend/src/components/launches/content-studio.handoff.opener.tsx',
      'apps/orchestrator/src/workflows/content-studio/render.ts',
      'apps/orchestrator/src/content-studio.worker.ts',
    ];
    const excluded = [
      'apps/backend/src/api/routes/media.controller.ts',
      'apps/backend/src/api/routes/copilot.controller.ts',
      'apps/frontend/src/components/media/media.component.tsx',
      'apps/frontend/src/components/launches/new.post.tsx',
      'apps/frontend/src/app/(app)/(site)/launches/page.tsx',
      'libraries/nestjs-libraries/src/openai/openai.service.ts',
      'libraries/nestjs-libraries/src/agent/agent.graph.service.ts',
      'libraries/nestjs-libraries/src/chat/load.tools.service.ts',
      // specs, tests and declarations, even inside Content Studio
      'apps/backend/src/api/routes/content-studio.controller.spec.ts',
      'libraries/nestjs-libraries/src/content-studio/content-studio.architecture.spec.ts',
      'apps/frontend/src/components/content-studio/package.workspace.test.tsx',
      'libraries/nestjs-libraries/src/content-studio/types.d.ts',
      // near misses: the name has to be content-studio, not contain it
      'apps/frontend/src/components/my-content-studio/list.tsx',
      'apps/frontend/src/components/launches/precontent-studio.tsx',
      'apps/frontend/src/components/launches/use.content-studio.tsx',
      // not TypeScript, or outside the source bases
      'apps/frontend/src/components/content-studio/readme.md',
      'apps/frontend/public/content-studio/script.ts',
      'content-studio/index.ts',
      'apps/frontend/content-studio.config.ts',
    ];
    const isContentStudioFile = (relative: string) =>
      isProduction(relative) && isContentStudioPath(relative);

    it.each(included.map((file) => [file]))('includes %s', (file) => {
      expect(isContentStudioFile(file)).toBe(true);
    });

    it.each(excluded.map((file) => [file]))('excludes %s', (file) => {
      expect(isContentStudioFile(file)).toBe(false);
    });

    // The same paths as real files in a scratch tree, walked by the real
    // walker; skipped folders are never entered
    it('walks the source bases and returns only Content Studio production files', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guard-'));
      try {
        const skipped = [
          'libraries/nestjs-libraries/src/content-studio/node_modules/x/index.ts',
          'apps/frontend/src/content-studio/.next/server/page.ts',
          'libraries/nestjs-libraries/src/content-studio/generated/client.ts',
          'apps/backend/src/content-studio/dist/main.ts',
        ];
        for (const file of [...included, ...excluded, ...skipped]) {
          fs.mkdirSync(path.dirname(path.join(root, file)), {
            recursive: true,
          });
          fs.writeFileSync(path.join(root, file), '');
        }

        expect(
          contentStudioFiles(root).map((file) => relativePath(root, file))
        ).toEqual([...included].sort());
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('real Content Studio tree', () => {
    const files = contentStudioFiles();

    it('resolves the source bases from the repository', () => {
      expect(fs.existsSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'))).toBe(true);
      for (const base of SOURCE_BASES) {
        expect(fs.statSync(path.join(REPO_ROOT, base)).isDirectory()).toBe(
          true
        );
      }
      // the walker does see this folder; only spec files are left out
      expect(contentStudioFiles(REPO_ROOT, isSource)).toContain(__filename);
      expect(files).not.toContain(__filename);
    });

    it('leaves legacy Postiz code out of the scan', () => {
      const seen = contentStudioFiles(REPO_ROOT, isSource).map((file) =>
        relativePath(REPO_ROOT, file)
      );
      for (const legacy of [
        'libraries/nestjs-libraries/src/openai/openai.service.ts',
        'libraries/nestjs-libraries/src/agent/agent.graph.service.ts',
        'libraries/nestjs-libraries/src/chat/load.tools.service.ts',
        'apps/backend/src/api/routes/copilot.controller.ts',
        'apps/frontend/src/components/launches/new.post.tsx',
        'apps/frontend/src/components/media/media.component.tsx',
      ]) {
        expect(fs.existsSync(path.join(REPO_ROOT, legacy))).toBe(true);
        expect(seen).not.toContain(legacy);
      }
      expect(seen.every(isContentStudioPath)).toBe(true);
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

    it('holds every provider adapter to one explicit SDK client', () => {
      const adapters = files
        .map((file) => relativePath(REPO_ROOT, file))
        .filter((file) => PROVIDER_ADAPTER_FILE.test(file));
      expect(adapters).toEqual([
        'libraries/nestjs-libraries/src/content-studio/ai/providers/anthropic.provider.ts',
        'libraries/nestjs-libraries/src/content-studio/ai/providers/openai.provider.ts',
        'libraries/nestjs-libraries/src/content-studio/ai/providers/openrouter.provider.ts',
      ]);
      for (const file of adapters) {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        const source = ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          true
        );
        const clients: ts.NewExpression[] = [];
        const collect = (node: ts.Node) => {
          if (ts.isNewExpression(node) && explicitClient(node)) {
            clients.push(node);
          }
          ts.forEachChild(node, collect);
        };
        collect(source);
        expect(clients).toHaveLength(1);
        expect(
          hasExplicitClientOptions(
            source,
            clients[0],
            explicitClient(clients[0]) as ExplicitClient
          )
        ).toBe(true);
        expect(rules(text, path.join(REPO_ROOT, file))).toEqual([]);
      }
    });

    it('lets only the provider adapters import a provider SDK', () => {
      const importers = files
        .filter((file) =>
          /from '(openai|@anthropic-ai\/sdk)(\/[^']*)?'/.test(
            fs.readFileSync(file, 'utf8')
          )
        )
        .map((file) => relativePath(REPO_ROOT, file));
      expect(importers).toEqual([
        'libraries/nestjs-libraries/src/content-studio/ai/providers/anthropic.provider.ts',
        'libraries/nestjs-libraries/src/content-studio/ai/providers/openai.provider.ts',
        'libraries/nestjs-libraries/src/content-studio/ai/providers/openrouter.provider.ts',
      ]);
      // the Anthropic SDK in its own adapter only, and no AI SDK wrapper
      expect(
        files
          .filter((file) =>
            /from '@anthropic-ai\/sdk(\/[^']*)?'/.test(
              fs.readFileSync(file, 'utf8')
            )
          )
          .map((file) => relativePath(REPO_ROOT, file))
      ).toEqual([
        'libraries/nestjs-libraries/src/content-studio/ai/providers/anthropic.provider.ts',
      ]);
      expect(
        files.filter((file) =>
          /@ai-sdk\/anthropic|@langchain\/anthropic/.test(
            fs.readFileSync(file, 'utf8')
          )
        )
      ).toEqual([]);
    });

    it('declares @anthropic-ai/sdk directly, at the pinned version', () => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
      );
      expect(manifest.dependencies['@anthropic-ai/sdk']).toBe('0.57.0');
      const lock = fs.readFileSync(
        path.join(REPO_ROOT, 'pnpm-lock.yaml'),
        'utf8'
      );
      expect(lock).toContain(
        "      '@anthropic-ai/sdk':\n        specifier: 0.57.0\n        version: 0.57.0\n"
      );
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(REPO_ROOT, 'node_modules/@anthropic-ai/sdk/package.json'),
            'utf8'
          )
        ).version
      ).toBe('0.57.0');
    });

    it('NG10 has exactly one SafeFetch importer in the Source layer: the ingestion service', () => {
      const sourceLayer = files
        .map((file) => relativePath(REPO_ROOT, file))
        .filter((file) => SOURCE_LAYER_FILE.test(file));
      expect(sourceLayer).toContain(SOURCE_INGESTION_FILE);
      expect(sourceLayer.length).toBeGreaterThan(5);
      const importers = sourceLayer.filter((file) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        const source = ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          true
        );
        let found = false;
        const visit = (node: ts.Node) => {
          const reference = moduleReferences(node);
          if (
            reference &&
            SAFE_FETCH_MODULE.test(
              normalizeModule(path.join(REPO_ROOT, file), reference.specifier)
            )
          ) {
            found = true;
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        return found;
      });
      expect(importers).toEqual([SOURCE_INGESTION_FILE]);
    });

    it(`has no violations in ${files.length} production file(s) under ${SOURCE_BASES.length} source bases`, () => {
      const violations = files.flatMap((file) =>
        checkSource(file, fs.readFileSync(file, 'utf8'))
      );
      expect(violations.map(format)).toEqual([]);
    });
  });
});
