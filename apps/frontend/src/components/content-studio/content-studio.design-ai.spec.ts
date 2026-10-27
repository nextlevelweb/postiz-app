import { createElement as h, useEffect } from 'react';
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
import { TextEncoder as NodeTextEncoder } from 'util';
import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  describeContentStudioDesignAIProposal,
  resolveContentStudioDesignAIProposal,
} from '@gitroom/nestjs-libraries/content-studio/design/design.ai.proposal';

// P6-02: the AI suggestions panel of Creative Studio, with the real design
// editor hook and the real pure proposal code; only the network, the toaster
// and translations are stand-ins. Components are required, not imported, so
// the spec type check doesn't follow them (as in the other frontend specs)
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});
jest.mock('next/navigation', () => ({
  usePathname: () => '/content-studio',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
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
  deleteDialog: jest.fn(async () => true),
}));
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

const { DesignAISuggestions } = require('./content-studio.design-ai');
const {
  useContentStudioDesignEditor,
} = require('./content-studio.design.editing');

const ROOT = join(__dirname, '../../../../..');
const DESIGN = '60200000-0000-4000-8000-0000000000a1';
const REV_3 = '60200000-0000-4000-8000-0000000000b3';
const REV_4 = '60200000-0000-4000-8000-0000000000b4';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const SUMMARY = 'Tighter, warmer words.';

const document3: ContentStudioDesignDocumentV1 =
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit: null,
    pages: [
      {
        id: 'page_1',
        name: '',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#ffffff' },
        },
        layers: [
          {
            id: 'l_title',
            name: 'Title',
            type: 'text',
            x: 80,
            y: 80,
            width: 920,
            height: 300,
            rotation: 0,
            opacity: 1,
            visible: true,
            text: 'Spring sale',
            font: {
              type: 'family',
              family: 'Arial',
              weight: 400,
              style: 'normal',
            },
            fontSize: 72,
            lineHeight: 1.2,
            letterSpacing: 0,
            color: { type: 'literal', value: '#000000' },
            align: 'left',
            verticalAlign: 'top',
            overflow: 'shrink',
          },
          {
            id: 'l_box',
            name: '',
            type: 'shape',
            shape: 'rectangle',
            x: 0,
            y: 800,
            width: 1080,
            height: 280,
            rotation: 0,
            opacity: 1,
            visible: true,
            fill: { type: 'literal', value: '#eeeeee' },
            cornerRadius: 0,
          },
        ],
      },
    ],
  });

const base = (revisionId = REV_3, revisionNumber = 3) => ({
  designId: DESIGN,
  revisionId,
  revisionNumber,
  contentHash: 'c'.repeat(64),
});

// the server's answer, made with the same pure code the server uses
const suggestion = (
  raw = JSON.stringify({
    summary: SUMMARY,
    operations: [{ type: 'set_text', layer: 'TEXT_1', text: 'Spring is here' }],
  }),
  intent = 'improve_copy' as const
) => {
  const proposal = resolveContentStudioDesignAIProposal({
    document: document3,
    brand: null,
    intent,
    raw,
  });
  return {
    operationId: 'op-1',
    base: base(),
    proposal,
    proposalHash: 'h'.repeat(64),
    changes: describeContentStudioDesignAIProposal(document3, proposal),
    ai: { provider: 'openai', model: 'gpt-6-luna', promptVersion: 'v' },
  };
};

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
let connections: unknown[];
let propose: (body: any) => Reply | Promise<Reply>;
const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const writes = () => calls().filter((c) => c.method !== 'GET');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

beforeEach(() => {
  connections = [
    {
      id: CONNECTION,
      name: 'Team',
      provider: 'openai',
      defaultModel: 'gpt-6-luna',
      disabled: false,
      credentialPresent: true,
    },
  ];
  propose = () => reply(200, suggestion());
  mockFetch.mockReset();
  mockToast.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (method === 'POST' && url.endsWith('/ai/propose')) {
      return propose(JSON.parse(init.body as string));
    }
    if (url === '/content-studio/ai/connections') {
      return reply(200, connections);
    }
    if (url === '/content-studio/ai/providers') {
      return reply(200, [
        {
          provider: 'openai',
          displayName: 'OpenAI',
          credentialFields: [],
          defaultModel: 'gpt-6.1-sol',
          models: [{ id: 'gpt-6-luna', label: 'Luna' }],
        },
      ]);
    }
    if (method === 'GET') {
      return reply(200, { pages: 0, results: [] });
    }
    return reply(500, {});
  });
});
afterEach(() => cleanup());

// the panel with a real editor, as the workspace holds it
const harness: { editor: any } = { editor: null };
const Harness = ({
  baseRevision,
  brandReady = true,
}: {
  baseRevision: ReturnType<typeof base> | null;
  brandReady?: boolean;
}) => {
  const editor = useContentStudioDesignEditor(DESIGN);
  useEffect(() => {
    harness.editor = editor;
  });
  harness.editor = editor;
  return h(DesignAISuggestions, {
    base: baseRevision,
    document: document3,
    brand: null,
    brandReady,
    editor,
  });
};
const show = async (
  baseRevision: ReturnType<typeof base> | null = base(),
  brandReady = true
) => {
  const view = render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(Harness, { baseRevision, brandReady })
    )
  );
  await flush();
  return view;
};
const rerenderWith = async (
  view: ReturnType<typeof render>,
  baseRevision: ReturnType<typeof base> | null
) => {
  view.rerender(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(Harness, { baseRevision })
    )
  );
  await flush();
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) =>
  screen.queryByRole('button', { name });
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const open = async () => click(button('Open AI suggestions'));
const generate = async () => click(button('Generate suggestion'));
const section = () => screen.getByRole('region', { name: 'AI suggestions' });

describe('Creative Studio AI suggestions (P6-02)', () => {
  it('FE1/FE2/FE3 a closed panel loads nothing; opened it offers the intents, the connection and an instruction', async () => {
    await show();
    expect(section()).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
    await open();
    const intent = screen.getByLabelText('Suggestion') as HTMLSelectElement;
    expect(Array.from(intent.options).map((option) => option.value)).toEqual([
      'improve_copy',
      'tighten_copy',
      'adapt_tone',
      'improve_hierarchy',
      'restyle',
      'rebalance_layout',
    ]);
    expect(screen.getByLabelText('AI connection')).toBeTruthy();
    expect(screen.getByLabelText('Additional instruction')).toBeTruthy();
    // copy suggestions can use the profiles; style and layout cannot
    expect(screen.getByLabelText('Writing Profile')).toBeTruthy();
    fireEvent.change(intent, { target: { value: 'restyle' } });
    await flush();
    expect(screen.queryByLabelText('Writing Profile')).toBeNull();
    // FE14: no image, Media or generation control
    expect(section().textContent).not.toMatch(
      /image generat|generate image|upload|media/i
    );
    expect(section().querySelector('input[type="file"]')).toBeNull();
  });

  it('FE5 without a usable connection it points to Brand & AI and offers no Generate', async () => {
    connections = [];
    await show();
    await open();
    expect(
      screen.getByText(
        'Connect an AI provider in Brand & AI to get design suggestions.'
      )
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Brand & AI' })).toBeTruthy();
    expect(queryButton('Generate suggestion')).toBeNull();
  });

  it('FE4 Generate needs the saved current revision shown and no unsaved changes', async () => {
    const view = await show(null);
    await open();
    expect((button('Generate suggestion') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      screen.getByText(
        'Suggestions are made for the current revision. Go back to the current revision to ask for one.'
      )
    ).toBeTruthy();
    await rerenderWith(view, base());
    expect((button('Generate suggestion') as HTMLButtonElement).disabled).toBe(
      false
    );
    // an unsaved change blocks asking: it would not be in the suggestion
    act(() => {
      harness.editor.begin({ id: REV_3, revisionNumber: 3 }, document3);
    });
    act(() => {
      harness.editor.apply((latest: ContentStudioDesignDocumentV1) => ({
        document: {
          ...latest,
          pages: [{ ...latest.pages[0], name: 'Changed' }],
        },
      }));
    });
    await flush();
    expect((button('Generate suggestion') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      screen.getByText(
        'Save or discard your changes first: suggestions are made for the saved revision.'
      )
    ).toBeTruthy();
  });

  it('BK1 no suggestion is asked while the pinned Brand Kit revision is not available', async () => {
    await show(base(), false);
    await open();
    expect((button('Generate suggestion') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      screen.getByText(
        'The pinned Brand Kit revision must be available before this design can be edited.'
      )
    ).toBeTruthy();
  });

  it('FE6/SEC2-SEC5 asks for exactly the shown revision with ids and the intent only, and announces it is generating', async () => {
    let finish!: (value: Reply) => void;
    propose = () => new Promise<Reply>((resolve) => (finish = resolve));
    await show();
    await open();
    fireEvent.change(screen.getByLabelText('Additional instruction'), {
      target: { value: '  Warmer  ' },
    });
    await generate();
    expect(screen.getByRole('status').textContent).toBe(
      'Generating a suggestion…'
    );
    // one request at a time
    fireEvent.click(button('Generate suggestion'));
    const posts = writes();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(
      `/content-studio/designs/${DESIGN}/revisions/${REV_3}/ai/propose`
    );
    expect(posts[0].body).toEqual({
      intent: 'improve_copy',
      connectionId: CONNECTION,
      writingProfileId: null,
      editorialPolicy: false,
      audienceProfileId: null,
      expertiseProfileId: null,
      instruction: 'Warmer',
    });
    expect(JSON.stringify(posts[0].body)).not.toMatch(
      /model|provider|apiKey|contentHash|pages|organization/
    );
    await act(async () => finish(reply(200, suggestion())));
    await flush();
    expect(screen.queryByText('Generating a suggestion…')).toBeNull();
  });

  it('FE7/FE8/FE9/M19 shows the summary, the changes from the documents and a before and after preview', async () => {
    await show();
    await open();
    await generate();
    const shown = section().querySelector(
      '[data-ai-suggestion]'
    ) as HTMLElement;
    expect(shown.textContent).toContain('Suggestion for Revision 3');
    expect(
      (shown.querySelector('[data-ai-summary]') as HTMLElement).textContent
    ).toBe(SUMMARY);
    const changes = within(shown).getByRole('list', { name: 'Changes' });
    expect(changes.textContent).toContain('Changed text in Title (Page 1)');
    expect(changes.textContent).toContain('Spring sale');
    expect(
      (changes.querySelector('[data-ai-after]') as HTMLElement).textContent
    ).toBe('Spring is here');
    const preview = shown.querySelector('[data-ai-preview="page_1"]');
    expect(preview?.textContent).toContain('Before');
    expect(preview?.textContent).toContain('After');
    expect(preview?.querySelectorAll('figure')).toHaveLength(2);
    // nothing applied or saved yet
    expect(harness.editor.state).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('FE10/PA3/UN1/UN2/UN3/FE15/M20 Apply puts the suggestion into the draft as one undo step, and saves nothing', async () => {
    await show();
    await open();
    await generate();
    await click(button('Apply suggestion'));
    const editor = harness.editor;
    expect(editor.state.base.revisionId).toBe(REV_3);
    expect(editor.document.pages[0].layers[0].text).toBe('Spring is here');
    expect(editor.document.pages[0].layers[1]).toEqual(
      document3.pages[0].layers[1]
    );
    expect(editor.dirty).toBe(true);
    expect(editor.canUndo).toBe(true);
    // the suggestion is gone; the draft is unsaved
    expect(section().querySelector('[data-ai-suggestion]')).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      'Suggestion applied to your unsaved changes. Review it, then save to keep it.',
      'success'
    );
    expect(writes().filter((c) => !c.url.endsWith('/ai/propose'))).toEqual([]);
    // one step back is the revision as saved, one forward the suggestion
    act(() => harness.editor.undo());
    await flush();
    expect(harness.editor.document).toEqual(document3);
    expect(harness.editor.canUndo).toBe(false);
    act(() => harness.editor.redo());
    await flush();
    expect(harness.editor.document.pages[0].layers[0].text).toBe(
      'Spring is here'
    );
  });

  it('FE11/PA2/M16 Discard drops the suggestion and changes nothing', async () => {
    await show();
    await open();
    await generate();
    await click(button('Discard suggestion'));
    expect(section().querySelector('[data-ai-suggestion]')).toBeNull();
    expect(harness.editor.state).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('FE12/PA5/M13 a suggestion for an older revision cannot be applied', async () => {
    const view = await show();
    await open();
    await generate();
    await rerenderWith(view, base(REV_4, 4));
    expect((button('Apply suggestion') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'This suggestion was created for an older revision. Generate a new suggestion.'
    );
    fireEvent.click(button('Apply suggestion'));
    expect(harness.editor.state).toBeNull();
  });

  it('FE13/PA6/M14 changes made after the suggestion block Apply: nothing is merged onto them', async () => {
    await show();
    await open();
    await generate();
    act(() => {
      harness.editor.begin({ id: REV_3, revisionNumber: 3 }, document3);
    });
    act(() => {
      harness.editor.apply((latest: ContentStudioDesignDocumentV1) => ({
        document: {
          ...latest,
          pages: [{ ...latest.pages[0], name: 'Edited by hand' }],
        },
      }));
    });
    await flush();
    expect((button('Apply suggestion') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'The design changed after this suggestion was made. Discard your changes, or save them and generate a new suggestion.'
    );
    fireEvent.click(button('Apply suggestion'));
    expect(harness.editor.document.pages[0].layers[0].text).toBe('Spring sale');
    // an unchanged open edit of the same revision takes it
    act(() => harness.editor.undo());
    await flush();
    expect((button('Apply suggestion') as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it('refuses to show an answer for another revision, or one that does not apply to the document', async () => {
    propose = () => reply(200, { ...suggestion(), base: base(REV_4, 4) });
    await show();
    await open();
    await generate();
    expect(section().querySelector('[data-ai-suggestion]')).toBeNull();
    expect(mockToast).toHaveBeenLastCalledWith(
      'The suggestion could not be shown safely. Try again.',
      'warning'
    );
    propose = () =>
      reply(200, {
        ...suggestion(),
        proposal: {
          ...suggestion().proposal,
          operations: [{ type: 'set_text', layerId: 'l_missing', text: 'x' }],
        },
      });
    await generate();
    expect(section().querySelector('[data-ai-suggestion]')).toBeNull();
  });

  it('a refusal is a fixed message, never the server text', async () => {
    for (const [code, text] of [
      [
        'CS_AI_DESIGN_PROPOSAL_INVALID',
        'The AI suggestion did not fit this design and was not used. Try again.',
      ],
      [
        'CS_AI_DESIGN_BASE_STALE',
        'This revision is no longer the current one. Reload the design and try again.',
      ],
      [
        'CS_AI_CONNECTION_REQUIRED',
        'Connect an AI provider before using AI writing.',
      ],
      [
        'CS_AI_RATE_LIMITED',
        'The provider is rate limiting this connection. Try again later.',
      ],
    ]) {
      propose = () =>
        reply(code === 'CS_AI_RATE_LIMITED' ? 429 : 400, {
          code,
          msg: 'SERVER_SECRET_TEXT',
        });
      cleanup();
      await show();
      await open();
      await generate();
      expect(mockToast).toHaveBeenLastCalledWith(text, 'warning');
    }
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain(
      'SERVER_SECRET_TEXT'
    );
  });

  it('FE1/P602 the workspace shows the panel for active designs only, for the saved current revision and its exact kit', () => {
    const workspace = readFileSync(
      join(
        ROOT,
        'apps/frontend/src/components/content-studio/content-studio.design.workspace.tsx'
      ),
      'utf8'
    );
    const block = workspace.slice(
      workspace.indexOf('<DesignAISuggestions'),
      workspace.indexOf(
        'editor={editor}',
        workspace.indexOf('<DesignAISuggestions')
      )
    );
    expect(workspace).toContain(
      '{!design.archivedAt && (\n        <DesignAISuggestions'
    );
    expect(block).toContain('shown.historical\n              ? null');
    expect(block).toContain('revisionId: currentRevision.id');
    expect(block).toContain('document={currentDocument}');
    expect(block).not.toContain('editor.document');
  });

  it('P602-1/FE15 the panel never saves, renders or sends a document: it asks, and applies into the editor only', () => {
    const panel = readFileSync(
      join(
        ROOT,
        'apps/frontend/src/components/content-studio/content-studio.design-ai.tsx'
      ),
      'utf8'
    );
    expect(panel).not.toMatch(
      /saveDesignRevision|editor\.save|\/render|createDesign|getMediaDesignRef|useContentStudioMediaLibrary|localStorage|sessionStorage/
    );
    expect(panel.match(/method: 'POST'/g)).toHaveLength(1);
    expect(panel).toContain('/ai/propose');
    expect(panel).toContain('editor.apply(');
  });
});
