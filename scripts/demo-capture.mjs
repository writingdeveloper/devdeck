// Launches DevDeck against the isolated curated fixture (scripts/demo-fixture.mjs)
// and captures clean English marketing screenshots to qa/shots/demo-*.png.
// Overriding USERPROFILE/HOME points os.homedir() (and thus ~/.claude/projects)
// at the throwaway demo HOME, so NO real data is read. Dev-only.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'qa', 'shots');
mkdirSync(out, { recursive: true });

const HOME = join(tmpdir(), 'devdeck-demo-home');
const REPOS = join(HOME, 'Documents', 'GitHub');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'devdeck-demo-ud-'))}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
  env: { ...process.env, USERPROFILE: HOME, HOME, HOMEDRIVE: 'C:', HOMEPATH: HOME.slice(2) },
});
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error') console.log('renderer error:', m.text()); });

// The tray guard turns window close into hide-to-tray (and window-all-closed keeps the app alive),
// so Playwright's bare app.close() waits forever and leaks a zombie harness instance. Mark the quit
// intent in main (same flag the tray's own Quit item sets) and quit explicitly.
async function closeApp() {
  await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
  await app.close().catch(() => {});
}

await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});
// Force English + point at the curated repos, then reload so the UI re-inits.
await win.evaluate((dir) => Promise.all([window.devdeck.setLanguage('en'), window.devdeck.setBaseDir(dir)]), REPOS);
// Seed per-project tasks BEFORE the hero shot so deck cards carry the ☑ badge and the
// Next board shows every due bucket (overdue / today / this week / no date).
const dayIso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const createdAt = new Date().toISOString();
const TODO_SEED = [
  ['acme-dashboard', [
    { id: 'd1', text: 'ship the dark-mode toggle', done: false, due: dayIso(0), createdAt },
    { id: 'd2', text: 'write the release notes', done: false, due: dayIso(-1), createdAt },
    { id: 'd3', text: 'fix the theme flash on load', done: true, due: null, createdAt },
  ]],
  ['payments-api', [
    { id: 'p1', text: 'integration tests for refunds', done: false, due: dayIso(2), createdAt },
    { id: 'p2', text: 'document the idempotency keys', done: false, due: null, createdAt },
  ]],
  ['ml-pipeline', [
    { id: 'm1', text: 'fix the data-loader OOM', done: false, due: dayIso(-3), createdAt },
    { id: 'm2', text: 'add drift alerts to the metrics dashboard', done: false, due: dayIso(5), createdAt },
  ]],
];
for (const [repo, todos] of TODO_SEED) {
  await win.evaluate(({ p, t }) => window.devdeck.setTodos(p, t), { p: join(REPOS, repo), t: todos });
}
await win.reload();
await win.waitForSelector('#cards .card', { timeout: 30000 }).catch(() => {});
await win.setViewportSize({ width: 1200, height: 760 }).catch(() => {});
await win.waitForTimeout(700);

async function shot(name) { await win.waitForTimeout(350); await win.screenshot({ path: join(out, name + '.png') }); console.log('shot:', name); }
async function showView(v) { await win.click(`.rail-item[data-view="${v}"]`); await win.waitForTimeout(400); }

// 1) hero deck
await showView('projects');
await shot('demo-projects');
// 2) expand a multi-session card (resume cue + session history visible)
const expanded = await win.evaluate(() => {
  const c = document.querySelector('.sessions-head .caret');
  if (c) { c.parentElement.click(); return true; } return false;
});
if (expanded) await shot('demo-sessions');
// 3) neglected filter via the deck-pulse 🔴 segment (the traffic-light payoff)
await win.waitForSelector('.deck-pulse .p-neglect', { timeout: 8000 }).catch(() => {});
await win.click('.deck-pulse .p-neglect').catch(() => {});
await shot('demo-neglected');
await win.click('.deck-pulse .p-neglect').catch(() => {});
// 4) usage analytics
await showView('usage');
await win.waitForSelector('.usage-summary, .usage-table', { timeout: 30000 }).catch(() => {});
await shot('demo-usage');
// 5) settings
await showView('settings');
await shot('demo-settings');
// 6) Next task board — the seeded todos fill the overdue / today / this-week / no-date buckets
await showView('next');
await win.waitForSelector('#view-next .tk-group, #view-next .tk-add', { timeout: 10000 }).catch(() => {});
await win.waitForTimeout(500);
await shot('demo-tasks');

// 7) cockpit sidebar — the rows are what the README is actually selling (provider mark, model,
// 🧠 context %, the 💬 auto summary, and a restorable entry whose conversation is gone). A live tile
// needs a real agent process, which the isolated demo HOME deliberately has none of, so the rows are
// rendered from representative data — the same technique qa/screenshot.mjs uses to measure them.
await showView('cockpit');
await win.evaluate(() => {
  const groups = document.getElementById('ck-groups');
  if (!groups) return;
  const hdr = (t) => `<div class="ck-group-head"><span>${t}</span></div>`;
  const row = (name, logo, act, meta, ctx, summary) => `<div class="ck-row act-${act}">
    <span class="ck-ind">${act === 'attention' ? '●' : ''}</span>
    <img class="ck-provider-logo" src="./assets/provider-${logo}.svg" alt="${logo}">
    <div class="ck-row-main">
      <div class="ck-line1"><span class="nm">${name}</span><span class="ck-ctx-col sev-${ctx >= 80 ? 'warn' : 'ok'}">🧠${ctx}%</span></div>
      <div class="mt">${meta}</div><div class="sm" title="${summary}">${summary}</div></div>
    <span class="ck-row-acts"><button class="ck-pin">📌</button><button class="ck-rename">✎</button><button class="ck-close">✕</button></span></div>`;
  groups.innerHTML = hdr('Needs you')
    + row('checkout-api', 'claude', 'attention', 'main · Opus 5', 84, 'Waiting on: run the migration against staging?')
    + hdr('Working')
    + row('storefront', 'codex', 'working', 'feat/cart · gpt-5.6-sol', 31, 'Rewriting the cart reducer tests')
    + row('design-system', 'claude', 'working', 'main · Sonnet 5', 12, 'Token pipeline: 3 files edited this turn')
    + hdr('Previous · 1')
    + `<div class="ck-row ck-row-prev"><span class="ck-ind"><span class="ck-dot"></span></span>
        <img class="ck-provider-logo" src="./assets/provider-claude.svg" alt="claude">
        <div class="ck-row-main"><div class="nm">infra-terraform</div><div class="mt gone">⚠ conversation gone</div></div>
        <span class="ck-prev-acts"><button class="ck-pin">📌</button><button class="ck-forget">✕</button></span></div>`;
});
// The ROWS alone are the shot: with no live tile the right-hand pane still shows its "no open
// sessions" empty state, which would contradict them, and the list element itself runs the full window
// height. Captured at 2× zoom — the sidebar is only 250 CSS px wide, and the demo reel scales every
// scene up to ~1200, so at 1× this would be the one blurry frame in it.
await win.waitForTimeout(350);
await win.locator('#ck-groups').screenshot({ path: join(out, 'demo-cockpit.png') });
console.log('shot: demo-cockpit (sidebar rows)');

await closeApp();
console.log('done — qa/shots/demo-*.png');
