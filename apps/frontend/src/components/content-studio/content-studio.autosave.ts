'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ContentStudioDraft,
  ContentStudioRequestError,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

export const AUTOSAVE_DELAY_MS = 1500;

export type ContentStudioSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'conflict'
  | 'error';

export interface ContentStudioAutosaveSnapshot {
  draft: ContentStudioDraft | null;
  version: number;
  state: ContentStudioSaveState;
  error: unknown;
  readOnly: boolean;
}

type SaveDraft = (
  draft: ContentStudioDraft,
  baseDraftVersion: number
) => Promise<{ draftVersion: number }>;

// flush() could not get the latest draft acknowledged
export class ContentStudioAutosaveError extends Error {
  constructor(public state: 'conflict' | 'error', public reason?: unknown) {
    super('The Content Studio draft is not saved');
    this.name = 'ContentStudioAutosaveError';
  }
}

// Saves the mutable draft of one package over compare-and-swap:
// - 1500 ms after the last edit, never per keystroke;
// - one PUT at a time; edits made meanwhile wait, and only the latest state is
//   sent next (never the ones in between);
// - every PUT is based on the version the server returned for the previous one;
// - a version conflict stops saving until the editor is reset from the server;
//   other failures keep the local draft and wait for a retry or a new edit.
// Drafts are compared as JSON: the editor builds them in one key order
export class ContentStudioAutosave {
  private draft: ContentStudioDraft | null = null;
  private draftKey = '';
  private savedKey = '';
  private version = 0;
  private state: ContentStudioSaveState = 'idle';
  private error: unknown = null;
  private readOnly = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  // the timer of the latest edit fired while a PUT was running
  private queued = false;
  private flushing = 0;
  // bumped by reset(): an answer for an older generation changes nothing
  private generation = 0;
  private attached = true;

  constructor(
    private save: SaveDraft,
    private onChange: (snapshot: ContentStudioAutosaveSnapshot) => void = () =>
      undefined,
    private delay = AUTOSAVE_DELAY_MS
  ) {}

  get currentDraft() {
    return this.draft;
  }

  get currentVersion() {
    return this.version;
  }

  snapshot(): ContentStudioAutosaveSnapshot {
    return {
      draft: this.draft,
      version: this.version,
      state: this.state,
      error: this.error,
      readOnly: this.readOnly,
    };
  }

  // The server's draft and version become both the local and the saved state
  reset(draft: ContentStudioDraft, version: number, readOnly: boolean) {
    this.generation += 1;
    this.clearTimer();
    this.queued = false;
    this.draft = draft;
    this.draftKey = this.savedKey = JSON.stringify(draft);
    this.version = version;
    this.readOnly = readOnly;
    this.state = 'idle';
    this.error = null;
    this.emit();
  }

  // Applies an edit to the latest local draft. Returns false when the draft
  // can't be edited (not loaded, or read-only)
  change(edit: (draft: ContentStudioDraft) => ContentStudioDraft) {
    if (!this.draft || this.readOnly) {
      return false;
    }
    const next = edit(this.draft);
    const key = JSON.stringify(next);
    if (key === this.draftKey) {
      return true;
    }
    this.draft = next;
    this.draftKey = key;
    // kept locally, but never saved over a newer server version
    if (this.state === 'conflict') {
      this.emit();
      return true;
    }
    this.error = null;
    if (!this.inFlight && key === this.savedKey) {
      this.clearTimer();
      this.state = 'idle';
    } else {
      if (!this.inFlight) {
        this.state = 'dirty';
      }
      this.restartTimer();
    }
    this.emit();
    return true;
  }

  // Resolves once the latest local draft is acknowledged by the server
  async flush() {
    this.flushing += 1;
    try {
      for (;;) {
        if (this.state === 'conflict' || this.state === 'error') {
          throw new ContentStudioAutosaveError(this.state, this.error);
        }
        if (this.inFlight) {
          await this.inFlight;
          continue;
        }
        if (this.readOnly || !this.draft || this.draftKey === this.savedKey) {
          return;
        }
        this.start();
      }
    } finally {
      this.flushing -= 1;
    }
  }

  // After a failed save: tries the latest local draft again
  retry() {
    if (this.state === 'error' && !this.inFlight) {
      this.state = 'dirty';
      this.start();
    }
  }

  // A revision request found the draft moved on elsewhere
  markConflict() {
    this.clearTimer();
    this.queued = false;
    this.state = 'conflict';
    this.emit();
  }

  attach() {
    this.attached = true;
    if (this.state === 'dirty' && !this.timer && !this.inFlight) {
      this.restartTimer();
    }
  }

  // Unmounting drops a pending edit timer and starts nothing new; a PUT that
  // is already running finishes on its own
  detach() {
    this.attached = false;
    this.clearTimer();
  }

  private emit() {
    if (this.attached) {
      this.onChange(this.snapshot());
    }
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private restartTimer() {
    this.clearTimer();
    if (!this.attached) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.inFlight) {
        this.queued = true;
        return;
      }
      this.start();
    }, this.delay);
  }

  private start() {
    if (
      this.inFlight ||
      this.readOnly ||
      !this.draft ||
      this.state === 'conflict'
    ) {
      return;
    }
    if (this.draftKey === this.savedKey) {
      this.state = 'idle';
      this.emit();
      return;
    }
    this.clearTimer();
    this.queued = false;
    const key = this.draftKey;
    const base = this.version;
    const generation = this.generation;
    // a copy: later edits never change what this request sends
    const body = JSON.parse(key) as ContentStudioDraft;
    this.state = 'saving';
    this.error = null;
    this.emit();

    const run = async () => {
      let result: { draftVersion: number } | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = await this.save(body, base);
      } catch (err) {
        failed = true;
        failure = err;
      }
      this.inFlight = null;
      if (generation !== this.generation) {
        this.next();
        return;
      }
      if (
        !failed &&
        !(
          Number.isInteger(result?.draftVersion) &&
          (result as { draftVersion: number }).draftVersion > base
        )
      ) {
        failed = true;
        failure = new Error('Unexpected draft version');
      }
      if (failed) {
        this.clearTimer();
        this.queued = false;
        this.error = failure;
        this.state =
          failure instanceof ContentStudioRequestError &&
          failure.code === 'CS_DRAFT_VERSION_CONFLICT'
            ? 'conflict'
            : 'error';
        this.emit();
        return;
      }
      this.version = (result as { draftVersion: number }).draftVersion;
      this.savedKey = key;
      this.next();
    };
    this.inFlight = run();
  }

  // After a PUT: saved, waiting for the latest edit's timer, or saving the
  // latest state now when its timer already fired or someone is flushing
  private next() {
    if (this.readOnly || this.state === 'conflict' || !this.draft) {
      return;
    }
    if (this.draftKey === this.savedKey) {
      this.state = 'idle';
      this.emit();
      return;
    }
    if (!this.attached && this.flushing === 0) {
      return;
    }
    if (this.queued || this.flushing > 0 || !this.timer) {
      this.start();
      return;
    }
    this.state = 'dirty';
    this.emit();
  }
}

// The controller of one workspace, rendered through its snapshots
export const useContentStudioAutosave = (save: SaveDraft) => {
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  const [snapshot, setSnapshot] = useState<ContentStudioAutosaveSnapshot>({
    draft: null,
    version: 0,
    state: 'idle',
    error: null,
    readOnly: true,
  });
  const [controller] = useState(
    () =>
      new ContentStudioAutosave(
        (draft, version) => saveRef.current(draft, version),
        setSnapshot
      )
  );
  useEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);
  return { ...snapshot, controller };
};
