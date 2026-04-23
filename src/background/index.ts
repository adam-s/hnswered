import { ALARM, BUCKET, DEFAULT_CONFIG, LOCK } from '../shared/constants.ts';
import type { SidepanelMessage, SidepanelResponse } from '../shared/types.ts';
import { log, logErr } from '../shared/debug.ts';
import { hnClient } from './hn-client.ts';
import { createStore } from './store.ts';
import { checkFastBucket, scanBucket, syncUserSubmissions, tick } from './poller.ts';
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

// Mutual exclusion via the Web Locks API. Replaces the prior hand-rolled
// `singleFlight` map + `runRefresh`'s drain-then-swap dance with one native
// primitive that:
//   - serializes work across the SW AND every open sidepanel context
//     (singleFlight only coalesced within a single JS context);
//   - auto-releases when the SW terminates, so a suspended-mid-tick scenario
//     can't leak a phantom holder;
//   - composes naturally with AbortSignal (deferred TODO #5) via options.signal.
//
// Two acquisition modes are used:
//   - exclusive (default): runRefresh — user-initiated work that MUST run, even
//     if another tick is in-flight (queues, runs after).
//   - ifAvailable: runTick / runDaily / runWeekly — alarm-driven idempotent work
//     that should drop on the floor if a peer is already holding the lock.
//     Skipping a redundant tick is strictly cheaper than queueing one.
//
// runRefresh's spam-click throttle (lastForceRefreshAt + MIN_REFRESH_INTERVAL_MS)
// is unchanged; it gates user-driven entry BEFORE we even ask for the lock,
// keeping the cheap-rejection path off the lock queue entirely.
const MIN_REFRESH_INTERVAL_MS = 10_000;
let lastForceRefreshAt = 0;

async function runTick(): Promise<void> {
  await navigator.locks.request(LOCK.TICK, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      log('index.runTick', `coalesced — lock held by peer, skipping redundant tick`);
      return;
    }
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
// is explicitly telling us "something new exists, look now." The entire refresh
// (sync + fast-bucket check + tick) is throttled by a single timestamp, not just
// the sync portion — otherwise spam-clicks burn ~165 HN requests per click via
// checkFastBucket alone.
async function runRefresh(): Promise<void> {
  log('index.runRefresh', `ENTER`);
  const now = Date.now();
  const sinceLastMs = now - lastForceRefreshAt;
  if (sinceLastMs < MIN_REFRESH_INTERVAL_MS) {
    // Throttle path: a refresh ran very recently; do NOT do more work, but DO
    // wait for any in-flight refresh to drain so the caller (force-refresh
    // message handler, set-config kickoff via void runRefresh) sees post-drain
    // storage state. An empty exclusive acquisition queues behind the in-flight
    // work and grants instantly when the lock is free — preserves the prior
    // singleFlight-coalesce-as-synchronization behavior without burning HN calls.
    log('index.runRefresh', `THROTTLED sinceLastMs=${sinceLastMs} min=${MIN_REFRESH_INTERVAL_MS} — draining any in-flight tick`);
    await navigator.locks.request(LOCK.TICK, () => {});
    return;
  }
  lastForceRefreshAt = now;

  // Exclusive lock acquisition. If a tick is in flight (rare — runTick uses
  // ifAvailable so peer ticks don't pile up, but an alarm-tick that won the
  // race a few ms before us is still running), we queue and run after it
  // releases. Web Locks gives us the prior `runRefresh` slot-swap's drain
  // semantics for free: queued requests grant in FIFO order.
  await navigator.locks.request(LOCK.TICK, async () => {
    try {
      const config = await store.getConfig();
      const { hnUser } = config;
      log('index.runRefresh', `config hnUser=${JSON.stringify(hnUser)} tickMin=${config.tickMinutes} retDays=${config.retentionDays}`);
      const monitoredBefore = await store.getMonitored();
      log('index.runRefresh', `pre-sync monitoredCount=${Object.keys(monitoredBefore).length} ids=${JSON.stringify(Object.keys(monitoredBefore))}`);
      if (hnUser) {
        log('index.runRefresh', `→ syncUserSubmissions user=${hnUser} force=true`);
        const added = await syncUserSubmissions(hnClient, store, hnUser, { force: true });
        log('index.runRefresh', `← syncUserSubmissions user=${hnUser} added=${added}`);
      } else {
        log('index.runRefresh', `skip syncUserSubmissions — no hnUser configured`);
      }
      const monitoredAfter = await store.getMonitored();
      log('index.runRefresh', `post-sync monitoredCount=${Object.keys(monitoredAfter).length} ids=${JSON.stringify(Object.keys(monitoredAfter))}`);
      log('index.runRefresh', `→ checkFastBucket`);
      const fastRes = await checkFastBucket(hnClient, store);
      log('index.runRefresh', `← checkFastBucket newReplies=${fastRes.newReplies} itemsChecked=${fastRes.itemsChecked} skipped=${fastRes.skipped} reason=${fastRes.reason}`);
      const replies = await store.getReplies();
      log('index.runRefresh', `final replyCount=${Object.keys(replies).length}`);
    } catch (err) {
      logErr('index.runRefresh', `failed`, err);
      console.error('[HNswered] refresh failed:', err);
    } finally {
      await refreshBadge();
      log('index.runRefresh', `EXIT`);
    }
  });
}

async function runDaily(): Promise<void> {
  await navigator.locks.request(LOCK.DAILY, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      log('index.runDaily', `coalesced — lock held by peer, skipping redundant scan`);
      return;
    }
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
  await navigator.locks.request(LOCK.WEEKLY, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      log('index.runWeekly', `coalesced — lock held by peer, skipping redundant scan`);
      return;
    }
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

chrome.runtime.onMessage.addListener((message: SidepanelMessage, sender, sendResponse) => {
  log('index.onMessage', `RECV kind=${message.kind} senderUrl=${sender?.url ?? 'n/a'}`);
  const respond = (value: SidepanelResponse) => sendResponse(value);
  (async () => {
    try {
      switch (message.kind) {
        case 'list-replies': {
          const replies = await store.getReplies();
          // Sort by HN's posting time, newest first — not by discoveredAt. When a
          // baseline-drain surfaces many existing replies in one sweep they all share
          // a near-identical discoveredAt, which renders ordering meaningless; posting
          // time gives a stable, HN-matching order.
          respond({ ok: true, data: Object.values(replies).sort((a, b) => b.time - a.time) });
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
            if (nextUser) {
              // Kick off a full refresh (force-sync + fast-bucket check + tick) so the
              // new user's items land in the monitored set and their existing replies
              // surface, without blocking the settings UI response. Reset
              // `lastForceRefreshAt` so a recent refresh-button click does not throttle
              // THIS refresh down to a cheap tick — user-change is never spam.
              log('index.onMessage', `user-changed → reset throttle + void runRefresh() for user=${nextUser}`);
              lastForceRefreshAt = 0;
              void runRefresh();
            }
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
        default: {
          // Unknown message kind — must respond so the sidepanel's sendMessage
          // callback resolves. Otherwise Chrome holds the port open until SW
          // suspension, the caller gets "message port closed before a response
          // was received," and any UI operation that sent the message hangs.
          const kind = (message as { kind?: unknown }).kind;
          log('index.onMessage', `UNKNOWN kind=${JSON.stringify(kind)}`);
          respond({ ok: false, error: `unknown message kind: ${String(kind)}` });
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
