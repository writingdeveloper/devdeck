# Project Memory Timeline and Resume Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand, local-only project Memory dialog that combines a deterministic resume snapshot with a bounded cross-provider activity timeline.

**Architecture:** Pure shared helpers parse Git records and project stored/session facts into one stable `ProjectMemory` contract. A main-process service performs bounded reads, partial-failure handling, concurrency limiting, and a 15-second per-project promise cache; IPC exposes it through the preload bridge. A focused renderer modal presents the snapshot and timeline and reuses the existing provider-aware open/session routing.

**Tech Stack:** Electron 43, TypeScript 5.5, vanilla DOM renderer, Vitest 3, Playwright Electron, axe-core, CSS, JSON locale dictionaries.

## Global Constraints

- Existing primary **Open** remains one-click and never opens Memory implicitly.
- Memory performs no network request and invokes no agent CLI.
- First response is capped at 40 events from at most 20 commits and 10 sessions.
- Transcript reads reuse provider readers and are limited to three concurrent last-message reads.
- Memory cache TTL is exactly 15 seconds and manual refresh invalidates only the selected project.
- No new state is persisted; notes and task completion are not fabricated as historical events.
- All untrusted text is rendered with DOM text APIs, never `innerHTML`.
- New user-facing strings ship in Korean, English, Japanese, and Chinese.

---

### Task 1: Shared memory contract, Git parser, and deterministic projection

**Files:**
- Create: `src/shared/projectMemory.ts`
- Create: `src/shared/projectMemory.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: `AgentId`, `ProjectSession`, `StoreEntry`, `GitInfo`, and `Todo`.
- Produces: `RecentCommit`, `ProjectMemoryEvent`, `ResumeSnapshot`, `ProjectMemory`, `parseRecentCommits(raw)`, and `buildProjectMemory(input)`.

- [ ] **Step 1: Write failing tests for parsing, projection, and merge limits**

```ts
it('parses delimiter-safe commit records and skips malformed records', () => {
  expect(parseRecentCommits('abc123\u001f1720000000\u001fsubject | safe\u001eBAD\u001e')).toEqual([
    { hash: 'abc123', at: 1_720_000_000_000, subject: 'subject | safe' },
  ]);
});

it('uses the newest session last message and merges stable bounded events', () => {
  const memory = buildProjectMemory(fixtureWithCrossProviderSessionsAnd45Events);
  expect(memory.snapshot.continueFrom).toMatchObject({ text: 'finish auth tests', agentId: 'codex' });
  expect(memory.events).toHaveLength(40);
  expect(memory.events.map((e) => e.at)).toEqual([...memory.events.map((e) => e.at)].sort((a, b) => b - a));
});

it('orders next tasks by overdue, today, future, then creation and reports the remainder', () => {
  expect(buildProjectMemory(taskFixture).snapshot.nextTasks.map((t) => t.id)).toEqual(['overdue', 'today', 'future']);
  expect(buildProjectMemory(taskFixture).snapshot.remainingTaskCount).toBe(1);
});
```

- [ ] **Step 2: Run Task 1 tests and confirm RED**

Run: `npx vitest run src/shared/projectMemory.test.ts`

Expected: FAIL because `src/shared/projectMemory.ts` and exported memory types do not exist.

- [ ] **Step 3: Implement the contract and pure helpers**

```ts
export function parseRecentCommits(raw: string): RecentCommit[] {
  return raw.split('\u001e').flatMap((record) => {
    const [hash, seconds, ...subject] = record.trim().split('\u001f');
    const at = Number(seconds) * 1000;
    return /^[0-9a-f]{4,40}$/i.test(hash) && Number.isFinite(at) && at > 0 && subject.length
      ? [{ hash, at, subject: subject.join('\u001f').trim() }]
      : [];
  });
}

export function buildProjectMemory(input: ProjectMemoryInput): ProjectMemory {
  // choose newest session, derive snapshot, create valid task/session/commit/open events,
  // stable-sort by at then kind/id, slice(0, 40), and preserve input.partial.
}
```

- [ ] **Step 4: Run Task 1 tests and the related shared suite**

Run: `npx vitest run src/shared/projectMemory.test.ts src/shared/tasks.test.ts src/shared/gitParse.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/shared/types.ts src/shared/projectMemory.ts src/shared/projectMemory.test.ts
git commit -m "feat: model project memory timeline"
```

### Task 2: Bounded main-process memory loader and cache

**Files:**
- Create: `src/main/projectMemory.ts`
- Create: `src/main/projectMemory.test.ts`
- Modify: `src/main/gitInfo.ts`
- Modify: `src/main/gitInfo.test.ts`

**Interfaces:**
- Consumes: `buildProjectMemory`, a `StoreEntry`, aggregate `ProjectSession[]`, and provider-owned `lastUserMessage` readers.
- Produces: `getRecentCommits(dir, limit, run)`, `makeProjectMemoryService(deps)`, `service.get(path, fresh?)`, and a complete `ProjectMemory`.

- [ ] **Step 1: Write failing tests for Git command, degradation, concurrency, and cache**

```ts
it('requests exactly 20 delimiter-safe commits', async () => {
  const calls: string[][] = [];
  await getRecentCommits('C:/repo', 20, async (args) => { calls.push(args); return ''; });
  expect(calls[0]).toEqual(['-C', 'C:/repo', 'log', '-20', '--format=%h%x1f%at%x1f%s%x1e']);
});

it('shares an in-flight cache hit and refreshes only the requested project', async () => {
  const service = makeProjectMemoryService(countingDeps);
  expect(service.get('C:/a')).toBe(service.get('C:/a'));
  await service.get('C:/b');
  await service.get('C:/a', true);
  expect(readCounts).toEqual({ a: 2, b: 1 });
});

it('limits last-message reads to three and reports a failed source as partial', async () => {
  const result = await makeProjectMemoryService(concurrencyDeps).get('C:/a');
  expect(maxInFlight).toBe(3);
  expect(result.partial).toContain('git');
  expect(result.events.some((e) => e.kind === 'session')).toBe(true);
});
```

- [ ] **Step 2: Run Task 2 tests and confirm RED**

Run: `npx vitest run src/main/projectMemory.test.ts src/main/gitInfo.test.ts`

Expected: FAIL because the service and recent-commit reader are absent.

- [ ] **Step 3: Implement recent Git reading and the service**

```ts
export function makeProjectMemoryService(deps: ProjectMemoryDeps): ProjectMemoryService {
  const cache = new Map<string, { expiresAt: number; promise: Promise<ProjectMemory> }>();
  return {
    get(path, fresh = false) {
      const key = cwdKey(path);
      if (fresh) cache.delete(key);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > deps.now()) return hit.promise;
      const promise = loadProjectMemory(path, deps);
      cache.set(key, { expiresAt: deps.now() + 15_000, promise });
      return promise;
    },
  };
}
```

Use a three-worker order-preserving mapper for last messages, catch Git and session discovery independently, and feed successful data plus `partial` into the pure builder.

- [ ] **Step 4: Run Task 2 tests and adjacent session tests**

Run: `npx vitest run src/main/projectMemory.test.ts src/main/gitInfo.test.ts src/main/sessions.test.ts src/main/codexSessions.test.ts src/main/antigravitySessions.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/main/projectMemory.ts src/main/projectMemory.test.ts src/main/gitInfo.ts src/main/gitInfo.test.ts
git commit -m "feat: load bounded project memory"
```

### Task 3: Allowlisted IPC and preload bridge

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/ipc.guard.test.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/global.d.ts`

**Interfaces:**
- Consumes: `makeProjectMemoryService`, `makeDeckScan`, `getProvider`, `Store.get`, and `isAllowedPath`.
- Produces: IPC `project:memory(path, fresh)`, `window.devdeck.projectMemory(path, fresh?)`.

- [ ] **Step 1: Add failing IPC tests for rejection and valid partial response**

```ts
it('does not read project memory outside configured folders', async () => {
  const handler = registered.get('project:memory')!;
  expect(await handler({}, 'C:/outside', false)).toMatchObject({ projectPath: '', events: [] });
  expect(memoryReadCount).toBe(0);
});

it('returns allowed project memory without mutating state', async () => {
  const before = readFileSync(stateFile, 'utf8');
  const result = await registered.get('project:memory')!({}, allowedPath, true);
  expect(result.projectPath).toBe(allowedPath);
  expect(readFileSync(stateFile, 'utf8')).toBe(before);
});
```

- [ ] **Step 2: Run the guard tests and confirm RED**

Run: `npx vitest run src/main/ipc.guard.test.ts`

Expected: FAIL because no `project:memory` handler is registered.

- [ ] **Step 3: Register one service instance and expose the typed bridge**

```ts
ipcMain.handle('project:memory', (_e, projectPath: string, fresh?: boolean) => {
  const path = String(projectPath);
  if (!isAllowedPath(effFolders(), path)) return emptyProjectMemory();
  return memoryService.get(path, fresh === true);
});
```

Add `projectMemory: (path, fresh) => ipcRenderer.invoke('project:memory', path, fresh === true)` and the matching `global.d.ts` return type.

- [ ] **Step 4: Run IPC/preload compilation checks**

Run: `npx vitest run src/main/ipc.guard.test.ts src/main/ipc.cockpit.test.ts && npm run build`

Expected: PASS and build exit code 0.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/main/ipc.ts src/main/ipc.guard.test.ts src/preload/preload.ts src/renderer/global.d.ts
git commit -m "feat: expose project memory over ipc"
```

### Task 4: Pure renderer presentation helpers

**Files:**
- Create: `src/renderer/projectMemoryPresentation.ts`
- Create: `src/renderer/projectMemoryPresentation.test.ts`

**Interfaces:**
- Consumes: `ProjectMemory`, `ProjectMemoryEvent`, current time, and locale-aware translation callbacks.
- Produces: `snapshotRows(memory, now)`, `timelineRows(memory, now)`, and bounded one-line display strings used by the modal.

- [ ] **Step 1: Write failing renderer presentation tests**

```ts
it('omits empty optional snapshot rows and labels a clean working tree', () => {
  expect(snapshotRows(cleanFixture, NOW).map((r) => r.kind)).toEqual(['continue', 'working-tree', 'latest-change']);
  expect(snapshotRows(cleanFixture, NOW).find((r) => r.kind === 'working-tree')?.valueKey).toBe('memory.clean');
});

it('keeps source text as data and returns exact session actions', () => {
  const rows = timelineRows(xssFixture, NOW);
  expect(rows[0].title).toBe('<img src=x onerror=alert(1)>');
  expect(rows[0].action).toEqual({ kind: 'session', sessionId: 'abc', agentId: 'claude' });
});
```

- [ ] **Step 2: Run Task 4 tests and confirm RED**

Run: `npx vitest run src/renderer/projectMemoryPresentation.test.ts`

Expected: FAIL because the presentation helper module is absent.

- [ ] **Step 3: Implement minimal pure row projection**

```ts
export interface TimelineRow {
  id: string;
  kind: ProjectMemoryEvent['kind'];
  at: number;
  title: string;
  detail: string | null;
  action: { kind: 'session'; sessionId: string; agentId: AgentId }
    | { kind: 'copy'; text: string }
    | { kind: 'tasks' }
    | null;
}
```

Keep raw user strings separate from translation keys and formatting metadata so the modal always assigns them with `textContent`.

- [ ] **Step 4: Run Task 4 tests**

Run: `npx vitest run src/renderer/projectMemoryPresentation.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src/renderer/projectMemoryPresentation.ts src/renderer/projectMemoryPresentation.test.ts
git commit -m "feat: present project memory facts"
```

### Task 5: Accessible Memory modal and Projects integration

**Files:**
- Create: `src/renderer/projectMemoryModal.ts`
- Modify: `src/renderer/projectsView.ts`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ko.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/zh.json`

**Interfaces:**
- Consumes: `window.devdeck.projectMemory`, Task 4 row helpers, `openInTerminal`, `presetBoardProject`, `createProviderOpenControl`, provider logos, and the selected project view model.
- Produces: `openProjectMemoryModal(project, trigger)`, card/list Memory buttons, refresh/retry, exact session resume, hash copy, filtered task-board navigation, and focus restoration.

- [ ] **Step 1: Add a failing integration assertion to the QA audit harness**

Add an audit block that opens the first `.project-memory-button` and asserts this literal shape:

```js
{
  present: true,
  role: true,
  ariaModal: true,
  titleLabelled: true,
  snapshotRowsAtLeast: 1,
  timelineRowsAtLeast: 1,
  closeLabelled: true,
  escapeClosed: true,
  focusRestored: true,
}
```

- [ ] **Step 2: Run the build and QA audit to confirm RED**

Run: `npm run build && node qa/audit.mjs`

Expected: FAIL because `.project-memory-button` and the modal do not exist.

- [ ] **Step 3: Implement the dialog and integrate both Projects modes**

```ts
export function openProjectMemoryModal(p: ProjectViewModel, trigger: HTMLElement): void {
  const overlay = document.createElement('div');
  const modal = document.createElement('section');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', title.id);
  // render loading immediately; await window.devdeck.projectMemory; use textContent;
  // trap focus, close on Escape/outside click, restore trigger focus.
}
```

Add a full Memory button to card actions and compact icon-labelled Memory button to row actions. The footer's provider-aware control and exact-session actions must construct existing open intents; task events call `presetBoardProject(path)` then navigate to Next.

- [ ] **Step 4: Add four-locale strings and responsive styles**

Add keys for title, refresh, close, loading, retry, empty, partial sources, snapshot labels, event labels/actions, clean/dirty/ahead states, remaining tasks, copy feedback, and Memory button. Style a fixed overlay with `max-width: 760px`, `max-height: calc(100vh - 48px)`, one-column behavior below 640px, semantic timeline list, visible focus, and no horizontal overflow at 520px.

- [ ] **Step 5: Run focused tests, build, and audit until GREEN**

Run: `npx vitest run src/renderer/projectMemoryPresentation.test.ts src/shared/i18n.test.ts && npm run build && node qa/audit.mjs`

Expected: tests/build PASS; audit reports zero WCAG violations for the open Memory dialog and all literal interaction assertions true.

- [ ] **Step 6: Commit Task 5**

```powershell
git add src/renderer/projectMemoryModal.ts src/renderer/projectsView.ts src/renderer/styles.css src/renderer/locales/*.json qa/audit.mjs
git commit -m "feat: add project memory dialog"
```

### Task 6: Screenshot QA, documentation, and complete verification

**Files:**
- Modify: `qa/screenshot.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: the completed Memory surface and isolated QA project fixture.
- Produces: normal/narrow Memory screenshots, regression checks, and user documentation.

- [ ] **Step 1: Extend screenshot QA with populated and narrow Memory states**

After seeding the allowed DevDeck project, open `.project-memory-button`, wait for `.pm-timeline-item`, capture `project-memory`, resize to 520×760, capture `project-memory-narrow`, and assert:

```js
const geometry = await win.evaluate(() => ({
  present: !!document.querySelector('.pm-modal'),
  overflow: document.querySelector('.pm-modal').scrollWidth > document.querySelector('.pm-modal').clientWidth + 1,
  events: document.querySelectorAll('.pm-timeline-item').length,
}));
if (!geometry.present || geometry.overflow || geometry.events < 1) process.exit(1);
```

- [ ] **Step 2: Update README with the local project-memory workflow**

Document that Memory combines recent cross-provider sessions, commits, current Git state, tasks, and notes; it is on-demand/local-only, makes no AI/network call, and does not change the one-click Open behavior.

- [ ] **Step 3: Run the full verification gate**

Run in this order:

```powershell
npm test
npm run build
npm run qa:audit
npm run qa
git diff --check
```

Expected: all Vitest tests pass with zero failures, build exits 0, axe reports no violations, screenshot QA exits 0 and writes both Memory screenshots, and `git diff --check` emits no errors.

- [ ] **Step 4: Inspect generated screenshots**

Open `qa/shots/project-memory.png` and `qa/shots/project-memory-narrow.png`; verify no clipping, overlap, illegible contrast, misleading blank state, or focus/overlay geometry defect. If a defect is found, first add a failing automated assertion where feasible, then fix it and rerun Step 3.

- [ ] **Step 5: Commit Task 6**

```powershell
git add qa/screenshot.mjs README.md
git commit -m "docs: document and verify project memory"
```

- [ ] **Step 6: Re-read this plan and the design success criteria**

Confirm every global constraint and success criterion is backed by implementation, an automated test, or the recorded visual inspection. Run `git status --short` and `git log --oneline -8`; do not claim completion if the worktree is dirty or any verification evidence is stale.
