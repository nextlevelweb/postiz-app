import { createElement as h, ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';
import { readFileSync } from 'fs';
import { join } from 'path';

// What changed in a source version (P8-04A) on Source detail: the actions on
// the current capture and on history rows, and the change view showing the
// server's answer as it is. A .spec.ts without JSX, like the other Content
// Studio frontend specs: components are required, not imported

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/content-studio/sources/x',
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModalCloseGuard: () => undefined,
  useModals: () => ({
    openModal: jest.fn(),
    closeAll: jest.fn(),
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: async () => true,
}));
jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: jest.fn() }),
}));
const mockFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));

const { ContentStudioSourceDetail } = require('./content-studio.source.detail');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const SOURCE = '11111111-1111-4111-8111-111111111111';
const FEED = '22222222-2222-4222-8222-222222222222';
const T1 = '2026-10-20T09:00:00.000Z';
const T2 = '2026-10-21T09:00:00.000Z';
const T3 = '2026-10-22T09:00:00.000Z';
const HTML_MARKER = '<img src=x onerror=alert(1)><b>bold</b>';
const vid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const versionSummary = (n: number, over: Record<string, unknown> = {}) => ({
  id: vid(n),
  versionNumber: n,
  schemaVersion: 1,
  extractionVersion: 'content-studio-source-v2',
  requestedUrl: 'https://example.com/pricing',
  finalUrl: 'https://example.com/pricing',
  redirectCount: 0,
  fetchedAt: [T1, T2, T3][n - 1] ?? T3,
  httpStatus: 200,
  contentType: 'text/html',
  contentLength: 1000,
  title: `Pricing ${n}`,
  contentHash: String(n).repeat(64),
  sourceHash: 'f'.repeat(64),
  createdAt: T1,
  ...over,
});

let source: Record<string, any>;
let versions: Array<Record<string, any>>;
let changes: Record<string, any>;
let changesReply: (versionId: string) => Reply | Promise<Reply>;

const compared = (n: number) => ({
  id: vid(n),
  versionNumber: n,
  fetchedAt: [T1, T2, T3][n - 1],
  title: `Pricing ${n}`,
  extractionVersion: 'content-studio-source-v2',
});
const contentChanged = () => ({
  source: {
    id: SOURCE,
    name: 'Pricing page',
    canonicalUrl: 'https://example.com/pricing',
  },
  after: compared(3),
  before: compared(1),
  repeatOf: null,
  change: 'content_changed',
  titleChanged: false,
  sameFetchedBytes: false,
  counts: {
    added: 3,
    removed: 1,
    unchanged: 40,
    beforeBlocks: 41,
    afterBlocks: 43,
  },
  blocks: [
    { change: 'unchanged', count: 12 },
    {
      change: 'removed',
      type: 'paragraph',
      level: null,
      text: 'Old price: 10 EUR.',
    },
    {
      change: 'added',
      type: 'paragraph',
      level: null,
      text: 'New price: 12 EUR.',
    },
    { change: 'added', type: 'heading', level: 2, text: 'Frequently asked' },
    { change: 'added', type: 'list_item', level: 1, text: HTML_MARKER },
    { change: 'unchanged', count: 28 },
  ],
});

const server = (url: string): Reply | Promise<Reply> => {
  const { pathname } = new URL(url, 'https://api.test');
  const base = `/content-studio/sources/${source.id}`;
  if (pathname === base) {
    return reply(200, {
      ...source,
      currentVersion: versions.length ? versions[versions.length - 1] : null,
    });
  }
  if (pathname === `${base}/versions`) {
    return reply(200, { pages: 1, results: [...versions].reverse() });
  }
  const change = pathname.match(/\/versions\/([^/]+)\/changes$/);
  if (change) {
    return changesReply(change[1]);
  }
  const one = versions.find((v) => pathname === `${base}/versions/${v.id}`);
  if (one) {
    return reply(200, {
      ...one,
      content: {
        schemaVersion: 1,
        blocks: [{ id: 'b1', type: 'paragraph', text: 'Body', level: null }],
      },
    });
  }
  if (pathname === `${base}/discoveries`) {
    return reply(200, { pages: 0, total: 0, results: [] });
  }
  return reply(404, { msg: 'Source not found.', code: 'CS_NOT_FOUND' });
};

beforeEach(() => {
  source = {
    id: SOURCE,
    kind: 'url',
    name: 'Pricing page',
    canonicalUrl: 'https://example.com/pricing',
    latestVersionNumber: 3,
    archivedAt: null,
    createdAt: T1,
    updatedAt: T3,
    lastCapturedAt: null,
  };
  versions = [versionSummary(1), versionSummary(2), versionSummary(3)];
  changes = contentChanged();
  changesReply = () => reply(200, changes);
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => server(url));
});
afterEach(() => cleanup());

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const renderDetail = async () => {
  const cache = new Map();
  const view = render(
    h(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      h(ContentStudioSourceDetail, { sourceId: source.id }) as ReactNode
    )
  );
  await flush();
  return view;
};
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const changeCalls = () =>
  mockFetch.mock.calls
    .map(([url, init]) => ({ url: url as string, init }))
    .filter(({ url }) => url.endsWith('/changes'));
const currentCapture = () =>
  screen.getByRole('heading', { name: 'Current capture' })
    .parentElement as HTMLElement;
const openCurrentChanges = async () => {
  await renderDetail();
  await click(
    within(currentCapture()).getByRole('button', { name: 'What changed' })
  );
};

describe('Source detail: what changed', () => {
  it('FE1 the current capture offers What changed from version 2 on, for that version', async () => {
    await openCurrentChanges();
    expect(changeCalls().map(({ url }) => url)).toEqual([
      `/content-studio/sources/${SOURCE}/versions/${vid(3)}/changes`,
    ]);
    // a GET with no body: the server chooses what it is compared with
    expect(changeCalls()[0].init?.method).toBeUndefined();
    expect(changeCalls()[0].init?.body).toBeUndefined();
  });

  it('FE2 there is nothing to compare with a single capture', async () => {
    source.latestVersionNumber = 1;
    versions = [versionSummary(1)];
    await renderDetail();
    expect(screen.queryByRole('button', { name: /What changed/ })).toBeNull();
  });

  it('FE3/FE4/M24 history rows from version 2 on have What changed beside View; version 1 has not', async () => {
    await renderDetail();
    for (const n of [2, 3]) {
      expect(
        screen.getByRole('button', { name: `What changed in Version ${n}` })
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: `View Version ${n}` })
      ).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'View Version 1' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'What changed in Version 1' })
    ).toBeNull();
    await click(
      screen.getByRole('button', { name: 'What changed in Version 2' })
    );
    expect(changeCalls().map(({ url }) => url)).toEqual([
      `/content-studio/sources/${SOURCE}/versions/${vid(2)}/changes`,
    ]);
  });

  it('FE5/FE10 content changed: the header, dates and counts as the server gave them', async () => {
    await openCurrentChanges();
    expect(
      screen.getByRole('heading', { name: 'Version 3 compared with Version 1' })
    ).toBeTruthy();
    expect(screen.getByText('Content changed')).toBeTruthy();
    expect(
      screen.getByText('+3 blocks added · −1 removed · 40 unchanged')
    ).toBeTruthy();
    expect(screen.queryByText(/Only the title changed/)).toBeNull();
    expect(screen.queryByText(/extractor/)).toBeNull();
    // no percentage or score
    expect(document.body.textContent).not.toMatch(/%|score/i);
  });

  it('FE11/FE12/FE13/FE14 added and removed blocks in order, kept runs collapsed, plain text only', async () => {
    const view = await openCurrentChanges().then(() => document.body);
    // the changes list, not the breadcrumb list of the navigation
    const changes = Array.from(view.querySelectorAll('ol')).find(
      (list) => !list.closest('nav')
    ) as HTMLElement;
    const items = within(changes).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '12 unchanged blocks',
      'RemovedOld price: 10 EUR.',
      'AddedNew price: 12 EUR.',
      'AddedFrequently asked',
      `Added•${HTML_MARKER}`,
      '28 unchanged blocks',
    ]);
    // the removed block is struck through, not hidden
    expect(
      within(items[1]).getByText('Old price: 10 EUR.').closest('.line-through')
    ).toBeTruthy();
    // block styling is the source view's: a heading is bold, a list item
    // keeps its level
    expect(within(items[3]).getByText('Frequently asked').className).toMatch(
      /font-\[600\]/
    );
    expect(
      (within(items[4]).getByText(HTML_MARKER).parentElement as HTMLElement)
        .style.paddingLeft
    ).toBe('20px');
    // M26 text, never markup
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('ol b')).toBeNull();
  });

  it('FE6 only the title changed, with a missing title shown as such', async () => {
    changes = {
      ...contentChanged(),
      before: { ...compared(1), title: null },
      after: { ...compared(3), title: 'Pricing 2026' },
      change: 'title_changed',
      titleChanged: true,
      counts: {
        added: 0,
        removed: 0,
        unchanged: 5,
        beforeBlocks: 5,
        afterBlocks: 5,
      },
      blocks: [{ change: 'unchanged', count: 5 }],
    };
    await openCurrentChanges();
    expect(screen.getByText('Only the title changed')).toBeTruthy();
    expect(
      screen.getByText('Title: No title captured → Pricing 2026')
    ).toBeTruthy();
    expect(screen.queryByText('Content changed')).toBeNull();
  });

  it('FE5 content changed with a new title shows the title too', async () => {
    changes = {
      ...contentChanged(),
      titleChanged: true,
      after: { ...compared(3), title: 'New' },
      before: { ...compared(1), title: 'Old' },
    };
    await openCurrentChanges();
    expect(screen.getByText('Content changed')).toBeTruthy();
    expect(screen.getByText('Title: Old → New')).toBeTruthy();
  });

  it('FE7/M25 another extraction is never called a content change: it says the extractor may have made the differences', async () => {
    changes = {
      ...contentChanged(),
      before: { ...compared(1), extractionVersion: 'content-studio-source-v1' },
      change: 'extraction_changed',
    };
    await openCurrentChanges();
    expect(
      screen.getByText(
        'Captured with a different extraction version: content-studio-source-v1 → content-studio-source-v2.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('Differences may come from the extractor, not the page.')
    ).toBeTruthy();
    expect(screen.queryByText('Content changed')).toBeNull();
    expect(screen.queryByText(/bytes were identical/)).toBeNull();
  });

  it('FE8 the same fetched bytes are stated when the server proved them', async () => {
    changes = {
      ...contentChanged(),
      before: { ...compared(1), extractionVersion: 'content-studio-source-v1' },
      change: 'extraction_changed',
      sameFetchedBytes: true,
    };
    await openCurrentChanges();
    expect(
      screen.getByText(
        'Differences may come from the extractor, not the page. The fetched page bytes were identical, so the visible differences come from extraction.'
      )
    ).toBeTruthy();
  });

  it('FE9/M27 a repeat names the capture it repeats, and with no earlier change compares nothing', async () => {
    changes = {
      ...contentChanged(),
      before: null,
      repeatOf: { id: vid(1), versionNumber: 1, fetchedAt: T1 },
      change: 'no_earlier_change',
      counts: {
        added: 0,
        removed: 0,
        unchanged: 0,
        beforeBlocks: 0,
        afterBlocks: 4,
      },
      blocks: [],
    };
    await openCurrentChanges();
    expect(screen.getByRole('heading', { name: 'Version 3' })).toBeTruthy();
    expect(
      screen.getByText(/^Same content, title and extraction as Version 1 \(/)
    ).toBeTruthy();
    expect(
      screen.getByText('No earlier different capture to compare with.')
    ).toBeTruthy();
    expect(screen.queryByText(/blocks added/)).toBeNull();
    expect(
      Array.from(document.querySelectorAll('ol')).filter(
        (list) => !list.closest('nav')
      )
    ).toEqual([]);
  });

  it('a repeat after a change states both: the repeat, then what its run changed', async () => {
    changes = {
      ...contentChanged(),
      repeatOf: { id: vid(2), versionNumber: 2, fetchedAt: T2 },
    };
    await openCurrentChanges();
    expect(
      screen.getByText(/^Same content, title and extraction as Version 2 \(/)
    ).toBeTruthy();
    expect(screen.getByText('Content changed')).toBeTruthy();
  });

  it('FE15 Back to history brings the history back, and View still works', async () => {
    await renderDetail();
    await click(
      screen.getByRole('button', { name: 'What changed in Version 3' })
    );
    expect(
      screen.queryByRole('heading', { name: 'Version history' })
    ).toBeNull();
    await click(screen.getByRole('button', { name: 'Back to history' }));
    expect(
      screen.getByRole('heading', { name: 'Version history' })
    ).toBeTruthy();
    expect(screen.queryByText('Content changed')).toBeNull();
  });

  it('FE16 shows loading until the answer arrives', async () => {
    let answer: (value: Reply) => void = () => undefined;
    changesReply = () => new Promise<Reply>((resolve) => (answer = resolve));
    await openCurrentChanges();
    expect(screen.queryByText('Content changed')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Version 3' })).toBeTruthy();
    await act(async () => answer(reply(200, changes)));
    await flush();
    expect(screen.getByText('Content changed')).toBeTruthy();
  });

  it('FE17 errors are fixed texts: integrity, missing, anything else', async () => {
    for (const [status, code, text] of [
      [
        500,
        'CS_SOURCE_INTEGRITY_ERROR',
        'Stored source data could not be read safely.',
      ],
      [404, 'CS_NOT_FOUND', 'This source version is no longer available.'],
      [503, 'SOMETHING', 'Changes could not be loaded.'],
    ] as const) {
      changesReply = () => reply(status, { msg: 'SERVER_DETAIL_MARKER', code });
      await openCurrentChanges();
      expect(screen.getByRole('alert').textContent).toBe(text);
      expect(document.body.textContent).not.toContain('SERVER_DETAIL_MARKER');
      cleanup();
    }
  });

  it('FE18 an archived page source can still be compared', async () => {
    source.archivedAt = T3;
    await openCurrentChanges();
    expect(screen.getByText('Content changed')).toBeTruthy();
  });

  it('FE19 a feed has no compare action', async () => {
    source = {
      ...source,
      id: FEED,
      kind: 'feed',
      latestVersionNumber: 0,
      canonicalUrl: 'https://example.com/feed.xml',
    };
    versions = [];
    await renderDetail();
    expect(screen.queryByRole('button', { name: /What changed/ })).toBeNull();
    expect(changeCalls()).toEqual([]);
  });

  it('opening a version then its changes shows one panel at a time', async () => {
    await renderDetail();
    await click(screen.getByRole('button', { name: 'View Version 3' }));
    expect(screen.getByText('Extracted content')).toBeTruthy();
    // the current capture's action still works while a version is open
    await click(
      within(currentCapture()).getByRole('button', { name: 'What changed' })
    );
    expect(screen.queryByText('Extracted content')).toBeNull();
    expect(screen.getByText('Content changed')).toBeTruthy();
  });
});

describe('Source detail: what changed, in the code', () => {
  const detail = readFileSync(
    join(__dirname, 'content-studio.source.detail.tsx'),
    'utf8'
  );
  const api = readFileSync(
    join(__dirname, 'content-studio.sources.api.ts'),
    'utf8'
  );

  it('39 the browser renders the answer: it never compares, classifies or picks a version', () => {
    const view = detail.slice(
      detail.indexOf('const SourceChangeView'),
      detail.indexOf('// The captures of a source, newest first')
    );
    expect(view).toContain('useContentStudioSourceVersionChanges(');
    expect(view).not.toMatch(
      /contentHash|sourceHash|isSameContentStudioSourceCapture|diffContentStudioSourceBlocks|Uint16Array|versionNumber - 1|\.sort\(/
    );
    expect(api).toMatch(
      /export const sourceVersionChangesPath = \(id: string, versionId: string\) =>\s*`\$\{sourceVersionPath\(id, versionId\)\}\/changes`;/
    );
  });

  it('51/52 no hard-coded colour and no HTML', () => {
    expect(detail).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    expect(detail).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(detail).not.toMatch(/(text|bg|border)-(red|green|yellow|blue)-\d/);
  });

  it('every new text has its English translation', () => {
    const en = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json'
        ),
        'utf8'
      )
    );
    const keys = Array.from(
      detail.matchAll(/'(content_studio_source_[a-z_]+)',\s*'([^']+)'/g)
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const [, key, fallback] of keys) {
      expect([key, en[key]]).toEqual([key, fallback]);
    }
  });
});
