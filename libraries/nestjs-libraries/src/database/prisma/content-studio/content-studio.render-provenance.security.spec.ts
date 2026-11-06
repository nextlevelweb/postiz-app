import fs from 'fs';
import path from 'path';

// P4-05 trust boundaries, pinned on the source: who may read stored Media
// bytes and private fonts, what the render path may import, and that no
// request can name an asset, a URL or a path

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const BASES = [
  'libraries/nestjs-libraries/src',
  'libraries/helpers/src',
  'apps/backend/src',
  'apps/orchestrator/src',
  'apps/frontend/src',
];
const SKIPPED = new Set(['node_modules', 'dist', '.next', 'generated']);

const walk = (directory: string): string[] =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return SKIPPED.has(entry.name) ? [] : walk(full);
        }
        return /\.tsx?$/.test(entry.name) &&
          !/\.(spec|test)\.tsx?$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
          ? [full]
          : [];
      })
    : [];

const PRODUCTION = BASES.flatMap((base) =>
  walk(path.join(REPO_ROOT, base))
).map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
// code only: comments may name what the code must not do
const code = (file: string) =>
  read(file)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
const users = (pattern: RegExp) =>
  PRODUCTION.filter((file) => pattern.test(code(file))).sort();

const LIB = 'libraries/nestjs-libraries/src';
const CS = `${LIB}/database/prisma/content-studio`;
const P405_FILES = [
  `${LIB}/content-studio/design/render/design.render.snapshot.ts`,
  `${CS}/content-studio.render-font.repository.ts`,
  `${CS}/content-studio.render-font.service.ts`,
  `${CS}/content-studio.design-render.repository.ts`,
  `${CS}/content-studio.design-render.service.ts`,
  `${CS}/content-studio.render-media.bridge.ts`,
  `${LIB}/dtos/content-studio/content-studio.design-render.dto.ts`,
  `${LIB}/upload/stored.media.reader.ts`,
  `${LIB}/upload/stored.asset.factory.ts`,
  `${LIB}/upload/content-studio.private-font.storage.ts`,
];

describe('P4-05 render provenance trust boundaries', () => {
  it('lists the P4-05 production files', () => {
    for (const file of P405_FILES) {
      expect(PRODUCTION).toContain(file);
    }
  });

  it('P405-1 only the Media bridge reads stored Media bytes, and only the render and font services use private font storage', () => {
    expect(users(/createStoredMediaReader\(/)).toEqual([
      `${CS}/content-studio.render-media.bridge.ts`,
      `${LIB}/upload/stored.asset.factory.ts`,
    ]);
    expect(users(/\.readStoredMediaBytes\(/)).toEqual([
      `${CS}/content-studio.render-media.bridge.ts`,
    ]);
    expect(users(/createContentStudioPrivateFontStorage\(/)).toEqual([
      `${CS}/content-studio.design-render.service.ts`,
      `${CS}/content-studio.render-font.service.ts`,
      `${LIB}/upload/stored.asset.factory.ts`,
    ]);
    expect(users(/\.readFontAsset\(/)).toEqual([
      `${CS}/content-studio.design-render.service.ts`,
    ]);
    expect(users(/\.writeFontAsset\(/)).toEqual([
      `${CS}/content-studio.render-font.service.ts`,
    ]);
    // P4-08: the design reference service reads Media bytes through it too
    expect(users(/ContentStudioRenderMediaBridge\b/)).toEqual([
      `${CS}/content-studio.design-reference.service.ts`,
      `${CS}/content-studio.design-render.service.ts`,
      `${CS}/content-studio.render-media.bridge.ts`,
      `${LIB}/database/prisma/database.module.ts`,
    ]);
    expect(users(/\.saveGeneratedFile\(/)).toEqual([
      `${CS}/content-studio.render-media.bridge.ts`,
    ]);
  });

  it('P405-2/M29 the render path never fetches over the network', () => {
    for (const file of P405_FILES) {
      expect(code(file)).not.toMatch(
        /\bfetch\(|XMLHttpRequest|from '(axios|undici|node-fetch|got|https?|http2|net|tls|dns)'|safe\.fetch|ssrfSafeDispatcher|signDownloadUrl|signUploadUrl/
      );
    }
  });

  it('P405-3 the render and font services take no URL, path or storage key from a caller', () => {
    for (const file of [
      `${CS}/content-studio.design-render.service.ts`,
      `${CS}/content-studio.render-font.service.ts`,
      `${CS}/content-studio.render-media.bridge.ts`,
    ]) {
      const text = code(file);
      expect(text).not.toMatch(/\b(url|href|src|filePath|fileName)\b\s*[:?]/i);
      expect(text).not.toMatch(/from 'fs'|from 'path'|process\.env/);
    }
    expect(code(`${CS}/content-studio.render-font.service.ts`)).not.toMatch(
      /originalname|mimetype/
    );
  });

  it('P405-4/P405-5 the layout engine is used by the renderer only, and the renderer by the render service only', () => {
    expect(users(/\blayoutContentStudioDesign\(/)).toEqual([
      `${LIB}/content-studio/design/layout/design.layout.ts`,
      `${LIB}/content-studio/design/render/design.renderer.ts`,
    ]);
    expect(users(/\brenderContentStudioDesignPage\(/)).toEqual([
      `${LIB}/content-studio/design/render/design.renderer.ts`,
      `${CS}/content-studio.design-render.service.ts`,
    ]);
    expect(users(/validateContentStudioRenderFontBytes\(/)).toEqual([
      `${LIB}/content-studio/design/render/design.render.fonts.ts`,
      `${CS}/content-studio.render-font.service.ts`,
    ]);
    // no layout or drawing in P4-05 code
    for (const file of P405_FILES) {
      expect(code(file)).not.toMatch(
        /fontkit|from 'sharp'|layoutContentStudioDesignText|layoutContentStudioDesignImageGeometry|<svg|buildContentStudioDesignPageSvg/
      );
    }
  });

  it('P405-6/P405-7 no browser, Fabric, AI or Source code on the render path', () => {
    for (const file of P405_FILES) {
      expect(code(file)).not.toMatch(
        /fabric|puppeteer|playwright|jsdom|canvas|globalThis\.document|\bwindow\.|content-studio\/ai\/|ai-connection|ai-writing|content-studio\/sources\/|source\.service/i
      );
    }
  });

  it('P405-8 the snapshot holds ids, semantics and hashes only', () => {
    const text = code(
      `${LIB}/content-studio/design/render/design.render.snapshot.ts`
    );
    expect(text.match(/\.strict\(\)/g)).toHaveLength(4);
    const schema = text.slice(
      text.indexOf('const fontRequest'),
      text.indexOf('const snapshotSchema')
    );
    // the requested tuple and its hash, then a mapping and its asset, or a
    // bundled default font by its fixed id
    expect(
      schema.match(/^\s{2,4}(\w+):/gm)?.map((key) => key.trim())
    ).toEqual([
      'family:',
      'weight:',
      'style:',
      'sha256:',
      'mappingId:',
      'fontAssetId:',
      'defaultFontId:',
      'mediaId:',
      'sha256:',
    ]);
    expect(schema).not.toMatch(
      /\b(url|path|storageKey|bytes|base64|fileName|contentType)\s*:/
    );
  });

  it('P405-10 the render body names only the revision and the page', () => {
    const dto = read(
      `${LIB}/dtos/content-studio/content-studio.design-render.dto.ts`
    );
    const render = dto.slice(
      dto.indexOf('export class RenderContentStudioDesignDto'),
      dto.indexOf('// Every page of exactly this revision')
    );
    expect(
      render.match(/^\s+(\w+): \w+;$/gm)?.map((line) => line.trim())
    ).toEqual(['revisionId: string;', 'pageId: string;']);
    const upload = dto.slice(
      dto.indexOf('export class UploadContentStudioRenderFontDto')
    );
    expect(
      upload.match(/^\s+(\w+): \w+;$/gm)?.map((line) => line.trim())
    ).toEqual(['family: string;', 'weight: number;', 'style: string;']);
  });

  it('keeps generic Media without fonts: the upload allow-lists and the Media schema are unchanged', () => {
    for (const file of [
      `${LIB}/upload/local.storage.ts`,
      `${LIB}/upload/cloudflare.storage.ts`,
      `${LIB}/upload/r2.uploader.ts`,
      `${LIB}/upload/custom.upload.validation.ts`,
      `${LIB}/upload/upload.factory.ts`,
      `${LIB}/upload/upload.interface.ts`,
    ]) {
      expect(read(file)).not.toMatch(/font|CONTENT_STUDIO/i);
    }
    const media = read(`${LIB}/database/prisma/media/media.service.ts`);
    expect(media).not.toMatch(/font|content-studio|StoredAssetFactory/i);
  });

  it('keeps private fonts out of the public upload tree and the public bucket', () => {
    const storage = code(
      `${LIB}/upload/content-studio.private-font.storage.ts`
    );
    expect(storage).not.toMatch(
      /process\.env|FRONTEND_URL|\/uploads|publicUrl|CLOUDFLARE_BUCKET_URL|ACL/
    );
    const factory = code(`${LIB}/upload/stored.asset.factory.ts`);
    const fonts = factory.slice(
      factory.indexOf('static createContentStudioPrivateFontStorage'),
      factory.indexOf('private static _cloudflareClient')
    );
    expect(fonts).not.toMatch(/CLOUDFLARE_BUCKET_URL|FRONTEND_URL/);
    expect(fonts).toContain(
      'process.env.CONTENT_STUDIO_PRIVATE_ASSET_DIRECTORY'
    );
    expect(fonts).toContain('process.env.CONTENT_STUDIO_PRIVATE_R2_BUCKET');
  });
});
