import { F as FETCH, H as HN_API, D as DEFAULT_CONFIG, B as BUCKET, R as RETENTION, a as DAY_MS, A as ALARM, L as LOCK } from './assets/constants-CC4aYNRT.js';

function log(loc, msg, data) {
  return;
}
function logErr(loc, msg, err) {
  return;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJSON(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH.TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const body = await res.json();
    const elapsed = Date.now() - t0;
    const size = typeof body === "object" ? JSON.stringify(body).length : 0;
    log("hn-client.fetchJSON", `OK attempt=${attempt} elapsedMs=${elapsed} bytes=${size} url=${url}`);
    return body;
  } catch (err) {
    if (attempt >= FETCH.MAX_RETRIES) {
      throw err;
    }
    const backoff = Math.min(
      FETCH.BACKOFF_BASE_MS * 2 ** attempt,
      FETCH.BACKOFF_MAX_MS
    );
    await sleep(backoff);
    return fetchJSON(url, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}
const hnClient = {
  async updates() {
    return fetchJSON(`${HN_API}/updates.json`);
  },
  async user(id) {
    return fetchJSON(`${HN_API}/user/${encodeURIComponent(id)}.json`);
  },
  async item(id) {
    return fetchJSON(`${HN_API}/item/${id}.json`);
  }
};
async function fetchItems(client, ids) {
  log("hn-client.fetchItems", `start count=${ids.length} ids=${JSON.stringify(ids)}`);
  const results = [];
  for (const id of ids) {
    const item = await client.item(id);
    if (item) {
      results.push(item);
      if (item.deleted || item.dead) {
        log("hn-client.fetchItems", `included-dead-or-deleted id=${id} deleted=${item.deleted} dead=${item.dead}`);
      }
    }
    await sleep(FETCH.PER_REQUEST_DELAY_MS);
  }
  log("hn-client.fetchItems", `done requested=${ids.length} got=${results.length}`);
  return results;
}

function createStore(area = chrome.storage.local) {
  async function get(key, fallback) {
    const res = await area.get(key);
    const value = res[key];
    return value ?? fallback;
  }
  async function set(key, value) {
    await area.set({ [key]: value });
  }
  return {
    async getConfig() {
      return get("config", { ...DEFAULT_CONFIG });
    },
    async setConfig(partial) {
      const current = await this.getConfig();
      const next = { ...current, ...partial };
      await set("config", next);
      return next;
    },
    async getMonitored() {
      return get("monitored", {});
    },
    async setMonitored(monitored) {
      await set("monitored", monitored);
    },
    async upsertMonitored(item) {
      const current = await this.getMonitored();
      current[String(item.id)] = item;
      await set("monitored", current);
    },
    async removeMonitored(ids) {
      const current = await this.getMonitored();
      for (const id of ids) delete current[String(id)];
      await set("monitored", current);
    },
    async getReplies() {
      return get("replies", {});
    },
    async addReplies(newReplies) {
      const current = await this.getReplies();
      for (const r of newReplies) {
        if (!current[String(r.id)]) current[String(r.id)] = r;
      }
      await set("replies", current);
    },
    async markRead(id) {
      const current = await this.getReplies();
      const r = current[String(id)];
      if (r && !r.read) {
        r.read = true;
        await set("replies", current);
      }
    },
    async markAllRead() {
      const current = await this.getReplies();
      let changed = false;
      for (const r of Object.values(current)) {
        if (!r.read) {
          r.read = true;
          changed = true;
        }
      }
      if (changed) await set("replies", current);
    },
    async getUnreadCount() {
      const current = await this.getReplies();
      let n = 0;
      for (const r of Object.values(current)) if (!r.read) n++;
      return n;
    },
    async pruneReplies(opts) {
      const now = opts.now ?? Date.now();
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      const monitored = opts.orphanedIfMonitoredMissing ? await this.getMonitored() : null;
      const entries = Object.entries(current);
      for (const [key, r] of entries) {
        if (opts.readOlderThanMs !== void 0 && r.read && now - r.discoveredAt > opts.readOlderThanMs) {
          delete current[key];
          continue;
        }
        if (monitored && r.read && !monitored[String(r.parentItemId)]) {
          delete current[key];
          continue;
        }
      }
      if (opts.hardCap !== void 0 && Object.keys(current).length > opts.hardCap) {
        const remaining = Object.values(current).sort((a, b) => {
          if (a.read !== b.read) return a.read ? -1 : 1;
          return a.discoveredAt - b.discoveredAt;
        });
        const over = remaining.length - opts.hardCap;
        for (let i = 0; i < over; i++) delete current[String(remaining[i].id)];
      }
      const after = Object.keys(current).length;
      if (after !== before) await set("replies", current);
      return before - after;
    },
    async clearRead() {
      const current = await this.getReplies();
      const before = Object.keys(current).length;
      for (const [key, r] of Object.entries(current)) {
        if (r.read) delete current[key];
      }
      const after = Object.keys(current).length;
      if (after !== before) await set("replies", current);
      return before - after;
    },
    async clearAllReplies() {
      const current = await this.getReplies();
      const n = Object.keys(current).length;
      if (n > 0) await set("replies", {});
      return n;
    },
    async clearPerUserState() {
      await area.remove(["replies", "monitored", "lastUserSync"]);
    },
    async getBytesInUse() {
      if (typeof area.getBytesInUse !== "function") return 0;
      return new Promise((resolve) => {
        try {
          const maybePromise = area.getBytesInUse(null, (b) => resolve(b ?? 0));
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then((b) => resolve(b ?? 0), () => resolve(0));
          }
        } catch {
          resolve(0);
        }
      });
    },
    async getTimestamps() {
      const res = await area.get(["lastTick", "lastDailyScan", "lastWeeklyScan", "lastUserSync"]);
      return {
        lastTick: res.lastTick ?? 0,
        lastDailyScan: res.lastDailyScan ?? 0,
        lastWeeklyScan: res.lastWeeklyScan ?? 0,
        lastUserSync: res.lastUserSync ?? 0
      };
    },
    async setTimestamp(key, ts) {
      await set(key, ts);
    }
  };
}

function excerptFrom(html, maxChars = 140) {
  if (!html) return void 0;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&#x2F;/g, "/").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  if (!text) return void 0;
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  const trimTo = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
  return text.slice(0, trimTo).trimEnd() + "…";
}

const nowMs = () => Date.now();
function toMonitored(item) {
  if (!item || item.deleted || item.dead) return null;
  if (item.type !== "story" && item.type !== "comment") return null;
  return {
    id: item.id,
    type: item.type,
    submittedAt: (item.time ?? Math.floor(nowMs() / 1e3)) * 1e3,
    lastDescendants: 0,
    lastKids: []
  };
}
function newKidIds(prev, next) {
  const seen = new Set(prev);
  const out = [];
  for (const id of next) if (!seen.has(id)) out.push(id);
  return out;
}
function toReply(item, parent, ctx = {}) {
  if (!item || item.deleted || item.dead) return null;
  if (!item.by || !item.id) return null;
  return {
    id: item.id,
    parentItemId: parent.id,
    parentItemTitle: ctx.title,
    parentAuthor: ctx.author,
    parentExcerpt: ctx.excerpt,
    author: item.by,
    text: item.text ?? "",
    time: (item.time ?? 0) * 1e3,
    read: false,
    discoveredAt: nowMs()
  };
}
function ageMs(item, now = nowMs()) {
  return now - item.submittedAt;
}
function filterByAge(monitored, minAgeMs, maxAgeMs, now = nowMs()) {
  const out = [];
  for (const m of Object.values(monitored)) {
    const age = ageMs(m, now);
    if (age >= minAgeMs && age < maxAgeMs) out.push(m);
  }
  return out;
}
async function checkOne(client, store, monitored, hnUser) {
  const ageMsNow = nowMs() - monitored.submittedAt;
  log("poller.checkOne", `ENTER id=${monitored.id} type=${monitored.type} submittedAt=${monitored.submittedAt} ageHrs=${(ageMsNow / 36e5).toFixed(2)} hnUser=${hnUser} prevKidsCount=${(monitored.lastKids ?? []).length} prevKids=${JSON.stringify(monitored.lastKids)} prevDescendants=${monitored.lastDescendants}`);
  const current = await client.item(monitored.id);
  if (!current || current.deleted || current.dead) {
    log("poller.checkOne", `parent-unavailable id=${monitored.id} current=${current === null ? "null" : JSON.stringify({ deleted: current.deleted, dead: current.dead })}`);
    return 0;
  }
  log("poller.checkOne", `parent-fetched id=${monitored.id} by=${current.by} type=${current.type} descendants=${current.descendants} kidsCount=${(current.kids ?? []).length}`);
  const prevKids = monitored.lastKids ?? [];
  const currKids = current.kids ?? [];
  const newIds = newKidIds(prevKids, currKids);
  log("poller.checkOne", `diff id=${monitored.id} prevCount=${prevKids.length} currCount=${currKids.length} newCount=${newIds.length} currKids=${JSON.stringify(currKids)} new=${JSON.stringify(newIds)}`);
  if (newIds.length === 0) {
    if ((current.descendants ?? 0) !== (monitored.lastDescendants ?? 0)) {
      log("poller.checkOne", `descendants-only-changed id=${monitored.id} from=${monitored.lastDescendants} to=${current.descendants} (nested activity, no new direct kids)`);
      monitored.lastDescendants = current.descendants;
      await store.upsertMonitored(monitored);
    } else {
      log("poller.checkOne", `no-change id=${monitored.id} descendants=${current.descendants}`);
    }
    return 0;
  }
  const capped = newIds.slice(0, FETCH.MAX_REPLIES_PER_CHECK);
  if (capped.length < newIds.length) {
    log("poller.checkOne", `cap-applied id=${monitored.id} willFetch=${capped.length} leftover=${newIds.length - capped.length}`);
  }
  log("poller.checkOne", `→ fetchItems id=${monitored.id} count=${capped.length} ids=${JSON.stringify(capped)}`);
  const newItems = await fetchItems(client, capped);
  log("poller.checkOne", `← fetchItems id=${monitored.id} got=${newItems.length}`);
  const parentCtx = monitored.type === "story" ? { title: current.title } : { author: current.by, excerpt: excerptFrom(current.text, 140) };
  log("poller.checkOne", `parent-ctx id=${monitored.id} ctx=${JSON.stringify(parentCtx)}`);
  const replies = [];
  const fetchedIds = /* @__PURE__ */ new Set();
  let selfSkipped = 0;
  let deadSkipped = 0;
  const hnUserLc = hnUser.toLowerCase();
  for (const it of newItems) {
    fetchedIds.add(it.id);
    log("poller.checkOne", `consider kid=${it.id} by=${it.by} deleted=${it.deleted} dead=${it.dead} parent=${monitored.id}`);
    if ((it.by ?? "").toLowerCase() === hnUserLc) {
      selfSkipped++;
      log("poller.checkOne", `self-skip kid=${it.id} by=${it.by} hnUser=${hnUser}`);
      continue;
    }
    const r = toReply(it, monitored, parentCtx);
    if (r) {
      replies.push(r);
      log("poller.checkOne", `accepted kid=${it.id} as reply by=${r.author}`);
    } else {
      deadSkipped++;
      log("poller.checkOne", `dead/deleted-skip kid=${it.id} deleted=${it.deleted} dead=${it.dead}`);
    }
  }
  if (replies.length > 0) {
    log("poller.checkOne", `→ addReplies id=${monitored.id} count=${replies.length}`);
    await store.addReplies(replies);
    log("poller.checkOne", `← addReplies id=${monitored.id} ok`);
  }
  log("poller.checkOne", `stored id=${monitored.id} new=${replies.length} selfSkipped=${selfSkipped} deadSkipped=${deadSkipped} fetched=${fetchedIds.size}`);
  const processed = /* @__PURE__ */ new Set([...prevKids, ...fetchedIds]);
  const nextLastKids = currKids.filter((id) => processed.has(id));
  log("poller.checkOne", `updating-baseline id=${monitored.id} prevKidsCount=${prevKids.length} fetchedCount=${fetchedIds.size} processedCount=${processed.size} nextLastKidsCount=${nextLastKids.length} nextLastKids=${JSON.stringify(nextLastKids)}`);
  monitored.lastKids = nextLastKids;
  monitored.lastDescendants = current.descendants;
  await store.upsertMonitored(monitored);
  log("poller.checkOne", `EXIT id=${monitored.id} returned=${replies.length}`);
  return replies.length;
}
async function syncUserSubmissions(client, store, username, opts = {}) {
  const now = nowMs();
  log("poller.syncUser", `ENTER user=${username} force=${!!opts.force} maxNewItems=${opts.maxNewItems ?? FETCH.MAX_SYNC_ITEMS_PER_CALL}`);
  if (!opts.force) {
    const { lastUserSync } = await store.getTimestamps();
    const age = now - lastUserSync;
    if (age < FETCH.USER_SYNC_MIN_INTERVAL_MS) {
      return 0;
    }
  }
  const user = await client.user(username);
  if (!user || !user.submitted) {
    log("poller.syncUser", `no-submissions user=${username} userObj=${JSON.stringify(user)}`);
    return 0;
  }
  log("poller.syncUser", `← client.user(${username}) id=${user.id} karma=${user.karma} submittedCount=${user.submitted.length} submitted[:10]=${JSON.stringify(user.submitted.slice(0, 10))}`);
  const existing = await store.getMonitored();
  log("poller.syncUser", `existingMonitored count=${Object.keys(existing).length} ids=${JSON.stringify(Object.keys(existing))}`);
  const dropThreshold = now - BUCKET.DROP_AGE_MS;
  const cap = opts.maxNewItems ?? FETCH.MAX_SYNC_ITEMS_PER_CALL;
  let added = 0;
  let fetched = 0;
  for (const id of user.submitted) {
    if (added >= cap) {
      break;
    }
    if (fetched >= cap * 2) {
      break;
    }
    const key = String(id);
    if (existing[key]) {
      continue;
    }
    const item = await client.item(id);
    fetched++;
    if (!item || !item.time) {
      log("poller.syncUser", `skip-null-or-notime id=${id} item=${JSON.stringify(item)}`);
      continue;
    }
    const itemTime = item.time * 1e3;
    if (itemTime < dropThreshold) {
      break;
    }
    const m = toMonitored(item);
    if (!m) {
      log("poller.syncUser", `skip-toMonitored-rejected id=${id} type=${item.type} deleted=${item.deleted} dead=${item.dead}`);
      continue;
    }
    await store.upsertMonitored(m);
    added++;
    log("poller.syncUser", `ADDED id=${id} type=${m.type} ageDays=${((now - m.submittedAt) / 864e5).toFixed(2)} lastKids=${JSON.stringify(m.lastKids)} lastDescendants=${m.lastDescendants} origKidsOnItem=${(item.kids ?? []).length} origDescendants=${item.descendants}`);
  }
  await store.setTimestamp("lastUserSync", now);
  return added;
}
async function tick(client, store, opts = {}) {
  const config = await store.getConfig();
  if (!config.hnUser) {
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: "no-user" };
  }
  log("poller.tick", `start user=${config.hnUser} skipIdsCount=${opts.skipIds?.size ?? 0}`);
  const updates = await client.updates();
  const monitored = await store.getMonitored();
  const userChanged = updates.profiles.includes(config.hnUser);
  const changedIds = new Set(updates.items);
  const skipIds = opts.skipIds;
  const toCheck = [];
  let skippedByCaller = 0;
  for (const m of Object.values(monitored)) {
    if (!changedIds.has(m.id)) continue;
    if (skipIds?.has(m.id)) {
      skippedByCaller++;
      continue;
    }
    toCheck.push(m);
  }
  log("poller.tick", `updates itemsInFeed=${updates.items.length} profilesInFeed=${updates.profiles.length} userInProfiles=${userChanged} monitored=${Object.keys(monitored).length} toCheck=${toCheck.length} skippedByCaller=${skippedByCaller} toCheckIds=${JSON.stringify(toCheck.map((m) => m.id))}`);
  if (userChanged) {
    log("poller.tick", `user-in-profiles user=${config.hnUser} → attempting sync (cooldown-gated)`);
    await syncUserSubmissions(client, store, config.hnUser);
  }
  let total = 0;
  const processedIds = [];
  for (const m of toCheck) {
    processedIds.push(m.id);
    total += await checkOne(client, store, m, config.hnUser);
  }
  await store.setTimestamp("lastTick", nowMs());
  log("poller.tick", `done newReplies=${total} itemsChecked=${toCheck.length}`);
  return { newReplies: total, itemsChecked: toCheck.length, skipped: false, processedIds };
}
async function checkFastBucket(client, store) {
  const config = await store.getConfig();
  if (!config.hnUser) {
    log("poller.checkFastBucket", `skip reason=no-user config=${JSON.stringify(config)}`);
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: "no-user", processedIds: [] };
  }
  const monitored = await store.getMonitored();
  const now = nowMs();
  const allIds = Object.keys(monitored);
  log("poller.checkFastBucket", `monitored-snapshot user=${config.hnUser} totalCount=${allIds.length} ids=${JSON.stringify(allIds)}`);
  for (const m of Object.values(monitored)) {
    const ageH = ((now - m.submittedAt) / 36e5).toFixed(2);
    log("poller.checkFastBucket", `item id=${m.id} type=${m.type} ageHrs=${ageH} withinFastBucket=${now - m.submittedAt < BUCKET.FAST_MAX_AGE_MS} lastKidsCount=${(m.lastKids ?? []).length}`);
  }
  const targets = filterByAge(monitored, 0, BUCKET.FAST_MAX_AGE_MS);
  log("poller.checkFastBucket", `targets=${targets.length} ids=${JSON.stringify(targets.map((m) => m.id))} fastMaxAgeMs=${BUCKET.FAST_MAX_AGE_MS}`);
  let total = 0;
  const processedIds = [];
  for (const m of targets) {
    log("poller.checkFastBucket", `→ checkOne id=${m.id}`);
    const n = await checkOne(client, store, m, config.hnUser);
    log("poller.checkFastBucket", `← checkOne id=${m.id} newReplies=${n}`);
    processedIds.push(m.id);
    total += n;
  }
  log("poller.checkFastBucket", `EXIT newReplies=${total} itemsChecked=${targets.length} processedIds=${JSON.stringify(processedIds)}`);
  return { newReplies: total, itemsChecked: targets.length, skipped: false, processedIds };
}
async function scanBucket(client, store, minAgeMs, maxAgeMs, stampKey) {
  const config = await store.getConfig();
  if (!config.hnUser) {
    return { newReplies: 0, itemsChecked: 0, skipped: true, reason: "no-user" };
  }
  await syncUserSubmissions(client, store, config.hnUser);
  const monitored = await store.getMonitored();
  const targets = filterByAge(monitored, minAgeMs, maxAgeMs);
  log("poller.scanBucket", `bucket stampKey=${stampKey} monitored=${Object.keys(monitored).length} targets=${targets.length} targetIds=${JSON.stringify(targets.map((m) => m.id))}`);
  let total = 0;
  for (const m of targets) {
    total += await checkOne(client, store, m, config.hnUser);
  }
  const now = nowMs();
  const toDrop = [];
  for (const m of Object.values(monitored)) {
    if (ageMs(m, now) >= BUCKET.DROP_AGE_MS) toDrop.push(m.id);
  }
  if (toDrop.length > 0) {
    log("poller.scanBucket", `drop-expired stampKey=${stampKey} count=${toDrop.length} ids=${JSON.stringify(toDrop)}`);
    await store.removeMonitored(toDrop);
  }
  if (stampKey === "lastDailyScan") {
    const retentionDays = Math.max(1, Number(config.retentionDays) || 30);
    await store.pruneReplies({
      readOlderThanMs: retentionDays * DAY_MS,
      hardCap: RETENTION.HARD_REPLY_CAP,
      orphanedIfMonitoredMissing: true,
      now
    });
  }
  await store.setTimestamp(stampKey, now);
  log("poller.scanBucket", `done stampKey=${stampKey} newReplies=${total} itemsChecked=${targets.length}`);
  return { newReplies: total, itemsChecked: targets.length, skipped: false };
}

async function updateBadge(unreadCount) {
  const text = unreadCount > 0 ? unreadCount > 99 ? "99+" : String(unreadCount) : "";
  await chrome.action.setBadgeText({ text });
  if (unreadCount > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2d7d7d" });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
}

const store = createStore();
async function refreshBadge() {
  const n = await store.getUnreadCount();
  await updateBadge(n);
}
async function ensureAlarms() {
  const config = await store.getConfig();
  const tickMin = Math.max(1, config.tickMinutes || DEFAULT_CONFIG.tickMinutes);
  const existing = await chrome.alarms.get(ALARM.TICK);
  if (!existing || existing.periodInMinutes !== tickMin) {
    await chrome.alarms.create(ALARM.TICK, {
      periodInMinutes: tickMin,
      delayInMinutes: tickMin
    });
  }
  if (!await chrome.alarms.get(ALARM.DAILY)) {
    await chrome.alarms.create(ALARM.DAILY, { periodInMinutes: 24 * 60, delayInMinutes: 60 });
  }
  if (!await chrome.alarms.get(ALARM.WEEKLY)) {
    await chrome.alarms.create(ALARM.WEEKLY, { periodInMinutes: 7 * 24 * 60, delayInMinutes: 24 * 60 });
  }
}
const MIN_REFRESH_INTERVAL_MS = 1e4;
let lastForceRefreshAt = 0;
async function runTick() {
  await navigator.locks.request(LOCK.TICK, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      return;
    }
    try {
      await tick(hnClient, store);
    } catch (err) {
      console.error("[HNswered] tick failed:", err);
    } finally {
      await refreshBadge();
    }
  });
}
async function runRefresh() {
  const now = Date.now();
  const sinceLastMs = now - lastForceRefreshAt;
  if (sinceLastMs < MIN_REFRESH_INTERVAL_MS) {
    await navigator.locks.request(LOCK.TICK, () => {
    });
    return;
  }
  lastForceRefreshAt = now;
  await navigator.locks.request(LOCK.TICK, async () => {
    try {
      const config = await store.getConfig();
      const { hnUser } = config;
      log("index.runRefresh", `config hnUser=${JSON.stringify(hnUser)} tickMin=${config.tickMinutes} retDays=${config.retentionDays}`);
      const monitoredBefore = await store.getMonitored();
      log("index.runRefresh", `pre-sync monitoredCount=${Object.keys(monitoredBefore).length} ids=${JSON.stringify(Object.keys(monitoredBefore))}`);
      if (hnUser) {
        log("index.runRefresh", `→ syncUserSubmissions user=${hnUser} force=true`);
        const added = await syncUserSubmissions(hnClient, store, hnUser, { force: true });
        log("index.runRefresh", `← syncUserSubmissions user=${hnUser} added=${added}`);
      } else {
        log("index.runRefresh", `skip syncUserSubmissions — no hnUser configured`);
      }
      const monitoredAfter = await store.getMonitored();
      log("index.runRefresh", `post-sync monitoredCount=${Object.keys(monitoredAfter).length} ids=${JSON.stringify(Object.keys(monitoredAfter))}`);
      log("index.runRefresh", `→ checkFastBucket`);
      const fastRes = await checkFastBucket(hnClient, store);
      log("index.runRefresh", `← checkFastBucket newReplies=${fastRes.newReplies} itemsChecked=${fastRes.itemsChecked} skipped=${fastRes.skipped} reason=${fastRes.reason}`);
      const skipIds = new Set(fastRes.processedIds ?? []);
      log("index.runRefresh", `→ tick skipIdsCount=${skipIds.size}`);
      const tickRes = await tick(hnClient, store, { skipIds });
      log("index.runRefresh", `← tick newReplies=${tickRes.newReplies} itemsChecked=${tickRes.itemsChecked} skipped=${tickRes.skipped} reason=${tickRes.reason}`);
      const replies = await store.getReplies();
      log("index.runRefresh", `final replyCount=${Object.keys(replies).length}`);
    } catch (err) {
      console.error("[HNswered] refresh failed:", err);
    } finally {
      await refreshBadge();
    }
  });
}
async function runDaily() {
  await navigator.locks.request(LOCK.DAILY, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      return;
    }
    try {
      await scanBucket(hnClient, store, BUCKET.DAILY_MIN_AGE_MS, BUCKET.DAILY_MAX_AGE_MS, "lastDailyScan");
    } catch (err) {
      console.error("[HNswered] daily scan failed:", err);
    } finally {
      await refreshBadge();
    }
  });
}
async function runWeekly() {
  await navigator.locks.request(LOCK.WEEKLY, { ifAvailable: true }, async (lock) => {
    if (lock === null) {
      return;
    }
    try {
      await scanBucket(hnClient, store, BUCKET.WEEKLY_MIN_AGE_MS, BUCKET.WEEKLY_MAX_AGE_MS, "lastWeeklyScan");
    } catch (err) {
      console.error("[HNswered] weekly scan failed:", err);
    } finally {
      await refreshBadge();
    }
  });
}
chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
  await refreshBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await refreshBadge();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  log("index.onAlarm", `fired name=${alarm.name} scheduledTime=${alarm.scheduledTime}`);
  if (alarm.name === ALARM.TICK) void runTick();
  else if (alarm.name === ALARM.DAILY) void runDaily();
  else if (alarm.name === ALARM.WEEKLY) void runWeekly();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  log("index.onStorageChanged", `keys=${JSON.stringify(keys)}`);
  if (changes.replies) void refreshBadge();
});
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log("index.onMessage", `RECV kind=${message.kind} senderUrl=${sender?.url ?? "n/a"}`);
  const respond = (value) => sendResponse(value);
  (async () => {
    try {
      switch (message.kind) {
        case "list-replies": {
          const replies = await store.getReplies();
          respond({ ok: true, data: Object.values(replies).sort((a, b) => b.time - a.time) });
          return;
        }
        case "mark-read": {
          await store.markRead(message.id);
          respond({ ok: true });
          return;
        }
        case "mark-all-read": {
          await store.markAllRead();
          respond({ ok: true });
          return;
        }
        case "get-config": {
          const config = await store.getConfig();
          respond({ ok: true, data: config });
          return;
        }
        case "set-config": {
          const prev = await store.getConfig();
          const config = await store.setConfig(message.config);
          const nextUser = (config.hnUser ?? "").trim();
          const prevUser = (prev.hnUser ?? "").trim();
          if (nextUser !== prevUser) {
            log("index.onMessage", `user-changed from=${JSON.stringify(prevUser)} to=${JSON.stringify(nextUser)} → clearPerUserState`);
            await store.clearPerUserState();
            await refreshBadge();
            if (nextUser) {
              log("index.onMessage", `user-changed → reset throttle + void runRefresh() for user=${nextUser}`);
              lastForceRefreshAt = 0;
              void runRefresh();
            }
          }
          await ensureAlarms();
          respond({ ok: true, data: config });
          return;
        }
        case "force-tick": {
          await runTick();
          respond({ ok: true });
          return;
        }
        case "force-refresh": {
          await runRefresh();
          respond({ ok: true });
          return;
        }
        case "force-daily-scan": {
          await runDaily();
          respond({ ok: true });
          return;
        }
        case "force-weekly-scan": {
          await runWeekly();
          respond({ ok: true });
          return;
        }
        case "get-monitored": {
          const monitored = await store.getMonitored();
          respond({ ok: true, data: Object.values(monitored) });
          return;
        }
        case "reset-all": {
          await chrome.storage.local.clear();
          await refreshBadge();
          respond({ ok: true });
          return;
        }
        case "clear-read": {
          const n = await store.clearRead();
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case "clear-all-replies": {
          const n = await store.clearAllReplies();
          await refreshBadge();
          respond({ ok: true, data: { dropped: n } });
          return;
        }
        case "get-storage-stats": {
          const [replies, monitored, bytes] = await Promise.all([
            store.getReplies(),
            store.getMonitored(),
            store.getBytesInUse()
          ]);
          const all = Object.values(replies);
          respond({ ok: true, data: {
            replyCount: all.length,
            unreadCount: all.filter((r) => !r.read).length,
            monitoredCount: Object.keys(monitored).length,
            bytesInUse: bytes
          } });
          return;
        }
        case "inspect": {
          const all = await chrome.storage.local.get(null);
          log("index.inspect", `config=${JSON.stringify(all.config)}`);
          log("index.inspect", `timestamps lastTick=${all.lastTick} lastUserSync=${all.lastUserSync} lastDailyScan=${all.lastDailyScan} lastWeeklyScan=${all.lastWeeklyScan}`);
          const monitored = all.monitored ?? {};
          const mArr = Object.values(monitored);
          log("index.inspect", `monitored count=${mArr.length}`);
          for (const m of mArr) {
            const ageDays = ((Date.now() - m.submittedAt) / 864e5).toFixed(2);
            log("index.inspect.monitored", `id=${m.id} type=${m.type} ageDays=${ageDays} lastDescendants=${m.lastDescendants} lastKids=${JSON.stringify(m.lastKids)}`);
          }
          const replies = all.replies ?? {};
          const rArr = Object.values(replies);
          const unread = rArr.filter((r) => !r.read).length;
          log("index.inspect", `replies count=${rArr.length} unread=${unread}`);
          const alarms = await chrome.alarms.getAll();
          for (const a of alarms) {
            log("index.inspect.alarm", `name=${a.name} scheduledTime=${a.scheduledTime} nextInMs=${a.scheduledTime - Date.now()} periodMin=${a.periodInMinutes}`);
          }
          respond({ ok: true, data: {
            config: all.config,
            monitored: mArr,
            replyCount: rArr.length,
            unreadCount: unread,
            timestamps: {
              lastTick: all.lastTick ?? null,
              lastUserSync: all.lastUserSync ?? null,
              lastDailyScan: all.lastDailyScan ?? null,
              lastWeeklyScan: all.lastWeeklyScan ?? null
            },
            alarms
          } });
          return;
        }
        default: {
          const kind = message.kind;
          log("index.onMessage", `UNKNOWN kind=${JSON.stringify(kind)}`);
          respond({ ok: false, error: `unknown message kind: ${String(kind)}` });
          return;
        }
      }
    } catch (err) {
      logErr("index.onMessage", `kind=${message.kind}`);
      respond({ ok: false, error: err.message });
    }
  })();
  return true;
});
void ensureAlarms();
void refreshBadge();
globalThis.__hnswered = {
  store,
  runTick,
  runRefresh,
  runDaily,
  runWeekly,
  refreshBadge,
  ensureAlarms
};
//# sourceMappingURL=background.js.map
