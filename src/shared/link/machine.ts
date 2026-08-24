/**
 * Machine identity — the address every DevDeck Link call is scoped to.
 *
 * DevDeck has always assumed exactly one machine, so a project is identified by its path alone. That
 * stops being true the moment a second machine's deck is shown here: `C:\Users\me\GitHub\devdeck`
 * exists on the desktop AND the laptop, and they are different projects with different git state and
 * different sessions. Anything keyed by path has to be keyed by (machine, path) instead.
 */

/**
 * The viewing machine's own id, as seen from its renderer. Not a real machine id: it is the absence of
 * one, so every existing call site keeps working unchanged and a missing id can never be mistaken for
 * a remote machine.
 */
export const LOCAL_MACHINE_ID = 'local';

/** Machine ids are UUIDs generated once per install. `local` is reserved for the viewer itself. */
const MACHINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidMachineId(value: unknown): value is string {
  return typeof value === 'string' && (value === LOCAL_MACHINE_ID || MACHINE_ID_RE.test(value));
}

/** Narrow an untrusted id (persisted state, a link frame) to a usable one; the viewer itself by default. */
export function toMachineId(value: unknown): string {
  return isValidMachineId(value) ? value : LOCAL_MACHINE_ID;
}

export function isLocalMachine(machineId: unknown): boolean {
  return toMachineId(machineId) === LOCAL_MACHINE_ID;
}

const MAX_MACHINE_NAME = 40;

/**
 * A machine's display name. Defaults to its hostname, which is what the person already calls it.
 * Control characters are stripped rather than escaped: this string is rendered in the sidebar next to
 * session rows, and a stray newline or ANSI escape from a hostile pairing payload must not be able to
 * disturb that layout.
 */
export function sanitizeMachineName(raw: unknown, fallback: string): string {
  const cleaned = cleanName(typeof raw === 'string' ? raw : '');
  if (cleaned) return trimForDisplay(cleaned);
  return trimForDisplay(cleanName(fallback)) || 'DevDeck';
}

function cleanName(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Trim an over-long name from the MIDDLE, not the end.
 *
 * Machine-managed hostnames are long, share a prefix, and differ only in a trailing id — a macOS CI
 * runner is called `sat12-bq154-ac99a524-1123-4271-b1f4-a8122e02bd5b-5691A934C60D.local`. Cutting the
 * tail off names like those makes two machines display identically, which is the one thing this label
 * exists to prevent: it is what tells you which machine's terminal you are about to type into.
 */
function trimForDisplay(text: string): string {
  if (text.length <= MAX_MACHINE_NAME) return text;
  const tail = 12;
  return `${text.slice(0, MAX_MACHINE_NAME - tail - 1)}…${text.slice(-tail)}`;
}

/**
 * Key for anything that used to be keyed by project path alone — the deck's reconcile signature, tile
 * lookups, per-project caches. The local machine keeps the bare path so existing persisted state and
 * signatures stay byte-identical; only remote entries carry a prefix.
 */
export function machineScopedKey(machineId: unknown, path: string): string {
  const id = toMachineId(machineId);
  return id === LOCAL_MACHINE_ID ? path : `${id}\u0000${path}`;
}

/** Split a scoped key back into its parts. */
export function parseMachineScopedKey(key: string): { machineId: string; path: string } {
  const sep = key.indexOf('\u0000');
  if (sep < 0) return { machineId: LOCAL_MACHINE_ID, path: key };
  return { machineId: toMachineId(key.slice(0, sep)), path: key.slice(sep + 1) };
}

/**
 * Terminal-session ids, qualified by the machine that owns them.
 *
 * A remote session's id is minted by the HOST and means nothing here on its own — two machines can
 * hand out the same one. Rather than teaching every part of the viewer to carry a machine alongside
 * every id, remote ids are qualified once at the boundary and the rest of the app keeps seeing a
 * single flat id space.
 *
 * `link:` is the sentinel because no local id can start with it: local pty ids are `<project path>#n`
 * (an absolute path, so it begins with a drive letter or a slash) or `usage-login:<provider>:n`.
 */
const REMOTE_ID_PREFIX = 'link:';

export function qualifyRemoteId(machineId: string, hostId: string): string {
  return `${REMOTE_ID_PREFIX}${machineId}:${hostId}`;
}

export function isRemoteId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(REMOTE_ID_PREFIX);
}

/**
 * Split a qualified id. Returns the local machine and the id unchanged when it is not qualified, so
 * callers can route every id through here without first asking which kind it is.
 *
 * The machine id is a fixed-length UUID, so the split point is unambiguous even though the host's
 * portion usually contains colons of its own (it embeds a Windows path).
 */
export function parseRemoteId(id: string): { machineId: string; hostId: string } {
  if (!isRemoteId(id)) return { machineId: LOCAL_MACHINE_ID, hostId: id };
  const body = id.slice(REMOTE_ID_PREFIX.length);
  const machineId = body.slice(0, 36);
  if (!isValidMachineId(machineId) || machineId === LOCAL_MACHINE_ID || body[36] !== ':') {
    return { machineId: LOCAL_MACHINE_ID, hostId: id };
  }
  return { machineId, hostId: body.slice(37) };
}
