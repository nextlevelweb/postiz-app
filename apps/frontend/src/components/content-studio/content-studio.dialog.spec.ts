import { createElement as h, FC, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';

// Dialogs, navigation and list input of the product UX foundation, with the
// real modal manager: unsaved work is never dropped by a click outside,
// Escape or the close button, a dialog never outlives the page it was opened
// on, and list entries are never lost on Save. A .spec.ts without JSX

let mockPathname = '/content-studio';
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname,
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
// the modal manager's Escape: a keydown listener, like the real hook
jest.mock('react-hotkeys-hook', () => {
  const { useEffect, useRef } = require('react');
  return {
    useHotkeys: (key: string, callback: () => void, deps: unknown[] = []) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const listener = (event: KeyboardEvent) => {
          if (event.key === key) {
            latest.current();
          }
        };
        document.addEventListener('keydown', listener);
        return () => document.removeEventListener('keydown', listener);
      }, deps);
    },
  };
});
const mockConfirm = jest.fn();
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: (...args: unknown[]) => mockConfirm(...args),
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));

const {
  ModalManager,
  useModals,
} = require('@gitroom/frontend/components/layout/new-modal');
const {
  ContentStudioCloseModalsOnNavigate,
  ContentStudioDialogLayout,
  useContentStudioDialogGuard,
  useUnsavedChangesWarning,
} = require('./content-studio.dialog');
const {
  contentStudioSectionOf,
  ContentStudioBreadcrumbs,
  ContentStudioNav,
} = require('./content-studio.shell');
const {
  addListEntries,
  splitListEntries,
  StringListEditor,
} = require('./intelligence/content-studio.intelligence.shared');
const {
  avoidReasonRule,
  parseAvoidReasonRule,
  WritingProfileForm,
  emptyWritingProfileContent,
} = require('./intelligence/content-studio.writing-profiles');

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

// a form with one field: dirty once something is typed
const Form: FC<{ close: () => void }> = ({ close }) => {
  const [value, setValue] = useState('');
  const release = useContentStudioDialogGuard(!!value);
  return h(
    ContentStudioDialogLayout,
    {
      footer: [
        h('button', { key: 'c', type: 'button', onClick: close }, 'Cancel'),
        h(
          'button',
          {
            key: 's',
            type: 'button',
            onClick: () => {
              release();
              close();
            },
          },
          'Save'
        ),
      ],
    },
    h('input', {
      'aria-label': 'Field',
      value,
      onChange: (e: any) => setValue(e.target.value),
    })
  );
};

const Opener: FC = () => {
  const modals = useModals();
  return h(
    'button',
    {
      type: 'button',
      onClick: () =>
        modals.openModal({
          title: 'Edit things',
          children: (close: () => void) => h(Form, { close }),
        }),
    },
    'Open'
  );
};

const showDialog = async () => {
  const view = render(h(ModalManager, null, h(Opener)));
  fireEvent.click(screen.getByText('Open'));
  await flush();
  return view;
};
const backdrop = () =>
  (
    screen
      .getByText('Edit things')
      .closest('.bg-newBgColorInner') as HTMLElement
  ).parentElement!.parentElement!.parentElement as HTMLElement;
const isOpen = () => !!screen.queryByText('Edit things');

beforeEach(() => {
  mockConfirm.mockReset();
  mockRouter.push.mockReset();
  mockPathname = '/content-studio';
});
// the modal store outlives a render: empty it between tests
const CloseAll: FC = () => {
  const { closeAll } = useModals();
  closeAll();
  return null;
};
afterEach(async () => {
  cleanup();
  render(h(CloseAll));
  cleanup();
  await flush();
});

describe('Dialog guard (P0: no lost work)', () => {
  it('D1 a click outside a clean dialog closes it without asking', async () => {
    await showDialog();
    fireEvent.click(backdrop());
    await flush();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('D2 a click outside a dialog with typed work asks first, and Keep editing keeps it', async () => {
    await showDialog();
    fireEvent.change(screen.getByLabelText('Field'), {
      target: { value: 'Five minutes of work' },
    });
    mockConfirm.mockResolvedValueOnce(false);
    fireEvent.click(backdrop());
    await flush();
    expect(mockConfirm).toHaveBeenCalledWith(
      'You have unsaved changes. Discard them?',
      'Discard changes',
      'Unsaved changes',
      'Keep editing'
    );
    expect(isOpen()).toBe(true);
    expect((screen.getByLabelText('Field') as HTMLInputElement).value).toBe(
      'Five minutes of work'
    );
  });

  it('D3 Escape and Cancel follow the same rule; Discard closes', async () => {
    await showDialog();
    fireEvent.change(screen.getByLabelText('Field'), {
      target: { value: 'typed' },
    });
    mockConfirm.mockResolvedValueOnce(false);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    await flush();
    expect(isOpen()).toBe(true);
    mockConfirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByText('Cancel'));
    await flush();
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(isOpen()).toBe(false);
  });

  it('D4 a saved form closes without asking', async () => {
    await showDialog();
    fireEvent.change(screen.getByLabelText('Field'), {
      target: { value: 'typed' },
    });
    fireEvent.click(screen.getByText('Save'));
    await flush();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('D5 the dialog body scrolls inside the window while its actions stay in view', async () => {
    await showDialog();
    const body = screen.getByLabelText('Field').parentElement as HTMLElement;
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('min-h-0');
    const layout = body.parentElement as HTMLElement;
    expect(layout.className).toMatch(/max-h-\[calc\(100dvh-/);
    expect(layout.className).toMatch(/xl:max-h-\[calc\(100dvh-/);
    const footer = layout.lastElementChild as HTMLElement;
    expect(footer.textContent).toBe('CancelSave');
    expect(footer.className).toContain('shrink-0');
  });
});

describe('Dialogs and navigation', () => {
  it('N1 a dialog never outlives the page it was opened on', async () => {
    const view = render(
      h(ModalManager, null, h(ContentStudioCloseModalsOnNavigate), h(Opener))
    );
    fireEvent.click(screen.getByText('Open'));
    await flush();
    expect(isOpen()).toBe(true);
    mockPathname = '/content-studio/intelligence';
    view.rerender(
      h(ModalManager, null, h(ContentStudioCloseModalsOnNavigate), h(Opener))
    );
    await flush();
    expect(isOpen()).toBe(false);
  });

  it('N2 an unsaved page asks before an in-app link leaves it, and warns on unload', async () => {
    const Page: FC = () => {
      useUnsavedChangesWarning(true);
      return h('a', { href: '/content-studio/sources' }, 'Sources');
    };
    render(h(Page));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    mockConfirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByText('Sources'));
    await flush();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByText('Sources'));
    await flush();
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/sources');
  });

  it('N3 a clean page leaves without asking', async () => {
    const Page: FC = () => {
      useUnsavedChangesWarning(false);
      return h('a', { href: '/content-studio/sources' }, 'Sources');
    };
    render(h(Page));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByText('Sources'));
    await flush();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ['/content-studio', 'home'],
    ['/content-studio/2c970f71-d29b-440d-a7c2-872d32d043ec', 'home'],
    ['/content-studio/sources/abc', 'sources'],
    ['/content-studio/research', 'radar'],
    ['/content-studio/designs/abc', 'creative'],
    ['/content-studio/templates', 'creative'],
    ['/content-studio/reviews', 'reviews'],
    ['/content-studio/intelligence', 'brand'],
    ['/content-studio/setup', 'brand'],
  ])('N4 %s is in the %s section', (path, section) => {
    expect(contentStudioSectionOf(path)).toBe(section);
  });

  it('N5 the navigation is in the order of the work, the current section marked', () => {
    mockPathname = '/content-studio/designs/abc';
    render(h(ContentStudioNav));
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Home',
      'Sources',
      'Research',
      'Creative Studio',
      'Reviews',
      'Brand & AI',
    ]);
    expect(
      links.filter((link) => link.getAttribute('aria-current') === 'page')
    ).toEqual([links[3]]);
  });

  it('N6 breadcrumbs name every parent and the page itself', () => {
    render(
      h(ContentStudioBreadcrumbs, {
        crumbs: [
          { label: 'Sources', href: '/content-studio/sources' },
          { label: 'Pricing page' },
        ],
      })
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    ).toEqual(['/content-studio', '/content-studio/sources']);
    expect(screen.getByText('Pricing page').getAttribute('aria-current')).toBe(
      'page'
    );
  });
});

describe('List input (tags, words, rules)', () => {
  const List: FC<{
    chips?: boolean;
    max?: number;
    onSave: (v: string[]) => void;
  }> = ({ chips, max = 10, onSave }) => {
    const [values, setValues] = useState<string[]>([]);
    return h(
      'div',
      null,
      h(StringListEditor, {
        label: 'Tone tags',
        values,
        max,
        chips,
        onChange: setValues,
      }),
      h('button', { type: 'button', onClick: () => onSave(values) }, 'Save')
    );
  };
  const input = () =>
    screen.getByLabelText('New Tone tags') as HTMLInputElement;

  it('L1 Enter adds what was typed', () => {
    const saved = jest.fn();
    render(h(List, { onSave: saved }));
    fireEvent.change(input(), { target: { value: ' practical ' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('');
    fireEvent.click(screen.getByText('Save'));
    expect(saved).toHaveBeenCalledWith(['practical']);
  });

  it('L2 a pasted list adds every line at once', () => {
    const saved = jest.fn();
    render(h(List, { onSave: saved }));
    fireEvent.paste(input(), {
      clipboardData: { getData: () => 'practical\nhuman\nclear\nconcrete' },
    });
    fireEvent.click(screen.getByText('Save'));
    expect(saved).toHaveBeenCalledWith([
      'practical',
      'human',
      'clear',
      'concrete',
    ]);
  });

  it('L3 what is still typed when Save is clicked is not lost', () => {
    const saved = jest.fn();
    render(h(List, { onSave: saved }));
    fireEvent.change(input(), { target: { value: 'last one' } });
    // the field loses focus before the click lands
    fireEvent.blur(input());
    fireEvent.click(screen.getByText('Save'));
    expect(saved).toHaveBeenCalledWith(['last one']);
  });

  it('L4 repeats are left out and the limit holds', () => {
    const saved = jest.fn();
    render(h(List, { onSave: saved, max: 3, chips: true }));
    fireEvent.paste(input(), {
      clipboardData: { getData: () => 'a, b; a\nc\nd' },
    });
    fireEvent.click(screen.getByText('Save'));
    expect(saved).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe('This list is full.');
  });

  it('L5 splits on lines and semicolons, and on commas for short entries only', () => {
    expect(splitListEntries('a\r\nb; c, d', false)).toEqual(['a', 'b', 'c, d']);
    expect(splitListEntries('a\r\nb; c, d', true)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(addListEntries(['a'], ['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('Writing profile: perspective and words to avoid', () => {
  const Writing: FC<{ onChange: (v: any) => void }> = ({ onChange }) => {
    const [value, setValue] = useState(emptyWritingProfileContent());
    return h(WritingProfileForm, {
      value,
      onChange: (next: any) => {
        setValue(next);
        onChange(next);
      },
    });
  };

  it('P1 names every perspective, and says what Mixed mixes', () => {
    render(h(Writing, { onChange: jest.fn() }));
    const select = screen.getByLabelText('Perspective') as HTMLSelectElement;
    expect(
      Array.from(select.options).map((o) => [o.value, o.textContent])
    ).toEqual([
      ['', 'Not set'],
      ['first_singular', 'First person singular — I / me'],
      ['first_plural', 'First person plural — we / us'],
      ['second', 'Second person — you'],
      ['third', 'Third person — the company / they'],
      ['mixed', 'Mixed — e.g. we and you, described under Voice'],
    ]);
    fireEvent.change(select, { target: { value: 'mixed' } });
    expect(
      screen.getByText(/usually we for the company and you for the reader/)
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: 'first_plural' } });
    expect(screen.getByText(/The team speaks as one/)).toBeTruthy();
  });

  it("A1 a word to avoid can say why; the reason is a Don't rule that goes with the word", () => {
    const changes = jest.fn();
    render(h(Writing, { onChange: changes }));
    const avoid = screen.getByLabelText('New Words to avoid');
    fireEvent.change(avoid, { target: { value: 'revolutionary' } });
    fireEvent.keyDown(avoid, { key: 'Enter' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add why revolutionary' })
    );
    fireEvent.change(screen.getByLabelText('Why avoid revolutionary'), {
      target: { value: 'Hype. Name the concrete benefit.' },
    });
    fireEvent.click(screen.getByText('Done'));
    let last = changes.mock.calls[changes.mock.calls.length - 1][0];
    expect(last.vocabulary.avoid).toEqual(['revolutionary']);
    expect(last.donts).toEqual([
      '"revolutionary" — Hype. Name the concrete benefit.',
    ]);
    expect(screen.getByText('Hype. Name the concrete benefit.')).toBeTruthy();
    // removing the word removes its reason
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove revolutionary' })
    );
    last = changes.mock.calls[changes.mock.calls.length - 1][0];
    expect(last.vocabulary.avoid).toEqual([]);
    expect(last.donts).toEqual([]);
  });

  it('A2 the reason rule round-trips and other rules are not mistaken for one', () => {
    expect(parseAvoidReasonRule(avoidReasonRule('synergy', 'Vague.'))).toEqual({
      term: 'synergy',
      reason: 'Vague.',
    });
    expect(parseAvoidReasonRule('No jargon.')).toBeNull();
  });
});
