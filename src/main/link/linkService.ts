/**
 * The link, as the rest of the app sees it.
 *
 * Owns this machine's identity, the inbound server when host mode is on, and one outbound connection
 * per known machine. Everything above this — the deck API's `link:*` methods, and eventually the
 * settings screen and the sidebar — talks to this and never to a socket.
 *
 * Two rules shape the whole file:
 *
 *  - A remote machine being unreachable is NORMAL, not an error. Laptops sleep, networks change, the
 *    other DevDeck gets quit. So calls fail fast with a reason the UI can render, reconnection is
 *    automatic and quiet, and the last known state stays on screen rather than the deck emptying out.
 *  - Host mode is off until someone turns it on. Nothing here opens a socket on its own.
 */
import { clipboard } from 'electron';
import type { DeckApiBundle } from '../api/deckApi';
import { startHostServer, type ActiveInvite, type HostConnectionInfo, type HostServer } from './hostServer';
import { dialHost, type ConnectedLink, type DialFailure } from './clientLink';
import { loadOrCreateIdentity, type LinkIdentity, type SafeStorageLike } from './identity';
import { addressCandidates, advertisableAddresses } from './addressCandidates';
import { LinkLog } from './linkLog';
import {
  createPairingToken, encodeInviteCode, findInviteCodeInText, parseInviteCode,
  INVITE_TTL_MS, type InviteProblem,
} from './inviteCode';
import {
  dialOrder, noteHostReached, removeKnownHost, removePairedDevice, upsertKnownHost, upsertPairedDevice,
  type KnownHost, type PairedDevice,
} from './devices';
import { LINK_DEFAULT_PORT } from './protocol';
import { qualifyRemoteId, parseRemoteId } from '../../shared/link/machine';
import { DEFAULT_LINK_PERMISSIONS, sanitizePermissions, type LinkPermission } from '../../shared/link/permissions';
import { networkInterfaces, hostname } from 'node:os';

export interface LinkPersistence {
  getHostMode(): boolean;
  setHostMode(on: boolean): void;
  getPort(): number;
  setPort(port: number): void;
  getPairedDevices(): PairedDevice[];
  setPairedDevices(devices: PairedDevice[]): void;
  getKnownHosts(): KnownHost[];
  setKnownHosts(hosts: KnownHost[]): void;
}

export type MachineConnectionState = 'connected' | 'connecting' | 'offline' | 'refused' | 'impostor';

export interface MachineStatus {
  machineId: string;
  machineName: string;
  state: MachineConnectionState;
  /** Populated when the state is not 'connected' — this is what the diagnostic surface renders. */
  problem: DialFailure | null;
  lastSeenMs: number | null;
  address: string | null;
  permissions: LinkPermission[];
}

export interface HostStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  machineId: string;
  machineName: string;
  fingerprint: string;
  addresses: string[];
  /** Non-null only while an unspent invite is live; the UI counts down against `expiresAtMs`. */
  invite: { code: string; expiresAtMs: number } | null;
  connections: HostConnectionInfo[];
  devices: PairedDevice[];
  error: string | null;
}

export interface LinkServiceOptions {
  userDataDir: string;
  safeStorage: SafeStorageLike;
  api: DeckApiBundle;
  machineId: string;
  machineName: () => string;
  appVersion: string;
  store: LinkPersistence;
  now?: () => number;
  /** Surfaced to the user (the same channel local errors use). */
  onError: (message: string) => void;
  /** Fires whenever anything the settings screen or sidebar shows has changed. */
  onChanged?: () => void;
  /** Remote terminal output and events, already qualified with the owning machine. */
  onRemoteEvent?: (channel: string, payload: unknown) => void;
  onRemotePty?: (qualifiedSessionId: string, bytes: Buffer) => void;
  /** Told when a viewer is actively watching this machine, so it does not power down under them. */
  onRemoteActivity?: () => void;
}

/** Reconnect backoff. Capped low: the common failure is a sleeping laptop, which comes back. */
const RECONNECT_STEPS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

interface Outbound {
  host: KnownHost;
  link: ConnectedLink | null;
  state: MachineConnectionState;
  problem: DialFailure | null;
  attempt: number;
  timer: NodeJS.Timeout | null;
  /**
   * The dial in progress, so a second caller AWAITS it instead of being told there is nothing to do.
   * Returning early here is what made pairing report success while the link was still being
   * established — the caller then made its first call against a machine that was still 'connecting'.
   */
  inflight: Promise<void> | null;
  /** Sessions this viewer has asked to watch; re-sent after a reconnect so the stream resumes. */
  attached: Map<string, { cols: number; rows: number }>;
}

export interface LinkService {
  hostStatus(): HostStatus;
  machines(): MachineStatus[];
  setHostMode(on: boolean): Promise<HostStatus>;
  setPort(port: number): Promise<HostStatus>;
  createInvite(permissions?: LinkPermission[]): Promise<HostStatus>;
  revokeInvite(): HostStatus;
  /** Pair with a machine from a pasted code. Resolves with what to tell the user. */
  addMachine(code: string): Promise<{ ok: true; machine: MachineStatus } | { ok: false; problem: InviteProblem | 'dial'; failure?: DialFailure }>;
  removeMachine(machineId: string): void;
  setDevicePermissions(fingerprint: string, permissions: LinkPermission[]): void;
  revokeDevice(fingerprint: string): void;
  disconnectDevice(fingerprint: string): void;
  /** A pasteable code sitting in the clipboard right now, for the "add a machine" banner. */
  clipboardInvite(): { code: string; machineName: string } | null;
  call(machineId: string, method: string, args: unknown[]): Promise<unknown>;
  notify(machineId: string, method: string, args: unknown[]): void;
  attach(qualifiedSessionId: string, cols: number, rows: number): void;
  detach(qualifiedSessionId: string): void;
  auditLog(limit?: number): ReturnType<LinkLog['recent']>;
  clearAuditLog(): void;
  /** True while any viewer is attached to a session here — the idle-shutdown veto (plan section 3.9). */
  hasRemoteViewers(): boolean;
  dispose(): Promise<void>;
}

export function createLinkService(options: LinkServiceOptions): LinkService {
  const now = options.now ?? Date.now;
  const log = new LinkLog(`${options.userDataDir}/link-log.json`);
  const identity: LinkIdentity = loadOrCreateIdentity({
    userDataDir: options.userDataDir,
    safeStorage: options.safeStorage,
    onWarn: options.onError,
  });

  let server: HostServer | null = null;
  let invite: (ActiveInvite & { code: string }) | null = null;
  let hostError: string | null = null;
  let connections: HostConnectionInfo[] = [];
  const outbound = new Map<string, Outbound>();
  let disposed = false;

  const changed = (): void => options.onChanged?.();
  const addresses = (): string[] => advertisableAddresses(addressCandidates(networkInterfaces(), hostname()));

  // ---- outbound ----

  for (const host of options.store.getKnownHosts()) register(host);

  function register(host: KnownHost): Outbound {
    const existing = outbound.get(host.machineId);
    if (existing) { existing.host = host; return existing; }
    const entry: Outbound = {
      host, link: null, state: 'offline', problem: null,
      attempt: 0, timer: null, inflight: null, attached: new Map(),
    };
    outbound.set(host.machineId, entry);
    void connect(entry);
    return entry;
  }

  /** Idempotent: concurrent callers share one dial and all wait for the same outcome. */
  function connect(entry: Outbound): Promise<void> {
    if (disposed || entry.link) return Promise.resolve();
    if (entry.inflight) return entry.inflight;
    entry.inflight = dial(entry).finally(() => { entry.inflight = null; });
    return entry.inflight;
  }

  async function dial(entry: Outbound): Promise<void> {
    entry.state = entry.attempt === 0 ? 'connecting' : entry.state;
    changed();

    const result = await dialHost({
      identity,
      host: entry.host,
      machineId: options.machineId,
      machineName: options.machineName(),
      appVersion: options.appVersion,
      onEvent: (channel, payload) => {
        // "What is running there" is re-addressed to a channel that NAMES the machine. Deriving it
        // from the ids would work right up until the interesting case — an empty list, which is how a
        // machine says its last session ended and has no id to read the machine from.
        if (channel === 'cockpit:sessions') {
          options.onRemoteEvent?.('link:sessions', {
            machineId: entry.host.machineId,
            sessions: qualifyPayload(entry.host.machineId, channel, payload),
          });
          return;
        }
        options.onRemoteEvent?.(channel, qualifyPayload(entry.host.machineId, channel, payload));
      },
      onPty: (sessionId, bytes) => options.onRemotePty?.(qualifyRemoteId(entry.host.machineId, sessionId), bytes),
      onClose: () => {
        entry.link = null;
        entry.state = 'offline';
        changed();
        scheduleRetry(entry);
      },
    });
    if (!result.ok) {
      entry.problem = result.failure;
      // An impostor is called out as its own state and never retried on a timer: quietly reconnecting
      // until it "works" is exactly how a pinned identity stops meaning anything.
      entry.state = result.failure.kind === 'fingerprint' ? 'impostor'
        : result.failure.kind === 'refused' ? 'refused'
          : 'offline';
      changed();
      if (entry.state === 'offline') scheduleRetry(entry);
      return;
    }

    entry.link = result.link;
    entry.problem = null;
    entry.state = 'connected';
    entry.attempt = 0;
    const updated = noteHostReached(entry.host, {
      address: result.link.address,
      addresses: result.link.ready.addresses,
      port: result.link.ready.port,
      machineName: result.link.ready.machineName,
      nowMs: now(),
    });
    entry.host = updated;
    options.store.setKnownHosts(upsertKnownHost(options.store.getKnownHosts(), updated));
    // Re-attach whatever this viewer was watching. Without this, a reconnect leaves every open
    // terminal silently dead — the tile is there, the agent is running, and nothing arrives.
    for (const [sessionId, size] of entry.attached) result.link.attach(sessionId, size.cols, size.rows);
    changed();
  }

  function scheduleRetry(entry: Outbound): void {
    if (disposed || entry.timer || entry.state === 'impostor') return;
    const delay = RECONNECT_STEPS_MS[Math.min(entry.attempt, RECONNECT_STEPS_MS.length - 1)];
    entry.attempt += 1;
    entry.timer = setTimeout(() => { entry.timer = null; void connect(entry); }, delay);
    entry.timer.unref?.();
  }

  /** Rewrite session ids inside a pushed event so the viewer sees one flat id space. */
  function qualifyPayload(machineId: string, channel: string, payload: unknown): unknown {
    // The list of what is running on that machine carries ids minted THERE; every one of them has to
    // be qualified or the viewer would key them against its own sessions.
    if (channel === 'cockpit:sessions') {
      return Array.isArray(payload)
        ? payload.map((row) => (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
          ? { ...(row as object), id: qualifyRemoteId(machineId, (row as { id: string }).id) }
          : row))
        : payload;
    }
    if (!payload || typeof payload !== 'object') return payload;
    if (channel !== 'cockpit:data' && channel !== 'cockpit:exit' && channel !== 'cockpit:resized') return payload;
    const row = payload as { id?: unknown };
    if (typeof row.id !== 'string') return payload;
    return { ...row, id: qualifyRemoteId(machineId, row.id) };
  }

  function linkFor(machineId: string): ConnectedLink {
    const entry = outbound.get(machineId);
    if (!entry) throw new Error(`unknown machine: ${machineId}`);
    if (!entry.link) throw new Error(entry.state === 'impostor' ? 'machine identity does not match' : 'machine is offline');
    return entry.link;
  }

  // ---- host ----

  async function startServer(): Promise<void> {
    if (server || disposed) return;
    try {
      server = await startHostServer({
        identity,
        port: options.store.getPort(),
        api: options.api,
        machineId: options.machineId,
        machineName: options.machineName,
        appVersion: options.appVersion,
        pairedDevices: () => options.store.getPairedDevices(),
        savePairedDevices: (devices) => options.store.setPairedDevices(devices),
        activeInvite: () => invite,
        consumeInvite: () => { invite = null; changed(); },
        addresses,
        now,
        onActivity: () => options.onRemoteActivity?.(),
        log: (entry) => {
          log.append(entry);
          // A viewer doing anything here counts as this machine being in use, so the idle-shutdown
          // watcher does not power it off from under someone working remotely.
          if (entry.kind === 'connected' || entry.kind === 'paired') options.onRemoteActivity?.();
        },
        onConnectionsChanged: (list) => { connections = list; changed(); },
      });
      hostError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // EADDRINUSE is the realistic one (another DevDeck, or the port taken). Reported, not retried:
      // silently binding a different port would leave every invite code pointing at the wrong one.
      hostError = message;
      options.onError(`DevDeck Link could not listen on port ${options.store.getPort()}: ${message}`);
    }
    changed();
  }

  async function stopServer(): Promise<void> {
    const running = server;
    server = null;
    connections = [];
    await running?.close();
    changed();
  }

  if (options.store.getHostMode()) void startServer();

  // ---- surface ----

  return {
    hostStatus() {
      return {
        enabled: options.store.getHostMode(),
        listening: server !== null,
        port: server?.port ?? options.store.getPort(),
        machineId: options.machineId,
        machineName: options.machineName(),
        fingerprint: identity.fingerprint,
        addresses: addresses(),
        invite: invite && invite.expiresAtMs > now() ? { code: invite.code, expiresAtMs: invite.expiresAtMs } : null,
        connections,
        devices: options.store.getPairedDevices(),
        error: hostError,
      };
    },

    machines() {
      return [...outbound.values()].map((entry) => ({
        machineId: entry.host.machineId,
        machineName: entry.host.machineName,
        state: entry.state,
        problem: entry.problem,
        lastSeenMs: entry.host.lastSeenMs,
        address: entry.link?.address ?? entry.host.lastAddress,
        permissions: entry.link?.ready.permissions ?? [],
      }));
    },

    async setHostMode(on) {
      options.store.setHostMode(on === true);
      if (on) await startServer();
      else { invite = null; await stopServer(); }
      return this.hostStatus();
    },

    async setPort(port) {
      const clean = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : LINK_DEFAULT_PORT;
      options.store.setPort(clean);
      if (server) { await stopServer(); await startServer(); }
      return this.hostStatus();
    },

    async createInvite(permissions) {
      // Turning host mode on implicitly: asking for a code IS asking to accept connections, and
      // making someone flip a separate switch first only produces a code that cannot be redeemed.
      if (!options.store.getHostMode()) { options.store.setHostMode(true); await startServer(); }
      const granted = sanitizePermissions(permissions ?? DEFAULT_LINK_PERMISSIONS);
      invite = {
        token: createPairingToken(),
        expiresAtMs: now() + INVITE_TTL_MS,
        permissions: granted.length ? granted : [...DEFAULT_LINK_PERMISSIONS],
        code: '',
      };
      invite.code = encodeInviteCode({
        machineId: options.machineId,
        machineName: options.machineName(),
        addresses: addresses(),
        port: server?.port ?? options.store.getPort(),
        fingerprint: identity.fingerprint,
        token: invite.token,
        expiresAtMs: invite.expiresAtMs,
      });
      changed();
      return this.hostStatus();
    },

    revokeInvite() { invite = null; changed(); return this.hostStatus(); },

    async addMachine(code) {
      const parsed = parseInviteCode(code, now());
      if (!parsed.ok) return { ok: false, problem: parsed.problem };
      const host: KnownHost = {
        machineId: parsed.invite.machineId,
        machineName: parsed.invite.machineName,
        fingerprint: parsed.invite.fingerprint,
        addresses: parsed.invite.addresses,
        port: parsed.invite.port,
        lastAddress: null,
        lastSeenMs: null,
      };
      // Pair on a throwaway connection rather than through the persistent one: the invite is
      // single-use, and a reconnect loop that kept re-sending a spent token would log a stream of
      // rejections on the other machine.
      const dialed = await dialHost({
        identity, host,
        machineId: options.machineId,
        machineName: options.machineName(),
        appVersion: options.appVersion,
        pairingToken: parsed.invite.token,
      });
      if (!dialed.ok) return { ok: false, problem: 'dial', failure: dialed.failure };

      const reached = noteHostReached(host, {
        address: dialed.link.address,
        addresses: dialed.link.ready.addresses,
        port: dialed.link.ready.port,
        machineName: dialed.link.ready.machineName,
        nowMs: now(),
      });
      dialed.link.close('paired');
      options.store.setKnownHosts(upsertKnownHost(options.store.getKnownHosts(), reached));
      const entry = register(reached);
      entry.host = reached;
      entry.attempt = 0;
      await connect(entry);
      changed();
      return { ok: true, machine: this.machines().find((m) => m.machineId === reached.machineId)! };
    },

    removeMachine(machineId) {
      const entry = outbound.get(machineId);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.link?.close('removed');
        outbound.delete(machineId);
      }
      options.store.setKnownHosts(removeKnownHost(options.store.getKnownHosts(), machineId));
      changed();
    },

    setDevicePermissions(fingerprint, permissions) {
      const devices = options.store.getPairedDevices();
      const target = devices.find((d) => d.fingerprint === fingerprint);
      if (!target) return;
      options.store.setPairedDevices(upsertPairedDevice(devices, { ...target, permissions: sanitizePermissions(permissions) }));
      // Permissions are read per call, but a device holding an open connection would keep using the
      // old set for anything already in flight — and the person expects "revoked" to mean now.
      server?.disconnect(fingerprint);
      changed();
    },

    revokeDevice(fingerprint) {
      options.store.setPairedDevices(removePairedDevice(options.store.getPairedDevices(), fingerprint));
      server?.disconnect(fingerprint);
      changed();
    },

    disconnectDevice(fingerprint) { server?.disconnect(fingerprint); changed(); },

    clipboardInvite() {
      // Read at the moment the screen asks, never stored: the clipboard is a shared surface and its
      // contents are none of DevDeck's business a second later.
      let text = '';
      try { text = clipboard.readText(); } catch { return null; }
      const code = findInviteCodeInText(text);
      if (!code) return null;
      const parsed = parseInviteCode(code, now());
      if (!parsed.ok) return null;
      // Already paired with this machine: offering to add it again would be a confusing no-op.
      if (outbound.has(parsed.invite.machineId)) return null;
      return { code, machineName: parsed.invite.machineName };
    },

    call(machineId, method, args) {
      return Promise.resolve().then(() => linkFor(machineId).request(method, args));
    },

    notify(machineId, method, args) {
      try { linkFor(machineId).notify(method, args); } catch { /* offline: a keystroke has nowhere to go */ }
    },

    attach(qualifiedSessionId, cols, rows) {
      const { machineId, hostId } = parseRemoteId(qualifiedSessionId);
      const entry = outbound.get(machineId);
      if (!entry) return;
      // Remembered even while offline, so a reconnect resumes the stream instead of leaving a live
      // tile silently dead.
      entry.attached.set(hostId, { cols, rows });
      entry.link?.attach(hostId, cols, rows);
    },

    detach(qualifiedSessionId) {
      const { machineId, hostId } = parseRemoteId(qualifiedSessionId);
      const entry = outbound.get(machineId);
      if (!entry) return;
      entry.attached.delete(hostId);
      entry.link?.detach(hostId);
    },

    auditLog(limit) { return log.recent(limit); },
    clearAuditLog() { log.clear(); },

    hasRemoteViewers() { return connections.some((c) => c.attachedSessions.length > 0); },

    async dispose() {
      disposed = true;
      for (const entry of outbound.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.link?.close('shutting down');
      }
      outbound.clear();
      log.flush();
      await stopServer();
    },
  };
}

/** Re-exported for the deck API's `link:*` methods. */
export { dialOrder };
