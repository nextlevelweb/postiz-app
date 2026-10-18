import fs from 'fs';
import path from 'path';

// The browser-safe boundary of the design modules (P4-07): the layout engine
// and the Creative Studio preview reach no Node module, no hashing and no
// server code through any import, however deep. Stored-content integrity is
// proven where content is read from storage (the server services), never in
// code a browser loads. Type-only imports are erased by the compiler and are
// not followed

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ALIASES: Array<[string, string]> = [
  ['@gitroom/nestjs-libraries/', 'libraries/nestjs-libraries/src/'],
  ['@gitroom/frontend/', 'apps/frontend/src/'],
  ['@gitroom/react/', 'libraries/react-shared-libraries/src/'],
  ['@gitroom/helpers/', 'libraries/helpers/src/'],
];
const CREATIVE_STUDIO =
  /^apps\/frontend\/src\/components\/content-studio\/content-studio\.(designs(\.api)?|design\.[a-z]+|api)\.tsx?$/;

const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
// code only: comments may name what the code must not do
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const resolve = (from: string, specifier: string) => {
  let base: string | null = null;
  if (specifier.startsWith('.')) {
    base = path.posix.join(path.posix.dirname(from), specifier);
  }
  for (const [alias, target] of ALIASES) {
    if (specifier.startsWith(alias)) {
      base = target + specifier.slice(alias.length);
    }
  }
  if (base === null) {
    return null;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unresolved import ${specifier} in ${from}`);
};

// Value imports and re-exports of a file; `import type` is left out
const valueImports = (text: string) =>
  Array.from(
    code(text).matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?'([^']+)'/g
    ),
    (match) => match[1]
  ).concat(
    Array.from(
      code(text).matchAll(/\brequire\(\s*'([^']+)'\s*\)/g),
      (m) => m[1]
    )
  );

// Every module reached from the entries: library files and Creative Studio
// files are followed, other app modules (React UI, SWR) are listed only
const graph = (entries: string[]) => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const specifier of valueImports(read(file))) {
      const target = resolve(file, specifier);
      if (target === null) {
        packages.add(specifier);
      } else if (
        target.startsWith('libraries/nestjs-libraries/src/') ||
        CREATIVE_STUDIO.test(target)
      ) {
        queue.push(target);
      } else {
        packages.add(specifier);
      }
    }
  }
  return {
    files: Array.from(files).sort(),
    packages: Array.from(packages).sort(),
  };
};

const FORBIDDEN =
  /^(node:.*|crypto|fs|path|os|child_process|buffer|http|https|net|tls|dns|sharp|fontkit|canvas|fabric|konva|playwright|puppeteer|@prisma\/client|@nestjs\/.*)$/;
const NODE_ONLY = /\bBuffer\b|\bprocess\.|\b__dirname\b|\brequire\(/;

const LAYOUT =
  'libraries/nestjs-libraries/src/content-studio/design/layout/design.layout.ts';
const PREVIEW =
  'apps/frontend/src/components/content-studio/content-studio.design.preview.tsx';
const WORKSPACE =
  'apps/frontend/src/components/content-studio/content-studio.design.workspace.tsx';

describe('design modules: browser-safe boundary', () => {
  it('BS1/BS2/BS3/M27 the layout engine reaches no Node module, hashing, Sharp or fontkit', () => {
    const { files, packages } = graph([LAYOUT]);
    expect(packages).toEqual(['zod']);
    expect(files).toEqual([
      'libraries/nestjs-libraries/src/content-studio/brand/brand.kit.ts',
      'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts',
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts',
      'libraries/nestjs-libraries/src/content-studio/design/layout/design.layout.text.ts',
      'libraries/nestjs-libraries/src/content-studio/design/layout/design.layout.ts',
      'libraries/nestjs-libraries/src/content-studio/design/layout/design.layout.types.ts',
      'libraries/nestjs-libraries/src/content-studio/editorial/writing.profile.ts',
    ]);
    for (const file of files) {
      expect([file, code(read(file))]).not.toEqual([
        file,
        expect.stringMatching(NODE_ONLY),
      ]);
    }
  });

  it('BS1/BS3/28/M28/M29 the Creative Studio preview and workspace reach no Node module, renderer, layout, hashing or server code', () => {
    const { files, packages } = graph([PREVIEW, WORKSPACE]);
    for (const specifier of packages) {
      expect(specifier).not.toMatch(FORBIDDEN);
    }
    const library = files.filter((file) => file.startsWith('libraries/'));
    expect(library).toEqual([
      'libraries/nestjs-libraries/src/content-studio/brand/brand.kit.ts',
      'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts',
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts',
      // P4-15: the pure Layout Pattern v1 parser, extraction and placement;
      // its hashing and built-ins stay server-side
      'libraries/nestjs-libraries/src/content-studio/design/design.layout.pattern.ts',
      // P4-13: the pure Style Preset v1 parser, extraction and apply; its
      // hashing and built-ins stay server-side
      'libraries/nestjs-libraries/src/content-studio/design/design.style.preset.ts',
      'libraries/nestjs-libraries/src/content-studio/editorial/writing.profile.ts',
    ]);
    for (const file of files) {
      expect([file, code(read(file))]).not.toEqual([
        file,
        expect.stringMatching(NODE_ONLY),
      ]);
    }
    expect(files).toEqual(
      expect.arrayContaining([
        PREVIEW,
        WORKSPACE,
        'apps/frontend/src/components/content-studio/content-studio.designs.api.ts',
        'apps/frontend/src/components/content-studio/content-studio.designs.tsx',
      ])
    );
  });

  it('BS8 integrity of stored Brand Kit and Design revisions stays on the server: only services hash and verify', () => {
    const users = (pattern: RegExp) => {
      const walk = (dir: string): string[] =>
        fs
          .readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
          .flatMap((entry) =>
            entry.isDirectory()
              ? entry.name === 'node_modules'
                ? []
                : walk(`${dir}/${entry.name}`)
              : /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
              ? [`${dir}/${entry.name}`]
              : []
          );
      return [
        ...walk('libraries/nestjs-libraries/src/content-studio'),
        ...walk(
          'libraries/nestjs-libraries/src/database/prisma/content-studio'
        ),
        ...walk('apps/frontend/src/components/content-studio'),
      ]
        .filter((file) => pattern.test(code(read(file))))
        .sort();
    };
    expect(users(/parseVerifiedContentStudioBrandKitRevision\(/)).toEqual([
      'libraries/nestjs-libraries/src/content-studio/brand/brand.kit.revision.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.brand-kit.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-reference.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design-render.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.service.ts',
    ]);
    // the layout and the render pipeline call no storage hashing of the kit
    expect(users(/storedContentStudioBrandKitContent\(/)).toEqual([
      'libraries/nestjs-libraries/src/content-studio/brand/brand.kit.revision.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.brand-kit.service.ts',
    ]);
  });
});
