# DevDeck Hybrid Command Center Redesign

**Date:** 2026-08-09

**Status:** Approved design

**Reference:** Orca (`stablyai/orca`) visual hierarchy and workspace navigation patterns

## 1. Objective

Redesign DevDeck as a cleaner hybrid command center that keeps its project-at-a-glance strength while making live AI sessions faster to monitor and resume.

This is not a visual reskin. The redesign must improve information hierarchy, simplify navigation and primary actions, reduce duplicate Projects/Cockpit flows, and make the renderer easier to maintain. Existing product capabilities, local-first behavior, internationalization, accessibility, and terminal reliability remain intact.

## 2. Product priority

The default experience remains project-oriented: users open DevDeck to understand the state of many repositories and choose what to work on. Live sessions that need attention are elevated above ordinary project activity so users can respond without entering a separate monitoring mode.

The product therefore combines two jobs in one shell:

1. Scan project state and decide what matters.
2. Enter or resume the relevant AI session with minimal context switching.

## 3. Design principles

- **Status before decoration:** color communicates actionable state, not visual personality.
- **One primary action per context:** secondary actions move to hover, overflow, or contextual menus.
- **Progressive disclosure:** show the minimum needed to choose an item; reveal detail after selection.
- **Stable spatial model:** global navigation stays in one sidebar and selected work stays in one main pane.
- **Project and session continuity:** a live session belongs to a project context rather than a disconnected Cockpit destination.
- **Keyboard parity:** every pointer workflow has an equivalent keyboard workflow.
- **Incremental migration:** preserve the Electron and TypeScript architecture; avoid a framework rewrite.

## 4. Application shell

### 4.1 Title bar

Keep the frameless native title bar and window controls. Reduce decorative branding and reserve the central drag area. Global refresh and shutdown controls remain available but use local SVG icons and consistent tooltips instead of emoji glyphs.

### 4.2 Sidebar

Replace the 48px icon rail with a resizable or fixed-width sidebar around 220px. It may collapse to an icon-only state when terminal width is more valuable.

The expanded sidebar is ordered as follows:

1. Quick Open
2. Tasks
3. Usage
4. Needs You sessions
5. Working sessions
6. Projects
7. Settings and language controls

Needs You and Working groups show counts and compact rows. Status is expressed by a small labeled indicator, never by color alone. Quiet and previous sessions live under their project or in an expandable secondary group so they do not compete with active work.

### 4.3 Main pane

The main pane renders one of four contexts:

- Project overview
- Selected project/session workspace
- Task board
- Usage or settings surface

The shell itself does not remount when contexts change. This preserves selection, focus, scroll position, and terminal geometry.

### 4.4 Startup behavior

On launch, restore the last valid context. If it no longer exists, open the project overview. New Needs You sessions appear at the top of the sidebar but do not unexpectedly replace the user's restored screen.

## 5. Project overview

### 5.1 Default presentation

Replace the project card grid as the default with a quiet row-based status board. Retain the card view as an optional display mode for users who prefer it.

Each row contains:

- Live-state indicator and project name
- Branch and working-tree summary
- Current resume cue or latest meaningful activity
- Session state or last activity
- One primary Open action

Task count, unpushed state, providers, cost, timestamps, and secondary file/editor/GitHub actions remain available but are grouped into secondary metadata or the overflow menu. The row must stay readable at the supported narrow width without hiding the primary action.

### 5.2 Toolbar

The overview toolbar contains only:

- View title and actionable aggregate counts
- Search
- Sort
- New project

Live-state filtering moves into clickable sidebar groups. Hidden-project controls and view-mode controls move to a compact overflow or display menu. Multi-select and Open Selected appear only after selection begins.

### 5.3 Project selection

Selecting a row opens the project workspace in the main pane. Opening the primary action uses the current provider-aware resume rules. A row selection and a session selection both resolve to the same project context, avoiding separate navigation models.

## 6. Project and session workspace

### 6.1 Workspace header

The header shows only information needed while working:

- Project or session name
- Branch
- Provider and model
- Live state
- Context usage
- Contextual actions

Cost, history, and less frequent project actions move to a details drawer or overflow menu.

### 6.2 Terminal

The terminal remains the dominant surface and retains its current lifecycle, split-independent geometry, search, clipboard, image-path handling, restart, restore, fork, and session persistence behavior.

The redesign must not change terminal height when dialogs, drawers, provider limits, or sidebar groups open. Collapsing the sidebar increases terminal width without remounting the terminal.

### 6.3 Needs You workflow

The preferred loop is:

1. Select a Needs You session in the sidebar.
2. Review the project context and terminal output.
3. Respond in the existing terminal.
4. When the agent resumes working, the item moves to Working.
5. Keyboard navigation selects the next Needs You item when requested by the user; it does not auto-switch without input.

### 6.4 Session actions

Resume, restore, start new, fork, rename, pin, and close use one consistent contextual action pattern. The primary action reflects the current state. Destructive actions keep explicit confirmation and focus restoration.

## 7. Project Memory

Replace the large central Project Memory modal with a right-side details drawer on wide layouts. The drawer contains the existing snapshot and timeline data and does not replace or resize the main context unexpectedly.

At narrow widths, the drawer becomes a full-width modal sheet. It preserves dialog semantics, Escape handling, focus trapping, and focus return to its trigger.

No Project Memory data contract or local-only behavior changes are required.

## 8. Tasks, Usage, and Settings

These remain dedicated main-pane contexts inside the shared shell.

- **Tasks:** simplify the add/filter toolbar and use the same row, status, menu, and provider-open primitives as Projects.
- **Usage:** retain the three headline cost summaries and detailed filtering, but align typography, spacing, tabs, tables, and dialogs with the new tokens.
- **Settings:** divide settings into clearly labeled sections with consistent control rows; keep About and update state secondary.

The calendar, usage modal, provider limits, localization, and existing data flows remain functionally unchanged.

## 9. Visual system

### 9.1 Typography

Use a bundled Geist variable font for the interface and retain Cascadia Mono/Consolas fallbacks for terminal and code metadata. Establish a small, explicit scale for metadata, body, row labels, section titles, and view titles.

### 9.2 Icons

Replace navigation and action emoji with a curated local SVG icon set. Decorative emoji may remain only where it is part of provider or content identity. Every icon-only action has an accessible label and tooltip.

### 9.3 Color and surfaces

Use neutral surfaces with low-contrast structural borders:

- App canvas
- Sidebar surface
- Raised or selected surface
- Popover/dialog surface

Reserve semantic color for Needs You, Working, success, warning, destructive, provider identity, and focus. Selected rows primarily use surface contrast and shape rather than saturated color.

### 9.4 Spacing and shape

Define shared spacing, radius, border, shadow, focus-ring, motion, and density tokens. Repeated rows use restrained radii and separators instead of making every item a floating card.

### 9.5 Themes

Dark mode is the first complete theme because it matches the current product and terminal environment. Tokens must support a future light theme without changing component contracts. A light-theme toggle is not part of the first implementation unless all redesigned surfaces meet the same contrast and QA standards.

## 10. Renderer architecture

Keep the existing Electron main/preload/renderer boundary and vanilla TypeScript DOM approach.

Split the renderer into the following layers:

- `design/`: tokens, typography, icons, and base styles
- `shell/`: title bar, sidebar, context routing, and responsive behavior
- `components/`: reusable button, menu, row, status, toolbar, drawer, dialog, and empty/error primitives
- `features/projects/`: project overview and project-context presentation
- `features/sessions/`: session groups, session rows, and workspace header
- Existing feature modules for tasks, usage, settings, and terminal behavior

DOM construction and event/state coordination should be separated. Components accept normalized view models and emit typed actions; feature modules continue to own IPC calls and product state.

The migration must not introduce React, Tailwind, or a new UI framework. This keeps scope focused on the redesign and avoids rewriting tested renderer behavior.

## 11. Data and state flow

Existing IPC contracts remain authoritative. The renderer derives a unified navigation model from project data, live session state, persisted cockpit entries, tasks, and usage summaries.

State updates follow this flow:

1. Main process and existing scanners provide normalized data through current IPC APIs.
2. Feature modules convert data into presentation models.
3. The shell reconciles sidebar groups and active context without replacing unchanged DOM nodes.
4. Component actions call feature handlers.
5. Feature handlers invoke IPC and update only affected presentation models.

Project rows and sidebar session rows must preserve node identity during refresh where practical, matching the current smooth-refresh guarantee.

## 12. Error, loading, and empty states

- Use skeletons only for initial content whose geometry is known.
- Replace indefinite skeletons with localized inline error states and retry actions.
- Preserve last-good provider usage and mark its age, matching current behavior.
- Use toast notifications for completed or failed user actions, not for persistent page-level errors.
- Empty states explain the next useful action and never resemble a filtered zero-result state.
- A failed secondary panel must not blank the terminal or project overview.

## 13. Accessibility and localization

- Preserve WCAG 2.1 AA audit coverage.
- All navigation, menus, drawers, dialogs, and row actions support keyboard operation.
- Focus remains visible and is restored after transient surfaces close.
- Status is represented by text and shape as well as color.
- Hover-revealed actions also appear on keyboard focus and touch-capable layouts.
- Korean, English, Japanese, and Chinese labels must fit without vertical single-character wrapping.
- Window controls retain native-purpose labels regardless of interface language.

## 14. Verification strategy

### 14.1 Automated tests

- Retain the full Vitest suite.
- Add unit tests for navigation-model derivation, status grouping, active-context restoration, and contextual primary-action selection.
- Add component interaction tests for menus, drawer focus behavior, row keyboard behavior, and collapsed sidebar state.

### 14.2 Playwright QA

Extend the existing screenshot harness to cover:

- Expanded and collapsed shell
- Project overview in list and optional card modes
- Needs You and Working groups
- Selected session workspace
- Project Memory drawer and narrow modal sheet
- Tasks, Usage, Settings, provider menus, and usage dialog
- All four languages
- 520px and 1000px layouts

Existing geometry assertions remain mandatory, especially terminal fill ratio, 26px usage footer height, provider menu containment, card/row reconciliation, and narrow-layout overflow.

### 14.3 Accessibility QA

Run axe against every primary context and transient surface. Add manual keyboard checks for Quick Open, sidebar groups, session switching, menus, drawer open/close, and focus restoration.

### 14.4 Completion criteria

The redesign is complete when:

- All existing unit tests pass.
- Build, screenshot QA, and accessibility audit pass without console or page errors.
- No supported viewport has unintended horizontal overflow.
- All four languages remain usable.
- Terminal geometry and session persistence behavior are unchanged.
- Projects and live sessions can be navigated through the shared shell without entering a disconnected Cockpit page.

## 15. Delivery boundaries

Included:

- Shared design system and shell
- Project overview redesign
- Session navigation and workspace integration
- Project Memory drawer
- Visual alignment of Tasks, Usage, Settings, dialogs, and empty/error states
- Renderer decomposition necessary to support the redesign
- Automated and visual QA updates

Excluded from this redesign:

- Main-process scanner or IPC protocol rewrites
- New agent providers
- New worktree orchestration features
- React/Tailwind migration
- Mobile application
- Mandatory light theme

## 16. Implementation sequence

Implementation should proceed in verified vertical slices:

1. Design tokens, typography, icons, and reusable primitives
2. Shared shell and navigation model
3. Project overview
4. Session workspace integration
5. Project Memory drawer
6. Tasks, Usage, and Settings alignment
7. Full regression, accessibility, localization, and visual QA

Each slice must keep the application buildable and preserve unrelated user behavior.
