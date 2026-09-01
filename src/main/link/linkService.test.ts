/**
 * The user's actual flow, end to end: press "copy code" on one machine, paste it on another, and work.
 *
 * Two full LinkServices are stood up against each other over real TLS, each with its own identity
 * file and its own store — which is as close to two installs as a test can get without two machines.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const clipboardText = { value: '' };
vi.mock('electron', () => ({
  clipboard: { readText: () => clipboardText.value },
}));

import { createLinkService, retryDelayForFailure, type LinkPersistence, type LinkService } from './linkService';
import { makeMethodTable, allow, blocked } from '../api/methods';
import { makeEventHub, type EventHub } from '../api/events';
import type { DeckApiBundle } from '../api/deckApi';
import type { SafeStorageLike } from './identity';
import type { KnownHost, PairedDevice } from './devices';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from(`enc:${t}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};

function memoryStore(port: number): LinkPersistence {
  let hostMode = false;
  let devices: PairedDevice[] = [];
  let hosts: KnownHost[] = [];
  let boundPort = port;
  return {
    getHostMode: () => hostMode,
    setHostMode: (on) => { hostMode = on; },
    getPort: () => boundPort,
    setPort: (p) => { boundPort = p; },
    getPairedDevices: () => devices,
    setPairedDevices: (d) => { devices = d; },
    getKnownHosts: () => hosts,
    setKnownHosts: (h) => { hosts = h; },
  };
}

interface Fixture {
  service: LinkService;
  events: EventHub;
  opened: string[];
  dir: string;
}

const dirs: string[] = [];
const services: LinkService[] = [];

function makeApi(opened: string[]): { bundle: DeckApiBundle; events: EventHub } {
  const table = makeMethodTable();
  table.invoke('projects:list', allow('observe'), () => [{ path: 'C:\\remote-repo', name: 'remote-repo' }]);
  table.invoke('cockpit:open', allow('spawn'), (req: { projectPath: string }) => {
    opened.push(req.projectPath);
    return { id: `${req.projectPath}#1`, agentId: 'claude', sessionId: 'sess-a' };
  });
  table.send('cockpit:input', allow('control'), () => undefined);
  table.send('cockpit:resize', allow('control'), () => undefined);
  table.invoke('settings:addFolder', blocked('native picker only'), () => []);
  const events = makeEventHub();
  return { bundle: { methods: table.table, events }, events };
}

function makeService(name: string, over: Partial<Parameters<typeof createLinkService>[0]> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `devdeck-link-${name}-`));
  dirs.push(dir);
  const opened: string[] = [];
  const { bundle, events } = makeApi(opened);
  const service = createLinkService({
    userDataDir: dir,
    safeStorage,
    api: bundle,
    machineId: over.machineId ?? '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    machineName: () => name,
    appVersion: '1.34.1',
    store: memoryStore(0),
    onError: () => { /* surfaced to the user in the app; noise here */ },
    ...over,
  });
  services.push(service);
  return { service, events, opened, dir };
}

/** A port nothing is listening on right now — a host that restarts must come back on the SAME port. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
  });
}

/** Poll until `cond` holds; the link settles on real sockets and real timers. */
async function waitFor(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => { clipboardText.value = ''; });
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('pairing two machines the way a person does', () => {
  it('copies a code on one machine, pastes it on the other, and works', async () => {
    const host = makeService('SIHYEONG-MAIN');
    const viewer = makeService('laptop', { machineId: '11111111-2222-4333-8444-555555555555' });

    // Asking for a code IS asking to accept connections — no separate switch to forget to flip.
    const withInvite = await host.service.createInvite();
    expect(withInvite.enabled).toBe(true);
    expect(withInvite.listening).toBe(true);
    expect(withInvite.invite?.code).toMatch(/^DDLINK1\./);

    const added = await viewer.service.addMachine(withInvite.invite!.code);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.machine.state).toBe('connected');
    expect(added.machine.machineName).toBe('SIHYEONG-MAIN');

    // And the other machine's deck is readable from here.
    await expect(viewer.service.call(added.machine.machineId, 'projects:list', []))
      .resolves.toEqual([{ path: 'C:\\remote-repo', name: 'remote-repo' }]);

    // The host now knows the device, and its own screen can show it.
    expect(host.service.hostStatus().devices).toHaveLength(1);
    expect(host.service.hostStatus().connections[0]?.machineName).toBeDefined();
  });

  it('spends the code once — a second machine cannot reuse it', async () => {
    // A code that still works after it worked is a code that is still live when it is pasted into the
    // wrong window later.
    const host = makeService('host');
    const first = makeService('first', { machineId: '11111111-2222-4333-8444-555555555555' });
    const second = makeService('second', { machineId: '22222222-3333-4444-8555-666666666666' });

    const status = await host.service.createInvite();
    const code = status.invite!.code;

    expect((await first.service.addMachine(code)).ok).toBe(true);
    expect(host.service.hostStatus().invite).toBeNull();

    const reused = await second.service.addMachine(code);
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.problem).toBe('dial');
    expect(host.service.hostStatus().devices).toHaveLength(1);
  });

  it('names the problem when the pasted text is not a usable code', async () => {
    const viewer = makeService('laptop');
    expect(await viewer.service.addMachine('hello')).toEqual({ ok: false, problem: 'not-a-code' });
    expect(await viewer.service.addMachine('')).toEqual({ ok: false, problem: 'not-a-code' });
  });

  it('reports an expired code as expired rather than as a broken one', async () => {
    const host = makeService('host');
    const status = await host.service.createInvite();
    // Same code, read five minutes later.
    const viewer = makeService('laptop', {
      machineId: '11111111-2222-4333-8444-555555555555',
      now: () => Date.now() + 6 * 60_000,
    });
    expect(await viewer.service.addMachine(status.invite!.code)).toEqual({ ok: false, problem: 'expired' });
  });
});

describe('the clipboard banner', () => {
  it('offers a code that is already in the clipboard', async () => {
    // The usual case should be one click, not a paste into an empty field.
    const host = makeService('SIHYEONG-MAIN');
    const viewer = makeService('laptop', { machineId: '11111111-2222-4333-8444-555555555555' });
    const status = await host.service.createInvite();
    clipboardText.value = `여기 코드: ${status.invite!.code}`;
    expect(viewer.service.clipboardInvite()).toEqual({ code: status.invite!.code, machineName: 'SIHYEONG-MAIN' });
  });

  it('stays quiet for unrelated clipboard contents', () => {
    const viewer = makeService('laptop');
    clipboardText.value = 'git commit -m "wip"';
    expect(viewer.service.clipboardInvite()).toBeNull();
  });

  it('stays quiet once that machine is already paired — re-adding it would be a confusing no-op', async () => {
    const host = makeService('SIHYEONG-MAIN');
    const viewer = makeService('laptop', { machineId: '11111111-2222-4333-8444-555555555555' });
    const first = await host.service.createInvite();
    await viewer.service.addMachine(first.invite!.code);

    const second = await host.service.createInvite();
    clipboardText.value = second.invite!.code;
    expect(viewer.service.clipboardInvite()).toBeNull();
  });
});

describe('revoking access', () => {
  it('cuts the live connection, not just the next one', async () => {
    const host = makeService('SIHYEONG-MAIN');
    const viewer = makeService('laptop', { machineId: '11111111-2222-4333-8444-555555555555' });
    const status = await host.service.createInvite();
    const added = await viewer.service.addMachine(status.invite!.code);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const fingerprint = host.service.hostStatus().devices[0].fingerprint;
    host.service.revokeDevice(fingerprint);
    await new Promise((r) => setTimeout(r, 100));

    expect(host.service.hostStatus().devices).toHaveLength(0);
    expect(host.service.hostStatus().connections).toHaveLength(0);
    // And the viewer cannot get back in on the strength of having been paired before.
    await expect(viewer.service.call(added.machine.machineId, 'projects:list', [])).rejects.toThrow();
  });

  it('narrowing permissions takes effect immediately, not on the next connection', async () => {
    const host = makeService('SIHYEONG-MAIN');
    const viewer = makeService('laptop', { machineId: '11111111-2222-4333-8444-555555555555' });
    const status = await host.service.createInvite();
    const added = await viewer.service.addMachine(status.invite!.code);
    if (!added.ok) throw new Error('expected pairing');

    await expect(viewer.service.call(added.machine.machineId, 'cockpit:open', [{ projectPath: 'C:\\remote-repo' }])).resolves.toBeTruthy();

    host.service.setDevicePermissions(host.service.hostStatus().devices[0].fingerprint, ['observe']);

    // Narrowing drops the live connection rather than letting it finish on the old permissions, so
    // the viewer's terminals go quiet for a moment and the link comes back on its own. Waiting for
    // that is the point: the reconnection has to happen without anyone touching a setting.
    // Polling on "connected" alone would pass on the STILL-OPEN old connection: the drop is
    // asynchronous, and the permissions a viewer reports come from the handshake it is holding. What
    // is being waited for is a NEW handshake carrying the narrowed set.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const [machine] = viewer.service.machines();
      if (machine?.state === 'connected' && machine.permissions.length === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(viewer.service.machines()[0].state).toBe('connected');
    expect(viewer.service.machines()[0].permissions).toEqual(['observe']);

    await expect(viewer.service.call(added.machine.machineId, 'cockpit:open', [{ projectPath: 'C:\\remote-repo' }]))
      .rejects.toThrow(/not permitted/);
    expect(host.opened).toEqual(['C:\\remote-repo']); // only the first call ever reached the handler
  }, 15_000);
});

describe('host mode', () => {
  it('is off until it is turned on — an update must not open a port on its own', () => {
    const host = makeService('host');
    const status = host.service.hostStatus();
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
  });

  it('stops listening and drops the invite when turned off', async () => {
    const host = makeService('host');
    await host.service.createInvite();
    expect(host.service.hostStatus().listening).toBe(true);
    const off = await host.service.setHostMode(false);
    expect(off.listening).toBe(false);
    expect(off.invite).toBeNull();
  });

  it('advertises a fingerprint and at least one address for the code to carry', async () => {
    const host = makeService('host');
    const status = await host.service.createInvite();
    expect(status.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(status.addresses.length).toBeGreaterThan(0);
  });
});

describe('what a refusal means for the next attempt', () => {
  const steps = [100, 200, 300];
  it('keeps trying a host that turned host mode off, and one mid-update, but never an impostor', () => {
    expect(retryDelayForFailure({ kind: 'refused', code: 'host-unavailable', message: '' }, 0, steps)).toBe(100);
    expect(retryDelayForFailure({ kind: 'refused', code: 'host-unavailable', message: '' }, 9, steps)).toBe(300);
    expect(retryDelayForFailure({ kind: 'refused', code: 'protocol-mismatch', message: '' }, 0, steps)).toBe(5 * 60_000);
    expect(retryDelayForFailure({ kind: 'refused', code: 'rate-limited', message: '' }, 0, steps)).toBe(60_000);
    expect(retryDelayForFailure({ kind: 'unreachable', tried: [], attempts: [], lastError: '' }, 1, steps)).toBe(200);
    expect(retryDelayForFailure({ kind: 'tls', address: 'a', error: '' }, 0, steps)).toBe(100);
    expect(retryDelayForFailure({ kind: 'refused', code: 'unpaired', message: '' }, 0, steps)).toBeNull();
    expect(retryDelayForFailure({ kind: 'refused', code: 'token-expired', message: '' }, 0, steps)).toBeNull();
    expect(retryDelayForFailure({ kind: 'fingerprint', address: 'a', expected: 'x', seen: 'y' }, 0, steps)).toBeNull();
  });

  it('comes back on its own after the host turns host mode off and on', async () => {
    const host = makeService('host');
    const viewer = makeService('viewer', { machineId: '11111111-2222-4333-8444-555555555555', reconnectStepsMs: [80, 80] });
    await host.service.setPort(await freePort());
    await host.service.setHostMode(true);
    const code = (await host.service.createInvite()).invite!.code;
    expect((await viewer.service.addMachine(code)).ok).toBe(true);
    await host.service.setHostMode(false);
    await waitFor(() => viewer.service.machines()[0]?.state !== 'connected');
    await host.service.setHostMode(true);
    // No probe, no button: the backoff alone brings it back.
    await waitFor(() => viewer.service.machines()[0]?.state === 'connected');
  });

  it('reconnect() dials at once for a machine that was refused', async () => {
    const host = makeService('host');
    const viewer = makeService('viewer', { machineId: '11111111-2222-4333-8444-555555555555', reconnectStepsMs: [60_000] });
    await host.service.setPort(await freePort());
    await host.service.setHostMode(true);
    const code = (await host.service.createInvite()).invite!.code;
    expect((await viewer.service.addMachine(code)).ok).toBe(true);
    await host.service.setHostMode(false);
    await waitFor(() => viewer.service.machines()[0]?.state !== 'connected');
    await host.service.setHostMode(true);
    await viewer.service.reconnect(viewer.service.machines()[0]!.machineId);
    expect(viewer.service.machines()[0]?.state).toBe('connected');
  });
});

describe('waking up', () => {
  it('probe() re-dials a machine that was waiting out a backoff', async () => {
    const host = makeService('host');
    const viewer = makeService('viewer', { machineId: '11111111-2222-4333-8444-555555555555' });
    await host.service.setPort(await freePort());
    await host.service.setHostMode(true);
    const code = (await host.service.createInvite()).invite!.code;
    const added = await viewer.service.addMachine(code);
    expect(added.ok).toBe(true);
    const hostId = host.service.hostStatus().machineId;

    await host.service.setHostMode(false);
    await waitFor(() => viewer.service.machines()[0]?.state !== 'connected');
    await host.service.setHostMode(true);
    // Without the probe the viewer would sit on its backoff timer; with it, it is back at once.
    viewer.service.probe();
    await waitFor(() => viewer.service.machines()[0]?.state === 'connected');
    expect(viewer.service.machines().find((m) => m.machineId === hostId)?.state).toBe('connected');
  });

  it('suspend() says goodbye in both directions, so nothing is left attached', async () => {
    const host = makeService('host');
    const viewer = makeService('viewer', { machineId: '11111111-2222-4333-8444-555555555555' });
    await host.service.setHostMode(true);
    const code = (await host.service.createInvite()).invite!.code;
    await viewer.service.addMachine(code);
    const hostId = host.service.hostStatus().machineId;
    viewer.service.attach(`link:${hostId}:C:\\remote-repo#1`, 80, 24);
    await waitFor(() => host.service.hasRemoteViewers());

    viewer.service.suspend();
    await waitFor(() => !host.service.hasRemoteViewers());
    expect(host.service.hostStatus().connections).toEqual([]);
    expect(viewer.service.machines()[0]?.state).not.toBe('connected');
    // And a resume brings it back, with the watched session re-attached.
    viewer.service.probe();
    await waitFor(() => host.service.hasRemoteViewers());
  });
});

describe('the audit log', () => {
  it('records who connected, so the machine\'s owner can answer "who has been in here"', async () => {
    const host = makeService('SIHYEONG-MAIN');
    const viewer = makeService('laptop', { machineId: '11111111-2222-4333-8444-555555555555' });
    const status = await host.service.createInvite();
    await viewer.service.addMachine(status.invite!.code);
    await new Promise((r) => setTimeout(r, 50));

    const entries = host.service.auditLog();
    expect(entries.map((e) => e.kind)).toContain('paired');
    expect(entries.map((e) => e.kind)).toContain('connected');
  });
});
