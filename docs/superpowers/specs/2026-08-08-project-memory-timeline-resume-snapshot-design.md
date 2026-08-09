# Project Memory Timeline and Resume Snapshot Design

## Problem

DevDeck already shows the latest Git state, recent agent conversations, a resume cue, a project note,
and project tasks. These signals answer separate questions, but they do not yet answer the personal
workflow question that matters after a context switch: **what happened here, where did I stop, and
what should I do next?**

The current card cue is intentionally compact. It can repeat an old request after the work was
completed, it cannot explain newer commits or working-tree changes, and it provides no chronological
view across providers. Opening several old sessions to reconstruct context defeats DevDeck's role as
a lightweight project memory layer.

## Goals

- Reconstruct recent project activity from data DevDeck already owns or can read locally.
- Present a concise, deterministic resume snapshot before the user enters a project when requested.
- Combine Claude, Codex, and Antigravity history without merging or changing conversation ownership.
- Keep the existing primary **Open** action one-click; memory is an optional aid, not a mandatory gate.
- Keep the feature local-first, fast on large transcripts, and useful with no AI summarization enabled.
- Make every snapshot fact traceable to its source and degrade cleanly when a source is unavailable.

## Non-goals

- Replacing Git history, an issue tracker, or the agent transcript viewer.
- Persisting copies of complete transcripts or source files.
- Automatically editing notes, tasks, project files, or agent memory.
- Inferring whether a task is complete from agent prose.
- Adding task-to-session links, a global Focus Queue, project lifecycle states, command palette, or
  morning/evening briefs in this first implementation.
- Forcing an AI call when the memory view opens. Existing opt-in AI session summaries remain separate.

## Chosen Experience

Each project card and list row gains a **Memory** action. It opens a fixed overlay dialog for that
project. The existing provider-aware **Open** control remains unchanged and never opens the dialog
implicitly.

The dialog has two vertically scrollable sections:

1. **Resume snapshot** — the small set of facts needed to restart work now.
2. **Recent timeline** — interleaved local activity, newest first.

The header shows the project name, current branch, current staleness, a refresh action, and a close
action. The footer provides the same provider-aware Open/New-session control used elsewhere, so the
user can move directly from context to work without returning to the card.

Opening is asynchronous. The dialog appears immediately with a loading skeleton, remains dismissible,
and replaces each source independently as results arrive. Refresh re-reads all sources and preserves
the current scroll position when practical.

### Resume snapshot

The snapshot is a deterministic projection, not generated prose. It contains only meaningful rows:

- **Continue from**: the newest session's last genuine user message, including its provider mark and
  session timestamp. If unavailable, fall back to that session's first message; omit if neither exists.
- **Working tree**: branch, uncommitted-file count, and unpushed-commit count. A clean, fully pushed
  repository gets a compact "Clean" state rather than an empty section.
- **Latest change**: the newest commit subject and timestamp.
- **Next tasks**: at most three incomplete tasks, ordered overdue, today, upcoming due date, then
  creation time. Remaining task count is summarized.
- **Project note**: the current note, when non-empty.

Every row identifies its source through its label or provider mark. The snapshot does not claim that
the last user request is unfinished. The wording **Continue from** deliberately means "last known
conversation point," not "remaining work."

### Recent timeline

Version one interleaves these bounded event types:

| Event | Timestamp | Detail | Action |
| --- | --- | --- | --- |
| Agent session | session log mtime | provider, first request, latest user request when readable | Resume exact session |
| Git commit | author timestamp | abbreviated hash, subject | Copy hash |
| Task created | `createdAt` | task text, current done/open state and due date | Open task board filtered to project |
| Project opened | current `lastOpened` | most recent DevDeck open | None |

Notes are shown in the snapshot but not the timeline because the current store has no trustworthy
note timestamp or revision history. Task completion is also not emitted as a historical event because
`Todo` has no completion timestamp. This avoids manufacturing chronology from present state.

The first page contains at most 40 merged events, sourced from at most 20 commits, 10 sessions across
installed providers, all current tasks up to the existing 200-item store cap, and the single most
recent project-open event. This is intentionally a recent-memory surface; pagination and durable
activity journaling can be evaluated after real use.

Sessions with identical IDs from different providers remain distinct. Event identity includes the
provider. Selecting a session always resumes it through its owning provider.

## Shared Data Model

New shared types define the IPC contract:

```ts
type ProjectMemoryEvent =
  | { id: string; kind: 'session'; at: number; agentId: AgentId; sessionId: string;
      firstMessage: string | null; lastUserMessage: string | null }
  | { id: string; kind: 'commit'; at: number; hash: string; subject: string }
  | { id: string; kind: 'task-created'; at: number; todoId: string; text: string;
      done: boolean; due: string | null }
  | { id: string; kind: 'project-opened'; at: number };

interface ResumeSnapshot {
  continueFrom: { text: string; agentId: AgentId; sessionId: string; at: number } | null;
  git: { branch: string | null; uncommitted: number; ahead: number | null;
         latestCommit: { at: number; hash: string; subject: string } | null };
  nextTasks: Todo[];
  remainingTaskCount: number;
  note: string | null;
}

interface ProjectMemory {
  projectPath: string;
  generatedAt: number;
  snapshot: ResumeSnapshot;
  events: ProjectMemoryEvent[];
  partial: Array<'git' | 'sessions'>;
}
```

The exact implementation may factor repeated commit/session shapes, but it preserves this semantic
boundary. `partial` communicates source failures without turning the whole response into an error.

## Main-Process Architecture

A focused `projectMemory` service aggregates independent readers and exposes one pure merge/projection
function for unit testing. The IPC handler `project:memory(path)` performs the existing scanned-folder
allowlist check before any filesystem or Git access and returns a neutral empty result for disallowed
paths.

The service receives dependencies rather than importing global settings directly:

- current `StoreEntry`,
- recent commits reader,
- cross-provider session reader,
- provider-owned last-message reader, and
- current time.

Git receives one on-demand command using a delimiter-safe format for the latest 20 commits. It does
not add work to the deck's periodic refresh. Commit parsing is a pure shared helper; malformed records
are skipped rather than leaking raw command output.

Session discovery reuses `makeProjectSessionScan` and requests at most 10 aggregate sessions. Last-user
messages are read only when the Memory dialog is requested, with a small concurrency cap. Claude keeps
its existing backward tail scan and hard byte cap; Codex and Antigravity use their existing provider
readers. No transcript is copied into the store, and no full historical transcript is reparsed for
timeline construction.

The finished `ProjectMemory` response is cached in memory by normalized project path for 15 seconds.
Concurrent requests share the same promise. Manual refresh passes a `fresh` flag that invalidates only
that project's cache entry. Nothing new is written to `state.json` in version one.

## Renderer Architecture

A new `projectMemoryModal` module owns dialog lifecycle, focus trap, Escape/outside-click dismissal,
loading, retry, refresh, source warnings, and focus restoration. It receives the selected
`ProjectViewModel` and callbacks for exact-session resume, task-board navigation, and provider-aware
project opening; it does not duplicate launch routing.

Snapshot and event rendering are factored into small pure view-model helpers so ordering, fallback
wording, truncation, and empty states can be tested without Electron. User text is always assigned via
`textContent`; transcript, note, task, branch, and commit values are never inserted as HTML.

The modal has one global empty state: "No local project history yet." A partial source failure instead
shows available data plus a compact warning such as "Session history unavailable" and a Retry action.

## Data Flow

1. User activates Memory on a card or row.
2. Renderer opens the dialog immediately and calls `project:memory(path)` through the preload bridge.
3. Main validates the path, then reads Git, provider sessions, and the existing store entry.
4. Independent failures are recorded in `partial`; successful facts are projected into the snapshot.
5. Events are merged by descending timestamp with deterministic kind/id tie-breakers and capped at 40.
6. Renderer displays the snapshot and timeline.
7. Exact-session actions send the existing `{ path, sessionId, agentId, mode: 'auto' }` intent.
8. Refresh invalidates that project's short cache and repeats the read.

## Error Handling and Security

- Disallowed project paths never reach Git, transcript readers, or the store mutation surface.
- Git or session-reader failure does not reject the whole memory request.
- A deleted/moved repository shows the stored note/tasks and an unavailable-source warning when the
  path still belongs to an allowed configured project; no arbitrary parent fallback is attempted.
- Invalid timestamps and session IDs are dropped using existing sanitizers and validators.
- Last-message reads are concurrency-limited and retain existing byte caps to avoid UI stalls on very
  large histories.
- The feature performs no network request and does not invoke agent CLIs.
- Renderer output uses DOM text APIs, and copied commit hashes come only from the parsed hexadecimal
  field.

## Accessibility and Localization

- The overlay uses `role="dialog"`, `aria-modal="true"`, a labelled title, initial focus on Close, a
  focus trap, Escape dismissal, outside-click dismissal, and trigger focus restoration.
- Memory controls are real buttons with localized accessible names in cards and compact list rows.
- Timeline items use a semantic list; timestamps use `<time datetime="...">` and localized relative
  display text.
- Provider identity includes text or an accessible provider name and never depends on color alone.
- Loading and refresh completion are announced through the existing polite status/toast mechanism.
- New strings are supplied in Korean, English, Japanese, and Chinese.

## Compatibility and Migration

The feature is additive. Existing `state.json` entries need no migration because all new history is
derived on demand. The current Resume Cue remains on cards and rows; Memory offers depth without
removing the fastest glanceable signal. Existing Open, explicit-session resume, notes, tasks, cockpit,
and external-terminal semantics remain authoritative.

If a provider is not installed, it contributes no sessions. If no provider history exists, Git,
tasks, note, and last-open data still produce useful memory.

## Test Strategy

Implementation follows red-green-refactor.

1. Add pure parser tests for bounded Git-log records, malformed data, delimiter-bearing subjects, and
   timestamp validation.
2. Add pure aggregator tests for cross-provider session identity, newest-first merge order, stable
   tie-breaking, 40-event cap, Continue-from fallback, task ordering, remaining count, and partial
   failures.
3. Add service tests proving transcript readers are bounded/concurrency-limited, cache hits share work,
   manual refresh invalidates one project, and no result is persisted.
4. Extend IPC tests for allowlist rejection, neutral error shapes, source-level degradation, and the
   exact provider/session pair returned to the renderer.
5. Add renderer tests for safe text rendering, empty/partial/loading states, exact-session actions,
   refresh, keyboard dismissal, focus trap, and focus restoration.
6. Run the complete Vitest suite and TypeScript/renderer production build.
7. Run the existing QA screenshot and accessibility audit in cards and list modes, at narrow and
   normal window sizes, with populated, empty, and partial memory states.

## Delivery Boundary

This implementation ends when Project Memory and Resume Snapshot are stable in cards and list view.
The next prioritized unit should be **task-session connection**, because these memory events then give
tasks a natural source/continuation relationship. It receives a separate design and does not expand
this release.

## Success Criteria

- A user can understand the latest conversation point, repository state, next tasks, and note from one
  project-local surface without opening an agent transcript.
- Recent commits and conversations from all installed providers appear in one correctly ordered view.
- Resuming a timeline session always uses the provider that owns it.
- The normal Open action remains one click and unchanged.
- Opening Memory adds no periodic deck-scan cost and performs no network or AI call.
- A failed Git or provider source leaves the remaining memory usable and visibly marked partial.
- Large transcripts do not trigger unbounded reads or main-thread full-file parsing.
- All automated tests, build checks, QA, and accessibility audits pass before release work begins.
