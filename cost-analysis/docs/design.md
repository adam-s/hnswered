# HNswered polling design

Current-truth reference for how the extension should detect replies. Replaces
the earlier exploration docs and simulator reports.

## 1. Why not `/v0/updates.json`

The HN `/v0/updates.json` feed is a narrow rolling window — roughly 40
globally-changed item ids. Using it as a gate to decide which monitored items
are worth re-fetching silently drops replies on low-traffic items, because a
monitored item is rarely present in that window at the moment the alarm fires.
It is not a viable primitive for this extension and is not used.

The production poller already removed the gate; the disavowal lives in the
comment at [src/background/poller.ts:252](../../src/background/poller.ts#L252).
Any future design work should treat that comment as load-bearing and not
re-introduce `updates.json` under any name.

## 2. Architecture

Three layers, in priority order:

1. **Algolia comment-feed polling — primary reply detection.**
   One request against `search_by_date?tags=comment` covers every comment on
   HN within the overlap window. Filter hits where `parent_id ∈ user_item_ids`.
   Cost does not scale with the number of monitored items or with per-item
   reply fan-out.

2. **Algolia author-sync — parent discovery.**
   Periodic `search_by_date?tags=(story,comment),author_<handle>` so newly
   authored user items are known before replies land on them.

3. **Firebase — recovery only.**
   A daily `/v0/item/<id>.json` cross-check against each known user item
   younger than ~30 days catches rare Algolia index misses. Optional hot-parent
   Firebase polls on very fresh user items can reduce index-lag latency if the
   budget allows, but are not required for correctness.

### Correctness invariant

**Overlap window ≥ max(comment-poll interval, author-sync interval).**
If the overlap is shorter than the author-sync interval, a reply on a
freshly-authored comment can age out of the window before the author-sync
discovers the parent. This is the only non-obvious correctness trap.

### Implementation sketch

On each poll:

1. If the author-sync interval has elapsed, run
   `search_by_date?tags=(story,comment),author_<handle>&numericFilters=created_at_i>author_cursor_minus_overlap`
   and update the local `user_item_ids` set.
2. Query comments:
   `search_by_date?tags=comment&numericFilters=created_at_i>now_minus_overlap&hitsPerPage=1000`.
3. Filter hits where `parent_id ∈ user_item_ids`.
4. Deduplicate by reply `objectID`.
5. Surface unseen non-self replies.

Daily Firebase cross-check (off the fast path):

- For each known user item younger than 30 days, fetch `/v0/item/<id>.json`.
- Diff `kids[]` against locally known reply ids.
- Surface any missing replies as delayed.

## 3. Configurations

Req/day counts Algolia comment-feed polls + Algolia author-sync only. The
daily Firebase cross-check adds at most one request per known user item per
day on top.

### Low-budget profiles

| Name | Comment poll | Author sync | Overlap | Algolia req/day | Median surface | p95 surface |
|---|---:|---:|---:|---:|---:|---:|
| Minimum | 15m | 15m | 15m | 192 | 7.7m | 14.4m |
| Balanced | 5m | 10m | 10m | 432 | 2.6m | 4.7m |
| Fast | 3m | 10m | 10m | 624 | 1.6m | 2.9m |
| Faster | 2m | 10m | 10m | 864 | 1.0m | 1.9m |
| Near-realtime | 1m | 2m | 5m | 2,160 | 0.5m | 0.9m |

**Recommended default: Balanced.** Materially faster than Minimum while staying
under 500 req/day, and overlap > sync protects the correctness invariant.

**Recommended high-speed mode: Fast.** ~1.5-minute median at ~624 req/day.

### High-budget profiles (~10,000 req/day ceiling)

| Name | Comment poll | Author sync | Overlap | Algolia req/day | Median surface | p95 surface |
|---|---:|---:|---:|---:|---:|---:|
| Polite fast | 15s | 30s | 5m | 8,640 | 7s | 14s |
| Safer headroom | 12s | 45s | 5m | 9,120 | 5s | 11s |
| Max | 10s | 90s | 5m | 9,600 | 4s | 9s |

**Recommended high-budget default: Polite fast.** Leaves ~1,360 req/day for
Firebase recovery/hot-parent checks.

### Saturation

Below ~12–15s polling, marginal gains are bounded by Algolia indexing lag,
network latency, and service-worker wake overhead rather than poll cadence.
Going from 15s → 10s spends another 960 req/day for ~5s of p95 improvement and
squeezes Firebase recovery headroom. Treat ~12s as the practical floor.

### Tempting configs that fail the invariant

`poll=10m, sync=30m, overlap=10m` costs the same 192 req/day as Minimum with a
lower median, but comment-reply catch drops from 100% to ~87% within 1h. The
30-minute author sync lets reply events on freshly-authored comments age out
of the 10m overlap before the parent is known. Don't skimp on overlap vs. sync.

## 4. Sample methodology

Two datasets informed the frontier:

- **Initial live dataset** — 449 authored items, 1,490 non-self direct replies
  (1,379 story-replies, 111 comment-replies) collected via the extension's
  live audit path.
- **Widened Algolia story sample** — 497 recent story trees, 6,081 non-self
  direct reply edges (1,663 story-replies, 4,418 comment-replies). Median
  reply-age-from-parent 4,091s; p95 45,500s. Only ~0.1% of replies arrive
  within 60s of the parent; ~5.3% within 5 minutes.

The widened sample confirmed the same saturation point (~12–15s polling) as
the initial dataset.

**Collection note:** a 1,000-story burst with high concurrency triggered
Algolia `403 Forbidden`. A 500-story pass completed cleanly. Future widening
should keep concurrency modest and page/time-slice collection rather than
bursting the full cap.

## 5. Caching invariants

Store in `chrome.storage.local`:

- `user_item_ids` — keyed by HN id, with `created_at_i`, type, parent id.
- `seen_reply_ids` — keyed by Algolia `objectID`.
- Newest-seen timestamp cursors — optimization only, not correctness.

**Correctness comes from the overlap window plus dedupe.** Cursors are an
optimization to shrink query ranges. If a cursor is lost or corrupted, the
overlap window still catches everything; the system degrades to slightly more
hits per poll, not to missed replies.

Retention/pruning follows the existing policy already in the extension.

## 6. Validation plan

Extrapolation has narrowed the space to two plausible configs. Only a live
shadow run can produce true production numbers (real Algolia indexing lag,
sustained throttling behavior, MV3 wake reliability at sub-minute cadence,
end-to-end surface time through storage writes and UI propagation).

**Plan:**

1. Shadow-run two candidates in parallel: `15s/30s/5m` (Polite fast) and
   `12s/45s/5m` (Safer headroom).
2. Run for 3–7 days.
3. Truth source (run in parallel to both candidates):
   - Firebase hot-parent checks for user items younger than 1h.
   - Daily `/v0/item/<id>.json` cross-check for everything else.
4. Per reply, log:
   - HN post time
   - Algolia first-seen time
   - extension-surfaced time
   - whether it required Firebase recovery
   - per-candidate request counts and any 403/429/5xx
5. Compare p50/p95/p99 latency, miss rate, and request burn across candidates.

Success criteria: ≥99.9% catch within 1h; p95 surface time matches the
extrapolated figures within ~2×; zero sustained 403/429.
