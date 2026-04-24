/**
 * End-to-end temporal tests for backfill: simulates wall-clock advancement via
 * @sinonjs/fake-timers so the production code paths — which call `Date.now()`
 * directly — can be exercised across multi-hour and multi-week gaps.
 *
 * The `now` parameter on maybeEnqueueBackfillSweep / drainOneBackfillItem is
 * tested in poller.test.ts. This file proves the same temporal invariants hold
 * when those functions are called WITHOUT the param (real code path uses
 * `nowMs = () => Date.now()` default), with time driven by fake-timers.
 *
 * Why fake-timers (not hand-rolled): @sinonjs/fake-timers is the same clock
 * primitive used by Sinon, Jest, Vitest — battle-tested monkey-patching of
 * `Date`, `Date.now`, `performance.now`. Sinon docs call out that ONLY `Date`
 * needs faking for this use case; faking setTimeout would deadlock the
 * production HN client's sleep() retry loop (see tests/harness/clock.ts for
 * the full rationale).
 *
 * Null hypothesis we're trying to falsify (per rigorous-testing framing):
 *
 *   H₀: "The backfill behavior is independent of wall-clock advancement."
 *
 * Rejected by every test below — each constructs a scenario where the output
 * (queue content, `since` passed to Algolia, lastBackfillSweepAt) differs
 * based on how far the fake clock advanced. If the code read time incorrectly
 * or cached a stale value, the asserted output would not hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import FakeTimers from '@sinonjs/fake-timers';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createFakeHN } from '../shim/fake-hn.ts';
import { createStore } from '../../src/background/store.ts';
import {
  computeBackfillSinceMs,
  drainOneBackfillItem,
  maybeEnqueueBackfillSweep,
} from '../../src/background/poller.ts';
import { DAY_MS } from '../../src/shared/constants.ts';
import type { AlgoliaCommentHit, MonitoredItem } from '../../src/shared/types.ts';

const T0 = Date.UTC(2026, 3, 23, 12, 0, 0); // 2026-04-23T12:00:00Z — stable anchor

function seed(store: ReturnType<typeof createStore>, monitored: Array<{ id: number; ageMs: number }>, now: number) {
  const m: Record<string, MonitoredItem> = {};
  for (const i of monitored) {
    m[String(i.id)] = {
      id: i.id,
      type: 'story',
      submittedAt: now - i.ageMs,
      title: `story ${i.id}`,
    };
  }
  return store.setMonitored(m);
}

function commentHit(p: { id: number; parent_id: number; author: string; ageMs: number; now: number }): AlgoliaCommentHit {
  return {
    objectID: String(p.id),
    created_at_i: Math.floor((p.now - p.ageMs) / 1000),
    author: p.author,
    comment_text: `reply ${p.id}`,
    parent_id: p.parent_id,
  };
}

// ---------------------------------------------------------------------------

test('temporal: "off 3 hours, 1-week setting" — real Date.now() driven by fake-timers', async () => {
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });

    // T0-3h: the last comment poll completed. Record it.
    clock.setSystemTime(T0 - 3 * 60 * 60 * 1000);
    await store.setTimestamp('lastCommentPoll', Date.now());
    await store.setTimestamp('lastBackfillSweepAt', Date.now());

    // T0: simulate SW waking up after a 3-hour gap. Seed monitored FROM the
    // wake-up perspective (so "3 days ago" means 3 days ago at T0).
    clock.setSystemTime(T0);
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 6 * DAY_MS },
      { id: 3, ageMs: 8 * DAY_MS }, // outside 7d
    ], Date.now());

    // Enqueue-sweep reads Date.now() internally (default param) — no `now` passed.
    const enqueued = await maybeEnqueueBackfillSweep(store);
    assert.equal(enqueued, 2, '3h gap > OVERLAP_MS triggers enqueue of past-week items');
    assert.deepEqual(await store.getBackfillQueue(), [1, 2], 'DESC by submittedAt');

    // Seed Algolia with two replies on id=1: one from during the 3h gap, one from 5h ago (pre-sweep).
    const hn = createFakeHN();
    hn.seedParentChild(1, commentHit({ id: 500, parent_id: 1, author: 'bob', ageMs: 2 * 60 * 60 * 1000, now: T0 })); // 2h ago
    hn.seedParentChild(1, commentHit({ id: 501, parent_id: 1, author: 'bob', ageMs: 5 * 60 * 60 * 1000, now: T0 })); // 5h ago

    // Drip — reads Date.now() internally for the since calculation.
    const surfaced = await drainOneBackfillItem(hn, store);
    assert.equal(surfaced, 1, 'only the 2h-old reply (inside the 3h gap) surfaces');

    // Prove the since filter was the ACTUAL wall-clock value of 3h ago,
    // not some stale cached now.
    const callLog = hn.log().find((l) => l.includes('parent_id=1'));
    const sinceSec = Number(callLog?.match(/since=(\d+)/)?.[1] ?? -1);
    assert.equal(sinceSec, Math.floor((T0 - 3 * 60 * 60 * 1000) / 1000),
      'since = lastBackfillSweepAt (3h pre-T0) — reading Date.now() via fake-timers');
  } finally { off(); clock.uninstall(); }
});

test('temporal: "off 2 weeks, 1-week setting" — depth caps `since` at now − 7d', async () => {
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });

    // Prior sweep 2 weeks ago.
    clock.setSystemTime(T0 - 14 * DAY_MS);
    await store.setTimestamp('lastCommentPoll', Date.now());
    await store.setTimestamp('lastBackfillSweepAt', Date.now());

    // Advance to wake-up.
    clock.setSystemTime(T0);
    await seed(store, [
      { id: 10, ageMs: 3 * DAY_MS },
      { id: 20, ageMs: 10 * DAY_MS }, // outside 7d → ignored
      { id: 30, ageMs: 20 * DAY_MS }, // outside 7d → ignored
    ], Date.now());

    const enqueued = await maybeEnqueueBackfillSweep(store);
    assert.equal(enqueued, 1, 'only id=10 within 7d — older weeks discarded per user policy');

    const hn = createFakeHN();
    await drainOneBackfillItem(hn, store);

    // Use the explicit parent-filtered log line, not log[0] — guards against
    // a future code path adding an earlier call with a coincidentally-matching
    // `since=` that would make this assertion validate the wrong request.
    const call = hn.log().find((l) => l.includes('parent_id=10'));
    assert.ok(call, 'expected a searchByParent call for id=10');
    const sinceSec = Number(call?.match(/since=(\d+)/)?.[1] ?? -1);
    assert.equal(sinceSec, Math.floor((T0 - 7 * DAY_MS) / 1000),
      'depth (7d) caps since — not the 2-week gap');
  } finally { off(); clock.uninstall(); }
});

test('temporal: wall-clock drift from T0 to T0+5min does NOT re-trigger enqueue', async () => {
  // Once steady-state polling resumes, Date.now() continues to advance, but the
  // gap between ticks stays small. Enqueue must not fire on every tick.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    await seed(store, [{ id: 1, ageMs: 1 * DAY_MS }], T0);

    // Simulate a successful poll 1 minute ago AND a prior completed sweep —
    // steady-state means both conditions are settled, so neither trigger fires.
    await store.setTimestamp('lastCommentPoll', T0 - 60_000);
    await store.setTimestamp('lastBackfillSweepAt', T0 - 60_000);

    // Enqueue at T0, T0+60s, T0+120s, T0+180s — all should be no-ops.
    for (let i = 0; i < 4; i++) {
      clock.tick(60_000);
      // Also update lastCommentPoll to simulate the poll running each tick.
      await store.setTimestamp('lastCommentPoll', Date.now() - 1000);
      const n = await maybeEnqueueBackfillSweep(store);
      assert.equal(n, 0, `tick ${i}: steady-state, no enqueue`);
    }
    assert.deepEqual(await store.getBackfillQueue(), [], 'queue remains empty throughout');
  } finally { off(); clock.uninstall(); }
});

test('temporal: full backfill lifecycle with fake-timers — enqueue, multi-tick drain, lastBackfillSweepAt advances', async () => {
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    const hn = createFakeHN();

    // Prior sweep, 2 days ago.
    const priorSweepAt = T0 - 2 * DAY_MS;
    await store.setTimestamp('lastCommentPoll', priorSweepAt);
    await store.setTimestamp('lastBackfillSweepAt', priorSweepAt);

    // Wake up at T0 with 3 items in past week.
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 3 * DAY_MS },
      { id: 3, ageMs: 5 * DAY_MS },
    ], T0);

    // Seed one reply per item, posted during the 2-day gap (1 hour ago).
    for (const id of [1, 2, 3]) {
      hn.seedParentChild(id, commentHit({
        id: id * 100, parent_id: id, author: 'bob', ageMs: 60 * 60 * 1000, now: T0,
      }));
    }

    assert.equal(await maybeEnqueueBackfillSweep(store), 3);

    // Drip 3 ticks — advance clock 1 min each (simulating real alarm cadence).
    await drainOneBackfillItem(hn, store);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, priorSweepAt,
      'tick 1: not yet complete');

    clock.tick(60_000);
    await drainOneBackfillItem(hn, store);
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, priorSweepAt,
      'tick 2: not yet complete');

    clock.tick(60_000);
    const finalNow = Date.now();
    await drainOneBackfillItem(hn, store);

    const endTs = (await store.getTimestamps()).lastBackfillSweepAt;
    assert.equal(endTs, finalNow, 'tick 3: queue drained → lastBackfillSweepAt = now');

    assert.deepEqual(await store.getBackfillQueue(), []);
    assert.equal(Object.keys(await store.getReplies()).length, 3,
      'all 3 gap-replies surfaced via backfill drip');

    // Post-drain: another tick at T0+3min. Should NOT re-enqueue (gap from
    // lastCommentPoll is huge, but we need a *new* gap to re-trigger. In real
    // flow pollComments runs between, updating lastCommentPoll. Simulate it.
    await store.setTimestamp('lastCommentPoll', Date.now());
    clock.tick(60_000);
    const reEnqueued = await maybeEnqueueBackfillSweep(store);
    assert.equal(reEnqueued, 0, 'steady-state tick after complete sweep → no re-storm');
  } finally { off(); clock.uninstall(); }
});

test('temporal: fake-timers advances Date.now AND Date objects (regression guard)', () => {
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  try {
    assert.equal(Date.now(), T0, 'Date.now pinned at T0');
    assert.equal(new Date().getTime(), T0, 'new Date() uses same clock');
    clock.tick(123_456);
    assert.equal(Date.now(), T0 + 123_456, 'clock.tick advances Date.now');
    assert.equal(new Date().getTime(), T0 + 123_456, 'clock.tick advances new Date()');
  } finally { clock.uninstall(); }
});

// ===========================================================================
// Regression tests — each proves a specific red-team finding is fixed.
// Before the fix these assertions would fail.
// ===========================================================================

test('REGRESSION HIGH#1: sliding-window — pinned floor stays fixed across a multi-hour drain', async () => {
  // Red-team finding: on first install (lastBackfillSweepAt=0) with a large
  // queue draining over many ticks, `now - depth` slides forward per drain
  // and later items lose coverage. Fix: pin `since` at enqueue time.
  //
  // This test simulates first install (no prior sweep) with a 7-day depth.
  // Drain ten items spread across 50 real hours of fake-clock time. EVERY
  // drain must query Algolia with the SAME since value — the one pinned at
  // enqueue time (T0 − 7d). A regression (sliding) would show the `since`
  // advancing per drain.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    // First-install state: no prior sweep.
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, 0);
    assert.equal((await store.getTimestamps()).backfillSweepFloor, 0);

    const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, ageMs: (i + 1) * DAY_MS * 0.5 }));
    await seed(store, items, T0);

    const enqueued = await maybeEnqueueBackfillSweep(store);
    assert.equal(enqueued, 10);
    const pinnedFloor = (await store.getTimestamps()).backfillSweepFloor;
    assert.equal(pinnedFloor, T0 - 7 * DAY_MS, 'floor pinned at T0 − 7d at enqueue time');

    const sinceValues: number[] = [];
    for (let i = 0; i < 10; i++) {
      clock.tick(5 * 60 * 60 * 1000); // +5 hours per drain — simulates 50h over full drain
      await drainOneBackfillItem(hn, store);
      const call = hn.log().find((l) => l.includes(`parent_id=${items[i].id}&since=`));
      const s = Number(call?.match(/since=(\d+)/)?.[1] ?? -1);
      sinceValues.push(s);
    }
    const expectedSinceSec = Math.floor((T0 - 7 * DAY_MS) / 1000);
    for (const [i, s] of sinceValues.entries()) {
      assert.equal(s, expectedSinceSec,
        `drain ${i}: since must equal the pinned floor (T0 − 7d); sliding window would have this advance`);
    }
    // After all 10 drains, queue empty → sweep complete → floor cleared, lastBackfillSweepAt advanced.
    assert.equal((await store.getBackfillQueue()).length, 0);
    assert.equal((await store.getTimestamps()).backfillSweepFloor, 0, 'floor cleared on completion');
    assert.ok((await store.getTimestamps()).lastBackfillSweepAt > 0);
  } finally { off(); clock.uninstall(); }
});

test('REGRESSION: sweep-in-progress blocks re-enqueue (prevents the drained-items re-storm bug)', async () => {
  // Pre-fix: every tick with `lastBackfillSweepAt=0` would re-enqueue items
  // that had just been drained, because the dedupe against `existing` queue
  // only catches items still IN the queue. Drained items were already popped
  // but still in `monitored`, so they got re-added forever. Queue stayed
  // pinned at its original size, drain never completed, lastBackfillSweepAt
  // never advanced, sweep became infinite.
  //
  // Fix: enqueue is a no-op whenever the queue is non-empty. Tick cadence can
  // re-trigger only after the queue fully drains.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 2 * DAY_MS },
      { id: 3, ageMs: 3 * DAY_MS },
    ], T0);

    // Tick 1: initial enqueue. Queue = [1, 2, 3].
    await maybeEnqueueBackfillSweep(store);
    assert.deepEqual(await store.getBackfillQueue(), [1, 2, 3]);

    // Tick 1 drain. Queue = [2, 3].
    await drainOneBackfillItem(hn, store);
    assert.deepEqual(await store.getBackfillQueue(), [2, 3]);

    // Tick 2: enqueue attempt WHILE sweep is in progress. MUST be a no-op —
    // the bug was that id=1 (just drained, still in monitored) would be re-added.
    clock.tick(60_000);
    const enqueued = await maybeEnqueueBackfillSweep(store);
    assert.equal(enqueued, 0, 'no re-enqueue during active sweep');
    assert.deepEqual(await store.getBackfillQueue(), [2, 3],
      'queue unchanged — drained item NOT re-added');

    // Finish the sweep.
    await drainOneBackfillItem(hn, store); // queue = [3]
    await drainOneBackfillItem(hn, store); // queue = []
    assert.equal((await store.getBackfillQueue()).length, 0);
    assert.ok((await store.getTimestamps()).lastBackfillSweepAt > 0,
      'sweep complete → timestamp advanced');
  } finally { off(); clock.uninstall(); }
});

test('REGRESSION HIGH#2: setConfig clamps tickMinutes to [1, MAX_TICK_MINUTES]', async () => {
  // Red-team finding: UI clamp to [1,5,15,30] can be bypassed by a legacy
  // saved config or a crafted setConfig. The store must enforce the invariant
  // so ensureAlarms doesn't schedule a tick cadence that violates
  // OVERLAP_MS ≥ tickMinutes + AUTHOR_SYNC_MS.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const saved60 = await store.setConfig({ hnUser: 'alice', tickMinutes: 60 });
    assert.ok(saved60.tickMinutes <= 35, `tickMinutes=60 must be clamped, got ${saved60.tickMinutes}`);
    const saved0 = await store.setConfig({ tickMinutes: 0 });
    assert.equal(saved0.tickMinutes, 1, 'tickMinutes=0 clamps to 1');
    const savedNeg = await store.setConfig({ tickMinutes: -5 });
    assert.equal(savedNeg.tickMinutes, 1);
    const saved15 = await store.setConfig({ tickMinutes: 15 });
    assert.equal(saved15.tickMinutes, 15, 'valid values pass through');
  } finally { off(); }
});

test('REGRESSION HIGH#2: setConfig rejects invalid backfillDays, falls back to default', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const bad = await store.setConfig({ hnUser: 'alice', backfillDays: 365 });
    assert.equal(bad.backfillDays, 7, 'non-whitelist value falls back to default 7');
    const good = await store.setConfig({ backfillDays: 30 });
    assert.equal(good.backfillDays, 30);
  } finally { off(); }
});

test('REGRESSION MED#1: future-clock lastBackfillSweepAt does not produce future `since`', () => {
  // Red-team finding: if system clock rolls back, lastBackfillSweepAt can
  // exceed now. Without the clamp, `since` becomes a future timestamp and
  // Algolia silently returns zero hits forever.
  const now = T0;
  const futureSweep = T0 + 2 * DAY_MS; // lastBackfillSweepAt is in the future
  const since = computeBackfillSinceMs({ now, lastBackfillSweepAt: futureSweep, backfillDays: 7 });
  assert.ok(since <= now, `since (${since}) must not exceed now (${now})`);
  assert.equal(since, now, 'clamped to `now` — next successful poll will advance it safely');
});

test('REGRESSION: extension-upgrade-in-place — user was already polling, never backfilled, upgrade adds backfill capability', async () => {
  // User had the extension configured BEFORE backfill shipped. On upgrade,
  // `lastCommentPoll` is recent (polling worked) but `lastBackfillSweepAt=0`
  // (backfill feature is new, never ran for this user). The enqueue trigger
  // must fire even though the gap is tiny — otherwise the new feature never
  // runs for upgraded users.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'mfiguiere', backfillDays: 7 });
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 5 * DAY_MS },
    ], T0);
    // Simulate upgrade-in-place: polled recently, but never swept.
    await store.setTimestamp('lastCommentPoll', T0 - 2 * 60 * 1000); // 2 min ago
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, 0);

    const n = await maybeEnqueueBackfillSweep(store);
    assert.equal(n, 2,
      'upgrade-in-place must enqueue: polling was working, but backfill has never run');
    assert.deepEqual(await store.getBackfillQueue(), [1, 2]);
  } finally { off(); clock.uninstall(); }
});

test('REGRESSION HIGH: mid-sweep absence INVALIDATES current sweep and re-enqueues with widened floor', async () => {
  // Scenario: sweep in progress with parent 1 already drained, parents 2,3
  // still queued. Laptop sleeps for 2 hours. Reply arrives on parent 1
  // during sleep. Wake tick must re-enqueue parent 1 (among others) with a
  // floor that reaches back into the absence window — otherwise the reply
  // is lost forever when the sweep eventually completes.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 2 * DAY_MS },
      { id: 3, ageMs: 3 * DAY_MS },
    ], T0);
    await store.setTimestamp('lastCommentPoll', T0 - 60_000); // recent — no absence yet

    // Initial sweep.
    await maybeEnqueueBackfillSweep(store);
    assert.deepEqual(await store.getBackfillQueue(), [1, 2, 3]);
    const initialFloor = (await store.getTimestamps()).backfillSweepFloor;

    // Drain parent 1.
    await drainOneBackfillItem(hn, store);
    assert.deepEqual(await store.getBackfillQueue(), [2, 3]);

    // Simulate 2-hour absence.
    clock.tick(2 * 60 * 60 * 1000);
    await store.setTimestamp('lastCommentPoll', T0 - 60_000); // didn't advance during sleep

    // Seed a gap reply on parent 1 posted 1 hour into the absence (so ~1hr ago).
    // Proof-of-recovery: after re-enqueue + drain, this reply MUST be in storage.
    const gapReplyId = 42;
    const gapReplyTimeSec = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // 1h ago
    hn.seedParentChild(1, {
      objectID: String(gapReplyId), author: 'bob',
      comment_text: 'arrived during the gap',
      parent_id: 1, created_at_i: gapReplyTimeSec,
    });

    // Wake tick: absence detected. Must invalidate the in-progress sweep.
    const enqueued = await maybeEnqueueBackfillSweep(store);
    assert.equal(enqueued, 3, 'all 3 items re-enqueued despite sweep having been mid-drain');
    assert.deepEqual(await store.getBackfillQueue(), [1, 2, 3],
      'queue replaced with full in-window set — parent 1 re-included to catch gap replies');
    const newFloor = (await store.getTimestamps()).backfillSweepFloor;
    assert.ok(newFloor <= initialFloor,
      `new floor (${new Date(newFloor).toISOString()}) must be ≤ initial (${new Date(initialFloor).toISOString()}) — widened, not narrowed`);

    // **Critical**: drain the re-enqueued parent 1 and prove the gap reply surfaces.
    // Earlier iteration of this test only checked queue/floor and would have
    // passed even if the re-enqueue used a too-narrow floor (since skipping
    // the gap reply). This assertion closes that gap.
    await drainOneBackfillItem(hn, store); // drains head = parent 1
    const replies = await store.getReplies();
    assert.ok(replies[String(gapReplyId)],
      'gap reply (posted during 2h absence) MUST surface when parent 1 is re-drained after absence invalidation');
  } finally { off(); clock.uninstall(); }
});

test('REGRESSION MED: neverSwept-during-drain still skips (no re-storm of drained items)', async () => {
  // Invariant: the neverSwept trigger must NOT re-enqueue drained items.
  // Only the `absence` trigger invalidates a sweep. This guards against
  // reintroducing the steady-state re-storm bug.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 2 * DAY_MS },
    ], T0);
    await store.setTimestamp('lastCommentPoll', T0 - 60_000);

    await maybeEnqueueBackfillSweep(store);
    await drainOneBackfillItem(hn, store);
    assert.deepEqual(await store.getBackfillQueue(), [2]);

    // Steady-state next tick — no absence. neverSwept is still true
    // (lastBackfillSweepAt hasn't advanced yet — queue non-empty).
    clock.tick(60_000);
    await store.setTimestamp('lastCommentPoll', Date.now() - 30_000); // current
    const n = await maybeEnqueueBackfillSweep(store);
    assert.equal(n, 0, 'no re-enqueue during neverSwept + in-progress sweep');
    assert.deepEqual(await store.getBackfillQueue(), [2]);
  } finally { off(); clock.uninstall(); }
});

test('drain: always uses sweep floor regardless of stored-reply state (per-parent optimization removed)', async () => {
  // Per-parent cursor was removed after red-team showed it can skip gap
  // replies after an absence. Every drain now uses the pinned sweep floor.
  // H₀: "drain might advance `since` based on a recent stored reply".
  // Rejected: whether or not recent replies exist, since == sweep floor.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 30 });
    await seed(store, [{ id: 100, ageMs: 20 * DAY_MS }], T0);

    // Adversarial setup: a prior sweep, a recent stored reply. A per-parent
    // implementation would use the recent reply timestamp as `since`.
    await store.setTimestamp('lastBackfillSweepAt', T0 - 1 * DAY_MS);
    await store.addReplies([{
      id: 555, parentItemId: 100, author: 'bob',
      text: 'prior', time: T0 - 5 * DAY_MS, read: false, discoveredAt: T0 - 5 * DAY_MS,
    }]);

    const sweepFloorMs = T0 - 30 * DAY_MS;
    await store.setTimestamp('backfillSweepFloor', sweepFloorMs);
    await store.setBackfillQueue([100]);

    await drainOneBackfillItem(hn, store);
    const call = hn.log().find((l) => l.includes('parent_id=100'));
    const sinceSec = Number(call?.match(/since=(\d+)/)?.[1] ?? -1);
    assert.equal(sinceSec, Math.floor(sweepFloorMs / 1000),
      'since MUST equal sweep floor (30d), NOT the 5d-old stored reply time');
  } finally { off(); clock.uninstall(); }
});

test('REGRESSION: per-parent cursor is NOT used on first sweep (lastBackfillSweepAt=0)', async () => {
  // Bug caught live: after `clearPerUserState` on user change, pollComments
  // surfaces a few recent replies from the 45-min rolling window. The previous
  // (buggy) per-parent cursor saw those stored replies and advanced `since`
  // past them — skipping the historical 7-day slice the first sweep was
  // supposed to cover.
  //
  // Fix: per-parent is only trusted after a sweep has completed (`lastBackfillSweepAt > 0`).
  // On first-ever sweep, always use the full sweep floor.
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    await seed(store, [{ id: 100, ageMs: 5 * DAY_MS }], T0);

    // Simulate: a fresh user change just happened. Live pollComments surfaced
    // a 15-min-old reply on parent 100.
    const recentReplyTimeMs = T0 - 15 * 60 * 1000;
    await store.addReplies([{
      id: 999, parentItemId: 100, author: 'bob',
      text: 'recent', time: recentReplyTimeMs, read: false, discoveredAt: T0,
    }]);
    // lastBackfillSweepAt stays 0 — no sweep has ever completed for this user.
    assert.equal((await store.getTimestamps()).lastBackfillSweepAt, 0);

    // Pin sweep floor 7 days back.
    const sweepFloorMs = T0 - 7 * DAY_MS;
    await store.setTimestamp('backfillSweepFloor', sweepFloorMs);
    await store.setBackfillQueue([100]);

    await drainOneBackfillItem(hn, store);
    const call = hn.log().find((l) => l.includes('parent_id=100'));
    const sinceSec = Number(call?.match(/since=(\d+)/)?.[1] ?? -1);
    assert.equal(sinceSec, Math.floor(sweepFloorMs / 1000),
      'first-ever sweep MUST use sweep floor (7d back), NOT per-parent (15 min back)');
  } finally { off(); clock.uninstall(); }
});

test('REGRESSION HIGH: drainAll stamps lastBackfillSweepAt=startTime (not now) to preserve post-drain coverage window', async () => {
  // Red-team: a long fullDrain holds LOCK.TICK for minutes. Alarm ticks
  // coalesce; pollComments doesn't run. Replies arriving mid-drain to
  // already-drained parents are missed. If completion sets
  // lastBackfillSweepAt=now, the next sweep's floor starts post-drain and
  // those missed replies are lost forever.
  //
  // Fix: stamp the sweep as having covered only up to drain-START, so the
  // next pollComments' OVERLAP_MS window (45min) can recover anything
  // missed during the drain (as long as drain < OVERLAP_MS).
  const clock = FakeTimers.install({ now: T0, toFake: ['Date'] });
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    await store.setConfig({ hnUser: 'alice', backfillDays: 7 });
    await seed(store, [
      { id: 1, ageMs: 1 * DAY_MS },
      { id: 2, ageMs: 2 * DAY_MS },
    ], T0);
    await store.setBackfillQueue([1, 2]);
    await store.setTimestamp('backfillSweepFloor', T0 - 7 * DAY_MS);

    const startIso = new Date(T0).toISOString();
    // Simulate drain taking wall-clock time — advance clock between items.
    // (drainBackfillQueueCompletely uses real setTimeout we don't fake; we
    // just check final stamp.)
    // Replace sleep with a no-op by mocking clock.tick indirectly:
    // Simply call drainBackfillQueueCompletely — fake-timers handles setTimeout.
    clock.tick(10); // just past T0
    await (await import('../../src/background/poller.ts')).drainBackfillQueueCompletely(hn, store);

    const stamp = (await store.getTimestamps()).lastBackfillSweepAt;
    assert.ok(stamp < T0 + 1000,
      `stamp=${new Date(stamp).toISOString()} must be near drain-START (${startIso}), NOT far-future drain-end`);
  } finally { off(); clock.uninstall(); }
});
