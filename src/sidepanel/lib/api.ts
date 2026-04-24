import type { Config, Reply, SidepanelMessage, SidepanelResponse, StorageStats } from '../../shared/types.ts';

function send<T = unknown>(msg: SidepanelMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: SidepanelResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response && 'error' in response ? response.error : 'unknown'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

export const api = {
  listReplies: () => send<Reply[]>({ kind: 'list-replies' }),
  markRead: (id: number) => send({ kind: 'mark-read', id }),
  markAllRead: () => send({ kind: 'mark-all-read' }),
  getConfig: () => send<Config>({ kind: 'get-config' }),
  setConfig: (config: Partial<Config>) => send<Config>({ kind: 'set-config', config }),
  forceRefresh: () => send({ kind: 'force-refresh' }),
  clearRead: () => send<{ dropped: number }>({ kind: 'clear-read' }),
  clearAllReplies: () => send<{ dropped: number }>({ kind: 'clear-all-replies' }),
  getStorageStats: () => send<StorageStats>({ kind: 'get-storage-stats' }),
  inspect: () => send({ kind: 'inspect' }),
};

// Only keys that affect what the sidepanel renders. Timestamps, backfillQueue,
// backfillSweepFloor, and monitored change far more often than the UI — during a
// 500-item fullDrain, backfillQueue alone writes 500 times. Filtering here avoids
// pulling the full replies map through IPC on every tick for no visible change.
const RENDER_RELEVANT_KEYS = new Set(['replies', 'config']);

export function onStorageChanged(cb: (keys: string[]) => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => RENDER_RELEVANT_KEYS.has(k));
    if (keys.length === 0) return;
    cb(keys);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
