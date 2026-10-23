import React, { createElement as h } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cleanup, render } from '@testing-library/react';

// Mobile polish of the app shell (aa3622bb, a4d10cb6, 3c705d4d): the sidebar
// logo is 44px on phones and 60px from `sm` (tablets and desktop) up, the
// agency settings get 4px side padding on phones only, and the selected
// settings tab on phones uses the theme's button text color: the tab keeps
// its bgColorInner background, so the brand action text (dark navy for a
// white label) would be unreadable on it in dark mode. The logo is rendered,
// with and without a white-label logo; the two settings screens need a
// signed-in SUPERADMIN, so their classes are pinned on the source
const MOBILE = ['w-[44px]', 'h-[44px]', 'min-w-[44px]', 'min-h-[44px]'];
const FROM_SM = [
  'sm:w-[60px]',
  'sm:h-[60px]',
  'sm:min-w-[60px]',
  'sm:min-h-[60px]',
];

const renderLogo = (logoUrl: string | undefined) => {
  const previous = process.env.NEXT_PUBLIC_BRAND_LOGO_URL;
  if (logoUrl === undefined) delete process.env.NEXT_PUBLIC_BRAND_LOGO_URL;
  else process.env.NEXT_PUBLIC_BRAND_LOGO_URL = logoUrl;
  try {
    let Logo: React.FC = () => null;
    jest.isolateModules(() => {
      ({ Logo } = require('@gitroom/frontend/components/new-layout/logo'));
    });
    const { container } = render(h(Logo));
    return container.firstElementChild as Element;
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_BRAND_LOGO_URL;
    else process.env.NEXT_PUBLIC_BRAND_LOGO_URL = previous;
  }
};
const classes = (element: Element) =>
  (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

const source = (file: string) =>
  readFileSync(join(__dirname, '..', file), 'utf8');

describe('mobile polish of the app shell', () => {
  afterEach(cleanup);

  it.each([
    ['the white-label logo', 'https://brand.example/logo.png', 'IMG'],
    ['the Postiz logo', undefined, 'svg'],
  ])(
    'MBL1/MBL2/MBL5 %s is 44px on phones and 60px from sm up',
    (_, logoUrl, tag) => {
      const logo = renderLogo(logoUrl);
      expect(logo.tagName).toBe(tag);
      const list = classes(logo);
      expect(list).toEqual(
        expect.arrayContaining(['mt-[8px]', ...MOBILE, ...FROM_SM])
      );
      // no unprefixed 60px size left to override the phone size
      expect(
        list.filter((name) => /^(min-)?[wh]-|^min-[wh]-/.test(name))
      ).toEqual(MOBILE);
      expect(list.filter((name) => name.startsWith('sm:'))).toEqual(FROM_SM);
      // the intrinsic size stays 60, the desktop size
      expect([logo.getAttribute('width'), logo.getAttribute('height')]).toEqual(
        ['60', '60']
      );
      if (tag === 'IMG') {
        expect(list).toContain('object-contain');
        expect(logo.getAttribute('src')).toBe(logoUrl);
      }
    }
  );

  it('MBL3 the agency settings get 4px side padding on phones only', () => {
    const agency = source('settings/agency.component.tsx');
    expect(agency).toMatch(
      /if \(user\?\.role !== 'SUPERADMIN'\) \{\s*return null;\s*\}\s*return \(\s*<div className="flex flex-col px-\[4px\] sm:px-0">\s*<div\s+className="rounded-\[10px\] p-\[20px\] mb-\[20px\] text-white relative overflow-hidden"/
    );
  });

  it('MBL4 the selected settings tab on phones uses the theme button text', () => {
    const settings = source('layout/settings.component.tsx');
    const strip = settings.slice(
      settings.indexOf(
        '<div className="xl:hidden flex gap-[8px] overflow-x-auto pb-[4px] shrink-0">'
      ),
      settings.indexOf('<FormProvider')
    );
    expect(strip).toContain(
      `'shrink-0 whitespace-nowrap rounded-full px-[14px] py-[10px] bg-newBgColorInner border border-newTableBorder',`
    );
    expect(strip).toMatch(
      /tabKey === tab &&\s*'bg-\[var\(--brand-primary\)\] text-btnText border-\[var\(--brand-primary\)\]'/
    );
    expect(strip).not.toContain('brand-action-text');
  });

  it('MBL5 the desktop settings menu is unchanged', () => {
    const settings = source('layout/settings.component.tsx');
    expect(settings).toContain(
      '<div className="bg-newBgColorInner p-[20px] hidden xl:flex flex-col transition-all w-[260px] shrink-0">'
    );
    expect(settings).toContain(
      `'cursor-pointer flex items-center gap-[12px] group/profile hover:bg-boxHover rounded-e-[8px] mobile:shrink-0 mobile:whitespace-nowrap mobile:rounded-[8px] mobile:px-[12px] mobile:py-[8px]',`
    );
    expect(settings).toMatch(/tabKey === tab && 'bg-boxHover'/);
  });
});
