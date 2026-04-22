import type { HNItem, MonitoredItem, Reply } from '../shared/types.ts';
import { BUCKET, DAY_MS, FETCH, RETENTION } from '../shared/constants.ts';
import { excerptFrom } from '../shared/excerpt.ts';
import { log } from '../shared/debug.ts';
import type { HNClient } from './hn-client.ts';
import { fetchItems } from './hn-client.ts';
import type { Store } from './store';

export interface PollResult {
  newReplies: number;
  itemsChecked: number;
  skipped: boolean;
  reason?: string;
}

const nowMs = () => Date.now();

export function toMonitored(item: HNItem): MonitoredItem | null {
  if (!item || item.deleted || item.dead) return null;
  if (item.type !== 'story' && item.type !== 'comment') return null;
  return {
    id: item.id,
    type: item.type,
    submittedAt: (item.time ?? Math.floor(nowMs() / 1000)) * 1000,
    lastDescendants: item.descendants,
    lastKids: [...(item.kids ?? [])],
  };
}

export function newKidIds(prev: number[], next: number[]): number[] {
  const seen = new Set(prev);
  const out: number[] = [];
  for (const id of next) if (!seen.has(id)) out.push(id);
  return out;
}

export interface ParentContext {
  title?: string;
  author?: string;
  excerpt?: string;
}

export function toReply(item: HNItem, parent: MonitoredItem, ctx: ParentContext = {}): Reply | null {
  if (!item || item.deleted || item.dead) return null;
  if (!item.by || !item.id) return null;
  return {
    id: item.id,
    parentItemId: parent.id,
    parentItemTitle: ctx.title,
    parentAuthor: ctx.author,
    parentExcerpt: ctx.excerpt,
    author: item.by,
    text: item.text ?? '',
    time: (item.time ?? 0) * 1000,
    read: false,
    discoveredAt: nowMs(),
  };
}

export function ageMs(item: MonitoredItem, now = nowMs()): number {
  return now - item.submittedAt;
}

export function filterByAge(
  monitored: Record<string, MonitoredItem>,
  minAgeMs: number,
  maxAgeMs: number,
  now = nowMs(),
): MonitoredItem[] {
  const out: MonitoredItem[] = [];
  for (const m of Object.values(monitored)) {
    const age = ageMs(m, now);
    if (age >= minAgeMs && age < maxAgeMs) out.push(m);
  }
  return out;
}

async function checkOne(
  client: HNClient,
  store: Store,
  monitored: MonitoredItem,
  hnUser: string,
): Promise<number> {
  log('poller.checkOne', `start id=${monitored.id} type=${monitored.type} prevKids=${JSON.stringify(monitored.lastKids)}`);
  const current = await client.item(monitored.id);
  if (!current || current.deleted || current.dead) {
    log('poller.checkOne', `parent-unavailable id=${monitored.id} deleted=${current?.deleted} dead=${current?.dead}`);
    return 0;
  }

  const prevKids = monitored.lastKids ?? [];
  const currKids = current.kids ?? [];
  const newIds = newKidIds(prevKids, currKids);
  log('poller.checkOne', `diff id=${monitored.id} currKids=${JSON.stringify(currKids)} new=${JSON.stringify(newIds)} descendants=${current.descendants}`);
  if (newIds.length === 0) {
    if ((current.descendants ?? 0) !== (monitored.lastDescendants ?? 0)) {
      log('poller.checkOne', `descendants-changed id=${monitored.id} from=${monitored.lastDescendants} to=${current.descendants}`);
      monitored.lastDescendants = current.descendants;
      await store.upsertMonitored(monitored);
    }
    return 0;
  }

  const capped = newIds.slice(0, FETCH.MAX_REPLIES_PER_CHECK);
  if (capped.length < newIds.length) {
    log('poller.checkOne', `cap-applied id=${monitored.id} willFetch=${capped.length} leftover=${newIds.length - capped.length}`);
  }
  const newItems = await fetchItems(client, capped);
  const parentCtx: ParentContext = monitored.type === 'story'
    ? { title: current.title }
    : { author: current.by, excerpt: excerptFrom(current.text, 140) };
  const replies: Reply[] = [];
  const fetchedIds = new Set<number>();
  let selfSkipped = 0;
  let deadSkipped = 0;
  for (const it of newItems) {
    fetchedIds.add(it.id);
    if (it.by === hnUser) { selfSkipped++; continue; }
    const r = toReply(it, monitored, parentCtx);
    if (r) replies.push(r);
    else deadSkipped++;
  }
  if (replies.length > 0) await store.addReplies(replies);
  log('poller.checkOne', `stored id=${monitored.id} new=${replies.length} selfSkipped=${selfSkipped} deadSkipped=${deadSkipped} fetched=${fetchedIds.size}`);

  // Only mark kids as "seen" that we actually processed, so the leftover slice gets
  // picked up on the next tick instead of being silently buried.
  const processed = new Set([...prevKids, ...fetchedIds]);
  monitored.lastKids = currKids.filter((id) => processed.has(id));
  monitored.lastDescendants = current.descendants;
  await store.upsertMonitored(monitored);
  return replies.length;
}

export async function syncUserSubmissions(
  client: HNClient,
  store: Store,
  username: string,
  opts: { maxNewItems?: number; force?: boolean } = {},
): Promise<number> {
  const now = nowMs();
  log('poller.syncUser', `start user=${username} force=${!!opts.force}`);
  if (!opts.force) {
    const { lastUserSync } = await store.getTimestamps();
    const age = now - lastUserSync;
    if (age < FETCH.USER_SYNC_MIN_INTERVAL_MS) {
      log('poller.syncUser', `gated user=${username} lastSyncAgeMs=${age} cooldownMs=${FETCH.USER_SYNC_MIN_INTERVAL_MS}`);
      return 0;
    }
  }
  const user = await client.user(username);
  if (!user || !user.submitted) {
    log('poller.syncUser', `no-submissions user=${username}`);
    return 0;
  }
  const existing = await store.getMonitored();
  log('poller.syncUser', `user=${username} submissions=${user.submitted.length} existingMonitored=${Object.keys(existing).length}`);
  const dropThreshold = now - BUCKET.DROP_AGE_MS;
  const cap = opts.maxNewItems ?? FETCH.MAX_SYNC_ITEMS_PER_CALL;
  let added = 0;
  let fetched = 0;
  let skippedExisting = 0;
  let skippedDeleted = 0;
  let stoppedAtAge = false;
  for (const id of user.submitted) {
    if (added >= cap) break;
    if (fetched >= cap * 2) break; // walk-cap so we don't chase deleted items forever
    const key = String(id);
    if (existing[key]) { skippedExisting++; continue; }
    const item = await client.item(id);
    fetched++;
    if (!item || !item.time) { skippedDeleted++; continue; }
    const itemTime = item.time * 1000;
    if (itemTime < dropThreshold) { stoppedAtAge = true; break; }
    const m = toMonitored(item);
    if (!m) { skippedDeleted++; continue; }
    await store.upsertMonitored(m);
    added++;
    log('poller.syncUser', `added id=${id} type=${m.type} ageDays=${((now - m.submittedAt) / 86400000).toFixed(2)}`);
  }
  await store.setTimestamp('lastUserSync', now);
  log('poller.syncUser', `done user=${username} added=${added} fetched=${fetched} skippedExisting=${skippedExisting} skippedDeleted=${skippedDeleted} stoppedAtAge=${stoppedAtAge}`);
  return added;
}

export async function tick(
  client: HNClient,
  store: Store,
): Promise<PollResult> {
  const config = await store.getConfig();
  if (!config.hnUser) {
    log('poller.tick', `skip reason=no-user`);
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: 'no-user' };
  }
  log('poller.tick', `start user=${config.hnUser}`);

  const updates = await client.updates();
  const monitored = await store.getMonitored();
  const userChanged = updates.profiles.includes(config.hnUser);
  const changedIds = new Set(updates.items);
  const toCheck: MonitoredItem[] = [];
  for (const m of Object.values(monitored)) {
    if (changedIds.has(m.id)) toCheck.push(m);
  }
  log('poller.tick', `updates itemsInFeed=${updates.items.length} profilesInFeed=${updates.profiles.length} userInProfiles=${userChanged} monitored=${Object.keys(monitored).length} toCheck=${toCheck.length} toCheckIds=${JSON.stringify(toCheck.map((m) => m.id))}`);

  if (userChanged) {
    log('poller.tick', `user-in-profiles user=${config.hnUser} → attempting sync (cooldown-gated)`);
    // Honor the cooldown even when /v0/updates.profiles flags our user — an active user
    // can appear in that list on every tick, which would otherwise blow the sync budget.
    await syncUserSubmissions(client, store, config.hnUser);
  }

  let total = 0;
  for (const m of toCheck) {
    total += await checkOne(client, store, m, config.hnUser);
  }

  await store.setTimestamp('lastTick', nowMs());
  log('poller.tick', `done newReplies=${total} itemsChecked=${toCheck.length}`);
  return { newReplies: total, itemsChecked: toCheck.length, skipped: false };
}

export async function scanBucket(
  client: HNClient,
  store: Store,
  minAgeMs: number,
  maxAgeMs: number,
  stampKey: 'lastDailyScan' | 'lastWeeklyScan',
): Promise<PollResult> {
  const config = await store.getConfig();
  if (!config.hnUser) {
    log('poller.scanBucket', `skip stampKey=${stampKey} reason=no-user`);
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: 'no-user' };
  }
  log('poller.scanBucket', `start stampKey=${stampKey} minAgeMs=${minAgeMs} maxAgeMs=${maxAgeMs}`);

  await syncUserSubmissions(client, store, config.hnUser);
  const monitored = await store.getMonitored();
  const targets = filterByAge(monitored, minAgeMs, maxAgeMs);
  log('poller.scanBucket', `bucket stampKey=${stampKey} monitored=${Object.keys(monitored).length} targets=${targets.length} targetIds=${JSON.stringify(targets.map((m) => m.id))}`);

  let total = 0;
  for (const m of targets) {
    total += await checkOne(client, store, m, config.hnUser);
  }

  const now = nowMs();
  const toDrop: number[] = [];
  for (const m of Object.values(monitored)) {
    if (ageMs(m, now) >= BUCKET.DROP_AGE_MS) toDrop.push(m.id);
  }
  if (toDrop.length > 0) {
    log('poller.scanBucket', `drop-expired stampKey=${stampKey} count=${toDrop.length} ids=${JSON.stringify(toDrop)}`);
    await store.removeMonitored(toDrop);
  }

  // Daily scan is also the cadence for reply retention sweep.
  if (stampKey === 'lastDailyScan') {
    const retentionDays = Math.max(1, Number(config.retentionDays) || 30);
    const dropped = await store.pruneReplies({
      readOlderThanMs: retentionDays * DAY_MS,
      hardCap: RETENTION.HARD_REPLY_CAP,
      orphanedIfMonitoredMissing: true,
      now,
    });
    log('poller.scanBucket', `prune retentionDays=${retentionDays} dropped=${dropped}`);
  }

  await store.setTimestamp(stampKey, now);
  log('poller.scanBucket', `done stampKey=${stampKey} newReplies=${total} itemsChecked=${targets.length}`);
  return { newReplies: total, itemsChecked: targets.length, skipped: false };
}
