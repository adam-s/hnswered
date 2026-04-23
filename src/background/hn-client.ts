import type { HNItem, HNUpdates, HNUser } from '../shared/types.ts';
import { FETCH, HN_API } from '../shared/constants.ts';
import { log, logErr } from '../shared/debug.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON<T>(url: string, attempt = 0): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH.TIMEOUT_MS);
  const t0 = Date.now();
  log('hn-client.fetchJSON', `GET attempt=${attempt} url=${url}`);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const body = (await res.json()) as T;
    const elapsed = Date.now() - t0;
    // Size is a rough estimate from JSON.stringify length; not worth fetching content-length.
    const size = typeof body === 'object' ? JSON.stringify(body).length : 0;
    log('hn-client.fetchJSON', `OK attempt=${attempt} elapsedMs=${elapsed} bytes=${size} url=${url}`);
    return body;
  } catch (err) {
    if (attempt >= FETCH.MAX_RETRIES) {
      logErr('hn-client.fetchJSON', `EXHAUSTED url=${url}`, err);
      throw err;
    }
    const backoff = Math.min(
      FETCH.BACKOFF_BASE_MS * 2 ** attempt,
      FETCH.BACKOFF_MAX_MS,
    );
    log('hn-client.fetchJSON', `retry attempt=${attempt} backoffMs=${backoff} url=${url}`);
    await sleep(backoff);
    return fetchJSON<T>(url, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

export interface HNClient {
  updates(): Promise<HNUpdates>;
  user(id: string): Promise<HNUser | null>;
  item(id: number): Promise<HNItem | null>;
}

export const hnClient: HNClient = {
  async updates() {
    return fetchJSON<HNUpdates>(`${HN_API}/updates.json`);
  },
  async user(id) {
    return fetchJSON<HNUser | null>(`${HN_API}/user/${encodeURIComponent(id)}.json`);
  },
  async item(id) {
    return fetchJSON<HNItem | null>(`${HN_API}/item/${id}.json`);
  },
};

export async function fetchItems(
  client: HNClient,
  ids: number[],
): Promise<HNItem[]> {
  log('hn-client.fetchItems', `start count=${ids.length} ids=${JSON.stringify(ids)}`);
  const results: HNItem[] = [];
  for (const id of ids) {
    const item = await client.item(id);
    if (item) {
      // Include dead/deleted items in results unconditionally — callers
      // (checkOne via toReply) filter them out, but they need the item to
      // advance baselines correctly. The log just records the condition.
      results.push(item);
      if (item.deleted || item.dead) {
        log('hn-client.fetchItems', `included-dead-or-deleted id=${id} deleted=${item.deleted} dead=${item.dead}`);
      }
    } else {
      log('hn-client.fetchItems', `null id=${id}`);
    }
    if (FETCH.PER_REQUEST_DELAY_MS > 0) await sleep(FETCH.PER_REQUEST_DELAY_MS);
  }
  log('hn-client.fetchItems', `done requested=${ids.length} got=${results.length}`);
  return results;
}
