import type { HNItem, HNUpdates, HNUser } from '../../src/shared/types';
import type { HNClient } from '../../src/background/hn-client';

export interface FakeHN extends HNClient {
  seedUser(user: HNUser): void;
  seedItem(item: HNItem): void;
  setUpdates(u: HNUpdates): void;
  counts(): { updates: number; user: number; item: number; total: number };
  log(): string[];
}

export function createFakeHN(): FakeHN {
  const users = new Map<string, HNUser>();
  const items = new Map<number, HNItem>();
  let updates: HNUpdates = { items: [], profiles: [] };
  const requests = { updates: 0, user: 0, item: 0 };
  const log: string[] = [];

  return {
    seedUser(u) {
      users.set(u.id, structuredClone(u));
    },
    seedItem(i) {
      items.set(i.id, structuredClone(i));
    },
    setUpdates(u) {
      updates = structuredClone(u);
    },
    counts() {
      return { ...requests, total: requests.updates + requests.user + requests.item };
    },
    log() {
      return [...log];
    },
    async updates() {
      requests.updates++;
      log.push('GET /v0/updates');
      return structuredClone(updates);
    },
    async user(id) {
      requests.user++;
      log.push(`GET /v0/user/${id}`);
      const u = users.get(id);
      return u ? structuredClone(u) : null;
    },
    async item(id) {
      requests.item++;
      log.push(`GET /v0/item/${id}`);
      const i = items.get(id);
      return i ? structuredClone(i) : null;
    },
  };
}
