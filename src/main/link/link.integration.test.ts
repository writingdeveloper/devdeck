/**
 * Host and client, over real TLS on the loopback interface, with a real certificate on each side.
 *
 * The unit tests cover the pieces; this covers the property that actually matters — that a paired
 * machine can drive this one, that an unpaired one cannot, and that neither of those depends on a
 * mock behaving itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as tls from 'node:tls';
import { makeMethodTable, allow, allowSession, blocked, localOnly, type DeckApi } from '../api/methods';
import { makeEventHub, type EventHub } from '../api/events';
import type { DeckApiBundle } from '../api/deckApi';
import { generateMachineCertificate } from './selfSignedCert';
import { startHostServer, type ActiveInvite, type HostLogEntry, type HostServer } from './hostServer';
import { dialHost, type ConnectedLink } from './clientLink';
import { createPairingToken } from './inviteCode';
import { attachConnection } from './connection';
import { LINK_PROTOCOL } from './protocol';
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
