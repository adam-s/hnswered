import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createStore } from '../../src/background/store.ts';
import { DAY_MS } from '../../src/shared/constants.ts';

function mkReply(over: Partial<{ id: number; parentItemId: number; read: boolean; discoveredAt: number }>) {
  return {
    id: over.id ?? 1,
    parentItemId: over.parentItemId ?? 10,
    author: 'x',
    text: '',
    time: 0,
    read: over.read ?? false,
    discoveredAt: over.discoveredAt ?? 0,
  };
}

test('pruneReplies drops read replies older than retention, keeps unread', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const now = 100 * DAY_MS;
    await store.addReplies([
      mkReply({ id: 1, read: true,  discoveredAt: now - 60 * DAY_MS }), // old read → drop
      mkReply({ id: 2, read: true,  discoveredAt: now - 10 * DAY_MS }), // fresh read → keep
      mkReply({ id: 3, read: false, discoveredAt: now - 90 * DAY_MS }), // old unread → keep
    ]);
    const dropped = await store.pruneReplies({ readOlderThanMs: 30 * DAY_MS, now });
    assert.equal(dropped, 1);
    const after = await store.getReplies();
    assert.deepEqual(Object.keys(after).sort(), ['2', '3'].sort());
  } finally { off(); }
});

test('pruneReplies drops orphaned READ replies but preserves orphaned UNREAD replies', async () => {
  // Orphan prune drops read replies only — unread replies survive even when their
  // parent is no longer monitored. Preserves the "unread is never auto-evicted"
  // contract: the UI can still render an orphaned unread reply from its stored
  // author/text/parentAuthor/parentExcerpt fields.
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.upsertMonitored({ id: 10, type: 'story', submittedAt: 0, lastKids: [] });
    await store.addReplies([
      mkReply({ id: 1, parentItemId: 10, read: false }),  // parent exists, unread → keep
      mkReply({ id: 2, parentItemId: 99, read: false }),  // parent missing, unread → KEEP (was dropped pre-fix)
      mkReply({ id: 3, parentItemId: 10, read: true }),   // parent exists, read → keep
      mkReply({ id: 4, parentItemId: 99, read: true }),   // parent missing, read → drop
    ]);
    const dropped = await store.pruneReplies({ orphanedIfMonitoredMissing: true });
    assert.equal(dropped, 1);
    const after = await store.getReplies();
    assert.deepEqual(Object.keys(after).sort(), ['1', '2', '3'].sort());
  } finally { off(); }
});

test('pruneReplies hardCap drops oldest read first, then oldest unread', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const batch = [
      mkReply({ id: 1, read: true,  discoveredAt: 1 }),
      mkReply({ id: 2, read: true,  discoveredAt: 2 }),
      mkReply({ id: 3, read: false, discoveredAt: 3 }),
      mkReply({ id: 4, read: false, discoveredAt: 4 }),
      mkReply({ id: 5, read: false, discoveredAt: 5 }),
    ];
    await store.addReplies(batch);
    const dropped = await store.pruneReplies({ hardCap: 3 });
    assert.equal(dropped, 2);
    const remaining = await store.getReplies();
    // read ones (1,2) should be gone first, leaving 3,4,5
    assert.deepEqual(Object.keys(remaining).sort(), ['3', '4', '5']);
  } finally { off(); }
});

test('clearRead drops read replies and leaves unread untouched', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.addReplies([
      mkReply({ id: 1, read: true }),
      mkReply({ id: 2, read: true }),
      mkReply({ id: 3, read: false }),
    ]);
    const dropped = await store.clearRead();
    assert.equal(dropped, 2);
    const after = await store.getReplies();
    assert.deepEqual(Object.keys(after), ['3']);
  } finally { off(); }
});

test('clearAllReplies drops everything regardless of read state', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.addReplies([
      mkReply({ id: 1, read: true }),
      mkReply({ id: 2, read: false }),
      mkReply({ id: 3, read: false }),
    ]);
    const dropped = await store.clearAllReplies();
    assert.equal(dropped, 3);
    assert.deepEqual(Object.keys(await store.getReplies()), []);
  } finally { off(); }
});

test('clearPerUserState wipes replies + monitored + lastUserSync but keeps config', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.setConfig({ hnUser: 'alice', tickMinutes: 5 });
    await store.upsertMonitored({ id: 10, type: 'story', submittedAt: 0, lastKids: [] });
    await store.addReplies([mkReply({ id: 1, parentItemId: 10 })]);
    await store.setTimestamp('lastUserSync', Date.now());

    await store.clearPerUserState();

    assert.equal(Object.keys(await store.getReplies()).length, 0);
    assert.equal(Object.keys(await store.getMonitored()).length, 0);
    assert.equal((await store.getTimestamps()).lastUserSync, 0);
    // Config untouched
    const cfg = await store.getConfig();
    assert.equal(cfg.hnUser, 'alice');
    assert.equal(cfg.tickMinutes, 5);
  } finally { off(); }
});
