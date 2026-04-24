/**
 * Shared helpers for launching Chromium with the HNswered extension loaded,
 * discovering the extension ID, and sending runtime messages to the background SW.
 */
import { chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const DIST = resolve(REPO_ROOT, 'dist');

export async function launchWithExtension({ headless = true, logRequests = false, viewport } = {}) {
  const userDataDir = mkdtempSync(resolve(tmpdir(), 'hnswered-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
    ],
    viewport: viewport ?? { width: 420, height: 800 },
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = sw.url().split('/')[2];

  const hnRequests = [];
  if (logRequests) {
    context.on('request', (req) => {
      const url = req.url();
      if ((url.includes('hacker-news.firebaseio.com') || url.includes('hn.algolia.com'))) {
        hnRequests.push({ url, ts: Date.now() });
      }
    });
    // Service-worker-originated requests need CDP to observe
    try {
      const cdp = await context.newCDPSession(sw);
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (e) => {
        const u = e.request.url;
        if (u.includes('hacker-news.firebaseio.com') || u.includes('hn.algolia.com')) {
          hnRequests.push({ url: u, ts: Date.now(), source: 'sw' });
        }
      });
    } catch {}
  }

  return {
    context,
    sw,
    extensionId,
    hnRequests,
    async send(message) {
      // SW.sendMessage doesn't loopback to its own onMessage. Call the exposed hook directly.
      return sw.evaluate(async (msg) => {
        const H = globalThis.__hnswered;
        if (!H) return { ok: false, error: 'harness hook missing' };
        try {
          switch (msg.kind) {
            case 'list-replies': {
              const replies = await H.store.getReplies();
              return { ok: true, data: Object.values(replies).sort((a, b) => b.discoveredAt - a.discoveredAt) };
            }
            case 'mark-read':
              await H.store.markRead(msg.id);
              return { ok: true };
            case 'mark-all-read':
              await H.store.markAllRead();
              return { ok: true };
            case 'get-config':
              return { ok: true, data: await H.store.getConfig() };
            case 'set-config': {
              // Mirrors the real handler: clear per-user state when hnUser changes.
              const prev = await H.store.getConfig();
              const cfg = await H.store.setConfig(msg.config);
              const prevUser = (prev.hnUser ?? '').trim();
              const nextUser = (cfg.hnUser ?? '').trim();
              if (prevUser !== nextUser) {
                await H.store.clearPerUserState();
                await H.refreshBadge();
              }
              await H.ensureAlarms();
              return { ok: true, data: cfg };
            }
            case 'force-refresh':
              await H.runRefresh();
              return { ok: true };
            case 'get-monitored': {
              const monitored = await H.store.getMonitored();
              return { ok: true, data: Object.values(monitored) };
            }
            case 'reset-all':
              await chrome.storage.local.clear();
              await H.refreshBadge();
              return { ok: true };
            case 'clear-read': {
              const n = await H.store.clearRead();
              await H.refreshBadge();
              return { ok: true, data: { dropped: n } };
            }
            case 'clear-all-replies': {
              const n = await H.store.clearAllReplies();
              await H.refreshBadge();
              return { ok: true, data: { dropped: n } };
            }
            case 'get-storage-stats': {
              const replies = await H.store.getReplies();
              const monitored = await H.store.getMonitored();
              const bytes = await H.store.getBytesInUse();
              const all = Object.values(replies);
              return { ok: true, data: {
                replyCount: all.length,
                unreadCount: all.filter((r) => !r.read).length,
                monitoredCount: Object.keys(monitored).length,
                bytesInUse: bytes,
              }};
            }
            case 'inspect': {
              const all = await chrome.storage.local.get(null);
              const mArr = Object.values(all.monitored ?? {});
              const rArr = Object.values(all.replies ?? {});
              const alarms = await chrome.alarms.getAll();
              return { ok: true, data: {
                config: all.config,
                monitored: mArr,
                replyCount: rArr.length,
                unreadCount: rArr.filter((r) => !r.read).length,
                timestamps: {
                  lastCommentPoll: all.lastCommentPoll ?? null,
                  lastAuthorSync: all.lastAuthorSync ?? null,
                },
                alarms,
              }};
            }
            default:
              return { ok: false, error: `unknown kind: ${msg.kind}` };
          }
        } catch (err) {
          return { ok: false, error: String(err.message ?? err) };
        }
      }, message);
    },
    async openSidepanel(opts = {}) {
      const page = await context.newPage();
      if (opts.viewport) await page.setViewportSize(opts.viewport);
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await page.waitForLoadState('networkidle');
      return page;
    },
    async close() {
      await context.close();
    },
  };
}

export async function waitFor(cond, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}
