import { ALARM, BUCKET, DEFAULT_CONFIG } from '../shared/constants.ts';
import type { SidepanelMessage, SidepanelResponse } from '../shared/types.ts';
import { log, logErr } from '../shared/debug.ts';
import { hnClient } from './hn-client.ts';
import { createStore } from './store.ts';
import { scanBucket, syncUserSubmissions, tick } from './poller.ts';
import { updateBadge } from './badge.ts';

const store = createStore();

async function refreshBadge() {
  const n = await store.getUnreadCount();
  await updateBadge(n);
  log('index.refreshBadge', `unread=${n}`);
}

async function ensureAlarms() {
  const config = await store.getConfig();
  const tickMin = Math.max(1, config.tickMinutes || DEFAULT_CONFIG.tickMinutes);
  const existing = await chrome.alarms.get(ALARM.TICK);
  if (!existing || existing.periodInMinutes !== tickMin) {
    await chrome.alarms.create(ALARM.TICK, {
      periodInMinutes: tickMin,
      delayInMinutes: tickMin,
    });
    log('index.ensureAlarms', `tick-registered periodMin=${tickMin}`);
  }
  if (!(await chrome.alarms.get(ALARM.DAILY))) {
    await chrome.alarms.create(ALARM.DAILY, { periodInMinutes: 24 * 60, delayInMinutes: 60 });
    log('index.ensureAlarms', `daily-registered`);
  }
  if (!(await chrome.alarms.get(ALARM.WEEKLY))) {
    await chrome.alarms.create(ALARM.WEEKLY, { periodInMinutes: 7 * 24 * 60, delayInMinutes: 24 * 60 });
    log('index.ensureAlarms', `weekly-registered`);
  }
}

// Single-flight guard: coalesce overlapping poll calls into one in-flight promise.
// Keeps concurrent force-tick clicks, alarm races, and storage-onChange ripples from
// firing multiple concurrent scans against the same store.
const inFlight: Record<string, Promise<void> | null> = { tick: null, daily: null, weekly: null };

function singleFlight(key: 'tick' | 'daily' | 'weekly', run: () => Promise<void>): Promise<void> {
  if (inFlight[key]) {
    log('index.singleFlight', `coalesce key=${key}`);
    return inFlight[key]!;
  }
  log('index.singleFlight', `new key=${key}`);
  const p = (async () => {
    try { await run(); } finally { inFlight[key] = null; }
  })();
  inFlight[key] = p;
  return p;
}

async function runTick(): Promise<void> {
  return singleFlight('tick', async () => {
    log('index.runTick', `enter`);
    try {
      await tick(hnClient, store);
    } catch (err) {
      logErr('index.runTick', `failed`, err);
      console.error('[HNswered] tick failed:', err);
    } finally {
      await refreshBadge();
      log('index.runTick', `exit`);
    }
  });
}

// User-initiated refresh: bypass the 30-min user-sync cooldown because the user
// is explicitly telling us "something new exists, look now."
const MIN_REFRESH_INTERVAL_MS = 10_000;
let lastForceRefreshAt = 0;

async function runRefresh(): Promise<void> {
  log('index.runRefresh', `enter`);
  if (inFlight.tick) {
    log('index.runRefresh', `drain in-flight tick before seizing slot`);
    try { await inFlight.tick; } catch {}
  }
  const now = Date.now();
  const allowForceSync = now - lastForceRefreshAt >= MIN_REFRESH_INTERVAL_MS;
  if (allowForceSync) lastForceRefreshAt = now;
  log('index.runRefresh', `allowForceSync=${allowForceSync} sinceLastMs=${now - lastForceRefreshAt}`);

  return singleFlight('tick', async () => {
    try {
      const { hnUser } = await store.getConfig();
      if (hnUser && allowForceSync) {
        await syncUserSubmissions(hnClient, store, hnUser, { force: true });
      }
      await tick(hnClient, store);
    } catch (err) {
      logErr('index.runRefresh', `failed`, err);
      console.error('[HNswered] refresh failed:', err);
    } finally {
      await refreshBadge();
      log('index.runRefresh', `exit`);
    }
  });
}

async function runDaily(): Promise<void> {
  return singleFlight('daily', async () => {
    log('index.runDaily', `enter`);
    try {
      await scanBucket(hnClient, store, BUCKET.DAILY_MIN_AGE_MS, BUCKET.DAILY_MAX_AGE_MS, 'lastDailyScan');
    } catch (err) {
      logErr('index.runDaily', `failed`, err);
      console.error('[HNswered] daily scan failed:', err);
    } finally {
      await refreshBadge();
      log('index.runDaily', `exit`);
    }
  });
}

async function runWeekly(): Promise<void> {
  return singleFlight('weekly', async () => {
    log('index.runWeekly', `enter`);
    try {
      await scanBucket(hnClient, store, BUCKET.WEEKLY_MIN_AGE_MS, BUCKET.WEEKLY_MAX_AGE_MS, 'lastWeeklyScan');
    } catch (err) {
      logErr('index.runWeekly', `failed`, err);
      console.error('[HNswered] weekly scan failed:', err);
    } finally {
      await refreshBadge();
      log('index.runWeekly', `exit`);
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  log('index.onInstalled', `fired`);
  await ensureAlarms();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  log('index.onStartup', `fired`);
  await ensureAlarms();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  log('index.onAlarm', `fired name=${alarm.name} scheduledTime=${alarm.scheduledTime}`);
  if (alarm.name === ALARM.TICK) void runTick();
  else if (alarm.name === ALARM.DAILY) void runDaily();
  else if (alarm.name === ALARM.WEEKLY) void runWeekly();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  log('index.onStorageChanged', `keys=${JSON.stringify(keys)}`);
  if (changes.replies) void refreshBadge();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onMessage.addListener((message: SidepanelMessage, _sender, sendResponse) => {
  log('index.onMessage', `kind=${message.kind}`);
  const respond = (value: SidepanelResponse) => sendResponse(value);
  (async () => {
    try {
      switch (message.kind) {
        case 'list-replies': {
          const replies = await store.getReplies();
          respond({ ok: true, data: Object.values(replies).sort((a, b) => b.discoveredAt - a.discoveredAt) });
          return;
        }
        case 'mark-read': {
          await store.markRead(message.id);
          respond({ ok: true });
          return;
        }
        case 'mark-all-read': {
          await store.markAllRead();
          respond({ ok: true });
          return;
        }
        case 'get-config': {
          const config = await store.getConfig();
          respond({ ok: true, data: config });
          return;
        }
        case 'set-config': {
          const prev = await store.getConfig();
          const config = await store.setConfig(message.config);
          const nextUser = (config.hnUser ?? '').trim();
          const prevUser = (prev.hnUser ?? '').trim();
          if (nextUser !== prevUser) {
            log('index.onMessage', `user-changed from=${JSON.stringify(prevUser)} to=${JSON.stringify(nextUser)} → clearPerUserState`);
            await store.clearPerUserState();
            await refreshBadge();
          }
          await ensureAlarms();
          respond({ ok: true, data: config });
          return;
        }
        case 'force-tick': {
          await runTick();
          respond({ ok: true });
          return;
        }
        case 'force-refresh': {
          await runRefresh();
          respond({ ok: true });
          return;
        }
        case 'force-daily-scan': {
          await runDaily();
          respond({ ok: true });
          return;
        }
        case 'force-weekly-scan': {
          await runWeekly();
          respond({ ok: true });
          return;
        }
        case 'get-monitored': {
          const monitored = await store.getMonitored();
          respond({ ok: true, data: Object.values(monitored) });
          return;
        }
        case 'reset-all': {
          await chrome.storage.local.clear();
          await refreshBadge();
          respond({ ok: true });
          return;
        }
        case 'clear-read': {
          const n = await store.clearRead();
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case 'clear-all-replies': {
          const n = await store.clearAllReplies();
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case 'get-storage-stats': {
          const [replies, monitored, bytes] = await Promise.all([
            store.getReplies(),
            store.getMonitored(),
            store.getBytesInUse(),
          ]);
          const all = Object.values(replies);
          respond({ ok: true, data: {
            replyCount: all.length,
            unreadCount: all.filter((r) => !r.read).length,
            monitoredCount: Object.keys(monitored).length,
            bytesInUse: bytes,
          }});
          return;
        }
        case 'inspect': {
          // Read-only dump of the whole state, logged line-by-line and also returned.
          // Safe to call repeatedly — does NOT touch storage or hit HN.
          const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
          log('index.inspect', `config=${JSON.stringify(all.config)}`);
          log('index.inspect', `timestamps lastTick=${all.lastTick} lastUserSync=${all.lastUserSync} lastDailyScan=${all.lastDailyScan} lastWeeklyScan=${all.lastWeeklyScan}`);
          const monitored = (all.monitored as Record<string, import('../shared/types.ts').MonitoredItem> | undefined) ?? {};
          const mArr = Object.values(monitored);
          log('index.inspect', `monitored count=${mArr.length}`);
          for (const m of mArr) {
            const ageDays = ((Date.now() - m.submittedAt) / 86400000).toFixed(2);
            log('index.inspect.monitored', `id=${m.id} type=${m.type} ageDays=${ageDays} lastDescendants=${m.lastDescendants} lastKids=${JSON.stringify(m.lastKids)}`);
          }
          const replies = (all.replies as Record<string, import('../shared/types.ts').Reply> | undefined) ?? {};
          const rArr = Object.values(replies);
          const unread = rArr.filter((r) => !r.read).length;
          log('index.inspect', `replies count=${rArr.length} unread=${unread}`);
          const alarms = await chrome.alarms.getAll();
          for (const a of alarms) {
            log('index.inspect.alarm', `name=${a.name} scheduledTime=${a.scheduledTime} nextInMs=${a.scheduledTime - Date.now()} periodMin=${a.periodInMinutes}`);
          }
          respond({ ok: true, data: {
            config: all.config,
            monitored: mArr,
            replyCount: rArr.length,
            unreadCount: unread,
            timestamps: {
              lastTick: all.lastTick ?? null,
              lastUserSync: all.lastUserSync ?? null,
              lastDailyScan: all.lastDailyScan ?? null,
              lastWeeklyScan: all.lastWeeklyScan ?? null,
            },
            alarms,
          }});
          return;
        }
      }
    } catch (err) {
      logErr('index.onMessage', `kind=${message.kind}`, err);
      respond({ ok: false, error: (err as Error).message });
    }
  })();
  return true;
});

log('index.boot', `loaded`);
void ensureAlarms();
void refreshBadge();

// Test/harness hook — expose internals to scripts/* that drive the SW via CDP.
// Production code never reads this; it's just a handle for Playwright evaluate().
(globalThis as unknown as Record<string, unknown>).__hnswered = {
  store,
  runTick,
  runRefresh,
  runDaily,
  runWeekly,
  refreshBadge,
  ensureAlarms,
};
