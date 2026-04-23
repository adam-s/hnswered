import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createFakeHN } from '../shim/fake-hn.ts';
import { createStore } from '../../src/background/store.ts';
import {
  checkFastBucket,
  filterByAge,
  newKidIds,
  scanBucket,
  syncUserSubmissions,
  tick,
  toMonitored,
  toReply,
} from '../../src/background/poller.ts';
import { BUCKET, DAY_MS } from '../../src/shared/constants.ts';

test('newKidIds returns only ids not previously seen', () => {
  assert.deepEqual(newKidIds([1, 2, 3], [1, 2, 3, 4, 5]), [4, 5]);
  assert.deepEqual(newKidIds([], [1]), [1]);
  assert.deepEqual(newKidIds([1, 2], []), []);
  assert.deepEqual(newKidIds([1, 2], [1, 2]), []);
});

test('toMonitored rejects deleted, dead, and wrong-type items; baselines empty so existing kids are surfaced', () => {
  assert.equal(toMonitored({ id: 1, type: 'story', deleted: true } as any), null);
  assert.equal(toMonitored({ id: 1, type: 'story', dead: true } as any), null);
  assert.equal(toMonitored({ id: 1, type: 'job' } as any), null);
  const m = toMonitored({ id: 1, type: 'story', time: 100, kids: [2, 3], descendants: 5 } as any);
  assert.equal(m?.id, 1);
  assert.deepEqual(m?.lastKids, [], 'baseline empty, not snapshotted — next checkOne surfaces existing kids as new');
  assert.equal(m?.lastDescendants, 0);
});

test('toReply skips deleted/dead and missing author', () => {
  const parent = { id: 10, type: 'story' as const, submittedAt: 0, lastKids: [] };
  assert.equal(toReply({ id: 1, deleted: true } as any, parent), null);
  assert.equal(toReply({ id: 1, dead: true } as any, parent), null);
  assert.equal(toReply({ id: 1, time: 5 } as any, parent), null);
  const r = toReply({ id: 1, by: 'alice', text: 'hi', time: 5 } as any, parent, { title: 'my post' });
  assert.equal(r?.author, 'alice');
  assert.equal(r?.parentItemTitle, 'my post');
  assert.equal(r?.read, false);
});

test('filterByAge buckets monitored items correctly', () => {
  const now = 400 * DAY_MS;
  const monitored = {
    fresh: { id: 1, type: 'story' as const, submittedAt: now - 0.25 * DAY_MS, lastKids: [] }, // 6h old
    midweek: { id: 2, type: 'story' as const, submittedAt: now - 3 * DAY_MS, lastKids: [] }, // 3d
    tenDays: { id: 3, type: 'story' as const, submittedAt: now - 10 * DAY_MS, lastKids: [] }, // 10d
    ancient: { id: 4, type: 'story' as const, submittedAt: now - 400 * DAY_MS, lastKids: [] }, // past year
  };
  const daily = filterByAge(monitored, BUCKET.DAILY_MIN_AGE_MS, BUCKET.DAILY_MAX_AGE_MS, now);
  assert.deepEqual(daily.map((m) => m.id).sort(), [2]);
  const weekly = filterByAge(monitored, BUCKET.WEEKLY_MIN_AGE_MS, BUCKET.WEEKLY_MAX_AGE_MS, now);
  assert.deepEqual(weekly.map((m) => m.id).sort(), [3]);
});

test('tick skips replies authored by the user themselves', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    const storyId = 100;
    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: 1, kids: [], descendants: 0 });
    await store.upsertMonitored({
      id: storyId,
      type: 'story',
      submittedAt: Date.now() - 60_000,
      lastKids: [],
      lastDescendants: 0,
    });
    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: 1, kids: [200, 201], descendants: 2 });
    hn.seedItem({ id: 200, type: 'comment', by: 'alice', text: 'self-reply', time: 2, parent: storyId });
    hn.seedItem({ id: 201, type: 'comment', by: 'bob', text: 'real reply', time: 2, parent: storyId });

    const res = await tick(hn, store);
    assert.equal(res.newReplies, 1);
    const replies = await store.getReplies();
    assert.equal(Object.keys(replies).length, 1);
    assert.equal(Object.values(replies)[0].author, 'bob');
  } finally {
    uninstall();
  }
});

test('cap on new-kid fetches leaves uncapped ids unmarked so the next tick catches them', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    const storyId = 300;
    await store.upsertMonitored({
      id: storyId,
      type: 'story',
      submittedAt: Date.now() - 60_000,
      lastKids: [],
      lastDescendants: 0,
    });
    // Create 15 new kids — cap (MAX_REPLIES_PER_CHECK=10) should only fetch 10.
    const kidIds = Array.from({ length: 15 }, (_, i) => 1000 + i);
    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: 1, kids: kidIds, descendants: 15 });
    for (const id of kidIds) {
      hn.seedItem({ id, type: 'comment', by: `user${id}`, text: `reply ${id}`, time: 2, parent: storyId });
    }

    const first = await tick(hn, store);
    assert.equal(first.newReplies, 10, 'first tick fetches MAX_REPLIES_PER_CHECK');

    // Second tick should catch the remaining 5.
    const second = await tick(hn, store);
    assert.equal(second.newReplies, 5, 'second tick catches the leftover 5');
    const all = await store.getReplies();
    assert.equal(Object.keys(all).length, 15, 'all 15 replies eventually captured');
  } finally {
    uninstall();
  }
});

test('tick detects a new direct reply on a monitored story', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();

    const storyId = 100;
    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: 1, title: 'hello', kids: [], descendants: 0 });
    await store.upsertMonitored({
      id: storyId,
      type: 'story',
      submittedAt: Date.now() - DAY_MS,
      lastKids: [],
      lastDescendants: 0,
    });

    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: 1, title: 'hello', kids: [200], descendants: 1 });
    hn.seedItem({ id: 200, type: 'comment', by: 'bob', text: 'nice post', time: 2, parent: storyId });

    const res = await tick(hn, store);
    assert.equal(res.newReplies, 1);
    assert.equal(res.itemsChecked, 1);
    const replies = await store.getReplies();
    assert.equal(Object.keys(replies).length, 1);
    assert.equal(Object.values(replies)[0].author, 'bob');
    const monitored = await store.getMonitored();
    assert.deepEqual(monitored[String(storyId)].lastKids, [200]);
  } finally {
    uninstall();
  }
});

test('tick detects replies on deeply-nested leaf comments identically to top-level items', async () => {
  // Proves the poller is blind to thread depth: it only inspects each monitored item's
  // direct kids. A user's leaf comment buried N levels deep is treated exactly like their
  // top-level story — both are first-class entries in user.submitted, and replies to
  // either are detected by the same diff on `kids`.
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5, retentionDays: 30 });
    const hn = createFakeHN();

    // Build a 6-level-deep thread: story(1) → c2 → c3 → c4 → c5 → alice-leaf(6).
    // alice only authored the deepest node. HN's user.submitted returns [6].
    const nowSec = Math.floor(Date.now() / 1000);
    hn.seedUser({ id: 'alice', created: 0, karma: 1, submitted: [6] });
    hn.seedItem({ id: 1, type: 'story',   by: 'zed',   time: nowSec - 100, kids: [2] });
    hn.seedItem({ id: 2, type: 'comment', by: 'yasmin', time: nowSec - 90, kids: [3], parent: 1 });
    hn.seedItem({ id: 3, type: 'comment', by: 'xander', time: nowSec - 80, kids: [4], parent: 2 });
    hn.seedItem({ id: 4, type: 'comment', by: 'willa',  time: nowSec - 70, kids: [5], parent: 3 });
    hn.seedItem({ id: 5, type: 'comment', by: 'victor', time: nowSec - 60, kids: [6], parent: 4 });
    hn.seedItem({ id: 6, type: 'comment', by: 'alice',  time: nowSec - 50, kids: [],  parent: 5 });

    // Sync picks up the leaf comment regardless of its depth.
    const added = await syncUserSubmissions(hn, store, 'alice');
    assert.equal(added, 1, 'leaf comment added to monitored');
    const monitored = await store.getMonitored();
    assert.ok(monitored['6'], 'monitored contains the deep leaf');
    assert.deepEqual(monitored['6'].lastKids, [], 'baseline captures current (empty) kids');

    // Someone replies directly to alice's deep leaf comment.
    hn.seedItem({ id: 7, type: 'comment', by: 'bob', text: 'deeply thoughtful reply', time: nowSec - 10, parent: 6 });
    hn.seedItem({ id: 6, type: 'comment', by: 'alice',  time: nowSec - 50, kids: [7],  parent: 5 });

    const res = await tick(hn, store);
    assert.equal(res.newReplies, 1, 'new reply on deep leaf detected');
    const replies = await store.getReplies();
    const r = Object.values(replies)[0];
    assert.equal(r.author, 'bob');
    assert.equal(r.parentItemId, 6);
    assert.equal(r.parentAuthor, 'alice', 'parent excerpt context captured');
  } finally {
    uninstall();
  }
});

test('tick skips when no user configured', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    const res = await tick(hn, store);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'no-user');
    assert.equal(hn.counts().total, 0);
  } finally {
    uninstall();
  }
});

test('syncUserSubmissions pulls items newer than 1yr and stops at older ones', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    // Poller uses real Date.now() not the shim clock, so seed relative to wall time.
    const nowSec = Math.floor(Date.now() / 1000);
    hn.seedUser({ id: 'alice', created: 0, karma: 100, submitted: [3, 2, 1] });
    hn.seedItem({ id: 3, type: 'story', by: 'alice', time: nowSec - 60, kids: [], title: 'recent' });
    hn.seedItem({ id: 2, type: 'story', by: 'alice', time: nowSec - 86400 * 30, kids: [] });
    hn.seedItem({ id: 1, type: 'story', by: 'alice', time: nowSec - 86400 * 400, kids: [] });

    const added = await syncUserSubmissions(hn, store, 'alice');
    assert.equal(added, 2, 'should add 2 items younger than 1yr and stop at the old one');
    const monitored = await store.getMonitored();
    assert.ok(monitored['3']);
    assert.ok(monitored['2']);
    assert.equal(monitored['1'], undefined);
  } finally {
    uninstall();
  }
});

test('tick surfaces pre-existing direct kids when user first configures their handle', async () => {
  // Regression: a user configuring their HN handle for the first time should see the
  // replies already sitting on their posts. Without toMonitored baselining lastKids=[],
  // everything is silenced.
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    const nowSec = Math.floor(Date.now() / 1000);
    const storyId = 500;
    hn.seedUser({ id: 'alice', created: 0, karma: 100, submitted: [storyId] });
    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: nowSec - 60, kids: [501, 502, 503], descendants: 3, title: 'hot take' });
    hn.seedItem({ id: 501, type: 'comment', by: 'bob',     time: nowSec - 50, parent: storyId, text: 'nice' });
    hn.seedItem({ id: 502, type: 'comment', by: 'charlie', time: nowSec - 40, parent: storyId, text: 'disagree' });
    hn.seedItem({ id: 503, type: 'comment', by: 'dan',     time: nowSec - 30, parent: storyId, text: 'source?' });

    const tickRes = await tick(hn, store);
    assert.equal(tickRes.newReplies, 3, 'tick surfaces all 3 existing top-level comments');
    const replies = await store.getReplies();
    assert.equal(Object.keys(replies).length, 3);
    assert.deepEqual(Object.values(replies).map((r) => r.author).sort(), ['bob', 'charlie', 'dan']);
  } finally {
    uninstall();
  }
});

test('checkOne self-reply filter is case-insensitive', async () => {
  // Regression: pre-fix, strict-equality comparison meant a user configured as "Alice"
  // would NOT self-filter replies authored as "alice" (HN canonical). Lowercase both
  // sides before comparing.
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'Alice', tickMinutes: 5 });
    const hn = createFakeHN();
    const storyId = 700;
    await store.upsertMonitored({
      id: storyId,
      type: 'story',
      submittedAt: Date.now() - 60_000,
      lastKids: [],
      lastDescendants: 0,
    });
    hn.seedItem({ id: storyId, type: 'story', by: 'Alice', time: 1, kids: [701, 702], descendants: 2 });
    hn.seedItem({ id: 701, type: 'comment', by: 'alice', time: 2, parent: storyId, text: 'self-reply canonical-case' });
    hn.seedItem({ id: 702, type: 'comment', by: 'bob',   time: 2, parent: storyId, text: 'real reply' });

    const res = await tick(hn, store);
    assert.equal(res.newReplies, 1, 'alice (lowercase) is recognized as self despite config Alice');
    const replies = await store.getReplies();
    assert.equal(Object.values(replies)[0].author, 'bob');
  } finally {
    uninstall();
  }
});

test('checkFastBucket surfaces new replies on all fast-bucket items directly', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    const storyId = 600;
    await store.upsertMonitored({
      id: storyId,
      type: 'story',
      submittedAt: Date.now() - 30 * 60_000,
      lastKids: [],
      lastDescendants: 0,
    });
    hn.seedItem({ id: storyId, type: 'story', by: 'alice', time: 1, kids: [700], descendants: 1 });
    hn.seedItem({ id: 700, type: 'comment', by: 'bob', time: 2, parent: storyId, text: 'first reply' });

    const refreshRes = await checkFastBucket(hn, store);
    assert.equal(refreshRes.newReplies, 1);
    assert.equal(refreshRes.itemsChecked, 1);
    const replies = await store.getReplies();
    assert.equal(Object.values(replies)[0].author, 'bob');
  } finally {
    uninstall();
  }
});

test('checkFastBucket excludes items older than FAST_MAX_AGE_MS', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    // One fresh, one older than a week — only the fresh one should be checked.
    await store.upsertMonitored({ id: 10, type: 'story', submittedAt: Date.now() - 60_000, lastKids: [], lastDescendants: 0 });
    await store.upsertMonitored({ id: 11, type: 'story', submittedAt: Date.now() - 10 * DAY_MS, lastKids: [], lastDescendants: 0 });
    hn.seedItem({ id: 10, type: 'story', by: 'alice', time: 1, kids: [], descendants: 0 });
    hn.seedItem({ id: 11, type: 'story', by: 'alice', time: 1, kids: [], descendants: 0 });

    const res = await checkFastBucket(hn, store);
    assert.equal(res.itemsChecked, 1, 'only the sub-week item is checked');
  } finally {
    uninstall();
  }
});

test('set-config user-change forces sync even if a refresh just ran within the throttle window', async () => {
  // Regression (M1): lastForceRefreshAt is module-global. Without the throttle reset in
  // the set-config handler, a user who clicks refresh then changes their username within
  // 10s would fall through to runTick (no force sync), and the new handle would never
  // get baselined. This test exercises the poller-level invariant — user-change MUST
  // be able to force a sync regardless of any prior click's throttle window.
  // NOTE: the actual reset lives in index.ts; this test proves syncUserSubmissions
  // itself honors {force:true} even if a previous sync happened recently.
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const hn = createFakeHN();
    const nowSec = Math.floor(Date.now() / 1000);
    hn.seedUser({ id: 'newuser', created: 0, karma: 1, submitted: [900] });
    hn.seedItem({ id: 900, type: 'story', by: 'newuser', time: nowSec - 60, kids: [], title: 'new' });

    // Pretend a sync happened 1 second ago (well inside the 30-min cooldown).
    await store.setTimestamp('lastUserSync', Date.now() - 1000);
    // Non-forced call must be gated.
    const gated = await syncUserSubmissions(hn, store, 'newuser');
    assert.equal(gated, 0, 'non-forced sync within cooldown is gated');
    // Forced call (as issued by user-change path) must proceed.
    const forced = await syncUserSubmissions(hn, store, 'newuser', { force: true });
    assert.equal(forced, 1, 'forced sync bypasses cooldown');
  } finally {
    uninstall();
  }
});

test('scanBucket daily pass prunes read replies past retention', async () => {
  // Coverage gap: scanBucket's `if (stampKey === "lastDailyScan")` branch runs
  // pruneReplies inline. Retention math is tested in retention.test.ts in isolation;
  // this proves the daily-scan code path actually invokes it.
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5, retentionDays: 30 });
    const hn = createFakeHN();
    hn.seedUser({ id: 'alice', created: 0, karma: 0, submitted: [] });
    const now = Date.now();
    // A monitored item in the daily bucket (1d–7d).
    await store.upsertMonitored({ id: 50, type: 'story', submittedAt: now - 3 * DAY_MS, lastKids: [], lastDescendants: 0 });
    hn.seedItem({ id: 50, type: 'story', by: 'alice', time: 1, kids: [], descendants: 0 });
    // Two replies: one fresh-read (keep), one read past retention (drop).
    await store.addReplies([
      { id: 51, parentItemId: 50, author: 'bob', text: 'recent', time: 0, read: true,  discoveredAt: now - 5 * DAY_MS },
      { id: 52, parentItemId: 50, author: 'bob', text: 'stale',  time: 0, read: true,  discoveredAt: now - 60 * DAY_MS },
    ]);

    await scanBucket(hn, store, BUCKET.DAILY_MIN_AGE_MS, BUCKET.DAILY_MAX_AGE_MS, 'lastDailyScan');

    const replies = await store.getReplies();
    assert.deepEqual(Object.keys(replies).sort(), ['51'], 'stale read reply pruned, fresh read reply kept');
  } finally {
    uninstall();
  }
});

test('scanBucket drops items older than 1yr from the monitored set', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    hn.seedUser({ id: 'alice', created: 0, karma: 0, submitted: [] });
    await store.upsertMonitored({
      id: 77,
      type: 'story',
      submittedAt: Date.now() - BUCKET.DROP_AGE_MS - 1,
      lastKids: [],
    });
    await scanBucket(hn, store, BUCKET.WEEKLY_MIN_AGE_MS, BUCKET.WEEKLY_MAX_AGE_MS, 'lastWeeklyScan');
    const monitored = await store.getMonitored();
    assert.equal(monitored['77'], undefined);
  } finally {
    uninstall();
  }
});
