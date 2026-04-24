const ALGOLIA_API = "https://hn.algolia.com/api/v1";
const ALGOLIA_HITS_PER_PAGE = 1e3;
const ALARM = {
  TICK: "hnswered:tick"
};
const LOCK = {
  TICK: "hnswered:tick"
};
const DEFAULT_CONFIG = {
  hnUser: "",
  tickMinutes: 5,
  retentionDays: 30,
  // Backfill depth in days. Users can pick 7 / 30 / 90 in Settings.
  // Controls the "catch up after absence" reach — items older than this
  // are never swept, even if the extension was offline for longer.
  backfillDays: 7
};
const BACKFILL_DAY_OPTIONS = [7, 30, 90];
const RETENTION = {
  HARD_REPLY_CAP: 5e3,
  // global max replies stored; evict oldest read once exceeded
  PAGE_SIZE: 50
  // UI "more" pagination step
};
const DAY_MS = 24 * 60 * 60 * 1e3;
const YEAR_MS = 365 * DAY_MS;
const DROP_AGE_MS = YEAR_MS;
const AUTHOR_SYNC_MS = 10 * 60 * 1e3;
const OVERLAP_MS = 45 * 60 * 1e3;
const MAX_TICK_MINUTES = Math.floor((OVERLAP_MS - AUTHOR_SYNC_MS) / 6e4);
const FETCH = {
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 500,
  BACKOFF_MAX_MS: 1e4,
  TIMEOUT_MS: 15e3};

export { ALGOLIA_HITS_PER_PAGE as A, BACKFILL_DAY_OPTIONS as B, DEFAULT_CONFIG as D, FETCH as F, LOCK as L, MAX_TICK_MINUTES as M, OVERLAP_MS as O, RETENTION as R, ALGOLIA_API as a, DAY_MS as b, AUTHOR_SYNC_MS as c, DROP_AGE_MS as d, ALARM as e };
//# sourceMappingURL=constants-BRcisosw.js.map
