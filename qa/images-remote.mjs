// Windows harness: a host and a paired viewer, real TLS, fixture CLI. From the viewer, a session on
// the host shows the images its transcript holds, opens them full size, and takes an attached JPEG
// (sent as PNG and typed as the host's path); the image methods refuse what they must over the link.
// Never starts a real agent. Run with npm run qa:images-remote.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeElectron } from './electron-lifecycle.mjs';
import { sandboxDir } from './sandbox.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shots = resolve(process.env.DEVDECK_IMAGES_OUT || join(root, 'qa', 'shots', 'images-remote'));
mkdirSync(shots, { recursive: true });
const sandbox = sandboxDir('devdeck-images-remote-');
const repo = join(sandbox, 'host-workspace');
const bin = join(sandbox, 'bin');
for (const p of [repo, bin]) mkdirSync(p, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'qa-remote-images'], { cwd: repo });
writeFileSync(join(bin, 'echo.js'), "if (process.argv.includes('agents')) { process.stdout.write('[]'); process.exit(0); } process.stdout.write('FIXTURE_READY\\r\\n'); if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.on('data', (d) => process.stdout.write('GOT:' + d.toString().replace(/\\r/g, '') + '\\r\\n'));\n");
writeFileSync(join(bin, 'claude.cmd'), '@echo off\r\nnode "%~dp0echo.js"\r\n');
copyFileSync(join(root, 'build', 'icon.png'), join(repo, 'render.png'));
writeFileSync(join(repo, 'secret.png'), 'not an image: TOKEN=abc');

const sid = '7c3d4e5f-1111-4222-8333-944455556666';
const png = readFileSync(join(root, 'docs', 'demo', 'poster.png')).toString('base64');
const ts = new Date().toISOString();
const transcript = [
  { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__playwright__browser_take_screenshot', input: {} }] } },
  { type: 'user', timestamp: ts, message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } },
  { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: 'render.png', content: '' } }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n';

const apps = [];
async function launch(name, seed) {
  const profile = join(sandbox, name.replace(/\W/g, '-')); const home = join(profile, 'home');
  mkdirSync(home, { recursive: true });
  const settings = { language: 'ko', machineName: name, folders: seed ? [{ path: repo, kind: 'repo' }] : [], viewMode: 'list' };
  if (seed) {
    const tdir = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, sid + '.jsonl'), transcript);
    settings.cockpitSessions = [{ tileId: 'tile-remote-img', projectPath: repo, name: 'host-workspace', sessionId: sid, agentId: 'claude', label: 'Remote images QA', lastActiveMs: Date.now() }];
  }
  writeFileSync(join(profile, 'state.json'), JSON.stringify({ projects: {}, settings }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDECODE: '', CLAUDE_CODE_SSE_PORT: '', CLAUDE_CODE_ENTRYPOINT: '' };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = bin + ';' + env[pathKey];
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + profile, '--no-sandbox', '--disable-gpu'], cwd: root, env });
  apps.push(app);
  const win = await app.firstWindow(); win.setDefaultTimeout(20000);
  await app.evaluate(({ app: a }) => {
    const require = process.getBuiltinModule('module').createRequire(a.getAppPath() + '/package.json');
    require(a.getAppPath() + '/dist/main/link/portMap.js').mapPort = async () => ({ state: 'not-found' }); // no router mappings from a test
  });
  return { app, win };
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const errors = [];
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
const rowsInclude = (win, text) => win.waitForFunction((t) => [...document.querySelectorAll('.ck-term.show .xterm-rows')].some((r) => r.textContent.replace(/\s/g, '').includes(t)), text, { timeout: 15000 });

try {
  if (process.platform !== 'win32') { console.log('SKIP: Windows native PTY required'); process.exit(0); }
  const host = await launch('Image host', true);
  host.win.on('pageerror', (e) => errors.push('host: ' + e));
  await host.win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
  await host.win.locator('#shell-session-groups .shell-session').first().click();
  await rowsInclude(host.win, 'FIXTURE_READY');
  await host.win.evaluate((p) => window.devdeck.link.setPort(p), await freePort());
  const viewer = await launch('Image viewer', false);
  viewer.win.on('pageerror', (e) => errors.push('viewer: ' + e));
  viewer.win.on('console', (m) => { if (m.type() === 'error') errors.push('viewer: ' + m.text()); });
  const status = await host.win.evaluate(() => window.devdeck.link.createInvite(['observe', 'control', 'spawn', 'write']));
  assert.ok(status.listening && status.invite?.code, 'host is listening with an invite');
  const added = await viewer.win.evaluate((code) => window.devdeck.link.addMachine(code), status.invite.code);
  assert.equal(added.ok, true);
  const machineId = status.machineId;

  await check('the viewer opens the host session and sees its image count', async () => {
    await viewer.win.waitForSelector('#shell-session-groups .shell-session', { timeout: 30000 });
    await viewer.win.locator('#shell-session-groups .shell-session').first().click();
    await viewer.win.waitForFunction(() => document.querySelector('#ck-header')?.textContent.includes('Remote images QA'));
    await viewer.win.waitForFunction(() => document.querySelector('#ck-header .ck-img-count')?.textContent === '2', null, { timeout: 40000 });
  });

  await check('thumbnails and the full view travel over the link', async () => {
    await viewer.win.locator('#ck-header button.ck-img-toggle').click();
    await viewer.win.waitForFunction(() => document.querySelectorAll('#ck-images .ck-img-thumb img[src^="data:image"]').length === 2);
    await viewer.win.locator('#ck-images .ck-img-thumb.kind-screenshot').click();
    await viewer.win.waitForFunction(() => document.querySelector('.ck-img-viewer .ck-img-stage img')?.getAttribute('src')?.startsWith('data:image'));
    await viewer.win.screenshot({ path: join(shots, 'viewer-full.png') });
    await viewer.win.keyboard.press('Escape');
  });

  await check('a JPEG attached on the viewer lands on the host as PNG and its host path is typed', async () => {
    const jpg = join(sandbox, 'photo.jpg');
    await host.app.evaluate(({ nativeImage }, [src, dst]) => {
      require('node:fs').writeFileSync(dst, nativeImage.createFromPath(src).toJPEG(80));
    }, [join(root, 'build', 'icon.png'), jpg]).catch(async () => {
      // `require` is not in scope inside evaluate on every Electron build; fall back to the module loader.
      await host.app.evaluate(({ nativeImage, app: a }, [src, dst]) => {
        const req = process.getBuiltinModule('module').createRequire(a.getAppPath() + '/package.json');
        req('node:fs').writeFileSync(dst, nativeImage.createFromPath(src).toJPEG(80));
      }, [join(root, 'build', 'icon.png'), jpg]);
    });
    const chooser = viewer.win.waitForEvent('filechooser');
    await viewer.win.locator('#ck-header .ck-act').filter({ has: viewer.win.locator('svg') }).and(viewer.win.locator('[title*="이미지·문서 첨부"]')).click();
    await (await chooser).setFiles(jpg);
    await rowsInclude(viewer.win, 'devdeck-paste-');
    const typed = await host.win.evaluate(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].map((r) => r.textContent).join('\n'));
    const m = /GOT:(\S*devdeck-paste-[0-9a-f-]+\.png)/.exec(typed.replace(/\n/g, ''));
    assert.ok(m, 'host typed a pasted-image path:\n' + typed);
    const head = readFileSync(m[1]).subarray(0, 8);
    assert.equal(head.toString('hex'), '89504e470d0a1a0a', 'the file on the host is a PNG');
    await viewer.win.screenshot({ path: join(shots, 'viewer-attached.png') });
  });

  await check('a log file attached on the viewer lands on the host under its own name and its host path is typed', async () => {
    const log = join(sandbox, 'build.log');
    writeFileSync(log, 'step 1 ok\nstep 2 failed\n');
    const chooser = viewer.win.waitForEvent('filechooser');
    await viewer.win.locator('#ck-header .ck-act[title*="이미지·문서 첨부"]').click();
    await (await chooser).setFiles(log);
    await rowsInclude(viewer.win, 'build.log');
    const typed = await host.win.evaluate(() => [...document.querySelectorAll('.ck-term.show .xterm-rows')].map((r) => r.textContent).join('\n'));
    const m = /GOT:(\S*devdeck-file-[0-9a-f-]{36}-build\.log)/.exec(typed.replace(/\n/g, ''));
    assert.ok(m, 'host typed the sent file path:\n' + typed);
    assert.equal(readFileSync(m[1], 'utf8'), 'step 1 ok\nstep 2 failed\n');
  });

  await check('over the link, a real image is served and a fake .png or unindexed id is refused', async () => {
    const r = await viewer.win.evaluate(async ([id, path]) => {
      const m = window.devdeck.machine(id).cockpit;
      return {
        real: !!(await m.imageFile(path, 'render.png', 'thumb')),
        fake: await m.imageFile(path, 'secret.png', 'thumb'),
        unindexed: await m.sessionImage(path, '7c3d4e5f-1111-4222-8333-944455556666', 'f:secret.png', 'full'),
      };
    }, [machineId, repo]);
    assert.deepEqual(r, { real: true, fake: null, unindexed: null });
  });

  await check('a Claude in Chrome screenshot in the host temp directory travels; other temp files do not', async () => {
    const shotDir = mkdtempSync(join(tmpdir(), 'claude-chrome-screenshots-'));
    const other = sandboxDir('devdeck-qa-other-');
    copyFileSync(join(root, 'build', 'icon.png'), join(shotDir, 'screenshot-1-1.jpg'));
    copyFileSync(join(root, 'build', 'icon.png'), join(other, 'shot.png'));
    try {
      const r = await viewer.win.evaluate(async ([id, path, shot, stray]) => {
        const m = window.devdeck.machine(id).cockpit;
        return { shot: !!(await m.imageFile(path, shot, 'full')), stray: await m.imageFile(path, stray, 'full') };
      }, [machineId, repo, join(shotDir, 'screenshot-1-1.jpg'), join(other, 'shot.png')]);
      assert.deepEqual(r, { shot: true, stray: null });
    } finally {
      rmSync(shotDir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
    }
  });

  assert.deepEqual(errors, [], 'no page/console errors');
  console.log('done');
} catch (e) {
  console.log('FAIL', e?.message ?? e);
  console.log('errors:', errors);
  process.exitCode = 1;
} finally {
  for (const a of apps) await closeElectron(a).catch(() => {});
}
