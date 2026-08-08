# Provider-Aware Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generic project open action visibly and reliably use the selected AI, while preserving provider-owned conversation resume and provider-scoped duplicate protection.

**Architecture:** Add an explicit provider/open-mode contract shared by renderer, preload, and main process. A pure provider-open model supplies menu outcomes and provider-scoped duplicate decisions; one renderer split-button component uses that model across Projects and Next, while the main process remains the authoritative launch resolver.

**Tech Stack:** TypeScript 5.5, Electron 43, Vitest 3, esbuild, Playwright Electron, axe-core, electron-builder, GitHub Actions.

## Global Constraints

- Generic **Open** honors the provider visibly selected by the user.
- Explicit historical sessions always resume with the provider that owns them.
- `auto` focuses/resumes only within the requested provider; `new` never deduplicates or resumes.
- Claude, Codex, and Antigravity histories remain independent; no transcript transfer is added.
- Task board, project cards, project list, batch open, embedded cockpit, and external terminals use the same request contract.
- Provider identity and outcome are available as localized text, not logo or color alone.
- New user-visible strings exist in English, Korean, Japanese, and Chinese.
- Publishing happens only after tests, type checks, build, QA, accessibility audit, packaging, and CI succeed.

---

## File Structure

- Create `src/shared/providerOpen.ts`: pure provider menu/outcome decisions.
- Create `src/shared/providerOpen.test.ts`: behavior tests for outcome and option ordering.
- Create `src/renderer/agentSelection.ts`: renderer-local installed/selected provider state and subscribers.
- Create `src/renderer/agentSelection.test.ts`: selection-store behavior tests without a DOM.
- Create `src/renderer/providerOpenControl.ts`: reusable accessible split button and menu.
- Modify `src/shared/types.ts`: `OpenMode` and shared IPC request shapes.
- Modify `src/shared/cockpitModel.ts` and `.test.ts`: provider-scoped duplicate lookup.
- Modify `src/main/ipc.ts` and `src/main/ipc.cockpit.test.ts`: authoritative provider/mode launch routing.
- Modify `src/preload/preload.ts` and `src/renderer/global.d.ts`: exact request contract across context isolation.
- Modify `src/renderer/main.ts`: initialize and update renderer provider selection once.
- Modify `src/renderer/cockpitView.ts`: provider-scoped live summaries and duplicate routing.
- Modify `src/renderer/openRouter.ts`: forward explicit provider/mode to either launch surface.
- Modify `src/renderer/projectsView.ts`: use shared controls; keep historical rows provider-owned.
- Modify `src/renderer/nextView.ts`: retain provider history and use the shared control.
- Modify `src/renderer/styles.css`: split-button/menu layout, compact states, focus, and responsive containment.
- Modify all four files in `src/renderer/locales/`: localized outcomes/actions.
- Modify `src/shared/i18n.test.ts`: require the new keys in every locale.
- Modify `qa/audit.mjs` and `qa/screenshot.mjs`: interaction/accessibility/geometry regression checks.
- Modify `README.md`, `package.json`, and `package-lock.json`: behavior documentation and patch release `1.29.3`.

---

### Task 1: Provider-open domain and duplicate identity

**Files:**
- Create: `src/shared/providerOpen.ts`
- Create: `src/shared/providerOpen.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/cockpitModel.ts:131`
- Modify: `src/shared/cockpitModel.test.ts:155`

**Interfaces:**
- Produces: `OpenMode = 'auto' | 'new'`.
- Produces: `ProjectOpenIntent { path: string; sessionId: string | null; agentId: AgentId; mode: OpenMode }`.
- Produces: `providerOpenOutcome(agentId, historyAgentIds, liveAgentIds): 'focus' | 'continue' | 'new'`.
- Produces: `providerOpenOptions(installed, selected, historyAgentIds, liveAgentIds): ProviderOpenOption[]`.
- Changes: `tileHoldingSession(tiles, target, agentId)` matches `sessionId + agentId` on non-exited tiles.

- [ ] **Step 1: Write failing provider outcome tests**

```ts
import { describe, expect, it } from 'vitest';
import { providerOpenOptions, providerOpenOutcome } from './providerOpen';

describe('providerOpenOutcome', () => {
  it('never treats another provider live in the same project as focusable', () => {
    expect(providerOpenOutcome('codex', ['claude'], ['claude'])).toBe('new');
  });
  it('focuses the requested live provider before considering history', () => {
    expect(providerOpenOutcome('codex', ['codex'], ['codex'])).toBe('focus');
  });
  it('continues requested-provider history when no matching live tile exists', () => {
    expect(providerOpenOutcome('codex', ['claude', 'codex'], ['claude'])).toBe('continue');
  });
});

describe('providerOpenOptions', () => {
  it('puts the selected installed provider first and reports each independent outcome', () => {
    expect(providerOpenOptions(['claude', 'codex', 'antigravity'], 'codex', ['claude'], ['claude']))
      .toEqual([
        { agentId: 'codex', selected: true, outcome: 'new' },
        { agentId: 'claude', selected: false, outcome: 'focus' },
        { agentId: 'antigravity', selected: false, outcome: 'new' },
      ]);
  });
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `npx vitest run src/shared/providerOpen.test.ts`

Expected: FAIL because `./providerOpen` does not exist.

- [ ] **Step 3: Add failing provider-scoped duplicate tests**

Update the existing `tileHoldingSession` fixtures to carry `agentId`, then add:

```ts
it('requires both conversation id and provider to match', () => {
  const tiles = [
    { id: 'claude-tile', sessionId: 'same-id', agentId: 'claude' as const, exited: false },
    { id: 'codex-tile', sessionId: 'same-id', agentId: 'codex' as const, exited: false },
  ];
  expect(tileHoldingSession(tiles, 'same-id', 'codex')).toBe('codex-tile');
  expect(tileHoldingSession(tiles, 'same-id', 'antigravity')).toBeNull();
});
```

- [ ] **Step 4: Run the duplicate test and verify RED**

Run: `npx vitest run src/shared/cockpitModel.test.ts -t "requires both conversation id and provider"`

Expected: FAIL because `tileHoldingSession` does not accept or compare a provider.

- [ ] **Step 5: Implement the minimal domain model**

```ts
// src/shared/providerOpen.ts
import type { AgentId } from './types';

export type ProviderOpenOutcome = 'focus' | 'continue' | 'new';
export interface ProviderOpenOption {
  agentId: AgentId;
  selected: boolean;
  outcome: ProviderOpenOutcome;
}

export function providerOpenOutcome(
  agentId: AgentId,
  historyAgentIds: readonly AgentId[],
  liveAgentIds: readonly AgentId[],
): ProviderOpenOutcome {
  if (liveAgentIds.includes(agentId)) return 'focus';
  return historyAgentIds.includes(agentId) ? 'continue' : 'new';
}

export function providerOpenOptions(
  installed: readonly AgentId[], selected: AgentId,
  historyAgentIds: readonly AgentId[], liveAgentIds: readonly AgentId[],
): ProviderOpenOption[] {
  const ids = installed.includes(selected) ? [selected, ...installed.filter((id) => id !== selected)] : [...installed];
  return ids.map((agentId) => ({ agentId, selected: agentId === selected, outcome: providerOpenOutcome(agentId, historyAgentIds, liveAgentIds) }));
}
```

Add to `types.ts`:

```ts
export type OpenMode = 'auto' | 'new';
export interface ProjectOpenIntent {
  path: string;
  sessionId: string | null;
  agentId: AgentId;
  mode: OpenMode;
}
```

Update `tileHoldingSession` to compare `t.agentId === agentId` in addition to the existing conditions.

- [ ] **Step 6: Run focused and full shared tests**

Run: `npx vitest run src/shared/providerOpen.test.ts src/shared/cockpitModel.test.ts`

Expected: both files PASS.

- [ ] **Step 7: Commit the domain contract**

```powershell
git add src/shared/providerOpen.ts src/shared/providerOpen.test.ts src/shared/types.ts src/shared/cockpitModel.ts src/shared/cockpitModel.test.ts
git commit -m "feat: define provider-aware open intent"
```

---

### Task 2: Authoritative provider and mode across IPC

**Files:**
- Modify: `src/main/ipc.ts:111-164,300-329,381-410`
- Modify: `src/main/ipc.cockpit.test.ts:111-152`
- Modify: `src/preload/preload.ts:9,60-62`
- Modify: `src/renderer/global.d.ts:11,64`
- Modify: `src/renderer/cockpitView.ts:22-25,268-297,386-390`
- Modify: `src/renderer/openRouter.ts:14-20`

**Interfaces:**
- Consumes: `ProjectOpenIntent`, `OpenMode`, and provider-scoped `tileHoldingSession` from Task 1.
- Produces: external `projects:open` and embedded `cockpit:open` requests with explicit `agentId` and `mode`.
- Preserves: historical `{ sessionId, agentId }` ownership and legacy missing-provider fallback to stored selection only.

- [ ] **Step 1: Replace the old inference test with the regression test**

```ts
it('keeps an explicit Codex generic open in Codex even when Claude is selected', async () => {
  const open = handlers.get('cockpit:open')!;
  storedAgent = 'claude';
  ptyCreate.mockClear();

  await open(null, {
    projectPath, sessionId: null, cols: 80, rows: 24,
    agentId: 'codex', mode: 'auto',
  });

  expect(launchCommand()).toBe('codex resume --last');
});
```

Add a forced-new assertion:

```ts
it('new mode never resumes requested-provider history', async () => {
  const open = handlers.get('cockpit:open')!;
  ptyCreate.mockClear();
  await open(null, { projectPath, sessionId: null, cols: 80, rows: 24, agentId: 'codex', mode: 'new' });
  expect(launchCommand()).toBe('codex');
});
```

- [ ] **Step 2: Run the IPC regression tests and verify RED**

Run: `npx vitest run src/main/ipc.cockpit.test.ts -t "explicit Codex|new mode"`

Expected: at least the `new mode` case FAILS because the handler ignores `mode` and resumes Codex history.

- [ ] **Step 3: Thread the exact request type through preload and renderer declarations**

Use `ProjectOpenIntent[]` for `window.devdeck.open`. Extend the cockpit request with `mode: OpenMode`; keep the path/name/display metadata renderer-only.

```ts
open: (items: import('../shared/types').ProjectOpenIntent[]) => ipcRenderer.invoke('projects:open', items)
```

- [ ] **Step 4: Remove project-owner inference from generic launch resolution**

Delete `agentForProject`. In both handlers select the provider with:

```ts
const a = agentFor(req.agentId);
const forceNew = req.mode === 'new';
```

For `projects:open`, use `buildCommand('new')` when `mode === 'new'`; otherwise resume an explicit ID, continue when this provider has history, and create when it does not.

For `cockpit:open`, map `forceNew` to `resolveOpenSession(... fresh: true ...)`; an `auto` request reads only that provider's history. Missing-provider compatibility falls back to `activeAgent()`, never to another provider's project history.

- [ ] **Step 5: Make cockpit duplicate lookup provider-scoped**

Filter candidate tiles by `projectPath` and requested `agentId`; pass tile `agentId` and request `agentId` into `tileHoldingSession`. Return immediately for `mode === 'new'`. Forward `mode` into `window.devdeck.cockpit.open`.

- [ ] **Step 6: Run focused IPC/cockpit tests**

Run: `npx vitest run src/main/ipc.cockpit.test.ts src/shared/cockpitModel.test.ts`

Expected: PASS.

- [ ] **Step 7: Run TypeScript to catch every stale bridge caller**

Run: `npx tsc --noEmit`

Expected: FAIL only at renderer call sites that still omit `agentId`/`mode`; record them for Tasks 3-4. Do not weaken the shared type.

- [ ] **Step 8: Commit IPC behavior after the temporary caller errors are resolved within this task**

Add explicit compatibility intents at remaining call sites (`agentId` from owning session or selection, `mode` from old `fresh`), then run `npx tsc --noEmit` until PASS.

```powershell
git add src/main/ipc.ts src/main/ipc.cockpit.test.ts src/preload/preload.ts src/renderer/global.d.ts src/renderer/cockpitView.ts src/renderer/openRouter.ts
git commit -m "fix: honor explicit provider open requests"
```

---

### Task 3: Shared selected-provider state

**Files:**
- Create: `src/renderer/agentSelection.ts`
- Create: `src/renderer/agentSelection.test.ts`
- Modify: `src/renderer/main.ts:171-203`

**Interfaces:**
- Consumes: `AgentId`.
- Produces: `createAgentSelectionStore(installed, selected)` for isolated tests.
- Produces: renderer singleton wrappers `initializeAgentSelection`, `selectedAgent`, `installedAgents`, `setSelectedAgent`, and `subscribeAgentSelection`.

- [ ] **Step 1: Write the failing selection-store test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAgentSelectionStore } from './agentSelection';

describe('createAgentSelectionStore', () => {
  it('notifies once when the selected installed provider changes', () => {
    const store = createAgentSelectionStore(['claude', 'codex'], 'claude');
    const changed = vi.fn();
    store.subscribe(changed);
    store.select('codex');
    store.select('codex');
    expect(store.selected()).toBe('codex');
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith('codex');
  });

  it('ignores providers outside the initialized installed set', () => {
    const store = createAgentSelectionStore(['claude'], 'claude');
    store.select('codex');
    expect(store.selected()).toBe('claude');
  });
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `npx vitest run src/renderer/agentSelection.test.ts`

Expected: FAIL because `./agentSelection` does not exist.

- [ ] **Step 3: Implement the minimal selection store**

Keep instance state private, reject selections outside the installed set, and notify subscribers only on an actual change. Add singleton wrappers initialized during boot. The header selector calls `await window.devdeck.setAgent(id)` first, then `setSelectedAgent(id)` so visible controls never advertise an unpersisted choice.

- [ ] **Step 4: Initialize it before renderer views mount**

During `boot`, fetch installed and active providers before `mountProjects`/`mountNext`, call `initializeAgentSelection(agents.length ? agents : [active], active)`, then build the header selector from the same values. Existing project reloads no longer maintain a separate `defaultAgentId` copy.

- [ ] **Step 5: Run the focused test and build**

Run: `npx vitest run src/renderer/agentSelection.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit the shared selection source**

```powershell
git add src/renderer/agentSelection.ts src/renderer/agentSelection.test.ts src/renderer/main.ts
git commit -m "refactor: share selected provider state"
```

---

### Task 4: Use one open interaction on Projects and Next

**Files:**
- Create: `src/renderer/providerOpenControl.ts`
- Modify: `src/renderer/projectsView.ts:21-97,330-351,407-420,632-653,702-709`
- Modify: `src/renderer/nextView.ts:11-18,69-100`
- Modify: `src/renderer/cockpitView.ts` (export provider-specific live summary)
- Modify: `src/renderer/providerLogo.ts`
- Modify: `src/renderer/styles.css:126-181,225-260`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/shared/i18n.test.ts:42-61`
- Modify: `qa/audit.mjs`
- Modify: `qa/screenshot.mjs`

**Interfaces:**
- Consumes: `createProviderOpenControl`, agent selection store, and explicit request routing.
- Produces: `createProviderOpenControl({ project, historyAgentIds, liveAgentIds, compact, onOpen })`.
- Emits: `{ path, sessionId: null, agentId, mode: 'auto' | 'new' }`.
- Produces: `liveProjectProviders(projectPath): AgentId[]` from cockpit renderer state.
- Preserves: historical session row action with exact `{ sessionId, agentId, mode: 'auto' }`.

- [ ] **Step 1: Add a failing QA contract before the component exists**

After the audit registers the repository as an allowed project, seed one task through `setTodos`, open Next, and assert:

```js
const providerOpen = await win.evaluate(async (p) => {
  await window.devdeck.setTodos(p, [{ id: 'qa-open', text: 'Provider open QA', done: false, createdAt: new Date().toISOString(), due: null }]);
  document.querySelector('.rail-item[data-view="next"]')?.click();
  await new Promise((r) => setTimeout(r, 700));
  const root = document.querySelector('#view-next .provider-open');
  const primary = root?.querySelector('.provider-open-primary');
  const menuButton = root?.querySelector('.provider-open-menu-button');
  return { root: !!root, primaryLabel: primary?.getAttribute('aria-label') ?? '', menuLabel: menuButton?.getAttribute('aria-label') ?? '' };
}, root);
```

Fail the audit unless the root exists and both accessible labels are non-empty.

- [ ] **Step 2: Run QA audit and verify RED**

Run: `npm run qa:audit`

Expected: FAIL with the provider-open contract because `.provider-open` does not exist.

- [ ] **Step 3: Add failing locale parity requirements**

Append these keys to `REQUIRED`:

```ts
'open.with_provider', 'open.choose_provider', 'open.status_focus',
'open.status_continue', 'open.status_new', 'open.new_session',
```

- [ ] **Step 4: Run locale test and verify RED**

Run: `npx vitest run src/shared/i18n.test.ts -t "locale parity"`

Expected: FAIL naming the missing keys.

- [ ] **Step 5: Add all localized strings**

English source meanings:

```json
"open.with_provider": "Open with {provider}",
"open.choose_provider": "Choose AI",
"open.status_focus": "Open — go to session",
"open.status_continue": "Continue recent conversation",
"open.status_new": "New conversation",
"open.new_session": "New session"
```

Add these exact equivalents, preserving the `{provider}` interpolation token:

```json
// ko
"open.with_provider": "{provider}(으)로 열기",
"open.choose_provider": "AI 선택",
"open.status_focus": "열려 있음 — 세션으로 이동",
"open.status_continue": "최근 대화 이어서",
"open.status_new": "새 대화",
"open.new_session": "새 세션"

// ja
"open.with_provider": "{provider} で開く",
"open.choose_provider": "AI を選択",
"open.status_focus": "開いています — セッションへ移動",
"open.status_continue": "最近の会話を続ける",
"open.status_new": "新しい会話",
"open.new_session": "新しいセッション"

// zh
"open.with_provider": "使用 {provider} 打开",
"open.choose_provider": "选择 AI",
"open.status_focus": "已打开 — 前往会话",
"open.status_continue": "继续最近的对话",
"open.status_new": "新对话",
"open.new_session": "新会话"
```

- [ ] **Step 6: Implement the accessible split button**

The primary action uses `selectedAgent()` and emits `mode: 'auto'`. The disclosure lists `providerOpenOptions(...)`; each row has an automatic action with outcome text and a separate localized “New session” action. Subscribe to selection changes and update the primary logo/label in place. Implement outside-click dismissal, Escape, ArrowUp/ArrowDown, Enter/Space activation, and focus restoration to the disclosure button.

Use `.provider-open`, `.provider-open-primary`, and `.provider-open-menu-button` from the QA contract. Use `createProviderLogo` for every provider mark. A compact control shows the mark and play glyph; a full control shows the localized open label.

- [ ] **Step 7: Add containment and focus styles**

Add `.provider-open-menu`, `.provider-open-option`, `.provider-open-status`, and `.provider-open-new` styles alongside the QA contract classes. Keep menus above cards, avoid overflow at task-row widths, and include visible `:focus-visible` outlines.

- [ ] **Step 8: Replace generic Projects buttons**

Change `toOpenReq` so only an explicit historical session uses its owner. Generic requests come from the shared control's selected provider. Replace the card and list generic buttons with `createProviderOpenControl`; leave historical session rows as their fixed-provider open buttons.

Batch open constructs one `auto` intent per selected project with `selectedAgent()`. New-project open uses the selected provider and `mode: 'new'` because there is no history to resume.

- [ ] **Step 9: Replace task-row button and retain provider history**

Extend local `Proj` with `agentIds: AgentId[]`, retain it from `listProjects`, and replace the bare `▶` with the compact shared control. The emitted request uses the task's project path/name/display metadata plus the chosen provider and mode.

- [ ] **Step 10: Add provider-specific live summaries**

Export the set of non-exited live provider IDs for a project from `cockpitView`. This feeds UI status only; actual duplicate/history resolution remains authoritative at click time.

- [ ] **Step 11: Extend screenshot QA**

Seed a task in the isolated QA profile, capture the closed control and its open menu, then assert the control stays inside `.tk-row` and the popup stays inside the viewport. Make the check conditional on a disclosure button when only one provider is installed, but always require the primary provider label.

- [ ] **Step 12: Run focused tests, QA, and build**

Run: `npx vitest run src/shared/i18n.test.ts src/shared/providerOpen.test.ts src/shared/cockpitModel.test.ts src/main/ipc.cockpit.test.ts`

Expected: PASS.

Run: `npm run qa`

Expected: console errors `0`, page errors `0`, provider control contained.

Run: `npm run qa:audit`

Expected: all IPC checks true and axe violations `0`.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 13: Commit the integrated UI**

```powershell
git add src/renderer/providerOpenControl.ts src/renderer/projectsView.ts src/renderer/nextView.ts src/renderer/cockpitView.ts src/renderer/providerLogo.ts src/renderer/styles.css src/renderer/locales src/shared/i18n.test.ts qa/audit.mjs qa/screenshot.mjs
git commit -m "feat: open projects with the chosen AI"
```

---

### Task 5: Documentation, release verification, and deployment

**Files:**
- Modify: `README.md:28-34`
- Modify: `package.json:3`
- Modify: `package-lock.json` version fields

**Interfaces:**
- Documents: generic provider selection, provider-owned historical resume, and explicit new-session behavior.
- Releases: patch version `1.29.3` through the existing `v*` GitHub Actions release workflow.

- [ ] **Step 1: Update README behavior**

Replace descriptions that say generic Open follows the historical owner with:

```md
Choose an AI directly from the provider-aware Open control. DevDeck focuses that AI's live session,
continues that AI's recent project conversation, or starts one when no history exists. “New session”
always starts separately. Opening a specific historical conversation remains pinned to its original AI.
```

- [ ] **Step 2: Bump the patch version**

Run: `npm version 1.29.3 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report `1.29.3`.

- [ ] **Step 3: Run the complete verification gate fresh**

Run: `npm test`

Expected: all tests PASS, zero failures.

Run: `npx tsc --noEmit`

Expected: exit code 0.

Run: `npm run build`

Expected: exit code 0.

Run: `npm run qa`

Expected: exit code 0, console errors 0, page errors 0, geometry checks pass.

Run: `npm run qa:audit`

Expected: exit code 0, all IPC checks true, zero axe violations.

Run: `npm run dist:installer`

Expected: exit code 0 and `release/DevDeck-1.29.3-Setup.exe` plus blockmap/latest metadata exist.

- [ ] **Step 4: Inspect the final diff and release artifact**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only planned source, test, QA, documentation, and version files are modified; ignored `release/` artifacts are not staged.

- [ ] **Step 5: Commit the release preparation**

```powershell
git add README.md package.json package-lock.json
git commit -m "chore: release v1.29.3"
```

- [ ] **Step 6: Push main and wait for CI**

Run: `git push origin main`

Then use GitHub CLI to identify the new CI run and wait:

```powershell
$providerOpenCiRun = gh run list --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $providerOpenCiRun --exit-status
```

Expected: build/test matrix and QA audit all succeed. If authentication is unavailable, stop and report the exact deployment blocker.

- [ ] **Step 7: Tag and publish only after CI succeeds**

```powershell
git tag -a v1.29.3 -m "DevDeck v1.29.3"
git push origin v1.29.3
$providerOpenReleaseRun = gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $providerOpenReleaseRun --exit-status
```

Expected: Windows, macOS, and Linux packaging jobs succeed and publish assets to GitHub Release `v1.29.3`.

- [ ] **Step 8: Verify the public release**

Run: `gh release view v1.29.3 --json url,tagName,isDraft,isPrerelease,assets`

Expected: `tagName` is `v1.29.3`, `isDraft` and `isPrerelease` are false, and platform artifacts are listed. Report the returned release URL.

---

## Plan Self-Review

- Every design goal maps to a task: explicit provider/mode (Tasks 1-2), shared UI (Tasks 3-4), ownership and dedupe (Tasks 1-2), localization/accessibility (Tasks 3-4), documentation/release (Task 5).
- New behavior is protected by a failing test or failing QA gate before production changes.
- `ProjectOpenIntent`, `OpenMode`, provider outcomes, and duplicate signatures are consistent across tasks.
- No transcript handoff, provider installation, or unrelated cockpit redesign is included.
