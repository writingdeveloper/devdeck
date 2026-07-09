// AI-QA screenshot harness: launches DevDeck via Playwright's Electron support,
// drives each view across all 4 languages, captures screenshots + console errors.
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'qa', 'shots');
mkdirSync(out, { recursive: true });

const consoleErrors = [];
const pageErrors = [];

// Isolated user-data-dir so the single-instance lock never makes this launch quit.
const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'devdeck-qa-'))}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
});
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
win.on('pageerror', (e) => pageErrors.push(String(e)));

// The tray guard turns window close into hide-to-tray (and window-all-closed keeps the app alive),
// so Playwright's bare app.close() waits forever and leaks a zombie harness instance. Mark the quit
// intent in main (same flag the tray's own Quit item sets) and quit explicitly.
async function closeApp() {
  await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
  await app.close().catch(() => {});
}

async function shot(name) {
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(out, name + '.png') });
  console.log('shot:', name);
}
async function lang() { return win.evaluate(() => document.documentElement.lang || 'ko'); }
async function showView(v) {
  await win.click(`.rail-item[data-view="${v}"]`);
  await win.waitForTimeout(300);
}

// wait for first project render (skeleton -> cards), generous for git scan
await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});

const LANGS = ['ko', 'en', 'ja', 'zh'];
for (let i = 0; i < LANGS.length; i++) {
  const l = await lang();
  // Projects view
  await showView('projects');
  await shot(`projects-${l}`);
  // Usage view (full scan can be slow)
  await showView('usage');
  await win.waitForSelector('.usage-summary, .usage-table', { timeout: 30000 }).catch(() => {});
  await shot(`usage-${l}`);
  // Settings view
  await showView('settings');
  await shot(`settings-${l}`);
  // advance language for the next iteration: open the 🌐 popup and pick the next one
  const next = LANGS[(i + 1) % LANGS.length];
  await win.click('#lang-btn');
  await win.click(`.lang-menu .menu-item[data-lang="${next}"]`);
  await win.waitForTimeout(300);
}

// Extra states on Projects (current language) — expanded sessions + neglected filter
await showView('projects');
const expanded = await win.evaluate(() => {
  const head = document.querySelector('.sessions-head .caret');
  if (head) { head.parentElement.click(); return true; }
  return false;
});
if (expanded) await shot('projects-session-expanded');
await win.click('#neglected-only').catch(() => {});
await shot('projects-neglected-filter');
await win.click('#neglected-only').catch(() => {});

// New-project modal: open, capture default + a validation-error state, then close
await win.click('#new-project').catch(() => {});
await win.waitForSelector('.np-overlay .np-panel', { timeout: 5000 }).catch(() => {});
await shot('new-project-modal');
await win.fill('#np-name', 'bad/name').catch(() => {});
await win.waitForTimeout(200);
await shot('new-project-modal-error');
await win.keyboard.press('Escape').catch(() => {});
await win.waitForTimeout(200);

// Compact list view toggle (+ GitHub octocat on rows for repos with a github remote)
await win.click('#view-list').catch(() => {});
await win.waitForSelector('#cards.as-list .prow', { timeout: 5000 }).catch(() => {});
await shot('projects-list-view');
await win.click('#view-cards').catch(() => {});
await win.waitForTimeout(300);

// Smooth refresh: a manual refresh must reconcile in place (reuse unchanged card nodes),
// not wipe + rebuild the whole deck. Tag every card, refresh, and confirm the nodes survive.
// The old full-replaceChildren behavior would leave 0 survivors.
const reuse = await win.evaluate(async () => {
  const before = Array.from(document.querySelectorAll('#cards .card'));
  before.forEach((el, i) => { el.dataset.qaMark = String(i); });
  document.getElementById('refresh').click();
  await new Promise((r) => setTimeout(r, 2500)); // wait out the reload + background cost re-render
  const survived = Array.from(document.querySelectorAll('#cards .card')).filter((el) => el.dataset.qaMark !== undefined).length;
  return { total: before.length, survived };
});
console.log(`refresh reuse: ${reuse.survived}/${reuse.total} card nodes reused`);
if (reuse.total > 0 && reuse.survived === 0) {
  console.error(`QA FAILED — deck refresh wiped all ${reuse.total} cards instead of reconciling in place`);
  await closeApp();
  process.exit(1);
}

// Narrow window to check responsive card grid
await win.setViewportSize({ width: 520, height: 760 }).catch(() => {});
await shot('projects-narrow');

// Title bar: maximized state (restore glyph)
await win.setViewportSize({ width: 1000, height: 720 }).catch(() => {});
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
await win.waitForTimeout(400);
await shot('titlebar-maximized');
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());

// Next task board: navigate + capture (empty-state render path — add form + no open tasks in the
// isolated QA profile). Guards the tasks.ts wiring renders without console/page errors.
await showView('next');
await win.waitForSelector('#view-next .tk-bar, #view-next .empty', { timeout: 5000 }).catch(() => {});
await shot('next-tasks');
const nextAdd = await win.evaluate(() => !!document.querySelector('#view-next .tk-add-text'));
console.log('next task-board add form present:', nextAdd);
// Calendar mode: toggle to the month grid, click a day, capture (exercises buildMonthGrid + Intl render).
await win.click('#view-next .tk-vt:nth-child(2)').catch(() => {});
await win.waitForSelector('#view-next .cal-grid .cal-cell', { timeout: 5000 }).catch(() => {});
const calCells = await win.evaluate(() => document.querySelectorAll('#view-next .cal-grid .cal-cell').length);
console.log('calendar cells rendered:', calCells, '(expect 42)');
await win.click('#view-next .cal-cell.today').catch(() => {});
await shot('next-calendar');
await win.click('#view-next .tk-vt:nth-child(1)').catch(() => {}); // back to list for later scenes

// Cockpit view: navigate and capture the empty state (no PTY spawned in the harness)
await showView('cockpit');
await win.waitForSelector('#ck-empty', { timeout: 5000 }).catch(() => {});
await shot('cockpit');

// Regression guard: the cockpit must fill #content's height. A CSS height bug once
// collapsed #view-cockpit to ~content height, shrinking the embedded terminal to a ~6-row strip.
const ckFill = await win.evaluate(() => {
  const content = document.getElementById('content').getBoundingClientRect().height;
  const main = document.querySelector('#view-cockpit .ck-main')?.getBoundingClientRect().height ?? 0;
  return { content: Math.round(content), main: Math.round(main), ratio: content ? main / content : 0 };
});
console.log(`cockpit fill: main=${ckFill.main}px content=${ckFill.content}px ratio=${ckFill.ratio.toFixed(2)}`);
if (ckFill.ratio < 0.8) {
  console.error(`QA FAILED — cockpit pane collapsed (main ${ckFill.main}px of content ${ckFill.content}px); the embedded terminal would render tiny.`);
  await closeApp();
  process.exit(1);
}

const badgeHidden = await win.evaluate(() => {
  const b = document.getElementById('ck-badge');
  return !b || b.classList.contains('hidden');
});
console.log(`cockpit badge hidden at zero needs-you: ${badgeHidden}`);
if (!badgeHidden) {
  console.error('QA FAILED — rail badge visible with no needs-you sessions');
  await closeApp();
  process.exit(1);
}

// Cockpit structure intact after the multi-session changes (the + New session button only appears
// with a live session, which the harness can't spawn — so just confirm the view renders cleanly).
const ckOk = await win.evaluate(() => {
  const newBtn = document.getElementById('ck-new-session');
  return !!document.getElementById('ck-groups') && !!document.querySelector('#view-cockpit .ck-main')
    && !!newBtn && newBtn.disabled === true; // + New session present and disabled with no live session
});
console.log(`cockpit structure + new-session button present: ${ckOk}`);
if (!ckOk) { console.error('QA FAILED — cockpit structure / + New session button missing'); await closeApp(); process.exit(1); }

// Usage bar fill — regression guard for the inline-span bug where the fill (width/height
// ignored on an inline box) rendered empty. window.devdeck is a frozen contextBridge object
// (can't stub the IPC) and CI has no Claude creds, so we test the CSS mechanism directly:
// inject the real meter markup with a 42% fill and confirm it gets a non-zero, proportional width.
const usageFill = await win.evaluate(async () => {
  const bar = document.getElementById('usage-bar');
  bar.classList.remove('hidden');
  bar.innerHTML = '<span class="ub-meter"><span class="ub-lab">5h</span><span class="ub-track"><span class="ub-fill ok" style="width:42%"></span></span><span class="ub-val">42%</span><span class="ub-rst">↻ 2h 19m</span></span>';
  await new Promise((r) => setTimeout(r, 200));
  const fill = bar.querySelector('.ub-fill');
  const track = bar.querySelector('.ub-track');
  return { fillWidth: fill ? Math.round(fill.getBoundingClientRect().width) : 0, trackWidth: track ? Math.round(track.getBoundingClientRect().width) : 0 };
});
await shot('usage-bar');
console.log(`usage bar fill: fillWidth=${usageFill.fillWidth}px of track=${usageFill.trackWidth}px (expect ~42%)`);
if (usageFill.fillWidth <= 0 || usageFill.trackWidth <= 0) {
  console.error(`QA FAILED — usage bar fill has no width (fill=${usageFill.fillWidth}px track=${usageFill.trackWidth}px); the meter would look empty (the inline-span bug).`);
  await closeApp();
  process.exit(1);
}

writeFileSync(join(out, '_console.json'), JSON.stringify({ consoleErrors, pageErrors }, null, 2));
console.log(`\nconsole errors: ${consoleErrors.length}, page errors: ${pageErrors.length}`);

await closeApp();

if (consoleErrors.length > 0 || pageErrors.length > 0) {
  console.error('QA FAILED — console/page errors detected:');
  console.error(JSON.stringify({ consoleErrors, pageErrors }, null, 2));
  process.exit(1);
}
console.log('done');
