import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createFakeHN } from '../shim/fake-hn.ts';
import { createStore } from '../../src/background/store.ts';
import {
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

test('toMonitored rejects deleted, dead, and wrong-type items', () => {
  assert.equal(toMonitored({ id: 1, type: 'story', deleted: true } as any), null);
  assert.equal(toMonitored({ id: 1, type: 'story', dead: true } as any), null);
  assert.equal(toMonitored({ id: 1, type: 'job' } as any), null);
  const m = toMonitored({ id: 1, type: 'story', time: 100, kids: [2, 3], descendants: 5 } as any);
  assert.equal(m?.id, 1);
  assert.deepEqual(m?.lastKids, [2, 3]);
  assert.equal(m?.lastDescendants, 5);
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
    hn.setUpdates({ items: [storyId], profiles: [] });
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
    hn.setUpdates({ items: [storyId], profiles: [] });

    const first = await tick(hn, store);
    assert.equal(first.newReplies, 10, 'first tick fetches MAX_REPLIES_PER_CHECK');

    // A second tick (with the updates feed still flagging the story) should catch the remaining 5.
    hn.setUpdates({ items: [storyId], profiles: [] });
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

    hn.setUpdates({ items: [storyId], profiles: [] });
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
    hn.setUpdates({ items: [6], profiles: [] });

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

test('tick does nothing when updates does not mention monitored items', async () => {
  const shim = createChromeShim();
  const uninstall = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    const hn = createFakeHN();
    await store.upsertMonitored({
      id: 1,
      type: 'story',
      submittedAt: Date.now() - DAY_MS,
      lastKids: [],
    });
    hn.setUpdates({ items: [999], profiles: [] });
    const res = await tick(hn, store);
    assert.equal(res.newReplies, 0);
    assert.equal(res.itemsChecked, 0);
    assert.equal(hn.counts().item, 0);
    assert.equal(hn.counts().updates, 1);
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
