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
  forceTick: () => send({ kind: 'force-tick' }),
  forceRefresh: () => send({ kind: 'force-refresh' }),
  clearRead: () => send<{ dropped: number }>({ kind: 'clear-read' }),
  clearAllReplies: () => send<{ dropped: number }>({ kind: 'clear-all-replies' }),
  getStorageStats: () => send<StorageStats>({ kind: 'get-storage-stats' }),
  inspect: () => send({ kind: 'inspect' }),
};

export function onStorageChanged(cb: () => void): () => void {
  const listener = (_: unknown, area: string) => {
    if (area === 'local') cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
