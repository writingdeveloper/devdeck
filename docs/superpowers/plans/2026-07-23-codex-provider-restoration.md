# Codex Provider Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Codex as a selectable DevDeck provider with project session history, exact session resume, and reliable Cockpit session restoration.

**Architecture:** Add a focused JSONL parser and session index for `~/.codex/sessions`, then register it through the existing `AgentProvider` boundary. Extend the generic session-ID adoption path to read Codex rollout file stats; retain Claude-only model/context metadata and Antigravity's current behavior.

**Tech Stack:** TypeScript 5.5, Node.js filesystem APIs, Electron IPC, Vitest 3.

## Global Constraints

- Do not add runtime dependencies or native modules.
- Preserve Claude-only usage analytics.
- Validate session IDs before using them in commands or filesystem lookups.
- A Codex Cockpit tile adopts an ID only through the existing unambiguous `pickDriftedSessionId` evidence rules.
- Preserve existing Claude and Antigravity behavior.

---

## File Structure

- Create `src/shared/codexParse.ts` and `.test.ts`: pure metadata/user-message parsing.
- Create `src/main/codexSessions.ts` and `.test.ts`: rollout lookup, all IDs, file stats, and resume cues.
- Modify `src/shared/types.ts`, `src/main/agents.ts`, and `src/main/agents.test.ts`: third provider registration.
- Modify `src/shared/cockpitPersist.ts`, `src/main/ipc.ts`, and `src/renderer/cockpitView.ts`: persisted Codex IDs and safe live adoption.
- Modify `src/main/launcher.ts` and test: Codex-specific missing CLI guidance.
- Modify all locale JSON files, `README.md`, and `package.json`: product copy.

### Task 1: Parse Codex rollout records

**Files:** Create `src/shared/codexParse.ts`; test `src/shared/codexParse.test.ts`.

**Interfaces:** Produces `codexSessionMeta(raw): { id: string; cwd: string } | null`, `codexFirstUserMessage(raw): string | null`, and `codexLastUserMessage(raw): string | null`. Task 2 consumes these functions.

- [ ] **Step 1: Write failing parser tests**

Cover valid `session_meta`, legacy `event_msg/user_message`, current `response_item/message/role:user/content:[{type:'input_text',text}]`, blank text, and malformed JSON. Assert metadata uses only `session_meta.payload.id` and `.cwd`; first/last messages are trimmed.

```ts
expect(codexSessionMeta(header)).toEqual({ id: ID, cwd: 'C:\\repo' });
expect(codexFirstUserMessage(lines)).toBe('first');
expect(codexLastUserMessage(lines)).toBe('latest');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/codexParse.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the parser**

Parse JSONL one line at a time with a private invalid-JSON-safe parser. Recognize both user-message shapes. For current records, return the first non-empty `input_text` item rather than concatenate content. Keep the helpers filesystem-free.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/shared/codexParse.test.ts`

Expected: PASS.

Run: `git add src/shared/codexParse.ts src/shared/codexParse.test.ts; git commit -m "feat(codex): parse rollout metadata and user messages"`

### Task 2: Index Codex sessions safely

**Files:** Create `src/main/codexSessions.ts`; test `src/main/codexSessions.test.ts`.

**Interfaces:** Consumes Task 1. Produces `codexAvailable`, `listCodexSessions(projectPath, dir, limit?)`, `listCodexSessionIds(projectPath, dir)`, `listCodexSessionStats(projectPath, dir)`, and `lastUserMessageForCodexSession(projectPath, id, dir)`.

- [ ] **Step 1: Write failing index tests**

Use `mkdtempSync` and nested `YYYY/MM/DD/rollout-*.jsonl` fixtures. Test exact-project filtering, newest-first order, default limit, all-ID listing, mtime/birthtime stats, missing directories, malformed headers, invalid IDs, and an 800 KiB trailing agent event after the latest user message.

```ts
expect(listCodexSessionIds('C:\\repo', root)).toEqual([newId, oldId]);
expect(listCodexSessionStats('C:\\repo', root)[0]).toMatchObject({ id: newId });
expect(lastUserMessageForCodexSession('C:\\repo', newId, root)).toBe('resume this');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/codexSessions.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement bounded rollout scanning**

Recursively enumerate only `rollout-*.jsonl`. Read a 64 KiB file head for metadata/previews; scan tail chunks backward up to 8 MiB for the last user message, dropping a partial leading line first. Import `SESSION_ID_RE` from `src/shared/paths.ts`; never construct paths from invalid IDs. Return `{ id, mtimeMs, birthtimeMs }` only for the exact matching CWD.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/main/codexSessions.test.ts`

Expected: PASS.

Run: `git add src/main/codexSessions.ts src/main/codexSessions.test.ts; git commit -m "feat(codex): index rollout sessions by project"`

### Task 3: Register Codex in AgentProvider

**Files:** Modify `src/shared/types.ts`, `src/main/agents.ts`; test `src/main/agents.test.ts`.

**Interfaces:** Consumes Task 2. Produces `getProvider('codex')`, Codex in `availableAgents`, and Codex-backed `listSessionIds`.

- [ ] **Step 1: Add failing provider tests**

```ts
const c = getProvider('codex');
expect(c.buildCommand('new')).toBe('codex');
expect(c.buildCommand('continue')).toBe('codex resume --last');
expect(c.buildCommand('resume', ID)).toBe(`codex resume ${ID}`);
expect(c.buildCommand('resume', '$(evil)')).toBe('codex resume --last');
expect(availableAgents(() => true).sort()).toEqual(['antigravity', 'claude', 'codex']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agents.test.ts`

Expected: FAIL because `codex` is absent from `AgentId` and the provider registry.

- [ ] **Step 3: Implement provider registration**

Add `codex` to `AgentId`, define `CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')`, and register a provider with `supportsSessionId: false`. Its commands are `codex`, `codex resume --last`, and `codex resume <validated-id>`. Wire all Codex session APIs, include it in `availableAgents`, and preserve the corrupted-setting fallback to Claude.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/main/agents.test.ts src/main/codexSessions.test.ts`

Expected: PASS.

Run: `git add src/shared/types.ts src/main/agents.ts src/main/agents.test.ts; git commit -m "feat(agents): register Codex provider"`

### Task 4: Preserve and restore Codex Cockpit sessions

**Files:** Modify/test `src/shared/cockpitPersist.ts`; modify/test `src/main/ipc.ts`; modify `src/renderer/cockpitView.ts`.

**Interfaces:** Consumes `listCodexSessionStats`. Produces persisted `agentId: 'codex'` entries and evidence-gated ID adoption for Codex tiles.

- [ ] **Step 1: Write failing persistence and IPC tests**

Add a Codex fixture to persistence sanitization/restore tests. In Cockpit IPC tests, assert Codex selects Codex file stats for `pickDriftedSessionId`, Claude continues to use `listSessionStats`, and Antigravity returns `null`.

```ts
expect(sanitizePersistedList([{ projectPath: 'C:/repo', name: 'repo', agentId: 'codex', sessionId: ID }]))
  .toMatchObject([{ agentId: 'codex', sessionId: ID }]);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/shared/cockpitPersist.test.ts src/main/ipc.cockpit.test.ts`

Expected: FAIL because Codex is discarded and has no live stats route.

- [ ] **Step 3: Implement safe adoption**

Permit `codex` in `sanitizePersistedList`. In `cockpit:liveSessionId`, choose Claude stats for Claude and `listCodexSessionStats` for Codex; return `null` for Antigravity. In `cockpitView.ts`, allow `refreshSessionId` for Claude or Codex, retaining all existing claimed-ID, output-time, opened-time, and one-candidate safeguards. Keep model/context metadata Claude-only through the existing neutral IPC response.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/shared/cockpitPersist.test.ts src/main/ipc.cockpit.test.ts`

Expected: PASS.

Run: `git add src/shared/cockpitPersist.ts src/shared/cockpitPersist.test.ts src/main/ipc.ts src/main/ipc.cockpit.test.ts src/renderer/cockpitView.ts; git commit -m "feat(cockpit): restore Codex conversations"`

### Task 5: Complete diagnostics, localization, and docs

**Files:** Modify/test `src/main/launcher.ts`; modify all locale JSON files; modify `README.md` and `package.json`.

**Interfaces:** Produces `agent.codex` text used by the existing selector and a Codex-specific missing-CLI warning.

- [ ] **Step 1: Add a failing CLI-guard test**

Test that missing `codex` returns a Codex-named actionable installation/PATH hint, while exact Claude guidance and generic `agy` behavior remain unchanged.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/main/launcher.test.ts`

Expected: FAIL because Codex currently receives the generic warning.

- [ ] **Step 3: Implement user-facing copy**

Add a `bin === 'codex'` branch to `makeCliGuard`. Add `agent.codex: "Codex"` to `en`, `ko`, `ja`, and `zh` locales. Update README headline, multi-agent, open/resume, and resume-cue copy to enumerate all three agents; retain the explicit Claude-only usage analytics scope. Update package description and keywords to avoid Claude-only metadata.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run src/main/launcher.test.ts`

Expected: PASS.

Run: `git add src/main/launcher.ts src/main/launcher.test.ts src/renderer/locales/en.json src/renderer/locales/ko.json src/renderer/locales/ja.json src/renderer/locales/zh.json README.md package.json; git commit -m "docs: advertise Codex support"`

## Final Verification

- [ ] Run `git diff --check` and `git status --short`; expect no whitespace errors and no uncommitted task files.
- [ ] Run `npx vitest run`; expect all tests pass.
- [ ] Run `npm run build`; expect TypeScript and renderer builds succeed.
- [ ] Start the Windows app. Verify Codex appears in the selector, a matching rollout shows a preview, and a specific rollout opens with `codex resume <id>`.
- [ ] In Cockpit, start a fresh Codex session, send one prompt, wait for its rollout file, restart DevDeck, and verify the saved tile resumes the same conversation.

## Self-Review

**Spec coverage:** provider registration (Task 3), session discovery/previews (Tasks 1–2), exact commands (Task 3), safe Cockpit restoration (Task 4), and product copy/PATH guidance (Task 5) are fully covered.

**Placeholder scan:** no deferred steps or unspecified test procedures remain.

**Type consistency:** Task 3 expands `AgentId` before Tasks 4–5 consume `codex`; Task 2 function names are the exact names required by Tasks 3–4; `SessionFileStat` preserves the existing `pickDriftedSessionId` contract.
