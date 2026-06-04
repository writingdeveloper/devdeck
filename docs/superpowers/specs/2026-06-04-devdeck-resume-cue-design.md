# DevDeck — Session Resume Cue (auto-derived "next todo")

**Date:** 2026-06-04
**Status:** Approved (approach), pending implementation

## Problem

The per-card "next todo" note is DevDeck's most differentiated feature, but it is **manual entry only** — the user must type what they were doing in each project. They asked whether DevDeck can pull this from Claude Code automatically.

## Findings (what Claude Code actually stores)

Investigated the real data on this machine:

- **`~/.claude/todos/`** exists but is keyed by *session-id* (not project), and in practice is empty/stale here (3 files, all `[]`). Not a reliable source.
- **TodoWrite** tool calls: neither devdeck session used TodoWrite as a tool. No structured pending-todo list to harvest.
- **Session JSONL** (`~/.claude/projects/<encoded>/<id>.jsonl`) is the only rich, reliable source. DevDeck *already* reads these (`sessions.ts` extracts the **first** user message per session for previews).

**Conclusion:** We cannot *fetch* a clean todo — Claude Code does not persist one per project. We can *derive* a **resume cue** from the conversation: the **last genuine user message** of the most recent session ("where I left off"). It is short, in the user's own words, and reliably present.

## Decision

Offline, deterministic **resume cue**, shown **non-destructively** alongside the manual note. No network/LLM (preserves DevDeck's offline/private posture and `connect-src 'none'` CSP; an LLM call per project on an always-open deck is costly and leaks code/secrets). No speculative TodoWrite harvesting (no data to harvest) — but the data shape is future-proofed so it can be added later without UI churn.

## Components

### 1. Extraction — `src/shared/sessionParse.ts` (pure)
Add `lastUserMessage(jsonlText: string): string | null`, the tail-scanning mirror of the existing `firstUserMessage`. Iterates lines **from the end**, returns the first `type:'user'` entry with genuine text, reusing the existing `textOf` / `isWrapper` helpers (so tool-results, system-reminders, and slash-command wrappers are skipped). Returns `null` if none.

### 2. Tail read — `src/main/sessions.ts`
Session files can be tens of MB. Real-data check: the last user message sits **0.4–3.4 MB** from the end (a single autonomous turn after a "진행처리"-style prompt is itself multi-MB), so a fixed small tail misses almost everything. `lastUserMessageForSession(projectPath, sessionId, claudeProjectsDir): string | null` therefore scans the file **backward in 1 MB chunks**, decoding each contiguous byte range and dropping the leading partial line, and returns as soon as `lastUserMessage` finds a hit — capped at **8 MB** from the end (`TAIL_MAX`). Reads only as much as needed (early-exit), so most projects cost one chunk. Beyond the cap → `null` (graceful).

### 3. View model — `src/shared/types.ts` + `src/main/projects.ts`
```ts
export interface ResumeCue { kind: 'lastMessage'; text: string; }  // kind reserved for future 'todos'
// ProjectViewModel gains:
resumeCue: ResumeCue | null;
```
`buildProjectList` gains a dep `resumeCue(projectPath, sessionId): string | null`, called for the **newest session only** (`sessions[0]`); wraps the result as `{ kind: 'lastMessage', text }` or `null`. Wired in `ipc.ts` to `lastUserMessageForSession`. Type flows to the renderer via `ProjectViewModel` (no preload/global.d.ts change needed).

### 4. Renderer — `src/renderer/projectsView.ts` (`makeNote`)
The cue augments, never overwrites. Three states in the note slot:
- **Note present** → unchanged (`.note-preview`). Cue is **not** shown (the user's own intent wins; no clutter).
- **Note empty + cue exists** → ghost shows `↩ {prefix}: {truncated cue}` (`.note-ghost.has-cue`), `title` = full cue text, single-line (whitespace collapsed, ~60 chars). Click opens the editor **pre-filled with the full cue text** → user tweaks and blur-saves (adopt), or Escape/clear to dismiss. Nothing is persisted until the user actively adopts it.
- **Note empty + no cue** → unchanged generic ghost (`tr('proj.next_todo')`).

`showEdit(prefill?)` gains an optional prefill (defaults to `p.note`). Mirrors the existing click-div pattern (no a11y regression vs. current note ghosts).

### 5. i18n — `src/renderer/locales/{ko,en,ja,zh}.json`
One new key `proj.resume_prefix`: ko "이어가기" / en "Resume" / ja "再開" / zh "继续".

## Data flow
`ipc projects:list` → `buildProjectList` → for each project, newest session id → `lastUserMessageForSession` (tail read + `lastUserMessage`) → `resumeCue` on the view model → renderer `makeNote` shows it as a ghost when the note is empty.

## Edge cases
- No sessions → `resumeCue: null` → generic ghost.
- Newest session has only tool-results/wrappers/system-reminders → `null`.
- Cue text very long / multiline → collapsed + truncated for display; full text in `title`.
- Live session being written → trailing partial line unparseable → falls back to the previous complete line.

## Non-goals (YAGNI)
TodoWrite/`~/.claude/todos` harvesting (interface reserved via `kind`); LLM summarization (possible future per-card opt-in "✨ 요약"); multi-session aggregation; showing the cue when a note already exists.

## Testing
- `sessionParse.test.ts`: `lastUserMessage` — picks the last genuine user message; skips trailing tool-results/system-reminders/wrappers; tolerates invalid JSON lines; empty/none → `null`.
- `sessions.test.ts`: `lastUserMessageForSession` — reads tail of a temp session file; returns last user message; missing file → `null`.
- `projects.test.ts`: `buildProjectList` sets `resumeCue` from the dep for the newest session and `null` when the dep returns null / no sessions.
