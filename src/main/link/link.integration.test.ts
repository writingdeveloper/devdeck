/**
 * Host and client, over real TLS on the loopback interface, with a real certificate on each side.
 *
 * The unit tests cover the pieces; this covers the property that actually matters — that a paired
 * machine can drive this one, that an unpaired one cannot, and that neither of those depends on a
 * mock behaving itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import type { TodoSaveResult } from '../../shared/tasks';
import { makeMethodTable, allow, allowSession, blocked, localOnly, type DeckApi } from '../api/methods';
import { makeEventHub, type EventHub } from '../api/events';
import type { DeckApiBundle } from '../api/deckApi';
import { generateMachineCertificate } from './selfSignedCert';
import { startHostServer, type ActiveInvite, type HostLogEntry, type HostServer } from './hostServer';
import { dialHost, requestTimeoutFor, type ConnectedLink } from './clientLink';
import { createPairingToken } from './inviteCode';
import { attachConnection } from './connection';
import { LINK_PROTOCOL } from './protocol';
import { makeTokenBucket } from './tokenBucket';
import { noteHostReached, type KnownHost, type PairedDevice } from './devices';
import type { LinkIdentity } from './identity';
import type { LinkPermission } from '../../shared/link/permissions';

const HOST_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';

const identityOf = (cn: string): LinkIdentity => {
  const cert = generateMachineCertificate({ commonName: cn });
  return { certPem: cert.certPem, keyPem: cert.keyPem, fingerprint: cert.fingerprint };
};

let hostIdentity: LinkIdentity;
let clientIdentity: LinkIdentity;
let server: HostServer | null;
let paired: PairedDevice[];
let invite: ActiveInvite | null;
let log: HostLogEntry[];
let events: EventHub;
let methods: DeckApi;
let openedProjects: string[];
let typed: { id: string; data: string }[];
let liveSessionIds: string[] | null;
let now: number;

function buildApi(): DeckApiBundle {
  const table = makeMethodTable();
  openedProjects = [];
  table.invoke('projects:list', allow('observe'), () => [{ path: 'C:\\repo', name: 'repo' }]);
  table.invoke('cockpit:open', allow('spawn'), (req: { projectPath: string }) => {
    openedProjects.push(req.projectPath);
    return { id: 'sess-1', sessionId: 'abc' };
  });
  typed = [];
  table.send('cockpit:input', allowSession('control'), (id: string, data: string) => { typed.push({ id, data }); });
  table.send('cockpit:resize', allowSession('control'), () => undefined);
  table.invoke('cockpit:sessionBuffer', allowSession('control'), (id: string) => `screen of ${id}`);
  table.invoke('boom', allow('observe'), () => { throw new Error('handler exploded'); });
  table.invoke('settings:addFolder', blocked('native picker only'), () => ['C:\\anything']);
  table.invoke('win:close', localOnly, () => undefined);
  methods = table.table;
  events = makeEventHub();
  return { methods, events };
}

async function startHost(over: Partial<Parameters<typeof startHostServer>[0]> = {}): Promise<HostServer> {
  const api = buildApi();
  const started = await startHostServer({
    identity: hostIdentity,
    port: 0,
    bindHost: '127.0.0.1',
    api,
    machineId: HOST_ID,
    machineName: () => 'SIHYEONG-MAIN',
    appVersion: '1.34.1',
    pairedDevices: () => paired,
    savePairedDevices: (list) => { paired = list; },
    activeInvite: () => invite,
    consumeInvite: () => { invite = null; },
    addresses: () => ['127.0.0.1', 'SIHYEONG-MAIN'],
    now: () => now,
    log: (entry) => { log.push(entry); },
    sessionIds: () => liveSessionIds,
    ...over,
  });
  server = started;
  return started;
}

function knownHost(port: number, over: Partial<KnownHost> = {}): KnownHost {
  return {
    machineId: HOST_ID, machineName: 'SIHYEONG-MAIN',
    fingerprint: hostIdentity.fingerprint,
    addresses: ['127.0.0.1'], port, lastAddress: null, lastSeenMs: null,
    ...over,
  };
}

async function connect(port: number, over: Partial<Parameters<typeof dialHost>[0]> = {}) {
  return dialHost({
    identity: clientIdentity,
    host: knownHost(port),
    machineId: CLIENT_ID,
    machineName: 'laptop',
    appVersion: '1.34.1',
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
    ...over,
  });
}

beforeEach(() => {
  hostIdentity = identityOf('devdeck-host');
  clientIdentity = identityOf('devdeck-client');
  paired = [];
  invite = null;
  log = [];
  liveSessionIds = ['sess-1', 'sess-2', 's'];
  now = 1_756_000_000_000;
  server = null;
});

afterEach(async () => { await server?.close(); server = null; });

describe('pairing', () => {
  it('pairs with a valid code, then serves the deck to the paired machine', async () => {
    const token = createPairingToken();
    invite = { token, expiresAtMs: now + 300_000, permissions: ['observe', 'control', 'spawn'] };
    const host = await startHost();

    const dialed = await connect(host.port, { pairingToken: token });
    expect(dialed.ok).toBe(true);
    if (!dialed.ok) return;

    expect(dialed.link.ready.machineName).toBe('SIHYEONG-MAIN');
    expect(dialed.link.ready.permissions).toEqual(['observe', 'control', 'spawn']);
    await expect(dialed.link.request('projects:list', [])).resolves.toEqual([{ path: 'C:\\repo', name: 'repo' }]);

    expect(paired).toHaveLength(1);
    expect(paired[0].fingerprint).toBe(clientIdentity.fingerprint);
    expect(paired[0]).toMatchObject({ machineId: CLIENT_ID, machineName: 'laptop' });
    expect(invite).toBeNull(); // single use
    expect(log.map((l) => l.kind)).toContain('paired');
    dialed.link.close();
  });

  it('lets the paired machine back in later without a code', async () => {
    paired = [{
      machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint,
      permissions: ['observe'], pairedAtMs: now, lastSeenMs: null,
    }];
    const host = await startHost();
    const dialed = await connect(host.port);
    expect(dialed.ok).toBe(true);
    if (dialed.ok) {
      expect(dialed.link.ready.permissions).toEqual(['observe']);
      dialed.link.close();
    }
  });

  it('refuses an unpaired machine and says why rather than dropping it silently', async () => {
    // The person most likely to hit this is the owner, after un-pairing or with an expired code. A
    // silent drop sends them to look at their firewall.
    const host = await startHost();
    const dialed = await connect(host.port);
    expect(dialed).toEqual({ ok: false, failure: { kind: 'refused', code: 'unpaired', message: expect.any(String) } });
    expect(log.some((l) => l.kind === 'rejected' && l.detail === 'unpaired device')).toBe(true);
  });

  it('refuses a wrong code and stops a socket being used as a grinder', async () => {
    invite = { token: createPairingToken(), expiresAtMs: now + 300_000, permissions: ['observe'] };
    const host = await startHost();
    const dialed = await connect(host.port, { pairingToken: 'not-the-token' });
    expect(dialed.ok).toBe(false);
    if (!dialed.ok) expect(dialed.failure).toMatchObject({ kind: 'refused' });
    expect(paired).toHaveLength(0);
    expect(log.some((l) => l.detail === 'bad token')).toBe(true);
  });

  it('refuses an expired code as expired, which is an actionable message', async () => {
    invite = { token: 'stale-token', expiresAtMs: now - 1, permissions: ['observe'] };
    const host = await startHost();
    const dialed = await connect(host.port, { pairingToken: 'stale-token' });
    expect(dialed.ok).toBe(false);
    if (!dialed.ok) expect(dialed.failure).toMatchObject({ kind: 'refused', code: 'token-expired' });
    expect(paired).toHaveLength(0);
  });
});

describe('pinning', () => {
  it('refuses a machine that is not the one paired with, and does not retry it', async () => {
    // The impostor holds a perfectly valid certificate — it is simply not the pinned one. This is the
    // case the whole design exists for, so it must fail loudly and stay failed.
    const host = await startHost();
    const impostorFingerprint = generateMachineCertificate().fingerprint;
    const dialed = await connect(host.port, { host: knownHost(host.port, { fingerprint: impostorFingerprint }) });
    expect(dialed.ok).toBe(false);
    if (!dialed.ok) {
      expect(dialed.failure.kind).toBe('fingerprint');
      if (dialed.failure.kind === 'fingerprint') expect(dialed.failure.expected).toBe(impostorFingerprint);
    }
    // Nothing reached the host's application layer: the client hung up during the handshake.
    expect(log.some((l) => l.kind === 'connected')).toBe(false);
  });
});

describe('permissions', () => {
  const pairWith = async (permissions: LinkPermission[]): Promise<ConnectedLink> => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions, pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost();
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    return dialed.link;
  };

  it('lets an observer read the deck but not start a session', async () => {
    const link = await pairWith(['observe']);
    await expect(link.request('projects:list', [])).resolves.toBeTruthy();
    await expect(link.request('cockpit:open', [{ projectPath: 'C:\\repo' }])).rejects.toThrow(/not permitted/);
    expect(openedProjects).toEqual([]); // the handler was never reached, not merely undone
    link.close();
  });

  it('never serves a blocked method, whatever the device holds', async () => {
    // settings:addFolder widens the path allowlist every other guard checks against, and is bound to
    // a native picker on the machine itself. No permission can reach it.
    const link = await pairWith(['observe', 'control', 'spawn', 'write', 'power']);
    await expect(link.request('settings:addFolder', ['C:\\anything'])).rejects.toThrow(/not permitted/);
    link.close();
  });

  it('never serves a local-only method', async () => {
    const link = await pairWith(['observe', 'control', 'spawn', 'write', 'power']);
    await expect(link.request('win:close', [])).rejects.toThrow(/not permitted/);
    link.close();
  });

  it('answers a name that does not exist without leaking whether it exists', async () => {
    const link = await pairWith(['observe']);
    await expect(link.request('no:such:method', [])).rejects.toThrow(/no such method/);
    link.close();
  });

  it('reports a handler that throws as a failed call, not as a dead link', async () => {
    const link = await pairWith(['observe']);
    await expect(link.request('boom', [])).rejects.toThrow(/handler exploded/);
    await expect(link.request('projects:list', [])).resolves.toBeTruthy(); // still usable
    link.close();
  });

  it('drops an unauthorized fire-and-forget call instead of running it', async () => {
    const link = await pairWith(['observe']);
    link.notify('cockpit:input', ['sess-1', 'rm -rf /']);
    await new Promise((r) => setTimeout(r, 50));
    expect(log.some((l) => l.kind === 'denied' && l.detail === 'cockpit:input')).toBe(true);
    link.close();
  });
});

describe('terminal streaming', () => {
  const pairedLink = async (): Promise<{ link: ConnectedLink; chunks: { id: string; text: string }[] }> => {
    paired = [{
      machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint,
      permissions: ['observe', 'control'], pairedAtMs: now, lastSeenMs: null,
    }];
    const host = await startHost();
    const chunks: { id: string; text: string }[] = [];
    const dialed = await connect(host.port, { onPty: (id, bytes) => { chunks.push({ id, text: bytes.toString('utf8') }); } });
    if (!dialed.ok) throw new Error('expected a connection');
    return { link: dialed.link, chunks };
  };

  it('streams only the sessions a viewer attached to', async () => {
    // Broadcasting every session would make each viewer pay for output it never asked for — and would
    // leak what else is running on the machine to a device that only opened one terminal.
    const { link, chunks } = await pairedLink();
    link.attach('sess-1', 80, 24);
    await new Promise((r) => setTimeout(r, 30));

    events.publish('cockpit:data', { id: 'sess-1', chunk: '\u001b[32mdone\u001b[0m\r\n' });
    events.publish('cockpit:data', { id: 'sess-2', chunk: 'someone else\r\n' });
    await new Promise((r) => setTimeout(r, 60));

    expect(chunks).toEqual([{ id: 'sess-1', text: '\u001b[32mdone\u001b[0m\r\n' }]);
    link.close();
  });

  it('stops streaming after a detach', async () => {
    const { link, chunks } = await pairedLink();
    link.attach('sess-1', 80, 24);
    await new Promise((r) => setTimeout(r, 30));
    link.detach('sess-1');
    await new Promise((r) => setTimeout(r, 30));
    events.publish('cockpit:data', { id: 'sess-1', chunk: 'after detach' });
    await new Promise((r) => setTimeout(r, 50));
    expect(chunks).toEqual([]);
    link.close();
  });

  it('carries multi-byte output through unharmed', async () => {
    const { link, chunks } = await pairedLink();
    link.attach('s', 80, 24);
    await new Promise((r) => setTimeout(r, 30));
    events.publish('cockpit:data', { id: 's', chunk: '한글 출력 ✅ ✻ Thinking…' });
    await new Promise((r) => setTimeout(r, 60));
    expect(chunks[0]?.text).toBe('한글 출력 ✅ ✻ Thinking…');
    link.close();
  });

  it('refuses terminal frames pushed by a client — input must pass the permission gate', async () => {
    // A client that could write pty frames would be typing into another machine's terminal without
    // ever going through `cockpit:input`'s permission check. Driven at the socket level, because a
    // well-behaved ConnectedLink has no way to do this — which is exactly why the host must not rely
    // on clients being well-behaved.
    paired = [{
      machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint,
      permissions: ['observe', 'control'], pairedAtMs: now, lastSeenMs: null,
    }];
    const host = await startHost();

    const outcome = await new Promise<string>((resolve) => {
      const socket = tls.connect({
        host: '127.0.0.1', port: host.port,
        key: clientIdentity.keyPem, cert: clientIdentity.certPem,
        rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: 'TLSv1.3',
      }, () => {
        const conn = attachConnection(socket, {
          onMessage: (message) => {
            if (message.t === 'hello') {
              conn.send({ t: 'hello', protocol: LINK_PROTOCOL, appVersion: '1.34.1', machineId: CLIENT_ID, machineName: 'laptop' });
            }
            if (message.t === 'ready') conn.sendPty('sess-1', 'sudo rm -rf /\r');
            if (message.t === 'error') resolve(`error:${message.code}`);
          },
          onPty: () => resolve('client received pty'),
          onClose: () => resolve('closed'),
        });
      });
      socket.on('error', () => resolve('closed'));
      setTimeout(() => resolve('still open'), 2_000);
    });

    expect(outcome).toMatch(/^(error:method-not-available|closed)$/);
  });
});

describe('session ids a paired machine may name', () => {
  const controller = async (permissions: LinkPermission[] = ['observe', 'control']) => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions, pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost();
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    return { link: dialed.link, host };
  };

  it('refuses to relay a call aimed at a THIRD machine', async () => {
    // A `link:`-qualified id names a session on some other machine this host is paired with. Handing
    // it to the id-routed handlers would make this machine type into that one with its own
    // credentials, on behalf of a caller that was never paired there.
    const { link } = await controller();
    const relayed = 'link:11111111-2222-4333-8444-555555555555:sess-9';
    await expect(link.request('cockpit:sessionBuffer', [relayed])).rejects.toThrow(/not a session on this machine/);
    link.notify('cockpit:input', [relayed, 'rm -rf /\r']);
    await new Promise((r) => setTimeout(r, 60));
    expect(typed).toEqual([]);
    expect(log.some((l) => l.kind === 'denied' && l.detail.startsWith('cockpit:sessionBuffer:link:'))).toBe(true);
    link.close();
  });

  it('keeps sessions this machine does not announce out of reach', async () => {
    // The OAuth login shell runs in the same pty table but is never announced; a device holding
    // `control` could otherwise read the login screen, type into it and kill it.
    const { link } = await controller();
    await expect(link.request('cockpit:sessionBuffer', ['usage-login:claude:7'])).rejects.toThrow(/not a session on this machine/);
    link.notify('cockpit:input', ['usage-login:claude:7', 'x']);
    await new Promise((r) => setTimeout(r, 60));
    expect(typed).toEqual([]);
    link.close();
  });

  it('serves a bare id of a session it does announce', async () => {
    const { link } = await controller();
    await expect(link.request('cockpit:sessionBuffer', ['sess-1'])).resolves.toBe('screen of sess-1');
    link.notify('cockpit:input', ['sess-1', 'ls\r']);
    await new Promise((r) => setTimeout(r, 60));
    expect(typed).toEqual([{ id: 'sess-1', data: 'ls\r' }]);
    link.close();
  });

  it('records an attach only for an announced session, and only so many of them', async () => {
    liveSessionIds = Array.from({ length: 100 }, (_, i) => `sess-${i}`);
    const { link, host } = await controller();
    link.attach('link:11111111-2222-4333-8444-555555555555:sess-1', 80, 24);
    link.attach('not-running', 80, 24);
    for (let i = 0; i < 100; i++) link.attach(`sess-${i}`, 80, 24);
    await new Promise((r) => setTimeout(r, 120));
    const attached = host.connections[0]?.attachedSessions ?? [];
    expect(attached.length).toBe(64);
    expect(attached.some((id) => id.startsWith('link:') || id === 'not-running')).toBe(false);
    link.close();
  });

  it('slows a device that asks too much, without dropping it', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost({ rateLimit: { capacity: 3, refillPerMs: 0 } });
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    const link = dialed.link;
    await link.request('projects:list', []);
    await link.request('projects:list', []);
    await link.request('projects:list', []);
    await expect(link.request('projects:list', [])).rejects.toThrow(/too many requests/);
    expect(link.closed).toBe(false);
    expect(log.filter((l) => l.kind === 'denied' && l.detail.startsWith('rate-limited')).length).toBe(1);
    link.close();
  });

  it('answers nothing before hello', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost();
    const outcome = await new Promise<string>((resolve) => {
      const socket = tls.connect({
        host: '127.0.0.1', port: host.port,
        key: clientIdentity.keyPem, cert: clientIdentity.certPem,
        rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: 'TLSv1.3',
      }, () => {
        const conn = attachConnection(socket, {
          onMessage: (message) => {
            // Skip hello on purpose: a client that never states its protocol must not be served.
            if (message.t === 'hello') conn.send({ t: 'req', id: 1, method: 'projects:list', args: [] });
            if (message.t === 'res') resolve('served');
            if (message.t === 'error') resolve(`error:${message.code}`);
          },
          onPty: () => resolve('pty'),
          onClose: () => resolve('closed'),
        });
      });
      socket.on('error', () => resolve('closed'));
      setTimeout(() => resolve('still open'), 2_000);
    });
    expect(outcome).toMatch(/^(error:protocol-mismatch|closed)$/);
  });
});

describe('liveness', () => {
  const rawClient = (host: HostServer, hello: Record<string, unknown>, onReady: (conn: ReturnType<typeof attachConnection>) => void, answerPings: boolean) =>
    new Promise<{ closed: boolean }>((resolve) => {
      const socket = tls.connect({
        host: '127.0.0.1', port: host.port,
        key: clientIdentity.keyPem, cert: clientIdentity.certPem,
        rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: 'TLSv1.3',
      }, () => {
        const conn = attachConnection(socket, {
          onMessage: (message) => {
            if (message.t === 'hello') conn.send({ t: 'hello', protocol: LINK_PROTOCOL, appVersion: '1.34.1', machineId: CLIENT_ID, machineName: 'laptop', ...hello } as never);
            if (message.t === 'ready') onReady(conn);
          },
          onPty: () => undefined,
          onClose: () => resolve({ closed: true }),
        }, { idleMs: 60_000, timeoutMs: 180_000, answerPings });
      });
      socket.on('error', () => resolve({ closed: true }));
      setTimeout(() => resolve({ closed: false }), 600);
    });

  it('drops a paired client that stops answering, and releases what it was watching', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe', 'control'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost({ heartbeat: { idleMs: 40, timeoutMs: 150 } });
    let sawAttached = false;
    const outcome = await rawClient(host, { features: ['ping'] }, (conn) => {
      conn.send({ t: 'attach', sessionId: 'sess-1', cols: 80, rows: 24 });
      setTimeout(() => { sawAttached = host.connections[0]?.attachedSessions.includes('sess-1') ?? false; }, 60);
    }, false);
    expect(sawAttached).toBe(true);
    expect(outcome.closed).toBe(true);
    expect(host.connections).toEqual([]);
    expect(log.some((l) => l.kind === 'disconnected')).toBe(true);
  });

  it('keeps a client from a build that predates pings, however silent', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost({ heartbeat: { idleMs: 40, timeoutMs: 150 } });
    const outcome = await rawClient(host, {}, () => undefined, false); // no `features`, never answers
    expect(outcome.closed).toBe(false);
    expect(host.connections.length).toBe(1);
  });

  it('a client gives up on a host that answers nothing', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    // The host advertises pings (it is a current build) but its socket is a black hole from here on.
    const host = await startHost({ heartbeat: { idleMs: 60_000, timeoutMs: 180_000, answerPings: false } });
    const closed: (string | null)[] = [];
    const dialed = await connect(host.port, { heartbeat: { idleMs: 40, timeoutMs: 150 }, onClose: (r) => closed.push(r) });
    if (!dialed.ok) throw new Error('expected a connection');
    await new Promise((r) => setTimeout(r, 400));
    expect(dialed.link.closed).toBe(true);
    expect(closed).toEqual(['heartbeat timeout']);
  });

  it('a request keeps the link alive as well as a pong would', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost({ heartbeat: { idleMs: 40, timeoutMs: 150, answerPings: false } });
    const dialed = await connect(host.port, { heartbeat: { idleMs: 40, timeoutMs: 150 } });
    if (!dialed.ok) throw new Error('expected a connection');
    for (let i = 0; i < 6; i++) { await dialed.link.request('projects:list', []); await new Promise((r) => setTimeout(r, 50)); }
    expect(dialed.link.closed).toBe(false);
    dialed.link.close();
  });

  it('pings do not count as the peer using this machine', async () => {
    let activity = 0;
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost({ heartbeat: { idleMs: 30, timeoutMs: 10_000 }, onActivity: () => { activity += 1; } });
    const dialed = await connect(host.port, { heartbeat: { idleMs: 30, timeoutMs: 10_000 } });
    if (!dialed.ok) throw new Error('expected a connection');
    const after = activity;
    await new Promise((r) => setTimeout(r, 300)); // several pings each way
    expect(activity).toBe(after);
    void makeTokenBucket; // keeps the import honest under isolatedModules
    dialed.link.close();
  });
});

describe('request deadlines', () => {
  it('gives the calls that walk a whole machine longer than a keystroke', () => {
    expect(requestTimeoutFor('projects:list')).toBe(120_000);
    expect(requestTimeoutFor('usage:report')).toBe(120_000);
    expect(requestTimeoutFor('cockpit:sessionScreen')).toBe(30_000);
    expect(requestTimeoutFor('projects:list', 5)).toBe(120_000); // the table wins over a caller's default
  });
});

describe('dialing', () => {
  it('falls through unreachable addresses to one that answers', async () => {
    const host = await startHost();
    const dialed = await connect(host.port, {
      host: knownHost(host.port, { addresses: ['192.0.2.1', '127.0.0.1'], lastAddress: null }),
      connectTimeoutMs: 300,
      pairingToken: 'x',
    });
    // 192.0.2.0/24 is TEST-NET-1 and routes nowhere; the run must reach 127.0.0.1 and be refused
    // there on the token, not report the whole host as unreachable.
    expect(dialed.ok).toBe(false);
    if (!dialed.ok) expect(dialed.failure.kind).toBe('refused');
  });

  it('reports unreachable with what it tried, so the message can name the addresses', async () => {
    const dialed = await connect(1, {
      host: knownHost(9, { addresses: ['192.0.2.1', '192.0.2.2'] }),
      connectTimeoutMs: 200,
    });
    expect(dialed.ok).toBe(false);
    if (!dialed.ok && dialed.failure.kind === 'unreachable') {
      expect(dialed.failure.tried).toEqual(['192.0.2.1', '192.0.2.2']);
    } else {
      throw new Error('expected unreachable');
    }
  });

  it('hands back the address that answered so the client can remember it', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost();
    const dialed = await connect(host.port, { host: knownHost(host.port, { addresses: ['127.0.0.1'] }) });
    expect(dialed.ok).toBe(true);
    if (!dialed.ok) return;
    // And the host taught it the rest of its addresses, which is what survives a network change.
    const remembered = noteHostReached(knownHost(host.port), {
      address: dialed.link.address,
      addresses: dialed.link.ready.addresses,
      port: dialed.link.ready.port,
      machineName: dialed.link.ready.machineName,
      nowMs: now,
    });
    expect(remembered.lastAddress).toBe('127.0.0.1');
    expect(remembered.addresses).toContain('SIHYEONG-MAIN');
    dialed.link.close();
  });
});

describe('host control', () => {
  it('lists live connections and can cut one off', async () => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    const host = await startHost();
    const dialed = await connect(host.port);
    expect(dialed.ok).toBe(true);
    if (!dialed.ok) return;

    expect(host.connections).toHaveLength(1);
    expect(host.connections[0].machineName).toBe('laptop');

    // The kill switch in Settings: revoking a device has to cut the live connection, not just stop
    // the next one.
    host.disconnect(clientIdentity.fingerprint);
    await new Promise((r) => setTimeout(r, 80));
    expect(host.connections).toHaveLength(0);
    expect(dialed.link.closed).toBe(true);
  });

  it('counts a remote request as this machine being in use, terminal or no terminal', async () => {
    // The idle watcher powers this machine off after ten quiet minutes, and it measures quiet by local
    // input devices — which someone driving this deck from another room never touches. Only ATTACHED
    // terminals vetoed it, so a viewer reading this machine's projects, git state or usage was, to the
    // watcher, nobody: it would run `shutdown /s` out from under them.
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions: ['observe'], pairedAtMs: now, lastSeenMs: null }];
    let activity = 0;
    const host = await startHost({ onActivity: () => { activity += 1; } });
    const dialed = await connect(host.port);
    expect(dialed.ok).toBe(true);
    if (!dialed.ok) return;

    const before = activity;
    await dialed.link.request('projects:list', []);
    expect(activity).toBeGreaterThan(before); // browsing counts, with nothing attached
  });
});


describe('task concurrency over the actual TLS transport', () => {
  it('keeps the first committed change when two paired clients write the same revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdeck-tls-tasks-'));
    const store = new Store(join(dir, 'state.json'));
    const initial = ['A', 'B'].map(id => ({ id, text: id, done: false, due: null, createdAt: '2026-09-08T00:00:00Z' }));
    store.saveTodos('repo', initial, 0);
    const host = await startHost();
    methods['project:saveTodos'] = { channel: 'invoke', remote: allow('write'), handler: (path, todos, revision) => store.saveTodos(path, todos, revision) };
    let first: ConnectedLink | null = null, second: ConnectedLink | null = null;
    try {
      const token1 = createPairingToken(); invite = { token: token1, expiresAtMs: now + 300_000, permissions: ['observe', 'write'] };
      const a = await connect(host.port, { pairingToken: token1 });
      expect(a.ok).toBe(true); if (!a.ok) throw new Error('first client did not connect'); first = a.link;
      const token2 = createPairingToken(); invite = { token: token2, expiresAtMs: now + 300_000, permissions: ['observe', 'write'] };
      const b = await connect(host.port, { pairingToken: token2, identity: identityOf('second-client'), machineId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      expect(b.ok).toBe(true); if (!b.ok) throw new Error('second client did not connect'); second = b.link;
      const saved = await first.request('project:saveTodos', ['repo', [{ ...initial[0], done: true }, initial[1]], 1]) as TodoSaveResult;
      const conflict = await second.request('project:saveTodos', ['repo', [initial[0], { ...initial[1], done: true }], 1]) as TodoSaveResult;
      expect(saved.ok).toBe(true); expect(conflict.ok).toBe(false);
      expect(conflict.todos.map(t => t.done)).toEqual([true, false]);
      expect(new Store(join(dir, 'state.json')).getTodos('repo').map(t => t.done)).toEqual([true, false]);
    } finally {
      first?.close(); second?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('hardening', () => {
  const pairedAs = (permissions: LinkPermission[]): void => {
    paired = [{ machineId: CLIENT_ID, machineName: 'laptop', fingerprint: clientIdentity.fingerprint, permissions, pairedAtMs: now, lastSeenMs: null }];
  };
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  type RawConn = ReturnType<typeof attachConnection>;

  /** A client driven at the frame level, for what a well-behaved ConnectedLink would never send. */
  const raw = (port: number, identity: LinkIdentity, script: { onHello?: (conn: RawConn) => void } = {}) =>
    new Promise<{ conn: RawConn; closed: Promise<void> }>((resolve) => {
      let markClosed: () => void = () => undefined;
      const closed = new Promise<void>((r) => { markClosed = r; });
      const socket = tls.connect({
        host: '127.0.0.1', port,
        key: identity.keyPem, cert: identity.certPem,
        rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: 'TLSv1.3',
      }, () => {
        const conn = attachConnection(socket, {
          onMessage: (message) => { if (message.t === 'hello') script.onHello?.(conn); },
          onPty: () => undefined,
          onClose: () => markClosed(),
        });
        resolve({ conn, closed });
      });
      socket.on('error', () => markClosed());
    });
  const hello = (conn: RawConn, over: Record<string, unknown> = {}) =>
    conn.send({ t: 'hello', protocol: LINK_PROTOCOL, appVersion: '1.34.1', machineId: CLIENT_ID, machineName: 'laptop', ...over } as never);
  const closedWithin = (closed: Promise<void>, ms: number) =>
    Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  it('runs only `send` methods as a notify — never an invoke method, with no reply and no budget', async () => {
    pairedAs(['observe', 'control', 'spawn']);
    const host = await startHost();
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    dialed.link.notify('cockpit:open', [{ projectPath: 'C:\\repo' }]);
    dialed.link.notify('projects:list', []);
    await settle();
    expect(openedProjects).toEqual([]);
    expect(log.some((l) => l.kind === 'denied' && l.detail === 'notify:cockpit:open')).toBe(true);
    // And the same method still works the way it is meant to be called.
    await expect(dialed.link.request('cockpit:open', [{ projectPath: 'C:\\repo' }])).resolves.toMatchObject({ id: 'sess-1' });
    dialed.link.close();
  });

  it('budgets resizes and closes, but never keystrokes', async () => {
    pairedAs(['observe', 'control']);
    const host = await startHost({ notifyRateLimit: { capacity: 3, refillPerMs: 0 } });
    let resized = 0;
    methods['cockpit:resize'] = { channel: 'send', remote: allowSession('control'), handler: () => { resized += 1; } };
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    for (let i = 0; i < 10; i++) dialed.link.notify('cockpit:resize', ['sess-1', 80, 24]);
    for (let i = 0; i < 200; i++) dialed.link.notify('cockpit:input', ['sess-1', 'x']);
    await settle(120);
    expect(resized).toBe(3);
    expect(typed).toHaveLength(200);
    expect(dialed.link.closed).toBe(false);
    dialed.link.close();
  });

  it('swallows a rejecting fire-and-forget handler instead of leaving an unhandled rejection', async () => {
    pairedAs(['observe', 'control']);
    const host = await startHost();
    methods['cockpit:resize'] = { channel: 'send', remote: allowSession('control'), handler: async () => { throw new Error('async send failed'); } };
    const unhandled: unknown[] = [];
    const trap = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', trap);
    try {
      const dialed = await connect(host.port);
      if (!dialed.ok) throw new Error('expected a connection');
      dialed.link.notify('cockpit:resize', ['sess-1', 80, 24]);
      await settle(100);
      expect(unhandled).toEqual([]);
      dialed.link.close();
    } finally {
      process.off('unhandledRejection', trap);
    }
  });

  it('does not trip over a method name that is an Object.prototype member', async () => {
    pairedAs(['observe', 'control']);
    const host = await startHost();
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    await expect(dialed.link.request('constructor', [])).rejects.toThrow(/no such method: constructor/);
    dialed.link.notify('__proto__', []);
    await expect(dialed.link.request('projects:list', [])).resolves.toBeTruthy();
    dialed.link.close();
  });

  it('sends a paired machine only the session channels, whatever else the hub carries', async () => {
    pairedAs(['observe', 'control']);
    const host = await startHost();
    const seen: string[] = [];
    const dialed = await connect(host.port, { onEvent: (ch) => { seen.push(ch); } });
    if (!dialed.ok) throw new Error('expected a connection');
    events.publish('settings:changed', { secret: true });
    events.publish('cockpit:sessions', []);
    await settle();
    expect(seen).toEqual(['cockpit:sessions']);
    dialed.link.close();
  });

  it('turns strangers away past a small number waiting, but never a paired device', async () => {
    pairedAs(['observe']);
    const host = await startHost({ maxUnauthenticated: 2 });
    const stranger = () => raw(host.port, identityOf('stranger'));
    const a = await stranger();
    const b = await stranger();
    await settle(30);
    const c = await stranger();
    expect(await closedWithin(c.closed, 1_000)).toBe(true);
    expect(await closedWithin(a.closed, 50)).toBe(false);
    const dialed = await connect(host.port);
    expect(dialed.ok).toBe(true);
    if (dialed.ok) dialed.link.close();
    a.conn.close(); b.conn.close();
  });

  it('drops a peer that sends a large frame before it is let in, and serves large ones after', async () => {
    const host = await startHost();
    const big = 'x'.repeat(200 * 1024);
    const unpaired = await raw(host.port, identityOf('stranger'), {
      onHello: (conn) => { hello(conn, { wantsPairing: true, machineName: big }); },
    });
    expect(await closedWithin(unpaired.closed, 1_000)).toBe(true);

    pairedAs(['observe']);
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    await expect(dialed.link.request('projects:list', [big])).resolves.toBeTruthy();
    dialed.link.close();
  });

  it('ignores a detach from a peer that was never let in', async () => {
    let announced = 0;
    await startHost({ onConnectionsChanged: () => { announced += 1; } });
    const stranger = await raw(server!.port, identityOf('stranger'), {
      onHello: (conn) => {
        hello(conn, { wantsPairing: true });
        for (let i = 0; i < 20; i++) conn.send({ t: 'detach', sessionId: 'sess-1' });
      },
    });
    await settle(100);
    expect(announced).toBe(0);
    stranger.conn.close();
  });

  it('keeps strangers from pushing the audit history out with refusals', async () => {
    const host = await startHost();
    // One connection spraying calls it may not make...
    const sprayer = await raw(host.port, identityOf('sprayer'), {
      onHello: (conn) => {
        hello(conn, { wantsPairing: true });
        for (let i = 0; i < 100; i++) conn.send({ t: 'req', id: i, method: `junk:${i}`, args: [] });
        for (let i = 0; i < 100; i++) conn.send({ t: 'notify', method: `junk:${i}`, args: [] });
      },
    });
    await settle(150);
    sprayer.conn.close();
    // ...and a loop of connections that are each turned away.
    for (let i = 0; i < 30; i++) await connect(host.port);
    await settle(100);
    const fromStrangers = log.length;
    expect(fromStrangers).toBeLessThanOrEqual(20);
    // A paired device's history is still written in full.
    pairedAs(['observe']);
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    expect(log.slice(fromStrangers).some((l) => l.kind === 'connected')).toBe(true);
    dialed.link.close();
  });

  it("throttles a paired device's own refusals and counts what it held back", async () => {
    pairedAs(['observe']);
    const host = await startHost();
    const dialed = await connect(host.port);
    if (!dialed.ok) throw new Error('expected a connection');
    for (let i = 0; i < 50; i++) dialed.link.notify('cockpit:input', ['sess-1', 'x']);
    await settle(80);
    expect(log.filter((l) => l.kind === 'denied')).toHaveLength(1);
    now += 11_000;
    dialed.link.notify('cockpit:input', ['sess-1', 'x']);
    await settle(80);
    const denials = log.filter((l) => l.kind === 'denied');
    expect(denials).toHaveLength(2);
    expect(denials[1].detail).toBe('cockpit:input (+49 more)');
    expect(host.connections).toHaveLength(1);
    dialed.link.close();
  });

  it('gives up on a host that finishes TLS and then says nothing', async () => {
    // TLS completes, so the connect timeout is already cleared; the heartbeat only starts at `ready`.
    const silent = tls.createServer({ key: hostIdentity.keyPem, cert: hostIdentity.certPem, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (silent.address() as { port: number }).port;
      const started = Date.now();
      const dialed = await connect(port, { handshakeTimeoutMs: 200 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(dialed).toEqual({ ok: false, failure: expect.objectContaining({ kind: 'unreachable', attempts: [{ address: '127.0.0.1', reason: 'timed-out' }] }) });
    } finally {
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it('releases an exited session from everyone attached to it, after telling them it exited', async () => {
    pairedAs(['observe', 'control']);
    let announced = 0;
    const host = await startHost({ onConnectionsChanged: () => { announced += 1; } });
    const exits: unknown[] = [];
    const dialed = await connect(host.port, { onEvent: (ch, payload) => { if (ch === 'cockpit:exit') exits.push(payload); } });
    if (!dialed.ok) throw new Error('expected a connection');
    dialed.link.attach('sess-1', 80, 24);
    await settle(40);
    const afterFirst = announced;
    // Re-sent on every resize; only the first one changes who is watching.
    for (let i = 0; i < 10; i++) dialed.link.attach('sess-1', 100 + i, 30);
    await settle(40);
    expect(announced).toBe(afterFirst);
    expect(host.connections[0].attachedSessions).toEqual(['sess-1']);

    events.publish('cockpit:exit', { id: 'sess-1', exitCode: 0 });
    await settle(60);
    expect(exits).toEqual([{ id: 'sess-1', exitCode: 0 }]);
    expect(host.connections[0].attachedSessions).toEqual([]);
    expect(announced).toBe(afterFirst + 1);
    dialed.link.close();
  });

  it('lets an already-paired device keep its permissions and leaves the invite unspent', async () => {
    pairedAs(['observe']);
    const token = createPairingToken();
    invite = { token, expiresAtMs: now + 300_000, permissions: ['observe', 'control', 'spawn', 'write', 'power'] };
    const host = await startHost();
    const dialed = await connect(host.port, { pairingToken: token });
    if (!dialed.ok) throw new Error('expected a connection');
    await settle(80);
    expect(invite).not.toBeNull();
    expect(paired).toHaveLength(1);
    expect(paired[0].permissions).toEqual(['observe']);
    await expect(dialed.link.request('cockpit:open', [{ projectPath: 'C:\\repo' }])).rejects.toThrow(/not permitted/);
    dialed.link.close();
  });

  it('says so in the log when pairing past the cap un-pairs the oldest device', async () => {
    const fp = (i: number): string => (i.toString(16).toUpperCase().padStart(2, '0').repeat(32).match(/../g) ?? []).join(':');
    paired = Array.from({ length: 32 }, (_, i) => ({
      machineId: `m-${i}`, machineName: `old-${i}`, fingerprint: fp(i + 1),
      permissions: ['observe'] as LinkPermission[], pairedAtMs: now - 1000 + i, lastSeenMs: null,
    }));
    const token = createPairingToken();
    invite = { token, expiresAtMs: now + 300_000, permissions: ['observe'] };
    const host = await startHost();
    const dialed = await connect(host.port, { pairingToken: token });
    if (!dialed.ok) throw new Error('expected a connection');
    expect(paired).toHaveLength(32);
    expect(paired.some((d) => d.machineName === 'old-0')).toBe(false);
    expect(log.some((l) => l.kind === 'rejected' && l.machineName === 'old-0' && l.detail.includes('limit'))).toBe(true);
    dialed.link.close();
  });
});
