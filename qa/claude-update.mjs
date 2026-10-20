// Verifies "update all Claude sessions" in the real app with a fixture `claude`: the button appears
// when the agent's screen says its update failed, every session is stopped, `claude update` runs with
// none of them alive, and the same conversations come back.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows harness (fixture claude.cmd on PATH). Run with npm run qa:update.
const root = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
const shots = resolve(process.argv[3] ?? join(root, 'qa', 'shots', 'claude-update'));
mkdirSync(shots, { recursive: true });
const { closeElectron } = await import('file:///' + join(root, 'qa', 'electron-lifecycle.mjs').replace(/\\/g, '/'));

const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-update-'));
const repo = join(sandbox, 'update-workspace');
const bin = join(sandbox, 'bin');
const profile = join(sandbox, 'profile');
const home = join(profile, 'home');
const log = join(sandbox, 'calls.log');
for (const p of [repo, bin, profile, home]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-update'], { cwd: repo });
// Records every invocation with how many sessions were alive at that moment (a live session holds a
// lock file); a session prints Claude's failed-update footer so the cockpit offers the fix.
writeFileSync(join(bin, 'agent.js'), `
const fs = require('fs'); const path = require('path');
const log = ${JSON.stringify(log)}; const locks = ${JSON.stringify(sandbox)};
// A tree kill on Windows skips exit handlers, so a lock can outlive its process: ask the OS instead.
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const alive = () => fs.readdirSync(locks).filter((f) => f.startsWith('alive-') && running(Number(f.slice(6)))).length;
const args = process.argv.slice(2);
if (args[0] === 'update') { fs.appendFileSync(log, 'update alive=' + alive() + '\\n'); console.log('Successfully updated from 2.1.1 to 2.1.2'); process.exit(0); }
const me = path.join(locks, 'alive-' + process.pid); fs.writeFileSync(me, '');
const bye = () => { try { fs.unlinkSync(me); } catch {} process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye); process.on('exit', () => { try { fs.unlinkSync(me); } catch {} });
fs.appendFileSync(log, 'start ' + args.join(' ') + '\\n');
process.stdout.write('FIXTURE_READY\\r\\n  \\u2717 Auto-update failed \\u00b7 Try claude doctor\\r\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', () => {});
setInterval(() => {}, 1 << 30);
`);
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0agent.js" %*\r\n');

const sids = ['5a1b2c3d-1111-4222-8333-944455556666', '6b2c3d4e-1111-4222-8333-944455556666'];
const enc = repo.replace(/[^a-zA-Z0-9]/g, '-');
const tdir = join(home, '.claude', 'projects', enc);
mkdirSync(tdir, { recursive: true });
for (const sid of sids) writeFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: repo, sessionId: sid, message: { role: 'user', content: 'hi' } }) + '\n');
writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings: {
  language: 'ko', folders: [{ path: repo, kind: 'repo' }], viewMode: 'list',
  cockpitSessions: sids.map((sid, i) => ({ tileId: 'tile-up-' + i, projectPath: repo, name: 'update-workspace', sessionId: sid, agentId: 'claude', label: 'Update QA ' + i, lastActiveMs: Date.now() })),
} }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = bin + ';' + env[pathKey];
const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu'], cwd: root, env });
const errors = [];
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
try {
  const win = await app.firstWindow();
  win.setDefaultTimeout(20000);
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await check('both sessions restore and run', async () => {
    await win.waitForFunction(() => document.querySelectorAll('#shell-session-groups .shell-session').length === 2, null, { timeout: 30000 });
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.getByRole('button', { name: /모두 복원/ }).click();
    const until = Date.now() + 20000;
    const starts = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split(/\r?\n/).filter((l) => l.startsWith('start')).length;
    while (Date.now() < until && starts() < 2) await new Promise((r) => setTimeout(r, 300));
    assert.equal(starts(), 2);
  });
  await check('a failed background update offers "update all"', async () => {
    await win.waitForFunction(() => [...document.querySelectorAll('#ck-header .ck-update')].some((b) => b.textContent.includes('모두 업데이트 (2)')), null, { timeout: 15000 });
    await win.screenshot({ path: join(shots, 'u1-offer.png') });
  });
  await check('confirm → sessions stop, claude update runs with none alive, both come back', async () => {
    const startsBefore = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start')).length;
    await win.locator('#ck-header .ck-update', { hasText: '모두 업데이트' }).click();
    await win.locator('.ck-confirm-ok').click();
    await win.waitForFunction(() => document.querySelectorAll('#shell-session-groups .shell-session').length === 2, null, { timeout: 30000 });
    const until = Date.now() + 30000;
    let calls = '';
    while (Date.now() < until) {
      calls = readFileSync(log, 'utf8');
      if (calls.includes('update alive=') && calls.split('\n').filter((l) => l.startsWith('start')).length >= startsBefore + 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.match(calls, /update alive=0/, 'update ran with no session alive:\n' + calls);
    const after = calls.slice(calls.indexOf('update alive='));
    for (const sid of sids) assert.ok(after.includes(sid), 'resumed ' + sid + ':\n' + calls);
    await win.screenshot({ path: join(shots, 'u2-after.png') });
  });
  assert.deepEqual(errors, [], 'no page/console errors');
  console.log('done');
} catch (e) {
  console.log('FAIL', e?.message ?? e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'u-fail.png') }); } catch {}
  console.log('calls:\n' + (existsSync(log) ? readFileSync(log, 'utf8') : '(none)'));
  console.log('errors:', errors);
  process.exitCode = 1;
} finally {
  await closeElectron(app);
}
