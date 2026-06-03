# DevDeck v3 Design — Claude Code manager: nav rail, usage analytics, i18n

**Date:** 2026-06-02
**Status:** Approved (scope + IA + design decisions)
**Builds on:** v2 (`docs/superpowers/specs/2026-06-02-devdeck-v2-design.md`)

## 1. Purpose & scope

v2 made DevDeck a resident session-targeting command deck. v3 grows it toward a fuller "Claude Code manager" by adding **token/usage analytics** (read-only) and **internationalization**, and restructures the UI around a **left navigation rail** so it can hold a second major surface without overloading the project card. A second-pass UX review (built v2 UI) drives the IA and a set of P0 fixes folded into M1.

Three milestones (each independently shippable):
- **M1 — Nav rail + IA restructure + P0 UI fixes.** The structural keystone.
- **M2 — Usage analytics view** (read-only).
- **M3 — i18n** (ko/en/ja/zh), extracted over the stabilized M1+M2 UI.

## 2. Information architecture & navigation (UX review's top recommendation)

A left icon rail replaces header-only chrome. View switching is `display:none` toggling (no router/library).

```
┌─────────────────────────────────────────────┐
│ [D] DevDeck                 [↻]  [▶ 선택 열기]│  slim header: app id + global actions
├──────┬──────────────────────────────────────┤
│ 📁   │  ┌ view-local toolbar (Projects) ───┐ │  filters move out of the header
│ 📊   │  │ [방치만] [🙈 숨김 N] 검색…        │ │
│ ⚙   │  └──────────────────────────────────┘ │
│      │  [ card grid … ]                      │
│ 🌐   │                                       │  globe = language switcher (rail footer)
└──────┴──────────────────────────────────────┘
```

- Rail: 48px icon-only, labels on hover; items **Projects** (default), **Usage** (M2), **Settings** (scan roots / thresholds / language). Globe pinned at the rail footer, reachable from every view.
- Header slims to app wordmark + global refresh + batch-open. The Projects view-local toolbar holds neglected-only, show-hidden(count), and search (search itself is still v4-deferred unless trivial; the toolbar is the home for it).
- Active view's rail icon is highlighted (accent). The active state of filters is visibly marked (P0 fix, §5).

## 3. Usage analytics (M2, read-only)

### Data source (verified)
Every assistant line in a session `.jsonl` carries `message.usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use.{web_search_requests,web_fetch_requests}`, and `message.model`. There is **no cost field** — cost is computed.

### Aggregation
`usageScan` walks `~/.claude/projects/<encoded>/*.jsonl` for in-scope projects, summing per session, per project, and globally, grouped by model. It also bins per-day totals (by message timestamp where present, else file mtime) for the trend chart. Reading is best-effort per file (skip unparseable lines), and bounded (stream/limit large files) so a full scan stays responsive.

### Cost — clearly an ESTIMATE
A `MODEL_PRICING` table (per-MTok: input, output, cache-write-5m, cache-write-1h, cache-read) computes an **estimated API-equivalent cost**. Values come from Anthropic's published pricing and are kept in one editable table; unknown models contribute tokens but **no cost** (and are flagged). The UI labels every cost as an estimate ("추정 API 환산 비용 / estimated API-equivalent") because subscription (Claude Code) users are billed a flat subscription, not per token. Cache-read and cache-write use their respective multipliers, not the input rate.

### Usage view
```
Usage   [7d │ 30d │ 90d │ all]                    추정 비용 ~$4.21
┌ global summary ───────────────────────────────────────────┐
│ in 1.2M · out 340K · cache 4.1M · web 23 · sessions 47     │
│ model mix  [opus ▓▓▓▓ 80%  sonnet ▓ 20%]                   │
└────────────────────────────────────────────────────────────┘
┌ daily trend (hand-rolled SVG bars, no chart lib) ─ ▁▂▅▇▃▂▁ ┐
┌ per-project table (sortable by any column) ────────────────┐
│ project    sessions  in    out   cache  est.cost   ▼        │
│ rockgaze   12        420K  90K   1.1M   ~$1.20              │
└────────────────────────────────────────────────────────────┘
```
Charts are hand-rolled SVG (bars + a model-mix bar/donut) — no chart dependency, consistent with the no-bundler build.

### On-card micro-summary (Projects view)
A single muted line on each card: `claude 06-01 22:10 · 3 sessions · ~$0.42`. The card stays a launcher/triage tool; full breakdowns live in the Usage view.

## 4. Internationalization (M3)

- Key-based strings via `t('card.open')`; locale dictionaries `src/renderer/locales/{ko,en,ja,zh}.json` (flat dotted keys). A tiny `i18n` module loads the active locale, resolves keys with `{var}` interpolation, and falls back to `en` then the key itself on a miss.
- **Default** = system locale (`app.getLocale()` → matched to a supported language; else `en`). Manual override via the rail-footer globe, persisted in `state.json` `settings.language`.
- Localized formatting: dates/numbers via `Intl.DateTimeFormat`/`Intl.NumberFormat` with the active locale (removes the hardcoded `ko-KR` in `fmtTime`).
- M3 extracts ALL UI strings (existing v2 + M1 + M2) to keys; `ko` is authoritative, `en`/`ja`/`zh` translated. Adding a language later = one more JSON file.

## 5. P0 UI fixes (folded into M1, from the second-pass review)

- **Sessions collapsed by default:** the card shows `claude <time> · N sessions` and the cost line; the `↳ firstMessage` preview + session list appear only when expanded (prevents 50+ always-on previews across 25 cards).
- **Note discoverability:** empty-note ghost text uses `--text-dim` (not `--text-faint`) so it's visible.
- **Active filter state:** neglected-only and show-hidden show a clear active style (accent border/fill), not the browser default.
- **Pin/hide → `⋯` overflow menu** in the card head, reclaiming title width.
- **Disabled batch CTA:** "선택 열기" is dimmed/non-interactive when nothing is selected.
- **Loading skeleton:** replace the raw "로딩 중…" with shimmer placeholder cards.
- **Empty-state context:** distinguish "no neglected projects" from "no projects found".
- **Accessibility basics:** `role=list/listitem` on the grid + session list, `aria-label` on icon buttons, `aria-live="assertive"` on the toast host.
- **Hover calm:** drop the `translateY(-1px)` card lift (jittery at 25 cards); keep border/background hover.

## 6. Architecture — new / changed modules

**New (pure, tested):**
- `src/shared/usage.ts` — `sumUsage(records)` → token totals by category; `estimateCost(totals, model, pricing)`; `MODEL_PRICING` table.
- `src/shared/i18n.ts` — `makeTranslator(dict, fallback)` → `t(key, vars?)`; pure resolution + interpolation + fallback.

**New (main):**
- `src/main/usageScan.ts` — scan in-scope projects' jsonl, parse `usage` lines, aggregate per session/project/global + daily bins; returns a `UsageReport`.

**New (renderer):**
- `src/renderer/locales/{ko,en,ja,zh}.json`
- View modules split from the monolithic `renderer.ts`: `nav`, `projectsView`, `usageView`, `charts` (SVG helpers), `i18nRuntime` (loads dict, exposes `t`). All remain **non-module** plain scripts (no runtime `import`) loaded via ordered `<script>` tags, OR a single concatenated build step — decided in the plan. Types continue to derive from `Window['devdeck']`.

**Changed:**
- `src/shared/types.ts` — `UsageReport`, `ProjectUsage`, `UsageTotals`, `Language`; `ProjectViewModel` gains an optional `costEstimate` (for the on-card line).
- `src/main/ipc.ts` — `usage:report` channel (date-range arg); `settings:setLanguage` / include language in an existing settings channel.
- `src/main/store.ts` — `settings.language` persisted (atomic writes already in place).
- `src/main/main.ts` — pass `app.getLocale()` for default language; wire usage IPC.
- `src/main/projects.ts` — optionally attach a per-project cost estimate (cheap subset of usage) for the card line, or fetch lazily via `usage:report`.
- `index.html` — nav rail + view containers + view-local toolbar markup.

## 7. Testing

Pure Vitest: `usage` (token summation, cost math incl. cache multipliers, unknown-model → no cost, empty), `i18n` (key hit/miss/fallback chain, `{var}` interpolation), locale formatting helpers. `usageScan` against temp-dir jsonl fixtures with synthetic `usage` lines (per-project/global/daily aggregation). Views/charts/nav are thin glue verified by build + manual launch; the usage pipeline is checked end-to-end against the real `~/.claude/projects` data (aggregate sanity).

## 8. Build order (milestones for the plan)

- **M1 — Nav + IA + P0 fixes:** rail, view switching, view-local toolbar, the §5 fixes. Strings may stay inline (Korean) — M3 extracts them.
- **M2 — Usage analytics:** `usage` + `usageScan` + `usage:report` IPC + Usage view (summary, SVG trend, sortable per-project table, date-range presets) + on-card cost line + the cost-is-estimate labeling.
- **M3 — i18n:** `i18n` module + locale JSONs (ko/en/ja/zh) + extract all strings to keys + system-locale default + globe switcher + `Intl` formatting.

## 9. Out of scope (deferred to v4)

Destructive session management (delete/rename/prune jsonl), real rate-limit/quota (not in local data), account/billing integration, auto-updating the pricing table, full keyboard navigation (only aria basics in v3), in-app search beyond a simple name filter if trivial, charting libraries.
