// Performance harness: where does the renderer's CPU actually go?
//
// The bug this exists for was reported as "the app suddenly got very slow, and another machine freezes
// for two or three minutes" — a claim no unit test can answer, because it is about the ONE thread that
// draws. So this launches the real app, opens real sessions, shows them, and takes a real V8 CPU
// profile of the renderer, reporting self time by function. Long tasks (anything blocking the UI
// thread past 50ms) are recorded alongside, because a freeze is not average CPU — it is one call that
// does not return.
//
// The terminals must be ON SCREEN to cost anything: a hidden xterm renders nothing, so a profile taken
// on the deck view measures an empty room.
//
// Run: node qa/perf.mjs [sessionCount]   (after npm run build)
import { _electron as electron } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSIONS = Math.max(1, Number(process.argv[2] ?? 4) | 0);
const IDLE_MS = 10_000;

const qaUserData = mkdtempSync(join(tmpdir(), 'devdeck-perf-'));
writeFileSync(join(qaUserData, 'state.json'), JSON.stringify({
  projects: {}, settings: { folders: [{ path: root, kind: 'repo' }], viewMode: 'list', cockpitSessions: [] },
}, null, 2));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${qaUserData}`, '--no-sandbox'],
  cwd: root,
  // A nested agent must not inherit this session's identity, or it writes into the transcript of the
  // conversation running the harness.
  env: { ...process.env, CLAUDE_CODE_SSE_PORT: '', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
});
const win = await app.firstWindow();
await win.setViewportSize?.({ width: 1500, height: 950 }).catch(() => {});
await win.waitForTimeout(2500);

if (!(await win.evaluate(() => window.devdeck.cockpit != null))) {
  console.log('SKIP: no pty on this platform'); await quit(); process.exit(0);
}

// ---- open N real sessions ------------------------------------------------------------------
// Real terminals with real agents attached: the load being measured is xterm drawing what a TUI
// actually prints, which no synthetic writer reproduces.
const opened = await win.evaluate(async ({ n, path }) => {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await window.devdeck.cockpit.open({ projectPath: path, sessionId: null, cols: 120, rows: 40, mode: 'new' }).catch(() => null);
    if (r?.id) ids.push(r.id);
  }
  return ids;
}, { n: SESSIONS, path: root }).catch(() => []);
console.log(`opened: ${opened.length}`);

// Onto the cockpit, where the terminals are actually drawn.
await win.click('.rail-item[data-view="cockpit"]').catch(() => {});
await win.waitForTimeout(600);
await win.locator('#shell-session-groups .shell-session').first().click().catch(() => {});
// Agents need a moment to boot and paint their TUI; without content there is nothing to render.
await win.waitForTimeout(12_000);

const state = await win.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-term-size]')];
  const shown = tiles.filter((t) => t.getClientRects().length > 0);
  return {
    view: document.querySelector('.view.show, [id^="view-"]:not([hidden])')?.id ?? '?',
    tiles: tiles.length, shown: shown.length,
    sizes: tiles.map((t) => t.dataset.termSize),
    painted: shown.map((t) => (t.innerText ?? '').replace(/\s+/g, ' ').trim().length),
  };
});
console.log(`view=${state.view} tiles=${state.tiles} shown=${state.shown} sizes=${state.sizes.join(',')} paintedChars=${state.painted.join(',')}`);

// ---- instrument the UI thread -------------------------------------------------------------
await win.evaluate(() => {
  window.__perf = { long: [], raf: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push(Math.round(e.duration)); })
    .observe({ entryTypes: ['longtask'] });
  const tick = () => { window.__perf.raf++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

const cdp = await win.context().newCDPSession(win);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); // µs

async function profile(label, body) {
  await win.evaluate(() => { window.__perf.long = []; window.__perf.raf = 0; });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await body();
  const { profile: p } = await cdp.send('Profiler.stop');
  report(label, p, Date.now() - t0, ...Object.values(await win.evaluate(() => ({ long: window.__perf.long, raf: window.__perf.raf }))));
}

/** Self time per function, from the sample stream — the only honest "what was running". */
function report(label, p, wall, long, raf) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = p.timeDeltas ?? [];
  p.samples.forEach((id, i) => {
    const cf = byId.get(id)?.callFrame; if (!cf) return;
    const where = cf.url ? `${cf.url.split('/').pop()}:${cf.lineNumber + 1}` : '';
    const key = `${cf.functionName || '(anonymous)'}  ${where}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0));
  });
  const idleKeys = (k) => k.startsWith('(idle)') || k.startsWith('(program)');
  const busy = [...self.entries()].filter(([k]) => !idleKeys(k)).reduce((a, [, v]) => a + v, 0);
  console.log(`\n===== ${label} =====`);
  console.log(`wall ${wall}ms · JS+GC ${(busy / 1000).toFixed(0)}ms = ${(busy / 10 / wall).toFixed(1)}% of one core · frames ${raf} (${(raf / wall * 1000).toFixed(0)}fps)`);
  if (long.length) {
    const worst = [...long].sort((a, b) => b - a);
    console.log(`LONG TASKS: ${long.length} · worst ${worst.slice(0, 6).join('ms, ')}ms · total ${long.reduce((a, b) => a + b, 0)}ms blocked`);
  } else console.log('LONG TASKS: none');
  for (const [k, v] of [...self.entries()].filter(([k]) => !idleKeys(k)).sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    if (v < 3000) break;
    console.log(`  ${(v / 1000).toFixed(0).padStart(6)}ms  ${k}`);
  }
}

// ---- 1. idle, terminals on screen ----------------------------------------------------------
await profile(`IDLE ${IDLE_MS / 1000}s · ${state.shown}/${state.tiles} tiles visible`, () => win.waitForTimeout(IDLE_MS));

// ---- 2. one terminal streaming hard --------------------------------------------------------
// Leave the agent to get a plain shell back (costs no tokens), then print more than a screen holds.
// This is the load an agent's own long turn puts on the renderer.
if (opened.length) {
  const id = opened[0];
  await win.evaluate((i) => window.devdeck.cockpit.input(i, ''), id).catch(() => {});
  await win.waitForTimeout(400);
  await win.evaluate((i) => window.devdeck.cockpit.input(i, ''), id).catch(() => {});
  await win.waitForTimeout(2500);
  await profile('STREAM 20k lines into one visible terminal', async () => {
    await win.evaluate((i) => window.devdeck.cockpit.input(i, "1..20000 | % { 'perf line ' + $_ + ' ' + ('x' * 60) }\r"), id).catch(() => {});
    await win.waitForTimeout(15_000);
  });
}

// ---- 3. window resize ----------------------------------------------------------------------
// "shrink the window and grow it again and it lags" — one pane resize re-fits every open terminal.
await profile('RESIZE shrink+grow x4', async () => {
  for (const [w, h] of [[900, 600], [1500, 950], [1000, 700], [1500, 950]]) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setSize(s[0], s[1]), [w, h]);
    await win.waitForTimeout(1400);
  }
});

// ---- 4. refresh (redraw every terminal) ----------------------------------------------------
await profile('REFRESH button (redraw all terminals)', async () => {
  await win.click('#refresh').catch(() => {});
  await win.waitForTimeout(6000);
});

// ---- 5. switching sessions -----------------------------------------------------------------
await profile('SWITCH sessions x8', async () => {
  const rows = win.locator('#shell-session-groups .shell-session');
  const n = await rows.count().catch(() => 0);
  for (let i = 0; i < 8 && n > 0; i++) { await rows.nth(i % n).click().catch(() => {}); await win.waitForTimeout(400); }
});

await quit();

async function quit() {
  await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
  await app.close().catch(() => {});
}
