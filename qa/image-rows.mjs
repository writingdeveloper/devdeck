// Windows harness: an image ties back to the terminal row it was shown on, and back again — plus the
// arrival preview, copying an image, and Ctrl+Up/Down between prompts. A fixture `claude` draws a
// screen the way Claude Code does (`● server - tool (MCP)` / `⎿  [Image]` / shaded `❯ prompt` rows)
// over an isolated HOME whose transcript holds the same images. Never starts a real agent.
// Run with npm run qa:image-rows.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxDir } from './sandbox.mjs';

const root = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
if (process.platform !== 'win32') { console.log('SKIP: Windows native PTY required'); process.exit(0); }
const shots = resolve(process.argv[3] ?? join(root, 'qa', 'shots', 'image-rows'));
mkdirSync(shots, { recursive: true });
const { closeElectron } = await import('file:///' + join(root, 'qa', 'electron-lifecycle.mjs').replace(/\\/g, '/'));

const sandbox = sandboxDir('devdeck-image-rows-');
const repo = join(sandbox, 'rows-workspace');
const bin = join(sandbox, 'bin');
const profile = join(sandbox, 'profile');
const home = join(profile, 'home');
for (const p of [repo, bin, home]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-rows'], { cwd: repo });

const sid = '7a1c2b3d-1111-4222-8333-944455556666';
const tdir = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(tdir, { recursive: true });
const transcript = join(tdir, sid + '.jsonl');
const png = (f) => readFileSync(join(root, f)).toString('base64');
const ts = new Date().toISOString();
const said = (text) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id, name, input = {}) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const shot = (id, data) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } });
const prompt = (text) => ({ type: 'user', timestamp: ts, cwd: repo, sessionId: sid, message: { role: 'user', content: text } });
const lines = [
  prompt('로그인 화면 확인해줘'),
  said('로그인 페이지를 열어 보겠습니다.'),
  call('n1', 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000/login' }),
  call('s1', 'mcp__playwright__browser_take_screenshot', { element: 'Submit button' }),
  shot('s1', png('docs/demo/poster.png')),
  prompt('다음 단계'),
  said('바탕화면을 확인합니다.'),
  call('w1', 'mcp__windows-mcp__Screenshot'),
  shot('w1', png('build/icon.png')),
];
writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
// What the fixture appends when it is sent SHOT: one more browser screenshot.
writeFileSync(join(bin, 'more.jsonl'), [
  said('헤더도 찍어 둡니다.'),
  call('s2', 'mcp__playwright__browser_take_screenshot', { element: 'Header' }),
  shot('s2', png('build/icon.png')),
].map((l) => JSON.stringify(l)).join('\n') + '\n');

const SHADE = '\x1b[48;5;237m';
const RESET = '\x1b[0m';
writeFileSync(join(bin, 'agent.js'), `
if (process.argv.includes('agents')) { process.stdout.write('[]'); process.exit(0); } // DevDeck's background-session listing
const fs = require('fs');
const out = (s) => process.stdout.write(s.replace(/\\n/g, '\\r\\n'));
const filler = (tag, n) => Array.from({ length: n }, (_, i) => '  ' + tag + ' output line ' + i).join('\\n') + '\\n';
out(${JSON.stringify(SHADE)} + '❯ 로그인 화면 확인해줘' + ${JSON.stringify(RESET)} + '\\n');
out('● 로그인 페이지를 열어 보겠습니다.\\n');
out('● playwright - browser_navigate (MCP)(url: "http://localhost:3000/login")\\n  ⎿  Navigated\\n');
out('● playwright - browser_take_screenshot (MCP)(element: "Submit button")\\n  ⎿  [Image]\\n');
out(filler('first', 70));
out(${JSON.stringify(SHADE)} + '❯ 다음 단계' + ${JSON.stringify(RESET)} + '\\n');
out('● windows-mcp - Screenshot (MCP)\\n  ⎿  [Image]\\n');
out(filler('second', 70));
const composer = () => out('────────────────────────────────\\n❯ \\n────────────────────────────────\\n');
composer();
out('FIXTURE_READY\\n');
let typed = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  typed += d.toString();
  if (!typed.includes('SHOT')) return;
  typed = '';
  out('● playwright - browser_take_screenshot (MCP)(element: "Header")\\n  ⎿  [Image]\\n');
  composer();
  fs.appendFileSync(${JSON.stringify(transcript)}, fs.readFileSync(${JSON.stringify(join(bin, 'more.jsonl'))}));
});
setInterval(() => {}, 1 << 30);
`);
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0agent.js" %*\r\n');

writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings: {
  language: 'ko', folders: [{ path: repo, kind: 'repo' }], viewMode: 'list',
  cockpitSessions: [{ tileId: 'tile-rows-1', projectPath: repo, name: 'rows-workspace', sessionId: sid, agentId: 'claude', label: 'Rows QA', lastActiveMs: Date.now() }],
} }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = bin + ';' + env[pathKey];

const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu'], cwd: root, env });
const errors = [];
let failed = false;
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
// The person's clipboard is put back afterwards: this harness copies an image onto it.
const savedClip = await app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), image: clipboard.readImage().toDataURL() }));
try {
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const screenText = () => win.evaluate(() => [...document.querySelectorAll('.ck-term.show .xterm-rows > div')].map((r) => r.textContent));
  const topRow = async () => (await screenText())[0] ?? '';
  /** The `[Image]` placeholder spans on screen, with the colour they are drawn in. */
  // A decorated run can be split into several spans, so the placeholder is found in the row's text
  // and measured over whichever spans cover it.
  const imageSpans = () => win.evaluate(() => [...document.querySelectorAll('.ck-term.show .xterm-rows > div')]
    .filter((row) => row.textContent.includes('[Image]'))
    .map((row) => {
      const at = row.textContent.indexOf('[Image]');
      let pos = 0; const covering = [];
      for (const s of row.querySelectorAll('span')) {
        const end = pos + s.textContent.length;
        if (end > at && pos < at + 7) covering.push(s);
        pos = end;
      }
      const rects = covering.map((s) => s.getBoundingClientRect());
      const x0 = Math.min(...rects.map((r) => r.left)); const x1 = Math.max(...rects.map((r) => r.right));
      return { x: (x0 + x1) / 2, y: rects[0].top + rects[0].height / 2, color: covering[0] ? getComputedStyle(covering[0]).color : '', row: row.textContent };
    }));

  await check('session opens with the fixture screen', async () => {
    await win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.includes('FIXTURE_READY')), null, { timeout: 20000 });
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-img-count')?.textContent === '2');
  });

  await check('Ctrl+Up steps back through the prompts the person sent, Ctrl+Down returns', async () => {
    await win.locator('.ck-term.show .xterm-screen').click();
    await win.keyboard.press('Control+ArrowUp');
    await win.waitForFunction(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent.includes('다음 단계'));
    await win.keyboard.press('Control+ArrowUp');
    await win.waitForFunction(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent.includes('로그인 화면 확인해줘'));
    await win.screenshot({ path: join(shots, '1-prompt-jump.png') });
    await win.keyboard.press('Control+ArrowDown');
    await win.waitForFunction(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent.includes('다음 단계'));
    await win.keyboard.press('Control+ArrowDown');
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows > div')].some((r) => r.textContent.includes('FIXTURE_READY')));
    // The composer's own `❯` is not a sent prompt, and nothing reached the agent.
    assert.ok(!(await topRow()).includes('────'), 'never jumped into the composer');
  });

  await check('placeholders are marked on screen and open the image they stand for', async () => {
    await win.keyboard.press('Control+ArrowUp');
    await win.waitForFunction(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent.includes('다음 단계'));
    let spans = [];
    for (const until = Date.now() + 8000; Date.now() < until; await win.waitForTimeout(250)) {
      spans = await imageSpans();
      if (spans[0]?.color === 'rgb(168, 205, 255)') break;
    }
    assert.equal(spans.length, 1, 'the windows screenshot row is on screen');
    assert.equal(spans[0].color, 'rgb(168, 205, 255)', 'drawn in the mark colour');
    await win.mouse.move(spans[0].x, spans[0].y);
    await win.waitForSelector('.ck-img-hover img[src^="data:image"]');
    await win.screenshot({ path: join(shots, '2-hover.png') });
    await win.mouse.click(spans[0].x, spans[0].y);
    await win.waitForFunction(() => document.querySelector('.ck-img-viewer .ck-img-stage img')?.getAttribute('src')?.startsWith('data:image'));
    const caption = await win.locator('.ck-img-caption').textContent();
    assert.match(caption, /windows-mcp · Screenshot/);
    assert.match(caption, /바탕화면을 확인합니다/);
    await win.keyboard.press('Escape');
    await win.waitForSelector('.ck-img-viewer', { state: 'detached' });
    assert.equal(await win.locator('.ck-img-hover').count(), 0, 'hover preview gone after the click');
  });

  await check('the viewer says what led to an image and goes to its row in the terminal', async () => {
    await win.locator('#ck-header button.ck-img-toggle').click();
    await win.waitForFunction(() => document.querySelectorAll('#ck-images .ck-img-thumb').length === 2);
    await win.locator('#ck-images .ck-img-thumb').nth(1).click(); // oldest: the login screenshot
    await win.waitForFunction(() => document.querySelector('.ck-img-viewer .ck-img-stage img')?.getAttribute('src')?.startsWith('data:image'));
    const context = await win.locator('.ck-img-context').textContent();
    assert.match(context, /Submit button/);
    assert.match(context, /localhost:3000\/login/);
    assert.match(context, /로그인 페이지를 열어 보겠습니다/);
    await win.screenshot({ path: join(shots, '3-viewer-context.png') });

    await win.locator('.ck-img-bar button[aria-label="이미지 복사"]').click();
    await win.waitForFunction(() => document.body.textContent.includes('이미지를 클립보드에 복사했습니다'));
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readImage().isEmpty()), false, 'an image is on the clipboard');

    await win.locator('.ck-img-bar button[aria-label="터미널에서 위치 보기"]').click();
    await win.waitForSelector('.ck-img-viewer', { state: 'detached' });
    // The scroll is drawn on the next frame; on a slow runner that is after the viewer is gone.
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows > div')].some((r) => r.textContent.includes('(element: "Submit button")')));
    const spans = await imageSpans();
    assert.ok(spans.some((s) => s.row.includes('[Image]')), 'the login screenshot row is on screen');
    assert.ok((await screenText()).some((r) => r.includes('browser_take_screenshot (MCP)(element: "Submit button")')), 'with its call above it');
    await win.screenshot({ path: join(shots, '4-revealed.png') });
    await win.locator('#ck-header button.ck-img-toggle').click(); // close the strip again
    await win.waitForFunction(() => document.querySelector('#ck-images')?.classList.contains('hidden'));
  });

  await check('a new screenshot is previewed over the terminal while the strip is closed', async () => {
    await win.locator('.ck-term.show .xterm-screen').click();
    await win.keyboard.type('SHOT');
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.includes('(element: "Header")')));
    // Re-selecting re-reads the list at once instead of waiting for the next tick.
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.waitForSelector('.ck-img-preview img[src^="data:image"]', { timeout: 40000 });
    await win.screenshot({ path: join(shots, '5-preview.png') });
    await win.locator('.ck-img-preview').click();
    await win.waitForFunction(() => document.querySelector('.ck-img-context')?.textContent.includes('Header'));
    await win.locator('.ck-img-bar button[aria-label="터미널에서 위치 보기"]').click();
    await win.waitForSelector('.ck-img-viewer', { state: 'detached' });
    assert.equal(await win.locator('.ck-img-preview').count(), 0, 'the preview went with the click');
  });

  assert.deepEqual(errors, [], 'no renderer errors');
} catch (e) {
  console.log('FAIL', e?.message ?? e);
  failed = true;
  try { const w = await app.firstWindow(); await w.screenshot({ path: join(shots, 'failure.png') }); } catch { /* window gone */ }
} finally {
  await app.evaluate(({ clipboard, nativeImage }, saved) => {
    if (saved.image && saved.image !== 'data:image/png;base64,') clipboard.writeImage(nativeImage.createFromDataURL(saved.image));
    else clipboard.writeText(saved.text);
  }, savedClip).catch(() => {});
  await closeElectron(app).catch(() => {});
}
if (failed) process.exitCode = 1;
