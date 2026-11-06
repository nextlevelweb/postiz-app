import { createElement as h } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SWRConfig } from 'swr';

// A .spec.ts without JSX, like the other Content Studio frontend specs:
// components are required, not imported
const mockFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
const mockToast = jest.fn();
jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: mockToast }),
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: jest.fn(), closeAll: jest.fn() }),
}));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: jest.fn(),
}));
let mockRole = 'USER';
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'user-1', role: mockRole }),
}));

const { ContentStudioRenderFonts } = require('./content-studio.render-fonts');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const FONT = {
  id: '11111111-1111-4111-8111-111111111111',
  family: 'Acme Sans',
  weight: 700,
  style: 'normal',
  disabledAt: null,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
};
let fonts: unknown[] = [];
let uploadReply: Reply = reply(201, FONT);

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body,
  }));
const writes = () => calls().filter((c) => c.method !== 'GET');

const show = () =>
  render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(ContentStudioRenderFonts)
    )
  );

beforeEach(() => {
  mockRole = 'USER';
  fonts = [];
  uploadReply = reply(201, FONT);
  mockFetch.mockReset();
  mockToast.mockReset();
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET' && url === '/content-studio/render-fonts') {
      return reply(200, fonts);
    }
    if (url === '/content-studio/render-fonts/upload') {
      return uploadReply;
    }
    if (url.endsWith('/disable') || url.endsWith('/enable')) {
      return reply(200, { ...FONT, disabledAt: '2026-11-06T11:00:00.000Z' });
    }
    return reply(404, {});
  });
});
afterEach(cleanup);

const file = (bytes: number, name = 'acme.ttf') =>
  new File([new Uint8Array(bytes)], name, { type: 'font/ttf' });
const fill = (family: string, upload: File) => {
  fireEvent.change(screen.getByLabelText('Family'), {
    target: { value: family },
  });
  fireEvent.change(screen.getByLabelText('Weight'), {
    target: { value: '700' },
  });
  fireEvent.change(screen.getByLabelText('Font file (.ttf or .otf)'), {
    target: { files: [upload] },
  });
};

describe('Render fonts', () => {
  it('RF1 shows the built-in Noto Sans and the organization fonts to every member, without upload or toggles', async () => {
    fonts = [FONT];
    show();
    expect(screen.getByText('Noto Sans · Built-in font')).toBeTruthy();
    expect(await screen.findByText('Acme Sans · 700 · Normal')).toBeTruthy();
    expect(screen.getByText('Used for new renders')).toBeTruthy();
    expect(screen.queryByText('Upload a font')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(
      screen.getByText(
        'An organization administrator can upload your brand fonts.'
      )
    ).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('RF2 says designs use the built-in font when none is uploaded', async () => {
    show();
    expect(
      await screen.findByText(
        'No fonts uploaded. Designs use the built-in font.'
      )
    ).toBeTruthy();
  });

  it('RF3 an administrator uploads the file with exactly the tuple, then the list reloads', async () => {
    mockRole = 'ADMIN';
    show();
    await screen.findByText('No fonts uploaded. Designs use the built-in font.');
    const upload = file(16);
    fill('  Acme Sans ', upload);
    fireEvent.click(screen.getByRole('button', { name: 'Save font' }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Render font saved.', 'success')
    );
    const [sent] = writes();
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/content-studio/render-fonts/upload');
    const body = sent.body as FormData;
    const keys: string[] = [];
    body.forEach((_value, key) => keys.push(key));
    expect(keys).toEqual(['family', 'weight', 'style', 'file']);
    expect(body.get('family')).toBe('Acme Sans');
    expect(body.get('weight')).toBe('700');
    expect(body.get('style')).toBe('normal');
    expect(body.get('file')).toBe(upload);
    expect(
      calls().filter(
        (c) => c.method === 'GET' && c.url === '/content-studio/render-fonts'
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  it('RF4 refuses a file over 32 MB and a missing family before anything is sent', async () => {
    mockRole = 'SUPERADMIN';
    show();
    await screen.findByText('No fonts uploaded. Designs use the built-in font.');
    fill('Acme', file(33_554_433));
    fireEvent.click(screen.getByRole('button', { name: 'Save font' }));
    expect(
      await screen.findByText('The font file is larger than 32 MB.')
    ).toBeTruthy();
    fill('', file(16));
    fireEvent.click(screen.getByRole('button', { name: 'Save font' }));
    expect(
      await screen.findByText('Enter the font family and choose a font file.')
    ).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('RF5 without private font storage it says uploads wait but designs still render', async () => {
    mockRole = 'ADMIN';
    uploadReply = reply(503, { code: 'CS_RENDER_FONT_STORAGE_UNAVAILABLE' });
    show();
    await screen.findByText('No fonts uploaded. Designs use the built-in font.');
    fill('Acme', file(16));
    fireEvent.click(screen.getByRole('button', { name: 'Save font' }));
    expect(
      await screen.findByText(
        'Private render font storage is not configured, so fonts cannot be uploaded yet. Designs still render with the built-in font.'
      )
    ).toBeTruthy();
  });

  it('RF6 an administrator disables a font by its id only', async () => {
    mockRole = 'ADMIN';
    fonts = [FONT];
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(writes()).toEqual([
        {
          method: 'POST',
          url: `/content-studio/render-fonts/${FONT.id}/disable`,
          body: undefined,
        },
      ])
    );
  });
});
