import fs from 'fs';
import path from 'path';
import { devFrontendOrigins } from '@gitroom/backend/dev.frontend.origins';

// The backend's LAN dev origins (CORS) need positive proof of development:
// NODE_ENV=development and POSTIZ_ALLOWED_DEV_ORIGINS. Production, test and
// an unset NODE_ENV (the image does not set it) add nothing, so the origins
// stay FRONTEND_URL and the fixed ones in main.ts
const REPO_ROOT = path.resolve(__dirname, '../../..');
const raw = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const LAN = {
  FRONTEND_URL: 'http://192.168.1.201:4200',
  POSTIZ_ALLOWED_DEV_ORIGINS: '192.168.1.201',
};

describe('devFrontendOrigins', () => {
  it('CORSENV1 development with dev origins set: localhost, 127.0.0.1 and the listed hosts, on the frontend protocol and port', () => {
    expect(devFrontendOrigins({ ...LAN, NODE_ENV: 'development' })).toEqual([
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://192.168.1.201:4200',
    ]);
  });

  it('CORSENV1 development without dev origins: nothing is added', () => {
    for (const value of [undefined, '', ' , ']) {
      expect(
        devFrontendOrigins({
          FRONTEND_URL: LAN.FRONTEND_URL,
          POSTIZ_ALLOWED_DEV_ORIGINS: value,
          NODE_ENV: 'development',
        })
      ).toEqual([]);
    }
  });

  it('CORSENV2 production: nothing is added, even with dev origins set', () => {
    expect(devFrontendOrigins({ ...LAN, NODE_ENV: 'production' })).toEqual([]);
  });

  it('CORSENV3 NODE_ENV unset (as the image runs the backend): nothing is added, even with dev origins set', () => {
    expect(devFrontendOrigins({ ...LAN })).toEqual([]);
    expect(devFrontendOrigins({ ...LAN, NODE_ENV: '' })).toEqual([]);
  });

  it('CORSENV4 test, or anything that is not exactly development: nothing is added', () => {
    for (const NODE_ENV of ['test', 'staging', 'Development', 'dev']) {
      expect(devFrontendOrigins({ ...LAN, NODE_ENV })).toEqual([]);
    }
  });

  it('CORSENV5 a malformed host is never an origin: no scheme, port, path, wildcard or space', () => {
    expect(
      devFrontendOrigins({
        ...LAN,
        NODE_ENV: 'development',
        POSTIZ_ALLOWED_DEV_ORIGINS:
          'http://evil.example,evil.example:80,evil.example/x,*.example,192.168.1.0/24,a b, 192.168.1.201 ',
      })
    ).toEqual([
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://192.168.1.201:4200',
    ]);
  });

  it('CORSENV5 no valid FRONTEND_URL: nothing is added', () => {
    expect(
      devFrontendOrigins({
        ...LAN,
        FRONTEND_URL: 'not a url',
        NODE_ENV: 'development',
      })
    ).toEqual([]);
  });

  it('CORSENV6 main.ts keeps FRONTEND_URL as the first origin and only spreads the dev origins after it', () => {
    const main = raw('apps/backend/src/main.ts');
    expect(main).toMatch(
      /origin: \[\s*process\.env\.FRONTEND_URL,\s*\.\.\.devFrontendOrigins\(\),\s*'http:\/\/localhost:6274',/
    );
    expect(main).not.toMatch(/POSTIZ_ALLOWED_DEV_ORIGINS/);
  });

  it('CORSENV7 the local dev wrapper runs the backend as development; the example env sets no NODE_ENV', () => {
    expect(raw('scripts/content-studio-dev-db.sh')).toMatch(
      /^export NODE_ENV=development$/m
    );
    expect(raw('.env.example')).not.toMatch(/^NODE_ENV=/m);
    expect(raw('.env.example')).toMatch(/^POSTIZ_ALLOWED_DEV_ORIGINS=""$/m);
  });
});
