export const HN_API = 'https://hacker-news.firebaseio.com/v0';
export const ALGOLIA_API = 'https://hn.algolia.com/api/v1';
export const ALGOLIA_HITS_PER_PAGE = 1000;

export const ALARM = {
  TICK: 'hnswered:tick',
} as const;

// navigator.locks name. `hnswered:` prefix namespaces any future
// devtools `navigator.locks.query()` output. Locks are ephemeral
// (auto-released on SW termination) so renaming has no upgrade cost.
export const LOCK = {
  TICK: 'hnswered:tick',
} as const;

export const DEFAULT_CONFIG = {
  hnUser: '',
  tickMinutes: 5,
  retentionDays: 30,
  // Backfill depth in days. Users can pick 7 / 30 / 90 in Settings.
  // Controls the "catch up after absence" reach — items older than this
  // are never swept, even if the extension was offline for longer.
  backfillDays: 7,
} as const;

export const BACKFILL_DAY_OPTIONS = [7, 30, 90] as const;

export const RETENTION = {
  HARD_REPLY_CAP: 5000,       // global max replies stored; evict oldest read once exceeded
  PAGE_SIZE: 50,              // UI "more" pagination step
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const YEAR_MS = 365 * DAY_MS;
export const DROP_AGE_MS = YEAR_MS;

// Author-sync runs when >=AUTHOR_SYNC_MS has elapsed since the last successful
// run. The comment-feed poll runs on every alarm fire.
export const AUTHOR_SYNC_MS = 10 * 60 * 1000;

// Overlap window for Algolia `numericFilters=created_at_i>X` queries.
// Must exceed `AUTHOR_SYNC_MS + max(tickMinutes)*60_000`, so a reply that
// lands on a freshly-authored comment can't age out of the window before
// the next author-sync discovers the parent. With AUTHOR_SYNC_MS=10m and
// max tickMinutes=30 (clamp in Settings.svelte), the required window is
// 40m; 45m gives margin. Redundancy is free — the comment feed is one
// request regardless of window size.
export const OVERLAP_MS = 45 * 60 * 1000;

// Hard ceiling on Settings tickMinutes so the OVERLAP_MS invariant above
// holds. Settings.svelte intervals list must stay ≤ this.
export const MAX_TICK_MINUTES = Math.floor((OVERLAP_MS - AUTHOR_SYNC_MS) / 60_000);

// Exported as a pure function so unit tests can exercise it directly AND so
// the module-load self-check below traps illegal edits to any of the three
// constants. A silently-violated cadence invariant produces missed-reply
// paths that would otherwise escape all tests (mutation M2).
export function assertCadenceInvariant(
  overlapMs: number,
  authorSyncMs: number,
  maxTickMinutes: number,
): void {
  const requiredMs = authorSyncMs + maxTickMinutes * 60_000;
  if (overlapMs < requiredMs) {
    throw new Error(
      `cadence invariant violated: OVERLAP_MS=${overlapMs} must be >= ` +
      `AUTHOR_SYNC_MS=${authorSyncMs} + MAX_TICK_MINUTES=${maxTickMinutes}min ` +
      `(required >= ${requiredMs})`,
    );
  }
}
assertCadenceInvariant(OVERLAP_MS, AUTHOR_SYNC_MS, MAX_TICK_MINUTES);

export const FETCH = {
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 500,
  BACKOFF_MAX_MS: 10_000,
  TIMEOUT_MS: 15_000,
  PER_REQUEST_DELAY_MS: 50,
} as const;
