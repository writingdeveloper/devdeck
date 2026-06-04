# Session Resume Cue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-derive a per-project "resume cue" (the last user message of the newest Claude Code session) and surface it non-destructively in the empty note slot, so the user rarely has to type the "next todo" by hand.

**Architecture:** A pure tail-scan extractor (`lastUserMessage`) mirrors the existing `firstUserMessage`. The main process reads only the file *tail* of the newest session and passes the text through `buildProjectList` onto a new `resumeCue` field on `ProjectViewModel`. The renderer shows it as a click-to-adopt ghost when the note is empty; nothing is persisted until the user adopts it.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), Vitest. Spec: `docs/superpowers/specs/2026-06-04-devdeck-resume-cue-design.md`.

---

### Task 1: `lastUserMessage` extractor (shared)

**Files:**
- Modify: `src/shared/sessionParse.ts`
- Test: `src/shared/sessionParse.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/sessionParse.test.ts` (and add `lastUserMessage` to the import on line 2: `import { firstUserMessage, lastUserMessage } from './sessionParse';`):

```ts
describe('lastUserMessage', () => {
  it('returns the last genuine user message, skipping trailing assistant lines', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'first thing' } }),
      line({ type: 'user', message: { content: 'the last thing I asked' } }),
      line({ type: 'assistant', message: { content: 'working on it' } }),
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('the last thing I asked');
  });

  it('skips trailing tool-results, wrappers, and system-reminders', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'where I left off' } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
      line({ type: 'user', message: { content: '<system-reminder>noise</system-reminder>' } }),
      line({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }),
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('where I left off');
  });

  it('tolerates a trailing partial/invalid JSON line', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'complete line' } }),
      '{"type":"user","message":{"content":"cut off',
    ].join('\n');
    expect(lastUserMessage(jsonl)).toBe('complete line');
  });

  it('returns null when there is no genuine user message', () => {
    expect(lastUserMessage(line({ type: 'assistant', message: { content: 'hi' } }))).toBeNull();
    expect(lastUserMessage('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/sessionParse.test.ts`
Expected: FAIL — `lastUserMessage is not a function` / not exported.

- [ ] **Step 3: Implement `lastUserMessage`**

Append to `src/shared/sessionParse.ts` (reuses the existing `textOf` and `isWrapper`):

```ts
/** Last genuine user message in a session .jsonl, or null. Tail-scan mirror of firstUserMessage. */
export function lastUserMessage(jsonlText: string): string | null {
  const lines = jsonlText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let obj: { type?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (obj.type !== 'user' || !obj.message) continue;
    const text = textOf(obj.message.content).trim();
    if (!text || isWrapper(text)) continue;
    return text;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/sessionParse.test.ts`
Expected: PASS (all `firstUserMessage` + `lastUserMessage` cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/sessionParse.ts src/shared/sessionParse.test.ts
git commit -m "feat(sessions): lastUserMessage tail-scan extractor"
```

---

### Task 2: Tail read + `lastUserMessageForSession` (main)

**Files:**
- Modify: `src/main/sessions.ts`
- Test: `src/main/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Change the import on line 5 of `src/main/sessions.test.ts` to:
`import { listSessions, lastUserMessageForSession } from './sessions';`

Append:

```ts
describe('lastUserMessageForSession', () => {
  it('returns the last genuine user message from the session tail', () => {
    const d = join(root, 'C--g-cue');
    mkdirSync(d, { recursive: true });
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'old prompt' } }),
      JSON.stringify({ type: 'user', message: { content: 'pick up the rail refactor' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'done' } }),
    ].join('\n');
    writeFileSync(join(d, `${id}.jsonl`), jsonl);
    expect(lastUserMessageForSession('C:\\g\\cue', id, root)).toBe('pick up the rail refactor');
  });

  it('returns null for a missing file or invalid session id', () => {
    expect(lastUserMessageForSession('C:\\g\\cue', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789', root)).toBeNull();
    expect(lastUserMessageForSession('C:\\g\\cue', '$(evil)', root)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/sessions.test.ts`
Expected: FAIL — `lastUserMessageForSession is not a function`.

- [ ] **Step 3: Implement tail read + lookup**

In `src/main/sessions.ts`:

(a) Add `fstatSync` to the `node:fs` import on line 1:
```ts
import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
```

(b) Add `lastUserMessage` to the sessionParse import on line 4:
```ts
import { firstUserMessage, lastUserMessage } from '../shared/sessionParse';
```

(c) Add the tail constant next to `HEAD_BYTES` (line 12):
```ts
const TAIL_BYTES = 256 * 1024;
```

(d) Add `readTail` right after the `readHead` function:
```ts
function readTail(file: string, bytes: number): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, start);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    try { return readFileSync(file, 'utf8'); } catch { return ''; }
  }
}
```

(e) Add the exported lookup at the end of the file:
```ts
/** Last genuine user message of a session, read from the file tail. Null if absent/unreadable. */
export function lastUserMessageForSession(
  projectPath: string,
  sessionId: string,
  claudeProjectsDir: string,
): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const file = join(claudeProjectsDir, encodeProjectPath(projectPath), sessionId + '.jsonl');
  if (!existsSync(file)) return null;
  return lastUserMessage(readTail(file, TAIL_BYTES));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions.ts src/main/sessions.test.ts
git commit -m "feat(sessions): lastUserMessageForSession (tail read)"
```

---

### Task 3: `ResumeCue` type + `buildProjectList` wiring (shared + main)

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/projects.ts`
- Test: `src/main/projects.test.ts`

- [ ] **Step 1: Add the type**

In `src/shared/types.ts`, add above `ProjectViewModel`:
```ts
export interface ResumeCue {
  kind: 'lastMessage'; // 'todos' reserved for future structured harvesting
  text: string;
}
```
And add this field to the `ProjectViewModel` interface (after `lastOpened`):
```ts
  resumeCue: ResumeCue | null;
```

- [ ] **Step 2: Write the failing test**

In `src/main/projects.test.ts`, add `resumeCue: () => null,` to the defaults object inside the `deps()` helper (after the `sessions: () => [],` line, before `getEntry`). Then append this test:

```ts
  it('derives resumeCue from the newest session via the dep', async () => {
    const list = await buildProjectList(deps({
      sessions: (p) => p.endsWith('fresh')
        ? [{ id: 'newest', mtimeMs: NOW, firstMessage: 'hi' }]
        : [],
      resumeCue: (_p, sessionId) => (sessionId === 'newest' ? 'continue the cue work' : null),
    }));
    expect(list.find((p) => p.name === 'fresh')!.resumeCue).toEqual({ kind: 'lastMessage', text: 'continue the cue work' });
    expect(list.find((p) => p.name === 'old')!.resumeCue).toBeNull();
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/projects.test.ts`
Expected: FAIL — `resumeCue` does not exist on `BuildDeps` / view model (type error or `undefined` !== expected).

- [ ] **Step 4: Implement the wiring**

In `src/main/projects.ts`:

(a) Add `ResumeCue` to the type import on line 1:
```ts
import type { GitInfo, ProjectViewModel, StoreEntry, SessionMeta, StaleThresholds, ResumeCue } from '../shared/types';
```

(b) Add the dep to the `BuildDeps` interface (after the `sessions` line):
```ts
  resumeCue: (projectPath: string, sessionId: string) => string | null;
```

(c) In the `raw.map` callback, after `const sessions = deps.sessions(r.path);` add:
```ts
      const cueText = sessions[0] ? deps.resumeCue(r.path, sessions[0].id) : null;
```

(d) Add to the returned object (after `lastOpened: entry.lastOpened,`):
```ts
        resumeCue: cueText ? ({ kind: 'lastMessage', text: cueText } satisfies ResumeCue) : null,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/projects.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/projects.ts src/main/projects.test.ts
git commit -m "feat(projects): resumeCue field wired through buildProjectList"
```

---

### Task 4: IPC wiring (main)

**Files:**
- Modify: `src/main/ipc.ts`

- [ ] **Step 1: Wire the dep**

In `src/main/ipc.ts`:

(a) Add `lastUserMessageForSession` to the sessions import on line 7:
```ts
import { listSessions, isValidSessionId, lastUserMessageForSession } from './sessions';
```

(b) In the `projects:list` handler's `buildProjectList({ ... })` call, add after the `sessions:` line:
```ts
      resumeCue: (p, sessionId) => lastUserMessageForSession(p, sessionId, CLAUDE_PROJECTS),
```

- [ ] **Step 2: Verify the project type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat(ipc): supply resumeCue from the newest session"
```

---

### Task 5: Renderer — adopt-on-click cue ghost + i18n

**Files:**
- Modify: `src/renderer/projectsView.ts:41-74` (the `makeNote` function)
- Modify: `src/renderer/styles.css` (one rule)
- Modify: `src/renderer/locales/{ko,en,ja,zh}.json`

- [ ] **Step 1: Add the i18n key to all four locales**

Add `"proj.resume_prefix"` to each file (place it next to `"proj.next_todo"`):
- `ko.json`: `"proj.resume_prefix": "이어가기",`
- `en.json`: `"proj.resume_prefix": "Resume",`
- `ja.json`: `"proj.resume_prefix": "再開",`
- `zh.json`: `"proj.resume_prefix": "继续",`

- [ ] **Step 2: Replace `makeNote` with the cue-aware version**

Replace the whole `makeNote` function (lines 41-74) in `src/renderer/projectsView.ts` with:

```ts
function truncateCue(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function makeNote(p: ProjectViewModel): HTMLElement {
  const wrap = document.createElement('div');
  const showRead = () => {
    wrap.replaceChildren();
    const el = document.createElement('div');
    if (p.note) {
      el.className = 'note-preview'; el.textContent = p.note;
      el.addEventListener('click', () => showEdit());
    } else if (p.resumeCue) {
      const cueText = p.resumeCue.text;
      el.className = 'note-ghost has-cue';
      el.textContent = `↩ ${tr('proj.resume_prefix')}: ${truncateCue(cueText)}`;
      el.title = cueText;
      el.addEventListener('click', () => showEdit(cueText));
    } else {
      el.className = 'note-ghost'; el.textContent = tr('proj.next_todo');
      el.addEventListener('click', () => showEdit());
    }
    wrap.appendChild(el);
  };
  const showEdit = (prefill?: string) => {
    const original = p.note;
    wrap.replaceChildren();
    const ta = document.createElement('textarea');
    ta.className = 'note-edit'; ta.rows = 2; ta.value = prefill ?? p.note; ta.placeholder = tr('proj.next_todo_ph');
    let cancelling = false;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        cancelling = true;
        p.note = original;
        ta.blur();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        ta.blur();
      }
    });
    ta.addEventListener('blur', () => {
      if (!cancelling && ta.value !== p.note) { p.note = ta.value; window.devdeck.setNote(p.path, ta.value); }
      showRead();
    });
    wrap.appendChild(ta); ta.focus();
  };
  showRead();
  return wrap;
}
```

> Note: the click handlers must be `() => showEdit()` / `() => showEdit(cueText)` arrows — NOT a bare `showEdit` reference — because `showEdit` now takes a string prefill and a bare reference would pass the click `MouseEvent` as the prefill.

- [ ] **Step 3: Add the overflow-guard CSS rule**

In `src/renderer/styles.css`, find the existing `.note-ghost` rule and add, immediately after it:

```css
.note-ghost.has-cue { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 4: Build + full test suite + QA**

Run: `npm run build`
Expected: tsc clean, renderer bundles, assets copied.

Run: `npx vitest run`
Expected: all tests PASS (includes the i18n locale-parity test, which passes because the key was added to all four files).

Run: `npm run qa`
Expected: screenshot + audit exit 0, **0 serious a11y violations** (the cue ghost mirrors the existing note-ghost click-div pattern, so no new violation).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/projectsView.ts src/renderer/styles.css src/renderer/locales/ko.json src/renderer/locales/en.json src/renderer/locales/ja.json src/renderer/locales/zh.json
git commit -m "feat(projects): show adopt-on-click resume cue in empty note slot"
```

---

## Self-Review

**Spec coverage:**
- Extraction `lastUserMessage` → Task 1. ✓
- Tail read + `lastUserMessageForSession` (256 KB) → Task 2. ✓
- `ResumeCue` type + `resumeCue` on view model + `buildProjectList` dep (newest session only) → Task 3. ✓
- IPC wiring → Task 4. ✓
- Renderer non-destructive ghost (note present → unchanged; empty+cue → adopt-on-click; empty+no-cue → generic) + i18n `proj.resume_prefix` → Task 5. ✓
- Edge cases (no sessions → null dep call guarded by `sessions[0] ?`; wrappers/tool-results skipped in Task 1 tests; long/multiline truncated by `truncateCue`; partial trailing line tolerated in Task 1/2) → covered. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ResumeCue { kind: 'lastMessage'; text: string }` defined in Task 3 and used identically in `buildProjectList` (Task 3) and the renderer (`p.resumeCue.text`, Task 5). Dep signature `resumeCue(projectPath, sessionId): string | null` matches in `BuildDeps` (Task 3), the test default/override (Task 3), and the IPC call (Task 4). `lastUserMessageForSession(projectPath, sessionId, claudeProjectsDir)` signature matches between Task 2 definition and Task 4 call.
