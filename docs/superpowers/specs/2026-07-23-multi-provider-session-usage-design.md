# Multi-provider sessions and usage design

Date: 2026-07-23

## Goal

Make DevDeck's Claude Code, Codex, and Antigravity support visually clear and behaviorally correct. A user must be able to identify the provider of every cockpit session, read long session names without giving terminal space to a wider sidebar, restore a session with its original provider, and inspect all officially available subscription limits from one compact entry point.

## Scope

This change covers:

- provider logos and long-name behavior in the cockpit sidebar and header;
- provider-aware open, restore, restart, new-session, metadata, and live-session-id flows;
- a normalized live-usage provider layer;
- Claude's current general, model-scoped, and usage-credit limits;
- Codex's official app-server rate-limit API;
- an Antigravity `/usage` and `/credits` guidance state;
- a one-line footer summary and an all-provider usage overlay;
- honest labeling of the existing Claude-only local analytics page;
- documentation, localization, accessibility, tests, and an Antigravity follow-up backlog item.

It does not attempt to reverse-engineer Antigravity credentials, protobuf storage, or private endpoints. It also does not turn the existing Claude local token/cost analytics into a normalized cross-provider accounting product.

## Findings that motivate the change

The cockpit currently renders raw provider identifiers such as `claude`, `codex`, and `antigravity`. Its 250px fixed sidebar puts the name, context percentage, metadata, and hidden row actions in competing flex columns. Although the actions are visually transparent until hover, they still consume width.

Provider identity is also coupled to the global active-agent setting. Cockpit open, session metadata, session-id lookup, and live drift detection resolve the global provider instead of the provider owned by the target session. Restoring, restarting, or creating a sibling of an existing session can therefore use a different provider after the global selection changes.

The footer is entirely Claude-specific: the IPC handler reads Claude credentials, the shared type models only five-hour and seven-day windows, and the renderer has two fixed meters. The local usage analytics page also reads only `~/.claude`, but the surrounding navigation can make that scope unclear.

## Selected approach

Use a provider-aware vertical slice rather than a surface-only patch or a full cross-provider accounting platform. Session operations will become explicitly provider-scoped, while live subscription limits will use a separate provider registry. UI presentation metadata will remain independent of main-process provider implementations.

## Architecture

### Session providers

`AgentProvider` continues to own session discovery and command construction. It gains or delegates provider-specific metadata and session-file operations required by the cockpit. Every path that acts on an existing session receives an explicit `AgentId`.

The following IPC requests include `agentId` and validate it before selecting a provider:

- cockpit open;
- session metadata;
- all session IDs;
- live session-ID drift detection.

The global selected agent is used only when the user starts a session from a project surface without an existing session context. Restore, restart, and “new session” from an existing cockpit tile preserve that tile's provider. Persisted `agentId` values are normalized to the `AgentId` union; invalid legacy values fall back to Claude as they do today.

### Usage providers

A separate `UsageProvider` boundary returns a normalized result for live subscription limits. Session providers and usage providers are separate because their capabilities and lifecycles differ.

Each result contains:

- provider ID and display state;
- plan label when available;
- zero or more normalized limit windows with stable kind, display label, percent, reset time, and optional model scope;
- optional credit/spend summary;
- freshness timestamp;
- one of `ready`, `stale`, `login-required`, `expired`, `not-applicable`, `cli-missing`, `offline`, `rate-limited`, or `unsupported`.

Provider failures are isolated and combined with all successful results.

### Provider presentation

A renderer-safe presentation registry maps `AgentId` to a bundled local SVG logo, localized display name, and accessible label. The session UI never constructs a provider label from a raw identifier. Logos are local assets and require no renderer network access.

## Provider usage behavior

### Claude

The existing OAuth endpoint remains in the Electron main process. Parsing supports both the legacy fixed fields and the current dynamic response:

- five-hour and overall weekly limits;
- every validated entry in the response `limits` array;
- model-scoped weekly limits such as Fable;
- Usage Credits and spend state when present.

Fable is not hardcoded as the only model-scoped limit. A scoped limit is rendered from the server-supplied, length-limited model display name. Accounts without a Fable entry show no empty Fable row. Current Anthropic guidance says Fable's temporary included allowance ended after 2026-07-07 and continued access uses Usage Credits, so both scoped limits and credits must be supported.

### Codex

DevDeck starts the installed `codex app-server` as a short-lived hidden child process, performs the required initialize/initialized handshake, and calls the stable `account/rateLimits/read` method. It normalizes the primary and secondary windows, plan and credit information that the server returns.

The child process has a bounded startup/request timeout, a maximum captured-output size, and deterministic cleanup. Codex owns token refresh and authentication; DevDeck does not parse or export Codex credentials. API-key, local-model, or other modes without ChatGPT subscription windows become `not-applicable`, not errors.

### Antigravity

The official CLI currently documents only interactive `/usage` (`/quota`) and `/credits` panels. The normalized result is therefore `unsupported` with localized instructions for those commands and a copy action. DevDeck does not call undocumented endpoints or decode protobuf quota state.

## Cockpit UI

### Sidebar

The sidebar stays exactly 250px wide. Each row uses this scan order:

1. activity indicator;
2. 20–22px provider logo;
3. session content.

The provider text is removed from the metadata line, which retains branch, dirty count, and model when available. The header and previous/restorable rows use the same logo component.

Session names use a two-line clamp. Custom labels and generated collision suffixes follow the same rule. Pointer hover and keyboard focus expose the complete name through an accessible tooltip/description. Extremely long names may still clamp after two lines, but their full content remains available without resizing the sidebar.

Pin, rename, and close controls are overlaid on the trailing edge only during row hover or focus-within. They do not reserve layout width while hidden. Their overlay uses a background fade so it remains legible without obscuring the name unexpectedly.

### Footer and usage overlay

The footer remains exactly 26px high, matching the current implementation, and does not change terminal height. It shows compact installed-provider logos, a concise critical/current-limit signal, and a right-aligned “All usage” action.

The action opens the selected U1 centered modal overlay. Opening or closing it does not modify shell, content, or xterm dimensions and must not trigger a terminal resize. The overlay:

- renders one provider section per installed provider;
- lists every available normalized window and its own reset time;
- shows Claude model-scoped limits and credits dynamically;
- shows Codex primary/secondary windows and credits when available;
- shows Antigravity `/usage` and `/credits` guidance;
- provides a deduplicated manual refresh;
- closes by button, outside click, or Escape;
- traps focus while open and returns focus to the trigger on close.

At mount, window focus, and every five minutes, installed usage providers refresh concurrently. Cached results render immediately. A refresh already in flight is reused rather than duplicated.

### Existing analytics page

The existing analytics page remains a Claude local-log report. Its title, empty state, explanatory copy, and README documentation explicitly say “Claude Code local analytics.” The new overlay owns all-provider live subscription limits. This avoids presenting incomparable local data as a unified cost report.

## Error handling and caching

Each provider has an independent last-good cache entry with a timestamp. A transient failure returns the last successful data as `stale`; the UI displays its age. Without a cached value, it displays the provider-specific state and an actionable explanation.

Polling failures remain inside the relevant provider section and do not emit repetitive toasts. A malformed response is rejected by parsers and never crosses IPC as partially trusted data. Percentages are finite and clamped to 0–100; labels are length-limited; reset times are validated.

Claude and Codex authentication material never crosses IPC. Only normalized plan, limit, reset, credit, status, and freshness fields reach the renderer.

## Localization and accessibility

All new visible strings and accessible names are added to Korean, English, Japanese, and Chinese locale files. Provider identity never depends on color alone: every logo has an accessible provider name. Tooltips are available by pointer and keyboard. The usage overlay follows dialog semantics, provides a labeled close control, traps focus, restores focus, and supports Escape.

Logo contrast, status text, stale labels, meter text, and modal controls meet the existing accessibility audit. Motion is limited to existing activity indicators and meter updates; no marquee is used for long names.

## Testing

### Unit and integration coverage

- Parse Claude legacy fixed windows, dynamic limits, model-scoped Fable data, credits, missing values, invalid reset timestamps, and percentage clamping.
- Exercise Codex JSON-RPC initialization, mixed notifications and responses, primary/secondary windows, auth modes, timeouts, output caps, malformed output, and cleanup.
- Combine concurrent provider results with partial failures, stale caches, and in-flight request deduplication.
- Validate persisted provider IDs and legacy normalization.
- Prove that changing the global selected provider does not change restore, restart, sibling-session creation, metadata lookup, ID lookup, or drift detection for existing sessions.
- Verify Antigravity always exposes documented CLI guidance and performs no usage network request.

### UI and end-to-end coverage

- Preserve the 250px sidebar and existing terminal width.
- Render two-line names and expose full names to pointer and keyboard users.
- Ensure hidden row actions reserve no name width.
- Render provider logos and accessible names in live, previous, and header contexts.
- Preserve footer height.
- Open and close the usage modal without an xterm resize.
- Verify Escape, outside click, focus trapping, focus restoration, and refresh deduplication.
- Render partial-success and stale-provider states.
- Check all four locales for overflow and run the existing axe audit.

### Completion commands

Run the complete Vitest suite, TypeScript/renderer build, existing QA audit, and screenshot workflow. Add or update screenshots for the cockpit sidebar, footer, and all-provider usage overlay.

## Documentation

Update README claims about live limits and outbound connections. Claude usage still contacts Anthropic's first-party endpoint. Codex usage is obtained through the locally installed official app-server, which performs its own first-party request. Antigravity usage remains an interactive CLI instruction. Document that local token/cost analytics remains Claude-only.

## References

- [Anthropic: Redeploying Fable 5](https://www.anthropic.com/news/redeploying-fable-5)
- [Claude Code models, usage, and limits](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)
- [OpenAI Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Google Antigravity `/usage` documentation](https://antigravity.google/docs/cli/commands/usage)
- [Google Antigravity credits documentation](https://antigravity.google/docs/cli/credits)

## Approved visual decisions

- A: fixed provider-logo column in the session row.
- A1: two-line session names with full-name hover/focus help.
- U1: centered all-provider usage modal opened from the unchanged one-line footer.
