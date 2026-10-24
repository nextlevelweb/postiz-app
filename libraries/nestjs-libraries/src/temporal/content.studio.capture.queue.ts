// The Temporal task queue of Content Studio feed captures (P8-C2). The feed
// workflows stay on `main`; only their heavy activity (one whole feed
// capture: the feed and up to 25 pages, 5 at a time) is scheduled here, and
// one activity-only Worker in the orchestrator runs it with a fixed number of
// slots. Captures past that wait in the queue, so many organizations' feeds
// due at once cannot take the network, memory or database away from posting.
//
// Technical worker capacity, not a product or organization limit. It is per
// orchestrator process: WORKER_CONCURRENCY_DIVIDER splits it across servers
// like the provider queues, or EXCLUDE_QUEUE pins the queue to one server.
//
// Imported by the workflow bundle: no Node, Nest or environment here
export const CONTENT_STUDIO_CAPTURE_TASK_QUEUE = 'content-studio-capture';

// Feed captures run at once per orchestrator. Each runs at most 5 page
// fetches at a time (FEED_CAPTURE_CONCURRENCY), so the default is at most 8
// feed fetches or 40 page fetches at once
export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT = 8;
export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX = 32;

export class ContentStudioCaptureConcurrencyError extends Error {
  constructor() {
    super(
      `CONTENT_STUDIO_CAPTURE_CONCURRENCY must be a whole number from 1 to ${CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX}`
    );
    this.name = 'ContentStudioCaptureConcurrencyError';
  }
}

// CONTENT_STUDIO_CAPTURE_CONCURRENCY as given: unset or empty is the default,
// anything else must be exactly a whole number in range. A wrong value stops
// the orchestrator rather than run with another capacity
export const contentStudioCaptureConcurrency = (
  value: string | undefined
): number => {
  if (value === undefined || value === '') {
    return CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT;
  }
  if (!/^[1-9][0-9]{0,2}$/.test(value)) {
    throw new ContentStudioCaptureConcurrencyError();
  }
  const concurrency = Number(value);
  if (concurrency > CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX) {
    throw new ContentStudioCaptureConcurrencyError();
  }
  return concurrency;
};
