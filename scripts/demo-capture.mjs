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
// 3) neglected-only filter (the traffic-light payoff)
await win.click('#neglected-only').catch(() => {});
await shot('demo-neglected');
await win.click('#neglected-only').catch(() => {});
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

await closeApp();
console.log('done — qa/shots/demo-*.png');
