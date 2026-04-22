export const HN_API = 'https://hacker-news.firebaseio.com/v0';

export const ALARM = {
  TICK: 'hnswered:tick',
  DAILY: 'hnswered:daily-scan',
  WEEKLY: 'hnswered:weekly-scan',
} as const;

export const DEFAULT_CONFIG = {
  hnUser: '',
  tickMinutes: 5,
  retentionDays: 30,
} as const;

export const RETENTION = {
  HARD_REPLY_CAP: 5000,       // global max replies stored; evict oldest read once exceeded
  PAGE_SIZE: 50,              // UI "more" pagination step
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const YEAR_MS = 365 * DAY_MS;

export const BUCKET = {
  FAST_MAX_AGE_MS: WEEK_MS,
  DAILY_MIN_AGE_MS: DAY_MS,
  DAILY_MAX_AGE_MS: WEEK_MS,
  WEEKLY_MIN_AGE_MS: WEEK_MS,
  WEEKLY_MAX_AGE_MS: YEAR_MS,
  DROP_AGE_MS: YEAR_MS,
} as const;

export const FETCH = {
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 500,
  BACKOFF_MAX_MS: 10_000,
  TIMEOUT_MS: 15_000,
  PER_REQUEST_DELAY_MS: 50,
  // Hard caps to keep us polite — HN has no rate limit documented,
  // but a prolific user can have thousands of submissions. Cap per-sync work.
  MAX_SYNC_ITEMS_PER_CALL: 15,
  MAX_REPLIES_PER_CHECK: 10,
  // Minimum time between successive /v0/user/<id> + submission-walk syncs.
  USER_SYNC_MIN_INTERVAL_MS: 30 * 60 * 1000,
} as const;
