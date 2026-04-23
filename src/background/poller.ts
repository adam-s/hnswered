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
  /** IDs whose checkOne actually ran. Used by callers like runRefresh to avoid
   *  re-checking items a prior step already covered (e.g., tick skipping items
   *  that checkFastBucket just processed). */
  processedIds?: number[];
}

const nowMs = () => Date.now();

export function toMonitored(item: HNItem): MonitoredItem | null {
  if (!item || item.deleted || item.dead) return null;
  if (item.type !== 'story' && item.type !== 'comment') return null;
  // Baseline empty so the next checkOne surfaces *all* current direct kids as "new".
  // Without this, a user who configures their HN username for the first time sees
  // nothing until brand-new replies land — existing conversations on their posts
  // are silently swallowed. Rate-limit bounded by MAX_REPLIES_PER_CHECK per tick.
  return {
    id: item.id,
    type: item.type,
    submittedAt: (item.time ?? Math.floor(nowMs() / 1000)) * 1000,
    lastDescendants: 0,
    lastKids: [],
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

export async function checkOne(
  client: HNClient,
  store: Store,
  monitored: MonitoredItem,
  hnUser: string,
): Promise<number> {
  const ageMsNow = nowMs() - monitored.submittedAt;
  log('poller.checkOne', `ENTER id=${monitored.id} type=${monitored.type} submittedAt=${monitored.submittedAt} ageHrs=${(ageMsNow / 3600000).toFixed(2)} hnUser=${hnUser} prevKidsCount=${(monitored.lastKids ?? []).length} prevKids=${JSON.stringify(monitored.lastKids)} prevDescendants=${monitored.lastDescendants}`);
  const current = await client.item(monitored.id);
  if (!current || current.deleted || current.dead) {
    log('poller.checkOne', `parent-unavailable id=${monitored.id} current=${current === null ? 'null' : JSON.stringify({deleted: current.deleted, dead: current.dead})}`);
    return 0;
  }
  log('poller.checkOne', `parent-fetched id=${monitored.id} by=${current.by} type=${current.type} descendants=${current.descendants} kidsCount=${(current.kids ?? []).length}`);

  const prevKids = monitored.lastKids ?? [];
  const currKids = current.kids ?? [];
  const newIds = newKidIds(prevKids, currKids);
  log('poller.checkOne', `diff id=${monitored.id} prevCount=${prevKids.length} currCount=${currKids.length} newCount=${newIds.length} currKids=${JSON.stringify(currKids)} new=${JSON.stringify(newIds)}`);
  if (newIds.length === 0) {
    if ((current.descendants ?? 0) !== (monitored.lastDescendants ?? 0)) {
      log('poller.checkOne', `descendants-only-changed id=${monitored.id} from=${monitored.lastDescendants} to=${current.descendants} (nested activity, no new direct kids)`);
      monitored.lastDescendants = current.descendants;
      await store.upsertMonitored(monitored);
    } else {
      log('poller.checkOne', `no-change id=${monitored.id} descendants=${current.descendants}`);
    }
    return 0;
  }

  const capped = newIds.slice(0, FETCH.MAX_REPLIES_PER_CHECK);
  if (capped.length < newIds.length) {
    log('poller.checkOne', `cap-applied id=${monitored.id} willFetch=${capped.length} leftover=${newIds.length - capped.length}`);
  }
  log('poller.checkOne', `→ fetchItems id=${monitored.id} count=${capped.length} ids=${JSON.stringify(capped)}`);
  const newItems = await fetchItems(client, capped);
  log('poller.checkOne', `← fetchItems id=${monitored.id} got=${newItems.length}`);
  const parentCtx: ParentContext = monitored.type === 'story'
    ? { title: current.title }
    : { author: current.by, excerpt: excerptFrom(current.text, 140) };
  log('poller.checkOne', `parent-ctx id=${monitored.id} ctx=${JSON.stringify(parentCtx)}`);
  const replies: Reply[] = [];
  const fetchedIds = new Set<number>();
  let selfSkipped = 0;
  let deadSkipped = 0;
  // Case-insensitive comparison: HN usernames are unique and case-preserving, but the
  // Settings UI does not enforce the user's exact case. If someone types "Alice" and
  // their handle is "alice", strict-equality would mis-file every real reply as self
  // (or vice versa). Lowercasing both sides fixes that at the cost of conflating two
  // distinct-but-differently-cased handles — which HN forbids anyway.
  const hnUserLc = hnUser.toLowerCase();
  for (const it of newItems) {
    fetchedIds.add(it.id);
    log('poller.checkOne', `consider kid=${it.id} by=${it.by} deleted=${it.deleted} dead=${it.dead} parent=${monitored.id}`);
    if ((it.by ?? '').toLowerCase() === hnUserLc) {
      selfSkipped++;
      log('poller.checkOne', `self-skip kid=${it.id} by=${it.by} hnUser=${hnUser}`);
      continue;
    }
    const r = toReply(it, monitored, parentCtx);
    if (r) {
      replies.push(r);
      log('poller.checkOne', `accepted kid=${it.id} as reply by=${r.author}`);
    } else {
      deadSkipped++;
      log('poller.checkOne', `dead/deleted-skip kid=${it.id} deleted=${it.deleted} dead=${it.dead}`);
    }
  }
  if (replies.length > 0) {
    log('poller.checkOne', `→ addReplies id=${monitored.id} count=${replies.length}`);
    await store.addReplies(replies);
    log('poller.checkOne', `← addReplies id=${monitored.id} ok`);
  }
  log('poller.checkOne', `stored id=${monitored.id} new=${replies.length} selfSkipped=${selfSkipped} deadSkipped=${deadSkipped} fetched=${fetchedIds.size}`);

  // Only mark kids as "seen" that we actually processed, so the leftover slice gets
  // picked up on the next tick instead of being silently buried.
  const processed = new Set([...prevKids, ...fetchedIds]);
  const nextLastKids = currKids.filter((id) => processed.has(id));
  log('poller.checkOne', `updating-baseline id=${monitored.id} prevKidsCount=${prevKids.length} fetchedCount=${fetchedIds.size} processedCount=${processed.size} nextLastKidsCount=${nextLastKids.length} nextLastKids=${JSON.stringify(nextLastKids)}`);
  monitored.lastKids = nextLastKids;
  monitored.lastDescendants = current.descendants;
  await store.upsertMonitored(monitored);
  log('poller.checkOne', `EXIT id=${monitored.id} returned=${replies.length}`);
  return replies.length;
}

export async function syncUserSubmissions(
  client: HNClient,
  store: Store,
  username: string,
  opts: { maxNewItems?: number; force?: boolean } = {},
): Promise<number> {
  const now = nowMs();
  log('poller.syncUser', `ENTER user=${username} force=${!!opts.force} maxNewItems=${opts.maxNewItems ?? FETCH.MAX_SYNC_ITEMS_PER_CALL}`);
  if (!opts.force) {
    const { lastUserSync } = await store.getTimestamps();
    const age = now - lastUserSync;
    if (age < FETCH.USER_SYNC_MIN_INTERVAL_MS) {
      log('poller.syncUser', `GATED user=${username} lastSyncAgeMs=${age} cooldownMs=${FETCH.USER_SYNC_MIN_INTERVAL_MS} lastUserSync=${lastUserSync}`);
      return 0;
    }
    log('poller.syncUser', `cooldown-ok user=${username} lastSyncAgeMs=${age}`);
  }
  log('poller.syncUser', `→ client.user(${username})`);
  const user = await client.user(username);
  if (!user || !user.submitted) {
    log('poller.syncUser', `no-submissions user=${username} userObj=${JSON.stringify(user)}`);
    return 0;
  }
  log('poller.syncUser', `← client.user(${username}) id=${user.id} karma=${user.karma} submittedCount=${user.submitted.length} submitted[:10]=${JSON.stringify(user.submitted.slice(0, 10))}`);
  const existing = await store.getMonitored();
  log('poller.syncUser', `existingMonitored count=${Object.keys(existing).length} ids=${JSON.stringify(Object.keys(existing))}`);
  const dropThreshold = now - BUCKET.DROP_AGE_MS;
  const cap = opts.maxNewItems ?? FETCH.MAX_SYNC_ITEMS_PER_CALL;
  let added = 0;
  let fetched = 0;
  let skippedExisting = 0;
  let skippedDeleted = 0;
  let stoppedAtAge = false;
  for (const id of user.submitted) {
    if (added >= cap) {
      log('poller.syncUser', `hit add-cap cap=${cap} added=${added} — stop walking`);
      break;
    }
    if (fetched >= cap * 2) {
      log('poller.syncUser', `hit walk-cap walkCap=${cap * 2} fetched=${fetched} — stop walking`);
      break;
    }
    const key = String(id);
    if (existing[key]) {
      skippedExisting++;
      log('poller.syncUser', `skip-existing id=${id}`);
      continue;
    }
    log('poller.syncUser', `→ client.item(${id})`);
    const item = await client.item(id);
    fetched++;
    if (!item || !item.time) {
      skippedDeleted++;
      log('poller.syncUser', `skip-null-or-notime id=${id} item=${JSON.stringify(item)}`);
      continue;
    }
    const itemTime = item.time * 1000;
    if (itemTime < dropThreshold) {
      stoppedAtAge = true;
      log('poller.syncUser', `stop-at-age id=${id} itemTimeMs=${itemTime} dropThresholdMs=${dropThreshold}`);
      break;
    }
    const m = toMonitored(item);
    if (!m) {
      skippedDeleted++;
      log('poller.syncUser', `skip-toMonitored-rejected id=${id} type=${item.type} deleted=${item.deleted} dead=${item.dead}`);
      continue;
    }
    await store.upsertMonitored(m);
    added++;
    log('poller.syncUser', `ADDED id=${id} type=${m.type} ageDays=${((now - m.submittedAt) / 86400000).toFixed(2)} lastKids=${JSON.stringify(m.lastKids)} lastDescendants=${m.lastDescendants} origKidsOnItem=${(item.kids ?? []).length} origDescendants=${item.descendants}`);
  }
  await store.setTimestamp('lastUserSync', now);
  log('poller.syncUser', `EXIT user=${username} added=${added} fetched=${fetched} skippedExisting=${skippedExisting} skippedDeleted=${skippedDeleted} stoppedAtAge=${stoppedAtAge}`);
  return added;
}

export async function tick(
  client: HNClient,
  store: Store,
  opts: { skipIds?: ReadonlySet<number> } = {},
): Promise<PollResult> {
  const config = await store.getConfig();
  if (!config.hnUser) {
    log('poller.tick', `skip reason=no-user`);
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: 'no-user' };
  }
  log('poller.tick', `start user=${config.hnUser} skipIdsCount=${opts.skipIds?.size ?? 0}`);

  const updates = await client.updates();
  const monitored = await store.getMonitored();
  const userChanged = updates.profiles.includes(config.hnUser);
  const changedIds = new Set(updates.items);
  const skipIds = opts.skipIds;
  const toCheck: MonitoredItem[] = [];
  let skippedByCaller = 0;
  for (const m of Object.values(monitored)) {
    if (!changedIds.has(m.id)) continue;
    if (skipIds?.has(m.id)) { skippedByCaller++; continue; }
    toCheck.push(m);
  }
  log('poller.tick', `updates itemsInFeed=${updates.items.length} profilesInFeed=${updates.profiles.length} userInProfiles=${userChanged} monitored=${Object.keys(monitored).length} toCheck=${toCheck.length} skippedByCaller=${skippedByCaller} toCheckIds=${JSON.stringify(toCheck.map((m) => m.id))}`);

  if (userChanged) {
    log('poller.tick', `user-in-profiles user=${config.hnUser} → attempting sync (cooldown-gated)`);
    // Honor the cooldown even when /v0/updates.profiles flags our user — an active user
    // can appear in that list on every tick, which would otherwise blow the sync budget.
    await syncUserSubmissions(client, store, config.hnUser);
  }

  let total = 0;
  const processedIds: number[] = [];
  for (const m of toCheck) {
    processedIds.push(m.id);
    total += await checkOne(client, store, m, config.hnUser);
  }

  await store.setTimestamp('lastTick', nowMs());
  log('poller.tick', `done newReplies=${total} itemsChecked=${toCheck.length}`);
  return { newReplies: total, itemsChecked: toCheck.length, skipped: false, processedIds };
}

// User-initiated force-refresh path: bypass the /v0/updates.json gate and check
// every fast-bucket monitored item directly. Necessary because HN's updates feed
// is a narrow, fast-rolling snapshot — low-traffic items with a single new reply
// can easily be absent from it, so the cheap `updates.items`-filtered tick misses
// them. Bounded: <= MAX_SYNC_ITEMS_PER_CALL items × O(1 + kid-fetch-cap) requests.
export async function checkFastBucket(
  client: HNClient,
  store: Store,
): Promise<PollResult> {
  log('poller.checkFastBucket', `ENTER`);
  const config = await store.getConfig();
  if (!config.hnUser) {
    log('poller.checkFastBucket', `skip reason=no-user config=${JSON.stringify(config)}`);
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: 'no-user', processedIds: [] };
  }
  const monitored = await store.getMonitored();
  const now = nowMs();
  const allIds = Object.keys(monitored);
  log('poller.checkFastBucket', `monitored-snapshot user=${config.hnUser} totalCount=${allIds.length} ids=${JSON.stringify(allIds)}`);
  for (const m of Object.values(monitored)) {
    const ageH = ((now - m.submittedAt) / 3600000).toFixed(2);
    log('poller.checkFastBucket', `item id=${m.id} type=${m.type} ageHrs=${ageH} withinFastBucket=${now - m.submittedAt < BUCKET.FAST_MAX_AGE_MS} lastKidsCount=${(m.lastKids ?? []).length}`);
  }
  const targets = filterByAge(monitored, 0, BUCKET.FAST_MAX_AGE_MS);
  log('poller.checkFastBucket', `targets=${targets.length} ids=${JSON.stringify(targets.map((m) => m.id))} fastMaxAgeMs=${BUCKET.FAST_MAX_AGE_MS}`);
  let total = 0;
  const processedIds: number[] = [];
  for (const m of targets) {
    log('poller.checkFastBucket', `→ checkOne id=${m.id}`);
    const n = await checkOne(client, store, m, config.hnUser);
    log('poller.checkFastBucket', `← checkOne id=${m.id} newReplies=${n}`);
    processedIds.push(m.id);
    total += n;
  }
  log('poller.checkFastBucket', `EXIT newReplies=${total} itemsChecked=${targets.length} processedIds=${JSON.stringify(processedIds)}`);
  return { newReplies: total, itemsChecked: targets.length, skipped: false, processedIds };
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
