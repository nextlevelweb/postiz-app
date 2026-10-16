import fs from 'fs';
import path from 'path';

// P4-06 boundaries, pinned on the source: the request names one revision
// only, every input is frozen before the first page, pages run one after the
// other through the one renderer, and nothing exports, archives or fetches

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const LIB = 'libraries/nestjs-libraries/src';
const CS = `${LIB}/database/prisma/content-studio`;
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
// code only: comments may name what the code must not do
const code = (file: string) =>
  read(file)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const SERVICE = `${CS}/content-studio.design-render.service.ts`;
const BATCH_REPOSITORY = `${CS}/content-studio.design-render-batch.repository.ts`;
const DTO = `${LIB}/dtos/content-studio/content-studio.design-render.dto.ts`;
const CONTROLLER = 'apps/backend/src/api/routes/content-studio.controller.ts';
const SNAPSHOT = `${LIB}/content-studio/design/render/design.render.snapshot.ts`;
const P406_FILES = [SERVICE, BATCH_REPOSITORY, DTO, SNAPSHOT];

const method = (text: string, name: string, next: string) =>
  text.slice(text.indexOf(name), text.indexOf(next, text.indexOf(name)));

describe('P4-06 render-all trust boundaries', () => {
  it('P406-1/P406-2 the render-all body is the revision id only: no page list or order', () => {
    const dto = read(DTO);
    const renderAll = method(
      dto,
      'export class RenderAllContentStudioDesignDto',
      '// The multipart fields'
    );
    expect(
      renderAll.match(/^\s+(\w+): \w+;$/gm)?.map((line) => line.trim())
    ).toEqual(['revisionId: string;']);
  });

  it('P406-3 the controller takes the organization and user from the request and the design from the path', () => {
    const block = method(
      read(CONTROLLER),
      "@Post('/designs/:id/render-all')",
      '// Render fonts:'
    );
    expect(block).toContain('organizationId: org.id,');
    expect(block).toContain('userId: user.id,');
    expect(block).toContain('designId: id,');
    expect(block).toContain('revisionId: body.revisionId,');
    expect(block.match(/body\.\w+/g)).toEqual(['body.revisionId']);
    expect(block).not.toMatch(/CheckPolicies|Role\.|assertManager/);
  });

  it('P406-4/P406-5 fonts, then images, are loaded once before the first page, and the pages only reuse them', () => {
    const text = code(SERVICE);
    const all = method(text, 'async renderAllPages(', 'private fontRequests(');
    const fonts = all.indexOf('this.preloadFonts(');
    const images = all.indexOf('this.preloadImages(');
    const loop = all.indexOf(
      'for (const [index, page] of document.pages.entries())'
    );
    expect(fonts).toBeGreaterThan(-1);
    expect(fonts).toBeLessThan(images);
    expect(images).toBeLessThan(loop);
    const body = all.slice(loop, all.indexOf('} catch (err) {', loop));
    expect(body).toContain('assets: async () => ({ fonts, images }),');
    expect(body).not.toMatch(
      /preload|getActiveMappingBySpec|readFontAsset|readMediaBytes|readImage|getRevision|brandRevision|designRevision/
    );
    // one page after the other
    expect(text).not.toMatch(/Promise\.(all|allSettled|any|race)\(/);
  });

  it('P406-6/P406-7 adds no network path and no storage provider', () => {
    for (const file of P406_FILES) {
      expect(code(file)).not.toMatch(
        /\bfetch\(|from '(axios|undici|node-fetch|got|https?|http2|net|tls|dns)'|safe\.fetch|S3Client|from 'fs'|createStorage\(/
      );
    }
    expect(
      fs
        .readdirSync(path.join(REPO_ROOT, `${LIB}/upload`))
        .filter((f) => !/\.spec\.ts$/.test(f))
        .sort()
    ).toEqual([
      'clipping.processor.interface.ts',
      'cloudflare.storage.ts',
      'content-studio.private-font.storage.ts',
      'custom.upload.validation.ts',
      'data.url.ts',
      'local.storage.ts',
      'media.processor.interface.ts',
      'multer.stream.engine.ts',
      'r2.uploader.ts',
      'runpod.media.processor.ts',
      'stored.asset.factory.ts',
      'stored.media.reader.ts',
      'upload.factory.ts',
      'upload.interface.ts',
      'upload.module.ts',
    ]);
  });

  it('P406-8/122/123 renders through the one page renderer only: no layout, Sharp or fontkit', () => {
    const text = code(SERVICE);
    expect(text).toMatch(
      /import \{ renderContentStudioDesignPage \} from '@gitroom\/nestjs-libraries\/content-studio\/design\/render\/design\.renderer';/
    );
    expect(text.match(/renderContentStudioDesignPage\(/g)).toHaveLength(1);
    expect(text).not.toMatch(
      /layoutContentStudioDesign|design\/layout\/design\.layout'|from 'sharp'|fontkit|buildContentStudioDesignPageSvg|rasterize/
    );
    expect(code(SNAPSHOT)).not.toMatch(
      /layoutContentStudioDesign|layoutRect|layoutItemGeometry/
    );
  });

  it('P406-9 the frontend calls render-all from the Creative Studio API only, with the revision id only', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return entry.name === 'node_modules' ? [] : walk(full);
        }
        return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
          ? [full]
          : [];
      });
    const frontend = walk(path.join(REPO_ROOT, 'apps/frontend/src'));
    const API =
      'apps/frontend/src/components/content-studio/content-studio.designs.api.ts';
    expect(
      frontend
        .filter((file) =>
          /render-all|renderAllPages/.test(fs.readFileSync(file, 'utf8'))
        )
        .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    ).toEqual([API]);
    expect(code(API)).toMatch(
      /`\$\{designPath\(id\)\}\/render-all`,\s*\{\s*method: 'POST',\s*body: JSON\.stringify\(\{ revisionId \}\),\s*\}/
    );
  });

  it('P406-10/92 no ZIP, PDF, GIF, video, Fabric, browser or AI on the render-all path', () => {
    for (const file of P406_FILES) {
      expect(code(file)).not.toMatch(
        /archiver|jszip|adm-zip|yazl|pdfkit|pdf-lib|jspdf|ffmpeg|\bgif\b|image\/gif|fabric|puppeteer|playwright|jsdom|content-studio\/ai\/|ai-writing|ai-connection/i
      );
    }
  });
});
