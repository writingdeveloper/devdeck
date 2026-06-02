# DevDeck — Project Command Deck (v1 Design)

**Date:** 2026-06-02
**Status:** Approved (v1 scope)
**Working name:** DevDeck (changeable)

## 1. Purpose

A desktop app that gives a single at-a-glance view of every project the user is
juggling — its git state, how long it has sat untouched, and a free-text "what's
next" note — and lets the user resume that project's Claude Code session
(`claude -c`) in one click.

Development itself happens entirely in Claude Code. DevDeck is **control +
entry-point + memory only**. It writes no project code and edits no files inside
the projects it tracks.

### Problems it solves
1. **Session continuity** — resume the right Claude Code conversation per project
   the next day, instead of losing context across reboots / unreliable memory.
2. **Concurrent projects get forgotten** — surface neglected projects so they
   are not abandoned.
3. **"What was I doing?"** — an app-owned, reboot-proof note per project.

## 2. Architecture (Electron)

### Main process (Node) — five single-purpose modules
- **scanner** — collect folders under the base dir (`C:\Users\SIHYEONG\Documents\GitHub`)
  that contain a `.git` directory. Exclude non-projects (`__pycache__`, `.claude`,
  `.pytest_cache`, dotfolders).
- **gitInfo** — per repo, run in parallel:
  - branch: `git -C <dir> rev-parse --abbrev-ref HEAD`
  - last commit: `git -C <dir> log -1 --format=%ct|%s`
  - uncommitted count: `git -C <dir> status --porcelain` (line count)
- **sessionInfo** — encode the repo's absolute path to Claude's session-dir name
  (replace `:` and `\` with `-`, e.g. `C:\Users\SIHYEONG\Documents\GitHub\rockgaze`
  -> `C--Users-SIHYEONG-Documents-GitHub-rockgaze`), then read the newest
  `*.jsonl` mtime under `~/.claude/projects/<encoded>/` as the **last Claude
  session time**.
- **store** — app-owned JSON at `app.getPath('userData')/state.json`. Persists
  per-project note, pinned, hidden, optional per-project stale threshold, and
  lastOpened. Survives reboot; independent of Claude memory.
- **launcher** — build `wt.exe` args and spawn. Single or multi-select opens one
  Windows Terminal window with N tabs; each tab runs `pwsh -NoExit -Command "claude -c"`
  in the project dir. Reuses the resolved-`wt.exe`-path + pwsh/powershell fallback
  logic from `open-night-projects.ps1`.

IPC: main exposes these to the renderer via a `contextBridge` preload (no direct
Node access in the renderer).

### Renderer (UI)
A dashboard of project cards.

## 3. Project card contents

```
┌─ rockgaze            🟢 today ─────────────┐
│ main · ✎3 uncommitted                      │
│ git    01:44  "scaffold Vite+TS+Three.js"  │
│ claude 15:06 (today)                       │
│ ✎ next: 아침에 Task1(돌 메시) 구현   ← edit│
│ ☐ select            [ Open ▶ ]             │
└────────────────────────────────────────────┘
```

- **Staleness badge** — `activity = max(last commit time, last session time)`.
  Thresholds (default, configurable): `<1d` 🟢 / `1–3d` neutral / `3–7d` 🟡 warn /
  `>7d` 🔴 neglected.
- **next note** — inline editable; writes to `store` immediately. Directly
  addresses the "forgot what I was doing" problem.

## 4. Screen / data flow

1. On launch, main scans the base dir → list of repos.
2. For each repo in parallel: gitInfo + sessionInfo, merged with store
   (note/pinned/hidden).
3. Renderer renders cards sorted by `activity` descending. A "neglected" filter
   pulls 🔴 projects to the top so forgotten work is not buried.
4. Editing a note → IPC → JSON written immediately.
5. Check N cards + **Open** → main spawns one WT window with N tabs (`claude -c`).
6. Refresh on window focus + a manual refresh button.

## 5. Persistence (core requirement)

`userData/state.json`, keyed by absolute project path:

```json
{
  "projects": {
    "C:\\Users\\SIHYEONG\\Documents\\GitHub\\rockgaze": {
      "note": "아침에 Task1(돌 메시) 구현",
      "pinned": false,
      "hidden": false,
      "staleDays": null,
      "lastOpened": "2026-06-02T15:06:00Z"
    }
  },
  "settings": { "baseDir": "C:\\Users\\SIHYEONG\\Documents\\GitHub", "defaultStaleDays": 7 }
}
```

App-owned → survives reboot and session end. Does **not** depend on Claude memory
restore.

## 6. Error handling

- Repo with no commits → show "(no commits)".
- No Claude session dir → "Claude 기록 없음".
- A broken/unreadable repo is isolated per-repo; the rest of the list still renders.
- `wt.exe` resolved via `Get-Command` with a `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`
  fallback. `pwsh` preferred, `powershell` fallback.

## 7. Testing

Pure functions are unit-tested (Vitest):
- path → Claude session-dir encoder
- git output parsers (branch / `%ct|%s` / porcelain count)
- staleness classifier (activity + threshold → badge)
- `wt.exe` argument builder (N projects → argv with `;` separators)

The Electron shell and process spawning are kept thin and verified manually.

## 8. Scope

### In v1
Scan → per-project state (git + last Claude session + staleness) → editable
note → multi-select open with `claude -c`.

### Out of v1 (YAGNI; possible later)
- In-app code editing (development stays in Claude Code).
- Multi-machine / cloud sync.
- Parsing Claude `*.jsonl` bodies for a last-session **summary** (v1 shows time only).
- VS Code / editor integration (could be a secondary per-card button later).

## 9. Open / deferred details (decide at plan time)
- Renderer UI: vanilla TS vs a lightweight framework (lean vanilla unless a
  framework earns its weight).
- Packaging tool (electron-builder vs electron-forge) for the eventual `.exe`.
