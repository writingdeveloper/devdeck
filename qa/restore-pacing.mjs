// Windows harness: restored agents start ONE AT A TIME — each only after the one before it finished
// starting. A fixture agent takes 2s to boot (the way `claude --resume` of a large transcript does)
// and records when it was launched; the gaps between launches must cover that boot, both for the
// sessions put back at launch and for "Restore all". Never starts a real agent.
// Run with npm run qa:restore-pacing.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeElectron } from './electron-lifecycle.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'win32') { console.log('SKIP: Windows native PTY required'); process.exit(0); }
const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-restore-pacing-'));
const repo = join(sandbox, 'pacing-workspace');
const bin = join(sandbox, 'bin');
const profile = join(sandbox, 'profile');
const home = join(profile, 'home');
const log = join(sandbox, 'starts.log');
for (const p of [repo, bin, home]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-pacing'], { cwd: repo });
const BOOT_MS = 2000;
writeFileSync(join(bin, 'agent.js'), `
if (process.argv.includes('agents')) { process.stdout.write('[]'); process.exit(0); } // DevDeck's background-session listing
require('fs').appendFileSync(${JSON.stringify(log)}, Date.now() + ' ' + process.argv.slice(2).join(' ') + '\\n');
const t = setInterval(() => process.stdout.write('.'), 100); // busy drawing while it boots
setTimeout(() => { clearInterval(t); process.stdout.write('\\r\\nPACING_READY\\r\\n> '); }, ${BOOT_MS});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', () => {});
setInterval(() => {}, 1 << 30);
`);
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0agent.js" %*\r\n');

const N = 4;
const sids = Array.from({ length: N }, (_, i) => `${i + 1}a2b3c4d-1111-4222-8333-944455556666`);
const tdir = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(tdir, { recursive: true });
for (const sid of sids) writeFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: repo, sessionId: sid, message: { role: 'user', content: 'hi' } }) + '\n');
writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings: {
  language: 'en', folders: [{ path: repo, kind: 'repo' }], viewMode: 'list',
  cockpitSessions: sids.map((sid, i) => ({ tileId: 'tile-pace-' + i, projectPath: repo, name: 'pacing-workspace', sessionId: sid, agentId: 'claude', label: 'Pace ' + i, lastActiveMs: Date.now() })),
} }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = bin + ';' + env[pathKey];

const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => Number(l.split(' ')[0])) : []);
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);
const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu'], cwd: root, env });
let failed = false;
try {
  const win = await app.firstWindow();
  win.setDefaultTimeout(60000);
  await win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
  // Whatever launch put back, then the rest by "Restore all".
  const restoreAll = win.getByRole('button', { name: /Restore all/i });
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (await restoreAll.count() && await restoreAll.first().isVisible() && await restoreAll.first().isEnabled()) { await restoreAll.first().click(); break; }
    if (starts().length >= N) break;
    await win.waitForTimeout(500);
  }
  while (Date.now() < until && starts().length < N) await win.waitForTimeout(500);
  const ts = starts();
  console.log(`starts: ${ts.length} gaps(ms): ${gaps(ts).join(', ')}`);
  assert.equal(ts.length, N, 'every saved session started');
  // Each agent draws for BOOT_MS and then needs a quiet moment before the next may start.
  for (const g of gaps(ts)) assert.ok(g >= BOOT_MS, `next agent started ${g}ms after the previous one, before it finished starting`);
  console.log('PASS restored agents start one at a time, each after the previous finished starting');
} catch (e) {
  console.log('FAIL', e?.message ?? e);
  failed = true;
} finally {
  await closeElectron(app).catch(() => {});
}
if (failed) process.exitCode = 1;
