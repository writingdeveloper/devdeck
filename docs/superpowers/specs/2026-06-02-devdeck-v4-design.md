# DevDeck v4 Design — QA fixes + Settings + e2e QA harness

**Date:** 2026-06-02
**Status:** Approved (user authorized full autonomous implementation)
**Builds on:** v3 (`docs/superpowers/specs/2026-06-02-devdeck-v3-design.md`)

## 1. Purpose & scope

A 2026-standard AI-QA pass (Playwright `_electron` + injected axe-core + IPC checks + vision review of per-view × per-locale screenshots) surfaced a small set of real defects. v4 fixes them and ships the previously-stubbed **Settings** surface (the largest v4-backlog item), and commits the QA harness as a reusable e2e tool.

### QA findings driving v4 (evidence: `qa/shots/`, `qa/shots/_audit.json`)
- **[Major · i18n]** Staleness badge text is hardcoded Korean in `src/shared/staleness.ts` (`🟢 오늘`, `🔴 N일`, `⚪ 기록 없음`) and renders Korean on every card in en/ja/zh.
- **[Serious · a11y]** axe color-contrast violations (27 projects / 6 usage / 1 settings nodes): muted text (`--text-faint`) below WCAG AA 4.5:1.
- **[Minor · IA]** The global "Open selected" batch CTA shows in Usage/Settings views where it is meaningless (a Projects-only action).
- **[Minor · UX]** The Usage model-mix bar has no legend (color↔model only via hover title).
- **[Polish]** Settings is an empty "coming soon" stub.

Verified working (no fix): IPC surfaces (listProjects, language round-trip, usageReport shape, single-instance lock, onError→toast), 0 console/page errors, CJK rendering, responsive reflow, all non-badge i18n.

### v4 milestones
- **M1 — QA fixes:** badge i18n, a11y contrast, IA (contextual batch CTA), Usage legend.
- **M2 — Settings:** editable scan base directory (removes hardcoded `BASE_DIR`), editable staleness thresholds, language dropdown — persisted and applied.
- **M3 — QA harness:** commit `qa/` (screenshot + audit) as a reusable tool with `npm run qa` / `npm run qa:audit`.

## 2. M1 — QA fixes

### Badge i18n
`StaleInfo` changes from `{ level, badge: string }` to `{ level, ageDays: number | null }`. `classifyStaleness` returns the floored `ageDays` (null when no activity) and the level; it no longer formats text. The renderer composes the badge from a level→emoji map + i18n: `ageDays == null` (or no-record) → `tr('proj.no_record')`; else `${EMOJI[level]} ${ageDays < 1 ? tr('badge.today') : tr('badge.days', {n: ageDays})}`. New locale keys `badge.today` / `badge.days` in all 4 files. Emojis (🟢⚪🟡🔴) stay in the renderer (not translated); they reinforce the left-bar color for color-blind safety.

### a11y color-contrast
Raise `--text-faint` from `#6b7280` (~3.6:1 on `--surface`) to a value meeting WCAG AA ≥4.5:1 on both `--bg` and `--surface` (target ~`#8b93a1`). Re-run axe; iterate token values until projects/usage/settings report **0 serious color-contrast violations**.

### IA — contextual batch CTA
Move `#open-selected` out of the global `#topbar` into the `#view-projects` `.view-toolbar`, so it only appears in the Projects view. The global topbar keeps the app title + refresh.

### Usage legend
Under the model-mix share bar, render a compact legend: one row of `‹swatch› model · NN%` per model, colors matching the bar.

## 3. M2 — Settings

A real Settings view (replacing the stub) with three sections, each i18n-labeled, persisted in `state.json` `settings`, and applied live:

1. **Scan directory** — a text input prefilled with the effective base dir + a **Browse…** button (Electron `dialog.showOpenDialog({properties:['openDirectory']})` via IPC). Changing it re-scans. Removes the hardcoded `BASE_DIR` as the only source: effective base = `store.settings.baseDir ?? DEFAULT_BASE_DIR`.
2. **Staleness thresholds** — three number inputs (fresh / warn / neglected days), defaulting to 1/3/7. Persisted as `settings.thresholds`; `buildProjectList` uses them (passed through deps) instead of the hardcoded `DEFAULT_THRESHOLDS`.
3. **Language** — a `<select>` (ko/en/ja/zh) mirroring the globe; changing it persists + re-renders.

**Data flow:** `settings:get` returns `{ baseDir, thresholds, language }` (resolved with defaults). `settings:setBaseDir`, `settings:setThresholds`, `settings:setLanguage` (exists), `settings:pickFolder` (opens the OS dialog, returns a path or null). `projects:list` and `usage:report` compute the effective base dir from the store each call; `projects:list` passes the configured thresholds to `buildProjectList`. After any settings change the renderer reloads the active view.

### Store / types
`StateFile.settings` extends to `{ language?, baseDir?, thresholds?: StaleThresholds }`. New store methods `getBaseDir/setBaseDir`, `getThresholds/setThresholds`. `buildProjectList` deps gain `thresholds: StaleThresholds`.

## 4. M3 — QA harness as a tool

Commit `qa/screenshot.mjs` (per-view × per-locale screenshots + console capture) and `qa/audit.mjs` (injected-axe a11y + IPC surface checks). Add scripts: `"qa": "npm run build && node qa/screenshot.mjs"`, `"qa:audit": "npm run build && node qa/audit.mjs"`. `qa/shots/` is gitignored (generated). `playwright` + `axe-core` are dev deps (already installed; `@axe-core/playwright` is unused — the harness injects `axe-core.source` directly because Electron's CDP lacks `Target.createTarget`).

## 5. Architecture impact

- **Changed:** `src/shared/staleness.ts` (+test), `src/shared/types.ts` (StaleInfo, settings types), `src/main/projects.ts` (thresholds dep), `src/main/ipc.ts` (effective baseDir, settings channels, pickFolder), `src/main/store.ts` (baseDir/thresholds), `src/main/main.ts` (DEFAULT_BASE_DIR), `src/preload/preload.ts` + `src/renderer/global.d.ts` (settings API), `src/renderer/projectsView.ts` (badge compose, open-selected move), `src/renderer/usageView.ts` (legend), `src/renderer/index.html` (CTA move, settings markup), `src/renderer/styles.css` (token bump, legend, settings form), `src/renderer/main.ts` (settings wiring), `src/renderer/locales/*.json` (badge + settings keys).
- **New:** `src/renderer/settingsView.ts` (the Settings form).
- Tests: staleness (ageDays), projects (thresholds dep + badge-free stale), store (baseDir/thresholds round-trip). Vitest. Settings/dialog glue verified by the QA harness + manual launch.

## 6. Verification
Re-run the QA harness (`npm run qa` + `npm run qa:audit`) after implementation: confirm badges localized in all 4 locales (vision review of `projects-en/ja/zh`), axe color-contrast serious violations → 0, IPC still green, settings round-trip. Then repackage the `.exe`.

## 7. Out of scope (v5 backlog)
In-app project search/sort, full keyboard nav, unpushed-commits column, `claude --from-pr`, destructive session mgmt, real quota, auto-updating price table, per-day cost, security hardening (`sandbox`/CSP), Electron bump, auto-update, code signing, visual-regression baselines in CI.
