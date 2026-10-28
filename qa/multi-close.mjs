// Closing several sidebar sessions at once, driven the way a person drives it.
//
// What this guards: the selection MODE (the Select button above the groups, "Select…" in a row's ⋯
// menu, a plain click picking a row while the mode is on, the group heading's checkbox, Shift+click
// ranges, Escape leaving, Delete closing), the one confirmation for the whole set, and the rows
// actually leaving afterwards. It uses saved ("previous") entries, which need no agent: closing them
// is a forget, so the whole flow runs without a `claude` on the PC. Also checked: a row's ⋯ menu is
// positioned inside the window even when the list is short (it used to be clipped by the list box).
//
// Run with `npm run qa:multi-close`. One Electron instance; do not run alongside `npm run qa`.
import { _electron as electron } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { closeElectron } from './electron-lifecycle.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = mkdtempSync(join(tmpdir(), 'devdeck-multiclose-fixture-'));
writeFileSync(join(projectRoot, 'README.md'), '# QA fixture\n');
execFileSync('git', ['init', '-q', '-b', 'qa-fixture'], { cwd: projectRoot });
execFileSync('git', ['add', '.'], { cwd: projectRoot });
execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@devdeck', 'commit', '-qm', 'fixture'], { cwd: projectRoot });

const qaUserData = mkdtempSync(join(tmpdir(), 'devdeck-multiclose-'));
const saved = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
writeFileSync(join(qaUserData, 'state.json'), JSON.stringify({
  projects: {},
  settings: {
    language: 'ko',
    folders: [{ path: projectRoot, kind: 'repo' }],
    cockpitSessions: saved.map((label) => ({ projectPath: projectRoot, name: 'fixture', sessionId: null, agentId: 'claude', label })),
  },
}, null, 2));

const consoleErrors = [];
const pageErrors = [];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const app = await electron.launch({
  args: ['.', `--user-data-dir=${qaUserData}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
  env: { ...process.env, CLAUDE_CODE_SSE_PORT: '', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
});
try {
  const win = await app.firstWindow();
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  win.on('pageerror', (e) => pageErrors.push(String(e)));
  await win.waitForSelector('#shell-session-groups', { timeout: 20000 });
  await win.waitForFunction((n) => document.querySelectorAll('.shell-session-wrap[data-previous="true"]').length >= n, saved.length, { timeout: 20000 });
  const previousRows = () => win.locator('.shell-session-wrap[data-previous="true"]');
  const rowByLabel = (label) => previousRows().filter({ hasText: label }).locator('.shell-session');
  const selectedCount = () => win.evaluate(() => document.querySelectorAll('.shell-session-wrap.is-selected').length);
  const inMode = () => win.evaluate(() => document.getElementById('shell-session-groups').classList.contains('is-selecting'));

  // 1. The Select button is on screen and turns the mode on with nothing picked.
  const toggle = win.locator('#shell-select-toggle');
  check('select button visible', await toggle.isVisible());
  await toggle.click();
  check('mode on after Select', await inMode());
  check('bar visible, close disabled with nothing picked', await win.locator('.shell-selection').isVisible() && await win.locator('.shell-selection-close').isDisabled());
  check('checkboxes drawn in the mode', await win.evaluate(() => getComputedStyle(document.querySelector('.shell-session-check')).display !== 'none'));

  // 2. Plain clicks pick (and do not open) while the mode is on.
  await rowByLabel('Alpha').click();
  await rowByLabel('Bravo').click();
  check('two plain clicks picked two rows', (await selectedCount()) === 2, `selected=${await selectedCount()}`);
  check('picked rows carry aria-pressed', await rowByLabel('Alpha').getAttribute('aria-pressed') === 'true');
  check('count says 2', (await win.locator('.shell-selection-count').textContent()).includes('2'));

  // 3. The group checkbox picks the whole group (opening the "show more" cut first).
  const groupCheck = win.locator('.shell-group.group-previous .shell-group-check');
  await groupCheck.click();
  check('group checkbox picked every saved row', (await selectedCount()) === saved.length, `selected=${await selectedCount()}`);
  check('group checkbox reads checked', await groupCheck.getAttribute('aria-checked') === 'true');
  await groupCheck.click();
  check('group checkbox again un-picked them', (await selectedCount()) === 0);

  // 4. Escape leaves the mode.
  await win.keyboard.press('Escape');
  check('Escape left the mode', !(await inMode()));
  check('toggle is back', await toggle.isVisible());

  // 5. "Select…" in a row's ⋯ menu starts a selection with that row; the menu was inside the window.
  const charlie = previousRows().filter({ hasText: 'Charlie' });
  await charlie.locator('.shell-session-actions').click();
  const menuBox = await charlie.locator('.shell-session-menu').boundingBox();
  const viewport = win.viewportSize() ?? await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  check('row menu is placed inside the window', !!menuBox && menuBox.y >= 0 && menuBox.y + menuBox.height <= viewport.height && menuBox.x >= 0, JSON.stringify(menuBox));
  await charlie.locator('.shell-session-pick').click();
  check('Select… picked that row and turned the mode on', (await inMode()) && (await selectedCount()) === 1);

  // 6. Shift+click ranges from the last pick.
  await rowByLabel('Echo').click({ modifiers: ['Shift'] });
  check('Shift+click picked the range Charlie..Echo', (await selectedCount()) === 3, `selected=${await selectedCount()}`);

  // 7. Close asks once; Enter answers; the rows leave and the mode ends.
  await win.locator('.shell-selection-close').click();
  await win.waitForSelector('.ck-confirm', { timeout: 5000 });
  const question = await win.locator('.ck-confirm-msg').textContent();
  check('one confirmation for the set', question.includes('3'), question);
  await win.keyboard.press('Enter');
  await win.waitForFunction((n) => document.querySelectorAll('.shell-session-wrap[data-previous="true"]').length === n, saved.length - 3, { timeout: 5000 });
  check('three rows left the list', (await previousRows().count()) === saved.length - 3);
  check('mode ended after the close', !(await inMode()));

  // 8. Delete closes the picked rows (after the question); Cancel keeps them.
  await toggle.click();
  await rowByLabel('Alpha').click();
  await win.keyboard.press('Delete');
  await win.waitForSelector('.ck-confirm', { timeout: 5000 });
  await win.locator('.ck-confirm-cancel').click();
  check('Cancel kept the row and the pick', (await previousRows().count()) === saved.length - 3 && (await selectedCount()) === 1);
  // The question keeps the keyboard: the quick-open chord must not move focus behind it, where a
  // later Enter would still answer it.
  await win.keyboard.press('Delete');
  await win.waitForSelector('.ck-confirm', { timeout: 5000 });
  await win.keyboard.press('Control+Shift+P');
  check('a chord cannot leave the question', await win.evaluate(() => document.activeElement?.closest('.ck-confirm') != null));
  check('one confirmation on screen', (await win.locator('.ck-confirm').count()) === 1);
  await win.keyboard.press('Enter');
  await win.waitForFunction((n) => document.querySelectorAll('.shell-session-wrap[data-previous="true"]').length === n, saved.length - 4, { timeout: 5000 });
  check('Delete + Enter closed the picked row', (await previousRows().count()) === saved.length - 4);
} finally {
  await closeElectron(app);
}

check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
