import fs from 'fs';
import path from 'path';

// The decisions of the Source layer that are about what it must never become,
// pinned on the code: no HTML, no claim that a source is true, and network
// access through SafeFetch in the ingestion service only (the architecture
// guard's CS_SOURCE_NETWORK_BOUNDARY holds the same line). Comments and string literals
// are stripped first: comments explain these rules and messages may use plain
// words. Behavior is covered by the parser, repository and service specs
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

const SOURCES_DIRECTORY =
  'libraries/nestjs-libraries/src/content-studio/sources';
const LAYER_FILES = [
  'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
  'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
  'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts',
];
const SOURCE_FILES = [
  ...fs
    .readdirSync(path.join(REPO_ROOT, SOURCES_DIRECTORY))
    .filter((file) => /\.ts$/.test(file) && !/\.spec\.ts$/.test(file))
    .map((file) => `${SOURCES_DIRECTORY}/${file}`),
  ...LAYER_FILES,
];
// The one Source file that may fetch, and only through safeFetch
const INGESTION_FILE = `${SOURCES_DIRECTORY}/ingestion/source.ingestion.service.ts`;
const ALL_FILES = [...SOURCE_FILES, INGESTION_FILE];

// The controller's source routes: from the first to the next section
const controllerRoutes = () => {
  const text = read('apps/backend/src/api/routes/content-studio.controller.ts');
  const start = text.indexOf("@Get('/sources')");
  const end = text.indexOf("@Get('/writing-profiles')");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

const schemaFields = (model: string) => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const match = schema.match(
    new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`)
  );
  if (!match) {
    throw new Error(`model ${model} not found`);
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((field) => field && !field.startsWith('@@'));
};
const MODEL_FIELDS = [
  ...schemaFields('ContentStudioSource'),
  ...schemaFields('ContentStudioSourceVersion'),
];

const identifiers = (text: string) =>
  Array.from(new Set(code(text).match(/[A-Za-z_$][\w$]*/g) || []));

describe('Source layer boundaries', () => {
  it('finds the Source production files it guards', () => {
    expect(SOURCE_FILES.sort()).toEqual(
      [
        `${SOURCES_DIRECTORY}/source.content.ts`,
        `${SOURCES_DIRECTORY}/source.extract.ts`,
        `${SOURCES_DIRECTORY}/source.types.ts`,
        `${SOURCES_DIRECTORY}/source.url.ts`,
        `${SOURCES_DIRECTORY}/source.version.ts`,
        ...LAYER_FILES,
      ].sort()
    );
    expect(
      fs
        .readdirSync(path.join(REPO_ROOT, SOURCES_DIRECTORY, 'ingestion'))
        .filter((file) => !/\.spec\.ts$/.test(file))
    ).toEqual(['source.ingestion.service.ts']);
  });

  it('64 stores and returns structured text only: no HTML field anywhere', () => {
    const HTML = /^(raw|rendered|sanitized|body|inner|outer)?html$/i;
    expect(MODEL_FIELDS.filter((field) => HTML.test(field))).toEqual([]);
    for (const file of ALL_FILES) {
      expect([
        file,
        identifiers(read(file)).filter(
          (name) =>
            HTML.test(name) ||
            /^(dangerouslySetInnerHTML|innerHTML|outerHTML)$/.test(name)
        ),
      ]).toEqual([file, []]);
    }
    expect(
      identifiers(controllerRoutes()).filter((name) => HTML.test(name))
    ).toEqual([]);
  });

  it('65 records provenance, never truth: no verification, fact or credibility field', () => {
    // "Verified" in parseVerifiedContentStudioSourceVersion is about stored
    // bytes matching their hash, not about facts; it is the one allowed name
    const FACTUAL =
      /^(verified|verifiedAt|isVerified|factChecked|factCheck|factual|facts|truthScore|isTrue|true_?claim|claimVerified|reliabilityScore|credibilityScore|confidenceScore|trustScore|trusted|isTrusted|accurate|accuracy|proven)$/i;
    const INTEGRITY_ONLY = new Set(['parseVerifiedContentStudioSourceVersion']);
    expect(MODEL_FIELDS.filter((field) => FACTUAL.test(field))).toEqual([]);
    expect(
      MODEL_FIELDS.filter((field) =>
        /verif|fact|truth|credib|trust/i.test(field)
      )
    ).toEqual([]);
    for (const file of ALL_FILES) {
      const names = identifiers(read(file));
      expect([file, names.filter((name) => FACTUAL.test(name))]).toEqual([
        file,
        [],
      ]);
      expect([
        file,
        names.filter(
          (name) =>
            /verif|factcheck|truth|credib/i.test(name) &&
            !INTEGRITY_ONLY.has(name)
        ),
      ]).toEqual([file, []]);
    }
    expect(
      identifiers(controllerRoutes()).filter((name) =>
        /verif|fact|truth|credib|trust/i.test(name)
      )
    ).toEqual([]);
  });

  it('67 makes no network request: Source code imports nothing that could', () => {
    // An allow-list, so a new HTTP client, DNS lookup or SafeFetch import is
    // caught whatever its name. Ingestion through SafeFetch comes with its own
    // module and its own rules
    const ALLOWED = [
      /^zod$/,
      /^crypto$/,
      /^@nestjs\/common$/,
      /^@prisma\/client$/,
      /^class-validator$/,
      /^class-transformer$/,
      /^@gitroom\/nestjs-libraries\/content-studio\/(canonical\.json|editorial\/writing\.profile|sources\/source\.[a-z]+)$/,
      /^@gitroom\/nestjs-libraries\/database\/prisma\/(prisma\.service|content-studio\/content-studio\.source\.repository)$/,
      /^@gitroom\/nestjs-libraries\/dtos\/content-studio\/content-studio\.project\.dto$/,
      // the inert HTML parser of the extractor
      /^parse5$/,
    ];
    for (const file of SOURCE_FILES) {
      const text = read(file);
      const imports = Array.from(
        text.matchAll(/^import[\s\S]*?from '([^']+)';$/gm),
        (match) => match[1]
      );
      // source.types.ts imports nothing; every other file does
      expect(imports.length > 0 || file.endsWith('/source.types.ts')).toBe(
        true
      );
      expect([
        file,
        imports.filter((target) => !ALLOWED.some((rule) => rule.test(target))),
      ]).toEqual([file, []]);
      expect([
        file,
        code(text).match(
          /\bfetch\(|\brequire\(|\bimport\(|XMLHttpRequest|WebSocket|axios|undici|safeFetch|createSafeFetch|\bdns\b|\bnet\.|process\.env/g
        ),
      ]).toEqual([file, null]);
    }
  });

  it('67 lets the ingestion service fetch through safeFetch and nothing else', () => {
    const text = read(INGESTION_FILE);
    const imports = Array.from(
      text.matchAll(/^import[\s\S]*?from '([^']+)';$/gm),
      (match) => match[1]
    );
    expect(imports).toContain(
      '@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'
    );
    const ALLOWED = [
      /^@nestjs\/common$/,
      /^@prisma\/client$/,
      /^crypto$/,
      /^@gitroom\/nestjs-libraries\/dtos\/webhooks\/safe\.fetch$/,
      /^@gitroom\/nestjs-libraries\/database\/prisma\/content-studio\/content-studio\.source\.(repository|service)$/,
      /^@gitroom\/nestjs-libraries\/content-studio\/sources\/source\.[a-z]+$/,
    ];
    expect(
      imports.filter((target) => !ALLOWED.some((rule) => rule.test(target)))
    ).toEqual([]);
    const body = code(text);
    expect(body).not.toMatch(
      /\bfetch\(|\brequire\(|\bimport\(|XMLHttpRequest|WebSocket|axios|undici|createSafeFetch|\bdns\b|\bnet\.|lookup\(|process\.env|console\.|Logger/
    );
    // one call, with the fixed policy constants
    expect(body.match(/\bsafeFetch\(/g)).toHaveLength(1);
  });

  it('67 keeps the controller source routes free of fetching and version writes', () => {
    const routes = code(controllerRoutes());
    expect(routes).not.toMatch(
      /\bfetch\(|safeFetch|axios|undici|appendVersion/i
    );
    // refresh hands the source id to the ingestion service, nothing else
    expect(
      routes.match(/_contentStudioSourceIngestionService\./g)
    ).toHaveLength(1);
  });
});
