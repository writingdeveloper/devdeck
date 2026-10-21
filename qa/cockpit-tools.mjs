// Windows harness: the cockpit's quick replies, session timeline, image markup sent back to the
// session, and documents received for a session from another machine. A fixture `claude` draws a
// Claude-shaped screen and records every byte typed into it, over an isolated HOME whose transcript
// holds the matching prompts, replies and screenshots. Never starts a real agent.
// Run with npm run qa:cockpit-tools.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
if (process.platform !== 'win32') { console.log('SKIP: Windows native PTY required'); process.exit(0); }
const shots = resolve(process.argv[3] ?? join(root, 'qa', 'shots', 'cockpit-tools'));
mkdirSync(shots, { recursive: true });
const { closeElectron } = await import('file:///' + join(root, 'qa', 'electron-lifecycle.mjs').replace(/\\/g, '/'));

const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-cockpit-tools-'));
const repo = join(sandbox, 'tools-workspace');
const bin = join(sandbox, 'bin');
const profile = join(sandbox, 'profile');
const home = join(profile, 'home');
for (const p of [repo, bin, home]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-tools'], { cwd: repo });

const sid = '7a1c2b3d-2222-4333-8444-955566667777';
const tdir = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(tdir, { recursive: true });
const transcript = join(tdir, sid + '.jsonl');
const typedLog = join(bin, 'typed.log');
const png = (f) => readFileSync(join(root, f)).toString('base64');
const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
const said = (text, min) => ({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id, name, min, input = {}) => ({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const shot = (id, data, min) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } });
const prompt = (text, min) => ({ type: 'user', timestamp: at(min), cwd: repo, sessionId: sid, message: { role: 'user', content: text } });
writeFileSync(transcript, [
  prompt('로그인 화면 확인해줘', 30),
  said('로그인 페이지를 열어 보겠습니다.', 29),
  call('s1', 'mcp__playwright__browser_take_screenshot', 29, { element: 'Submit button' }),
  shot('s1', png('docs/demo/poster.png'), 29),
  said('제출 버튼이 비활성 상태입니다.', 28),
  prompt('다음 단계', 10),
  said('바탕화면도 확인했습니다.', 9),
].map((l) => JSON.stringify(l)).join('\n') + '\n');

const SHADE = '\x1b[48;5;237m';
const RESET = '\x1b[0m';
writeFileSync(join(bin, 'agent.js'), `
const fs = require('fs');
const out = (s) => process.stdout.write(s.replace(/\\n/g, '\\r\\n'));
const filler = (tag, n) => Array.from({ length: n }, (_, i) => '  ' + tag + ' output line ' + i).join('\\n') + '\\n';
out(${JSON.stringify(SHADE)} + '❯ 로그인 화면 확인해줘' + ${JSON.stringify(RESET)} + '\\n');
out('● playwright - browser_take_screenshot (MCP)(element: "Submit button")\\n  ⎿  [Image]\\n');
out(filler('first', 70));
out(${JSON.stringify(SHADE)} + '❯ 다음 단계' + ${JSON.stringify(RESET)} + '\\n');
out(filler('second', 70));
out('────────────────────────────────\\n❯ \\n────────────────────────────────\\n');
out('FIXTURE_READY\\n');
// Claude Code's status protocol (OSC 7501): ask the terminal, then report once answered.
const status = (fields) => process.stdout.write('\\x1b]7501;' + fields + '\\x07');
const b64 = (s) => Buffer.from(s).toString('base64');
process.stdout.write('\\x1b]7501;?\\x07');
let seenInput = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  fs.appendFileSync(${JSON.stringify(typedLog)}, d);
  seenInput += d.toString();
  if (seenInput.includes('\\x1b]7501;?')) { seenInput = seenInput.replace('\\x1b]7501;?', ''); status('state=working:app=claude-code:progress=30:msg=' + b64('테스트 실행 중')); }
  if (seenInput.includes('BLOCKME')) { seenInput = ''; status('state=blocked:app=claude-code:kind=permission:msg=' + b64('Bash')); }
  if (seenInput.includes('DONEME')) { seenInput = ''; status('state=done:app=claude-code:msg=' + b64('로그인 버그를 고쳤습니다')); }
});
setInterval(() => {}, 1 << 30);
`);
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0agent.js" %*\r\n');

writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings: {
  language: 'ko', folders: [{ path: repo, kind: 'repo' }], viewMode: 'list',
  // An install updated from 1.41.0, with Claude's status signal turned on.
  whatsNewSeen: '1.41.0', programStatus: true,
  cockpitSessions: [{ tileId: 'tile-tools-1', projectPath: repo, name: 'tools-workspace', sessionId: sid, agentId: 'claude', label: 'Tools QA', lastActiveMs: Date.now() }],
} }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = bin + ';' + env[pathKey];

// DEVDECK_EXECUTABLE runs it against a packaged build (release.yml), where the bundled ConPTY is what ships.
const executablePath = process.env.DEVDECK_EXECUTABLE;
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu'], cwd: root, env });
const errors = [];
let failed = false;
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
const typed = () => (existsSync(typedLog) ? readFileSync(typedLog, 'utf8') : '');
const waitTyped = async (needle, ms = 8000) => {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) if (typed().includes(needle)) return;
  assert.fail(`the session never received ${JSON.stringify(needle)}; got ${JSON.stringify(typed().slice(-200))}`);
};
try {
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const topRow = () => win.evaluate(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent ?? '');

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  await check('after an update, What\'s new lists what changed and shows where it is', async () => {
    await win.waitForSelector('.wn-dialog', { timeout: 20000 });
    assert.equal(await win.locator('#wn-title').textContent(), `DevDeck ${version}의 새로운 기능`);
    // Only what is newer than the version the person last saw.
    const versions = await win.locator('.wn-version').allTextContents();
    assert.ok(versions.length >= 1 && !versions.includes('v1.41.0'), versions.join(','));
    await win.screenshot({ path: join(shots, '0-whats-new.png') });
    await win.locator('.wn-card', { hasText: 'Claude가 직접 상태를 알려 줍니다' }).locator('.wn-show').click();
    await win.waitForSelector('.wn-dialog', { state: 'detached' });
    await win.waitForSelector('#settings-form .set-row.dd-spotlight #set-program-status');
    assert.equal(await win.locator('#set-program-status').isChecked(), true);
    await win.screenshot({ path: join(shots, '0-spotlight.png') });
    const seen = JSON.parse(readFileSync(join(profile, 'state.json'), 'utf8')).settings.whatsNewSeen;
    assert.equal(seen, version, 'not shown again for this version');
  });

  await check('session opens with the fixture screen', async () => {
    await win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.includes('FIXTURE_READY')), null, { timeout: 20000 });
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-img-count')?.textContent === '1');
  });

  await check('Claude\'s own status shows in the header: working, needs approval, done', async () => {
    // The host answered the probe, so the agent reports.
    await waitTyped('\x1b]7501;?');
    const pill = win.locator('#ck-header .ck-status-pill');
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-status-pill')?.textContent?.includes('작업 중 30%'));
    assert.match(await pill.textContent(), /테스트 실행 중/);
    await win.locator('.ck-term.show .xterm-screen').click();
    await win.keyboard.type('BLOCKME');
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-status-pill.st-blocked')?.textContent?.includes('승인 필요'));
    await win.screenshot({ path: join(shots, '1-status-blocked.png') });
    await win.keyboard.type('DONEME');
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-status-pill.st-done')?.textContent?.includes('로그인 버그를 고쳤습니다'));
    await win.screenshot({ path: join(shots, '1-status-done.png') });
  });

  await check('a quick reply from the menu is typed and sent', async () => {
    const button = win.locator('#ck-header button[aria-label="빠른 답장"]');
    // New since the last version the person ran: marked until it is used.
    assert.equal(await button.locator('.dd-new-dot').count(), 1, 'a NEW dot on the quick reply button');
    // Waiting for the person: the button says so.
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-qr-btn')?.classList.contains('ready'), null, { timeout: 20000 });
    await button.click();
    await win.waitForSelector('.ck-qr-menu .ck-qr-item');
    assert.deepEqual(await win.locator('.ck-qr-item .ck-qr-text').allTextContents(), ['네 계속 진행해줘', '커밋해줘', '테스트 돌려서 결과 확인해줘', '변경한 내용 요약해줘']);
    await win.screenshot({ path: join(shots, '1-quick-replies.png') });
    await win.locator('.ck-qr-item').first().click();
    await waitTyped('네 계속 진행해줘\r');
    assert.equal(await win.locator('.ck-qr-menu').count(), 0, 'the menu closed');
    assert.equal(await win.locator('#ck-header .ck-qr-btn .dd-new-dot').count(), 0, 'the NEW dot went once it was used');
  });

  await check('Ctrl+Shift+<n> sends the n-th quick reply from the terminal', async () => {
    await win.locator('.ck-term.show .xterm-screen').click();
    await win.keyboard.press('Control+Shift+Digit2');
    await waitTyped('커밋해줘\r');
    assert.ok(!typed().includes('@'), 'Shift+2 itself never reached the agent');
  });

  await check('quick replies edited in Settings are the ones offered', async () => {
    await win.click('.rail-item[data-view="settings"]');
    const field = win.locator('#settings-form .set-quick-replies');
    await field.fill('배포 전 체크리스트 확인해줘\n로그 다시 봐줘');
    await field.blur();
    await win.waitForFunction(() => document.querySelector('#settings-form .set-quick-replies')?.closest('.set-row')?.querySelector('.set-save-status')?.textContent === '저장됨');
    const saved = JSON.parse(readFileSync(join(profile, 'state.json'), 'utf8')).settings.quickReplies;
    assert.deepEqual(saved, ['배포 전 체크리스트 확인해줘', '로그 다시 봐줘']);
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.locator('#ck-header button[aria-label="빠른 답장"]').click();
    assert.deepEqual(await win.locator('.ck-qr-item .ck-qr-text').allTextContents(), ['배포 전 체크리스트 확인해줘', '로그 다시 봐줘']);
    await win.keyboard.press('Escape');
    await win.waitForSelector('.ck-qr-menu', { state: 'detached' });
  });

  await check('the timeline lists each prompt with when, the reply and its images, and jumps to it', async () => {
    await win.locator('#ck-header button[aria-label="타임라인 보기"]').click();
    await win.waitForFunction(() => document.querySelectorAll('.ck-timeline .ck-tl-item').length === 2);
    const items = await win.locator('.ck-tl-item .ck-tl-text').allTextContents();
    assert.deepEqual(items, ['로그인 화면 확인해줘', '다음 단계']);
    const replies = await win.locator('.ck-tl-item .ck-tl-reply').allTextContents();
    assert.deepEqual(replies, ['제출 버튼이 비활성 상태입니다.', '바탕화면도 확인했습니다.']);
    assert.equal(await win.locator('.ck-tl-item').first().locator('.ck-tl-images').textContent(), '1');
    assert.equal(await win.locator('.ck-tl-item.gone').count(), 0, 'both prompts are still on screen');
    // The terminal underneath kept its size: the panel floats over it.
    const cols = await win.evaluate(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent.length ?? 0);
    await win.screenshot({ path: join(shots, '2-timeline.png') });
    await win.locator('.ck-tl-item .ck-tl-jump').first().click();
    await win.waitForFunction(() => document.querySelector('.ck-term.show .xterm-rows > div')?.textContent.includes('로그인 화면 확인해줘'));
    assert.ok((await topRow()).includes('로그인 화면 확인해줘'));
    assert.ok(cols > 0);
    await win.locator('.ck-tl-item .ck-tl-images').first().click();
    await win.waitForFunction(() => document.querySelector('.ck-img-context')?.textContent.includes('Submit button'));
  });

  await check('a screenshot marked up in the viewer goes back to the session with the marks on it', async () => {
    await win.locator('.ck-img-bar button[aria-label="표시하기"]').click();
    await win.waitForSelector('.ck-img-markup.on');
    const box = await win.locator('.ck-img-stage img').boundingBox();
    const from = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
    const to = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 };
    await win.mouse.move(from.x, from.y); await win.mouse.down();
    await win.mouse.move(to.x, to.y, { steps: 6 }); await win.mouse.up();
    await win.locator('.ck-img-tools button[aria-label="화살표"]').click();
    await win.mouse.move(to.x + 60, to.y + 40); await win.mouse.down();
    await win.mouse.move(to.x + 5, to.y + 5, { steps: 6 }); await win.mouse.up();
    assert.equal(await win.locator('.ck-img-tools button[aria-label="되돌리기 (Ctrl+Z)"]').isDisabled(), false);
    await win.screenshot({ path: join(shots, '3-markup.png') });
    await win.locator('.ck-img-bar button[aria-label="표시한 이미지를 세션에 첨부"]').click();
    await win.waitForSelector('.ck-img-viewer', { state: 'detached' });
    await waitTyped('.png ');
    const path = /(\S+devdeck-paste-[0-9a-f-]+\.png)/.exec(typed())?.[1];
    assert.ok(path && existsSync(path), 'the marked-up image was written where the session can read it');
    // Red marks in the sent picture: count strongly red pixels (the bitmap is BGRA).
    const red = await app.evaluate(({ nativeImage }, p) => {
      const img = nativeImage.createFromPath(p); const b = img.toBitmap(); let n = 0;
      for (let i = 0; i < b.length; i += 4) if (b[i + 2] > 220 && b[i + 1] < 90 && b[i] < 90) n++;
      return n;
    }, path);
    assert.ok(red > 200, `the marks are in the sent image (${red} red pixels)`);
    rmSync(path, { force: true });
  });

  await check('a document sent from another machine lands in the temp directory under its own name', async () => {
    const landed = await win.evaluate(() => window.devdeck.cockpit.receiveFile('build.log', btoa('step 1 ok\nstep 2 failed\n')));
    assert.match(landed, /devdeck-file-[0-9a-f-]{36}-build\.log$/);
    assert.equal(readFileSync(landed, 'utf8'), 'step 1 ok\nstep 2 failed\n');
    assert.equal(await win.evaluate(() => window.devdeck.cockpit.receiveFile('run.ps1', btoa('Remove-Item'))), null);
    rmSync(landed, { force: true });
  });

  assert.deepEqual(errors, [], 'no renderer errors');
} catch (e) {
  console.log('FAIL', e?.message ?? e);
  failed = true;
  try { const w = await app.firstWindow(); await w.screenshot({ path: join(shots, 'failure.png') }); } catch { /* window gone */ }
} finally {
  await closeElectron(app).catch(() => {});
}
if (failed) process.exitCode = 1;
