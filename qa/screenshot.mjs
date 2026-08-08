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

// Deterministic local-history fixture. Real home-directory logs vary between machines, so the Usage
// page receives a representative combined report through its renderer QA seam.
const LOCAL_USAGE_REPORT = {
  global: { input: 1500, output: 500, cacheWrite: 100, cacheRead: 700 }, globalCost: 8.75,
  hasUnknownModel: true, webSearch: 2, webFetch: 1, sessions: 5, activeMs: 5400000,
  byModel: [
    { providerId: 'claude', model: 'claude-opus-4-1', totals: { input: 600, output: 200, cacheWrite: 100, cacheRead: 300 }, costEstimate: 3.25, hasUnknownPrice: false },
    { providerId: 'codex', model: 'gpt-5.6-sol', totals: { input: 800, output: 250, cacheWrite: 0, cacheRead: 350 }, costEstimate: 5.5, hasUnknownPrice: false },
    { providerId: 'codex', model: 'future-codex', totals: { input: 100, output: 50, cacheWrite: 0, cacheRead: 50 }, costEstimate: null, hasUnknownPrice: true },
  ],
  byProject: [
    { path: 'C:/qa/shared', name: 'shared-app', sessions: 2, totals: { input: 800, output: 250, cacheWrite: 50, cacheRead: 400 }, costEstimate: 4.5, hasUnknownModel: false, activeMs: 2400000, status: 'active', providerCosts: { claude: 1.5, codex: 3 } },
    { path: 'C:/qa/claude', name: 'claude-only', sessions: 1, totals: { input: 300, output: 100, cacheWrite: 50, cacheRead: 100 }, costEstimate: 1.75, hasUnknownModel: false, activeMs: 1200000, status: 'active', providerCosts: { claude: 1.75 } },
    { path: 'C:/qa/codex', name: 'codex-only', sessions: 2, totals: { input: 400, output: 150, cacheWrite: 0, cacheRead: 200 }, costEstimate: 2.5, hasUnknownModel: true, activeMs: 1800000, status: 'active', providerCosts: { codex: 2.5 } },
  ],
  daily: [
    { day: '2026-08-07', tokens: 900, cost: 3.25, providerTokens: { claude: 400, codex: 500 }, providerCosts: { claude: 1.25, codex: 2 } },
    { day: '2026-08-08', tokens: 1100, cost: 5.5, providerTokens: { claude: 400, codex: 700 }, providerCosts: { claude: 2, codex: 3.5 } },
  ],
  byProvider: [
    { providerId: 'claude', state: 'ready', global: { input: 600, output: 200, cacheWrite: 100, cacheRead: 300 }, globalCost: 3.25, hasUnknownModel: false, webSearch: 2, webFetch: 1, sessions: 2, activeMs: 2100000,
      byModel: [{ providerId: 'claude', model: 'claude-opus-4-1', totals: { input: 600, output: 200, cacheWrite: 100, cacheRead: 300 }, costEstimate: 3.25, hasUnknownPrice: false }],
      byProject: [
        { path: 'C:/qa/shared', name: 'shared-app', sessions: 1, totals: { input: 300, output: 100, cacheWrite: 50, cacheRead: 200 }, costEstimate: 1.5, hasUnknownModel: false, activeMs: 900000, status: 'active', providerCosts: { claude: 1.5 } },
        { path: 'C:/qa/claude', name: 'claude-only', sessions: 1, totals: { input: 300, output: 100, cacheWrite: 50, cacheRead: 100 }, costEstimate: 1.75, hasUnknownModel: false, activeMs: 1200000, status: 'active', providerCosts: { claude: 1.75 } },
      ], daily: [{ day: '2026-08-08', tokens: 800, cost: 3.25, providerTokens: { claude: 800 }, providerCosts: { claude: 3.25 } }] },
    { providerId: 'codex', state: 'ready', global: { input: 900, output: 300, cacheWrite: 0, cacheRead: 400 }, globalCost: 5.5, hasUnknownModel: true, webSearch: 0, webFetch: 0, sessions: 3, activeMs: 3300000,
      byModel: [
        { providerId: 'codex', model: 'gpt-5.6-sol', totals: { input: 800, output: 250, cacheWrite: 0, cacheRead: 350 }, costEstimate: 5.5, hasUnknownPrice: false },
        { providerId: 'codex', model: 'future-codex', totals: { input: 100, output: 50, cacheWrite: 0, cacheRead: 50 }, costEstimate: null, hasUnknownPrice: true },
      ], byProject: [
        { path: 'C:/qa/shared', name: 'shared-app', sessions: 1, totals: { input: 500, output: 150, cacheWrite: 0, cacheRead: 200 }, costEstimate: 3, hasUnknownModel: false, activeMs: 1500000, status: 'active', providerCosts: { codex: 3 } },
        { path: 'C:/qa/codex', name: 'codex-only', sessions: 2, totals: { input: 400, output: 150, cacheWrite: 0, cacheRead: 200 }, costEstimate: 2.5, hasUnknownModel: true, activeMs: 1800000, status: 'active', providerCosts: { codex: 2.5 } },
      ], daily: [{ day: '2026-08-08', tokens: 1200, cost: 5.5, providerTokens: { codex: 1200 }, providerCosts: { codex: 5.5 } }] },
  ],
};
async function injectLocalUsage() {
  await win.evaluate((report) => document.dispatchEvent(new CustomEvent('devdeck:local-usage-report', { detail: report })), LOCAL_USAGE_REPORT);
  await win.waitForTimeout(150);
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
  await injectLocalUsage();
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

// The three headline cards stay visible while keyboard filtering changes only the detail region.
await showView('usage');
await injectLocalUsage();
const usageAll = await win.evaluate(() => ({
  cards: document.querySelectorAll('.usage-cost-card').length,
  values: Array.from(document.querySelectorAll('.usage-cost-card b')).map((e) => e.textContent),
  rows: Array.from(document.querySelectorAll('.usage-table td:first-child')).map((e) => e.textContent),
  logosLoaded: Array.from(document.querySelectorAll('#view-usage .ck-provider-logo')).every((i) => i.complete && i.naturalWidth > 0),
  overflow: document.querySelector('#view-usage').scrollWidth > document.querySelector('#view-usage').clientWidth + 1,
}));
await win.locator('.usage-provider-filter button').nth(2).focus();
await win.keyboard.press('Enter');
await win.waitForTimeout(150);
const usageCodex = await win.evaluate(() => ({
  cards: document.querySelectorAll('.usage-cost-card').length,
  rows: Array.from(document.querySelectorAll('.usage-table td:first-child')).map((e) => e.textContent),
  selected: document.querySelector('.usage-provider-filter button:nth-child(3)')?.getAttribute('aria-pressed'),
}));
console.log('local usage analytics:', JSON.stringify({ usageAll, usageCodex }));
if (usageAll.cards !== 3 || usageAll.values.join() !== '~$8.75,~$3.25,~$5.50' || !usageAll.logosLoaded || usageAll.overflow
  || usageCodex.cards !== 3 || usageCodex.selected !== 'true' || usageCodex.rows.some((name) => name.includes('claude-only')) || !usageCodex.rows.some((name) => name.includes('codex-only'))) {
  console.error('QA FAILED — combined local usage cards/provider filtering/geometry regressed.');
  await closeApp(); process.exit(1);
}
await shot('usage-combined-provider-costs');

// Extra states on Projects (current language) — expanded sessions + neglected filter
await showView('projects');
const expanded = await win.evaluate(() => {
  const head = document.querySelector('.sessions-head .caret');
  if (head) { head.parentElement.click(); return true; }
  return false;
});
if (expanded) await shot('projects-session-expanded');
// Neglected filter is now the deck-pulse 🔴 segment (renders after the cost/pulse loads).
await win.waitForSelector('.deck-pulse .p-neglect', { timeout: 8000 }).catch(() => {});
await win.click('.deck-pulse .p-neglect').catch(() => {});
await shot('projects-neglected-filter');
await win.click('.deck-pulse .p-neglect').catch(() => {});

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

// Next task board: seed one isolated-profile task so the provider-aware split Open control is rendered.
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
}, root);
await win.evaluate(async () => window.devdeck.pickFolder());
await win.evaluate(async (p) => window.devdeck.addFolder(p), root);
const taskSeeded = await win.evaluate(async () => {
  const project = (await window.devdeck.listProjects())[0];
  if (!project) return false;
  await window.devdeck.setTodos(project.path, [{
    id: 'qa-provider-open', text: 'Provider open QA', done: false, due: null,
    createdAt: new Date().toISOString(),
  }]);
  return true;
});
await showView('next');
await win.waitForSelector('#view-next .provider-open, #view-next .empty', { timeout: 5000 }).catch(() => {});
await shot('next-tasks');
const nextAdd = await win.evaluate(() => !!document.querySelector('#view-next .tk-add-text'));
console.log('next task-board add form present:', nextAdd);
if (!taskSeeded) {
  console.error('QA FAILED — no project was available to seed the provider-open task.');
  await closeApp(); process.exit(1);
}
await win.click('#view-next .provider-open-menu-button');
await win.waitForSelector('#view-next .provider-open-menu:not(.hidden)', { timeout: 3000 });
await shot('next-provider-open-menu');
const providerOpenGeo = await win.evaluate(() => {
  const row = document.querySelector('#view-next .tk-row')?.getBoundingClientRect();
  const control = document.querySelector('#view-next .provider-open')?.getBoundingClientRect();
  const menu = document.querySelector('#view-next .provider-open-menu:not(.hidden)')?.getBoundingClientRect();
  return {
    present: !!row && !!control && !!menu,
    controlInRow: !!row && !!control && control.left >= row.left && control.right <= row.right,
    menuInViewport: !!menu && menu.left >= 0 && menu.right <= innerWidth && menu.top >= 0 && menu.bottom <= innerHeight,
  };
});
console.log('provider open geometry:', JSON.stringify(providerOpenGeo));
if (!providerOpenGeo.present || !providerOpenGeo.controlInRow || !providerOpenGeo.menuInViewport) {
  console.error('QA FAILED — provider Open control or menu escaped its row/viewport.');
  await closeApp(); process.exit(1);
}
await win.keyboard.press('Escape');
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

// Provider marks + two-line names: the sidebar must stay 250px, a very long ASCII name and an
// unbroken CJK name must clamp at two lines (never widen the sidebar or spill), and the hover-only
// row actions must reserve no width while hidden. The harness can't spawn a live PTY session, so
// inject representative row markup and measure the real CSS.
const sidebar = await win.evaluate(async () => {
  const groups = document.getElementById('ck-groups');
  const long = 'devdeck-monorepo-frontend-experimental-feature-branch-session-42-x';
  const cjk = '데브덱코크핏세션이름아주아주긴한글이름테스트용으로만든것';
  // Line 3 (.sm) is the auto summary — deliberately longer than the sidebar so the clamp is exercised.
  const summary = 'cockpitView.ts에 세션 요약 줄을 붙이고 CSS와 i18n을 정리하는 중';
  const rowHtml = (name, logo) => `<div class="ck-row act-idle">
    <span class="ck-ind"><span class="ck-dot"></span></span>
    <img class="ck-provider-logo" src="./assets/provider-${logo}.svg" alt="${logo}">
    <div class="ck-row-main"><div class="ck-line1"><span class="nm" tabindex="0" aria-label="${name}" data-full-name="${name}">${name}</span><span class="ck-ctx-col">🧠41%</span></div><div class="mt">main · Opus</div><div class="sm" title="${summary}">${summary}</div></div>
    <span class="ck-row-acts"><button class="ck-pin">📌</button><button class="ck-rename">✎</button><button class="ck-close">✕</button></span></div>`;
  groups.innerHTML = rowHtml(long, 'claude') + rowHtml(cjk, 'codex')
    // A restorable entry whose conversation is gone: its meta line warns in the accent colour, since
    // restoring it opens a FRESH session under the same name.
    + `<div class="ck-row ck-row-prev"><span class="ck-ind"><span class="ck-dot"></span></span><img class="ck-provider-logo" src="./assets/provider-antigravity.svg" alt="antigravity"><div class="ck-row-main"><div class="nm" tabindex="0" aria-label="${long}" data-full-name="${long}">${long}</div><div class="mt gone">⚠ conversation gone</div></div><span class="ck-prev-acts"><button class="ck-pin">📌</button><button class="ck-forget">✕</button></span></div>`;
  await new Promise((r) => setTimeout(r, 250));
  const list = document.querySelector('#view-cockpit .ck-list').getBoundingClientRect();
  const names = [...document.querySelectorAll('#ck-groups .nm')];
  const lh = parseFloat(getComputedStyle(names[0]).lineHeight);
  const logos = document.querySelectorAll('#ck-groups .ck-provider-logo');
  const loaded = [...logos].every((i) => i.complete && i.naturalWidth > 0);
  const sums = [...document.querySelectorAll('#ck-groups .sm')];
  const sumLh = sums.length ? parseFloat(getComputedStyle(sums[0]).lineHeight) || 16 : 0;
  return {
    sidebarWidth: Math.round(list.width),
    twoLines: names.every((n) => n.getBoundingClientRect().height <= lh * 2 + 1),
    inside: names.every((n) => n.getBoundingClientRect().right <= list.right + 1),
    logos: logos.length,
    loaded,
    actsHidden: getComputedStyle(document.querySelector('#ck-groups .ck-row-acts')).opacity === '0',
    // The summary line must stay ONE clipped line inside the sidebar — it is long by construction here.
    summaries: sums.length,
    summaryOneLine: sums.every((s) => s.getBoundingClientRect().height <= sumLh + 1),
    summaryInside: sums.every((s) => s.getBoundingClientRect().right <= list.right + 1),
    summaryClipped: sums.every((s) => s.scrollWidth > s.clientWidth), // actually overflowing → ellipsis in play
    rowHeight: Math.round(document.querySelector('#ck-groups .ck-row').getBoundingClientRect().height),
    // The gone warning must be visually distinct from the ordinary dim "Restore" line AND stay inside
    // the sidebar — a warning that reads like normal metadata is one the user scrolls past.
    goneTinted: (() => {
      const g = document.querySelector('#ck-groups .ck-row-prev .mt.gone');
      const plain = document.querySelector('#ck-groups .ck-row:not(.ck-row-prev) .mt');
      return !!g && getComputedStyle(g).color !== getComputedStyle(plain).color;
    })(),
    goneInside: (() => {
      const g = document.querySelector('#ck-groups .ck-row-prev .mt.gone');
      return !!g && g.getBoundingClientRect().right <= list.right + 1;
    })(),
  };
});
await shot('cockpit-provider-sidebar');
console.log(`cockpit sidebar: width=${sidebar.sidebarWidth}px twoLines=${sidebar.twoLines} inside=${sidebar.inside} logos=${sidebar.logos} svgLoaded=${sidebar.loaded} actionsHiddenByDefault=${sidebar.actsHidden}`);
console.log(`cockpit summary line: rows=${sidebar.summaries} oneLine=${sidebar.summaryOneLine} inside=${sidebar.summaryInside} clipped=${sidebar.summaryClipped} rowHeight=${sidebar.rowHeight}px`);
if (sidebar.sidebarWidth !== 250 || !sidebar.twoLines || !sidebar.inside || sidebar.logos !== 3 || !sidebar.loaded || !sidebar.actsHidden) {
  console.error('QA FAILED — cockpit sidebar geometry / provider marks regressed (expect 250px, 2-line clamp, contained names, 3 loaded SVG marks, hidden row actions).');
  await closeApp();
  process.exit(1);
}
if (sidebar.summaries !== 2 || !sidebar.summaryOneLine || !sidebar.summaryInside || !sidebar.summaryClipped) {
  console.error('QA FAILED — session summary line regressed (expect one clipped line per live row, contained in the 250px sidebar).');
  await closeApp();
  process.exit(1);
}
console.log(`cockpit gone marker: tinted=${sidebar.goneTinted} inside=${sidebar.goneInside}`);
if (!sidebar.goneTinted || !sidebar.goneInside) {
  console.error('QA FAILED — the "conversation gone" warning on a restorable row is not visually distinct or overflows the sidebar.');
  await closeApp();
  process.exit(1);
}
// The full-name tooltip must be reachable by KEYBOARD, not only pointer.
const tooltip = await win.evaluate(async () => {
  const nm = document.querySelector('#ck-groups .nm');
  nm.focus();
  await new Promise((r) => setTimeout(r, 150));
  return { focused: document.activeElement === nm, hasFullName: !!nm.dataset.fullName, labelled: nm.getAttribute('aria-label') === nm.dataset.fullName };
});
await shot('cockpit-provider-tooltip');
console.log(`cockpit name help: keyboardFocusable=${tooltip.focused} fullName=${tooltip.hasFullName} ariaLabel=${tooltip.labelled}`);
if (!tooltip.focused || !tooltip.hasFullName) {
  console.error('QA FAILED — the complete session name is not reachable by keyboard.');
  await closeApp();
  process.exit(1);
}
await win.evaluate(() => { document.getElementById('ck-groups').innerHTML = ''; });

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

// All-provider usage dialog. window.devdeck is a frozen contextBridge object and CI has no provider
// credentials, so the deterministic snapshot is delivered through the documented open event. The key
// guarantee under test: opening/closing the overlay changes NO other geometry (the cockpit terminal
// must never resize), and the dialog is fully keyboard-operable.
const SNAPSHOT = {
  fetchedAt: Date.now(),
  providers: [
    { providerId: 'claude', state: 'ready', planLabel: 'Max 20x', credits: { hasCredits: true, balance: 12.5, spent: 3.25, currency: 'USD' }, guidance: null, fetchedAt: Date.now(), limits: [
      { id: 'claude:session', kind: 'session', label: 'usage.limit_session', percent: 42, resetAt: Date.now() + 2 * 3600_000, modelLabel: null },
      { id: 'claude:weekly', kind: 'weekly', label: 'usage.limit_weekly', percent: 76, resetAt: Date.now() + 3 * 86400_000, modelLabel: null },
      { id: 'claude:seven_day:fable-5', kind: 'model-weekly', label: 'usage.limit_model_weekly', percent: 91, resetAt: Date.now() + 3 * 86400_000, modelLabel: 'Fable 5' },
    ] },
    { providerId: 'codex', state: 'stale', planLabel: 'plus', credits: null, guidance: null, fetchedAt: Date.now(), staleSince: Date.now() - 8 * 60_000, limits: [
      { id: 'codex:primary', kind: 'primary', label: 'usage.limit_primary', percent: 18, resetAt: Date.now() + 5 * 3600_000, modelLabel: null },
      { id: 'codex:secondary', kind: 'secondary', label: 'usage.limit_secondary', percent: 4, resetAt: null, modelLabel: null },
    ] },
    { providerId: 'antigravity', state: 'unsupported', planLabel: null, credits: null, fetchedAt: Date.now(), limits: [], guidance: { commands: ['/usage', '/quota', '/credits'] } },
  ],
};

// Footer, rendered through its REAL path from the same snapshot: Claude has two independent windows
// (5h + weekly) and both must be on the row — showing only the higher one hid the 5h limit entirely.
// The model-scoped quota is warn+ here, so it earns the third slot; Codex shows its own two windows.
const footer = await win.evaluate(async (snapshot) => {
  const read = async (providerId) => {
    document.dispatchEvent(new CustomEvent('devdeck:usage-snapshot', { detail: { snapshot } }));
    document.dispatchEvent(new CustomEvent('devdeck:usage-active-provider', { detail: { providerId } }));
    await new Promise((r) => setTimeout(r, 150));
    const bar = document.getElementById('usage-bar');
    return {
      labels: Array.from(bar.querySelectorAll('.ub-limit .ub-lab')).map((e) => e.textContent),
      values: Array.from(bar.querySelectorAll('.ub-limit .ub-val')).map((e) => e.textContent),
      // Clipping is the designed degradation for a narrow window (the dialog has the full list), so
      // this is reported, not enforced; the 26px height is what must never move.
      clipped: (() => { const s = bar.querySelector('.ub-summary'); return !!s && s.scrollWidth > s.clientWidth + 1; })(),
      height: Math.round(bar.getBoundingClientRect().height),
    };
  };
  const claude = await read('claude');
  const codex = await read('codex');
  const antigravity = await read('antigravity');
  document.dispatchEvent(new CustomEvent('devdeck:usage-active-provider', { detail: { providerId: null } }));
  return { claude, codex, antigravity };
}, SNAPSHOT);
console.log(`usage footer: claude=${JSON.stringify(footer.claude.values)} codex=${JSON.stringify(footer.codex.values)} antigravity=${footer.antigravity.values.length} clipped=${footer.claude.clipped} height=${footer.claude.height}`);
if (footer.claude.values.join() !== '42%,76%,91%' || footer.codex.values.join() !== '18%,4%'
  || footer.antigravity.values.length !== 0 || footer.claude.height !== 26) {
  console.error(`QA FAILED — usage footer does not show every window of the reported provider: ${JSON.stringify(footer)}`);
  await closeApp();
  process.exit(1);
}

const geometry = () => win.evaluate(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  return { shell: r('#shell'), content: r('#content'), terms: r('.ck-terms'), xterm: r('.xterm'), footer: r('#usage-bar') };
});

await showView('cockpit');
const beforeGeo = await geometry();
const modal = await win.evaluate(async (snapshot) => {
  document.dispatchEvent(new CustomEvent('devdeck:usage-open', { detail: { snapshot } }));
  await new Promise((r) => setTimeout(r, 250));
  const dlg = document.querySelector('.usage-modal');
  return {
    open: !!dlg,
    role: dlg?.getAttribute('role'),
    modal: dlg?.getAttribute('aria-modal'),
    labelled: !!dlg?.getAttribute('aria-labelledby') && !!document.getElementById(dlg.getAttribute('aria-labelledby'))?.textContent?.trim(),
    closeLabelled: !!document.querySelector('.um-close')?.getAttribute('aria-label'),
    sections: document.querySelectorAll('.um-provider').length,
    limits: document.querySelectorAll('.um-limit').length,
    commands: document.querySelectorAll('.um-cmd').length,
    focusOnClose: document.activeElement?.classList.contains('um-close'),
  };
}, SNAPSHOT);
await shot('all-provider-usage');
const openGeo = await geometry();
console.log(`usage modal: open=${modal.open} role=${modal.role} ariaModal=${modal.modal} labelled=${modal.labelled} closeLabelled=${modal.closeLabelled} sections=${modal.sections} limits=${modal.limits} copyCommands=${modal.commands} focusMoved=${modal.focusOnClose}`);
if (!modal.open || modal.role !== 'dialog' || modal.modal !== 'true' || !modal.labelled || !modal.closeLabelled || modal.sections !== 3 || modal.limits !== 5 || modal.commands !== 3 || !modal.focusOnClose) {
  console.error('QA FAILED — all-provider usage dialog structure/accessibility regressed.');
  await closeApp();
  process.exit(1);
}

// Keyboard: Tab wraps inside the dialog, Escape closes it, and focus returns to the page.
const keyboard = await win.evaluate(async () => {
  const dlg = document.querySelector('.usage-modal');
  const buttons = Array.from(dlg.querySelectorAll('button:not([disabled])'));
  buttons[buttons.length - 1].focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  const wrappedForward = document.activeElement === buttons[0];
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  const wrappedBack = document.activeElement === buttons[buttons.length - 1];
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return { wrappedForward, wrappedBack, closed: !document.querySelector('.usage-modal') };
});
const afterGeo = await geometry();
console.log(`usage modal keyboard: tabWrap=${keyboard.wrappedForward} shiftTabWrap=${keyboard.wrappedBack} escapeCloses=${keyboard.closed}`);
if (!keyboard.wrappedForward || !keyboard.wrappedBack || !keyboard.closed) {
  console.error('QA FAILED — usage dialog is not fully keyboard-operable (Tab wrap / Escape).');
  await closeApp();
  process.exit(1);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log(`usage modal geometry: unchangedWhileOpen=${same(beforeGeo, openGeo)} unchangedAfterClose=${same(beforeGeo, afterGeo)} footerHeight=${beforeGeo.footer ? beforeGeo.footer[3] : 'hidden'}`);
if (!same(beforeGeo, openGeo) || !same(beforeGeo, afterGeo)) {
  console.error(`QA FAILED — opening the usage dialog changed layout geometry (a terminal resize storm). before=${JSON.stringify(beforeGeo)} open=${JSON.stringify(openGeo)} after=${JSON.stringify(afterGeo)}`);
  await closeApp();
  process.exit(1);
}
if (beforeGeo.footer && beforeGeo.footer[3] !== 26) {
  console.error(`QA FAILED — usage footer must stay 26px (got ${beforeGeo.footer[3]}px); it would steal terminal height.`);
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
