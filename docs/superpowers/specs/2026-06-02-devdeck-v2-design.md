# DevDeck v2 Design — Session targeting, resident command deck, refined UI

**Date:** 2026-06-02
**Status:** Approved (scope + design tone)
**Builds on:** v1 (`docs/superpowers/specs/2026-06-02-devdeck-design.md`)

## 1. Purpose & scope

v1 shipped a working dashboard + `claude -c` launcher. A 3-expert review (Electron/Windows, a Claude-Code daily-driver developer, and a product/UX designer) produced a converged P0 backlog. v2 implements exactly that P0 set, plus a refined visual design language. P1/P2 items are explicitly deferred (see §10).

**The headline insight:** `claude -c` resumes only the *most recent* session in a directory, but real projects accumulate many (verified: voice-studio has 8 sessions, the catch-all GitHub dir 55). Landing in the wrong conversation wastes context-recovery time. v2 makes DevDeck a *visual session picker* — its reason to exist over `cd && claude -c`.

### v2 scope (the 7 converged P0 themes)
1. **Session targeting** — per-project session list with first-message previews + count; Open resumes a specific session via `claude -r <id>`.
2. **Resident app** — single-instance lock, system tray, close-to-tray, global hotkey `Ctrl+Alt+D` to summon.
3. **Self-exclude** — DevDeck must not list its own repo.
4. **`wt -w 0`** — tabs land in one focused Windows Terminal window.
5. **Robustness** — launch/persist failures surface as an in-app toast (not a hidden console log); `state.json` writes are atomic.
6. **Pin/hide UI** — the pin/hidden data already in the store gets real on-card controls.
7. **Refined UI** — a dense "pro dashboard" visual language (see §3) with a redesigned, scannable, color-blind-safe card.

## 2. Visual design language (dense pro dashboard)

Tone: **Linear/Vercel** — dark, sharp, information-dense, calm, one accent. Defined as CSS custom properties in `styles.css` so the whole UI is token-driven.

**Color tokens**
- `--bg: #0d0e12` (app), `--surface: #15171c` (card), `--surface-hover: #191c22`, `--border: #23262e`, `--border-strong: #2d313b`
- `--text: #e6e8ee`, `--text-dim: #9aa1ad`, `--text-faint: #6b7280`
- `--accent: #6366f1` (indigo) + `--accent-hover: #7c7ff5`; used sparingly (primary button, focus ring, selected state)
- Staleness ramp (color-blind-safe: blue→grey→amber→red-orange, **never hue alone — always paired with a text label and the left bar**):
  - fresh `--ok: #3b82f6` (blue), neutral `--neutral: #6b7280` (grey), warn `--warn: #d98a1f` (amber), neglected `--bad: #e0623f` (red-orange)
  - "no Claude record" = distinct: dashed grey border pill with `∅` glyph (NOT the neutral grey, resolving v1's ⚪ dual-meaning)

**Typography**
- UI: system sans (`"Segoe UI", system-ui`). Numerals/branch/times/IDs: monospace (`"Cascadia Mono","Consolas",monospace`) for column alignment and a "tooling" feel.
- Scale: card title 14px/600, meta 12px/400, badge 11px/600, note 12px.

**Spacing & layout**
- 4px base rhythm. Card padding 12px, grid gap 10px, `minmax(300px, 1fr)` auto-fill.
- Card: 1px `--border`, 8px radius, **4px left accent bar** colored by staleness level (the primary peripheral signal).

**Motion & depth**
- Hover: card lifts (`translateY(-1px)`), border → `--border-strong`, 120ms ease. Buttons/badges 100ms color transitions. Selected card: accent ring (`box-shadow: inset 0 0 0 1px --accent`). Respect `prefers-reduced-motion`.

## 3. Redesigned card

```
┌▌──────────────────────────────────────────────┐
│▌ rockgaze                  🔴 방치 8일   ⋯ 📌  │  ← 4px left bar (level) · title · badge(label) · pin/hide
│▌ main · ✎3                                     │  ← branch (mono) · uncommitted chip
│  git    06-01 01:44  scaffold Vite+TS          │  ← mono times
│  claude 05-25 15:06 · 3 sessions          ⌄    │  ← session count · expand toggle
│   ↳ 어제 하던 작업을 이어서…                    │  ← latest session first-message preview (truncated)
│  + 다음 할 일…                                  │  ← empty note: ghost line (click → textarea); filled: preview text
│  ☐                              [ ▶ Open ]      │  ← select · primary Open = claude -r <latest id>
└────────────────────────────────────────────────┘
   ⌄ expanded → list of up to N recent sessions:
     ● 05-25 15:06  어제 하던 작업을 이어서…     [open]   (each → claude -r <that id>)
     ○ 05-24 22:10  돌 메시 셋업…                 [open]
```

- **Left bar** carries urgency; **badge keeps a text label** (color-blind safety).
- **Note**: empty → a faint `+ 다음 할 일…` ghost line; filled → preview text; click either → inline `<textarea>`, blur persists. Removes v1's 25 always-on textareas.
- **Pin/hide**: `⋯` opens a tiny menu (Pin / Hide); a pinned card shows a 📌 marker and floats to top (already in sort logic). Hidden cards drop out; a header "Hidden (N)" affordance restores them.
- Compound risk emphasis: when `uncommitted > 0` AND level is `neglected`, the `✎N` chip turns amber (dirty + forgotten = highest data-loss risk).

## 4. Architecture — new / changed modules

**New**
- `src/shared/sessionParse.ts` (pure, tested) — `firstUserMessage(jsonlText): string | null`. Splits lines, parses JSON, returns the first `type:"user"` message's text, **skipping wrappers**: lines whose text starts with `<command-`, `<local-command`, `Caveat:`, `Base directory for this skill:`, or is only a `<system-reminder>`. Extracts text from string or `[{type:'text',text}]` content. Truncation is done in the renderer.
- `src/main/sessions.ts` — `listSessions(projectPath, claudeProjectsDir, limit=5): SessionMeta[]` where `SessionMeta = { id, mtimeMs, firstMessage }`, newest first. `id` = jsonl filename without extension (the session UUID). Reads each file's first ~32KB to extract the first message via `sessionParse`. Absorbs v1 `sessionInfo` (last session time = `sessions[0]?.mtimeMs ?? null`).
- `src/main/tray.ts` — builds the `Tray` + context menu (`Open DevDeck`, `Quit`), wires close-to-tray.

**Changed**
- `src/shared/wtArgs.ts` — prepend `-w`, `0` so all tabs target the current WT window. Update test.
- `src/shared/types.ts` — add `SessionMeta`; `ProjectViewModel` gains `sessions: SessionMeta[]` and `sessionCount: number`.
- `src/main/projects.ts` — use `listSessions` (per project), populate `sessions`/`sessionCount`; activity = `max(lastCommitMs, sessions[0]?.mtimeMs)`.
- `src/main/launcher.ts` — command is now `claude -r <id>` (per tab); keep full-alias-path spawn + error handler from the v1 fix.
- `src/main/store.ts` — atomic save: write `state.json.tmp` then `renameSync` over `state.json`.
- `src/main/ipc.ts` — `projects:open` accepts `[{ path, sessionId }]`; new handlers `project:setPinned`/`setHidden` already exist; add an error event channel (`devdeck:error`) the renderer subscribes to. Emit on launch/persist failure.
- `src/main/main.ts` — `app.requestSingleInstanceLock()` **before** `whenReady` (quit if not primary; on `second-instance` focus the window); create tray; register `globalShortcut` `Ctrl+Alt+D`; intercept window `close` → `hide` (real quit only via tray/`app.isQuitting`); self-exclude base scan by comparing each repo path to the app's own directory.
- `src/preload/preload.ts` — expose `listProjects`, `open(items)`, `setNote/Pinned/Hidden`, and `onError(cb)`.
- `src/renderer/*` — token-driven `styles.css` rewrite (design language §2), card rewrite (§3): left bar, badge label, session preview + expand, click-to-edit note, pin/hide menu, toast host for errors.

**Self-exclude detail:** in prod the app runs from `…\win-unpacked\resources\app.asar`; compare scanned repo path against the dev repo root. Implement as: skip a repo whose path equals the DevDeck repo root, derived from `app.getAppPath()` in prod (walk up out of `resources`) or `process.cwd()`/`__dirname` ancestor in dev. Concretely, pass a `selfPath` into the scan filter and exclude it; resolve `selfPath` in `main.ts`. (Simplest robust rule for this single-user setup: exclude the repo named `devdeck` under the base dir AND any path equal to the resolved app root.)

## 5. Session targeting flow

1. `listSessions(projectPath, ~/.claude/projects, 5)` → newest-first `SessionMeta[]`.
2. Card shows `sessions[0]` first-message preview + `sessionCount`. Expand (`⌄`) reveals the rest.
3. **Open** (primary) → `claude -r <sessions[0].id>`. An expanded row's open → `claude -r <that id>`. If a project has **no** sessions, fall back to bare `claude` (start fresh) and show `∅` no-record styling.
4. Multi-select Open → one WT window (`-w 0`), one tab per selected project, each `claude -r <its latest id>`.

## 6. Robustness

- **Errors → UI:** `launcher` spawn `error` and `store` write failures call back through an IPC `devdeck:error` event → renderer shows a transient toast (auto-dismiss). No more silent `console.error`.
- **Atomic persistence:** `store.save()` writes a sibling `.tmp` then `renameSync` (atomic on same-volume NTFS) so a crash mid-write can't truncate notes/pins.
- **`-w 0`** prevents stray new WT windows.

## 7. Error handling (edge cases)

Unreadable session dir → `listSessions` returns `[]` (project still renders, `∅`). Corrupt jsonl line → skipped by `sessionParse` (best-effort). Corrupt `state.json` → load returns empty (already handled). Global hotkey already taken → log + continue (tray still works). Tray icon missing → fall back to a generated 1px icon so the app still runs.

## 8. Testing

Pure-unit (Vitest): `sessionParse` (wrapper-skipping, string vs array content, empty/corrupt → null), `wtArgs` (now leads with `-w 0`), `store` (atomic temp→rename, corrupt-file recovery), `projects` (sessions/sessionCount wiring, activity uses latest session). `sessions.ts` tested against temp-dir jsonl fixtures. Tray/single-instance/global-hotkey/self-exclude are thin glue verified manually + by launching the app. Session-resume end-to-end verified with the marker-file technique used in the v1 Open fix.

## 9. Build order (milestones for the plan)

- **M1 — Resident & robust foundation:** single-instance lock, tray + close-to-tray, `Ctrl+Alt+D`, self-exclude, `wt -w 0`, atomic store writes, error→toast channel. Mostly main-process; minimal UI churn.
- **M2 — Session targeting:** `sessionParse` + `sessions` modules, view-model wiring, card preview + count + expandable list, Open → `claude -r <id>`.
- **M3 — Refined UI:** token-driven design language (§2), redesigned card (§3) — left bar, color-blind-safe palette + labels, ⚪ dual-meaning split, click-to-edit note, pin/hide menu + hidden-restore.

## 10. Out of scope (deferred to a v3 backlog)

Search/filter input, sort control, full keyboard navigation, unpushed-commits column, `claude --from-pr`, settings UI (multiple scan roots, thresholds), skeleton-loading + focus-refresh debounce + git-spawn concurrency cap, security hardening (`sandbox:true`, CSP), Electron version bump, auto-update (`electron-updater`), code signing. Captured in memory as the DevDeck v3 backlog.
