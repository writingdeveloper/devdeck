// Real Electron UI + IPC + disk persistence, with controlled response ordering and failures.
// No provider CLI, user projects, credentials, or live conversations are required.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeElectron } from './electron-lifecycle.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-resilience-'));
const repo = join(sandbox, 'project');
const userData = join(sandbox, 'profile');
const bin = join(sandbox, 'bin');
const out = join(root, 'qa', 'shots', 'resilience');
for (const p of [repo, userData, out, bin]) mkdirSync(p, { recursive: true });
// Exercise ConPTY without depending on a logged-in provider or starting another agent.
for (const name of ['claude', 'codex', 'antigravity']) writeFileSync(join(bin, name + '.cmd'), '@echo off\r\necho DEVDECK_QA_PTY_READY\r\n');
execFileSync('git', ['init', '-q', '-b', 'qa-fixture'], { cwd: repo });
const stateFile = join(userData, 'state.json');
writeFileSync(stateFile, JSON.stringify({ projects: {}, settings: { language: 'en', viewMode: 'cards', folders: [{ path: repo, kind: 'repo' }] } }));
const results = [];
const errors = [];
let app, win;
async function launch() {
  const executablePath = process.env.DEVDECK_EXECUTABLE;
  const env = { ...process.env, CLAUDE_CODE_SSE_PORT: '', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  if (process.platform === 'win32') env[pathKey] = `${bin};${env[pathKey] ?? ''}`;
  app = await electron.launch({
    ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    cwd: root,
    env,
  });
  win = await app.firstWindow();
  win.setDefaultTimeout(10_000);
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('crash', () => errors.push('renderer crashed'));
  await win.waitForSelector('#cards .card, #cards .prow', { state: 'attached', timeout: 30_000 });
}
async function close() {
  if (!app) return;
  const closing = app;
  app = null;
  await closeElectron(closing);
}
async function view(name) { await win.click(`.rail-item[data-view="${name}"]`); }
async function check(name, fn) {
  await fn(); results.push(name); console.log(`PASS ${name}`);
}
async function flush() { await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function pending(key, n = 1) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await app.evaluate((_, { key, n }) => (globalThis.qaPending[key]?.length ?? 0) >= n, { key, n })) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`No pending response: ${key} (${n})`);
}
async function answer(key, { index = 0, name = 'Current', cost = 222, fail = false } = {}) {
  await pending(key, index + 1);
  await app.evaluate((_, arg) => {
    const job = globalThis.qaPending[arg.key].splice(arg.index, 1)[0];
    if (arg.fail) job.reject(new Error('injected old failure'));
    else if (arg.key.includes('usage')) job.resolve({ ...globalThis.qaUsage, globalCost: arg.cost });
    else job.resolve([{ ...globalThis.qaProject, name: arg.name,
      todos: [{ id: arg.name, text: arg.name, done: false, due: null, createdAt: new Date().toISOString() }] }]);
  }, { key, index, name, cost, fail });
  await flush();
}

try {
  await launch();
  await check('task save failure preserves draft; retry persists exactly once across restart', async () => {
    await view('next');
    await win.fill('.tk-add-text', 'Persistent task');
    mkdirSync(stateFile + '.tmp');
    try {
      await win.click('.tk-add-btn');
      await win.waitForSelector('#toast-host .toast');
      assert.equal(await win.inputValue('.tk-add-text'), 'Persistent task');
      assert.equal(await win.locator('.tk-text').count(), 0);
      assert.equal(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).projects).length, 0);
    } finally { rmSync(stateFile + '.tmp', { recursive: true }); }
    await win.click('.tk-add-btn');
    await win.waitForSelector('.tk-text');
    assert.equal(await win.locator('.tk-text').innerText(), 'Persistent task');
    await close(); await launch(); await view('next');
    await win.waitForSelector('.tk-text');
    assert.deepEqual(await win.locator('.tk-text').allTextContents(), ['Persistent task']);
  });

  await check('failed checkbox save rolls back and remains retryable', async () => {
    mkdirSync(stateFile + '.tmp');
    try {
      await win.click('.tk-check');
      await win.waitForSelector('#toast-host .toast');
      assert.equal(await win.isChecked('.tk-check'), false);
    } finally { rmSync(stateFile + '.tmp', { recursive: true }); }
    await win.click('.tk-check');
    await win.waitForFunction(() => document.querySelectorAll('.tk-text').length === 0);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).projects[repo].todos[0].done, true);
  });

  await check('failed note save keeps editable text and retry reaches disk', async () => {
    await view('projects');
    await win.click('.note-ghost');
    await win.fill('.note-edit', 'Persistent note');
    mkdirSync(stateFile + '.tmp');
    try {
      await win.locator('.note-edit').press('Control+Enter');
      await win.waitForFunction(() => {
        const e = document.querySelector('.note-edit'); return e && !e.disabled && e === document.activeElement;
      });
      assert.equal(await win.inputValue('.note-edit'), 'Persistent note');
    } finally { rmSync(stateFile + '.tmp', { recursive: true }); }
    await win.locator('.note-edit').press('Control+Enter');
    await win.waitForFunction(() => !document.querySelector('.note-edit'));
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).projects[repo].note, 'Persistent note');
  });

  if (process.platform === 'win32') await check('Windows native terminal launches and renders provider output', async () => {
    assert.equal((await win.evaluate(() => window.devdeck.getSettings())).ptyAvailable, true, 'required Windows native binding');
    await win.click('#cards .provider-open-primary');
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term')].some((e) => e.textContent.includes('DEVDECK_QA_PTY_READY')));
    assert.equal(await win.locator('.ck-term.show').count(), 1);
    await view('projects');
  });

  // Keep the renderer and preload real. Delay only the main process's answers, under explicit
  // harness control. No timing guess determines which response wins.
  const project = (await win.evaluate(() => window.devdeck.listProjects()))[0];
  await app.evaluate(({ ipcMain, BrowserWindow }, project) => {
    globalThis.qaProject = project;
    globalThis.qaPending = {};
    globalThis.qaUsage = { global: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, globalCost: 0,
      sessions: 0, activeMs: 0, hasUnknownModel: false, webSearch: 0, webFetch: 0,
      byModel: [], byProvider: [], byProject: [], daily: [] };
    const queue = (key) => new Promise((resolve, reject) => (globalThis.qaPending[key] ??= []).push({ resolve, reject }));
    for (const name of ['projects:list', 'usage:report', 'link:machines', 'link:call']) ipcMain.removeHandler(name);
    ipcMain.handle('projects:list', () => queue('local-projects'));
    ipcMain.handle('usage:report', (_, since) => since === 0 ? globalThis.qaUsage : queue('local-usage'));
    globalThis.qaMachines = [{ machineId: 'qa-remote', machineName: 'QA Remote', state: 'offline' }];
    ipcMain.handle('link:machines', () => globalThis.qaMachines);
    ipcMain.handle('link:call', (_, machine, method) => {
      if (method === 'projects:list') return queue('remote-projects');
      if (method === 'usage:report') return globalThis.qaUsage;
      if (method === 'project:memory') return queue('remote-memory');
      throw new Error(`Unexpected remote action: ${machine}/${method}`);
    });
    BrowserWindow.getAllWindows()[0].webContents.send('link:changed');
  }, project);
  await win.waitForSelector('#machine-switch:not(.hidden)');

  await check('machine switch immediately removes old actionable rows; A → B → A ignores old success', async () => {
    await win.click('#refresh'); await pending('local-projects');
    await win.selectOption('#machine-switch', 'qa-remote'); await pending('remote-projects');
    assert.equal(await win.locator('#cards .card').count(), 0);
    assert.equal(await win.locator('#shell-projects .shell-project').count(), 0);
    await win.selectOption('#machine-switch', 'local'); await pending('local-projects', 2);
    await answer('local-projects', { index: 1, name: 'Newest local' });
    await win.waitForFunction(() => document.querySelector('#cards')?.textContent.includes('Newest local'));
    await answer('local-projects', { name: 'Obsolete local' });
    await answer('remote-projects', { fail: true });
    assert.ok((await win.locator('#cards').innerText()).includes('Newest local'));
    assert.ok(!(await win.locator('#cards').innerText()).includes('Obsolete local'));
    assert.equal(await win.locator('#cards .load-error').count(), 0);
  });

  await check('task board ignores both obsolete success and obsolete failure after repeated navigation', async () => {
    await view('next'); await pending('local-projects');
    await view('projects'); await view('next'); await pending('local-projects', 2);
    await answer('local-projects', { index: 1, name: 'Newest task' });
    await win.waitForSelector('.tk-text');
    await answer('local-projects', { name: 'Obsolete task' });
    assert.deepEqual(await win.locator('.tk-text').allTextContents(), ['Newest task']);
    await view('projects'); await view('next'); await pending('local-projects');
    await view('projects'); await view('next'); await pending('local-projects', 2);
    await answer('local-projects', { index: 1, name: 'Still current' });
    await answer('local-projects', { fail: true });
    assert.deepEqual(await win.locator('.tk-text').allTextContents(), ['Still current']);
  });

  await check('usage view cannot show an older request under the current selection', async () => {
    await view('usage'); await pending('local-usage');
    await view('projects'); await view('usage'); await pending('local-usage', 2);
    await answer('local-usage', { index: 1, cost: 222 });
    await win.waitForSelector('.usage-cost-card.lead b');
    await answer('local-usage', { cost: 111 });
    assert.equal(await win.locator('.usage-cost-card.lead b').innerText(), '~$222.00');
  });

  await check('forgetting the selected machine reloads local projects and clears remote rows', async () => {
    await view('projects');
    await win.selectOption('#machine-switch', 'qa-remote');
    await answer('remote-projects', { name: 'Remote only' });
    await win.waitForFunction(() => document.querySelector('#cards')?.textContent.includes('Remote only'));
    await win.click('#cards .project-memory-button');
    await pending('remote-memory');
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.qaMachines = [];
      BrowserWindow.getAllWindows()[0].webContents.send('link:changed');
    });
    await pending('local-projects');
    assert.equal(await win.locator('#cards .card').count(), 0);
    assert.equal(await win.locator('.pm-overlay').count(), 0);
    await answer('remote-memory', { fail: true });
    assert.equal(await win.locator('.pm-overlay').count(), 0);
    await answer('local-projects', { name: 'Local after forgetting' });
    await win.waitForFunction(() => document.querySelector('#cards')?.textContent.includes('Local after forgetting'));
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
    writeFileSync(join(out, 'results.json'), JSON.stringify({ passed: results, errors }, null, 2));
    // This is the one owned temporary tree created above; never remove a user-supplied path.
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
