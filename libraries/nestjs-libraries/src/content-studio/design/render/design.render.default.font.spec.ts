import fs from 'fs';
import path from 'path';
import { validateContentStudioRenderFontBytes } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.fonts';
import { designRenderSha256 } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

const FONTS = path.join(__dirname, 'fonts');
const PINNED = {
  'NotoSans-Regular.ttf':
    'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
  'NotoSans-Bold.ttf':
    '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
};

// a fresh copy of the module, so its once-per-process cache starts empty
const load = () => {
  let loaded!: typeof import('@gitroom/nestjs-libraries/content-studio/design/render/design.render.default.font');
  jest.isolateModules(() => {
    loaded = require('@gitroom/nestjs-libraries/content-studio/design/render/design.render.default.font');
  });
  return loaded;
};

afterEach(() => jest.restoreAllMocks());

describe('bundled default render font', () => {
  it('DFM1 ships exactly the pinned Noto Sans files with their OFL license and provenance', () => {
    expect(fs.readdirSync(FONTS).sort()).toEqual([
      'FONTLOG.txt',
      'NotoSans-Bold.ttf',
      'NotoSans-Regular.ttf',
      'OFL.txt',
    ]);
    for (const [file, sha256] of Object.entries(PINNED)) {
      const bytes = fs.readFileSync(path.join(FONTS, file));
      expect(designRenderSha256(bytes)).toBe(sha256);
      // a single TrueType font the renderer accepts, as an upload would be
      expect(validateContentStudioRenderFontBytes(bytes)).toEqual({
        format: 'ttf',
      });
    }
    const license = fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(license).toContain('The Noto Project Authors');
    const log = fs.readFileSync(path.join(FONTS, 'FONTLOG.txt'), 'utf8');
    for (const sha256 of Object.values(PINNED)) {
      expect(log).toContain(sha256);
    }
  });

  it('DFM2 keeps the license file under a name the Docker build context keeps', () => {
    const ignore = fs.readFileSync(
      path.join(__dirname, '../../../../../../.dockerignore'),
      'utf8'
    );
    // LICENSE and *.md files are left out of the image
    expect(ignore).toMatch(/^\*\*\/LICENSE$/m);
    expect(ignore).toMatch(/^\*\*\/\*\.md$/m);
    expect(fs.existsSync(path.join(FONTS, 'OFL.txt'))).toBe(true);
  });

  it('DFM3 picks Regular up to weight 500 and Bold from 600, for either style', () => {
    const { contentStudioDefaultRenderFontId } = load();
    expect(
      [100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) =>
        contentStudioDefaultRenderFontId({ weight })
      )
    ).toEqual([
      'noto-sans-regular',
      'noto-sans-regular',
      'noto-sans-regular',
      'noto-sans-regular',
      'noto-sans-regular',
      'noto-sans-bold',
      'noto-sans-bold',
      'noto-sans-bold',
      'noto-sans-bold',
    ]);
  });

  it('DFM4 reads each file once per process and hands out copies', () => {
    const read = jest.spyOn(fs, 'readFileSync');
    const { readContentStudioDefaultRenderFont } = load();
    const first = readContentStudioDefaultRenderFont('noto-sans-regular');
    first!.bytes.fill(0);
    const second = readContentStudioDefaultRenderFont('noto-sans-regular');
    expect(designRenderSha256(second!.bytes)).toBe(
      PINNED['NotoSans-Regular.ttf']
    );
    expect(second!.sha256).toBe(PINNED['NotoSans-Regular.ttf']);
    expect(
      read.mock.calls.filter((call) =>
        String(call[0]).endsWith('NotoSans-Regular.ttf')
      )
    ).toHaveLength(1);
  });

  it('DFM5 a missing or changed file is unavailable, never other bytes, and is checked again later', () => {
    const real = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync');
    const { readContentStudioDefaultRenderFont } = load();
    read.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(readContentStudioDefaultRenderFont('noto-sans-bold')).toBeNull();
    read.mockImplementationOnce(
      (file) => Buffer.concat([real(file as string), Buffer.from([0])]) as never
    );
    expect(readContentStudioDefaultRenderFont('noto-sans-bold')).toBeNull();
    expect(readContentStudioDefaultRenderFont('noto-sans-bold')?.sha256).toBe(
      PINNED['NotoSans-Bold.ttf']
    );
    expect(
      readContentStudioDefaultRenderFont('inter-regular' as never)
    ).toBeNull();
  });

  it('DFM6 reads only its own folder: no system font, URL or other path', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'design.render.default.font.ts'),
      'utf8'
    );
    expect(text.match(/readFileSync\(/g)).toHaveLength(1);
    expect(text).toContain(
      "readFileSync(path.join(__dirname, 'fonts', font.file))"
    );
    expect(text).not.toMatch(/https?:|\/usr\/|\/System\/|fontconfig|fetch\(/);
  });
});
