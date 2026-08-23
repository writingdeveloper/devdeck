/**
 * What one paired machine is allowed to ask another to do.
 *
 * Granted per device on the HOST, shown to the person at pairing time, and revocable there afterwards.
 * The set is deliberately small: a permission nobody can explain in one line is a permission nobody
 * will read before granting.
 *
 * Lives in `shared/` because both ends need it — the host to gate calls, the viewer to render the
 * pairing and permission screens.
 */
export type LinkPermission =
  /** Read the deck: projects, sessions, git state, usage summaries. */
  | 'observe'
  /** Drive an EXISTING session: input, resize, attach, close. */
  | 'control'
  /** Start work: open a new session, create a project folder, launch an external terminal/editor. */
  | 'spawn'
  /** Change stored state: notes, todos, pins, thresholds. */
  | 'write'
  /** Act on the host machine itself (idle shutdown). Off by default. */
  | 'power';

/** Display order — widest-reaching last, so the dangerous one is not the first thing clicked past. */
export const LINK_PERMISSIONS: readonly LinkPermission[] = ['observe', 'control', 'spawn', 'write', 'power'];

/**
 * What a device gets when it pairs, unless the person changes it: everything needed to actually work
 * on the other machine, and nothing that acts on the machine itself.
 *
 * `power` is excluded on purpose. Being able to see a machine must never imply being able to shut it
 * down while someone is sitting at it.
 */
export const DEFAULT_LINK_PERMISSIONS: readonly LinkPermission[] = ['observe', 'control', 'spawn', 'write'];

/** i18n keys for the pairing/permission UI, so the strings live with the locales, not here. */
export const LINK_PERMISSION_LABEL_KEY: Record<LinkPermission, string> = {
  observe: 'link.perm.observe',
  control: 'link.perm.control',
  spawn: 'link.perm.spawn',
  write: 'link.perm.write',
  power: 'link.perm.power',
};

export function isLinkPermission(value: unknown): value is LinkPermission {
  return typeof value === 'string' && (LINK_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Narrow an untrusted permission list (persisted state, a pairing frame) to known values.
 *
 * Deliberately NOT falling back to the defaults when the input is junk: a corrupted entry must
 * degrade to "this device can do nothing" and be re-granted deliberately, never silently re-widen to
 * a working set the person never approved.
 */
export function sanitizePermissions(raw: unknown): LinkPermission[] {
  if (!Array.isArray(raw)) return [];
  const kept = new Set<LinkPermission>();
  for (const value of raw) if (isLinkPermission(value)) kept.add(value);
  return LINK_PERMISSIONS.filter((p) => kept.has(p));
}
