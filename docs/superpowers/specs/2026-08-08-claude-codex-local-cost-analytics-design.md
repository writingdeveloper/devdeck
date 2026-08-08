# Claude and Codex Local Cost Analytics Design

## Problem

DevDeck supports Claude Code, Codex, and Antigravity, but its Usage page analyzes only Claude Code transcripts under `~/.claude`. The page explicitly calls itself Claude-only, so a user who works in both Claude and Codex cannot see their API-equivalent costs together even though DevDeck already discovers Codex projects, sessions, models, and token-related rollout events.

The always-on footer and **All usage** dialog solve a different problem: they show live subscription limits and reset windows. The user is satisfied with those surfaces. This design changes only the local token and cost analytics page.

## Goals

- Show **combined estimated cost**, **Claude estimated cost**, and **Codex estimated cost** together on one Usage page.
- Preserve the existing date ranges, project breakdown, model breakdown, daily chart, search, sorting, deleted-project handling, and active-time analysis.
- Let the user filter the analytics page by **All**, **Claude**, or **Codex** without navigating away.
- Derive both providers' analytics from local session records and keep transcripts on the device.
- Base token semantics and price cards on provider documentation, while treating the result as an API-equivalent estimate rather than a subscription bill.
- Keep large Codex rollouts responsive through streaming, incremental indexing, and bounded aggregate caches.
- Make partial or unknown data explicit instead of silently reporting a false complete total.

## Non-goals

- Changing the footer usage bar, live quota polling, or the **All usage** dialog.
- Estimating the user's actual Claude or ChatGPT subscription invoice.
- Adding Antigravity cost analytics before it exposes stable model and token data suitable for cost calculation.
- Combining unrelated quota percentages or reset windows.
- Uploading transcripts, credentials, aggregate usage, or telemetry.
- Reconstructing cloud Codex tasks that have no local rollout.

## Approaches Considered

### Codex account usage only

The documented App Server `account/usage/read` method provides lifetime token activity and optional daily buckets. It does not provide project, model, input/output/cache splits, or enough information to calculate project-level cost. It cannot reach feature parity with the existing Claude page.

### Local Codex rollout analysis — chosen

Codex rollouts associate sessions with a working directory and record the model and token-usage updates needed for local project analytics. The documented non-interactive Codex JSON stream uses the same input, cached-input, output, and reasoning-output concepts. This approach supports the existing page's project, model, date, and cost views.

The on-disk rollout envelope is not treated as a permanently frozen public API. Parsing stays isolated behind a provider adapter, accepts known compatible field spellings, validates every number, and fails per file rather than per report.

### Hybrid account totals plus local cost

This would put an authoritative account total beside a local cost estimate, but the scopes can differ because of cloud tasks, ephemeral runs, deleted records, authentication mode, or retention. A total that cannot be reconciled with the visible rows would be more confusing than useful, so the account endpoint remains part of live provider support rather than this page.

## Chosen User Experience

The Usage page heading becomes **Claude Code + Codex local analytics** with a concise explanation that all values come from local records and costs are API-equivalent estimates.

The toolbar contains two independent controls:

- date range: **7d / 30d / 90d / All**;
- provider: **All / Claude / Codex**.

The **All** view leads with three cost cards in this order:

1. **Combined estimated cost** — sum of every priceable Claude and Codex model in the selected range;
2. **Claude** — Claude's priceable subtotal;
3. **Codex** — Codex's priceable subtotal.

The first card remains visually primary. Claude and Codex cards use their existing provider marks and text labels. Selecting a provider keeps the combined context visible but filters the detailed token stats, model share, daily chart, and project table to that provider.

Existing token and activity stats remain. In the All view, they are sums of both providers after normalization. The model legend prefixes each model with its provider identity so similarly named or aliased models are never conflated.

Each project row shows the combined estimated cost as its main value and a compact `Claude … · Codex …` breakdown underneath when both providers contributed. Under a provider filter, the row shows only that provider's value. Projects used by only one provider do not render an empty second line.

Antigravity does not appear as a selectable cost filter. The scope explanation says that Antigravity is excluded because its current local records do not expose stable model/token usage for this calculation. The live footer continues to offer its existing CLI guidance.

## Cost Semantics

Every monetary number is labelled **API-equivalent estimated cost**, not “spend,” “bill,” or “subscription cost.” Subscription plans, credits, negotiated enterprise rates, long-context tiers, regional pricing, and provider promotions can make the real amount different.

Each normalized usage record has:

- provider;
- project path;
- session identifier;
- timestamp/day;
- model identifier;
- uncached input tokens;
- cached-input tokens;
- cache-write tokens;
- output tokens.

Reasoning output is not added separately when it is already a subset of output tokens.

Claude records already report ordinary input, cache read, cache creation, and output as separate fields. Their current calculation remains unchanged.

Codex reports total input along with cached-input and, on supporting models, cache-write subsets. The normalized uncached input is:

`max(0, input_tokens - cached_input_tokens - cache_write_input_tokens)`

Cached input and cache writes then receive their own documented rates. This prevents cached tokens from being charged once as ordinary input and again as cached input.

The cost for a normalized record is:

`uncached input × input rate + cached input × cache-read rate + cache writes × cache-write rate + output × output rate`

All rates are stored per million tokens in a provider-aware price registry. Exact model IDs, documented aliases, and dated snapshots may resolve to the same price card. Unknown or unsupported model IDs retain their token counts but contribute no monetary value.

The UI indicates a **partial estimate** whenever any contributing record has no price card. It never turns an unknown price into zero. Provider subtotals and the combined total share the same completeness rule.

## Data Architecture

### Common report domain

The existing Claude-specific `UsageReport` becomes a provider-aware local analytics report. Provider adapters produce the same normalized aggregates, and a pure combiner produces:

- global totals and cost completeness;
- provider subtotals;
- model rows tagged with provider;
- project rows with provider subtotals;
- daily rows with provider subtotals;
- session counts and active time.

Filtering and sorting operate on this normalized report rather than branching on provider-specific raw formats in the renderer.

### Claude adapter

The current Claude scanner remains the source of truth for `~/.claude`. Its parsing, synthetic-record exclusion, active-time cap, deleted-project reconciliation, and digest cache are preserved behind the common adapter contract.

### Codex adapter

The Codex scanner walks only validated `rollout-*.jsonl` files under the configured Codex sessions directory. It reads the session metadata from the bounded head to identify the session and canonical working directory, then streams usage events without retaining transcript text.

The scanner associates each usage update with the most recent valid model context and event timestamp. When cumulative totals are present, it derives non-negative deltas from successive totals; this makes repeated notifications idempotent. If a compatible older event has only last-request usage, the scanner accepts that record once. A cumulative reset starts a new baseline and uses the validated last-request usage for that event.

Every numeric field must be finite and non-negative. Malformed JSON lines, unknown event types, invalid model values, and impossible negative deltas are ignored without invalidating other records.

### Incremental aggregate index

Codex rollouts can be several gigabytes, so a changed file must not be reparsed from byte zero on every refresh.

For each rollout the index stores only:

- canonical file identity and safe metadata (`size`, `mtime`, session/project identity);
- last fully consumed byte offset and incomplete trailing bytes;
- the last cumulative token baseline and current model;
- compact day/model aggregate buckets;
- bounded timestamps needed for active-time calculation;
- parser schema version and price-registry version.

The cache contains no prompts, responses, tool output, or credentials. On append, parsing resumes at the saved offset. On truncation, replacement, identity mismatch, or schema-version change, that file alone is rebuilt. Cache writes are atomic. A corrupt cache is discarded and reconstructed from source records.

Initial indexing is asynchronous and streams one file at a time. The renderer shows the existing loading state until a complete consistent report is ready. Parsing yields periodically so the Electron main process can continue servicing other IPC work.

## Project Reconciliation

Claude and Codex project paths are canonicalized through the existing path utilities before aggregation. The same repository used by both providers becomes one project row with two provider subtotals.

Projects found in local usage history but absent from current scan locations remain visible as deleted projects so totals remain honest. The existing collapsed deleted-project group includes both providers and preserves its combined/provider subtotals.

Sessions count once per provider session when that session has activity inside the selected range. A Claude and Codex session in the same repository remain two sessions.

## Error and Partial-Data Handling

- Failure of the Claude adapter does not suppress valid Codex analytics, and vice versa.
- An unavailable sessions directory produces an empty provider subtotal, not a fatal page error.
- A provider-level failure is surfaced near that provider's subtotal with retry guidance.
- A malformed or concurrently written line is skipped or retained as an incomplete tail for the next refresh.
- Unknown models show tokens and an unavailable cost marker; known-model totals are explicitly marked partial.
- Price-registry misses never fall back to a guessed family unless an official alias mapping is recorded.
- Overflow, non-finite numbers, negative deltas, and path mismatches are rejected before aggregation.
- Search and provider filters never alter the headline range total; only range selection changes the accounting period.

## Accessibility and Localization

- Provider filters are real buttons with pressed/selected state and keyboard access.
- Provider identity always includes localized text; logos are supplementary.
- Partial estimates and unavailable values are conveyed in text, not color alone.
- Cost cards have unambiguous accessible labels containing provider and selected date range.
- New strings are supplied in Korean, English, Japanese, and Chinese.
- Existing table sorting semantics and keyboard activation remain intact.

## Testing Strategy

Implementation follows red-green-refactor.

1. Add pure Codex parser tests for cumulative deltas, last-usage fallback, cache subtraction, model changes, timestamps, duplicate notifications, cumulative resets, malformed lines, and partial trailing lines.
2. Add incremental-index tests for append, unchanged files, truncation, replacement, corrupt cache, schema invalidation, atomic persistence, and multi-gigabyte behavior through bounded synthetic streams.
3. Add common aggregation tests for combined/Claude/Codex costs, project merging, daily totals, session counts, deleted projects, unknown prices, and one-provider failure.
4. Add official-price-card tests for supported Claude and Codex model IDs, aliases, snapshots, cached input, cache writes, output, and unknown models.
5. Add renderer tests for the three headline costs, provider filtering, project cost breakdown, partial-estimate labels, empty states, and localization.
6. Extend IPC tests to prove the report combines isolated adapters and returns useful partial data when one fails.
7. Run the complete unit suite, TypeScript checks, production build, application QA, and accessibility audit.
8. Verify a release build on supported operating systems before publishing.

## Documentation Sources

- OpenAI Codex App Server: `account/usage/read` and `thread/tokenUsage/updated` establish the supported account/thread usage concepts.
- OpenAI Codex non-interactive JSON output: documents turn-completion usage fields for input, cached input, output, and reasoning output.
- OpenAI model and pricing pages: source for Codex model price cards and cache pricing.
- Anthropic model pricing: source for Claude input, cache-write, cache-read, and output price cards.

Documentation is consulted when adding or changing a price card. A model without a verified current price remains unpriced rather than inheriting a guessed rate.

## Documentation and Release

- Update README's Usage-page description from Claude-only analytics to Claude + Codex local analytics.
- Keep the live-limit and privacy descriptions unchanged except where a cross-reference needs the new page scope.
- Update the Usage-page screenshot and four-language QA captures.
- Bump the patch version because this is a backward-compatible analytics expansion.
- Publish through the repository's existing CI and release workflow only after all verification passes.

## Success Criteria

- The All view displays combined, Claude, and Codex estimated costs at the same time.
- A user can switch between All, Claude, and Codex without leaving the Usage page.
- The combined cost equals the sum of priceable Claude and Codex records in the selected range.
- Project rows combine matching repository paths while preserving each provider's subtotal.
- Codex cached tokens are not double-counted as ordinary input.
- Unknown model prices produce an explicit partial estimate, never a false zero or silently complete total.
- Appending to a large Codex rollout reads only new bytes after the initial index.
- No transcript text or credential material is persisted in the usage index.
- The footer usage bar, quota polling, and All usage dialog behave exactly as before.
- All automated tests, type checks, builds, QA checks, and accessibility checks pass before release publication.
