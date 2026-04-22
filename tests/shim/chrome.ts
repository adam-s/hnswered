/**
 * Tiny in-memory chrome.* shim for unit tests.
 * Implements only what our code uses: storage.local + alarms with virtual time.
 */

interface AlarmRecord {
  name: string;
  periodInMinutes?: number;
  scheduledTime: number;
}

export interface FakeClock {
  now(): number;
  advance(ms: number): Promise<void>;
  set(ms: number): Promise<void>;
}

export interface ChromeShim {
  storage: {
    local: chrome.storage.StorageArea;
    onChanged: { addListener(fn: (changes: unknown, area: string) => void): void; removeListener(fn: (changes: unknown, area: string) => void): void };
  };
  alarms: {
    create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number; when?: number }): Promise<void>;
    get(name: string): Promise<AlarmRecord | undefined>;
    getAll(): Promise<AlarmRecord[]>;
    clear(name: string): Promise<boolean>;
    onAlarm: { addListener(fn: (alarm: AlarmRecord) => void): void };
  };
  action: {
    setBadgeText(info: { text: string }): Promise<void>;
    setBadgeBackgroundColor(info: { color: string }): Promise<void>;
    setBadgeTextColor(info: { color: string }): Promise<void>;
    getBadge(): { text: string };
  };
  clock: FakeClock;
}

export function createChromeShim(startTs = 1_700_000_000_000): ChromeShim {
  let now = startTs;
  const clock: FakeClock = {
    now: () => now,
    async advance(ms) {
      await advanceTo(now + ms);
    },
    async set(ms) {
      await advanceTo(ms);
    },
  };

  const store: Record<string, unknown> = {};
  const changeListeners: Array<(changes: unknown, area: string) => void> = [];

  const storageLocal: chrome.storage.StorageArea = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      const result: Record<string, unknown> = {};
      const want =
        keys == null
          ? Object.keys(store)
          : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
          ? keys
          : Object.keys(keys);
      for (const k of want) if (k in store) result[k] = store[k];
      return result;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = v;
      }
      for (const fn of changeListeners) fn(changes, 'local');
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, { oldValue?: unknown; newValue: undefined }> = {};
      for (const k of list) {
        if (k in store) {
          changes[k] = { oldValue: store[k], newValue: undefined };
          delete store[k];
        }
      }
      for (const fn of changeListeners) fn(changes, 'local');
    },
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    async getBytesInUse() {
      return 0;
    },
  } as unknown as chrome.storage.StorageArea;

  const alarms = new Map<string, AlarmRecord>();
  const alarmListeners: Array<(alarm: AlarmRecord) => void> = [];

  async function advanceTo(target: number) {
    while (true) {
      let next: AlarmRecord | null = null;
      for (const a of alarms.values()) {
        if (a.scheduledTime <= target && (!next || a.scheduledTime < next.scheduledTime)) next = a;
      }
      if (!next) break;
      now = next.scheduledTime;
      if (next.periodInMinutes && next.periodInMinutes > 0) {
        next.scheduledTime += next.periodInMinutes * 60_000;
      } else {
        alarms.delete(next.name);
      }
      for (const fn of alarmListeners) fn({ ...next });
    }
    now = target;
  }

  let badgeText = '';
  let badgeBg = '';
  let badgeFg = '';

  const shim: ChromeShim = {
    storage: {
      local: storageLocal,
      onChanged: {
        addListener: (fn) => changeListeners.push(fn),
        removeListener: (fn) => {
          const i = changeListeners.indexOf(fn);
          if (i >= 0) changeListeners.splice(i, 1);
        },
      },
    },
    alarms: {
      async create(name, info) {
        const delayMs = (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
        const when = info.when ?? now + delayMs;
        alarms.set(name, {
          name,
          periodInMinutes: info.periodInMinutes,
          scheduledTime: when,
        });
      },
      async get(name) {
        const a = alarms.get(name);
        return a ? { ...a } : undefined;
      },
      async getAll() {
        return Array.from(alarms.values(), (a) => ({ ...a }));
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: {
        addListener: (fn) => alarmListeners.push(fn),
      },
    },
    action: {
      async setBadgeText({ text }) {
        badgeText = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badgeBg = color;
      },
      async setBadgeTextColor({ color }) {
        badgeFg = color;
      },
      getBadge() {
        return { text: badgeText };
      },
    },
    clock,
  };
  void badgeBg;
  void badgeFg;
  return shim;
}

/** Install the shim on globalThis so production code using `chrome.*` picks it up. */
export function installChromeShim(shim: ChromeShim): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = g.chrome;
  g.chrome = {
    storage: shim.storage,
    alarms: shim.alarms,
    action: shim.action,
    runtime: { lastError: null },
  };
  return () => {
    g.chrome = prev;
  };
}
