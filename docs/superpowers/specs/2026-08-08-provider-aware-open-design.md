# Provider-Aware Open Design

## Problem

DevDeck currently conflates two different intentions:

1. resume the conversation that already belongs to a provider, and
2. open the same project with the provider the user has deliberately selected.

The Projects surfaces put the newest session owner into every generic open request. The task board sends no provider, and the main process replaces that omission with the owner of the project's newest conversation. The cockpit then resolves that provider's newest session and selects an existing tile when it finds the same conversation. Consequently, changing the header selection from Claude to Codex does not change what opens for a project that already has Claude history.

The recent duplicate-session protection is correct for one conversation, but its lookup is not expressed as a provider-scoped operation. The UI also gives no indication whether an open action will focus a live tile, resume history, or start a conversation.

## Goals

- Make a generic **Open** action honor the provider visibly selected by the user.
- Let a project already open in Claude be opened independently in Codex or Antigravity.
- Preserve conversation ownership: an explicit historical session always resumes with the provider that created it.
- Prevent two live processes from attaching to the same provider conversation.
- Expose the outcome before the click: focus an open session, continue recent history, or create a conversation.
- Use the same interaction and state rules in the task board, project cards, and project list.
- Preserve keyboard access, localization, external-terminal behavior, batch opening, and missing-CLI guidance.

## Non-goals

- Transferring Claude conversation text into Codex or Antigravity.
- Combining provider transcripts into one cross-provider conversation.
- Changing how a provider's CLI resumes its own conversation.
- Adding provider installation or account management.
- Redesigning the cockpit session list beyond the open/focus behavior required here.

## Chosen Interaction

Every generic project open control becomes a provider-aware split button.

- The primary segment shows the selected provider's mark and opens with that provider.
- The disclosure segment lists every installed provider.
- Each provider entry describes the automatic result as **Open**, **Continue recent**, or **New conversation**.
- Each provider also offers **New session**, which bypasses live-session focus and history continuation.
- Changing the header provider immediately changes the primary segment on all rendered open controls.

Compact contexts may use the provider mark plus the play symbol instead of the word “Open,” but retain the same accessible name and disclosure menu. The task board, project card, and project list share one control implementation so their behavior cannot drift.

Specific historical session rows remain single-action controls. Their provider mark and accessible name make their fixed ownership explicit; they do not offer another provider because a foreign provider cannot resume that transcript.

## Open Semantics

An open request has an explicit provider and one of two modes:

- `auto`: focus a live conversation for that project and provider when the exact target is already held; otherwise continue that provider's newest conversation; if the provider has no history for the project, create a conversation.
- `new`: always create a provider conversation and never deduplicate against an existing tile.

An optional explicit session ID means “resume this exact conversation.” It is valid only with its owning provider.

The automatic decision table is:

| Requested provider state for project | `auto` result | `new` result |
| --- | --- | --- |
| Exact target is held by a live tile | Focus that provider tile | Start another conversation |
| Provider history exists, no matching live tile | Resume provider's newest conversation | Start another conversation |
| No provider history exists | Start a conversation | Start a conversation |
| Provider history lookup fails | Start a conversation and retain the selected provider | Start a conversation |

Provider histories are independent. A live Claude tile is never a duplicate of a Codex or Antigravity request, even when both use the same project path.

## Architecture

### Open intent

`OpenReq` becomes an explicit intent boundary. Generic callers always provide `agentId`; they no longer derive it from the newest project session. The request distinguishes automatic opening from forced creation instead of relying on an ambiguous missing field.

The main-process handlers keep the explicit provider authoritative. The global selection is a compatibility fallback only for legacy or newly created callers that genuinely omit provider context. The “newest project owner” fallback is removed from generic opening because it contradicts visible provider selection.

### Shared provider open control

A focused renderer component builds the split button and its menu from:

- installed providers,
- the current selected provider,
- providers with project history, and
- live cockpit sessions for the project, grouped by provider.

It emits an open intent and owns menu focus, dismissal, labels, and compact/full presentation. It does not launch terminals directly.

The renderer keeps the selected provider in one small shared state source. The header selector updates that source after persistence succeeds; open controls subscribe or are rerendered so their primary segment cannot show stale ownership.

### Routing and provider resolution

`openRouter` continues to choose embedded cockpit on Windows and an external terminal elsewhere. It forwards the same explicit provider and mode in both cases.

For the cockpit, duplicate resolution is provider-scoped. Candidate live tiles are filtered by both project path and provider before comparing the concrete session ID. A provider lookup is performed only when a live tile for that same project and provider could be a duplicate.

For external terminals, the main process resolves session history only inside the requested provider. `new` maps to the provider's new command. `auto` maps to continue when that provider has history and new otherwise.

### Historical sessions

Historical session controls keep `{ sessionId, agentId }` together. The main process uses that pair to resume. Renderer and main-process validation prevent an explicit session from silently falling through to a different provider.

## Data and UI State

The Projects response already includes provider-owned sessions and ordered `agentIds`. The task board will retain the provider summary from that response rather than discarding it when it maps projects into its local model.

Live cockpit state will expose a read-only summary keyed by project path and provider. UI status is advisory; launch correctness never depends on it. The main process and cockpit re-resolve actual history at click time to avoid races.

Menu status priority is:

1. **Open** when a live tile exists for the project and provider.
2. **Continue recent** when provider history exists.
3. **New conversation** otherwise.

## Error Handling

- A missing provider CLI retains the current actionable warning and still lets the terminal surface the shell's authoritative error.
- A failed history lookup must not switch providers. It falls back to a new conversation with the requested provider.
- A failed duplicate lookup must not focus a tile owned by another provider. Opening proceeds with the requested provider.
- An invalid or unavailable provider in an untrusted IPC payload is normalized through the existing installed/known-provider checks; it cannot select an arbitrary command.
- A session ID paired with a provider that cannot find it is treated according to the existing missing-conversation restore behavior, without trying another provider's store.
- Menu dismissal, Escape, outside click, and focus return are handled without leaving invisible focus targets.

## Accessibility and Localization

- The split control has one labelled primary action and a separately labelled menu trigger.
- Menus use button/menu semantics consistent with the renderer's existing controls and support Arrow keys, Enter, Space, Escape, and focus restoration.
- Provider identity is conveyed by localized text in addition to the logo.
- Status is not conveyed by color alone.
- New strings are added in English, Korean, Japanese, and Chinese.
- Compact play-only buttons retain an accessible name containing provider and outcome.

## Test Strategy

Implementation follows red-green-refactor.

1. Add a regression test showing that a generic Codex request for a project with Claude history remains a Codex request.
2. Add pure decision tests for provider-scoped duplicate matching, `auto`, `new`, explicit-session ownership, history presence, and lookup failure.
3. Add renderer component tests where feasible for emitted intents, status labels, menu keyboard behavior, and selected-provider updates.
4. Extend IPC tests to prove embedded and external launches build commands for the requested provider and that forced-new never resumes.
5. Extend cockpit tests to prove a Claude tile does not deduplicate a Codex request, while the same Codex conversation does.
6. Run the complete Vitest suite and TypeScript checks.
7. Run the production renderer/application build.
8. Run the existing QA and accessibility audit against the task board, project card/list, menu states, and cockpit focus behavior.

## Documentation and Release

- Update README multi-agent and one-click-open descriptions to distinguish provider selection from conversation ownership.
- Update screenshots or demo assets only if the existing release workflow requires current UI captures.
- Record the behavior change in the repository's established release notes/changelog location, if present.
- Bump the patch version because this is a backward-compatible behavior and UI fix.
- Build release artifacts and use the repository's existing authenticated release/publish workflow. Publishing is attempted only after all verification succeeds; missing credentials or required human approval is reported as a deployment blocker rather than bypassed.

## Success Criteria

- With a Claude tile live, choosing Codex from a task row opens or focuses only a Codex session for that project.
- The primary open action always matches the provider shown on the control.
- Choosing **New session** never focuses or resumes an existing conversation.
- Choosing a historical Claude conversation still resumes with Claude after the header is switched to Codex.
- Duplicate protection still prevents two live tiles from attaching to the same conversation of the same provider.
- Task board, project cards, project list, external terminals, and embedded cockpit follow the same provider rules.
- All automated tests, type checks, build, QA, and accessibility checks pass before release publication.
