# Query windows — what the extension actually asks HN for

There are exactly three code paths that query HN. This document lists their
scopes so you don't have to re-derive them from
[poller.ts](../src/background/poller.ts) +
[algolia-client.ts](../src/background/algolia-client.ts) every time.

## 1. First-install backfill

Runs **once**, on first configure or username change.

- Endpoint: Algolia `search?tags=comment&numericFilters=parent_id=<id>` per item
- Item scope: each monitored item authored in the past **7 days** (`BACKFILL_AGE_MS = WEEK_MS` in [poller.ts](../src/background/poller.ts))
- Reply scope: **every direct reply, regardless of age** (no `since` filter)
- Purpose: avoid an empty sidepanel right after install

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

- Replies posted **before install**, to items older than 1 week: **never surfaced** — no code path queries them.
- Replies posted **before install**, to items ≤1 week old: caught by backfill (path 1).
- Replies posted **after install**: caught by the rolling 45-min poll (path 3), as long as the SW runs at least once every 45 min.

## The one correctness knob

`OVERLAP_MS (45m) ≥ tickMinutes + AUTHOR_SYNC_MS (10m)`.

Violating this means a reply to a freshly-authored item could age out of the
comment-feed window before the next author-sync discovers the parent. The
UI clamps `tickMinutes` to `[1, 5, 15, 30]` so the invariant holds at every
permitted setting — at `tickMinutes=30`, cushion is 5 min; at 1, 34 min.
