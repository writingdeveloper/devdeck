/**
 * The two device ledgers a machine keeps, and the dial order that makes reconnecting work.
 *
 *  - `PairedDevice` (inbound): who may connect TO this machine, pinned by certificate fingerprint,
 *    with what permissions. The host's side of a pairing.
 *  - `KnownHost` (outbound): a machine this one connects to — where to reach it and what fingerprint
 *    to demand when it answers. The viewer's side.
 *
 * Both are persisted, so both are parsed defensively: a corrupted entry must degrade to "cannot
 * connect", never to "connects with more access than was granted".
 */
import { fingerprintsMatch } from './selfSignedCert';
import { sanitizePermissions, type LinkPermission } from '../../shared/link/permissions';
import { sanitizeMachineName } from '../../shared/link/machine';

export interface PairedDevice {
  machineId: string;
  machineName: string;
  /** Their certificate's SHA-256. The only thing that authenticates them after pairing. */
  fingerprint: string;
  permissions: LinkPermission[];
  pairedAtMs: number;
  lastSeenMs: number | null;
}

export interface KnownHost {
  machineId: string;
  machineName: string;
  /** Their certificate's SHA-256, taken from the invite code and pinned from the first connection. */
  fingerprint: string;
  /** Candidates in the host's own preferred order (addressCandidates.ts). Refreshed on each connect. */
  addresses: string[];
  port: number;
  /** The address that last completed a handshake. Tried first; that is the whole reconnect strategy. */
  lastAddress: string | null;
  lastSeenMs: number | null;
}

const MAX_DEVICES = 32;
const MAX_ADDRESSES = 8;

function normalizeFingerprint(raw: unknown): string {
  const hex = typeof raw === 'string' ? raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : '';
  // Anything that is not a full SHA-256 is not a fingerprint. Keeping a short one would create an
  // entry that can never match a real peer — or, worse, invite someone to "fix" the comparison.
  return hex.length === 64 ? (hex.match(/../g) ?? []).join(':') : '';
}

function normalizeAddresses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const address = value.trim().slice(0, 253);
    // A stored address is handed straight to a socket, so it is VALIDATED rather than cleaned up:
    // deleting characters would turn `SIHYEONG-MAIN` into a hostname that resolves to nothing and
    // then report it as the address that failed. Letters, digits, dot, hyphen, underscore and colon
    // cover every hostname and IPv4/IPv6 literal; anything else is not an address.
    if (!address || !/^[A-Za-z0-9._:-]+$/.test(address) || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

function normalizePort(raw: unknown, fallback: number): number {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function finiteOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function sanitizePairedDevices(raw: unknown): PairedDevice[] {
  if (!Array.isArray(raw)) return [];
  const out: PairedDevice[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const fingerprint = normalizeFingerprint(row.fingerprint);
    const machineId = typeof row.machineId === 'string' ? row.machineId : '';
    // A device with no fingerprint can never be authenticated; keeping it would only put a row in the
    // permission UI that grants access to nobody and confuses everybody.
    if (!fingerprint || !machineId || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({
      machineId,
      machineName: sanitizeMachineName(row.machineName, machineId.slice(0, 8)),
      fingerprint,
      permissions: sanitizePermissions(row.permissions),
      pairedAtMs: finiteOrNull(row.pairedAtMs) ?? 0,
      lastSeenMs: finiteOrNull(row.lastSeenMs),
    });
    if (out.length >= MAX_DEVICES) break;
  }
  return out;
}

export function sanitizeKnownHosts(raw: unknown, defaultPort: number): KnownHost[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownHost[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const fingerprint = normalizeFingerprint(row.fingerprint);
    const machineId = typeof row.machineId === 'string' ? row.machineId : '';
    const addresses = normalizeAddresses(row.addresses);
    // No fingerprint means no pin, and connecting without a pin is exactly the thing this design
    // exists to prevent. No address means nowhere to dial.
    if (!fingerprint || !machineId || addresses.length === 0 || seen.has(machineId)) continue;
    seen.add(machineId);
    const lastAddress = typeof row.lastAddress === 'string' ? normalizeAddresses([row.lastAddress])[0] ?? null : null;
    out.push({
      machineId,
      machineName: sanitizeMachineName(row.machineName, machineId.slice(0, 8)),
      fingerprint,
      addresses,
      port: normalizePort(row.port, defaultPort),
      lastAddress,
      lastSeenMs: finiteOrNull(row.lastSeenMs),
    });
    if (out.length >= MAX_DEVICES) break;
  }
  return out;
}

/** The paired device presenting `fingerprint`, or null. Identity is the fingerprint, never the name. */
export function findPairedDevice(devices: readonly PairedDevice[], fingerprint: unknown): PairedDevice | null {
  return devices.find((d) => fingerprintsMatch(d.fingerprint, fingerprint)) ?? null;
}

/**
 * Add or update a paired device, keyed by fingerprint.
 *
 * Re-pairing an existing device REPLACES its permissions rather than merging them: pairing shows the
 * person a permission set and they approve that set, so silently keeping a permission that is no
 * longer on screen would grant access nobody agreed to.
 */
export function upsertPairedDevice(devices: readonly PairedDevice[], device: PairedDevice): PairedDevice[] {
  const rest = devices.filter((d) => !fingerprintsMatch(d.fingerprint, device.fingerprint));
  return [...rest, device].slice(-MAX_DEVICES);
}

export function removePairedDevice(devices: readonly PairedDevice[], fingerprint: unknown): PairedDevice[] {
  return devices.filter((d) => !fingerprintsMatch(d.fingerprint, fingerprint));
}

export function upsertKnownHost(hosts: readonly KnownHost[], host: KnownHost): KnownHost[] {
  const rest = hosts.filter((h) => h.machineId !== host.machineId);
  return [...rest, host].slice(-MAX_DEVICES);
}

export function removeKnownHost(hosts: readonly KnownHost[], machineId: string): KnownHost[] {
  return hosts.filter((h) => h.machineId !== machineId);
}

/**
 * The order to try a host's addresses in.
 *
 * Last-known-good first. That single rule is what makes a moved laptop reconnect without anybody
 * touching a setting: the address that worked yesterday is almost always the address that works
 * today, and when it is not, the rest of the list is right behind it in the host's own preferred
 * order (overlay, then LAN, then names — see addressCandidates.ts).
 */
export function dialOrder(host: Pick<KnownHost, 'addresses' | 'lastAddress'>): string[] {
  const rest = host.addresses.filter((a) => a.toLowerCase() !== (host.lastAddress ?? '').toLowerCase());
  return host.lastAddress ? [host.lastAddress, ...rest] : [...rest];
}

/**
 * Record a successful connection: remember which address answered, and adopt the address list the
 * host just reported.
 *
 * Adopting the host's list is what keeps a pairing alive across a network change — the host
 * re-enumerates its interfaces on every connect, so a machine that moved offices teaches the client
 * its new address using the one that still worked.
 */
export function noteHostReached(
  host: KnownHost,
  reached: { address: string; addresses?: readonly string[]; port?: number; machineName?: string; nowMs: number },
): KnownHost {
  const advertised = normalizeAddresses(reached.addresses ?? []);
  // Keep the address that actually worked even if the host stopped advertising it: it is the one
  // piece of evidence we have that beats the host's own opinion about how to reach itself.
  const merged = normalizeAddresses([reached.address, ...advertised, ...host.addresses]);
  return {
    ...host,
    machineName: reached.machineName ? sanitizeMachineName(reached.machineName, host.machineName) : host.machineName,
    addresses: merged,
    port: normalizePort(reached.port, host.port),
    lastAddress: reached.address,
    lastSeenMs: reached.nowMs,
  };
}
