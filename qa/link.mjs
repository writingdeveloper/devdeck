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
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

async function launch(tag, registerFolder) {
  const userData = mkdtempSync(join(tmpdir(), `devdeck-rc-${tag}-`));
  // Its own temp directory. Both instances run against one filesystem here, so a pasted image landing
  // in the HOST's temp dir is the only thing that distinguishes "the bytes crossed the link and the
  // machine running the agent wrote the file" from "the local paste ran and typed a path that machine
  // cannot read" — which is the whole failure this feature exists to avoid, and it is silent.
  const temp = mkdtempSync(join(tmpdir(), `devdeck-tmp-${tag}-`));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    cwd: repo,
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});
  if (registerFolder) {
    // addFolder only accepts a directory blessed by the native picker, so drive the real handshake.
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, repo);
    await win.evaluate(async () => window.devdeck.pickFolder());
    await win.evaluate(async (p) => window.devdeck.addFolder(p, 'repo'), repo);
  }
  return { app, win, temp };
}

/** A port the OS says is free right now — asked of the OS rather than guessed. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
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
  // Bind somewhere nobody else is. A real DevDeck runs on the machine this harness runs on, and it
  // holds the default port — leaving the harness's host enabled but not listening, so pairing timed
  // out for a reason that had nothing to do with the code under test.
  const hostPort = await freePort();
  await host.win.evaluate(async (port) => window.devdeck.link.setPort(port), hostPort);
  result.hostPort = hostPort;

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

  // --- and it is a WORKING terminal, not merely a repainted screen ---
  // A tile picked up on connect must carry an id naming the machine that owns it. A bare one routes
  // its keystrokes into THIS machine's pty table, where nothing has that id: the session takes no
  // input and receives no output, while looking exactly like a healthy one that has gone quiet.
  //
  // The id is taken from the machine's own list rather than from whatever chunk happens to arrive: an
  // adopted session that is simply IDLE emits nothing, and waiting for it to speak made this report
  // "inert" on a perfectly healthy link about half the time — a check that cries wolf is not a check.
  // Asking, then typing, tests the same thing on demand.
  const adoptedStream = await viewer.win.evaluate(async () => {
    const machines = await window.devdeck.link.machines();
    const connected = machines.find((m) => m.state === 'connected');
    const running = connected ? await window.devdeck.machine(connected.machineId).cockpit.liveSessions() : [];
    const id = running[0]?.id ?? null;
    if (!id) return { id: null, total: 0 };
    let total = 0;
    window.devdeck.cockpit.onData((p) => { if (p.id === id) total += p.chunk.length; });
    window.devdeck.cockpit.input(id, 'echo devdeck-adopt-probe' + String.fromCharCode(13));
    await new Promise((r) => setTimeout(r, 6000));
    return { id, total };
  });
  result.adoptedIdIsQualified = typeof adoptedStream.id === 'string' && adoptedStream.id.startsWith('link:');
  result.adoptedBytesFlow = adoptedStream.total > 0;

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

  // --- one pty, two windows: whose size wins? ---
  // A pty has ONE size. Both machines are now attached to this session and each fits it to its own
  // window, so before this was negotiated the last one to lay out left the pty at ITS size and the
  // other went on drawing at a width the pty no longer had — ConPTY then repainted over the older,
  // wider paint, which is the split screen this was reported as. The rule is the multiplexers': the
  // pty ends up at the SMALLEST attached view, and the bigger window simply leaves space empty.
  const termSize = (win) => win.evaluate(() => {
    const tile = document.querySelector('.ck-term.show');
    const pane = document.getElementById('ck-terms');
    if (!tile) return null;
    const first = tile.querySelector('.xterm-rows')?.children[0];
    const rowH = first ? first.getBoundingClientRect().height : 0;
    return {
      // Stamped by the tile itself on every resize: a row of text is as long as its content, so the
      // drawn width cannot be read back off the screen.
      size: tile.dataset.termSize || null,
      // The most this window could show. Zero when the cockpit is not the visible view — a hidden
      // pane measures nothing, and a terminal there simply follows the pty.
      capacityRows: rowH && pane ? Math.floor(pane.clientHeight / rowH) : 0,
    };
  });
  const negotiate = async (hostBox, viewerBox) => {
    await host.win.setViewportSize(hostBox);
    await viewer.win.setViewportSize(viewerBox);
    await new Promise((r) => setTimeout(r, 7000));
    const h = await termSize(host.win);
    const v = await termSize(viewer.win);
    const rows = h?.size ? Number(h.size.split('x')[1]) : 0;
    const caps = [h?.capacityRows, v?.capacityRows].filter((n) => n > 0);
    return {
      host: h, viewer: v,
      agreed: !!h?.size && h.size === v?.size,
      // Nobody draws more rows than the windows that CAN measure are able to show.
      withinEveryVisiblePane: caps.length === 0 || rows <= Math.min(...caps),
    };
  };
  // Put the host back on its terminal first: a hidden pane measures nothing, and this case is only
  // interesting when BOTH windows can say how much they are able to show.
  await host.win.click('#shell-session-groups .shell-session').catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const bigHost = await negotiate({ width: 1500, height: 950 }, { width: 900, height: 620 });
  // Then swap which machine is the small one — AND make it a different small, so the agreed size
  // has to be recomputed rather than latched at whatever was settled first.
  const bigViewer = await negotiate({ width: 1100, height: 780 }, { width: 1500, height: 950 });
  // And with nothing constraining it, the terminal must be BIGGER than either constrained case —
  // otherwise "they agree" would pass just as well on a size that ignores the windows entirely.
  const bothBig = await negotiate({ width: 1500, height: 950 }, { width: 1500, height: 950 });
  const rowsOf = (n) => (n?.host?.size ? Number(n.host.size.split('x')[1]) : 0);
  result.sizeNegotiation = { bigHost, bigViewer, bothBig };
  // Two different smallest windows must produce two different agreed sizes: equal ones would pass
  // even if the size were simply never renegotiated.
  result.sizeFollowsWhicheverIsSmaller = !!bigHost.host?.size && !!bigViewer.host?.size && bigHost.host.size !== bigViewer.host.size;
  result.smallWindowActuallyConstrains = rowsOf(bothBig) > rowsOf(bigHost) && rowsOf(bothBig) > rowsOf(bigViewer);
  result.bothTerminalsAgreeOnSize = bigHost.agreed && bigViewer.agreed && bothBig.agreed;
  result.neitherDrawsMoreThanItCanShow = bigHost.withinEveryVisiblePane && bigViewer.withinEveryVisiblePane && bothBig.withinEveryVisiblePane;
  await host.win.setViewportSize({ width: 1280, height: 860 });
  await viewer.win.setViewportSize({ width: 1280, height: 860 });
  await new Promise((r) => setTimeout(r, 3000));


  // --- pasting a screenshot into a session that is running on the OTHER machine ---
  // The local paste writes a temp PNG here and types its path, which on a remote session names a file
  // that machine does not have — so the BYTES have to travel and the path that gets typed has to be
  // the HOST's. Nothing checked that end to end, and every part of it fails silently: the agent simply
  // reports a file it cannot read. Driven through a real Ctrl+V so the local-vs-remote branch in the
  // key handler is what decides, not the harness.
  // Watched at the PTY INPUT rather than on screen: what the paste types is sent to the agent, and
  // whether the agent happens to echo it back is its business, not this feature's.
  await viewer.app.evaluate(({ ipcMain, clipboard, nativeImage }, png) => {
    globalThis.__typed = '';
    ipcMain.on('cockpit:input', (_e, _id, data) => { globalThis.__typed += String(data); });
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png, 'base64')));
  }, await viewer.win.screenshot({ type: 'png' }).then((buf) => buf.toString('base64')));
  await viewer.win.evaluate(() => {
    const box = document.querySelector('.ck-term.show .xterm-helper-textarea');
    if (box) box.focus();
  });
  await viewer.win.waitForTimeout(300);
  await viewer.win.keyboard.press('Control+V');
  let pastedPath = null;
  for (let i = 0; i < 40 && !pastedPath; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const typed = await viewer.app.evaluate(() => globalThis.__typed || '');
    pastedPath = (typed.match(/[A-Za-z]:[^\s]*devdeck-paste-[0-9a-f-]+\.png/i) ?? [null])[0];
  }
  result.remotePasteTypedAPath = typeof pastedPath === 'string';
  // The decisive part: that file has to exist on the machine running the agent, not on this one.
  // Both instances share this filesystem, so WHERE the file is written is the proof: the host's own
  // temp directory means the bytes travelled and the machine running the agent wrote them.
  result.remotePasteLandedOnHost = !!pastedPath && existsSync(pastedPath) && pastedPath.toLowerCase().startsWith(host.temp.toLowerCase());
  result.remotePasteNotWrittenLocally = !!pastedPath && !pastedPath.toLowerCase().startsWith(viewer.temp.toLowerCase());

  // --- and an ORDINARY text paste into that same remote session still types the text ---
  // A remote paste asks for image bytes first. "No image on the clipboard" and "the read failed" are
  // the same answer, so treating it as a failure would swallow every text paste into a remote session
  // behind an error toast — silently, since the terminal simply would not receive what was pasted.
  const textMarker = `devdeck-text-paste-${Date.now()}`;
  await viewer.app.evaluate(({ clipboard }, text) => { globalThis.__typed = ''; clipboard.writeText(text); }, textMarker);
  await viewer.win.evaluate(() => document.querySelector('.ck-term.show .xterm-helper-textarea')?.focus());
  await viewer.win.waitForTimeout(250);
  await viewer.win.keyboard.press('Control+V');
  result.remoteTextPasteStillWorks = false;
  for (let i = 0; i < 25 && !result.remoteTextPasteStillWorks; i++) {
    await new Promise((r) => setTimeout(r, 300));
    result.remoteTextPasteStillWorks = (await viewer.app.evaluate(() => globalThis.__typed || '')).includes(textMarker);
  }

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

  // --- a session RENAMED on the host must be called that here too ---
  // The name is the only thing telling two sessions on one repository apart. Without it travelling
  // with the session, every one of a machine's sessions arrives under that machine's folder name and
  // the rows the user deliberately named apart become indistinguishable.
  const renamed = 'link-named-' + Date.now();
  await host.win.evaluate(async (label) => {
    const running = await window.devdeck.cockpit.liveSessions();
    if (running[0]) window.devdeck.cockpit.noteLabel(running[0].id, label);
  }, renamed);
  result.viewerSeesHostRename = await viewer.win.evaluate(async (label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const sessions = await window.devdeck.cockpit.loadSessions();
      if (sessions.some((s) => s.label === label)) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }, renamed);
  result.renameShowsInViewerSidebar = await viewer.win.evaluate((label) =>
    [...document.querySelectorAll('.ck-row, .shell-session')].some((n) => (n.textContent || '').includes(label)), renamed);

  // --- and renaming a session the viewer is only WATCHING must reach the machine running it ---
  // Same call the rename box makes; recording the name only here would leave the person sitting at
  // that machine — and every other deck watching it — on the folder name.
  const fromViewer = 'viewer-named-' + Date.now();
  await viewer.win.evaluate(async ([machineId, label]) => {
    const running = await window.devdeck.machine(machineId).cockpit.liveSessions();
    if (running[0]) window.devdeck.cockpit.noteLabel(running[0].id, label);
  }, [remoteId, fromViewer]);
  result.hostSeesViewerRename = await host.win.evaluate(async (label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const running = await window.devdeck.cockpit.liveSessions();
      if (running.some((s) => s.label === label)) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }, fromViewer);

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
  // Every boolean here is written so that TRUE is the working link; printing a false one and exiting 0
  // is how a broken one ships green — the exact way the black-rectangle release got through. Any check
  // reporting false, or a thrown error, fails the run. `exitCode` rather than `exit` so the two apps
  // below are still shut down instead of left as zombie harness instances.
  const failed = Object.entries(result).filter(([, value]) => value === false).map(([key]) => key);
  if (result.error) failed.unshift(`threw: ${result.error}`);
  if (failed.length) {
    console.error(`QA:LINK FAILED — ${failed.join(', ')}`);
    process.exitCode = 1;
  }
  await closeApp(host.app).catch(() => {});
  await closeApp(viewer.app).catch(() => {});
}
