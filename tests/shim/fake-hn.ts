import type { HNItem, HNUser } from '../../src/shared/types';
import type { HNClient } from '../../src/background/hn-client';

export interface FakeHN extends HNClient {
  seedUser(user: HNUser): void;
  seedItem(item: HNItem): void;
  counts(): { user: number; item: number; total: number };
  log(): string[];
}

export function createFakeHN(): FakeHN {
  const users = new Map<string, HNUser>();
  const items = new Map<number, HNItem>();
  const requests = { user: 0, item: 0 };
  const log: string[] = [];

  return {
    seedUser(u) {
      users.set(u.id, structuredClone(u));
    },
    seedItem(i) {
      items.set(i.id, structuredClone(i));
    },
    counts() {
      return { ...requests, total: requests.user + requests.item };
    },
    log() {
      return [...log];
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
