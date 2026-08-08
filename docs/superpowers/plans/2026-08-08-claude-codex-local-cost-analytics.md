# Claude and Codex Local Cost Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend DevDeck's local Usage page so one view shows combined, Claude, and Codex API-equivalent estimated costs with provider-filtered project, model, token, and daily detail.

**Architecture:** Keep Claude parsing intact behind a provider slice, add a streaming Codex rollout adapter with a persisted aggregate-only incremental index, and merge the two through pure shared report functions. The renderer consumes only the normalized report, while the existing footer usage bar and live quota IPC remain unchanged.

**Tech Stack:** Electron 43, TypeScript 5.5, Node.js filesystem streams, Vitest 3, renderer DOM APIs, Playwright Electron QA, electron-builder.

## Global Constraints

- Change only the local token/cost Usage page; do not change the footer usage bar, live quota polling, or the **All usage** dialog.
- Show combined estimated cost, Claude estimated cost, and Codex estimated cost simultaneously in the All view.
- Label every monetary value as an API-equivalent estimate rather than a subscription bill.
- Support only Claude and Codex in local cost analytics; explain that Antigravity lacks stable model/token records for this calculation.
- Keep all transcript processing local and persist no prompt, response, tool output, credential, or raw transcript text.
- Unknown model prices retain token counts, contribute no monetary value, and force an explicit partial-estimate state.
- Normalize Codex uncached input as `max(0, input_tokens - cached_input_tokens - cache_write_input_tokens)`; do not add reasoning output separately to output.
- Add every user-facing string in Korean, English, Japanese, and Chinese.
- Preserve existing range selection, search, sorting, deleted-project grouping, active-time calculation, and accessibility behavior.
- Use documented provider price cards only; never guess an unknown model's price.
- Follow red-green-refactor and commit after each independently testable task.

---

## File Structure

- Create `src/shared/localUsage.ts`: provider-aware report types, empty slices, pure merging, filtering, and provider cost helpers.
- Create `src/shared/localUsage.test.ts`: provider merge, filtering, deleted-project, unknown-price, and partial-provider tests.
- Modify `src/shared/types.ts`: point legacy exported Usage report types at the new provider-aware domain without changing unrelated project/session types.
- Modify `src/shared/usage.ts`: add Codex price cards and provider-aware price resolution while preserving Claude callers.
- Modify `src/shared/usage.test.ts`: official Codex prices, aliases, cached-token formulas, and unknown-model behavior.
- Create `src/shared/codexUsageParse.ts`: pure line/event parser and cumulative-delta state machine.
- Create `src/shared/codexUsageParse.test.ts`: token normalization, deduplication, reset, model, day, and malformed-input tests.
- Modify `src/main/codexSessions.ts`: export bounded validated rollout-head metadata for reuse by analytics.
- Modify `src/main/codexSessions.test.ts`: prove exported heads contain only validated rollout files and canonical session metadata.
- Create `src/main/codexUsageScan.ts`: streaming incremental scanner and aggregate-only persisted index.
- Create `src/main/codexUsageScan.test.ts`: initial scan, append, no-op refresh, partial line, truncation, corrupt cache, deleted path, and event-loop yield tests.
- Modify `src/main/usageScan.ts`: tag the existing Claude report as a Claude provider slice.
- Modify `src/main/usageScan.test.ts`: update type expectations and assert the Claude slice identity is preserved.
- Modify `src/main/ipc.ts`: scan Claude and Codex independently, isolate failures, merge slices, and place the Codex index in Electron user data.
- Modify `src/main/ipc.guard.test.ts`: assert combined results and one-provider failure containment.
- Modify `src/preload/preload.ts` and `src/renderer/global.d.ts` only if the report signature needs an explicit imported alias; keep the channel name `usage:report` unchanged.
- Modify `src/shared/usageFilter.ts` and `src/shared/usageFilter.test.ts`: preserve provider subtotals when deleted projects collapse.
- Modify `src/renderer/usageView.ts`: render cost cards, provider filter, partial states, provider-tagged models, and per-project breakdown.
- Modify `src/renderer/styles.css`: cost-card and provider-filter layout with narrow-window wrapping.
- Modify `src/renderer/locales/{ko,en,ja,zh}.json`: localized scope, filters, costs, partial state, and Antigravity explanation.
- Modify `src/shared/i18n.test.ts`: require the new keys across all locales.
- Modify `qa/screenshot.mjs` and `qa/audit.mjs`: deterministic combined-usage fixture, geometry checks, keyboard filter checks, and accessibility coverage.
- Modify `README.md`, `package.json`, and `package-lock.json`: document the new scope and publish the patch release.

---

### Task 1: Provider-Aware Pricing and Report Domain

**Files:**
- Create: `src/shared/localUsage.ts`
- Create: `src/shared/localUsage.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/usage.ts`
- Modify: `src/shared/usage.test.ts`

**Interfaces:**
- Produces: `LocalUsageProvider = 'claude' | 'codex'` and `LocalUsageFilter = 'all' | LocalUsageProvider`.
- Produces: `ProviderUsageSlice`, `ProviderUsageSummary`, provider-tagged `ModelUsage`, provider-aware `ProjectUsage`, and merged `UsageReport`.
- Produces: `emptyProviderUsage(providerId, state?)`, `combineProviderUsage(slices)`, and `selectProviderUsage(report, filter: LocalUsageFilter)`.
- Produces: `priceForProvider(providerId, model, now?)`, `estimateProviderCost(totals, card) -> { value, complete }`, and `normalizeCodexTotals(raw)`.
- Consumes: existing `UsageTotals`, `PriceCard`, `addTotals`, `estimateCost`, and `cwdKey` behavior.

- [ ] **Step 1: Write failing pricing tests**

Add tests that pin the documented Codex price cards and token normalization:

```ts
expect(priceForProvider('codex', 'gpt-5.6-sol')).toEqual({ input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
expect(priceForProvider('codex', 'gpt-5.6-terra')).toEqual({ input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 });
expect(priceForProvider('codex', 'gpt-5.6-luna')).toEqual({ input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 });
expect(priceForProvider('codex', 'gpt-5.5')?.input).toBe(5);
expect(priceForProvider('codex', 'gpt-5.4-mini')?.output).toBe(4.5);
expect(priceForProvider('codex', 'gpt-unknown')).toBeUndefined();
expect(normalizeCodexTotals({ input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 7 }))
  .toEqual({ input: 30, cacheRead: 60, cacheWrite: 10, output: 7 });
expect(estimateProviderCost({ input: 1, cacheRead: 0, cacheWrite: 1, output: 0 }, { input: 5, cacheRead: 0.5, cacheWrite: null, output: 30 }))
  .toEqual({ value: 0.000005, complete: false });
```

- [ ] **Step 2: Run the pricing tests and verify red**

Run: `npx vitest run src/shared/usage.test.ts`

Expected: FAIL because `priceForProvider` and `normalizeCodexTotals` do not exist.

- [ ] **Step 3: Implement provider-aware pricing**

Keep `priceFor(model, now)` as the Claude-compatible wrapper. Permit `PriceCard.cacheWrite` to be `null` in the provider-aware path and keep all existing Claude cards numeric. Add exact documented cards for the Codex models present in supported local history (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `gpt-5.4-mini`) plus explicit dated-snapshot/alias mappings only. Clamp malformed or overlapping Codex token fields so normalized totals remain finite and non-negative. Treat `reasoning_output_tokens` as informational because it is already included in `output_tokens`. If a model has no documented cache-write rate, `estimateProviderCost` prices the supported components and returns `complete: false` when cache-write tokens are non-zero, rather than inventing a rate.

- [ ] **Step 4: Write failing report-domain tests**

Cover two slices that share one canonical project path, provider-tagged models, separate subtotals, combined totals, unknown-price propagation, provider selection, and one `state: 'error'` slice. Assert:

```ts
const report = combineProviderUsage([claudeSlice, codexSlice]);
expect(report.globalCost).toBeCloseTo(12.5);
expect(report.byProvider.map((p) => [p.providerId, p.costEstimate])).toEqual([
  ['claude', 7.5],
  ['codex', 5],
]);
expect(report.byProject).toHaveLength(1);
expect(report.byProject[0].providerCosts).toEqual({ claude: 7.5, codex: 5 });
expect(selectProviderUsage(report, 'codex').globalCost).toBe(5);
```

- [ ] **Step 5: Run report tests and verify red**

Run: `npx vitest run src/shared/localUsage.test.ts`

Expected: FAIL because the report module does not exist.

- [ ] **Step 6: Implement the normalized report domain**

Use stable provider order `claude`, then `codex`. Merge projects by `cwdKey(path)`, keep the scanned display path/name, sum session counts and active time, merge daily rows by ISO day, and keep model rows distinct by `(providerId, model)`. A cost is `null` only when no record in that scope is priceable; `hasUnknownModel` independently marks partial estimates.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run src/shared/usage.test.ts src/shared/localUsage.test.ts`

Expected: PASS.

- [ ] **Step 8: Run type checking and commit**

Run: `npx tsc --noEmit`

Expected: PASS.

Commit:

```text
feat: define provider-aware local usage reports
```

---

### Task 2: Codex Usage Event Parser

**Files:**
- Create: `src/shared/codexUsageParse.ts`
- Create: `src/shared/codexUsageParse.test.ts`

**Interfaces:**
- Consumes: `normalizeCodexTotals` and `UsageTotals` from `src/shared/usage.ts`.
- Produces: `CodexUsageCursor { model, cumulative, seenFallbackKeys }`.
- Produces: `CodexUsageEntry { day, dayMs, timestampMs, model, totals }`.
- Produces: `initialCodexUsageCursor()` and `parseCodexUsageLine(line, cursor)` returning `{ cursor, entry, activityTimestampMs }`.

- [ ] **Step 1: Write failing parser tests**

Build JSONL fixtures containing `turn_context`, `event_msg/token_count`, `total_token_usage`, `last_token_usage`, user messages, corrupt lines, and model switches. Assert that:

```ts
expect(entries.map((e) => e.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
expect(entries[0].totals).toEqual({ input: 30, cacheRead: 60, cacheWrite: 10, output: 7 });
expect(entries[1].totals.output).toBe(4);
```

Add separate cases proving an identical cumulative notification emits no second entry, a cumulative decrease starts a new baseline from `last_token_usage`, an older last-only event is accepted once, invalid numbers are rejected, and reasoning tokens are not added twice.

- [ ] **Step 2: Run parser tests and verify red**

Run: `npx vitest run src/shared/codexUsageParse.test.ts`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement the state machine**

Parse one line at a time. Update the current model only from a bounded non-empty `turn_context.payload.model`. For token events, prefer non-negative component-wise deltas of `total_token_usage`; return no entry when every delta is zero. If totals decrease, normalize `last_token_usage` and replace the cumulative baseline. Use the event's validated timestamp to assign UTC `YYYY-MM-DD` buckets. Return activity timestamps for user, assistant, and completed token events without retaining their text.

- [ ] **Step 4: Run focused tests and refactor**

Run: `npx vitest run src/shared/codexUsageParse.test.ts src/shared/codexParse.test.ts`

Expected: PASS, including the existing cockpit-tail parser tests.

- [ ] **Step 5: Commit**

```text
feat: parse Codex rollout usage events
```

---

### Task 3: Incremental Codex Rollout Index

**Files:**
- Modify: `src/main/codexSessions.ts`
- Modify: `src/main/codexSessions.test.ts`
- Create: `src/main/codexUsageScan.ts`
- Create: `src/main/codexUsageScan.test.ts`

**Interfaces:**
- Consumes: `parseCodexUsageLine`, `CodexUsageCursor`, `activeMsFromTimestamps`, provider pricing, and canonical path helpers.
- Produces: `CodexRolloutHead { file, id, cwd, mtimeMs, birthtimeMs, size, firstMessage }` and `listCodexRolloutHeads(dir)`.
- Produces: `scanCodexUsage({ sessionsDir, cachePath, sinceMs, exists?, yieldNow? }): Promise<ProviderUsageSlice>`.
- Persists: versioned aggregate-only `CodexUsageIndex` with per-file offset, trailing partial line, cursor, day/model aggregate buckets, per-day active time/activity flags, one last-activity timestamp, and safe file metadata.

- [ ] **Step 1: Expose validated rollout heads under test**

Extend the existing session fixture tests to assert that `listCodexRolloutHeads(root)` returns the exact validated file, session ID, CWD, size, and timestamps while excluding malformed IDs, unrelated JSONL files, and unreadable entries.

- [ ] **Step 2: Run the session tests and verify red**

Run: `npx vitest run src/main/codexSessions.test.ts`

Expected: FAIL because the exported head API does not exist.

- [ ] **Step 3: Export the bounded rollout metadata**

Rename the private head enumeration behind the exported function and preserve every existing caller's bounded 64 KiB head behavior. Add `size` from the same `statSync` call; do not expose transcript contents.

- [ ] **Step 4: Write failing scanner tests**

Use temporary nested rollout directories and an explicit cache path. Cover:

- initial streaming scan produces a Codex slice with project/model/day/cost data;
- unchanged size/mtime reads the persisted digest without reparsing;
- append resumes from the saved byte offset and adds only the new delta;
- a partial final JSON line is retained and processed after the rest is appended;
- truncation or file replacement rebuilds only that file;
- corrupt/wrong-version cache rebuilds safely;
- missing sessions directory returns an empty ready Codex slice;
- a missing project path receives `status: 'deleted'`;
- two records separated by more than five minutes exclude the idle gap;
- a supplied `yieldNow` callback runs during a multi-chunk scan.

Instrument test dependencies with `onBytesRead` and assert an append scan reads fewer bytes than the complete file.

- [ ] **Step 5: Run scanner tests and verify red**

Run: `npx vitest run src/main/codexUsageScan.test.ts`

Expected: FAIL because `scanCodexUsage` does not exist.

- [ ] **Step 6: Implement streaming and incremental persistence**

Read fixed-size byte chunks from each validated rollout. Prepend the saved trailing bytes, split only complete newline-delimited records, and pass each complete line to the pure parser. Store compact `(day, model)` totals, per-day active milliseconds/activity flags, and only the last activity timestamp needed to continue the five-minute gap calculation. Resume only when identity, size, mtime progression, schema version, and stored offset are consistent; otherwise rebuild the file digest. Range filtering counts a session once when any retained day in the range has activity.

Write the complete JSON index to `<cachePath>.tmp`, close it, then rename it over `cachePath`. Bound the retained partial tail and reject an index entry whose arrays or strings exceed the declared limits. Yield with `setImmediate` between chunks by default.

- [ ] **Step 7: Run scanner and regression tests**

Run: `npx vitest run src/main/codexUsageScan.test.ts src/main/codexSessions.test.ts src/shared/codexUsageParse.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```text
feat: index Codex usage incrementally
```

---

### Task 4: Combine Claude and Codex in Usage IPC

**Files:**
- Modify: `src/main/usageScan.ts`
- Modify: `src/main/usageScan.test.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/ipc.guard.test.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/global.d.ts`

**Interfaces:**
- Consumes: `scanUsage`, `scanCodexUsage`, `combineProviderUsage`, `emptyProviderUsage`, `CODEX_SESSIONS`, and Electron `app.getPath('userData')`.
- Produces: unchanged `window.devdeck.usageReport(sinceMs): Promise<UsageReport>` channel with a provider-aware payload.

- [ ] **Step 1: Write failing Claude-slice tests**

Update the existing scanner assertions to require:

```ts
expect(r.providerId).toBe('claude');
expect(r.state).toBe('ready');
expect(r.byModel[0].providerId).toBe('claude');
```

- [ ] **Step 2: Run Claude scanner tests and verify red**

Run: `npx vitest run src/main/usageScan.test.ts`

Expected: FAIL because the existing report is not provider-tagged.

- [ ] **Step 3: Adapt the Claude scanner**

Return a `ProviderUsageSlice` without changing parsing, caching, pricing, active-time, or deleted-project behavior. Tag every model row with `providerId: 'claude'`.

- [ ] **Step 4: Write failing IPC containment tests**

Inject scanner dependencies in the IPC test seam and assert:

```ts
expect(report.byProvider.map((p) => p.providerId)).toEqual(['claude', 'codex']);
expect(report.globalCost).toBe(claudeCost + codexCost);
```

Add one case where the Codex scanner rejects and assert the returned report still contains Claude totals plus a Codex `state: 'error'` summary. Add the symmetric Claude failure case. Assert no live-usage handler or footer snapshot contract changes.

- [ ] **Step 5: Run IPC tests and verify red**

Run: `npx vitest run src/main/ipc.guard.test.ts`

Expected: FAIL because `usage:report` invokes only Claude scanning.

- [ ] **Step 6: Combine independent scans in the handler**

Run both adapters with `Promise.allSettled`. Convert a rejected adapter to `emptyProviderUsage(providerId, 'error')`, merge both slices, and return the report. Use `join(app.getPath('userData'), 'codex-usage-index.json')` for the aggregate cache. Preserve the existing input validation for `sinceMs` and keep `usage:snapshot`/`usage:refresh` untouched.

- [ ] **Step 7: Run focused and type tests**

Run: `npx vitest run src/main/usageScan.test.ts src/main/codexUsageScan.test.ts src/main/ipc.guard.test.ts`

Run: `npx tsc --noEmit`

Expected: both commands PASS.

- [ ] **Step 8: Commit**

```text
feat: combine Claude and Codex usage reports
```

---

### Task 5: Provider-Aware Usage Page

**Files:**
- Modify: `src/shared/usageFilter.ts`
- Modify: `src/shared/usageFilter.test.ts`
- Modify: `src/renderer/usageView.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `UsageReport`, `selectProviderUsage`, provider logos, localized strings, existing chart helpers, and existing project filters.
- Produces: renderer state `activeUsageProvider: 'all' | LocalUsageProvider` and a deterministic `devdeck:local-usage-report` QA event seam.

- [ ] **Step 1: Write failing deleted-project breakdown tests**

Create deleted rows with Claude-only, Codex-only, and mixed `providerCosts`, then assert the collapsed group preserves both subtotals and the combined cost while propagating partial-estimate flags.

- [ ] **Step 2: Run filter tests and verify red**

Run: `npx vitest run src/shared/usageFilter.test.ts`

Expected: FAIL because deleted aggregation drops provider subtotals.

- [ ] **Step 3: Preserve provider detail in filtering helpers**

Sum provider costs independently, keep `null` distinct from zero, and preserve provider session/token detail needed by the selected-provider table.

- [ ] **Step 4: Implement the cost-first renderer**

Replace the Claude-only heading with the approved scope. Add an accessible provider segmented control after the date chips. In the All view, always render three leading cards: combined, Claude, Codex. Append a localized partial marker when `hasUnknownModel` is true and use `—` when no model in that scope is priceable.

Render the remaining stats, model legend, daily chart, and rows from `selectProviderUsage(report, activeUsageProvider)`. In All rows, show the main combined amount plus a provider subline only when both providers contributed. Use `createProviderLogo` and `providerName`; do not inject provider names or model labels with `innerHTML`.

Listen for `devdeck:local-usage-report` only as a deterministic QA seam: its validated `detail.report` replaces the displayed report without changing IPC or production load behavior.

- [ ] **Step 5: Add responsive styles**

Add `.usage-provider-filter`, `.usage-cost-cards`, `.usage-cost-card`, `.usage-cost-breakdown`, and `.usage-partial` styles. Allow cards and toolbar controls to wrap below 720 px, keep focus outlines visible, and avoid horizontal page overflow. Preserve the existing table's scroll/width behavior.

- [ ] **Step 6: Run focused checks**

Run: `npx vitest run src/shared/localUsage.test.ts src/shared/usageFilter.test.ts`

Run: `npx tsc --noEmit`

Run: `npm run build`

Expected: all commands PASS.

- [ ] **Step 7: Commit**

```text
feat: show Claude and Codex costs together
```

---

### Task 6: Localization and End-to-End UI Verification

**Files:**
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/shared/i18n.test.ts`
- Modify: `qa/screenshot.mjs`
- Modify: `qa/audit.mjs`

**Interfaces:**
- Consumes: the renderer's `devdeck:local-usage-report` event seam.
- Produces: localized cost-page strings and repeatable visual/accessibility assertions with no provider credentials.

- [ ] **Step 1: Add failing locale-key assertions**

Require these concepts in all four locale files: combined local analytics title, local-record explanation, All/Claude/Codex provider filters, combined estimate, provider estimates, partial estimate, unknown-price explanation, provider failure, project provider breakdown, and Antigravity exclusion.

- [ ] **Step 2: Run locale tests and verify red**

Run: `npx vitest run src/shared/i18n.test.ts`

Expected: FAIL with the missing usage keys.

- [ ] **Step 3: Add all translations**

Use natural concise UI language. Korean source wording must include `전체 예상 비용`, `Claude Code`, `Codex`, `API 환산 예상 비용`, `일부 모델 제외`, and a direct statement that Antigravity lacks stable token/model records for this analysis.

- [ ] **Step 4: Add deterministic QA coverage**

Inject a report containing one shared project, one Claude-only project, one Codex-only project, known and unknown models, both provider costs, and 30 daily buckets. Assert:

- three cost cards are visible together;
- the combined displayed value equals the fixture's Claude plus Codex values;
- activating the Codex filter with keyboard changes detail rows while retaining the three headline cards;
- provider logos load;
- no cost card or toolbar overflows at the QA viewport;
- the footer geometry and All usage dialog snapshots remain unchanged;
- all four language screenshots render without console or page errors.

Extend the accessibility audit to the populated Usage page and require zero axe violations.

- [ ] **Step 5: Run localization and QA**

Run: `npx vitest run src/shared/i18n.test.ts`

Run: `npm run qa`

Run: `npm run qa:audit`

Expected: all commands PASS; screenshots include the populated combined analytics page in four languages, console errors are 0, page errors are 0, and axe violations are 0.

- [ ] **Step 6: Commit**

```text
test: verify combined local usage analytics
```

---

### Task 7: Documentation, Version, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/screenshots/usage.png` with the verified populated combined-analytics capture.

**Interfaces:**
- Consumes: the completed provider-aware Usage page and repository release scripts.
- Produces: patch-version release documentation and verified installer artifacts.

- [ ] **Step 1: Update user documentation**

Change the Usage feature description from Claude-only to Claude + Codex local analytics. State that one page shows combined and separate API-equivalent estimates, local records stay on-device, unknown models make totals partial, Antigravity is excluded from cost analytics, and live provider limits remain in the unchanged footer/dialog.

- [ ] **Step 2: Bump the patch version**

Increment `1.29.3` to `1.29.4` in `package.json` and `package-lock.json`. Do not change dependency versions.

- [ ] **Step 3: Run complete verification from a clean build**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run build`

Run: `npm run qa`

Run: `npm run qa:audit`

Run: `git diff --check`

Expected: the full Vitest suite passes, TypeScript emits no errors, production build passes, QA and accessibility pass with zero console/page/axe errors, and diff check reports no whitespace errors.

- [ ] **Step 4: Build the Windows installer**

Run: `npm run dist:installer`

Expected: `release/DevDeck-1.29.4-Setup.exe` exists and has non-zero size. Record its SHA-256 checksum with `Get-FileHash`.

- [ ] **Step 5: Review the final diff and commit**

Confirm that `src/renderer/usageBar.ts`, `src/renderer/usageModal.ts`, `src/main/usageProviders.ts`, and `src/main/codexUsage.ts` have no behavior changes.

Commit:

```text
chore: release v1.29.4
```

---

### Task 8: Integration and Deployment

**Files:**
- No source changes expected; release metadata is produced by the existing GitHub workflows.

**Interfaces:**
- Consumes: verified feature branch, repository CI workflow, and release workflow.
- Produces: merged `main`, tag `v1.29.4`, public latest GitHub release, and platform artifacts.

- [ ] **Step 1: Perform final implementation self-review**

Review the complete branch against every Success Criterion in the design. Check parser correctness, cache invalidation, cost completeness, privacy boundaries, provider failure containment, keyboard behavior, narrow layout, and unchanged footer files. Fix any finding with a focused failing test and rerun the affected suite.

- [ ] **Step 2: Re-run the verification gate after review fixes**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run build`

Run: `npm run qa`

Run: `npm run qa:audit`

Expected: every command PASS on the reviewed commit.

- [ ] **Step 3: Integrate the feature branch**

Fast-forward or merge the verified feature branch into `main` according to repository state, without discarding unrelated work. Confirm `git status --short --branch` is clean and `git log -1` identifies the release commit.

- [ ] **Step 4: Push and verify CI**

Push `main` to `origin`, monitor the repository CI run, and require successful Windows, macOS, Linux, and accessibility jobs before release publication.

- [ ] **Step 5: Tag and publish v1.29.4**

Create and push tag `v1.29.4` only after CI succeeds. Monitor the release workflow, ensure a draft is published if the workflow leaves one, and mark it latest.

- [ ] **Step 6: Verify public assets**

Confirm the public release contains Windows setup and blockmap/update metadata, macOS x64 and arm64 DMGs plus metadata, and Linux AppImage/deb plus metadata. Confirm the public Windows installer URL responds and record the published artifact digest.
