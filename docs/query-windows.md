# Query windows — what the extension actually asks HN for

There are exactly three code paths that query HN. This document lists their
scopes so you don't have to re-derive them from
[poller.ts](../src/background/poller.ts) +
[algolia-client.ts](../src/background/algolia-client.ts) every time.

## 1. Backfill catch-up

Per-parent Algolia sweep that fills gaps the rolling comment-feed window can't cover. See [design.md §7](../cost-analysis/docs/design.md#7-backfill-catch-up-design) for full design.

- Endpoint: Algolia `search?tags=comment&numericFilters=parent_id=<id>,created_at_i>since` per parent
- Item scope: each monitored item authored in the past `backfillDays` (user-configured 7 / 30 / 90, default 7)
- Reply scope: replies newer than the pinned `backfillSweepFloor` — computed from `max(lastBackfillSweepAt − OVERLAP_MS, now − backfillDays)` at sweep-start
- Triggers (any of):
  - First configure / username change (fullDrain, burst)
  - `backfillDays` widened (fullDrain, burst)
  - Gap since `lastBackfillSweepAt` exceeds `OVERLAP_MS` (drip, one parent per tick)
  - `neverSwept` upgrade-in-place case (drip)
- Drain cadence: one parent per tick (drip) OR all-at-once paced at `DRAIN_ALL_DELAY_MS = 1500ms` (fullDrain, holds `LOCK.TICK` for the duration)

## 2. Author-sync (populates `monitored`)

Runs every ~10 minutes (`AUTHOR_SYNC_MS` gate) AND on every force-refresh.

- Endpoint: Algolia `search_by_date?tags=story,author_X` + `tags=comment,author_X`, paginated up to 5 pages per tag
- First sync window: past **365 days** (`DROP_AGE_MS`)
- Subsequent syncs: `lastAuthorSync − OVERLAP_MS` → now
- Does NOT fetch replies — only builds/refreshes the parent list

## 3. Reply poll (ongoing)

Runs on every alarm tick (user-configured `tickMinutes`, default 5, min 1).

- Endpoint: Algolia `search_by_date?tags=comment&numericFilters=created_at_i>since`
- Window: `now − 45 minutes` (`OVERLAP_MS`)
- Filter: keep hits where `parent_id ∈ monitored.keys()` and `author !== hnUser`
- One request per tick regardless of how many items are monitored

## Coverage implications

- Replies posted **before install**, to items older than `backfillDays` (default 7d): **never surfaced** — no code path queries them.
- Replies posted **before install**, to items ≤ `backfillDays` old: caught by backfill (path 1) on first configure.
- Replies posted **after install, during normal operation**: caught by the rolling 45-min comment-feed poll (path 3), as long as the SW runs at least once every 45 min.
- Replies posted **during an offline gap longer than `OVERLAP_MS`**: caught by backfill (path 1), which re-sweeps all monitored parents when the gap is detected.

## The one correctness knob

`OVERLAP_MS (45m) ≥ tickMinutes + AUTHOR_SYNC_MS (10m)`.

Violating this means a reply to a freshly-authored item could age out of the
comment-feed window before the next author-sync discovers the parent. The
UI clamps `tickMinutes` to `[1, 5, 15, 30]` so the invariant holds at every
permitted setting — at `tickMinutes=30`, cushion is 5 min; at 1, 34 min.
