// DevDeck Link end-to-end: does opening a project that lives on ANOTHER machine actually give a
// working terminal here?
//
// Two real DevDeck installs with separate user-data directories, paired by pressing the buttons a
// person presses, then the deck switched to the remote machine and one of its projects opened. The
// assertion that matters is the last one: bytes from the other machine's pty arriving in this one.
//
// Run with `npm run qa:link`. This launches TWO Electron instances, so do NOT run it alongside
// `npm run qa` — the deck-refresh reconciliation check in that harness reports false failures when
// another instance is competing for the machine.
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

async function launch(tag, registerFolder) {
  const userData = mkdtempSync(join(tmpdir(), `devdeck-rc-${tag}-`));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo,
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});
  if (registerFolder) {
    // addFolder only accepts a directory blessed by the native picker, so drive the real handshake.
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, repo);
    await win.evaluate(async () => window.devdeck.pickFolder());
    await win.evaluate(async (p) => window.devdeck.addFolder(p, 'repo'), repo);
  }
  return { app, win };
}

async function closeApp(app) {
  await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
  await app.close().catch(() => {});
}

const host = await launch('host', true);   // the machine with the project on it
const viewer = await launch('viewer', false);
const result = {};

try {
  // --- the host is already working when we connect to it ---
  const hostProject = await host.win.evaluate(async () => {
    const projects = await window.devdeck.listProjects();
    if (!projects.length) return null;
    const res = await window.devdeck.cockpit.open({
      projectPath: projects[0].path, sessionId: null, cols: 80, rows: 24, mode: 'new', agentId: 'claude',
    });
    return res.id || null;
  });
  result.hostStartedSessionFirst = !!hostProject;
  await new Promise((r) => setTimeout(r, 2500)); // let it print something worth repainting

  // --- pair, through the UI ---
  await host.win.click('.rail-item[data-view="settings"]');
  await host.win.waitForSelector('#settings-form .link-block .chip.chip-primary', { timeout: 15000 });
  await host.win.click('#settings-form .link-block .chip.chip-primary');
  await host.win.waitForSelector('#settings-form .link-code', { timeout: 15000 });
  const code = (await host.win.textContent('#settings-form .link-code')).trim();

  await viewer.win.click('.rail-item[data-view="settings"]');
  await viewer.win.fill('#settings-form .link-code-input', code);
  await viewer.win.click('#settings-form .link-add-row .chip');
  await viewer.win.waitForFunction(() => document.querySelector('#settings-form .link-state.is-connected') !== null, undefined, { timeout: 20000 });
  result.paired = true;

  // --- a session ALREADY running on the host must arrive here, with its screen ---
  // The scenario the feature is for: that machine is mid-work when you connect to it. Started BEFORE
  // pairing so this really tests the pull-on-connect path, not just live announcements.
  result.adoptedRunningSession = await viewer.win.evaluate(async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const sessions = await window.devdeck.cockpit.loadSessions();
      if (sessions.some((s) => typeof s.machineId === 'string' && s.machineId.length > 10)) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  });
  result.adoptedScreenRepainted = await viewer.win.evaluate(() =>
    [...document.querySelectorAll('.ck-term')].some((n) => (n.textContent || '').trim().length > 0));

  // --- the switcher appears only now that a machine is paired ---
  await viewer.win.click('.rail-item[data-view="projects"]');
  await viewer.win.waitForFunction(
    () => { const s = document.getElementById('machine-switch'); return s && !s.classList.contains('hidden'); },
    undefined, { timeout: 15000 },
  );
  result.switcherAppeared = true;
  result.switcherOptions = await viewer.win.evaluate(() =>
    [...document.getElementById('machine-switch').options].map((o) => o.textContent));

  // --- the viewer's own deck is empty (no folders registered here) ---
  result.localProjectCount = await viewer.win.evaluate(() => document.querySelectorAll('#cards .card, #cards .prow').length);

  // --- switch to the host and read ITS projects ---
  const remoteId = await viewer.win.evaluate(() =>
    [...document.getElementById('machine-switch').options].map((o) => o.value).find((v) => v !== 'local'));
  await viewer.win.selectOption('#machine-switch', remoteId);
  await viewer.win.waitForFunction(
    () => document.querySelectorAll('#cards .card, #cards .prow').length > 0,
    undefined, { timeout: 20000 },
  );
  result.remoteProjectCount = await viewer.win.evaluate(() => document.querySelectorAll('#cards .card, #cards .prow').length);
  result.remoteProjectName = await viewer.win.evaluate(() => {
    const row = document.querySelector('#cards .card, #cards .prow');
    return row?.textContent?.slice(0, 40) ?? null;
  });
  result.switcherMarkedRemote = await viewer.win.evaluate(() =>
    document.getElementById('machine-switch').classList.contains('is-remote'));

  // --- open it the way a person does: press the project's Open button on the remote deck ---
  // Driving cockpit.open directly would prove the transport but skip everything the app does around
  // it — the tile, the sidebar row, and what gets written to disk for the next launch.
  await viewer.win.click('#cards .provider-open-primary');
  await viewer.win.waitForFunction(
    () => document.querySelectorAll('.ck-term').length > 0,
    undefined, { timeout: 25000 },
  );
  // --- bytes actually arrive from the other machine ---
  // Observed at the stream itself rather than through a test-only hook in the app: whatever id the
  // chunks carry IS the tile's id, and it must be one qualified with the machine that owns it.
  const streamed = await viewer.win.evaluate(() => new Promise((resolve) => {
    let total = 0;
    let seenId = null;
    window.devdeck.cockpit.onData(({ id, chunk }) => { seenId = id; total += chunk.length; });
    setTimeout(() => { if (seenId) window.devdeck.cockpit.input(seenId, 'echo devdeck-link-probe' + String.fromCharCode(13)); }, 1500);
    setTimeout(() => resolve({ total, seenId }), 8000);
  }));
  result.bytesFromRemote = streamed.total;
  result.streamWorks = streamed.total > 0;
  result.remoteTileId = typeof streamed.seenId === 'string' ? streamed.seenId.slice(0, 5) : null;
  result.idIsQualified = typeof streamed.seenId === 'string' && streamed.seenId.startsWith('link:');

  // --- and the reverse: a session the VIEWER started must appear on the host's own deck ---
  // Otherwise the person sitting at that machine sees an agent working with no tile to look at, and
  // loses it entirely on the next restart, since only tiles are persisted.
  result.hostAdoptedViewerSession = await host.win.evaluate(async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const sessions = await window.devdeck.cockpit.loadSessions();
      if (sessions.length >= 2) return true; // its own, plus the one opened from the other machine
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  });

  // --- a note written on a remote project must land THERE, not here ---
  // This is the decisive check for a whole family of silent bugs: everything keyed by a project PATH
  // (notes, pins, task lists, costs, memory) belongs to the machine holding the project, and the same
  // path exists on both machines. Writing locally would attach it to unrelated work and look fine.
  const marker = 'devdeck-link-note-' + Date.now();
  const remoteProjectPath = await viewer.win.evaluate(async (id) => {
    const projects = await window.devdeck.machine(id).listProjects();
    return projects[0]?.path ?? null;
  }, remoteId);
  await viewer.win.evaluate(async ([id, path, note]) => {
    await window.devdeck.machine(id).setNote(path, note);
  }, [remoteId, remoteProjectPath, marker]);
  await new Promise((r) => setTimeout(r, 400));
  result.noteLandedOnHost = await host.win.evaluate(async (path) => {
    const projects = await window.devdeck.listProjects();
    return projects.some((p) => p.path === path && p.note.includes('devdeck-link-note-'));
  }, remoteProjectPath);
  result.noteDidNotLandLocally = await viewer.win.evaluate(async (path) => {
    const projects = await window.devdeck.listProjects();
    return !projects.some((p) => p.path === path && p.note.includes('devdeck-link-note-'));
  }, remoteProjectPath);
  await viewer.win.evaluate(async ([id, path]) => window.devdeck.machine(id).setNote(path, ''), [remoteId, remoteProjectPath]);

  // --- the host knows a viewer is watching, which is what vetoes its idle shutdown ---
  const hostStatus = await host.win.evaluate(async () => window.devdeck.link.hostStatus());
  result.hostConnections = hostStatus.connections.length;
  result.hostSeesAttached = hostStatus.connections[0]?.attachedSessions?.length > 0;

  // --- the tile says which machine it is on, or two same-named repos are indistinguishable ---
  await viewer.win.click('.rail-item[data-view="cockpit"]').catch(() => {});
  result.sidebarMarksRemote = await viewer.win.evaluate(() =>
    [...document.querySelectorAll('.rail-session, .ck-row, [data-session-id]')]
      .some((n) => (n.textContent || '').includes('⇄')));

  // --- a saved tile remembers its machine, or a restart reopens it against a local path that means
  //     something entirely different here ---
  const persisted = await viewer.win.evaluate(async () => window.devdeck.cockpit.loadSessions());
  result.persistedCount = persisted.length;
  result.persistedCarriesMachine = persisted.some((entry) => typeof entry.machineId === 'string' && entry.machineId.length > 10);

  // --- the host going away must not wedge the viewer: it reports offline and reconnects on its own ---
  await closeApp(host.app);
  await viewer.win.waitForFunction(
    () => (window.__lastMachines = null, window.devdeck.link.machines().then((m) => { window.__lastMachines = m; })),
    undefined, { timeout: 5000 },
  ).catch(() => {});
  const offlineDeadline = Date.now() + 25000;
  let offlineState = null;
  while (Date.now() < offlineDeadline) {
    const machines = await viewer.win.evaluate(async () => window.devdeck.link.machines());
    offlineState = machines[0]?.state ?? null;
    if (offlineState !== 'connected') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  result.stateAfterHostQuit = offlineState;
  result.viewerSurvivedHostQuit = offlineState !== null && offlineState !== 'connected';
  result.viewerStillAlive = await viewer.win.evaluate(() => document.getElementById('machine-switch') !== null);
} catch (err) {
  result.error = String(err).split('\n').slice(0, 2).join(' | ');
} finally {
  console.log(JSON.stringify(result, null, 2));
  await closeApp(host.app).catch(() => {});
  await closeApp(viewer.app).catch(() => {});
}
