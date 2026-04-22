import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeShim, installChromeShim } from '../shim/chrome.ts';
import { createStore } from '../../src/background/store.ts';

test('store returns defaults when unset', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    const c = await store.getConfig();
    assert.equal(c.hnUser, '');
    assert.equal(c.tickMinutes, 5);
    assert.deepEqual(await store.getMonitored(), {});
    assert.deepEqual(await store.getReplies(), {});
    assert.equal(await store.getUnreadCount(), 0);
  } finally {
    off();
  }
});

test('mark-read flips a single reply; mark-all-read flips all', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.addReplies([
      { id: 1, parentItemId: 10, author: 'a', text: '', time: 0, read: false, discoveredAt: 0 },
      { id: 2, parentItemId: 10, author: 'b', text: '', time: 0, read: false, discoveredAt: 0 },
    ]);
    assert.equal(await store.getUnreadCount(), 2);
    await store.markRead(1);
    assert.equal(await store.getUnreadCount(), 1);
    await store.markAllRead();
    assert.equal(await store.getUnreadCount(), 0);
  } finally {
    off();
  }
});

test('addReplies does not overwrite existing entries', async () => {
  const shim = createChromeShim();
  const off = installChromeShim(shim);
  try {
    const store = createStore(shim.storage.local);
    await store.addReplies([
      { id: 1, parentItemId: 10, author: 'a', text: 'first', time: 0, read: true, discoveredAt: 0 },
    ]);
    await store.addReplies([
      { id: 1, parentItemId: 10, author: 'a', text: 'second', time: 0, read: false, discoveredAt: 0 },
    ]);
    const replies = await store.getReplies();
    assert.equal(replies['1'].text, 'first');
    assert.equal(replies['1'].read, true);
  } finally {
    off();
  }
});
