// Verifies the image strip, viewer and 📎 attach in the real app, against an isolated HOME and a
// fixture `claude` that echoes what it is sent. Never starts a real agent.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows harness (fixture claude.cmd on PATH). Run with npm run qa:images.
const root = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
const shots = resolve(process.argv[3] ?? join(root, 'qa', 'shots', 'images'));
mkdirSync(shots, { recursive: true });
const { closeElectron } = await import('file:///' + join(root, 'qa', 'electron-lifecycle.mjs').replace(/\\/g, '/'));

const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-images-'));
const repo = join(sandbox, 'image-workspace');
const bin = join(sandbox, 'bin');
const profile = join(sandbox, 'profile');
const home = join(profile, 'home');
for (const p of [repo, bin, profile, home]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-images'], { cwd: repo });
// An echoing agent: whatever is pasted into it shows up on its screen.
writeFileSync(join(bin, 'echo.js'), "process.stdout.write('FIXTURE_READY\\r\\n'); if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.on('data', (d) => process.stdout.write('GOT:' + d.toString().replace(/\\r/g, '') + '\\r\\n'));\n");
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0echo.js"\r\n');

// A transcript with a tool screenshot, a pasted image and an image file the agent wrote.
const sid = '3f6c2a1e-1111-4222-8333-944455556666';
const pngA = readFileSync(join(root, 'docs', 'demo', 'poster.png')).toString('base64');
const pngB = readFileSync(join(root, 'build', 'icon.png')).toString('base64');
copyFileSync(join(root, 'build', 'icon.png'), join(repo, 'render.png'));
// What a peer must NOT be able to read through the image methods: a non-image named .png, a real
// image outside the project, and one reached through a junction inside the project.
writeFileSync(join(repo, 'secret.png'), 'not an image: TOKEN=abc');
const outside = join(sandbox, 'outside'); mkdirSync(outside);
copyFileSync(join(root, 'build', 'icon.png'), join(outside, 'private.png'));
symlinkSync(outside, join(repo, 'linked'), 'junction');
const ts = new Date().toISOString();
const enc = repo.replace(/[^a-zA-Z0-9]/g, '-');
const tdir = join(home, '.claude', 'projects', enc);
mkdirSync(tdir, { recursive: true });
const lines = [
  { type: 'user', timestamp: ts, cwd: repo, sessionId: sid, message: { role: 'user', content: 'take a screenshot' } },
  { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__playwright__browser_take_screenshot', input: {} }] } },
  { type: 'user', timestamp: ts, message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngA } }] }] } },
  { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB } }, { type: 'text', text: 'like this' }] } },
  { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: 'render.png', content: '' } }] } },
];
writeFileSync(join(tdir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings: {
  language: 'ko', folders: [{ path: repo, kind: 'repo' }], viewMode: 'list',
  cockpitSessions: [{ tileId: 'tile-img-1', projectPath: repo, name: 'image-workspace', sessionId: sid, agentId: 'claude', label: 'Images QA', lastActiveMs: Date.now() }],
} }));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = bin + ';' + env[pathKey];
const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu'], cwd: root, env });
const errors = [];
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); console.log('PASS ' + name); };
try {
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.setViewportSize?.({ width: 1440, height: 900 });

  await check('restored session opens in the cockpit', async () => {
    await win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.waitForFunction(() => document.querySelector('#ck-header')?.textContent.includes('Images QA'));
    await win.waitForFunction(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.includes('FIXTURE_READY')), null, { timeout: 20000 });
  });

  await check('header shows the image toggle with the session image count', async () => {
    await win.waitForFunction(() => document.querySelector('#ck-header .ck-img-count')?.textContent === '3');
  });

  await check('toggle opens the strip with three thumbnails, newest first', async () => {
    await win.locator('#ck-header button[aria-pressed]').click();
    await win.waitForFunction(() => document.querySelectorAll('#ck-images .ck-img-thumb img[src^="data:image"]').length === 3);
    const kinds = await win.evaluate(() => [...document.querySelectorAll('#ck-images .ck-img-thumb')].map((b) => b.className.match(/kind-(\w+)/)[1]));
    assert.deepEqual(kinds, ['file', 'pasted', 'screenshot']);
    await win.screenshot({ path: join(shots, '1-strip.png') });
  });

  await check('a thumbnail opens the full viewer; arrows step, Esc closes', async () => {
    await win.locator('#ck-images .ck-img-thumb.kind-screenshot').click();
    await win.waitForFunction(() => document.querySelector('.ck-img-viewer .ck-img-stage img')?.getAttribute('src')?.startsWith('data:image'));
    const caption = await win.locator('.ck-img-caption').textContent();
    assert.match(caption, /playwright · browser_take_screenshot/);
    assert.equal(await win.locator('.ck-img-counter').textContent(), '3 / 3');
    await win.screenshot({ path: join(shots, '2-viewer.png') });
    await win.keyboard.press('ArrowLeft');
    await win.waitForFunction(() => document.querySelector('.ck-img-counter')?.textContent === '2 / 3');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.ck-img-viewer', { state: 'detached' });
  });

  await check('📎 attach types the picked file path into the session', async () => {
    const chooser = win.waitForEvent('filechooser');
    await win.locator('#ck-header button[title="파일 첨부"]').click();
    const fc = await chooser;
    await fc.setFiles(join(repo, 'render.png'));
    await win.waitForFunction((p) => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.replace(/\s/g, '').includes(p.replace(/\s/g, ''))), join(repo, 'render.png'), { timeout: 10000 });
    await win.screenshot({ path: join(shots, '3-attached.png') });
  });

  await check('image reads refuse non-images, paths outside the project, and junction escapes', async () => {
    const read = (fp) => win.evaluate(([r, f]) => window.devdeck.cockpit.imageFile(r, f, 'thumb'), [repo, fp]);
    assert.ok(await read('render.png'), 'a real image in the project is served');
    assert.equal(await read('secret.png'), null, 'a non-image named .png');
    assert.equal(await read(join(outside, 'private.png')), null, 'an absolute path outside the folders');
    assert.equal(await read('../outside/private.png'), null, 'a relative escape');
    assert.equal(await read('linked/private.png'), null, 'a junction out of the project');
    const bogus = await win.evaluate(([r]) => window.devdeck.cockpit.sessionImage(r, '3f6c2a1e-1111-4222-8333-944455556666', 'f:secret.png', 'full'), [repo]);
    assert.equal(bogus, null, 'an id the session index does not hold');
  });

  await check('a new image in the transcript shows up as unseen when the strip is closed', async () => {
    await win.locator('#ck-header button[aria-pressed="true"]').click(); // close
    writeFileSync(join(tdir, sid + '.jsonl'), readFileSync(join(tdir, sid + '.jsonl'), 'utf8') + JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB } }] } }) + '\n');
    // Re-select to refresh (a turn end does the same in real use).
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    await win.locator('#shell-session-groups .shell-session').first().click();
    await win.waitForFunction(() => {
      const n = document.querySelector('#ck-header .ck-img-count');
      return !!n && (n.textContent === '+1' || n.textContent === '4');
    }, null, { timeout: 40000 });
  });

  assert.deepEqual(errors, [], 'no page/console errors');
  console.log(`done: ${passed.length} passed`);
} catch (e) {
  console.log('FAIL', e?.message ?? e);
  try { const w = await app.firstWindow(); await w.screenshot({ path: join(shots, 'fail.png') }); } catch {}
  console.log('errors:', errors);
  process.exitCode = 1;
} finally {
  await closeElectron(app);
}
