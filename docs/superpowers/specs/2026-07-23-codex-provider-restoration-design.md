# Codex provider restoration design

## Goal

Restore Codex as a first-class DevDeck agent alongside Claude and Antigravity. A user can choose Codex, inspect its project-local conversation history, resume a specific or latest conversation, and preserve Cockpit sessions across an app restart or update.

## Provider architecture

Extend `AgentId` with `codex` and register a Codex `AgentProvider` in `src/main/agents.ts`. The provider will use `~/.codex/sessions` as its availability marker and session source.

Its launch commands are:

- New conversation: `codex`
- Latest conversation: `codex resume --last`
- Specific conversation: `codex resume <session-id>`

Codex does not accept an app-generated session ID for a new conversation. It launches normally, then Cockpit adopts its ID only when one unclaimed rollout file was created after that tile opened and its modification time matches the tile's output. This is the existing evidence-gated session-ID adoption rule used for Claude drift detection, extended to Codex. It lets a new Codex tile be restored to its own conversation without accidentally adopting another concurrently running tile's rollout.

## Session discovery

A dedicated Codex session reader will recursively scan `~/.codex/sessions` for `rollout-*.jsonl` files. It will:

- read the `session_meta` header for the session ID and working directory;
- associate only exact project-directory matches with a DevDeck project;
- sort matching sessions by file modification time, newest first;
- extract first and last genuine user messages for card previews and resume cues;
- read only bounded head/tail regions for large rollout logs where possible; and
- reject malformed IDs and unreadable logs without failing the project scan.

The parser will support both the historical `event_msg/user_message` representation and the current rollout format. This keeps existing stored conversations visible while retaining compatibility with the current Codex desktop CLI logs.

## UI, settings, and persistence

The existing agent selector will list Codex whenever its session directory exists. The localized `agent.codex` label and README copy will describe the three supported agents.

No new renderer controls are needed: the project view already reads the active provider's sessions, and Cockpit persists `agentId` plus `sessionId`. Restored Codex entries are resumed only while Codex is the active agent; the existing safeguard otherwise opens a fresh session under the selected provider.

## Cockpit behavior and non-goals

Codex uses the existing generic Cockpit PTY lifecycle, status timing fallback, saved-session schema, and evidence-gated live session-ID adoption. The Codex reader exposes all matching rollout IDs and their file creation/modification times for that adoption check. Claude-specific enrichments remain Claude-only:

- model, active-working-time, and context-window metadata return their neutral values for Codex;
- Claude usage analytics remain unchanged and do not claim to represent Codex usage.

The generic PATH warning will recognize the `codex` binary and give a Codex-specific installation hint if it is unavailable on Windows.

## Verification

Unit tests will cover the Codex parser/session reader for current and legacy records, project filtering, order, malformed input, large-log last-message lookup, and availability. Provider tests will cover availability, command construction, and open-session resolution. Existing IPC and renderer tests will be updated for the expanded `AgentId` validation and Cockpit persistence behavior. The full test suite and production build will be run before handoff.
