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

// Isolated user-data-dir so the single-instance lock never makes this launch quit. Seed three legacy
// previous sessions: two id-less siblings exercise identity migration, while the fake named id gives
// the real missing-conversation check a deterministic warning row.
const qaUserData = mkdtempSync(join(tmpdir(), 'devdeck-qa-'));
writeFileSync(join(qaUserData, 'state.json'), JSON.stringify({
  projects: {},
  settings: {
    folders: [{ path: root, kind: 'repo' }],
    viewMode: 'list',
    cockpitSessions: [
      { projectPath: root, name: 'devdeck', sessionId: null, agentId: 'claude', label: 'Legacy id-less A' },
      { projectPath: root, name: 'devdeck', sessionId: null, agentId: 'claude', label: 'Legacy id-less B' },
      { projectPath: root, name: 'devdeck', sessionId: 'qa-conversation-is-gone', agentId: 'claude', label: 'Missing conversation' },
    ],
  },
}, null, 2));
const app = await electron.launch({
  args: ['.', `--user-data-dir=${qaUserData}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
});
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
win.on('pageerror', (e) => pageErrors.push(String(e)));

// Keep project-card costs deterministic. A live Codex/Claude session in this checkout can accrue
// usage while the harness is running, which legitimately changes the card signature and makes the
// "unchanged card is reconciled in place" assertion test moving external data instead.
await app.evaluate(({ ipcMain }, projectPath) => {
  ipcMain.removeHandler('usage:report');
  ipcMain.handle('usage:report', () => ({
    global: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, globalCost: 4.5,
    hasUnknownModel: false, webSearch: 0, webFetch: 0, sessions: 1, activeMs: 0,
    byModel: [],
    byProject: [{
      path: projectPath, name: 'devdeck', sessions: 1,
      totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      costEstimate: 4.5, hasUnknownModel: false, activeMs: 0, status: 'active', providerCosts: {},
    }],
    daily: [], byProvider: [],
  }));
}, root);

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
async function showCockpitViaSession() {
  const session = win.locator('#shell-session-groups .shell-session').first();
  if (!await session.isVisible().catch(() => false)) return false;
  await session.click();
  await win.waitForTimeout(300);
  return true;
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
const cockpitAvailable = await win.evaluate(() => !document.getElementById('shell-session-section')?.classList.contains('hidden'));

// The internal Cockpit route must never regain a user-facing rail destination, including on platforms
// where embedded PTYs are unavailable.
const cockpitDestinationCount = await win.locator('.rail-item[data-view="cockpit"]').count();
if (cockpitDestinationCount !== 0) {
  console.error(`QA FAILED — expected zero standalone Cockpit destinations, found ${cockpitDestinationCount}`);
  await closeApp(); process.exit(1);
}

// The expanded command-center sidebar must not inherit the old 36px icon-rail geometry.
// A cascade-order regression makes localized labels spill vertically outside their buttons while
// the overall sidebar still has the expected width, so inspect each navigation item itself.
const shellNavGeometry = await win.evaluate(() => {
  const sidebar = document.getElementById('app-sidebar');
  const items = Array.from(document.querySelectorAll('#app-sidebar .rail-item'));
  return {
    present: !!sidebar && items.length >= 5,
    width: sidebar?.getBoundingClientRect().width ?? 0,
    overflow: items.some((item) => item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1),
  };
});
console.log('shell navigation geometry:', JSON.stringify(shellNavGeometry));
// The width is a user preference now, so this asserts the supported range rather than one constant —
// what must never happen is the rail inheriting the old 36px icon-rail geometry or clipping a label.
if (!shellNavGeometry.present || shellNavGeometry.width < 180 || shellNavGeometry.width > 460 || shellNavGeometry.overflow) {
  console.error('QA FAILED — expanded shell navigation is clipped:', JSON.stringify(shellNavGeometry));
  await closeApp(); process.exit(1);
}


const shellGeometry = await win.evaluate(() => {
  const shell = document.getElementById('shell')?.getBoundingClientRect();
  const sidebar = document.getElementById('app-sidebar')?.getBoundingClientRect();
  const content = document.getElementById('content')?.getBoundingClientRect();
  return {
    present: !!shell && !!sidebar && !!content,
    contained: !!shell && !!sidebar && !!content && sidebar.left >= shell.left && content.right <= shell.right,
    overlap: !!sidebar && !!content && sidebar.right > content.left + 1,
  };
});
if (!shellGeometry.present || !shellGeometry.contained || shellGeometry.overlap) {
  console.error('QA FAILED — shared shell geometry is invalid:', JSON.stringify(shellGeometry));
  await closeApp(); process.exit(1);
}

// Previous-session management must live in the shared shell before the hidden compatibility list.
// Exercise real persisted entries and the real Cockpit pin/forget handlers (no DOM-only mock).
if (cockpitAvailable) {
  await win.waitForSelector('.shell-session-wrap[data-previous="true"]', { timeout: 10000 }).catch(() => {});
  await win.waitForFunction(() => !!document.querySelector('.shell-session-wrap[data-conversation-gone="true"]'), null, { timeout: 10000 }).catch(() => {});
  const previousShell = await win.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.shell-session-wrap[data-previous="true"]'));
    const keys = rows.map((wrap) => wrap.querySelector('.shell-session')?.getAttribute('data-shell-entity-key'));
    const warning = document.querySelector('.shell-session-wrap[data-conversation-gone="true"]');
    return {
      count: rows.length,
      uniqueKeys: new Set(keys).size,
      restoreAll: !!document.querySelector('#shell-restore-all:not(.hidden)'),
      restoreCopy: rows.every((wrap) => !!wrap.querySelector('.shell-session small')?.textContent?.trim()),
      warningVisible: !!warning?.querySelector('.shell-session-warning'),
      menus: rows.every((wrap) => wrap.querySelector('.shell-session-actions')?.getAttribute('aria-haspopup') === 'menu'),
    };
  });
  if (previousShell.count !== 3 || previousShell.uniqueKeys !== 3 || !previousShell.restoreAll || !previousShell.restoreCopy || !previousShell.warningVisible || !previousShell.menus) {
    console.error('QA FAILED — shared-shell previous-session controls are incomplete:', JSON.stringify(previousShell));
    await closeApp(); process.exit(1);
  }

  const firstPrevious = win.locator('.shell-session-wrap[data-previous="true"]').first();
  const firstKey = await firstPrevious.locator('.shell-session').getAttribute('data-shell-entity-key');
  await firstPrevious.locator('.shell-session-actions').focus();
  await win.keyboard.press('Enter');
  await firstPrevious.locator('[data-session-action="pin"]').press('Enter');
  await win.waitForTimeout(150);
  const pinPersisted = await win.evaluate(async (key) => {
    const tileId = decodeURIComponent(String(key).replace(/^session:tile:/, ''));
    return (await window.devdeck.cockpit.loadSessions()).some((entry) => entry.tileId === tileId && entry.pinned === true);
  }, firstKey);

  const forgetTarget = win.locator('.shell-session-wrap[data-previous="true"]').filter({ hasText: 'Legacy id-less B' });
  const beforeForget = await win.locator('.shell-session-wrap[data-previous="true"]').count();
  await forgetTarget.locator('.shell-session-actions').click();
  await forgetTarget.locator('[data-session-action="forget"]').click();
  await win.waitForTimeout(150);
  const afterForget = await win.locator('.shell-session-wrap[data-previous="true"]').count();
  if (!pinPersisted || afterForget !== beforeForget - 1) {
    console.error('QA FAILED — shared-shell pin/forget did not route through Cockpit handlers:', JSON.stringify({ pinPersisted, beforeForget, afterForget }));
    await closeApp(); process.exit(1);
  }
}

// Quick Open must be operable from the keyboard alone (Enter once only ever fired the FIRST result),
// and a filtered rail must not leave section headings or "Restore all" hanging over an empty list.
const quickOpen = await win.evaluate(async () => {
  const input = document.getElementById('shell-quick-open');
  const host = document.getElementById('shell-quick-results');
  const type = async (value) => {
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  };
  const key = async (k) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 80));
  };
  await type('e'); // broad enough to match several sessions AND the project, in every locale
  const results = () => Array.from(host.querySelectorAll('.shell-quick-result'));
  const activeIndex = () => results().findIndex((item) => item.classList.contains('active'));
  const matched = results().length; // captured while the query is live — the field is cleared below
  const initial = activeIndex();
  await key('ArrowDown');
  const afterDown = activeIndex();
  await key('ArrowUp');
  const afterUp = activeIndex();
  const listbox = host.getAttribute('role') === 'listbox'
    && input.getAttribute('aria-expanded') === 'true'
    && !!input.getAttribute('aria-activedescendant')
    && results().every((item) => item.getAttribute('role') === 'option');
  await type('zzz-definitely-no-match');
  const empty = {
    message: !!host.querySelector('.shell-quick-empty')?.textContent?.trim(),
    sectionsHidden: (document.getElementById('shell-session-section')?.getClientRects().length ?? 0) === 0
      && (document.getElementById('shell-project-section')?.getClientRects().length ?? 0) === 0,
    restoreAllHidden: (document.getElementById('shell-restore-all')?.getClientRects().length ?? 0) === 0,
  };
  await type('');
  return { matched, initial, afterDown, afterUp, listbox, empty, restored: (document.getElementById('shell-project-section')?.getClientRects().length ?? 0) > 0 };
});
console.log('quick open:', JSON.stringify(quickOpen));
const arrowsOk = quickOpen.matched >= 2 && quickOpen.initial === 0 && quickOpen.afterDown === 1 && quickOpen.afterUp === 0;
if (!arrowsOk || !quickOpen.listbox
  || !quickOpen.empty.message || !quickOpen.empty.sectionsHidden || !quickOpen.empty.restoreAllHidden || !quickOpen.restored) {
  console.error('QA FAILED — Quick Open is not keyboard-navigable or leaves stale sections behind:', JSON.stringify(quickOpen));
  await closeApp(); process.exit(1);
}

// Search had to be reached with the mouse, and from inside a terminal there was no way to it at all.
// Ctrl+Shift+P works anywhere and re-opens a collapsed rail on the way (the chord is swallowed before
// the PTY sees it, so it can't reach the agent as a stray Ctrl+P).
await win.click('#shell-collapse');
await win.waitForTimeout(180);
await win.keyboard.press('Control+Shift+P');
await win.waitForTimeout(220);
const chord = await win.evaluate(() => ({
  focused: document.activeElement === document.getElementById('shell-quick-open'),
  reExpanded: document.getElementById('app-sidebar')?.classList.contains('collapsed') === false,
  hinted: document.getElementById('shell-quick-open')?.placeholder?.includes('Ctrl+Shift+P') === true,
}));
console.log('quick open chord:', JSON.stringify(chord));
if (!chord.focused || !chord.reExpanded || !chord.hinted) {
  console.error('QA FAILED — Ctrl+Shift+P does not reach Quick Open:', JSON.stringify(chord));
  await closeApp(); process.exit(1);
}

// The language control was the bare glyph 文 — only legible to someone who already reads CJK, and it
// never said which language was active. It must now be an icon plus the ACTIVE language's own name.
const langControl = await win.evaluate(() => {
  const button = document.getElementById('lang-btn');
  const endonyms = { ko: '한국어', en: 'English', ja: '日本語', zh: '中文' };
  return {
    hasIcon: !!button?.querySelector('svg'),
    showsEndonym: button?.querySelector('.rail-label')?.textContent === endonyms[document.documentElement.lang],
    labelled: (button?.getAttribute('aria-label')?.length ?? 0) > 0,
    // The old markup was a lone <span aria-hidden>文</span>. Scoped to the button's own children —
    // the language MENU legitimately lists 中文, which contains the same character.
    noBareGlyph: !Array.from(button?.querySelectorAll('*') ?? []).some((el) => el.textContent?.trim() === '文'),
  };
});
console.log('language control:', JSON.stringify(langControl));
if (!langControl.hasIcon || !langControl.showsEndonym || !langControl.labelled || !langControl.noBareGlyph) {
  console.error('QA FAILED — the language control is not self-explanatory:', JSON.stringify(langControl));
  await closeApp(); process.exit(1);
}

// Its menu opened OUTSIDE a rail that clips its overflow, so the popup was invisible and focusing its
// first item scrolled that clipped box sideways — the whole sidebar slid across. A click-through check
// cannot see this (a clipped element still has a box and is still clickable), so measure containment
// against the rail and confirm the rail never scrolls.
await win.click('#lang-btn');
await win.waitForTimeout(220);
const langMenu = await win.evaluate(() => {
  const rail = document.getElementById('app-sidebar').getBoundingClientRect();
  const menu = document.querySelector('.lang-menu:not(.hidden)')?.getBoundingClientRect();
  const sidebar = document.getElementById('app-sidebar');
  return {
    open: !!menu,
    inside: !!menu && menu.left >= rail.left - 1 && menu.right <= rail.right + 1
      && menu.top >= 0 && menu.bottom <= innerHeight + 1,
    railNotScrolled: sidebar.scrollLeft === 0 && sidebar.scrollTop === 0,
    focusInMenu: document.activeElement?.closest('.lang-menu') != null,
  };
});
await win.keyboard.press('Escape');
console.log('language menu:', JSON.stringify(langMenu));
if (!langMenu.open || !langMenu.inside || !langMenu.railNotScrolled || !langMenu.focusInMenu) {
  console.error('QA FAILED — the language menu opens outside the rail or shifts it:', JSON.stringify(langMenu));
  await closeApp(); process.exit(1);
}

// The rail is user-sized: 224px could never fit "master ✎1 · Claude · Opus 4.8 · 35%". The handle has
// to survive the sidebar's own `overflow: hidden` (it lives outside the rail for that reason), take
// arrow keys, persist, and stay out of the way when the rail is folded.
const resize = await win.evaluate(async () => {
  const shell = document.getElementById('shell');
  const sidebar = document.getElementById('app-sidebar');
  const handle = document.getElementById('shell-resizer');
  const width = () => Math.round(sidebar.getBoundingClientRect().width);
  const key = (k, shift = false) => {
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
    return new Promise((r) => setTimeout(r, 120));
  };
  const start = width();
  const handleBox = handle.getBoundingClientRect();
  const shellBox = shell.getBoundingClientRect();
  await key('ArrowRight'); await key('ArrowRight');
  const wider = width();
  await key('ArrowLeft');
  const narrower = width();
  await key('End');
  const maxed = width();
  await key('Enter'); // reset to default
  const reset = width();
  const stored = localStorage.getItem('devdeck.shell.width');
  return {
    start, wider, narrower, maxed, reset, stored,
    grabbable: handleBox.width >= 5 && handleBox.left >= shellBox.left && handleBox.right <= shellBox.right,
    tracksRail: Math.abs(handleBox.left + handleBox.width / 2 - sidebar.getBoundingClientRect().right) <= 4,
    labelled: (handle.getAttribute('aria-label')?.length ?? 0) > 0 && handle.getAttribute('role') === 'separator',
    valued: handle.getAttribute('aria-valuenow') === String(width()),
  };
});
console.log('sidebar resize:', JSON.stringify(resize));
if (resize.wider <= resize.start || resize.narrower >= resize.wider || resize.maxed <= resize.narrower
  || resize.reset !== 300 || resize.stored !== "300"
  || !resize.grabbable || !resize.tracksRail || !resize.labelled || !resize.valued) {
  console.error('QA FAILED — the sidebar cannot be resized or the handle is unreachable:', JSON.stringify(resize));
  await closeApp(); process.exit(1);
}

// The title bar right above already shows the logo and "DevDeck"; a second wordmark in the rail read
// as a rendering mistake. And the chrome must be ONE colour — the title bar used to be a blue-black
// while everything beside it was neutral grey.
const chrome = await win.evaluate(() => {
  const rgb = (el) => getComputedStyle(el).backgroundColor;
  const neutral = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) <= 1; };
  const topbar = rgb(document.getElementById('topbar'));
  return {
    topbar, sidebar: rgb(document.getElementById('app-sidebar')),
    matches: topbar === rgb(document.getElementById('app-sidebar')),
    neutralTopbar: neutral(topbar),
    neutralCanvas: neutral(rgb(document.body)),
    singleWordmark: document.querySelectorAll('#app-sidebar .shell-side-brand').length === 0,
  };
});
console.log('chrome:', JSON.stringify(chrome));
if (!chrome.matches || !chrome.neutralTopbar || !chrome.neutralCanvas || !chrome.singleWordmark) {
  console.error('QA FAILED — the app chrome is tinted or duplicates the wordmark:', JSON.stringify(chrome));
  await closeApp(); process.exit(1);
}

// The project list is the other unbounded one (100+ repos here). Its header must carry the same
// foldable/counted treatment, and folding it must not take the session list with it.
const projectSection = await win.evaluate(async () => {
  const toggle = document.getElementById('shell-projects-toggle');
  const host = document.getElementById('shell-projects');
  const visible = () => (host?.getClientRects().length ?? 0) > 0;
  const before = { count: toggle?.querySelector('.shell-group-count')?.textContent, expanded: toggle?.getAttribute('aria-expanded'), visible: visible() };
  toggle?.click(); await new Promise((r) => setTimeout(r, 200));
  const folded = { count: toggle?.querySelector('.shell-group-count')?.textContent, expanded: toggle?.getAttribute('aria-expanded'), visible: visible() };
  toggle?.click(); await new Promise((r) => setTimeout(r, 200));
  return { before, folded, reopened: visible(), named: (toggle?.querySelector('.shell-group-name')?.textContent?.length ?? 0) > 0 };
});
console.log('project section:', JSON.stringify(projectSection));
if (!projectSection.before.visible || projectSection.before.expanded !== 'true' || !projectSection.named
  || projectSection.folded.visible || projectSection.folded.expanded !== 'false'
  || projectSection.folded.count !== projectSection.before.count || !projectSection.reopened) {
  console.error('QA FAILED — the project section header does not fold/count correctly:', JSON.stringify(projectSection));
  await closeApp(); process.exit(1);
}

await win.click('#shell-collapse');
await win.waitForTimeout(180);
const collapsedShell = await win.evaluate(() => {
  const sidebar = document.getElementById('app-sidebar');
  return {
    collapsed: sidebar?.classList.contains('collapsed') === true,
    width: Math.round(sidebar?.getBoundingClientRect().width ?? 0),
    labelsHidden: Array.from(document.querySelectorAll('#app-sidebar .rail-label')).every((label) => getComputedStyle(label).display === 'none'),
  };
});
await shot('shell-collapsed');
if (!collapsedShell.collapsed || collapsedShell.width !== 52 || !collapsedShell.labelsHidden) {
  console.error('QA FAILED — collapsed shell geometry is invalid:', JSON.stringify(collapsedShell));
  await closeApp(); process.exit(1);
}
await win.click('#shell-collapse');
await win.waitForTimeout(180);

const LANGS = ['ko', 'en', 'ja', 'zh'];
const RESTORE_LABELS = { ko: '복원', en: 'Restore', ja: '復元', zh: '恢复' };
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
await win.click('#project-display');
await win.click('#view-list').catch(() => {});
await win.waitForSelector('#cards.as-list .prow', { timeout: 5000 }).catch(() => {});
await shot('projects-list-view');
await win.click('#project-display');
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
  // Reported alongside the verdict so a failure says WHICH failure it was: a genuine wipe-and-rebuild,
  // or the deck having flipped back to list mode / not finished reloading inside the wait.
  return {
    total: before.length, survived,
    cardsNow: document.querySelectorAll('#cards .card').length,
    rowsNow: document.querySelectorAll('#cards .prow').length,
  };
});
console.log(`refresh reuse: ${reuse.survived}/${reuse.total} card nodes reused ${JSON.stringify(reuse)}`);
if (reuse.total > 0 && reuse.survived === 0) {
  console.error(`QA FAILED — deck refresh wiped all ${reuse.total} cards instead of reconciling in place`);
  await closeApp();
  process.exit(1);
}

// Narrow window to check responsive card grid. Switch language at desktop width first because the
// narrow shell deliberately hides its language trigger, then inspect the localized toolbar at 520px.
const displayMenuGeometry = [];
for (const target of LANGS) {
  if (await lang() !== target) {
    await win.setViewportSize({ width: 1000, height: 720 }).catch(() => {});
    await win.click('#lang-btn');
    await win.click(`.lang-menu .menu-item[data-lang="${target}"]`);
    await win.waitForTimeout(120);
  }
  await showView('projects');
  await win.click('#project-display');
  await win.click('#view-list');
  await win.waitForSelector('#cards.as-list .prow', { timeout: 10000 });
  await win.setViewportSize({ width: 520, height: 760 }).catch(() => {});
  await win.waitForTimeout(180); // wait for the sidebar's width transition before measuring content geometry
  await win.click('#project-display');
  const geometry = await win.evaluate((restoreLabel) => {
    const toolbar = document.querySelector('#view-projects .view-toolbar');
    const menu = document.getElementById('project-display-menu');
    const rect = menu?.getBoundingClientRect();
    const previousDetail = document.querySelector('.shell-session-wrap[data-previous="true"]:not([data-conversation-gone="true"]) .shell-session small');
    return {
      language: document.documentElement.lang,
      toolbarOverflow: !!toolbar && toolbar.scrollWidth > toolbar.clientWidth + 1,
      menuContained: !!rect && rect.left >= 0 && rect.right <= innerWidth + 1,
      menuOverflow: !!menu && menu.scrollWidth <= menu.clientWidth + 1,
      listOverflow: document.getElementById('view-projects').scrollWidth > document.getElementById('view-projects').clientWidth + 1,
      rowContained: Array.from(document.querySelectorAll('.prow')).every((row) => row.getBoundingClientRect().left >= 0 && row.getBoundingClientRect().right <= innerWidth + 1),
      stateVisible: document.querySelectorAll('.prow-state').length === document.querySelectorAll('.prow').length && Array.from(document.querySelectorAll('.prow-state')).every((state) => state.getClientRects().length > 0 && !!state.querySelector('.prow-state-text')?.textContent?.trim() && !!state.querySelector('.prow-state-shape')),
      openVisible: Array.from(document.querySelectorAll('.prow .provider-open-primary')).every((button) => button.getClientRects().length > 0 && !!button.querySelector('.provider-open-primary-text')?.textContent?.trim()),
      shellDetailLocalized: !!previousDetail?.textContent?.includes(restoreLabel),
    };
  }, RESTORE_LABELS[target]);
  displayMenuGeometry.push(geometry);
  await win.keyboard.press('Escape');
}
console.log('narrow Display menu geometry:', JSON.stringify(displayMenuGeometry));
if (displayMenuGeometry.some((entry) => entry.toolbarOverflow || !entry.menuContained || !entry.menuOverflow || entry.listOverflow || !entry.rowContained || !entry.stateVisible || !entry.openVisible || !entry.shellDetailLocalized)) {
  console.error('QA FAILED — narrow Display controls overflow:', JSON.stringify(displayMenuGeometry));
  await closeApp(); process.exit(1);
}
await win.click('#project-display');
await shot('projects-display-menu-narrow');
await win.keyboard.press('Escape');
await shot('projects-narrow');

// List-row columns must never render on top of each other. `.prow-git` / `.prow-sess` are nowrap and
// right-aligned, so a track narrower than their text spills LEFT over its neighbour instead of
// clipping — which once made the metadata unreadable at ordinary desktop widths.
const rowCollisions = [];
for (const width of [1280, 1360, 1440, 1600, 1920]) {
  await win.setViewportSize({ width, height: 820 }).catch(() => {});
  await win.waitForTimeout(220);
  rowCollisions.push(await win.evaluate((viewportWidth) => {
    const row = document.querySelector('#cards.as-list .prow');
    if (!row) return { width: viewportWidth, collisions: ['no-row'] };
    const cells = Array.from(row.children).filter((cell) => cell.getClientRects().length > 0)
      .map((cell) => ({ cls: cell.className.split(' ')[0], rect: cell.getBoundingClientRect() }));
    return {
      width: viewportWidth,
      collisions: cells.filter((cell, index) => index > 0 && cell.rect.left < cells[index - 1].rect.right - 1).map((cell) => cell.cls),
      rowOverflow: row.scrollWidth > row.clientWidth + 1,
    };
  }, width));
}
console.log('project list row columns:', JSON.stringify(rowCollisions));
if (rowCollisions.some((entry) => entry.collisions.length > 0 || entry.rowOverflow)) {
  console.error('QA FAILED — project list columns overlap:', JSON.stringify(rowCollisions));
  await closeApp(); process.exit(1);
}
await win.setViewportSize({ width: 520, height: 760 }).catch(() => {});
await win.waitForTimeout(200);

// At supported narrow widths, the shared session navigation remains reachable as an overlay drawer.
if (cockpitAvailable) {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: [
    { id: 'qa-mobile-attention', projectPath: 'C:/qa/mobile', label: 'Mobile session', detail: 'main · Claude', activity: 'attention', pinned: false },
  ] })));
  // A desktop fold is persisted, so `.collapsed` is normally still set when the window narrows and the
  // drawer opens. Reproduce that pairing — the collapsed-state hides must all be undone by the drawer.
  await win.evaluate(() => document.getElementById('app-sidebar')?.classList.add('collapsed'));
  const mobileTrigger = win.locator('#shell-mobile-toggle');
  await mobileTrigger.focus();
  await mobileTrigger.click();
  const mobileOpen = await win.evaluate(() => ({
    open: document.getElementById('app-sidebar')?.classList.contains('mobile-open') === true,
    expanded: document.getElementById('shell-mobile-toggle')?.getAttribute('aria-expanded') === 'true',
    count: document.getElementById('shell-mobile-toggle')?.textContent?.includes('1') === true,
    rowVisible: document.querySelector('.shell-session')?.getClientRects().length > 0,
    // `.collapsed` persists from the desktop fold and coexists with `.mobile-open`, so the drawer has
    // to undo every collapsed-state hide — the headers are what name and count each list.
    headingsVisible: Array.from(document.querySelectorAll('#app-sidebar .shell-group-heading'))
      .every((heading) => heading.getClientRects().length > 0),
    // The rail floats at this width; a resize handle pinned to a fixed x would land on the drawer's
    // own rows and eat their clicks.
    resizerHidden: (document.getElementById('shell-resizer')?.getClientRects().length ?? 0) === 0,
  }));
  await win.keyboard.press('Escape');
  const mobileEscaped = await mobileTrigger.evaluate((button) => document.activeElement === button && button.getAttribute('aria-expanded') === 'false');
  await mobileTrigger.click();
  await win.locator('.shell-session').first().click();
  const mobileSelected = await win.evaluate(() => ({
    closed: document.getElementById('app-sidebar')?.classList.contains('mobile-open') !== true,
    cockpit: document.getElementById('view-cockpit')?.classList.contains('active') === true,
  }));
  if (!mobileOpen.open || !mobileOpen.expanded || !mobileOpen.count || !mobileOpen.rowVisible || !mobileOpen.headingsVisible || !mobileOpen.resizerHidden || !mobileEscaped || !mobileSelected.closed || !mobileSelected.cockpit) {
    console.error('QA FAILED — narrow shared-session drawer is not keyboard/pointer reachable:', JSON.stringify({ mobileOpen, mobileEscaped, mobileSelected }));
    await closeApp(); process.exit(1);
  }
  // Undo the simulated desktop fold so the later wide-viewport scenes see the normal sidebar.
  await win.evaluate(() => document.getElementById('app-sidebar')?.classList.remove('collapsed'));
}

// Title bar: both accessible action states track the maximize state and current locale.
await win.setViewportSize({ width: 1000, height: 720 }).catch(() => {});
if (await win.evaluate(() => window.devdeck.windowControls.isMaximized())) await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
await win.waitForTimeout(250);
const maximizeBefore = await win.evaluate(() => ({ title: document.getElementById('win-max')?.title, aria: document.getElementById('win-max')?.getAttribute('aria-label') }));
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
await win.waitForTimeout(400);
const maximizeAfter = await win.evaluate(() => ({ title: document.getElementById('win-max')?.title, aria: document.getElementById('win-max')?.getAttribute('aria-label') }));
await shot('titlebar-maximized');
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
const maximizeLabels = {
  en: ['Maximize', 'Restore'], ko: ['최대화', '복원'], ja: ['最大化', '元に戻す'], zh: ['最大化', '还原'],
}[await lang()];
if (!maximizeLabels || maximizeBefore.title !== maximizeLabels[0] || maximizeBefore.aria !== maximizeBefore.title
  || maximizeAfter.title !== maximizeLabels[1] || maximizeAfter.aria !== maximizeAfter.title) {
  console.error('QA FAILED — maximize title/aria-label is stale:', JSON.stringify({ maximizeBefore, maximizeAfter, maximizeLabels }));
  await closeApp(); process.exit(1);
}

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

// Shell reconciliation must keep the exact focused project row through the real project refresh
// path. A replace-children implementation would detach the button and lose keyboard focus.
if (!taskSeeded) {
  console.error('QA FAILED — unable to seed a project for shell refresh reconciliation.');
  await closeApp(); process.exit(1);
}
await showView('projects');
await win.click('#refresh');
await win.waitForSelector('#shell-projects .shell-project', { timeout: 10000 });
const shellRefresh = await win.evaluate(async () => {
  const before = document.querySelector('#shell-projects .shell-project');
  before.focus();
  const key = before.dataset.shellEntityKey;
  document.getElementById('refresh').click();
  await new Promise((r) => setTimeout(r, 2500));
  const after = document.querySelector(`#shell-projects .shell-project[data-shell-entity-key="${CSS.escape(key)}"]`);
  return { sameNode: before === after, focused: document.activeElement === after };
});
console.log(`shell refresh reuse: sameNode=${shellRefresh.sameNode} focused=${shellRefresh.focused}`);
if (!shellRefresh.sameNode || !shellRefresh.focused) {
  console.error('QA FAILED — shell refresh replaced or defocused an unchanged project row.');
  await closeApp(); process.exit(1);
}

// Project Memory: the same real allowed checkout supplies recent commits and the seeded task. Capture
// both normal and narrow geometry, and fail if the modal itself overflows horizontally.
await showView('projects');
await win.waitForSelector('.project-memory-button', { timeout: 10000 });
await win.click('#project-display');
await win.click('#view-list');
await win.waitForSelector('#cards.as-list .prow', { timeout: 5000 });
const populatedProjectGeometry = await win.evaluate(() => {
  const view = document.getElementById('view-projects');
  const row = view?.querySelector('.prow')?.getBoundingClientRect();
  const content = document.getElementById('content')?.getBoundingClientRect();
  return {
    overflow: !!view && view.scrollWidth > view.clientWidth + 1,
    rowContained: !!row && !!content && row.left >= content.left - 1 && row.right <= content.right + 1,
  };
});
if (populatedProjectGeometry.overflow || !populatedProjectGeometry.rowContained) {
  console.error('QA FAILED — populated project row overflows the command-center content:', JSON.stringify(populatedProjectGeometry));
  await closeApp(); process.exit(1);
}
await shot('projects-populated');
const memoryTrigger = win.locator('.project-memory-button').first();
const contentBeforeMemory = await win.evaluate(() => {
  const r = document.getElementById('content').getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
});
await memoryTrigger.focus();
await memoryTrigger.click();
await win.waitForSelector('.pm-modal:not(.loading) .pm-timeline-item', { timeout: 10000 });
const memoryWide = await win.evaluate(() => {
  const modal = document.querySelector('.pm-modal');
  const r = modal?.getBoundingClientRect();
  const c = document.getElementById('content').getBoundingClientRect();
  return {
    surface: modal?.dataset.surface,
    rightAligned: !!r && Math.abs(r.right - window.innerWidth) <= 1,
    content: [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)],
  };
});
await shot('project-memory');
const memoryProviderButton = win.locator('.pm-modal .provider-open-menu-button');
await memoryProviderButton.focus();
await memoryProviderButton.click();
await win.waitForSelector('.pm-modal .provider-open-menu:not(.hidden)', { timeout: 3000 });
await win.keyboard.press('Escape');
const memoryEscapePriority = await win.evaluate(() => ({
  drawerOpen: !!document.querySelector('.pm-modal'),
  providerClosed: !!document.querySelector('.pm-modal .provider-open-menu.hidden'),
  focusReturned: document.activeElement?.classList.contains('provider-open-menu-button') === true,
}));
await memoryProviderButton.focus(); // last visible focusable after the provider popup is closed
await win.keyboard.press('Tab');
const memoryForwardWrap = await win.locator('.pm-refresh').evaluate((button) => document.activeElement === button);
await win.keyboard.press('Shift+Tab');
const memoryReverseWrap = await memoryProviderButton.evaluate((button) => document.activeElement === button);
await memoryProviderButton.click();
await win.waitForSelector('.pm-modal .provider-open-menu:not(.hidden)', { timeout: 3000 });
await win.keyboard.press('Escape');
const memoryStillOpenAfterInnerEscape = await win.locator('.pm-modal').count() === 1;
if (!memoryEscapePriority.drawerOpen || !memoryEscapePriority.providerClosed || !memoryEscapePriority.focusReturned
  || !memoryForwardWrap || !memoryReverseWrap || !memoryStillOpenAfterInnerEscape) {
  console.error('QA FAILED — Project Memory nested provider focus/Escape containment regressed:', JSON.stringify({ memoryEscapePriority, memoryForwardWrap, memoryReverseWrap, memoryStillOpenAfterInnerEscape }));
  await closeApp(); process.exit(1);
}
await win.setViewportSize({ width: 520, height: 760 }).catch(() => {});
await win.waitForTimeout(150);
const memoryGeometry = await win.evaluate(() => {
  const modal = document.querySelector('.pm-modal');
  return {
    present: !!modal,
    surface: modal?.dataset.surface,
    overflow: !!modal && modal.scrollWidth > modal.clientWidth + 1,
    fullWidth: !!modal && Math.abs(modal.getBoundingClientRect().width - window.innerWidth) <= 1,
    contained: !!modal && modal.getBoundingClientRect().left >= 0 && modal.getBoundingClientRect().right <= window.innerWidth + 1,
    events: document.querySelectorAll('.pm-timeline-item').length,
  };
});
await shot('project-memory-narrow');
if (memoryWide.surface !== 'drawer' || !memoryWide.rightAligned || JSON.stringify(memoryWide.content) !== JSON.stringify(contentBeforeMemory)
  || !memoryGeometry.present || memoryGeometry.surface !== 'sheet' || !memoryGeometry.fullWidth || !memoryGeometry.contained
  || memoryGeometry.overflow || memoryGeometry.events < 1) {
  console.error('QA FAILED — Project Memory drawer/sheet geometry regressed:', JSON.stringify({ memoryWide, memoryGeometry, contentBeforeMemory }));
  await closeApp(); process.exit(1);
}
await win.keyboard.press('Escape');
const memoryFocusReturned = await memoryTrigger.evaluate((el) => document.activeElement === el).catch(() => false);
if (!memoryFocusReturned) {
  console.error('QA FAILED — Project Memory did not return focus to its trigger after Escape.');
  await closeApp(); process.exit(1);
}
await win.setViewportSize({ width: 1000, height: 720 }).catch(() => {});
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

// Cockpit is an internal route: enter through the real shared-shell session path when its Windows
// implementation is available, and skip the platform-specific checks elsewhere.
if (cockpitAvailable) {
await win.evaluate(() => {
  document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: [
    { id: 'qa-cockpit-route', projectPath: 'C:/qa/route', label: 'QA Cockpit route', detail: 'main · Claude', activity: 'idle', pinned: false },
  ] }));
});
await showCockpitViaSession();
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

// Cockpit structure intact after the multi-session changes (the + New session button only appears
// with a live session, which the harness can't spawn — so just confirm the view renders cleanly).
const ckOk = await win.evaluate(() => {
  const newBtn = document.getElementById('ck-new-session');
  return !!document.getElementById('ck-groups') && !!document.querySelector('#view-cockpit .ck-main')
    && !!newBtn && newBtn.disabled === true; // + New session present and disabled with no live session
});
console.log(`cockpit structure + new-session button present: ${ckOk}`);
if (!ckOk) { console.error('QA FAILED — cockpit structure / + New session button missing'); await closeApp(); process.exit(1); }

// Unified session navigation: long names/details must stay inside the shared 224px sidebar and
// the old nested Cockpit sidebar must not consume any terminal width. The harness cannot spawn a
// live PTY session, so send a representative fixture through the mounted shell controller's narrow
// renderer-local QA seam and inspect its real reconciliation output.
const sidebar = await win.evaluate(async () => {
  const groups = document.getElementById('shell-session-groups');
  const long = 'devdeck-monorepo-frontend-experimental-feature-branch-session-42-x';
  const cjk = '데브덱코크핏세션이름아주아주긴한글이름테스트용으로만든것';
  const fixture = [
    { id: 'qa-shell-attention', projectPath: 'C:/qa/attention', label: long, detail: 'main · Claude · 41%', activity: 'attention', pinned: false },
    { id: 'qa-shell-working', projectPath: 'C:/qa/working', label: cjk, detail: 'feature/command-center · Codex · 82%', activity: 'working', pinned: false },
  ];
  document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: fixture }));
  await new Promise((r) => setTimeout(r, 250));
  const selectedRow = groups.querySelector('.group-attention .shell-session');
  selectedRow.focus(); selectedRow.click();
  document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: fixture }));
  await new Promise((r) => setTimeout(r, 250));
  const list = document.getElementById('app-sidebar').getBoundingClientRect();
  const names = [...groups.querySelectorAll('strong')];
  const details = [...groups.querySelectorAll('small')];
  const nested = document.querySelector('#view-cockpit .ck-list');
  const main = document.querySelector('#view-cockpit .ck-main').getBoundingClientRect();
  const wrap = document.querySelector('#view-cockpit .ck-wrap').getBoundingClientRect();
  return {
    sidebarWidth: Math.round(list.width),
    inside: names.every((n) => n.getBoundingClientRect().right <= list.right + 1),
    detailInside: details.every((n) => n.getBoundingClientRect().right <= list.right + 1),
    clipped: [...names, ...details].every((n) => n.scrollWidth >= n.clientWidth),
    signals: groups.querySelectorAll('.shell-signal').length,
    selected: selectedRow.classList.contains('selected') && selectedRow.getAttribute('aria-current') === 'true',
    reused: selectedRow === groups.querySelector('.group-attention .shell-session') && document.activeElement === selectedRow,
    semanticGroups: Array.from(groups.querySelectorAll('.shell-group')).every((section) => {
      const headingId = section.getAttribute('aria-labelledby');
      return !!headingId && document.getElementById(headingId)?.tagName === 'H2';
    }),
    sessionStatusNames: (() => {
      const statuses = {
        en: ['Awaiting you', 'Working'], ko: ['질문 대기', '작업 중'],
        ja: ['確認待ち', '実行中'], zh: ['等待确认', '工作中'],
      }[document.documentElement.lang] ?? [];
      return Array.from(groups.querySelectorAll('.shell-session')).every((row, index) => row.getAttribute('aria-label')?.includes(statuses[index]));
    })(),
    nestedHidden: getComputedStyle(nested).display === 'none',
    mainFillsWrap: Math.abs(main.width - wrap.width) <= 1,
  };
});
await shot('cockpit-provider-sidebar');
console.log(`unified session sidebar: width=${sidebar.sidebarWidth}px namesInside=${sidebar.inside} detailsInside=${sidebar.detailInside} signals=${sidebar.signals} selected=${sidebar.selected} reused=${sidebar.reused} semanticGroups=${sidebar.semanticGroups} sessionStatusNames=${sidebar.sessionStatusNames} nestedHidden=${sidebar.nestedHidden} terminalFills=${sidebar.mainFillsWrap}`);
if (sidebar.sidebarWidth < 180 || sidebar.sidebarWidth > 460 || !sidebar.inside || !sidebar.detailInside || sidebar.signals !== 2 || !sidebar.selected || !sidebar.reused || !sidebar.semanticGroups || !sidebar.sessionStatusNames || !sidebar.nestedHidden || !sidebar.mainFillsWrap) {
  console.error('QA FAILED — unified session navigation overflowed or the legacy Cockpit list still consumes terminal width.');
  await closeApp();
  process.exit(1);
}
// The full session row must be reachable by keyboard in the shared sidebar.
const tooltip = await win.evaluate(async () => {
  const row = document.querySelector('#shell-session-groups .shell-session');
  row.focus();
  await new Promise((r) => setTimeout(r, 150));
  return { focused: document.activeElement === row, labelled: !!row.getAttribute('aria-label') };
});
await shot('cockpit-provider-tooltip');
console.log(`session navigation keyboard: focusable=${tooltip.focused} labelled=${tooltip.labelled}`);
if (!tooltip.focused || !tooltip.labelled) {
  console.error('QA FAILED — the unified session row is not keyboard reachable or labelled.');
  await closeApp();
  process.exit(1);
}

// A LIVE session must keep the row controls it had in the old cockpit list (pin / rename / close),
// and its status must be readable without color: distinct shapes, and a spinning "working" mark —
// the redesign once shipped an actions menu on previous rows only and a single static grey dot.
const liveRowControls = await win.evaluate(async () => {
  document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: [
    { id: 'qa-live-attention', projectPath: 'C:/qa/attention', label: 'attention row', detail: 'main · Claude', activity: 'attention', pinned: false },
    { id: 'qa-live-working', projectPath: 'C:/qa/working', label: 'working row', detail: 'feat · Codex', activity: 'working', pinned: false, summary: 'writing the regression guard' },
    { id: 'qa-live-idle', projectPath: 'C:/qa/idle', label: 'idle row', detail: 'main · Claude', activity: 'idle', pinned: true },
  ] }));
  await new Promise((r) => setTimeout(r, 250));
  const wraps = Array.from(document.querySelectorAll('.shell-session-wrap'));
  const actionsOf = (wrap) => Array.from(wrap.querySelectorAll('[data-session-action]'))
    .filter((item) => !item.classList.contains('hidden')).map((item) => item.dataset.sessionAction);
  const working = document.querySelector('.activity-working .shell-signal');
  const shapes = wraps.map((wrap) => wrap.querySelector('.shell-signal')?.className.replace('shell-signal ', ''));
  return {
    triggersVisible: wraps.every((wrap) => (wrap.querySelector('.shell-session-actions')?.getClientRects().length ?? 0) > 0),
    liveActions: actionsOf(wraps[0]),
    pinnedActions: actionsOf(wraps.find((wrap) => wrap.querySelector('[data-pinned="true"]'))),
    workingAnimated: getComputedStyle(working).animationName === 'shell-spin',
    distinctShapes: new Set(shapes).size === shapes.length,
    summaryShown: !!document.querySelector('.activity-working')?.parentElement?.querySelector('.shell-entity-copy em:not(.hidden)')?.textContent,
  };
});
console.log(`live session row controls: ${JSON.stringify(liveRowControls)}`);
if (!liveRowControls.triggersVisible
  || liveRowControls.liveActions.join() !== 'pin,rename,close'
  || liveRowControls.pinnedActions.join() !== 'unpin,rename,close'
  || !liveRowControls.workingAnimated || !liveRowControls.distinctShapes || !liveRowControls.summaryShown) {
  console.error('QA FAILED — a live session row lost its pin/rename/close menu or its non-color status mark.');
  await closeApp();
  process.exit(1);
}

// The sidebar has to stay legible when the lists get LONG — this user runs a dozen concurrent
// sessions and keeps far more pinned than fit on screen. Three things carry that: recency order
// inside every group (alphabetical order is what forced "a pin for the pins"), a per-group cut with
// an explicit "show N more", and foldable headers that keep advertising their count while folded.
const atScale = await win.evaluate(async () => {
  const base = 1_700_000_000_000;
  const row = (i, over) => ({
    id: `qa-scale-${i}`, projectPath: `C:/qa/scale/${i}`, label: `session ${String(i).padStart(2, '0')}`,
    detail: 'main · Claude', activity: 'idle', pinned: true, lastActiveMs: base + i * 60_000, ...over,
  });
  document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: [
    ...Array.from({ length: 12 }, (_, i) => row(i)),                                  // pinned, limit 10
    ...Array.from({ length: 8 }, (_, i) => row(50 + i, { pinned: false, previous: true })), // previous, limit 5
  ] }));
  await new Promise((r) => setTimeout(r, 250));
  const read = (kind) => {
    const section = document.querySelector(`.group-${kind}`);
    const toggle = section?.querySelector('.shell-group-toggle');
    return {
      count: toggle?.querySelector('.shell-group-count')?.textContent,
      expanded: toggle?.getAttribute('aria-expanded'),
      labels: Array.from(section?.querySelectorAll('.shell-group-body .shell-entity-copy strong') ?? []).map((e) => e.textContent),
      moreShown: (section?.querySelector('.shell-more')?.getClientRects().length ?? 0) > 0,
      bodyVisible: (section?.querySelector('.shell-group-body')?.getClientRects().length ?? 0) > 0,
    };
  };
  const click = async (selector) => { document.querySelector(selector)?.click(); await new Promise((r) => setTimeout(r, 200)); };
  const pinnedCut = read('pinned');
  const previousCut = read('previous');
  await click('.group-pinned .shell-more');
  const pinnedFull = read('pinned');
  await click('.group-pinned .shell-group-toggle');
  const pinnedFolded = read('pinned');
  await click('.group-pinned .shell-group-toggle');
  return { pinnedCut, previousCut, pinnedFull, pinnedFolded, reopened: read('pinned').bodyVisible };
});
console.log('sidebar at scale:', JSON.stringify(atScale));
const scaleOk =
  // 12 pinned cut to 10, newest FIRST — alphabetical order would put "session 00" on top.
  atScale.pinnedCut.count === '12' && atScale.pinnedCut.labels.length === 10
  && atScale.pinnedCut.labels[0] === 'session 11' && atScale.pinnedCut.labels.at(-1) === 'session 02'
  && atScale.pinnedCut.moreShown
  && atScale.previousCut.count === '8' && atScale.previousCut.labels.length === 5 && atScale.previousCut.moreShown
  // "show more" reveals the rest and retires itself.
  && atScale.pinnedFull.labels.length === 12 && !atScale.pinnedFull.moreShown
  // Folded: rows gone, but the count still says how many are in there.
  && !atScale.pinnedFolded.bodyVisible && atScale.pinnedFolded.count === '12' && atScale.pinnedFolded.expanded === 'false'
  && atScale.reopened;
await shot('sidebar-at-scale');
if (!scaleOk) {
  console.error('QA FAILED — the sidebar does not stay legible at scale (order, per-group cut, or foldable headers):', JSON.stringify(atScale));
  await closeApp(); process.exit(1);
}

// Unpinning must say WHERE the row went and offer a way back — with neither, it reads as a delete,
// which is why pins accumulated until the pinned group was as unreadable as the list it shortcuts.
const unpinFeedback = await win.evaluate(async () => {
  // The neighbour exists so the destination group is actually on screen — the toast names it, and this
  // reads that name off the rendered header rather than hardcoding one locale's wording.
  document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: [
    { id: 'qa-unpin', projectPath: 'C:/qa/unpin', label: 'unpin me', detail: 'main · Claude', activity: 'idle', pinned: true, lastActiveMs: 2 },
    { id: 'qa-unpin-neighbour', projectPath: 'C:/qa/quiet', label: 'quiet neighbour', detail: 'main · Claude', activity: 'idle', pinned: false, lastActiveMs: 1 },
  ] }));
  await new Promise((r) => setTimeout(r, 200));
  const destination = document.querySelector('.group-quiet .shell-group-name')?.textContent ?? '';
  document.querySelector('.group-pinned .shell-session-actions')?.click();
  document.querySelector('.group-pinned [data-session-action="unpin"]')?.click();
  await new Promise((r) => setTimeout(r, 200));
  const toast = document.querySelector('#toast-host .toast-info');
  return {
    text: toast?.textContent ?? '', destination,
    shown: (toast?.getClientRects().length ?? 0) > 0,
    polite: toast?.getAttribute('role') === 'status',
    namesRow: toast?.textContent?.includes('unpin me') === true,
    namesDestination: destination.length > 0 && toast?.textContent?.includes(destination) === true,
    undoable: (toast?.querySelector('.toast-action')?.getClientRects().length ?? 0) > 0,
  };
});
console.log('unpin feedback:', JSON.stringify(unpinFeedback));
if (!unpinFeedback.shown || !unpinFeedback.polite || !unpinFeedback.namesRow || !unpinFeedback.namesDestination || !unpinFeedback.undoable) {
  console.error('QA FAILED — unpinning gives no destination or no undo:', JSON.stringify(unpinFeedback));
  await closeApp(); process.exit(1);
}
await win.evaluate(() => { document.querySelectorAll('#toast-host .toast-info').forEach((t) => t.remove()); });
}

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

if (cockpitAvailable) await showCockpitViaSession();
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
