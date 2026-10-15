// Regression journeys for the 2026-09-08 review. Isolated profile, project and home; no real agent.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeElectron } from './electron-lifecycle.mjs';

const root = resolve(process.env.DEVDECK_REVIEW_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url))));
const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-maintenance-'));
const repo = join(sandbox, 'project'), profile = join(sandbox, 'profile'), home = join(sandbox, 'home');
const out = resolve(process.env.DEVDECK_QA_OUT ?? join(root, 'qa/shots/maintenance'));
for (const p of [repo, profile, home, out]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'maintenance-fixture'], { cwd: repo });
const file = join(profile, 'state.json');
const task = (id) => ({ id, text: `Task ${id}`, done: false, due: null, createdAt: '2026-09-08T00:00:00Z' });
writeFileSync(file, JSON.stringify({ projects: { [repo]: { todos: [task('A'), task('B')] } }, settings: {
  folders: [{ path: repo, kind: 'repo' }], language: 'en', viewMode: 'list', trayAlert: 'attention',
  thresholds: { freshDays: 3, warnDays: 7, neglectedDays: 14 },
} }));
const labels = JSON.parse(readFileSync(join(root, 'src/renderer/locales/en.json'), 'utf8'));
const results = [], errors = [];
let app, win;
const readState = () => JSON.parse(readFileSync(file, 'utf8'));
const view = name => win.click(`.rail-item[data-view="${name}"]`);
const frames = () => win.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const check = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`); };
async function launch() {
  const executablePath = process.env.DEVDECK_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu'], cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' },
  });
  win = await app.firstWindow(); win.setDefaultTimeout(10000);
  win.on('pageerror', e => errors.push(String(e))); win.on('crash', () => errors.push('renderer crashed'));
  await win.waitForSelector('#cards .prow, #cards .card', { state: 'attached', timeout: 30000 });
}
async function close() { if (app) { const current = app; app = null; await closeElectron(current); } }

try {
  await launch();
  await check('invalid threshold is explained inline, corrected input persists, host rejects invalid values', async () => {
    await view('settings');
    const fresh = win.locator('#settings-form .set-num').nth(0);
    await fresh.fill('999'); await fresh.press('Tab');
    await win.waitForFunction(() => document.querySelector('#settings-form .set-num')?.getAttribute('aria-invalid') === 'true');
    assert.equal(await fresh.inputValue(), '999');
    assert.equal(readState().settings.thresholds.freshDays, 3);
    await win.screenshot({ path: join(out, 'invalid-threshold.png') });
    await fresh.fill('4'); await fresh.press('Tab');
    await win.waitForFunction(() => document.querySelector('#settings-form .set-num')?.closest('.set-row')?.textContent.includes('Saved'));
    assert.equal(readState().settings.thresholds.freshDays, 4);
    const rejected = await win.evaluate(async () => {
      try { await window.devdeck.setThresholds({ freshDays: Infinity, warnDays: Infinity, neglectedDays: Infinity }); return false; }
      catch { return true; }
    });
    assert.equal(rejected, true);
  });

  if (process.platform === 'win32') await check('failed settings writes restore visible values, show errors, and remain retryable', async () => {
    for (const spec of [
      ['set.tray_alert', 'select', 'off', 'attention', 'trayAlert'],
      ['set.context_window', 'select', '200000', '1000000', 'contextWindow'],
      ['set.session_summary', 'check', false, true, 'sessionSummary'],
      ['set.ai_summary', 'check', true, false, 'aiSessionSummary'],
      ['set.open_at_login', 'check', true, false, 'openAtLogin'],
    ]) {
      const [label, type, next, original, property] = spec;
      const c = win.getByLabel(labels[label], { exact: true });
      mkdirSync(file + '.tmp');
      try {
        if (type === 'check') await c.click(); else await c.selectOption(next);
        const row = c.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " set-row ")]');
        await row.locator('.set-save-status').filter({ hasText: labels['common.save_failed'] }).waitFor();
        assert.equal(type === 'check' ? await c.isChecked() : await c.inputValue(), original);
        assert.equal(await c.isDisabled(), false);
        const stored = await win.evaluate(() => window.devdeck.getSettings());
        assert.equal(stored[property], type === 'select' && property === 'contextWindow' ? Number(original) : original);
      } finally { rmSync(file + '.tmp', { recursive: true, force: true }); }
    }
    // Never change the real machine's autostart setting or enable paid summaries during QA.
    const tray = win.getByLabel(labels['set.tray_alert'], { exact: true });
    await tray.selectOption('off');
    await win.waitForFunction(() => [...document.querySelectorAll('.set-row')].some(r => r.querySelector('select')?.value === 'off' && r.textContent.includes('Saved')));
    assert.equal(readState().settings.trayAlert, 'off');
    await win.screenshot({ path: join(out, 'settings-save-feedback.png') });
  });

  await check('two stale IPC snapshots cannot overwrite each other, revision survives restart', async () => {
    const a = await win.evaluate(async p => (await window.devdeck.listProjects()).find(x => x.path === p), repo);
    const b = structuredClone(a);
    a.todos[0].done = true; b.todos[1].done = true;
    const save = snapshot => win.evaluate(async s => window.devdeck.setTodos(s.path, s.todos, s.todosRevision), snapshot);
    const first = await save(a), second = await save(b);
    assert.equal(first.ok, true); assert.equal(second.ok, false);
    assert.deepEqual(second.todos.map(t => t.done), [true, false]);
    assert.deepEqual(readState().projects[repo].todos.map(t => t.done), [true, false]);
    await close(); await launch();
    const restored = await win.evaluate(async p => (await window.devdeck.listProjects()).find(x => x.path === p), repo);
    assert.equal(restored.todosRevision, first.revision);
  });

  await check('task conflict shows latest data, preserves the new-task draft and requires review', async () => {
    await view('next'); await win.waitForSelector('.tk-add-text');
    await win.fill('.tk-add-text', 'Keep my draft');
    // A second client edits B while the first task board still holds the previous revision.
    await win.evaluate(async p => {
      const current = (await window.devdeck.listProjects()).find(x => x.path === p);
      current.todos.find(t => t.id === 'B').text = 'Remote edited B';
      await window.devdeck.setTodos(p, current.todos, current.todosRevision);
    }, repo);
    await win.click('.tk-add-btn'); await win.waitForSelector('.tk-conflict');
    assert.equal(await win.inputValue('.tk-add-text'), 'Keep my draft');
    assert.ok((await win.locator('.tk-conflict-draft').inputValue()).includes('Keep my draft'));
    assert.ok((await win.locator('#view-next').innerText()).includes('Remote edited B'));
    assert.equal(readState().projects[repo].todos.length, 2);
    await win.screenshot({ path: join(out, 'task-conflict.png') });
    await win.click('.tk-conflict-reviewed'); await win.click('.tk-add-btn');
    await win.waitForFunction(() => [...document.querySelectorAll('.tk-text')].some(e => e.textContent === 'Keep my draft'));
    assert.equal(readState().projects[repo].todos.filter(t => t.text === 'Keep my draft').length, 1);
    assert.equal(await win.inputValue('.tk-add-text'), '');
  });

  await check('legacy unversioned task route is explicitly refused', async () => {
    const message = await app.evaluate(async ({ ipcMain, BrowserWindow }, p) => {
      // Invoke the registered legacy adapter; modern preload intentionally exposes only safe saves.
      const handler = ipcMain._invokeHandlers.get('project:setTodos');
      try { await handler({ sender: BrowserWindow.getAllWindows()[0].webContents }, p, []); return ''; }
      catch (e) { return String(e); }
    }, repo);
    assert.match(message, /TASKS_CLIENT_OUTDATED/);
    assert.equal(readState().projects[repo].todos.length, 3);
  });
  assert.deepEqual(errors, [], 'unexpected renderer errors');
} catch (error) {
  errors.push(String(error));
  if (win) await win.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  try { await close(); }
  catch (error) { errors.push(String(error)); throw error; }
  finally {
    writeFileSync(join(out, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), passed: results, errors }, null, 2));
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
