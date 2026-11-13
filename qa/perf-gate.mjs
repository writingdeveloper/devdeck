// Deterministic performance gate (Windows CI): the regressions DevDeck has actually shipped, measured
// in units that do not depend on how fast the runner is.
//
// qa/perf.mjs is the manual benchmark — real agents, CPU percentages, a person reading the numbers.
// CPU percentages are meaningless across CI hardware, and real agents cost money, so this gate asks
// different questions of a fixture agent that prints a known workload:
//
//  - IDLE: is anything animating or rewriting the DOM when nothing is happening? Every "the app got
//    heavy" report so far was a screen that never stopped drawing (a CSS spinner composited at 60fps,
//    a sidebar rebuilt on every PTY chunk). Counted, not timed.
//  - WORKING: one tile repainting its whole screen at 10fps the way an agent's TUI does. Does the
//    main process keep up (event-loop stall), and does the UI thread stay responsive (long tasks)?
//  - HIDDEN: sessions printing while one of them is behind the other. A tile nobody is looking at
//    must not be drawn: xterm's DOM renderer redrew a display:none terminal in full for every line
//    that scrolled it, measuring every cell (v1.49.0, 20 tiles: frames of 5–16 s). Counted in
//    character-width measurements.
//  - STREAM: 20,000 lines into a visible terminal. The "other PC freezes for minutes" class is a main
//    process that stops answering; its longest stall is the number that says so.
//
// Limits are set several times above what this machine measures, so a slow runner passes and a real
// regression (an order of magnitude) does not. Never starts a real agent.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeElectron } from './electron-lifecycle.mjs';
import { sandboxDir } from './sandbox.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(process.env.DEVDECK_PERF_OUT || join(root, 'qa', 'shots', 'perf-gate'));
mkdirSync(out, { recursive: true });
if (process.platform !== 'win32') { console.log('SKIP: Windows native PTY required'); process.exit(0); }

const LIMITS = {
  idleRunningAnimations: 0,   // nothing may animate on a quiet deck
  idleMutations: 40,          // DOM mutation records in 6s of quiet (a rebuild-per-tick loop is thousands)
  idleLongTasks: 0,
  workingMainStallMs: 250,    // longest main-process event-loop stall while a tile repaints at 10fps
  workingLongestTaskMs: 250,
  workingOutsideMutations: 400, // sidebar/header/footer while two tiles repaint at 10fps for 8s (a rebuild per chunk is ~10k)
  hiddenWidthMeasurements: 300, // character-width measurements while a hidden tile scrolls 60 lines (drawing it hidden is ~100k)
  hiddenLongestTaskMs: 250,
  hiddenLayoutQuestions: 0,   // times a tile that is off screen, or the list nobody sees, made the document lay itself out to say so
  streamMainStallMs: 600,     // longest main-process stall while 20k lines stream
  streamLongestTaskMs: 600,
  streamSeconds: 45,          // the stream must finish drawing at all
};

const sandbox = sandboxDir('devdeck-perf-gate-');
const repo = join(sandbox, 'perf-workspace');
const bin = join(sandbox, 'bin');
const profile = join(sandbox, 'profile');
const home = join(profile, 'home');
for (const p of [repo, bin, home]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-perf'], { cwd: repo });
// The fixture agent: a static screen at rest; "W" repaints the whole screen at 10fps for 8s with a
// Claude spinner in it (so the deck shows the session as working); "S" prints 20,000 lines.
writeFileSync(join(bin, 'agent.js'), `
if (process.argv.includes('agents')) { process.stdout.write('[]'); process.exit(0); } // DevDeck's background-session listing
const out = (s) => process.stdout.write(s);
// What this agent has finished, on disk: the screen cannot say (a resize repaints it and drops what
// scrolled off), and the harness must not start measuring the next thing early.
const mark = (name) => require('fs').appendFileSync(${JSON.stringify(join(bin, 'marks.log'))}, name + '\\n');
const E = '\\x1b';
const screen = (title) => out(E + '[H' + E + '[2J' + title + '\\r\\n' + Array.from({ length: 30 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(80)).join('\\r\\n') + '\\r\\n> ');
screen('PERF_FIXTURE_READY'); mark('PERF_FIXTURE_READY');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const glyphs = ['\\u00b7', '\\u2722', '\\u2733', '\\u2736', '\\u273b', '\\u273d'];
process.stdin.on('data', (d) => {
  const k = d.toString();
  if (k === 'W') {
    let i = 0; const end = Date.now() + 8000;
    const t = setInterval(() => {
      i++;
      const rows = Array.from({ length: 34 }, (_, r) => 'row ' + r + ' frame ' + i + ' ' + 'x'.repeat(90));
      out(E + '[H' + rows.join('\\r\\n') + '\\r\\n' + glyphs[i % glyphs.length] + ' Thinking\\u2026 (' + i + 's \\u00b7 esc to interrupt)');
      if (Date.now() > end) { clearInterval(t); screen('WORK_DONE'); mark('WORK_DONE'); }
    }, 100);
  } else if (k === 'B') {
    // An agent working in the background: a line every 100ms for 6s, scrolling its screen.
    let i = 0;
    const t = setInterval(() => {
      i++;
      out('trickle ' + i + ' ' + 'z'.repeat(70) + '\\r\\n');
      if (i >= 60) { clearInterval(t); out('TRICKLE_DONE\\r\\n'); mark('TRICKLE_DONE'); }
    }, 100);
  } else if (k === 'S') {
    let n = 0;
    const pump = () => { let chunk = ''; for (let j = 0; j < 500 && n < 20000; j++) chunk += 'perf line ' + (++n) + ' ' + 'y'.repeat(60) + '\\r\\n'; out(chunk); if (n < 20000) setImmediate(pump); else { out('STREAM_DONE\\r\\n'); mark('STREAM_DONE'); } };
    pump();
  }
});
setInterval(() => {}, 1 << 30);
`);
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0agent.js" %*\r\n');
const sids = ['8d4e5f6a-1111-4222-8333-944455556666', '9e5f6a7b-1111-4222-8333-944455556666'];
const tdir = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(tdir, { recursive: true });
for (const sid of sids) writeFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: repo, sessionId: sid, message: { role: 'user', content: 'hi' } }) + '\n');
writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings: {
  language: 'en', folders: [{ path: repo, kind: 'repo' }], viewMode: 'list',
  cockpitSessions: sids.map((sid, i) => ({ tileId: 'tile-perf-' + i, projectPath: repo, name: 'perf-workspace', sessionId: sid, agentId: 'claude', label: 'Perf ' + i, lastActiveMs: Date.now() })),
} }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = bin + ';' + env[pathKey];

// A window that Windows considers covered is not drawn at all: no frames, so nothing below would be
// measured (and every number would pass). On a desktop someone is using, that is the usual state of a
// window a script opened — so the gate's window keeps drawing whatever is on top of it.
const KEEP_DRAWING = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile, '--no-sandbox', ...KEEP_DRAWING], cwd: root, env });
const results = {};
const failures = [];
const judge = (name, value, limit) => {
  results[name] = { value, limit };
  const ok = value <= limit;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${value} (limit ${limit})`);
  if (!ok) failures.push(name);
};
try {
  const win = await app.firstWindow();
  win.setDefaultTimeout(30000);
  await win.setViewportSize?.({ width: 1500, height: 950 }).catch(() => {});
  await win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
  // Both tiles running, one on screen.
  const restoreAll = win.getByRole('button', { name: /Restore all/i });
  if (await restoreAll.count()) await restoreAll.first().click();
  await win.waitForFunction(() => document.querySelectorAll('.ck-term').length >= 2, null, { timeout: 30000 });
  await win.locator('#shell-session-groups .shell-session').first().click();
  const ids = await win.evaluate(() => window.devdeck.cockpit.liveSessions().then((list) => list.map((s) => s.id)));
  assert.ok(ids.length >= 2, 'two sessions running: ' + JSON.stringify(ids));
  // Read off each session's output buffer, not the visible rows: a screen printed before the terminal
  // reached its final size can scroll the marker out of view, which says nothing about performance.
  // Every running session has finished `marker` — read off the fixture's own log. This was a
  // waitForFunction over each session's output buffer, and waited for nothing: an async predicate's
  // PROMISE was taken for its answer, and a promise is truthy. The "working" window below therefore
  // measured the 4 ms after the key was sent instead of the 8 s of repainting, and the buffer could
  // not have answered anyway — a resize repaints the screen and drops what scrolled off it.
  const marksLog = join(bin, 'marks.log');
  const allPrinted = async (marker, ms) => {
    for (const until = Date.now() + ms; ;) {
      const seen = existsSync(marksLog) ? readFileSync(marksLog, 'utf8').split('\n').filter((l) => l === marker).length : 0;
      if (seen >= ids.length) return;
      if (Date.now() > until) throw new Error(`${seen} of ${ids.length} sessions finished ${marker}`);
      await win.waitForTimeout(100);
    }
  };
  await allPrinted('PERF_FIXTURE_READY', 30000);
  // The workload goes to every running session — one is on screen, the other works in the background,
  // which is how a deck is actually used.
  const sendAll = (key) => win.evaluate(([list, k]) => { for (const i of list) window.devdeck.cockpit.input(i, k); }, [ids, key]);
  await win.waitForTimeout(3000); // let restore, meta and git refreshes settle

  // ---- instruments ---------------------------------------------------------------------------
  await win.evaluate(() => {
    window.__gate = { long: [], mutations: 0, outside: 0, measures: 0, asked: 0 };
    // xterm's DOM renderer sizes a cell by reading offsetWidth off a helper span. Counted, because a
    // terminal drawn while it is display:none measures every cell on every draw (the answer is 0,
    // and 0 is never cached) — the v1.49.0 "everything stutters" report, with 20 tiles open.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
      if (this.classList.contains('xterm-char-measure-element')) window.__gate.measures++;
      return width.get.call(this);
    } });
    // "Are you on screen?" put to the document is not free: it brings styles and layout up to date
    // first, in the middle of a frame that is still writing rows. A tile that is off screen has to
    // know that without asking (v1.49.1 asked for every draw: a fifth of the frame with 20 tiles),
    // and so does the pre-redesign session list, which is never displayed.
    for (const question of ['checkVisibility', 'getClientRects']) {
      const ask = Element.prototype[question];
      Element.prototype[question] = function (...args) {
        if ((this.classList.contains('ck-term') && !this.classList.contains('show')) || this.id === 'ck-list') window.__gate.asked++;
        return ask.apply(this, args);
      };
    }
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__gate.long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
    new MutationObserver((records) => {
      window.__gate.mutations += records.length;
      // Outside the terminals: the sidebar, header and footer. A terminal redraws by design while its
      // agent works; the chrome around it must not rebuild along with every chunk.
      for (const r of records) { const t = r.target.nodeType === 1 ? r.target : r.target.parentElement; if (!t?.closest?.('.ck-terms')) window.__gate.outside++; }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  // Main-process event-loop stall: a 20ms timer's lateness, the longest of the window.
  await app.evaluate(() => {
    globalThis.__lag = { max: 0, last: Date.now() };
    globalThis.__lagTimer = setInterval(() => { const now = Date.now(); globalThis.__lag.max = Math.max(globalThis.__lag.max, now - globalThis.__lag.last - 20); globalThis.__lag.last = now; }, 20);
  });
  const reset = async () => {
    await win.evaluate(() => { window.__gate.long = []; window.__gate.mutations = 0; window.__gate.outside = 0; window.__gate.measures = 0; window.__gate.asked = 0; });
    await app.evaluate(() => { globalThis.__lag.max = 0; globalThis.__lag.last = Date.now(); });
  };
  const read = async () => ({
    ...(await win.evaluate(() => ({ long: [...window.__gate.long], mutations: window.__gate.mutations, outside: window.__gate.outside, measures: window.__gate.measures, asked: window.__gate.asked }))),
    stall: await app.evaluate(() => globalThis.__lag.max),
  });

  // ---- IDLE ----------------------------------------------------------------------------------
  await reset();
  await win.waitForTimeout(6000);
  const idle = await read();
  const running = await win.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
    const el = a.effect?.target;
    return `${a.animationName ?? a.constructor.name} on ${el?.className ?? el?.tagName ?? '?'}`;
  }));
  if (running.length) console.log('  running animations: ' + running.join(' | '));
  judge('idle running animations', running.length, LIMITS.idleRunningAnimations);
  judge('idle DOM mutation records (6s)', idle.mutations, LIMITS.idleMutations);
  judge('idle long tasks', idle.long.length, LIMITS.idleLongTasks);
  await win.screenshot({ path: join(out, 'idle.png') });

  // ---- WORKING -------------------------------------------------------------------------------
  await reset();
  const workingFrom = Date.now();
  await sendAll('W');
  await allPrinted('WORK_DONE', 30000);
  // The window must be the 8 s of repainting, or the three numbers below say nothing.
  judge('working: seconds not measured (of 8)', Math.max(0, 8 - Math.round((Date.now() - workingFrom) / 1000)), 1);
  const working = await read();
  judge('working: main-process stall ms', working.stall, LIMITS.workingMainStallMs);
  judge('working: longest UI task ms', Math.max(0, ...working.long), LIMITS.workingLongestTaskMs);
  judge('working: DOM mutation records outside the terminals (8s)', working.outside, LIMITS.workingOutsideMutations);

  // ---- HIDDEN --------------------------------------------------------------------------------
  // Sessions scrolling while one of them is behind the other: the tile nobody is looking at must
  // cost nothing to draw. Counted in width measurements, which do not depend on the runner.
  await win.waitForTimeout(1500);
  const guarded = await win.evaluate(() => [...document.querySelectorAll('.ck-term')].map((t) => t.dataset.termHiddenSkip ?? 'missing'));
  judge('hidden: terminals without the off-screen draw guard', guarded.filter((g) => g !== 'on').length, 0);
  await reset();
  await sendAll('B');
  await allPrinted('TRICKLE_DONE', 30000);
  await win.waitForTimeout(500);
  const hidden = await read();
  judge('hidden: width measurements while a hidden tile scrolls 60 lines', hidden.measures, LIMITS.hiddenWidthMeasurements);
  judge('hidden: layout questions asked on behalf of what is not on screen', hidden.asked, LIMITS.hiddenLayoutQuestions);
  judge('hidden: longest UI task ms', Math.max(0, ...hidden.long), LIMITS.hiddenLongestTaskMs);
  // ...and the tile that was hidden shows what it printed the moment it is looked at.
  await win.locator('#shell-session-groups .shell-session').nth(1).click();
  const caughtUp = await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.includes('TRICKLE_DONE')), null, { timeout: 5000 }).then(() => 0, () => 1);
  judge('hidden: a tile shown again is missing its output', caughtUp, 0);
  await win.screenshot({ path: join(out, 'hidden.png') });
  await win.locator('#shell-session-groups .shell-session').first().click();

  // ---- STREAM --------------------------------------------------------------------------------
  await win.waitForTimeout(1500);
  await reset();
  const t0 = Date.now();
  await sendAll('S');
  await allPrinted('STREAM_DONE', LIMITS.streamSeconds * 1000);
  // ...and drawn: the visible terminal has caught up with it.
  await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.includes('STREAM_DONE')), null, { timeout: LIMITS.streamSeconds * 1000 });
  const streamSeconds = Math.round((Date.now() - t0) / 100) / 10;
  // The window includes what follows a stream — scrollback trimming, reflow, the deck catching up —
  // so a stall that lands just after the last line is still inside it.
  await win.waitForTimeout(3000);
  const stream = await read();
  judge('stream: seconds to draw 20k lines', streamSeconds, LIMITS.streamSeconds);
  judge('stream: main-process stall ms', stream.stall, LIMITS.streamMainStallMs);
  judge('stream: longest UI task ms', Math.max(0, ...stream.long), LIMITS.streamLongestTaskMs);
  await win.screenshot({ path: join(out, 'stream.png') });
} catch (e) {
  console.log('FAIL harness: ' + (e?.message ?? e));
  failures.push('harness');
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  await closeElectron(app).catch(() => {});
}
if (failures.length) { console.log(`\nFAIL: ${failures.join(', ')}`); process.exitCode = 1; } else console.log('\nPASS: performance gate');
// Exit explicitly: on a Windows runner a handle left by the closed app once kept node alive after
// the verdict was printed, until the job hit its 20-minute limit and the v1.42.0 release was cancelled.
process.exit(process.exitCode ?? 0);
