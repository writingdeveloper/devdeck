# Command Center Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every merge-blocking command-center review finding while preserving terminal, IPC, localization, and responsive-layout behavior.

**Architecture:** Keep Cockpit as an internal renderer route, but make the shared shell the only user-facing navigation model. Reconcile sidebar entities by stable keys, centralize active-context synchronization, and make startup restoration a one-shot coordinator that cannot override later user intent. Move secondary project controls into an accessible display menu without changing their existing handlers.

**Tech Stack:** Electron 43, TypeScript 5.5, vanilla DOM, Vitest 3, Playwright 1.62, axe-core.

## Global Constraints

- Do not introduce React, Tailwind, a new UI framework, or a new IPC contract.
- Preserve all existing provider-aware Open, project selection, Cockpit terminal lifecycle, and persisted-session behavior.
- Preserve Korean, English, Japanese, and Chinese localization.
- Preserve WCAG 2.1 AA, keyboard parity, focus restoration, terminal geometry, and narrow-layout containment.
- Every behavior change follows a red-green test cycle and each task ends in a focused commit.

---

### Task 1: Stable, synchronized, accessible shell entities

**Files:**
- Modify: `src/renderer/shell.ts`
- Modify: `src/renderer/shell/shell.css`
- Modify: `src/shared/shellNavigation.ts`
- Modify: `src/shared/shellNavigation.test.ts`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/shared/i18n.test.ts`
- Modify: `qa/screenshot.mjs`

**Interfaces:**
- `ShellController` adds `setActiveProject(path: string | null): void` and `setActiveSession(id: string | null): void`.
- `shellEntityKey(kind, id)` returns stable `project:<path>` or `session:<id>` keys.
- `sessionAccessibleLabel(item, localizedStatus)` includes label, detail, and explicit status.

- [ ] **Step 1: Write failing model and localization tests**

Add tests proving entity keys remain stable, session accessible labels include localized status, and required status keys exist in all four locales.

- [ ] **Step 2: Run focused tests and verify the new expectations fail**

Run: `npm test -- src/shared/shellNavigation.test.ts src/shared/i18n.test.ts`

Expected: FAIL because the helpers/status keys do not exist.

- [ ] **Step 3: Implement keyed reconciliation and context synchronization**

Maintain keyed caches for session and project buttons. Update existing nodes in place, move them into the required grouped order, and remove only missing keys. Preserve focus when an unchanged key is refreshed. Make group labels semantic headings, associate sections through `aria-labelledby`, and give every session button an accessible name containing its localized activity label. Programmatic active setters must update `.selected` and `aria-current` on all current and subsequently reconciled rows.

Quick Open must flatten filtered sessions through `buildSessionGroups`, activate the first urgency-ordered result, clear the query after activation, and synchronize the active entity.

- [ ] **Step 4: Add real shell refresh QA**

Focus an existing sidebar project, invoke the real refresh path, and assert that the same DOM node remains focused. Verify session sections expose headings and session rows include status text when sessions exist.

- [ ] **Step 5: Run focused tests, build, and screenshot QA**

Run: `npm test -- src/shared/shellNavigation.test.ts src/shared/i18n.test.ts`

Run: `npm run build && npm run qa`

Expected: PASS with stable sidebar node/focus assertions and zero console/page errors.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/shell.ts src/renderer/shell/shell.css src/shared/shellNavigation.ts src/shared/shellNavigation.test.ts src/renderer/locales src/shared/i18n.test.ts qa/screenshot.mjs
git commit -m "fix: stabilize shared shell navigation"
```

### Task 2: Deterministic context restoration and internal Cockpit routing

**Files:**
- Create: `src/shared/contextRestore.ts`
- Create: `src/shared/contextRestore.test.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/nav.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/cockpitView.ts`
- Modify: `qa/screenshot.mjs`
- Modify: `qa/audit.mjs`

**Interfaces:**
- `createContextRestoreCoordinator(saved, cockpitAvailable)` exposes `projectsLoaded(paths)`, `sessionsLoaded(ids)`, `cancel()`, and returns one restore decision at most once.
- `mountNav` retains `show('cockpit')` for internal activation while no `.rail-item[data-view="cockpit"]` is user-facing.
- Notification activation emits the existing Cockpit navigation callback rather than clicking a removed rail button.

- [ ] **Step 1: Write failing coordinator tests**

Cover a valid project restore, a missing project fallback after the project source loads, a valid session restore after the session source loads, a missing/unavailable session fallback, and cancellation before delayed data arrives. Assert no coordinator returns more than one decision.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- src/shared/contextRestore.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement one-shot restore and active shell synchronization**

Apply restoration only after the requested entity's relevant source has completed its initial load. Persist the Projects fallback, clear the pending request after the first decision, and cancel it on user navigation. Every project/session restore or programmatic open calls the Task 1 active setter. A view activation clears entity selection unless it is the internal Cockpit route selected through a session.

- [ ] **Step 4: Remove the standalone Cockpit destination**

Delete the Cockpit rail button but keep `#view-cockpit` and the internal `ViewId`. Replace notification button-click routing with an exported renderer callback that shows Cockpit, selects the existing session, persists the session context, and marks the matching shared-shell row active. Update QA selectors to enter Cockpit through a real session route when available and skip the Windows-only view otherwise.

- [ ] **Step 5: Run focused tests, full build, and Electron audits**

Run: `npm test -- src/shared/contextRestore.test.ts src/shared/shellNavigation.test.ts src/shared/cockpitModel.test.ts`

Run: `npm run build && npm run qa && npm run qa:audit`

Expected: PASS; no standalone Cockpit navigation button; restored/programmatic entities have selected state; no terminal remount or geometry regression.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/contextRestore.ts src/shared/contextRestore.test.ts src/renderer/main.ts src/renderer/nav.ts src/renderer/index.html src/renderer/cockpitView.ts qa/screenshot.mjs qa/audit.mjs
git commit -m "fix: make shell context restoration deterministic"
```

### Task 3: Simplified project controls and remaining icon migration

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/projectsView.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/shutdown.ts`
- Modify: `src/renderer/icons.ts`
- Modify: `src/renderer/design/components.css`
- Modify: `src/renderer/features/projects/projects.css`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/shared/i18n.test.ts`
- Modify: `qa/screenshot.mjs`
- Modify: `qa/audit.mjs`

**Interfaces:**
- The visible project toolbar contains New Project, search, sort, aggregate status, and an accessible Display menu.
- The Display menu owns hidden-project, list/card mode, and provider controls using the existing handlers.
- `#open-selected` is hidden when selection is empty and visible only when at least one project is selected.

- [ ] **Step 1: Write failing presentation/localization tests**

Add tests for selection-action visibility and all new Display menu labels. Extend audit assertions so the Display trigger has `aria-haspopup="menu"`, correct expanded state, keyboard Escape closure, and labeled menu items.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/renderer/projectOverview.test.ts src/shared/i18n.test.ts`

Expected: FAIL because the visibility helper/labels do not exist.

- [ ] **Step 3: Move secondary controls into the Display menu**

Preserve element IDs and existing event handlers. Implement click, Enter/Space, outside-click, and Escape behavior with focus return. Hide Open Selected while the selection set is empty and reveal it when selection begins. Keep controls contained at 520px in all four languages.

- [ ] **Step 4: Replace remaining structural emoji icons**

Use the local SVG factory for title-bar refresh/theme and shutdown menu controls. Keep decorative provider/content identity unchanged and preserve localized accessible labels and tooltips.

- [ ] **Step 5: Run final local gates**

Run: `npm run build`

Run: `npm test`

Run: `npm run qa`

Run: `npm run qa:audit`

Run: `git diff --check`

Expected: PASS with zero console/page errors, zero serious/critical accessibility violations, and no horizontal overflow.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/index.html src/renderer/projectsView.ts src/renderer/main.ts src/renderer/shutdown.ts src/renderer/icons.ts src/renderer/design/components.css src/renderer/features/projects/projects.css src/renderer/locales src/shared/i18n.test.ts qa
git commit -m "fix: simplify command center controls"
```

## Final acceptance checklist

- [ ] Unchanged sidebar project/session nodes retain identity and focus across refresh.
- [ ] Programmatic and restored project/session contexts synchronize selected styling and `aria-current`.
- [ ] Startup restoration completes once and cannot override subsequent user navigation.
- [ ] Cockpit is reachable through live-session/project workflows but has no standalone global navigation item.
- [ ] Session status is announced as localized text and session groups use semantic headings.
- [ ] Project secondary controls live in one accessible Display menu; Open Selected is contextual.
- [ ] Quick Open preserves urgency order, clears after activation, and updates selected state.
- [ ] Structural navigation/title/shutdown icons use the local SVG set.
- [ ] Build,  complete Vitest suite, screenshot QA, axe audit, GitHub CI, and `git diff --check` pass.
