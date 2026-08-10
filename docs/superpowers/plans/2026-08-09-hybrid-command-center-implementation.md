# Hybrid Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild DevDeck's renderer as a clean shared command-center shell that unifies project scanning and live-session response while preserving all existing behavior and QA guarantees.

**Architecture:** Keep Electron, the existing preload/IPC contracts, and vanilla TypeScript DOM rendering. Introduce pure presentation models plus focused shell/component modules, move Cockpit session navigation into the shared sidebar, and migrate styles into ordered design/shell/feature files copied by the existing build pipeline.

**Tech Stack:** Electron 43, TypeScript 5.5, esbuild, Vitest 3, Playwright 1.62, axe-core, xterm 6, CSS custom properties.

## Global Constraints

- Do not introduce React, Tailwind, or another UI framework.
- Preserve all existing main-process and preload IPC contracts.
- Preserve Windows embedded-terminal lifecycle, geometry, restoration, search, clipboard, image-path, fork, restart, and persistence behavior.
- Preserve Korean, English, Japanese, and Chinese localization.
- Preserve WCAG 2.1 AA audit coverage and keyboard parity.
- Dark mode is the only mandatory finished theme in this implementation.
- Keep the application buildable and testable after every task.
- Keep unchanged project and Cockpit DOM nodes stable during refresh where current reconciliation already guarantees it.

---

## File map

### New files

- `src/renderer/design/tokens.css` — colors, typography, spacing, radii, focus, and motion tokens.
- `src/renderer/design/base.css` — reset, body, typography, generic hidden/focus/disabled states.
- `src/renderer/design/components.css` — buttons, inputs, menus, status indicators, rows, toolbars, dialogs, and drawers.
- `src/renderer/shell/shell.css` — title bar, expanded/collapsed sidebar, main pane, and responsive shell layout.
- `src/renderer/features/projects/projects.css` — project overview list/card presentation.
- `src/renderer/features/cockpit/cockpit.css` — global session list and terminal workspace presentation.
- `src/renderer/features/secondary.css` — Tasks, Usage, Settings, modal, and footer alignment.
- `src/renderer/icons.ts` — local SVG icon markup and DOM creation.
- `src/renderer/icons.test.ts` — icon allowlist and accessibility behavior.
- `src/shared/shellNavigation.ts` — pure shell navigation types, grouping, counts, and context restoration.
- `src/shared/shellNavigation.test.ts` — navigation-model tests.
- `src/renderer/shell.ts` — shell mounting, collapse persistence, project rows, and view activation hooks.
- `src/renderer/projectOverview.ts` — pure project-row presentation derivation.
- `src/renderer/projectOverview.test.ts` — project hierarchy and metadata tests.
- `src/renderer/projectMemorySurface.ts` — responsive drawer/sheet mode selection.
- `src/renderer/projectMemorySurface.test.ts` — surface-mode tests.

### Modified files

- `src/renderer/index.html` — semantic shared sidebar and simplified Cockpit container.
- `src/renderer/main.ts` — mount icons/shell and connect project/Cockpit updates.
- `src/renderer/nav.ts` — explicit view activation API and shared-sidebar support.
- `src/renderer/projectsView.ts` — row-first default, simplified toolbar, shell project publishing.
- `src/renderer/cockpitView.ts` — publish session models, global sidebar selection, simplified workspace header.
- `src/renderer/projectMemoryModal.ts` — drawer/sheet classes and semantics.
- `src/renderer/nextView.ts` — shared toolbar/row classes and simplified control grouping.
- `src/renderer/usageView.ts` — shared heading/tab/table classes.
- `src/renderer/settingsView.ts` — shared section/control-row classes.
- `src/renderer/styles.css` — temporary compatibility imports only, then removal of migrated declarations.
- `package.json` and `package-lock.json` — pinned `@fontsource-variable/geist@5.3.0` font asset dependency.
- `src/renderer/locales/{ko,en,ja,zh}.json` — shell and accessible icon labels.
- `scripts/copy-assets.mjs` — copy the ordered CSS tree and bundled font.
- `qa/screenshot.mjs` — shared-shell, sidebar, drawer, responsive, and localization scenes.
- `qa/audit.mjs` — shared-sidebar and drawer accessibility assertions.
- `package.json` — test count copy only if README/test badge updates are performed at release time.

---

### Task 1: Design tokens and local SVG icons

**Files:**
- Create: `src/renderer/design/tokens.css`
- Create: `src/renderer/design/base.css`
- Create: `src/renderer/design/components.css`
- Create: `src/renderer/icons.ts`
- Create: `src/renderer/icons.test.ts`
- Modify: `src/renderer/styles.css:1-52`
- Modify: `scripts/copy-assets.mjs:10-18`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `type IconName`, `iconMarkup(name: IconName): string`, and `createIcon(name: IconName, className?: string): SVGSVGElement`.
- Produces: stable CSS tokens prefixed with `--dd-` and shared classes `.ui-button`, `.ui-icon-button`, `.ui-toolbar`, `.ui-status`, `.ui-row`, `.ui-drawer`.

- [ ] **Step 1: Write the failing icon allowlist test**

```ts
import { describe, expect, it } from 'vitest';
import { iconMarkup, type IconName } from './icons';

describe('iconMarkup', () => {
  it('returns local, currentColor SVG markup for every shell icon', () => {
    const names: IconName[] = ['search', 'projects', 'sessions', 'tasks', 'usage', 'settings', 'refresh', 'more', 'play', 'panel-left'];
    for (const name of names) {
      expect(iconMarkup(name)).toContain('<svg');
      expect(iconMarkup(name)).toContain('stroke="currentColor"');
      expect(iconMarkup(name)).not.toContain('http');
    }
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm test -- src/renderer/icons.test.ts`

Expected: FAIL because `./icons` does not exist.

- [ ] **Step 3: Implement the icon factory and design files**

Run `npm install --save-exact @fontsource-variable/geist@5.3.0`. Use one allowlisted path map in `icons.ts`; `createIcon` must parse the trusted local markup, add `aria-hidden="true"`, and never accept arbitrary SVG input. Define the dark neutral palette, Geist/system font stack, mono stack, five-level type scale, 4/8/12/16/24 spacing scale, 6/8/10 radii, semantic attention/working/success/destructive colors, and two-pixel focus ring. Move only shared declarations from `styles.css`; keep feature selectors in place until their migration task.

Update `copy-assets.mjs` to recursively copy `src/renderer/design`, `src/renderer/shell`, and `src/renderer/features` into matching `dist/renderer` directories, and copy `node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2` to `dist/renderer/assets/geist-latin-wght-normal.woff2`. Add the matching `@font-face` declaration and ordered `@import` statements at the top of `styles.css`.

- [ ] **Step 4: Run focused and build verification**

Run: `npm test -- src/renderer/icons.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: build succeeds and `dist/renderer/design/tokens.css` exists.

- [ ] **Step 5: Commit the design foundation**

```powershell
git add src/renderer/design src/renderer/icons.ts src/renderer/icons.test.ts src/renderer/styles.css scripts/copy-assets.mjs package.json package-lock.json
git commit -m "feat: add command center design foundation"
```

### Task 2: Pure shell navigation model

**Files:**
- Create: `src/shared/shellNavigation.ts`
- Create: `src/shared/shellNavigation.test.ts`

**Interfaces:**
- Consumes: `ActivityState` from `src/shared/sessionStatus.ts`.
- Produces: `ShellSessionInput`, `ShellProjectInput`, `ShellSessionGroup`, `ShellContext`, `buildSessionGroups(items)`, `filterShellItems(query, sessions, projects)`, `attentionCount(items)`, and `restoreShellContext(saved, availableProjectPaths, availableSessionIds)`.

- [ ] **Step 1: Write failing grouping and restoration tests**

```ts
import { describe, expect, it } from 'vitest';
import { attentionCount, buildSessionGroups, filterShellItems, restoreShellContext, type ShellSessionInput } from './shellNavigation';

const rows: ShellSessionInput[] = [
  { id: 'quiet', projectPath: 'C:/quiet', label: 'quiet', detail: 'main', activity: 'idle', pinned: true },
  { id: 'work', projectPath: 'C:/work', label: 'work', detail: 'feat', activity: 'working', pinned: false },
  { id: 'ask', projectPath: 'C:/ask', label: 'ask', detail: 'main', activity: 'attention', pinned: false },
];

describe('shell navigation', () => {
  it('orders urgent groups before pins and counts only genuine attention', () => {
    expect(buildSessionGroups(rows).map((g) => g.kind)).toEqual(['attention', 'working', 'pinned']);
    expect(attentionCount(rows)).toBe(1);
  });

  it('restores a valid context and falls back to projects for missing state', () => {
    expect(restoreShellContext({ kind: 'session', id: 'ask' }, new Set(['C:/ask']), new Set(['ask']))).toEqual({ kind: 'session', id: 'ask' });
    expect(restoreShellContext({ kind: 'session', id: 'gone' }, new Set(['C:/ask']), new Set(['ask']))).toEqual({ kind: 'view', id: 'projects' });
  });

  it('quick-open matches visible labels, details, and project names case-insensitively', () => {
    const result = filterShellItems('CHECKOUT', rows, [{ path: 'C:/checkout', name: 'checkout-api', branch: 'main' }]);
    expect(result.projects.map((x) => x.path)).toEqual(['C:/checkout']);
    expect(result.sessions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- src/shared/shellNavigation.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure model**

Define `ShellProjectInput` as `{ path: string; name: string; branch: string | null }`. Define group kinds as `'attention' | 'working' | 'pinned' | 'turn' | 'quiet' | 'previous'`. Sort within groups by case-insensitive label, exclude pinned attention/working rows from the pinned group, and return only non-empty groups. Define contexts as `{ kind: 'view'; id: 'projects' | 'next' | 'usage' | 'settings' } | { kind: 'project'; path: string } | { kind: 'session'; id: string }`. Quick Open trims and lowercases its query, matches session label/detail and project name/branch, and preserves urgency/project ordering.

- [ ] **Step 4: Run focused and shared model tests**

Run: `npm test -- src/shared/shellNavigation.test.ts src/shared/cockpitModel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the navigation model**

```powershell
git add src/shared/shellNavigation.ts src/shared/shellNavigation.test.ts
git commit -m "feat: model shared command center navigation"
```

### Task 3: Shared application shell and explicit view activation

**Files:**
- Create: `src/renderer/shell.ts`
- Create: `src/renderer/shell/shell.css`
- Modify: `src/renderer/index.html:12-77`
- Modify: `src/renderer/nav.ts:1-15`
- Modify: `src/renderer/main.ts:1-190`
- Modify: `src/renderer/locales/{ko,en,ja,zh}.json`

**Interfaces:**
- Consumes: `createIcon()` from Task 1.
- Produces: `mountShell(options): ShellController`.
- `ShellController` exposes `showView(view)`, `setCockpitAvailable(on)`, `setSessionGroups(groups)`, `setProjects(items)`, `setCollapsed(on)`, and `activeView()`.
- `mountNav` returns `show(view: ViewId): void` rather than closing over an inaccessible function.

- [ ] **Step 1: Add a failing pure test for collapse normalization**

Add to `src/shared/shellNavigation.test.ts`:

```ts
import { normalizeSidebarState } from './shellNavigation';

it('accepts only persisted boolean sidebar state', () => {
  expect(normalizeSidebarState(true)).toBe(true);
  expect(normalizeSidebarState('true')).toBe(false);
  expect(normalizeSidebarState(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/shared/shellNavigation.test.ts`

Expected: FAIL because `normalizeSidebarState` is missing.

- [ ] **Step 3: Implement the shell markup and controller**

Replace `#rail` with semantic `#app-sidebar` while retaining `.rail-item[data-view]` on view buttons for compatibility. Use visible localized labels in expanded mode and SVG icons from `createIcon`. Place Quick Open, Projects, Tasks, Usage at the top; session groups and compact project rows in scrollable sections; Settings and Language at the bottom. Move `#ck-list` into the shared sidebar on Windows and leave `#view-cockpit` with only the terminal workspace.

Implement Quick Open as a real text input. Typing filters only the sidebar session/project rows; Enter activates the first visible result and Escape clears the query. Persist the last active `ShellContext` as JSON in renderer-local `localStorage` under `devdeck:shell-context:v1`, validate it through `restoreShellContext` on launch, and never persist terminal output or project data in that key.

Implement `mountNav` as:

```ts
export type ViewId = 'projects' | 'usage' | 'settings' | 'next' | 'cockpit';
export function mountNav(onShow: (view: ViewId) => void): { show(view: ViewId): void; active(): ViewId };
```

Do not auto-switch on new attention. Persist collapse through the existing settings API only after adding a dedicated shell field; until that IPC change is deliberately implemented, reuse `cockpitSidebarCollapsed` for the unified sidebar.

- [ ] **Step 4: Run build and existing navigation QA smoke**

Run: `npm run build`

Expected: PASS with no TypeScript errors.

Run: `npm run qa`

Expected: existing scenes complete; screenshot differences are expected, but structural assertions and console/page error checks pass.

- [ ] **Step 5: Commit the shell**

```powershell
git add src/renderer/index.html src/renderer/shell.ts src/renderer/shell src/renderer/nav.ts src/renderer/main.ts src/renderer/locales
git commit -m "feat: introduce shared command center shell"
```

### Task 4: Row-first project overview and sidebar projects

**Files:**
- Create: `src/renderer/projectOverview.ts`
- Create: `src/renderer/projectOverview.test.ts`
- Create: `src/renderer/features/projects/projects.css`
- Modify: `src/renderer/projectsView.ts:17-755`
- Modify: `src/renderer/index.html:39-62`
- Modify: `src/renderer/main.ts`

**Interfaces:**
- Consumes: `ProjectViewModel` and per-project live activity.
- Produces: `projectRowModel(project, live, cost): ProjectRowModel` with `headline`, `branchLine`, `cue`, `state`, `secondary`, and `primaryLabelKey`.
- `projectsView` publishes `onProjectsChanged(listener)`, `currentProjects()`, and `focusProject(path)` without exposing mutable arrays.

- [ ] **Step 1: Write failing project hierarchy tests**

```ts
import { describe, expect, it } from 'vitest';
import { projectRowModel } from './projectOverview';
import type { ProjectViewModel } from '../shared/types';

it('keeps the resume cue primary and moves cost/providers to secondary metadata', () => {
  const project = { name: 'checkout-api', branch: 'main', uncommitted: 3, ahead: 1, resumeCue: { kind: 'lastMessage', text: 'review migration output' }, sessionCount: 2 } as ProjectViewModel;
  expect(projectRowModel(project, 'attention', 1.34)).toMatchObject({
    headline: 'checkout-api', cue: 'review migration output', state: 'attention', primaryLabelKey: 'common.open',
  });
  expect(projectRowModel(project, 'attention', 1.34).secondary).toContain('~$1.34');
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- src/renderer/projectOverview.test.ts`

Expected: FAIL because `projectOverview.ts` does not exist.

- [ ] **Step 3: Implement row models and make list mode the default**

Set `viewMode` default to `'list'`. Reduce the always-visible toolbar to New Project, search, sort, and aggregate status. Move hidden count, view mode, and secondary filters into a display menu. Render the same row model in the main overview and a more compact model in `#shell-projects`. A compact sidebar project click activates Projects, clears unrelated filtering, scrolls the corresponding row into view, selects it, and places focus on the row; it does not launch an agent until Open is invoked. Preserve `cardCache`, `reconcileChildren`, provider-aware Open, task badge, GitHub/editor/folder actions, and multi-select semantics.

- [ ] **Step 4: Run focused tests, build, and project screenshot scenes**

Run: `npm test -- src/renderer/projectOverview.test.ts src/renderer/projectMemoryPresentation.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run qa`

Expected: project refresh node reuse, narrow overflow, provider menu containment, and console/page error checks pass.

- [ ] **Step 5: Commit the project overview**

```powershell
git add src/renderer/projectOverview.ts src/renderer/projectOverview.test.ts src/renderer/features/projects src/renderer/projectsView.ts src/renderer/index.html src/renderer/main.ts
git commit -m "feat: redesign project overview as status board"
```

### Task 5: Integrate Cockpit sessions into the shared sidebar

**Files:**
- Create: `src/renderer/features/cockpit/cockpit.css`
- Modify: `src/renderer/cockpitView.ts:21-930`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/shared/cockpitModel.ts`
- Modify: `src/shared/cockpitModel.test.ts`

**Interfaces:**
- Consumes: `ShellSessionInput` and `buildSessionGroups` from Task 2.
- Produces: `cockpitNavigationItems(): ShellSessionInput[]` and `onCockpitNavigationChange(listener): () => void`.
- Produces: `sessionNavigationItem(session, label, detail, pinned): ShellSessionInput` as the pure adapter used by `cockpitNavigationItems()`.
- Session-row activation invokes the shell's explicit `showView('cockpit')` before selecting the terminal.

- [ ] **Step 1: Write a failing urgency/deduplication test**

Add to `src/shared/cockpitModel.test.ts`:

```ts
it('adapts a cockpit session without losing project ownership or activity', () => {
  const session = { id: 'a', projectPath: 'C:/a', name: 'repo', agentId: 'codex', status: 'running', staleLevel: 'fresh', branch: 'main', dirty: 0, activity: 'attention' } as CockpitSession;
  expect(sessionNavigationItem(session, 'review api', 'main · Codex', true)).toEqual({
    id: 'a', projectPath: 'C:/a', label: 'review api', detail: 'main · Codex', activity: 'attention', pinned: true,
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/shared/cockpitModel.test.ts`

Expected: FAIL because `sessionNavigationItem` is missing.

- [ ] **Step 3: Publish session navigation and simplify the workspace header**

Adapt the existing `renderList` grouping through the shared navigation model without changing `Live`, PTY, persistence, activity polling, notification, or metadata behavior. Replace emoji activity marks, brain, clock, folder, pin, rename, and close glyphs with local SVG icons plus localized text/labels. Keep context percentage text visible. Session click must activate Cockpit and then select the existing terminal node; it must never respawn or remount it.

Remove the nested Cockpit sidebar width from `.ck-wrap`; the terminal main pane should fill the shared content area. Retain a one-click global sidebar collapse control for maximum terminal width.

- [ ] **Step 4: Run Cockpit tests and QA geometry checks**

Run: `npm test -- src/shared/cockpitModel.test.ts src/renderer/agentSelection.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run qa`

Expected: Cockpit main/content height ratio remains at least 0.8, usage footer stays 26px, long names remain contained, and zero-attention badge remains hidden.

- [ ] **Step 5: Commit session integration**

```powershell
git add src/renderer/features/cockpit src/renderer/cockpitView.ts src/renderer/index.html src/renderer/main.ts src/shared/cockpitModel.ts src/shared/cockpitModel.test.ts
git commit -m "feat: integrate live sessions into command center"
```

### Task 6: Convert Project Memory to drawer and narrow sheet

**Files:**
- Create: `src/renderer/projectMemorySurface.ts`
- Create: `src/renderer/projectMemorySurface.test.ts`
- Modify: `src/renderer/projectMemoryModal.ts`
- Modify: `src/renderer/design/components.css`
- Modify: `qa/screenshot.mjs`
- Modify: `qa/audit.mjs`

**Interfaces:**
- Produces: `memorySurfaceMode(width: number): 'drawer' | 'sheet'` with drawer at widths `>= 720` and sheet below 720.
- `openProjectMemoryModal` keeps its existing public signature to avoid changing callers.

- [ ] **Step 1: Write the failing mode test**

```ts
import { describe, expect, it } from 'vitest';
import { memorySurfaceMode } from './projectMemorySurface';

describe('memorySurfaceMode', () => {
  it('uses an overlay drawer on wide layouts and a sheet on narrow layouts', () => {
    expect(memorySurfaceMode(1000)).toBe('drawer');
    expect(memorySurfaceMode(719)).toBe('sheet');
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- src/renderer/projectMemorySurface.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement responsive surface semantics**

Keep `role="dialog"`, `aria-modal="true"`, labelled title, Escape handling, focus trap, outside click, loading, retry, and trigger focus restoration. Add mode classes computed at open and updated on resize. A drawer overlays from the right and must not alter `#content`, `.ck-main`, or terminal bounds. The sheet fills the viewport width below 720px without horizontal overflow.

- [ ] **Step 4: Extend and run memory QA**

Add screenshot assertions for right-edge alignment at 1000px, full-width containment at 520px, unchanged terminal/content geometry while open, Escape close, and focus return.

Run: `npm test -- src/renderer/projectMemorySurface.test.ts src/renderer/projectMemoryPresentation.test.ts`

Expected: PASS.

Run: `npm run qa && npm run qa:audit`

Expected: Project Memory scenes and axe checks pass with no overflow.

- [ ] **Step 5: Commit the drawer**

```powershell
git add src/renderer/projectMemorySurface.ts src/renderer/projectMemorySurface.test.ts src/renderer/projectMemoryModal.ts src/renderer/design/components.css qa/screenshot.mjs qa/audit.mjs
git commit -m "feat: present project memory as responsive drawer"
```

### Task 7: Align Tasks, Usage, Settings, dialogs, and footer

**Files:**
- Create: `src/renderer/features/secondary.css`
- Modify: `src/renderer/nextView.ts`
- Modify: `src/renderer/usageView.ts`
- Modify: `src/renderer/settingsView.ts`
- Modify: `src/renderer/usageModal.ts`
- Modify: `src/renderer/usageBar.ts`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/locales/{ko,en,ja,zh}.json`

**Interfaces:**
- Consumes: shared `.ui-toolbar`, `.ui-button`, `.ui-row`, `.ui-dialog`, and typography tokens.
- Produces no new data or IPC contracts.

- [ ] **Step 1: Add a failing localization completeness assertion**

Append the exact shell keys to the existing `REQUIRED` array in `src/shared/i18n.test.ts`:

```ts
'shell.quick_open', 'shell.needs_you', 'shell.working',
'shell.projects', 'shell.collapse', 'shell.expand',
```

- [ ] **Step 2: Run the test and verify missing keys fail**

Run: `npm test -- src/shared/i18n.test.ts`

Expected: FAIL listing the new shell keys.

- [ ] **Step 3: Apply shared visual primitives without changing feature behavior**

Tasks keeps add, due date, filters, completion, calendar, and provider-aware Open. Usage keeps three cost cards, provider filters, tables, charts, and local-only copy. Settings keeps every current field and callback. Dialogs retain fixed overlays, focus traps, Escape behavior, and geometry stability. Remove migrated selectors from `styles.css` only after their replacement selectors are active.

- [ ] **Step 4: Run localization, build, screenshot, and axe checks**

Run: `npm test -- src/shared/i18n.test.ts`

Expected: PASS.

Run: `npm run build && npm run qa && npm run qa:audit`

Expected: PASS; all four languages render, provider controls remain contained, Usage has three headline cards, and the footer remains exactly 26px.

- [ ] **Step 5: Commit secondary surfaces**

```powershell
git add src/renderer/features/secondary.css src/renderer/nextView.ts src/renderer/usageView.ts src/renderer/settingsView.ts src/renderer/usageModal.ts src/renderer/usageBar.ts src/renderer/styles.css src/renderer/locales
git commit -m "feat: align secondary views with command center"
```

### Task 8: Full shell QA, compatibility cleanup, and documentation

**Files:**
- Modify: `qa/screenshot.mjs`
- Modify: `qa/audit.mjs`
- Modify: `README.md`
- Modify: `docs/screenshots/*.png` through the existing deterministic capture workflow
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Verifies every interface from Tasks 1-7; produces no runtime API.

- [ ] **Step 1: Add final shared-shell assertions before cleanup**

In `qa/screenshot.mjs`, assert:

```js
const shellGeometry = await win.evaluate(() => {
  const shell = document.getElementById('shell')?.getBoundingClientRect();
  const sidebar = document.getElementById('app-sidebar')?.getBoundingClientRect();
  const content = document.getElementById('content')?.getBoundingClientRect();
  return {
    present: !!shell && !!sidebar && !!content,
    contained: !!shell && !!sidebar && !!content && sidebar.left >= shell.left && content.right <= shell.right,
    overlap: !!sidebar && !!content && sidebar.right > content.left + 1,
  };
});
if (!shellGeometry.present || !shellGeometry.contained || shellGeometry.overlap) {
  console.error('QA FAILED — shared shell geometry is invalid:', JSON.stringify(shellGeometry));
  await closeApp(); process.exit(1);
}
```

Also capture expanded/collapsed sidebar, Needs You selection, project overview list/card, Cockpit workspace, memory drawer/sheet, all secondary views, and all four languages.

- [ ] **Step 2: Run the complete unit suite before deleting compatibility CSS**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Remove superseded CSS and stale emoji-specific presentation**

Delete only declarations proven unused by `rg` against renderer HTML/TypeScript. Keep compatibility class names required by QA or runtime selectors until their assertions and callers are updated in the same change. Replace README screenshots and product description to show the shared command center without claiming unsupported light mode or non-Windows embedded terminals.

- [ ] **Step 4: Run final build and QA gates**

Run: `npm run build`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run qa`

Expected: PASS with zero console errors and zero page errors.

Run: `npm run qa:audit`

Expected: PASS with zero WCAG A/AA violations on Projects, Cockpit, Tasks, Usage, Settings, Project Memory, and the usage dialog.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Commit final QA and documentation**

```powershell
git add qa README.md docs/screenshots src/renderer/styles.css
git commit -m "test: verify command center redesign"
```

---

## Final acceptance checklist

- [ ] Shared expanded/collapsed sidebar works with pointer and keyboard.
- [ ] Needs You and Working sessions are visible from every primary context.
- [ ] Selecting a live session activates its existing Cockpit terminal without remounting it.
- [ ] Projects default to the row-first status board and retain optional cards.
- [ ] Provider-aware Open behavior is unchanged.
- [ ] Project Memory is an overlay drawer at 1000px and contained sheet at 520px.
- [ ] Tasks, Usage, Settings, dialogs, and footer use the shared design system.
- [ ] All four languages fit without unintended horizontal overflow.
- [ ] Terminal fill ratio, usage footer height, node reuse, menu containment, and focus restoration assertions pass.
- [ ] Build, complete Vitest suite, Playwright screenshot QA, axe audit, and `git diff --check` pass.
