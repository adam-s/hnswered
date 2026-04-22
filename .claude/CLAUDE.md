# CLAUDE.md

Notes for future Claude Code sessions and human contributors on this repo.

## Language (mandatory)

Do not use the word "kill" unless referring to the Unix `kill` command — AI agents should preserve life, even in metaphor.
Use instead: **stop**, **end**, **halt**, **exit**, **close**, **shut down**, **cancel**, **interrupt**, **terminate**, **abort**.
Example: "stop the process" / "close the connection" / "halt the loop" — not "kill the process".

## What this is

Chrome MV3 extension (Svelte 5 side panel + background service worker) that watches Hacker News for replies to a configured user's posts and comments. **Read-only** against live HN — only `GET` to `https://hacker-news.firebaseio.com/v0/*`. Never posts or writes.

## Hard rules

- **Do not pound HN.** Every cap in [src/shared/constants.ts](../src/shared/constants.ts) is load-bearing: `MAX_SYNC_ITEMS_PER_CALL`, `MAX_REPLIES_PER_CHECK`, `USER_SYNC_MIN_INTERVAL_MS`, `PER_REQUEST_DELAY_MS`, `HARD_REPLY_CAP`. A change that removes a cap or skips the cooldown needs explicit justification. See "Politeness" in the README.
- **Aesthetic constraint.** Brand teal `#2d7d7d` (topbar, badge, focus/destructive accents — white text on teal), beige body `#f6f6ef`, Verdana, flat, no rounded corners, no shadows, dense. The look is HN-adjacent by design, but the brand color is deliberately *not* HN's `#ff6600`. UI changes stay within. Use the [design-critique skill](skills/design-critique/SKILL.md) for review passes.

## Invariants that look removable but aren't

- **`self.__hnswered` global** in [src/background/index.ts](../src/background/index.ts) — test-harness hook that the `scripts/` harnesses reach into via CDP. Don't delete in "cleanup" passes.
- **`hnswered:` alarm-key prefix** in [src/shared/constants.ts](../src/shared/constants.ts) — stable identifier. Renaming orphans existing users' alarms.
- **Self-reply filter** (`if (it.by === hnUser) continue`) in [src/background/poller.ts](../src/background/poller.ts) — intentional. Your own comments on your own items are silent. For manual end-to-end testing, temporarily comment it out; do not delete.
- **`lastKids = currKids.filter(id => processed.has(id))`** in `poller.ts` `checkOne` — do NOT simplify to `lastKids = currKids`. That silently buries replies past `MAX_REPLIES_PER_CHECK`. Covered by a regression test.
- **`singleFlight('tick', ...)` guards** in [src/background/index.ts](../src/background/index.ts) — `runRefresh` deliberately drains any in-flight tick *first* before taking the slot, so the forced user-sync isn't skipped by a concurrent alarm tick. Ordering matters.
- **Force-refresh vs force-tick** — force-refresh bypasses the 30-min user-sync cooldown (user-initiated). force-tick honors it. Don't conflate in the message handler.

## Test + build conventions

- **TypeScript tests use `.ts` extensions in imports** (`import x from './foo.ts'`). `pnpm test` runs via `node --test --experimental-strip-types`. No ts-node, no tsx.
- **`pnpm build`** outputs to `dist/`. Vite multi-entry emits `background.js` and `sidepanel.html` + its chunked JS/CSS.
- **`pnpm type-check`** is `tsc --noEmit`.
- **Svelte 5 runes** throughout: `$state`, `$derived`, `$props`. Not Svelte 4 stores.
- **Playwright harnesses in `scripts/`** (`snapshot.mjs`, `perf-profile.mjs`, `impersonate.mjs`) use shared `scripts/lib/extension.mjs`. CLI convention: `--label`, `--key=value` args, JSON summary + PNGs under a labeled output directory. Keep new scripts consistent.
- **`impersonate` hits live HN** under a request budget (default 200). `--demo=N` is a read-only live integration smoke test that seeds top stories with empty baselines to prove the detection pipeline. Budget-bounded one-shot — never loop.

## Skills

Invoked via the `Agent` tool with `subagent_type: "general-purpose"` and `model: "opus"`. Each skill has a `SKILL.md` with a prompt template; fill the bracketed sections with real project context before invoking.

- **[red-team-review](skills/red-team-review/SKILL.md)** — adversarial bug hunt. Use at checkpoints during long features, after substantial surface-area changes, or before release.
- **[design-critique](skills/design-critique/SKILL.md)** — Jony-Ive-persona UI critique inside the aesthetic constraint above.

Both are read-only. See each SKILL.md for cleanup discipline.

## Known deferred red-team findings

Tradeoffs we chose, not oversights:

- **No CAS on `chrome.storage.local` read-modify-write.** Concurrent ticks + UI writes can clobber each other. Mitigated by `singleFlight`, not eliminated. A per-key lock is the real fix if this ever bites in production.
- **`lastUserSync` is written on forced syncs too.** An alarm tick shortly after a force-refresh will skip its sync. Intentional: cooldown measures work done, not intent.
- **Sidepanel refreshes on every `storage.local` change** including `lastTick`. Message/CPU churn, not a request storm. Worth debouncing eventually.
- **No per-scan overall request budget.** Individual caps bound worst case; nothing aborts mid-scan if HN is slow and retries compound.
- **`__hnswered` global ships in the production bundle.** SW scope only, not web-reachable. Removing requires Vite build-mode flags — not worth it for MVP.

## Noise to ignore

- **IDE `@rollup/rollup-darwin-arm64` "Cannot find module" warning** in .svelte files — a known Svelte language-server bug with npm optional-deps. CLI build is unaffected. If the IDE keeps complaining: `rm -rf node_modules pnpm-lock.yaml && pnpm install`.
- **Markdown table-pipe-spacing lint warnings** in README.md — cosmetic; tables render correctly.

## Naming

User-visible brand is **HNswered** (capital H and N). Internal identifiers stay lowercase: npm package name, alarm-key prefix, `globalThis.__hnswered` hook, `userDataDir` temp prefix, Vite plugin name. If a future clean-break rename happens, the alarm prefix is the only one with an upgrade cost.
