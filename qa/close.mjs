// What "close" actually does, on both ends of a DevDeck Link, driven the way a person drives it.
//
// Every defect this guards against was silent: the deck that pressed close looked right, and the
// damage was somewhere else — an "exited" tile left on the OTHER machine (saved, and re-run after an
// update restart), a close pressed while the link was down that never arrived (the agent kept running
// and the tile was adopted straight back on reconnect), a close refused for lack of permission that
// looked like it worked, and a bulk close where all but one of the closed sessions came back as dead
// tiles. None of it shows up in unit tests, because each is an ordering between two processes.
//
// Run with `npm run qa:close`. Two Electron instances: do NOT run it alongside `npm run qa`/`qa:link`.
// Sessions run the real `claude` CLI in a throwaway repository with no conversation to continue (see
// the fixture note in link.mjs for why it must never be this checkout).
import { _electron as electron } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeElectron } from './electron-lifecycle.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

const fixtureRepo = mkdtempSync(join(tmpdir(), 'devdeck-close-fixture-'));
writeFileSync(join(fixtureRepo, 'README.md'), '# fixture');
execFileSync('git', ['init', '-q'], { cwd: fixtureRepo });
execFileSync('git', ['-c', 'user.email=qa@devdeck', '-c', 'user.name=qa', 'add', '-A'], { cwd: fixtureRepo });
execFileSync('git', ['-c', 'user.email=qa@devdeck', '-c', 'user.name=qa', 'commit', '-q', '-m', 'fixture'], { cwd: fixtureRepo });

async function launch(tag, registerFolder) {
  const userData = mkdtempSync(join(tmpdir(), `devdeck-close-${tag}-`));
  const temp = mkdtempSync(join(tmpdir(), `devdeck-closetmp-${tag}-`));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo,
    // A nested agent must not inherit this session's identity (same scrub as link.mjs / perf.mjs).
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CODE_SSE_PORT: '', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.error(`[${stamp()}] ${tag}: page error ${String(e).slice(0, 200)}`));
  await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});
  if (registerFolder) {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, fixtureRepo);
    await win.evaluate(async () => window.devdeck.pickFolder());
    await win.evaluate(async (p) => window.devdeck.addFolder(p, 'repo'), fixtureRepo);
  }
  await win.setViewportSize({ width: 1400, height: 900 });
  return { app, win };
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** The agent processes under a pid: what is actually still running, whatever the UI says. */
function agentProcessCount(rootPid) {
  if (process.platform !== 'win32') return null;
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const kids = new Map();
  for (const p of JSON.parse(out)) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  let n = 0; const stack = [rootPid];
  while (stack.length) for (const c of kids.get(stack.pop()) ?? []) { if (/^(powershell|pwsh|claude|node)\.exe$/i.test(c.Name)) n++; stack.push(c.ProcessId); }
  return n;
}

const rows = (win) => win.evaluate(() => [...document.querySelectorAll('#shell-session-groups .shell-session')].map((n) => ({
  label: n.querySelector('strong')?.textContent ?? '',
  activity: [...n.classList].find((c) => c.startsWith('activity-'))?.slice(9) ?? '?',
  previous: n.closest('.shell-session-wrap')?.dataset.previous === 'true',
})));
const liveRows = async (win, label) => (await rows(win)).filter((r) => r.label.includes(label) && !r.previous);
const persisted = (win, label) => win.evaluate(async (l) => (await window.devdeck.cockpit.loadSessions()).filter((s) => (s.label ?? '').includes(l)).length, label);
const running = (win, label) => win.evaluate(async (l) => (await window.devdeck.cockpit.liveSessions()).some((s) => (s.label ?? '').includes(l)), label);
const headerTitle = (win) => win.evaluate(() => document.querySelector('#ck-header .title')?.textContent ?? '');

async function waitFor(fn, ms = 20000, step = 400) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

/** Open a session on `owner` (window of the machine that runs it) and name it there. */
async function openNamed(owner, label) {
  return owner.win.evaluate(async (label) => {
    const projects = await window.devdeck.listProjects();
    const res = await window.devdeck.cockpit.open({ projectPath: projects[0].path, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude' });
    await new Promise((r) => setTimeout(r, 800));
    const me = (await window.devdeck.cockpit.liveSessions()).find((s) => s.id === res.id);
    if (me) await window.devdeck.cockpit.renameSession(me.id, label, me);
    return res.id;
  }, label);
}

/** Open a session on the host FROM the viewer, then name it on the host. */
async function openFromViewer(label) {
  await viewer.win.evaluate(async () => {
    const m = (await window.devdeck.link.machines()).find((x) => x.state === 'connected');
    const projects = await window.devdeck.machine(m.machineId).listProjects();
    await window.devdeck.machine(m.machineId).cockpit.open({ projectPath: projects[0].path, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude' });
  });
  await sleep(800);
  await host.win.evaluate(async (label) => {
    const me = (await window.devdeck.cockpit.liveSessions()).find((s) => !s.label);
    if (me) await window.devdeck.cockpit.renameSession(me.id, label, me);
  }, label);
  await waitFor(async () => (await liveRows(viewer.win, label)).length && (await liveRows(host.win, label)).length);
}

async function selectRow(win, label) {
  await win.locator('#shell-session-groups .shell-session-wrap:not(.is-previous) .shell-session', { hasText: label }).first().click();
  return waitFor(async () => (await headerTitle(win)).includes(label), 5000, 150);
}

/** Header button by position: new session, pin, rename, folder, restart, close. */
const HEADER = { newSession: 0, restart: 4, close: 5 };
async function pressHeader(win, which) {
  await win.evaluate((i) => document.querySelectorAll('#ck-header .ck-act')[i].click(), HEADER[which]);
}
async function closeViaUi(win, label) {
  if (!(await selectRow(win, label))) return false;
  await pressHeader(win, 'close');
  await win.waitForSelector('.ck-confirm-ok', { timeout: 5000 });
  await win.click('.ck-confirm-ok');
  return true;
}

const host = await launch('host', true);
const viewer = await launch('viewer', false);
const checks = {};
const notes = {};
const check = (name, ok, detail) => { checks[name] = !!ok; if (detail !== undefined) notes[name] = detail; console.log(`[${stamp()}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`); };

try {
  const hostPid = host.app.process().pid;
  await openNamed(host, 'qa-H1');
  await openNamed(host, 'qa-H2');

  // --- pair through the UI, on a port nobody else holds ---
  await host.win.evaluate(async (p) => window.devdeck.link.setPort(p), await freePort());
  await host.win.click('.rail-item[data-view="settings"]');
  await host.win.waitForSelector('#settings-form .link-block .chip.chip-primary', { timeout: 15000 });
  await host.win.click('#settings-form .link-block .chip.chip-primary');
  await host.win.waitForSelector('#settings-form .link-code', { timeout: 15000 });
  const code = (await host.win.textContent('#settings-form .link-code')).trim();
  await viewer.win.click('.rail-item[data-view="settings"]');
  await viewer.win.fill('#settings-form .link-code-input', code);
  await viewer.win.click('#settings-form .link-add-row .chip');
  await viewer.win.waitForFunction(() => document.querySelector('#settings-form .link-state.is-connected') !== null, undefined, { timeout: 20000 });
  const machineId = await viewer.win.evaluate(async () => (await window.devdeck.link.machines()).find((m) => m.state === 'connected').machineId);
  check('viewerAdoptsHostSessions', await waitFor(async () => (await liveRows(viewer.win, 'qa-H1')).length && (await liveRows(viewer.win, 'qa-H2')).length));

  // --- 1. a remote close ends the session THERE, and the host's own deck follows ---
  await openFromViewer('qa-V1');
  await sleep(2500);
  const procsBefore = agentProcessCount(hostPid);
  await closeViaUi(viewer.win, 'qa-V1');
  await sleep(5000);
  const procsAfter = agentProcessCount(hostPid);
  check('remoteClose.killsHostSession', !(await running(host.win, 'qa-V1')));
  check('remoteClose.hostProcessesEnd', procsBefore === null || procsBefore - procsAfter >= 2, { procsBefore, procsAfter });
  check('remoteClose.noGhostOnHost', (await liveRows(host.win, 'qa-V1')).length === 0 && (await persisted(host.win, 'qa-V1')) === 0);
  check('remoteClose.goneOnViewer', (await liveRows(viewer.win, 'qa-V1')).length === 0 && (await persisted(viewer.win, 'qa-V1')) === 0);

  // --- 2. closing at the host removes the session from the viewer watching it ---
  await closeViaUi(host.win, 'qa-H1');
  await sleep(5000);
  check('hostClose.noGhostOnViewer', (await liveRows(viewer.win, 'qa-H1')).length === 0 && (await persisted(viewer.win, 'qa-H1')) === 0);

  // --- 3. a close pressed while the link is down is delivered when it comes back ---
  await openFromViewer('qa-V2');
  await sleep(1500);
  await host.win.evaluate(async () => window.devdeck.link.setHostMode(false));
  await waitFor(() => viewer.win.evaluate(async () => (await window.devdeck.link.machines()).every((m) => m.state !== 'connected')), 20000);
  await closeViaUi(viewer.win, 'qa-V2');
  await sleep(1000);
  await host.win.evaluate(async () => window.devdeck.link.setHostMode(true));
  await sleep(1500);
  await viewer.win.evaluate(async (id) => window.devdeck.link.reconnect(id).catch(() => {}), machineId);
  await waitFor(() => viewer.win.evaluate(async () => (await window.devdeck.link.machines()).some((m) => m.state === 'connected')), 30000);
  await sleep(8000);
  check('offlineClose.deliveredOnReconnect', !(await running(host.win, 'qa-V2')));
  check('offlineClose.notReadopted', (await liveRows(viewer.win, 'qa-V2')).length === 0);

  // --- 4. a close this device is not permitted to make is not pretended ---
  const fp = await host.win.evaluate(async () => (await window.devdeck.link.hostStatus()).devices?.[0]?.fingerprint ?? null);
  await host.win.evaluate(async (fp) => window.devdeck.link.setDevicePermissions(fp, ['observe']), fp);
  await sleep(1500);
  await closeViaUi(viewer.win, 'qa-H2');
  await sleep(4000);
  check('deniedClose.sessionKeepsRunning', await running(host.win, 'qa-H2'));
  check('deniedClose.tileComesBackHonestly', (await liveRows(viewer.win, 'qa-H2')).length === 1);
  await host.win.evaluate(async (fp) => window.devdeck.link.setDevicePermissions(fp, ['observe', 'control', 'spawn', 'write']), fp);
  await sleep(1500);

  // --- 5. a bulk close leaves nothing behind (it used to bring all but one back as dead tiles) ---
  for (const l of ['qa-B1', 'qa-B2', 'qa-B3', 'qa-B4']) await openNamed(host, l);
  await waitFor(async () => (await liveRows(host.win, 'qa-B4')).length);
  await sleep(3000);
  for (const l of ['qa-B1', 'qa-B2', 'qa-B3']) {
    await host.win.locator('#shell-session-groups .shell-session', { hasText: l }).first().click({ modifiers: ['Control'] });
    await sleep(150);
  }
  await host.win.click('.shell-selection-close');
  await host.win.waitForSelector('.ck-confirm-ok', { timeout: 5000 });
  await host.win.click('.ck-confirm-ok');
  await sleep(6000);
  const leftHost = (await rows(host.win)).filter((r) => /qa-B[123]/.test(r.label));
  const leftViewer = (await rows(viewer.win)).filter((r) => /qa-B[123]/.test(r.label));
  check('bulkClose.noZombiesOnHost', leftHost.length === 0, leftHost);
  check('bulkClose.noZombiesOnViewer', leftViewer.length === 0, leftViewer);
  check('bulkClose.keepsTheUnselected', (await liveRows(host.win, 'qa-B4')).length === 1);

  // --- 6. a session started elsewhere does not take the screen or the keyboard ---
  await viewer.win.click('.rail-item[data-view="cockpit"]').catch(() => {});
  await selectRow(viewer.win, 'qa-B4');
  const before6 = await headerTitle(viewer.win);
  await openNamed(host, 'qa-H6');
  await waitFor(async () => (await liveRows(viewer.win, 'qa-H6')).length);
  await sleep(1500);
  check('adoption.doesNotStealSelection', (await headerTitle(viewer.win)) === before6, { before: before6, after: await headerTitle(viewer.win) });

  // --- 7. "+ new session" on a remote tile opens on THAT machine ---
  const hostCount7 = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).length);
  await selectRow(viewer.win, 'qa-H6');
  await pressHeader(viewer.win, 'newSession');
  await sleep(4000);
  const hostCount7b = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).length);
  const viewerLocal7 = await viewer.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).length);
  check('remoteNewSession.opensOnHost', hostCount7b === hostCount7 + 1 && viewerLocal7 === 0, { hostCount7, hostCount7b, viewerLocal7 });

  // --- 8. Enter on a focused Cancel cancels ---
  await selectRow(host.win, 'qa-H6');
  await pressHeader(host.win, 'close');
  await host.win.waitForSelector('.ck-confirm-cancel', { timeout: 5000 });
  await host.win.focus('.ck-confirm-cancel');
  await host.win.keyboard.press('Enter');
  await sleep(1500);
  check('confirm.enterOnCancelCancels', await running(host.win, 'qa-H6'));

  // --- 9. restart keeps the tile, its name, and leaves exactly one terminal for it ---
  const count9 = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).length);
  await selectRow(host.win, 'qa-H6');
  await pressHeader(host.win, 'restart');
  await host.win.waitForSelector('.ck-confirm-ok', { timeout: 5000 });
  await host.win.click('.ck-confirm-ok');
  await sleep(7000);
  const count9b = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).length);
  check('restart.oneTerminalSameName', count9b === count9 && (await liveRows(host.win, 'qa-H6')).length === 1, { count9, count9b, rows: await liveRows(host.win, 'qa-H6') });
  check('restart.noGhostOnViewer', (await liveRows(viewer.win, 'qa-H6')).filter((r) => r.activity === 'exited').length === 0, await liveRows(viewer.win, 'qa-H6'));

  // --- 10. "Update installed · Restart to apply" offers a one-click restart that keeps the tile ---
  // Claude Code's own /restart is macOS/Linux-only, so on Windows this button is the way onto a new
  // version. The notice is printed into a real tile (the agent is left for its shell first), exactly
  // where Claude Code draws it, and the button must restart the session under the same name.
  await openNamed(host, 'qa-U1');
  await waitFor(async () => (await liveRows(host.win, 'qa-U1')).length);
  await waitFor(() => selectRow(host.win, 'qa-U1'), 15000, 1000);
  const u1 = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).find((s) => s.label === 'qa-U1')?.id);
  const screenHas = (text) => host.win.evaluate((t) => [...(document.querySelector('.ck-term.show .xterm-rows')?.children ?? [])].some((r) => (r.textContent ?? '').includes(t)), text);
  await waitFor(() => screenHas('No, exit'), 20000);
  await host.win.evaluate((id) => window.devdeck.cockpit.input(id, '\r'), u1); // trust prompt: "No, exit" -> PowerShell
  await waitFor(() => screenHas('PS '), 15000);
  await host.win.evaluate((id) => window.devdeck.cockpit.input(id, "Write-Host '  >> bypass permissions on      Update installed · Restart to apply'\r"), u1);
  const appeared = await waitFor(() => host.win.evaluate(() => !!document.querySelector('#ck-header .ck-update')), 8000);
  check('update.buttonAppears', appeared, appeared ? undefined : await host.win.evaluate(() => [...(document.querySelector('.ck-term.show .xterm-rows')?.children ?? [])].map((r) => r.textContent).filter((t) => t && t.trim()).slice(-6)));
  const count10 = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).length);
  await host.win.click('#ck-header .ck-update').catch(() => {});
  await sleep(7000);
  const after10 = await host.win.evaluate(async () => (await window.devdeck.cockpit.liveSessions()).map((s) => ({ id: s.id, label: s.label })));
  check('update.restartsSameTile', after10.length === count10 && after10.some((s) => s.label === 'qa-U1' && s.id !== u1), { u1, after10 });
  check('update.buttonGoneAfterRestart', !(await host.win.evaluate(() => !!document.querySelector('#ck-header .ck-update'))));

  // --- what a relaunch / update restart would bring back ---
  const exitedAnywhere = [...await rows(host.win), ...await rows(viewer.win)].filter((r) => r.activity === 'exited' && !r.previous);
  check('noExitedTilesAnywhere', exitedAnywhere.length === 0, exitedAnywhere);
} catch (e) {
  console.error('close QA failed', e);
  checks.harness = false;
} finally {
  for (const i of [viewer, host]) { try { await closeElectron(i.app); } catch (e) { console.error(String(e)); checks.cleanExit = false; } }
}

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ checks, notes }, null, 2));
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'all close checks passed');
process.exit(failed.length ? 1 : 0);
