import { basename } from './paths';

/** A cockpit session remembered across restarts, enough to re-open it via the agent's resume command. */
export interface PersistedSession {
  tileId: string;           // opaque tile identity; independent of the conversation/provider identity
  projectPath: string;
  name: string;
  sessionId: string | null; // the specific session to resume, or null to continue/new
  agentId: string;          // 'claude' | 'antigravity' | 'codex' — which agent the session was opened with
  label?: string | null;    // user-given custom name (overrides the auto label); null/absent = auto
  pinned?: boolean;         // user pinned this session to the top group (absent = not pinned)
}

/** Identity available at the Cockpit navigation boundary. Runtime IDs distinguish id-less live tiles. */
export interface CockpitNavigationIdentity {
  tileId?: string;
  projectPath: string;
  sessionId: string | null;
  runtimeId?: string;
}

let fallbackTileSequence = 0;

/** Create an opaque identity once for a Cockpit tile, then persist it with that tile. */
export function createCockpitTileId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  fallbackTileSequence += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackTileSequence.toString(36)}`;
}

/** Stable shared-shell address for a Cockpit tile across conversation/provider drift and restart. */
export function cockpitNavigationId(entry: CockpitNavigationIdentity): string {
  if (entry.tileId) return `tile:${encodeURIComponent(entry.tileId)}`;
  return legacyCockpitNavigationId(entry);
}

/** Address emitted by builds before opaque tile identities existed (migration only). */
export function legacyCockpitNavigationId(entry: CockpitNavigationIdentity): string {
  const path = encodeURIComponent(entry.projectPath);
  if (entry.sessionId) return `previous:${path}:${encodeURIComponent(entry.sessionId)}`;
  if (entry.runtimeId) return `live:${path}:${encodeURIComponent(entry.runtimeId)}`;
  return `previous:${path}:`;
}

/** Restoration/in-flight de-duplication key; id-less sibling tiles must never collide. */
export function persistedSessionKey(entry: Pick<PersistedSession, 'tileId'>): string {
  return entry.tileId;
}

/**
 * Remove the saved copies that an update relaunch is about to restore. Exact opaque identities win.
 * Separately migrated legacy lists can have different generated IDs, so fall back one-for-one to the
 * old address; never filter every matching id-less sibling at once.
 */
export function removeAutoRestoreMatches(
  restorable: readonly PersistedSession[],
  pending: readonly PersistedSession[],
): PersistedSession[] {
  const remaining = [...restorable];
  for (const item of pending) {
    let index = remaining.findIndex((candidate) => persistedSessionKey(candidate) === persistedSessionKey(item));
    if (index < 0) {
      const legacy = legacyCockpitNavigationId(item);
      index = remaining.findIndex((candidate) => legacyCockpitNavigationId(candidate) === legacy);
    }
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/** Translate the runtime ID carried by a notification into the shell's current navigation identity. */
export function cockpitNavigationIdForRuntime(entries: readonly CockpitNavigationIdentity[], runtimeId: string): string | null {
  const entry = entries.find((item) => item.runtimeId === runtimeId);
  return entry ? cockpitNavigationId(entry) : null;
}

const MAX_PERSISTED = 50;
const MAX_LABEL = 60;

/**
 * Choose which session a restored cockpit tile should resume when it never named one of its own.
 * Resumes the NEWEST session (`newestFirstIds` is mtime-desc from listSessions) that isn't already
 * open in another tile, so multiple tiles of one project each get a distinct recent conversation.
 * `reservedIds` are conversations OTHER saved entries are still waiting to restore: skip those when
 * anything else is free, or the open consumes that entry (adoptRestorableMatch) and the user's name
 * for it is gone. A preference, not a rule — an id-less entry must still restore something.
 * null → nothing to resume (caller falls back to continue/new).
 */
export function pickRestoreSessionId(newestFirstIds: string[], liveIds: Set<string>, reservedIds: Set<string> = new Set()): string | null {
  let reservedFallback: string | null = null;
  for (const id of newestFirstIds) {
    if (liveIds.has(id)) continue;
    if (!reservedIds.has(id)) return id;
    reservedFallback ??= id;
  }
  return reservedFallback;
}

/** What a restored tile should launch. `fresh` = start a brand-new conversation under the entry's
 *  name, because the one it named cannot be reopened. */
export interface RestoreTarget { sessionId: string | null; fresh: boolean; }

/**
 * Which conversation a restored tile should reopen. A saved entry NAMES one conversation and carries
 * the user's own label + pin for it, so its own id wins whenever it can still be opened —
 * `newestFirstIds` must be ALL of the project's on-disk ids (mtime-desc) so an older-but-valid saved
 * id is still recognized as existing, and each of a project's conversations keeps its own tile
 * instead of every tile collapsing onto the newest one (the "3rd session vanished" bug).
 *
 * When that conversation CANNOT be opened — its transcript is gone (Claude Code deletes transcripts
 * after `cleanupPeriodDays`; a session the user never typed in was never written at all) or another
 * tile already holds it — the tile must NOT be handed a different conversation. Substituting the
 * newest one is what made a renamed tile come back showing a stranger's work under the user's name,
 * and worse: that open then CONSUMED the saved entry which really owned the substituted conversation,
 * deleting its label. Such a tile comes back FRESH instead — same name, empty terminal, no lie.
 *
 * An entry with NO saved id is judged the same way, once you know what the absent id means:
 *  - Antigravity never records which conversation a tile holds (no `--session-id` to pin, and the live
 *    id probe doesn't run for it), so ALL its entries are id-less and an absent id says nothing at
 *    all. The newest-not-live guess is that provider's only resume — keep it.
 *  - Claude and Codex do record one, so an absent id means the tile never wrote a conversation. If the
 *    user NAMED that tile, the name is a claim about specific work and a substitute would break it the
 *    same way — such an entry comes back fresh too. Unnamed, the tile claims nothing beyond "a session
 *    in this project", which any of its conversations satisfies, so the fallback still applies (two
 *    concurrent Codex tiles whose ids were never adopted both come back on real conversations).
 */
export function resolveRestoreTarget(
  entry: Pick<PersistedSession, 'sessionId' | 'label' | 'agentId'>,
  newestFirstIds: string[],
  liveIds: Set<string>,
  reservedIds: Set<string> = new Set(),
): RestoreTarget {
  if (entry.sessionId) {
    const usable = newestFirstIds.includes(entry.sessionId) && !liveIds.has(entry.sessionId);
    return usable ? { sessionId: entry.sessionId, fresh: false } : { sessionId: null, fresh: true };
  }
  if (entry.label && entry.agentId !== 'antigravity') return { sessionId: null, fresh: true };
  return { sessionId: pickRestoreSessionId(newestFirstIds, liveIds, reservedIds), fresh: false };
}

/** One on-disk session file's identity + timestamps, for the live drift detector below. */
export interface SessionFileStat { id: string; mtimeMs: number; birthtimeMs: number; }

// A candidate file only counts as "this tile's output" when its mtime tracks the tile's last PTY
// output this closely — an unrelated session streaming in another terminal won't stay coupled.
const DRIFT_COUPLING_MS = 8_000;

/**
 * Detect that a live tile's conversation MOVED to a different on-disk session. `--resume`/`-c`/
 * compaction append in place, but /clear (and a manual `claude` run inside the tile's shell) starts a
 * BRAND-NEW session id in the same terminal — the tile's open-time id then goes permanently stale, so
 * persisting it restores the PAST conversation after a restart/update (the "과거 데이터 복원" bug).
 *
 * Adopt a new id only on unambiguous evidence, ALL of:
 *  - the tile produced output since the last check (something was written on our behalf),
 *  - the tile's CURRENT file did not move since the last check (the output went elsewhere),
 *  - exactly ONE unclaimed file moved since the last check, was born after the tile opened,
 *    and its mtime tracks the tile's output time (uncoupled writes belong to other terminals).
 * Anything ambiguous returns null (keep the current id — a later sample disambiguates).
 */
export function pickDriftedSessionId(
  stats: SessionFileStat[],
  opts: { currentId: string | null; claimedIds: string[]; openedAtMs: number; sinceMs: number; lastDataAtMs: number },
): string | null {
  if (opts.lastDataAtMs <= opts.sinceMs) return null; // no output since the last check
  const cur = stats.find((s) => s.id === opts.currentId);
  if (cur && cur.mtimeMs > opts.sinceMs) return null; // our own file is still being written — no drift
  const claimed = new Set(opts.claimedIds);
  const candidates = stats.filter((s) =>
    s.id !== opts.currentId && !claimed.has(s.id)
    && s.mtimeMs > opts.sinceMs
    && s.birthtimeMs > opts.openedAtMs
    && Math.abs(s.mtimeMs - opts.lastDataAtMs) <= DRIFT_COUPLING_MS);
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Which conversation a tile that has NO id yet is writing to. Used after the tile's provider is
 * re-detected (the user ran a different agent in the tile's shell, so the old id belonged to the old
 * provider and was dropped): there is nothing to compare against, so the birth-time gate above can't
 * apply — a `claude -c` picks up a file born long before the tile opened.
 *
 * The coupling + uniqueness gates still stand, so a session streaming in an external terminal for the
 * same project can't be adopted: exactly one unclaimed file must have moved since the last check, in
 * lockstep with this tile's own output.
 */
export function pickAdoptedSessionId(
  stats: SessionFileStat[],
  opts: { claimedIds: string[]; sinceMs: number; lastDataAtMs: number },
): string | null {
  if (opts.lastDataAtMs <= opts.sinceMs) return null; // no output since the last check
  const claimed = new Set(opts.claimedIds);
  const candidates = stats.filter((s) =>
    !claimed.has(s.id)
    && s.mtimeMs > opts.sinceMs
    && Math.abs(s.mtimeMs - opts.lastDataAtMs) <= DRIFT_COUPLING_MS);
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * A newly-opened session that lands on a conversation a saved (restorable) entry already points at
 * CONSUMES that entry — and must inherit its user-given pin + label unless the open request carries
 * its own. Without this, opening a project from the deck / task board / ⟳ restart (none of which
 * know about pins) silently erased the pin from persistence even though state.json had saved it.
 */
export function adoptRestorableMatch(
  restorable: PersistedSession[],
  sessionId: string | null,
  req: { tileId?: string; label: string | null; pinned: boolean },
): { rest: PersistedSession[]; tileId: string | undefined; label: string | null; pinned: boolean } {
  if (!sessionId) return { rest: restorable, tileId: req.tileId, label: req.label, pinned: req.pinned };
  const match = restorable.find((r) => r.sessionId === sessionId);
  return {
    rest: restorable.filter((r) => r.sessionId !== sessionId),
    tileId: req.tileId ?? match?.tileId,
    label: req.label ?? match?.label ?? null,
    pinned: req.pinned || match?.pinned === true,
  };
}

/**
 * Validate/normalize a persisted-session list loaded from disk (defends against a corrupted
 * state.json): drops entries without a string projectPath, defaults the name to the path
 * basename, coerces sessionId to string|null and agentId to a known provider, caps the count.
 */
export function sanitizePersistedList(raw: unknown, createTileId: () => string = createCockpitTileId): PersistedSession[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedSession[] = [];
  const usedTileIds = new Set<string>();
  const uniqueTileId = (candidate: unknown): string => {
    const supplied = typeof candidate === 'string' ? candidate.trim().slice(0, 128) : '';
    if (supplied && !usedTileIds.has(supplied)) { usedTileIds.add(supplied); return supplied; }
    for (let attempt = 0; attempt < 8; attempt++) {
      const generated = String(createTileId()).trim().slice(0, 128);
      if (generated && !usedTileIds.has(generated)) { usedTileIds.add(generated); return generated; }
    }
    // A broken/custom generator must not collapse two tiles. The suffix is migration-only fallback.
    const base = String(createTileId()).trim().slice(0, 96) || 'tile';
    let suffix = out.length + 1;
    while (usedTileIds.has(`${base}-${suffix}`)) suffix += 1;
    const generated = `${base}-${suffix}`;
    usedTileIds.add(generated);
    return generated;
  };
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.projectPath !== 'string' || !o.projectPath) continue;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, MAX_LABEL) : null;
    out.push({
      tileId: uniqueTileId(o.tileId),
      projectPath: o.projectPath,
      name: typeof o.name === 'string' && o.name ? o.name : basename(o.projectPath),
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      agentId: o.agentId === 'antigravity' || o.agentId === 'codex' ? o.agentId : 'claude',
      label,
      pinned: o.pinned === true ? true : undefined, // omit when not pinned (keeps state.json minimal)
    });
    if (out.length >= MAX_PERSISTED) break;
  }
  return out;
}
