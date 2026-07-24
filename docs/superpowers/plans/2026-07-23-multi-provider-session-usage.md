# Multi-provider Sessions and Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every cockpit session retain and display its own AI provider, and replace the Claude-only footer with a compact all-provider live-limit experience for Claude Code, Codex, and Antigravity.

**Architecture:** Deliver this as two sequential, independently reviewable milestones. First, make existing-session operations explicitly provider-scoped and centralize renderer presentation of provider identity. Second, introduce a normalized usage domain, provider adapters, isolated caching/orchestration, and a fixed overlay UI; the existing local analytics page remains Claude-only.

**Tech Stack:** Electron 43 IPC/context bridge, TypeScript 5.5, DOM/CSS renderer, Node.js child processes and HTTPS, Vitest 3, Playwright Electron QA, axe-core.

## Global Constraints

- The cockpit sidebar remains exactly `250px` wide.
- The footer remains exactly `26px` high and opening usage details must not change shell, cockpit, or xterm dimensions.
- Existing-session restore, restart, sibling creation, metadata, session-ID lookup, and drift detection always use the session's stored `AgentId`; only a project-surface launch may use the globally selected agent.
- Provider marks are bundled local SVG assets; no renderer network request is allowed and the existing `connect-src 'none'` CSP remains unchanged.
- Long session names use a two-line clamp and expose the complete name on both pointer hover and keyboard focus.
- Claude limits include legacy windows, every validated dynamic limit, model-scoped limits such as Fable, and Usage Credits when present; Fable is not hardcoded.
- Codex usage uses the installed official `codex app-server` and `account/rateLimits/read`; DevDeck does not read or export Codex credentials.
- Antigravity performs no quota network request and shows only documented `/usage` (`/quota`) and `/credits` guidance.
- Provider failures are isolated; last-good data becomes `stale`, and a refresh already in flight is reused.
- Authentication material never crosses IPC. Renderer data is limited to provider, plan, normalized windows, credit summary, state, freshness, and guidance.
- All new visible strings and accessible names are present in Korean, English, Japanese, and Chinese.
- The existing analytics page is labeled “Claude Code local analytics” and is not presented as cross-provider accounting.

---

## Milestone 1: Provider-correct sessions and provider presentation

### Task 1: Validate provider IDs and scope cockpit IPC to the requested provider

**Files:**
- Create: `src/shared/agents.ts`
- Create: `src/shared/agents.test.ts`
- Modify: `src/shared/cockpitPersist.ts:1-115`
- Modify: `src/shared/cockpitPersist.test.ts:35-50`
- Modify: `src/main/ipc.ts:96-100,301-388`
- Modify: `src/main/ipc.cockpit.test.ts:1-99`
- Modify: `src/main/ipc.guard.test.ts:120-140`

**Interfaces:**
- Produces: `isAgentId(value: unknown): value is AgentId` and `normalizeAgentId(value: unknown, fallback?: AgentId): AgentId`.
- Changes cockpit request signatures to `open({ agentId, projectPath, sessionId, cols, rows, fresh })`, `sessionMeta(agentId, projectPath, sessionId)`, `sessionIds(agentId, projectPath)`, and `liveSessionId(agentId, projectPath, opts)`.
- Preserves: invalid persisted `agentId` values normalize to Claude; invalid IPC `agentId` values return the handler's neutral/refusal shape and never select a provider.

- [ ] **Step 1: Write provider normalization tests**

```ts
import { describe, expect, it } from 'vitest';
import { isAgentId, normalizeAgentId } from './agents';

describe('agent IDs', () => {
  it.each(['claude', 'codex', 'antigravity'] as const)('accepts %s', (id) => {
    expect(isAgentId(id)).toBe(true);
    expect(normalizeAgentId(id)).toBe(id);
  });
  it('rejects untrusted values and applies an explicit fallback', () => {
    expect(isAgentId('weird')).toBe(false);
    expect(isAgentId(null)).toBe(false);
    expect(normalizeAgentId('weird')).toBe('claude');
    expect(normalizeAgentId(undefined, 'codex')).toBe('codex');
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the new module is missing**

Run: `npx vitest run src/shared/agents.test.ts`

Expected: FAIL because `./agents` cannot be resolved.

- [ ] **Step 3: Implement the shared guard and reuse it for persistence**

```ts
import type { AgentId } from './types';

const AGENT_IDS = new Set<AgentId>(['claude', 'codex', 'antigravity']);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_IDS.has(value as AgentId);
}

export function normalizeAgentId(value: unknown, fallback: AgentId = 'claude'): AgentId {
  return isAgentId(value) ? value : fallback;
}
```

Import `normalizeAgentId` in `cockpitPersist.ts`, change `PersistedSession.agentId` to `AgentId`, and assign `agentId: normalizeAgentId(o.agentId)` inside `sanitizePersistedList`.

- [ ] **Step 4: Write failing IPC tests proving global-provider changes cannot affect a requested session**

Extend the hoisted mocks with `getProvider` spies or provider method spies, then cover all three providers:

```ts
it('uses the request agent for session IDs after the global agent changes', () => {
  storedAgent = 'claude';
  const ids = handlers.get('cockpit:sessionIds')!;
  expect(ids(null, 'codex', projectPath)).toEqual(codexIds);
});

it('uses the request agent for drift detection', () => {
  storedAgent = 'antigravity';
  handlers.get('cockpit:liveSessionId')!(null, 'claude', projectPath, opts);
  expect(claudeStats).toHaveBeenCalledOnce();
  expect(codexStats).not.toHaveBeenCalled();
});

it.each(['weird', null, 7])('rejects invalid provider %j', (agentId) => {
  expect(handlers.get('cockpit:sessionIds')!(null, agentId, projectPath)).toEqual([]);
  expect(handlers.get('cockpit:sessionMeta')!(null, agentId, projectPath, 'sid'))
    .toEqual({ model: null, activeMs: 0, contextTokens: 0 });
  expect(handlers.get('cockpit:liveSessionId')!(null, agentId, projectPath, opts)).toBeNull();
});
```

Add an open-handler test with a fake `ptyHost.create` and provider mocks asserting that `{ agentId: 'codex' }` builds a Codex command even while `storedAgent === 'claude'`.

- [ ] **Step 5: Update the IPC handlers to validate and select explicitly**

Use this pattern in each handler:

```ts
if (!isAgentId(agentId)) return neutralResult;
const provider = getProvider(agentId);
```

For `cockpit:open`, make `agentId` required and use `provider` for both session discovery and `resolveOpenSession`. Return `{ id: '', agentId: 'claude', sessionId: null }` for an invalid ID without spawning a PTY. For metadata, call `readClaudeSessionMeta` only when `agentId === 'claude'`; other providers return the neutral metadata object. For drift, choose Claude stats for `claude`, Codex stats for `codex`, and `null` for Antigravity.

- [ ] **Step 6: Run the provider, persistence, cockpit IPC, and guard tests**

Run: `npx vitest run src/shared/agents.test.ts src/shared/cockpitPersist.test.ts src/main/ipc.cockpit.test.ts src/main/ipc.guard.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the provider-scoped main-process slice**

```bash
git add src/shared/agents.ts src/shared/agents.test.ts src/shared/cockpitPersist.ts src/shared/cockpitPersist.test.ts src/main/ipc.ts src/main/ipc.cockpit.test.ts src/main/ipc.guard.test.ts
git commit -m "fix(cockpit): scope session IPC to its provider"
```

### Task 2: Preserve provider identity through renderer open, restore, restart, and sibling flows

**Files:**
- Modify: `src/preload/preload.ts:56-72`
- Modify: `src/renderer/global.d.ts:56-72`
- Modify: `src/renderer/cockpitView.ts:17-18,270-355,537-698`
- Modify: `src/shared/cockpitPersist.test.ts:155-185`
- Modify: `src/shared/cockpitModel.ts`
- Modify: `src/shared/cockpitModel.test.ts`

**Interfaces:**
- Consumes: validated `AgentId` request arguments from Task 1.
- Produces: `OpenReq.agentId?: AgentId`; `createSession` resolves `p.agentId ?? await window.devdeck.getAgent()` exactly once for a project-surface launch.
- Guarantees: restore/restart/sibling requests always carry a concrete provider, while a deck/task launch with no session context uses the current global provider.

- [ ] **Step 1: Add a pure provider-selection helper and failing tests**

Add to `cockpitModel.ts`:

```ts
export function providerForOpen(requestAgent: AgentId | undefined, selectedAgent: AgentId): AgentId {
  return requestAgent ?? selectedAgent;
}
```

Test:

```ts
expect(providerForOpen('codex', 'claude')).toBe('codex');
expect(providerForOpen(undefined, 'antigravity')).toBe('antigravity');
```

Run: `npx vitest run src/shared/cockpitModel.test.ts`

Expected: FAIL because `providerForOpen` is not exported.

- [ ] **Step 2: Implement the helper and update context-bridge types**

Change all cockpit bridge signatures to carry `AgentId` as the first/provider field:

```ts
open(req: { agentId: AgentId; projectPath: string; sessionId: string | null; cols: number; rows: number; fresh?: boolean }): Promise<OpenResult>;
sessionMeta(agentId: AgentId, projectPath: string, sessionId: string): Promise<SessionMetaResult>;
sessionIds(agentId: AgentId, projectPath: string): Promise<string[]>;
liveSessionId(agentId: AgentId, projectPath: string, opts: DriftOptions): Promise<string | null>;
```

Mirror the exact signatures in `preload.ts` and `global.d.ts`.

- [ ] **Step 3: Thread the provider through every renderer flow**

In `createSession`, resolve once before opening:

```ts
const agentId = providerForOpen(p.agentId, await window.devdeck.getAgent());
const res = await window.devdeck.cockpit.open({
  agentId, projectPath: p.path, sessionId: p.sessionId ?? null,
  cols: term.cols, rows: term.rows, fresh: p.fresh,
});
```

Pass `agentId` to `sessionMeta`, `sessionIds`, and `liveSessionId`. Construct restore, restart, and sibling requests with `agentId`:

```ts
await createSession({ ...projectFields, agentId: r.agentId, sessionId: restoredId });
await createSession({ ...projectFields, agentId: s.agentId, fresh: true });
const restartReq: OpenReq = { ...projectFields, agentId: l.session.agentId, sessionId: l.openedSessionId };
```

Restart must include `openedSessionId`; otherwise it can regress to provider-specific “continue latest” behavior.

- [ ] **Step 4: Add regression assertions for provider and session ID preservation**

Extend the pure persistence tests so a stored Codex session resolves to its own valid ID and retains `agentId: 'codex'`. Add a source-level IPC surface assertion in `ipc.cockpit.test.ts` that renderer requests list every provider field; do not test private renderer functions directly in the Node Vitest environment.

- [ ] **Step 5: Run focused tests and the TypeScript build**

Run: `npx vitest run src/shared/cockpitModel.test.ts src/shared/cockpitPersist.test.ts src/main/ipc.cockpit.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with preload and renderer signatures aligned.

- [ ] **Step 6: Commit provider preservation across the renderer**

```bash
git add src/preload/preload.ts src/renderer/global.d.ts src/renderer/cockpitView.ts src/shared/cockpitModel.ts src/shared/cockpitModel.test.ts src/shared/cockpitPersist.test.ts
git commit -m "fix(cockpit): preserve provider across session actions"
```

### Task 3: Add bundled provider logos and the compact two-line sidebar layout

**Files:**
- Create: `src/assets/provider-claude.svg`
- Create: `src/assets/provider-codex.svg`
- Create: `src/assets/provider-antigravity.svg`
- Create: `src/renderer/providerPresentation.ts`
- Create: `src/shared/providerPresentation.ts`
- Create: `src/shared/providerPresentation.test.ts`
- Modify: `src/renderer/cockpitView.ts:537-679`
- Modify: `src/renderer/styles.css:411-518`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `qa/screenshot.mjs:150-205`

**Interfaces:**
- Produces: `providerPresentation(agentId): { nameKey: string; logoSrc: string }` and renderer `createProviderLogo(agentId, className?): HTMLImageElement`.
- Presentation registry is exhaustive over `Record<AgentId, ProviderPresentation>` and uses only `./assets/provider-*.svg` paths.
- Live rows, previous rows, and the selected header use the same logo helper and localized accessible name.

- [ ] **Step 1: Write the exhaustive presentation registry test**

```ts
import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESENTATION } from './providerPresentation';

it('defines a local SVG and i18n name for every provider', () => {
  expect(Object.keys(PROVIDER_PRESENTATION).sort()).toEqual(['antigravity', 'claude', 'codex']);
  for (const item of Object.values(PROVIDER_PRESENTATION)) {
    expect(item.logoSrc).toMatch(/^\.\/assets\/provider-[a-z]+\.svg$/);
    expect(item.nameKey).toMatch(/^agent\./);
  }
});
```

Run: `npx vitest run src/shared/providerPresentation.test.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 2: Add the registry, renderer helper, and local SVG marks**

Use an exhaustive registry:

```ts
export interface ProviderPresentation { nameKey: string; logoSrc: string; }

export const PROVIDER_PRESENTATION: Record<AgentId, ProviderPresentation> = {
  claude: { nameKey: 'agent.claude', logoSrc: './assets/provider-claude.svg' },
  codex: { nameKey: 'agent.codex', logoSrc: './assets/provider-codex.svg' },
  antigravity: { nameKey: 'agent.antigravity', logoSrc: './assets/provider-antigravity.svg' },
};
```

The renderer helper creates an `<img>`, sets `src`, `alt = tr(nameKey)`, `title = tr(nameKey)`, and the requested CSS class. Draw each mark with a `24×24` SVG `viewBox`, transparent background, and `currentColor`-independent fixed fills that remain legible on `#101218`. Do not embed remote images, scripts, fonts, or data URLs.

- [ ] **Step 3: Replace provider text with the common logo component**

Build row DOM in this order: `.ck-ind`, `.provider-logo`, `.ck-row-main`, action overlay. Remove `${s.agentId}` from live metadata and `${r.agentId}` from previous metadata. Replace the header's `✦ ${s.agentId}` pill with the same provider image plus a visually hidden localized provider name.

For every non-editing name, set:

```ts
const fullName = liveLabels.get(s.id) ?? s.name;
nm.textContent = fullName;
nm.tabIndex = 0;
nm.dataset.fullName = fullName;
nm.setAttribute('aria-label', fullName);
```

Apply the same behavior to previous rows and the header title.

- [ ] **Step 4: Implement the fixed-width layout and focus-visible full-name tooltip**

Use these layout rules as the basis of the CSS change:

```css
.ck-list { width: 250px; flex: 0 0 250px; }
.ck-row { position: relative; display: grid; grid-template-columns: 14px 22px minmax(0, 1fr); column-gap: 7px; }
.ck-provider-logo { width: 20px; height: 20px; align-self: start; }
.ck-row-main { min-width: 0; }
.ck-row .nm {
  display: -webkit-box; min-width: 0; overflow: hidden; overflow-wrap: anywhere;
  -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
}
.ck-row-acts, .ck-prev-acts {
  position: absolute; inset-inline-end: 4px; top: 50%; transform: translateY(-50%);
  opacity: 0; pointer-events: none;
  background: linear-gradient(90deg, transparent, #101218 24%);
}
.ck-row:hover .ck-row-acts, .ck-row:focus-within .ck-row-acts,
.ck-row:hover .ck-prev-acts, .ck-row:focus-within .ck-prev-acts { opacity: 1; pointer-events: auto; }
.ck-row .nm:hover::after, .ck-row .nm:focus-visible::after {
  content: attr(data-full-name); position: fixed; z-index: 80; max-width: 360px;
}
```

Position the tooltip from `getBoundingClientRect()` using CSS custom properties set on pointer/focus, so `position: fixed` does not clip inside `.ck-list`. The tooltip must have a solid background, border, padding, and `pointer-events: none`. Do not increase sidebar width or add a marquee.

- [ ] **Step 5: Add localized provider accessible names and QA geometry checks**

Ensure `agent.claude`, `agent.codex`, and `agent.antigravity` exist in all four locale files. Extend `qa/screenshot.mjs` to inject representative live and previous row markup with a 70-character ASCII name and an unbroken CJK name, then assert:

```js
const sidebarWidth = Math.round(document.querySelector('.ck-list').getBoundingClientRect().width);
const lineHeight = parseFloat(getComputedStyle(document.querySelector('.ck-row .nm')).lineHeight);
const nameHeight = document.querySelector('.ck-row .nm').getBoundingClientRect().height;
return { sidebarWidth, twoLines: nameHeight <= lineHeight * 2 + 1, logos: document.querySelectorAll('.ck-provider-logo').length };
```

Expected: width `250`, two-line clamp `true`, and provider logos present in live/previous/header fixtures. Capture `cockpit-provider-sidebar.png` and `cockpit-provider-tooltip.png`.

- [ ] **Step 6: Run registry tests, build, and screenshot QA**

Run: `npx vitest run src/shared/providerPresentation.test.ts src/shared/cockpitModel.test.ts`

Run: `npm run build`

Run: `node qa/screenshot.mjs`

Expected: all commands PASS; sidebar and tooltip screenshots show no name/action overlap.

- [ ] **Step 7: Commit provider presentation and sidebar UX**

```bash
git add src/assets/provider-*.svg src/shared/providerPresentation.ts src/shared/providerPresentation.test.ts src/renderer/providerPresentation.ts src/renderer/cockpitView.ts src/renderer/styles.css src/renderer/locales qa/screenshot.mjs
git commit -m "feat(cockpit): show provider logos in compact session rows"
```

---

## Milestone 2: All-provider live usage

### Task 4: Define the normalized usage domain and parse Claude's dynamic limits

**Files:**
- Replace: `src/shared/usageWindows.ts`
- Replace: `src/shared/usageWindows.test.ts`
- Modify: `src/main/claudeUsage.ts:1-116`
- Modify: `src/main/claudeUsage.test.ts:1-100`

**Interfaces:**
- Produces: `UsageProviderState`, `UsageLimit`, `UsageCredits`, `ProviderUsage`, `UsageSnapshot`, `parseClaudeUsageResponse`, `clampPercent`, `parseResetTime`, and `usageSeverity`.
- `ProviderUsage` contains `providerId`, `state`, `planLabel`, `limits`, `credits`, `guidance`, `fetchedAt`, and optional `staleSince`.
- Claude adapter returns a provider result rather than the old `{ enabled, data/error }` union.

- [ ] **Step 1: Write normalized-domain and Claude parser tests**

Use an exact shared model:

```ts
export type UsageProviderState = 'ready' | 'stale' | 'login-required' | 'expired' |
  'not-applicable' | 'cli-missing' | 'offline' | 'rate-limited' | 'unsupported';
export type UsageLimitKind = 'session' | 'weekly' | 'model-weekly' | 'primary' | 'secondary';
export interface UsageLimit {
  id: string; kind: UsageLimitKind; label: string; percent: number | null;
  resetAt: number | null; modelLabel: string | null;
}
export interface UsageCredits {
  hasCredits: boolean | null; balance: number | null; spent: number | null; currency: string | null;
}
export interface ProviderUsage {
  providerId: AgentId; state: UsageProviderState; planLabel: string | null;
  limits: UsageLimit[]; credits: UsageCredits | null;
  guidance: { commands: string[] } | null; fetchedAt: number; staleSince?: number;
}
export interface UsageSnapshot { providers: ProviderUsage[]; fetchedAt: number; }
```

Test legacy `five_hour`/`seven_day`; dynamic `limits` with general and model display names; a Fable-scoped entry; two different model entries; `extra_usage`/spend credits; absent fields; labels over 80 characters; `NaN`, `Infinity`, `-5`, and `130` percentages; invalid reset timestamps; and a non-object response. Assert model limits are data-driven and no Fable row appears when the response omits it.

- [ ] **Step 2: Run parser tests and verify they fail against the legacy model**

Run: `npx vitest run src/shared/usageWindows.test.ts src/main/claudeUsage.test.ts`

Expected: FAIL because normalized usage fields and dynamic Claude parsing do not exist.

- [ ] **Step 3: Implement strict normalization helpers**

```ts
export function clampPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value))) : null;
}

export function parseResetTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeUsageLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback;
}
```

Deduplicate limits by stable `id`; preserve legacy IDs `claude:session` and `claude:weekly`; derive dynamic IDs from the server kind plus a sanitized model/name discriminator.

- [ ] **Step 4: Migrate Claude fetching, cache behavior, and errors**

Rename `getUsageWindows` to `getClaudeUsage`. Return `login-required` for missing credentials, `expired` for expired/401 without cache, `not-applicable` for API/custom endpoint modes, `rate-limited` for 429, and `offline` for other failures. When a last-good entry exists, return the same data with `state: 'stale'`, `staleSince: cached.fetchedAt`, and a fresh attempt timestamp; never silently label stale data as ready.

Keep the OAuth token entirely inside `fetchUsageApi`. Add a `MAX_RESPONSE_BYTES = 256 * 1024` guard that destroys the request and returns failure when exceeded.

- [ ] **Step 5: Run the shared and Claude adapter tests**

Run: `npx vitest run src/shared/usageWindows.test.ts src/main/claudeUsage.test.ts`

Expected: PASS, including dynamic Fable and credit cases.

- [ ] **Step 6: Commit the normalized usage model and Claude adapter**

```bash
git add src/shared/usageWindows.ts src/shared/usageWindows.test.ts src/main/claudeUsage.ts src/main/claudeUsage.test.ts
git commit -m "feat(usage): normalize Claude limits and model quotas"
```

### Task 5: Implement the bounded Codex app-server rate-limit client

**Files:**
- Create: `src/main/codexUsage.ts`
- Create: `src/main/codexUsage.test.ts`

**Interfaces:**
- Consumes: normalized `ProviderUsage` types from Task 4.
- Produces: `getCodexUsage(deps: CodexUsageDeps): Promise<ProviderUsage>` and `parseCodexRateLimits(value, now): ProviderUsage | null`.
- Process contract: spawn `codex app-server`, send newline-delimited JSON-RPC initialize/initialized/read messages, cap output, time out, and terminate exactly once.

- [ ] **Step 1: Write parser tests for official rate-limit snapshots**

Cover primary and secondary windows, `planType`, credits with finite balance, unlimited credits, API-key/no-subscription mode, missing windows, malformed percentages, and invalid reset timestamps. Assert output labels are `Primary` and `Secondary`, kinds are `primary` and `secondary`, and unknown response fields never cross the normalized boundary.

- [ ] **Step 2: Write fake-process protocol tests**

Use `PassThrough` streams and a fake child with a `kill` spy. Verify these exact messages are written in order:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"devdeck","version":"1.22.0"}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}
```

Feed interleaved notifications and responses in split chunks. Also test missing CLI (`ENOENT`), initialize timeout, read timeout, stderr noise, malformed JSON lines, output exceeding `256 KiB`, early exit, and cleanup after success/failure. Every test must assert `kill` is called at most once and listeners/timers are cleared.

- [ ] **Step 3: Run the Codex tests and verify the module is missing**

Run: `npx vitest run src/main/codexUsage.test.ts`

Expected: FAIL because `codexUsage.ts` does not exist.

- [ ] **Step 4: Implement the JSON-RPC state machine**

Define constants `STARTUP_TIMEOUT_MS = 8_000`, `REQUEST_TIMEOUT_MS = 12_000`, and `MAX_OUTPUT_BYTES = 256 * 1024`. Parse stdout by newline, ignore notifications and unrelated IDs, send `initialized` only after response ID `1`, and resolve only from response ID `2`. A single `finish(result)` function clears both timers, removes stream listeners, closes stdin, and kills the child if still alive.

Map `ENOENT` to `cli-missing`, auth/login errors to `login-required`, modes without subscription windows to `not-applicable`, timeout/early exit/malformed output to `offline`, and a valid snapshot to `ready`.

- [ ] **Step 5: Run the Codex tests**

Run: `npx vitest run src/main/codexUsage.test.ts`

Expected: PASS for parsing, mixed notifications, timeout, cap, and deterministic cleanup.

- [ ] **Step 6: Commit the Codex usage adapter**

```bash
git add src/main/codexUsage.ts src/main/codexUsage.test.ts
git commit -m "feat(usage): read Codex app-server rate limits"
```

### Task 6: Add provider orchestration, per-provider stale cache, deduplication, and IPC

**Files:**
- Create: `src/main/usageProviders.ts`
- Create: `src/main/usageProviders.test.ts`
- Modify: `src/main/ipc.ts:28,415-434`
- Modify: `src/preload/preload.ts:31-33`
- Modify: `src/renderer/global.d.ts:35-39`
- Modify: `src/main/ipc.guard.test.ts`

**Interfaces:**
- Consumes: `getClaudeUsage`, `getCodexUsage`, `availableAgents`, and normalized shared types.
- Produces: `UsageCoordinator.cached(installed: AgentId[]): UsageSnapshot | null`, `UsageCoordinator.refresh(installed: AgentId[], force?: boolean): Promise<UsageSnapshot>`, IPC `usage:snapshot`, and IPC `usage:refresh({ force?: boolean })`.
- Antigravity adapter always returns `unsupported` with commands `['/usage', '/quota', '/credits']` and performs no I/O.

- [ ] **Step 1: Write orchestration tests**

Test all providers launching concurrently; one provider failure not rejecting the snapshot; only installed providers included; stable display order Claude/Codex/Antigravity; a second call during refresh returning the same promise; cached data returned before the five-minute TTL; `force: true` bypassing freshness but still reusing an in-flight call; and a failed refresh converting only that provider's last-good value to `stale`.

Add a spy that throws if the Antigravity adapter performs any filesystem, process, credential, or network dependency call.

- [ ] **Step 2: Run orchestration tests and verify they fail**

Run: `npx vitest run src/main/usageProviders.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the coordinator with isolated cache entries**

```ts
interface UsageCoordinatorDeps {
  now(): number;
  load(): ProviderUsage[];
  save(values: ProviderUsage[]): void;
  providers: Record<AgentId, () => Promise<ProviderUsage>>;
}

class UsageCoordinator {
  private cache = new Map<AgentId, ProviderUsage>();
  private inFlight: Promise<UsageSnapshot> | null = null;

  constructor(private deps: UsageCoordinatorDeps) {
    for (const value of deps.load()) this.cache.set(value.providerId, value);
  }

  cached(installed: AgentId[]): UsageSnapshot | null {
    return installed.some((id) => this.cache.has(id)) ? this.snapshot(installed, this.now()) : null;
  }

  refresh(installed: AgentId[], force = false): Promise<UsageSnapshot> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!force && installed.every((id) => this.isFresh(this.cache.get(id), now))) {
      return Promise.resolve(this.snapshot(installed, now));
    }
    this.inFlight = this.fetchProviders(installed, now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private now(): number { return this.deps.now(); }
  private isFresh(value: ProviderUsage | undefined, now: number): boolean {
    return !!value && now - value.fetchedAt < 300_000;
  }
  private snapshot(installed: AgentId[], now: number): UsageSnapshot {
    return { providers: installed.flatMap((id) => this.cache.has(id) ? [this.cache.get(id)!] : []), fetchedAt: now };
  }
  private async fetchProviders(installed: AgentId[], now: number): Promise<UsageSnapshot> {
    const settled = await Promise.allSettled(installed.map((id) => this.deps.providers[id]()));
    settled.forEach((result, index) => {
      const id = installed[index];
      if (result.status === 'fulfilled') this.cache.set(id, result.value);
      else {
        const old = this.cache.get(id);
        this.cache.set(id, old
          ? { ...old, state: 'stale', staleSince: old.fetchedAt }
          : { providerId: id, state: 'offline', planLabel: null, limits: [], credits: null, guidance: null, fetchedAt: now });
      }
    });
    this.deps.save([...this.cache.values()]);
    return this.snapshot(installed, now);
  }
}
```

Use `Promise.allSettled`, update successful provider cache entries independently, and retain/relabel only the failed provider's last-good entry. If a provider fails before it has a last-good entry, create an isolated normalized `offline` result for that provider rather than rejecting the snapshot. Load a validated cache once when constructing the coordinator and persist a validated array of normalized provider results to `usage-cache.json`; reject unknown provider IDs, states, non-finite numbers, overlong labels, and invalid timestamps on read.

- [ ] **Step 4: Replace the Claude-only IPC surface**

Register `usage:snapshot` for an immediate validated cache read and `usage:refresh` for provider work. Both calculate installed providers with `availableAgents()` and call the singleton coordinator. The refresh handler accepts only `{ force?: boolean }`; coerce force with `opts?.force === true`. Remove `usage:windows` after updating preload and renderer typings to:

```ts
usageSnapshot(): Promise<UsageSnapshot | null>;
refreshUsageProviders(opts?: { force?: boolean }): Promise<UsageSnapshot>;
```

No credential, child-process object, raw provider response, or exception string may be returned.

- [ ] **Step 5: Run coordinator, IPC guard, and build checks**

Run: `npx vitest run src/main/usageProviders.test.ts src/main/ipc.guard.test.ts`

Run: `npm run build`

Expected: PASS and no reference to `usage:windows` remains under `src/`.

- [ ] **Step 6: Commit the all-provider IPC layer**

```bash
git add src/main/usageProviders.ts src/main/usageProviders.test.ts src/main/ipc.ts src/main/ipc.guard.test.ts src/preload/preload.ts src/renderer/global.d.ts
git commit -m "feat(usage): expose cached multi-provider limits"
```

### Task 7: Build the 26px summary footer and accessible all-usage modal

**Files:**
- Replace: `src/renderer/usageBar.ts`
- Create: `src/renderer/usageModal.ts`
- Create: `src/shared/usagePresentation.ts`
- Create: `src/shared/usagePresentation.test.ts`
- Modify: `src/renderer/main.ts:1-170`
- Modify: `src/renderer/index.html:91`
- Modify: `src/renderer/styles.css:515-540`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `qa/audit.mjs`
- Modify: `qa/screenshot.mjs`

**Interfaces:**
- Consumes: `usageSnapshot`, `refreshUsageProviders`, provider-logo helper, normalized usage types, `formatReset`, and `usageSeverity`.
- Produces: `mountUsageBar`, `refreshUsageBar(force?)`, `openUsageModal`, `closeUsageModal`, and pure `summarizeProviderUsage`/`criticalUsageLimit` helpers.
- Refresh schedule: mount, window focus, and every `300_000ms`; manual refresh calls `{ force: true }`; renderer also deduplicates its promise.

- [ ] **Step 1: Write pure footer-summary tests**

Test that the highest percentage across all ready/stale limits wins; critical outranks warning/ok; null percentages do not win; a stale limit retains its signal plus stale state; unsupported Antigravity produces guidance rather than a fake percentage; and empty providers produce a localized-neutral summary key.

Run: `npx vitest run src/shared/usagePresentation.test.ts`

Expected: FAIL because presentation helpers do not exist.

- [ ] **Step 2: Implement summary helpers and compact footer rendering**

The footer contains a left `.ub-providers` logo cluster, a single `.ub-summary` containing the most urgent/current limit and reset countdown, a flexible spacer, and a real `<button class="ub-all">`. Do not navigate to the analytics rail item on click. Keep `#usage-bar` rendered even when one provider is unavailable; hide it only when `providers.length === 0`.

Polling and provider failures render only inside the footer/modal state and never call the global toast path.

Set `height: 26px`, `min-height: 26px`, and `max-height: 26px`; preserve the existing top border and do not add vertical padding.

- [ ] **Step 3: Implement modal rendering and lifecycle**

Append a `role="dialog"`, `aria-modal="true"`, labeled `.usage-modal` inside a fixed `.usage-modal-overlay`. Render one section per installed provider with logo, localized name, plan, every window's meter/percentage/reset, credits, state, and stale age. Antigravity renders copy buttons for `/usage`, `/quota`, and `/credits`; the button uses the existing main-process clipboard bridge.

On open, record `document.activeElement`, focus the close button, trap `Tab`/`Shift+Tab` among enabled buttons/links, close on Escape or a click whose target is the overlay, and return focus to the recorded trigger. Remove all modal listeners on close. Manual refresh disables only the refresh button while awaiting the shared refresh promise.

- [ ] **Step 4: Wire refresh scheduling without duplicate requests**

Use one renderer promise:

```ts
let refreshInFlight: Promise<UsageSnapshot> | null = null;
export function refreshUsageBar(force = false): Promise<UsageSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = window.devdeck.refreshUsageProviders({ force })
    .then((snapshot) => { renderFooter(snapshot); renderOpenModal(snapshot); return snapshot; })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
```

At mount, await `usageSnapshot()` first and render it immediately when non-null, then start `refreshUsageBar()`. Call refresh again on `window.focus` and with a five-minute interval. `applyLanguage` rerenders the renderer's cached snapshot instead of forcing provider requests.

- [ ] **Step 5: Add all four locale dictionaries**

Add keys for “All usage”, dialog title/close/refresh, last updated/stale age, plan, reset, credits/balance/spent, each normalized state, Primary/Secondary, dynamic model limit framing, and Antigravity `/usage`/`/quota`/`/credits` instructions. Keep dynamic provider/model labels as sanitized data, not translation keys.

- [ ] **Step 6: Add end-to-end modal, geometry, and accessibility assertions**

In screenshot QA, inject a deterministic snapshot through an IPC stub installed before window boot. Capture `usage-footer-{lang}.png` and `all-provider-usage-{lang}.png` for all four locales. Measure `#usage-bar`, `#shell`, `.ck-terms`, and any `.xterm` rectangle before/open/close; assert footer height remains `26` and all other rectangles are byte-for-byte equal. Trigger Escape, outside click, Tab wrap, Shift+Tab wrap, and focus restoration to `.ub-all`.

In `qa/audit.mjs`, open the dialog before running axe so the modal state is audited. Fail on serious/critical dialog violations and assert `role`, `aria-modal`, accessible close label, and three provider sections.

- [ ] **Step 7: Run UI helpers, build, screenshot QA, and accessibility QA**

Run: `npx vitest run src/shared/usagePresentation.test.ts src/shared/usageWindows.test.ts`

Run: `npm run build`

Run: `node qa/screenshot.mjs`

Run: `node qa/audit.mjs`

Expected: PASS; no shell/terminal geometry delta; modal keyboard behavior and all four locale screenshots are correct.

- [ ] **Step 8: Commit the usage footer and modal**

```bash
git add src/renderer/usageBar.ts src/renderer/usageModal.ts src/shared/usagePresentation.ts src/shared/usagePresentation.test.ts src/renderer/main.ts src/renderer/index.html src/renderer/styles.css src/renderer/locales qa/audit.mjs qa/screenshot.mjs
git commit -m "feat(usage): add all-provider limits modal"
```

### Task 8: Relabel Claude-only analytics and document provider capabilities

**Files:**
- Modify: `src/renderer/usageView.ts:40-60`
- Modify: `src/renderer/main.ts:55-70`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/shared/i18n.test.ts`
- Modify: `README.md:29-49,95`
- Verify: `docs/backlog.md`

**Interfaces:**
- Existing local report remains `usageReport(sinceMs)` and reads Claude logs only.
- Navigation/title/empty/disclaimer copy identifies it as Claude Code local analytics.
- README distinguishes local analytics from live subscription limits and states each provider's data path.

- [ ] **Step 1: Add a locale-parity test for all multi-provider keys**

Import the four renderer JSON dictionaries in `i18n.test.ts` and assert the same required key array exists and contains non-empty strings in each dictionary. Include provider names, modal controls/states, Antigravity commands, and `usage.local_title`/`usage.local_explainer`.

- [ ] **Step 2: Run the i18n test and verify missing keys fail**

Run: `npx vitest run src/shared/i18n.test.ts`

Expected: FAIL until all four dictionaries contain the complete key set.

- [ ] **Step 3: Add the analytics heading and explicit explanatory copy**

At the top of `usageView` rendering, add a heading using `usage.local_title` and description using `usage.local_explainer`. Change the rail title/accessible label from generic usage to the localized Claude analytics label. Preserve the empty-state statement that it scans `~/.claude`; do not imply Codex or Antigravity cost/token aggregation.

- [ ] **Step 4: Update README capability and privacy text**

Document:

- the fixed provider-logo session sidebar and provider-correct restore behavior;
- the footer's Claude dynamic/model limits and Usage Credits;
- Codex rate limits through the local official app-server;
- Antigravity's documented interactive `/usage`, `/quota`, and `/credits` guidance;
- Claude-only local token/cost analytics;
- outbound behavior: renderer remains offline, Claude uses Anthropic's first-party endpoint, Codex app-server owns its own first-party request, and Antigravity makes no usage request.

Confirm `docs/backlog.md` retains the official Antigravity quota API follow-up and its release-review trigger; do not mark it completed.

- [ ] **Step 5: Run i18n tests and build**

Run: `npx vitest run src/shared/i18n.test.ts`

Run: `npm run build`

Expected: PASS with all locale keys and renderer copy resolved.

- [ ] **Step 6: Commit scope labels and documentation**

```bash
git add src/renderer/usageView.ts src/renderer/main.ts src/renderer/locales src/shared/i18n.test.ts README.md
git commit -m "docs: clarify provider usage capabilities"
```

### Task 9: Complete regression verification and refresh committed screenshots

**Files:**
- Modify: `docs/screenshots/usage.png`
- Create: `docs/screenshots/cockpit-providers.png`
- Create: `docs/screenshots/all-provider-usage.png`
- Modify only if a verified gap is found: files already listed in Tasks 1-8

**Interfaces:**
- Verifies both milestones as a complete user flow.
- Produces the final screenshot assets and a clean, tested worktree.

- [ ] **Step 1: Run the complete unit and integration suite**

Run: `npm test`

Expected: PASS with no skipped new provider/usage tests.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: PASS; local SVG assets appear under `dist/renderer/assets/` and `rg "usage:windows" src dist` returns no matches.

- [ ] **Step 3: Run the full accessibility audit**

Run: `npm run qa:audit`

Expected: PASS with zero serious/critical violations in projects, Claude analytics, settings, next, cockpit, and the open usage dialog.

- [ ] **Step 4: Run the full screenshot workflow and inspect the three target states**

Run: `npm run qa`

Expected: PASS with no console/page errors, a 250px cockpit sidebar, a 26px footer, no terminal geometry change, readable Korean/English/Japanese/Chinese modal layouts, and keyboard-visible full-name help.

Copy the verified representative captures without hand-editing images:

```powershell
Copy-Item -LiteralPath 'qa/shots/usage-en.png' -Destination 'docs/screenshots/usage.png' -Force
Copy-Item -LiteralPath 'qa/shots/cockpit-provider-sidebar.png' -Destination 'docs/screenshots/cockpit-providers.png' -Force
Copy-Item -LiteralPath 'qa/shots/all-provider-usage-en.png' -Destination 'docs/screenshots/all-provider-usage.png' -Force
```

- [ ] **Step 5: Review the final diff for security and scope regressions**

Run: `git diff --check`

Run: `rg -n "accessToken|\.credentials|account/rateLimits/read|/usage|/credits|connect-src" src README.md`

Expected: tokens appear only inside main-process credential/fetch code; raw credentials do not appear in preload, shared types, or renderer; Antigravity has no network adapter; CSP remains `connect-src 'none'`.

- [ ] **Step 6: Commit screenshot and verification artifacts**

```bash
git add docs/screenshots/usage.png docs/screenshots/cockpit-providers.png docs/screenshots/all-provider-usage.png
git commit -m "docs: refresh multi-provider usage screenshots"
```

- [ ] **Step 7: Confirm completion state**

Run: `git status --short`

Expected: no uncommitted files. Record the passing commands and commit IDs in the handoff; do not claim completion if any unit, build, audit, screenshot, geometry, or security check failed.
