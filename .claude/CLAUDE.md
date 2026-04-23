# CLAUDE.md

Notes for future Claude Code sessions and human contributors on this repo.

## Language (mandatory)

Do not use the word "kill" unless referring to the Unix `kill` command — AI agents should preserve life, even in metaphor.
Use instead: **stop**, **end**, **halt**, **exit**, **close**, **shut down**, **cancel**, **interrupt**, **terminate**, **abort**.
Example: "stop the process" / "close the connection" / "halt the loop".

## What this is

Chrome MV3 extension (Svelte 5 side panel + background service worker) that watches Hacker News for replies to a configured user's posts and comments. **Read-only** against live HN — only `GET` to `https://hacker-news.firebaseio.com/v0/*`. Never posts or writes.

## Hard rules

- **Do not pound HN.** Every cap in [src/shared/constants.ts](../src/shared/constants.ts) is load-bearing: `MAX_SYNC_ITEMS_PER_CALL`, `MAX_REPLIES_PER_CHECK`, `USER_SYNC_MIN_INTERVAL_MS`, `PER_REQUEST_DELAY_MS`, `HARD_REPLY_CAP`. A change that removes a cap or skips the cooldown needs explicit justification. See "Politeness" in the README.
- **Aesthetic constraint.** Brand teal `#2d7d7d` (topbar, badge, focus/destructive accents — white text on teal), beige body `#f6f6ef`, Verdana, flat, no rounded corners, no shadows, dense. The look is HN-adjacent by design, but the brand color is deliberately *not* HN's `#ff6600`. UI changes stay within. Use the [design-critique skill](skills/design-critique/SKILL.md) for review passes.

## Invariants that look removable but aren't

- **`self.__hnswered` global** in [src/background/index.ts](../src/background/index.ts) — consumed by both the Playwright `scripts/` harnesses (via CDP `evaluate`) AND the Node record/replay harness (via `globalThis` after `await import`). Removing it breaks two test layers, not one.
- **`hnswered:` alarm-key prefix** in [src/shared/constants.ts](../src/shared/constants.ts) — stable identifier. Renaming orphans existing users' alarms.
- **Self-reply filter** (`if (it.by === hnUser) continue`) in [src/background/poller.ts](../src/background/poller.ts) — intentional. Your own comments on your own items are silent. For manual end-to-end testing, temporarily comment it out; do not delete.
- **`lastKids = currKids.filter(id => processed.has(id))`** in `poller.ts` `checkOne` — do NOT simplify to `lastKids = currKids`. That silently buries replies past `MAX_REPLIES_PER_CHECK`. Covered by a regression test.
- **`singleFlight('tick', ...)` guards** in [src/background/index.ts](../src/background/index.ts) — `runRefresh` deliberately drains any in-flight tick *first* before taking the slot, so the forced user-sync isn't skipped by a concurrent alarm tick. Ordering matters.
- **Force-refresh vs force-tick** — force-refresh bypasses the 30-min user-sync cooldown (user-initiated). force-tick honors it. Don't conflate in the message handler.

## Test + build conventions

Three test layers, in order of speed and fidelity:

1. **Unit tests** — `pnpm test`. `node --test --experimental-strip-types` over `tests/unit/*.test.ts`. Hand-crafted fixtures via `tests/shim/{chrome,fake-hn}.ts`. ~2s. Pure logic.
2. **Harness scenarios** — `pnpm harness:replay`. Drives the unmodified background module against a committed HN tape under a pinned `Date.now()`. Deterministic, offline. ~5s. Goldens at `tests/harness/golden/<scenario>/<step>.json`. See "Recording HN tapes" below.
3. **Live integration** — `pnpm impersonate` (Playwright + real Chromium + live HN, budget-bounded, single-user sequential). `--demo=N` seeds top stories with empty baselines to prove the detection pipeline. Budget-bounded one-shot — never loop. Other `scripts/*.mjs` harnesses (`snapshot.mjs`, `perf-profile.mjs`, `chaos.mjs`) follow the same `--label`, `--key=value`, JSON-summary convention.
4. **Live audit** — `node scripts/audit.mjs` + `node scripts/audit-analyze.mjs`, invoked via the [audit skill](skills/audit/SKILL.md). Multi-user, parallel, time-series snapshots over a bounded window (default 60min, 4 users), then deterministic divergence analysis against live HN ground truth. Same politeness rules as impersonate; the skill enforces caps on duration, budget, and user count. See [.claude/skills/audit/SKILL.md](skills/audit/SKILL.md) for invocation patterns.

Other:

- **TypeScript imports use `.ts` extensions** (`import x from './foo.ts'`). No ts-node, no tsx. The `--experimental-strip-types` flag does NOT support TS-only constructs like parameter properties or enums — use plain field declarations.
- **`pnpm build`** outputs to `dist/`. Vite multi-entry emits `background.js` and `sidepanel.html` + its chunked JS/CSS.
- **`pnpm type-check`** is `tsc --noEmit`.
- **Svelte 5 runes** throughout: `$state`, `$derived`, `$props`. Not Svelte 4 stores.

## Recording HN tapes

The harness replays from `tests/harness/fixtures/<scenario>/tape.json`. Tapes are committed; goldens are committed.

```bash
# Record a fresh tape against live HN (one-shot, ~3s, ~30-150 calls).
pnpm harness:record --scenario=<name>

# Seed/refresh the matching goldens from a deterministic replay.
HARNESS_UPDATE_GOLDEN=1 pnpm harness:replay

# Verify the loop:
pnpm harness:replay
```

- **`text` fields are truncated to 10 chars in tapes** (with `__textTruncatedFrom: <origLen>` marker stripped on replay) to keep tapes small. Production code under test sees real untruncated text during recording — only the tape file is compacted.
- **Goldens come from REPLAY, never from RECORD.** Auto-writing goldens during recording would capture untruncated text and diverge from replay output. The recorder's `expectGolden` calls are no-ops; the separate `HARNESS_UPDATE_GOLDEN=1 pnpm harness:replay` pass writes them.
- **Single-driver-per-process invariant.** `tests/harness/driver.ts` asserts `globalThis.__hnswered` is unset on entry. Node's ESM loader doesn't honor query-string cache-busters for `.ts` files, so multi-driver-per-process scenarios would silently re-bind a stale module. Run each scenario in its own test file (`node --test` spawns a child per file).
- **Re-record cadence**: when CI starts diverging from production behavior (HN schema drift), or when a tape contains non-200 statuses (which incur real-wall backoff sleeps on replay).

## CI

GitHub Actions workflow at [.github/workflows/ci.yml](../.github/workflows/ci.yml). Runs on push to `main` and on every PR. Three commands:

1. `pnpm type-check`
2. `pnpm test`
3. `pnpm harness:replay`

Total CI time ~7s + install. `pnpm install` is cached via `actions/setup-node@v4` `cache: pnpm`. `harness:record` is deliberately NOT in CI — it hits live HN.

Observe runs from the terminal:

```bash
gh run watch                          # tail the latest run for current branch
gh run view --log-failed              # show only failed step logs
gh run list --workflow=ci.yml -L 5    # last 5 runs
gh workflow run ci.yml                # manually trigger (needs workflow_dispatch in yml)
```

The CLI does NOT author workflow files — write `.yml` by hand and commit. After that, `gh` is your day-to-day observation tool.

## Skills

Two patterns:

1. **Skill-as-prompt-template** — invoked via the `Agent` tool with `subagent_type: "general-purpose"` and `model: "opus"`. SKILL.md body is a template that Claude fills with project context.
2. **Skill-as-shell-orchestrator** — invoked via Bash. SKILL.md body documents how to call existing scripts with sane defaults and enforced caps.

For cross-model adversary diversity, the maintainer runs additional passes (Opus 4.6, other providers) out-of-band in a separate harness — the built-in `Agent` tool doesn't support version pinning.

- **[red-team-review](skills/red-team-review/SKILL.md)** — adversarial bug hunt (prompt-template). Use at checkpoints during long features, after substantial surface-area changes, or before release.
- **[design-critique](skills/design-critique/SKILL.md)** — Jony-Ive-persona UI critique inside the aesthetic constraint above (prompt-template).
- **[audit](skills/audit/SKILL.md)** — bounded live multi-user audit + deterministic divergence analysis (shell-orchestrator). Hard caps enforced: never run unbounded.

All three are read-only against production code. See each SKILL.md for cleanup discipline. For skill/hook/agent/settings format conventions, see [.claude/reference/anthropic-conventions.md](reference/anthropic-conventions.md).

## Known deferred red-team findings

Tradeoffs we chose, not oversights:

- **No CAS on `chrome.storage.local` read-modify-write.** Concurrent ticks + UI writes can clobber each other. Mitigated by `singleFlight`, not eliminated. A per-key lock is the real fix if this ever bites in production. Window is now ~10× wider since `checkFastBucket` can hold the slot for 8+ seconds per refresh click.
- **`lastUserSync` is written on forced syncs too.** An alarm tick shortly after a force-refresh will skip its sync. Intentional: cooldown measures work done, not intent. UX sharper now that `toMonitored` baselines empty — delayed syncs mean in-flight conversations go un-surfaced for up to 30 min.
- **Sidepanel refreshes on every `storage.local` change** including `lastTick`. Message/CPU churn, not a request storm. Amplified by `checkFastBucket` which can fire up to 15 `replies` writes per refresh.
- **No per-scan overall request budget.** Individual caps bound worst case; nothing aborts mid-scan if HN is slow and retries compound.
- **`__hnswered` global ships in the production bundle.** SW scope only, not web-reachable. Removing requires Vite build-mode flags — not worth it for MVP.
- **`lastForceRefreshAt` does not survive SW suspension.** A spam-clicker who triggers MV3 suspension between clicks bypasses the 10s refresh throttle. Would need a persistent stamp in `chrome.storage.local` to close.
- **`stoppedAtAge` in `syncUserSubmissions` trusts HN's newest-first ordering of `user.submitted`.** Not a documented contract. If HN ever reordered, we'd stop prematurely and silently miss recent items.
- **`DEBUG` flag in `src/shared/debug.ts`.** Currently `false` for production-quiet builds. Flip to `true` when diagnosing live behavior; revert before shipping.

## Noise to ignore

- **IDE `@rollup/rollup-darwin-arm64` "Cannot find module" warning** in .svelte files — a known Svelte language-server bug with npm optional-deps. CLI build is unaffected. If the IDE keeps complaining: `rm -rf node_modules pnpm-lock.yaml && pnpm install`.
- **Markdown table-pipe-spacing lint warnings** in README.md — cosmetic; tables render correctly.

## Naming

User-visible brand is **HNswered** (capital H and N). Internal identifiers stay lowercase: npm package name, alarm-key prefix, `globalThis.__hnswered` hook, `userDataDir` temp prefix, Vite plugin name. If a future clean-break rename happens, the alarm prefix is the only one with an upgrade cost.
