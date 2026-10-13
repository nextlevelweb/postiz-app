import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  ContentStudioAutosave as AutosaveClass,
  ContentStudioAutosaveSnapshot,
} from './content-studio.autosave';
import type { ContentStudioDraft } from './content-studio.api';

const {
  ContentStudioAutosave,
  ContentStudioAutosaveError,
  useContentStudioAutosave,
  AUTOSAVE_DELAY_MS,
} = require('./content-studio.autosave');
const { ContentStudioRequestError } = require('./content-studio.api');

const draftWith = (
  text: string,
  mediaIds: string[] = []
): ContentStudioDraft => ({
  schemaVersion: 1,
  copy: { global: { thread: [{ id: 'main', text, mediaIds }] } },
});
const setText = (text: string) => (draft: ContentStudioDraft) => ({
  ...draft,
  copy: {
    global: {
      thread: draft.copy.global.thread.map((item, index) =>
        index === 0 ? { ...item, text } : item
      ),
    },
  },
});

// a save the test answers by hand
interface Pending {
  draft: ContentStudioDraft;
  base: number;
  resolve: (version?: number) => Promise<void>;
  reject: (err: unknown) => Promise<void>;
}
let pending: Pending[];
let concurrent: number;
let maxConcurrent: number;
let snapshots: ContentStudioAutosaveSnapshot[];
const save = jest.fn(
  (draft: ContentStudioDraft, base: number) =>
    new Promise<{ draftVersion: number }>((resolve, reject) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      pending.push({
        draft,
        base,
        resolve: async (version = base + 1) => {
          concurrent -= 1;
          resolve({ draftVersion: version });
          await settle();
        },
        reject: async (err) => {
          concurrent -= 1;
          reject(err);
          await settle();
        },
      });
    })
);
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};
const sent = () =>
  save.mock.calls.map(([draft, base]) => [
    (draft as ContentStudioDraft).copy.global.thread[0].text,
    base,
  ]);
const last = () => snapshots[snapshots.length - 1];

let autosave: AutosaveClass;
const create = (version = 4, readOnly = false) => {
  autosave = new ContentStudioAutosave(
    save,
    (s: ContentStudioAutosaveSnapshot) => snapshots.push(s)
  );
  autosave.reset(draftWith('server'), version, readOnly);
  return autosave;
};
const edit = (text: string) => autosave.change(setText(text));
const advance = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await settle();
};
const conflict = () =>
  new ContentStudioRequestError(409, 'CS_DRAFT_VERSION_CONFLICT');

beforeEach(() => {
  jest.useFakeTimers();
  pending = [];
  concurrent = 0;
  maxConcurrent = 0;
  snapshots = [];
  save.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('Content Studio autosave: debounce', () => {
  it('A1 starts saved and sends nothing', async () => {
    create();
    await advance(10_000);
    expect(save).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ state: 'idle', version: 4 });
  });

  it('A2/A3 saves 1500 ms after the edit, not before', async () => {
    create();
    edit('a');
    expect(last().state).toBe('dirty');
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(last().state).toBe('saving');
  });

  it('A4/A5 sends the base version and draft, then takes the returned version', async () => {
    create(4);
    edit('a');
    await advance(1500);
    expect(save.mock.calls[0]).toEqual([draftWith('a'), 4]);
    await pending[0].resolve(5);
    expect(last()).toMatchObject({ state: 'idle', version: 5 });
    expect(autosave.currentVersion).toBe(5);
  });

  it('A11 every edit restarts the 1500 ms', async () => {
    create();
    edit('a');
    await advance(1000);
    edit('ab');
    await advance(1000);
    edit('abc');
    await advance(1499);
    expect(save).not.toHaveBeenCalled();
    await advance(1);
    expect(sent()).toEqual([['abc', 4]]);
  });

  it('A10 going back to the saved text cancels the save', async () => {
    create();
    edit('a');
    edit('server');
    expect(last().state).toBe('idle');
    await advance(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it('an identical edit changes nothing', async () => {
    create();
    expect(autosave.change((d) => ({ ...d }))).toBe(true);
    await advance(5000);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('Content Studio autosave: one save at a time', () => {
  it('A6-A9 edits during a save wait; only the latest goes next, on the returned version', async () => {
    create(4);
    edit('A');
    await advance(1500);
    edit('B');
    await advance(200);
    edit('C');
    await advance(1500);
    // C's timer fired while A was still running
    expect(save).toHaveBeenCalledTimes(1);
    expect(last().state).toBe('saving');

    await pending[0].resolve(5);
    expect(sent()).toEqual([
      ['A', 4],
      ['C', 5],
    ]);
    await pending[1].resolve(6);
    expect(maxConcurrent).toBe(1);
    expect(last()).toMatchObject({ state: 'idle', version: 6 });
    expect(sent().map(([text]) => text)).not.toContain('B');
  });

  it("a save that ends before the latest edit waits for that edit's timer", async () => {
    create(4);
    edit('A');
    await advance(1500);
    edit('B');
    await pending[0].resolve(5);
    expect(save).toHaveBeenCalledTimes(1);
    expect(last().state).toBe('dirty');
    await advance(1499);
    expect(save).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(sent()).toEqual([
      ['A', 4],
      ['B', 5],
    ]);
  });

  it('A25 the body is a snapshot: later edits never change it', async () => {
    create();
    edit('A');
    await advance(1500);
    const body = pending[0].draft;
    // a copy made when the request started, not the live draft object
    expect(body).not.toBe(autosave.currentDraft);
    edit('changed');
    expect(body).toEqual(draftWith('A'));
    expect(body).not.toBe(autosave.currentDraft);
  });
});

describe('Content Studio autosave: flush', () => {
  it('A12 saves at once, without waiting for the timer', async () => {
    create();
    edit('a');
    const done = autosave.flush();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    await pending[0].resolve(5);
    await expect(done).resolves.toBeUndefined();
    await advance(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('resolves at once when nothing is unsaved', async () => {
    create();
    await expect(autosave.flush()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('A13/A14 waits for the running save, saves the latest, and resolves only then', async () => {
    create(4);
    edit('A');
    await advance(1500);
    edit('C');
    let resolved = false;
    const done = autosave.flush().then(() => {
      resolved = true;
    });
    await pending[0].resolve(5);
    expect(resolved).toBe(false);
    expect(sent()).toEqual([
      ['A', 4],
      ['C', 5],
    ]);
    await pending[1].resolve(6);
    await done;
    expect(resolved).toBe(true);
    expect(autosave.currentVersion).toBe(6);
  });

  it('A24 two flushes share one save', async () => {
    create();
    edit('a');
    const one = autosave.flush();
    const two = autosave.flush();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    await pending[0].resolve(5);
    await Promise.all([one, two]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects when the save fails', async () => {
    create();
    edit('a');
    const done = autosave.flush();
    await settle();
    await pending[0].reject(new ContentStudioRequestError(500));
    await expect(done).rejects.toBeInstanceOf(ContentStudioAutosaveError);
    await expect(done).rejects.toMatchObject({ state: 'error' });
  });

  it('rejects in a conflict without sending anything', async () => {
    create();
    edit('a');
    await advance(1500);
    await pending[0].reject(conflict());
    edit('b');
    await expect(autosave.flush()).rejects.toMatchObject({ state: 'conflict' });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('Content Studio autosave: failures', () => {
  it('A15 a failed save keeps the local draft and does not retry by itself', async () => {
    create();
    edit('mine');
    await advance(1500);
    await pending[0].reject(new TypeError('offline'));
    expect(last()).toMatchObject({ state: 'error', version: 4 });
    expect(autosave.currentDraft).toEqual(draftWith('mine'));
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('A16 retry sends the latest draft on the saved version', async () => {
    create(4);
    edit('mine');
    await advance(1500);
    await pending[0].reject(new ContentStudioRequestError(500));
    autosave.retry();
    await settle();
    expect(sent()).toEqual([
      ['mine', 4],
      ['mine', 4],
    ]);
    await pending[1].resolve(5);
    expect(last()).toMatchObject({ state: 'idle', version: 5 });
  });

  it('A17 a new edit after a failure saves again after the delay', async () => {
    create();
    edit('a');
    await advance(1500);
    await pending[0].reject(new ContentStudioRequestError(500));
    edit('ab');
    expect(last().state).toBe('dirty');
    await advance(1500);
    expect(sent()).toEqual([
      ['a', 4],
      ['ab', 4],
    ]);
  });

  it('an answer without a newer version is a failure, not a version', async () => {
    create(4);
    edit('a');
    await advance(1500);
    await pending[0].resolve(3);
    expect(last()).toMatchObject({ state: 'error', version: 4 });
  });

  it('A18/A19 a version conflict stops saving, whatever the edits', async () => {
    create();
    edit('a');
    await advance(1500);
    await pending[0].reject(conflict());
    expect(last().state).toBe('conflict');
    edit('b');
    autosave.retry();
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(last().state).toBe('conflict');
    // the local text is still there
    expect(autosave.currentDraft).toEqual(draftWith('b'));
  });

  it('markConflict stops a pending save', async () => {
    create();
    edit('a');
    autosave.markConflict();
    await advance(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it('A20 reset clears the conflict and takes the server draft and version', async () => {
    create();
    edit('a');
    await advance(1500);
    await pending[0].reject(conflict());
    autosave.reset(draftWith('theirs'), 9, false);
    expect(last()).toMatchObject({
      state: 'idle',
      version: 9,
      draft: draftWith('theirs'),
    });
    edit('next');
    await advance(1500);
    expect(sent().pop()).toEqual(['next', 9]);
  });

  it('A23 an answer for a draft replaced by reset changes nothing', async () => {
    create(4);
    edit('a');
    await advance(1500);
    autosave.reset(draftWith('server again'), 9, false);
    await pending[0].resolve(5);
    expect(autosave.currentVersion).toBe(9);
    expect(last()).toMatchObject({ state: 'idle', version: 9 });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('Content Studio autosave: read-only and unmount', () => {
  it('A21 a read-only draft cannot change or save', async () => {
    create(4, true);
    expect(edit('a')).toBe(false);
    await advance(5000);
    await autosave.flush();
    expect(save).not.toHaveBeenCalled();
    expect(autosave.currentDraft).toEqual(draftWith('server'));
  });

  it('A22 unmounting drops the pending timer and starts nothing', async () => {
    const { result, unmount } = renderHook(() =>
      useContentStudioAutosave(save)
    );
    act(() => {
      result.current.controller.reset(draftWith('server'), 4, false);
      result.current.controller.change(setText('typed'));
    });
    expect(result.current.state).toBe('dirty');
    unmount();
    await advance(10_000);
    expect(save).not.toHaveBeenCalled();
  });

  it('a save already running when unmounting finishes, and nothing follows it', async () => {
    const { result, unmount } = renderHook(() =>
      useContentStudioAutosave(save)
    );
    act(() => {
      result.current.controller.reset(draftWith('server'), 4, false);
      result.current.controller.change(setText('a'));
    });
    await act(() => advance(1500));
    act(() => {
      result.current.controller.change(setText('ab'));
    });
    unmount();
    await pending[0].resolve(5);
    await advance(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('the hook renders every state change', async () => {
    const { result } = renderHook(() => useContentStudioAutosave(save));
    act(() => {
      result.current.controller.reset(draftWith('server'), 4, false);
      result.current.controller.change(setText('a'));
    });
    expect(result.current).toMatchObject({ state: 'dirty', version: 4 });
    await act(() => advance(1500));
    expect(result.current.state).toBe('saving');
    await act(() => pending[0].resolve(5));
    expect(result.current).toMatchObject({ state: 'idle', version: 5 });
    expect(result.current.draft).toEqual(draftWith('a'));
  });
});

describe('Content Studio autosave: source', () => {
  it('uses no timer library, hashing or storage', () => {
    const source = readFileSync(
      join(__dirname, 'content-studio.autosave.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /lodash|use-debounce|crypto|localStorage|sessionStorage|sendBeacon/
    );
  });
});
