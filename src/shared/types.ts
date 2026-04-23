export type ItemType = 'story' | 'comment' | 'job' | 'poll' | 'pollopt';

export interface HNItem {
  id: number;
  type?: ItemType;
  deleted?: boolean;
  dead?: boolean;
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  url?: string;
  parent?: number;
  kids?: number[];
  descendants?: number;
  score?: number;
}

export interface HNUser {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

export interface Config {
  hnUser: string;
  tickMinutes: number;
  retentionDays: number;
}

export interface MonitoredItem {
  id: number;
  type: 'story' | 'comment';
  submittedAt: number;
  lastDescendants?: number;
  lastKids: number[];
}

export interface Reply {
  id: number;
  parentItemId: number;
  parentItemTitle?: string;   // set when parent is a story
  parentAuthor?: string;      // set when parent is a comment
  parentExcerpt?: string;     // truncated parent text (≈140 chars, tags stripped)
  author: string;
  text: string;
  time: number;
  read: boolean;
  discoveredAt: number;
}

export interface StoreSchema {
  config: Config;
  monitored: Record<string, MonitoredItem>;
  replies: Record<string, Reply>;
  lastTick: number;
  lastDailyScan: number;
  lastWeeklyScan: number;
  lastUserSync: number;
}

export type SidepanelMessage =
  | { kind: 'list-replies' }
  | { kind: 'mark-read'; id: number }
  | { kind: 'mark-all-read' }
  | { kind: 'get-config' }
  | { kind: 'set-config'; config: Partial<Config> }
  | { kind: 'force-tick' }
  | { kind: 'force-refresh' }
  | { kind: 'force-daily-scan' }
  | { kind: 'force-weekly-scan' }
  | { kind: 'get-monitored' }
  | { kind: 'get-storage-stats' }
  | { kind: 'clear-read' }
  | { kind: 'clear-all-replies' }
  | { kind: 'reset-all' }
  | { kind: 'inspect' };

export interface StorageStats {
  replyCount: number;
  unreadCount: number;
  monitoredCount: number;
  bytesInUse: number;
}

export type SidepanelResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };
