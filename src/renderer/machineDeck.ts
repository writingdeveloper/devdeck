/**
 * Which machine the deck is showing, and the one place that decides whether a call runs here or
 * travels over the link.
 *
 * Everything else in the renderer asks `deckFor(machineId)` and then makes the same calls it always
 * made. That is the whole point of the API extraction: a project on another machine is read with
 * `listProjects`, and a session on it is opened with `cockpit.open` — the same names, aimed
 * elsewhere. There is no second set of remote-flavoured functions to keep in step.
 *
 * The switcher deliberately swaps the deck rather than merging every machine's projects into one
 * list. A person with a hundred repositories on two machines does not want two hundred rows; they
 * want to be looking at one machine at a time, and to be able to tell which.
 */
import { LOCAL_MACHINE_ID, parseRemoteId } from '../shared/link/machine';
import type { MachineStatus } from '../main/link/linkService';

export { LOCAL_MACHINE_ID };
/** The error a call to another machine fails with when that machine's DevDeck predates the method. */
export const HOST_TOO_OLD = 'host-too-old';

/** The subset of the deck API the views actually call. Local and remote both satisfy it. */
export interface DeckFacade {
  listProjects: typeof window.devdeck.listProjects;
  /**
   * Anything keyed by a project PATH belongs to the machine that holds the project. A note, a pin, a
   * task list, a cost figure and a memory snapshot are all facts about work that lives over there —
   * writing or reading them here would attach them to whatever happens to sit at the same path on
   * this computer, which is the quietest kind of wrong.
   */
  projectMemory: (path: string, fresh?: boolean) => Promise<import('../shared/types').ProjectMemory>;
  setNote: (path: string, note: string) => Promise<void>;
  /** Versioned note save; against a host too old to version notes it falls back to a plain write. */
  saveNote: (path: string, note: string, revision: number) => Promise<import('../shared/types').NoteSaveResult>;
  setTodos: typeof window.devdeck.setTodos;
  setPinned: (path: string, pinned: boolean) => Promise<void>;
  setHidden: (path: string, hidden: boolean) => Promise<void>;
  usageReport: (sinceMs: number) => Promise<import('../shared/types').UsageReport>;
  cockpit: {
    open: (req: { projectPath: string; sessionId: string | null; cols: number; rows: number; mode: import('../shared/types').OpenMode; agentId: string; attachId?: string }) => Promise<{ id: string; agentId: import('../shared/types').AgentId; sessionId: string | null; error?: string; adopted?: boolean }>;
    sessionMeta: (projectPath: string, sessionId: string, agentId?: string, wantAi?: boolean) => Promise<never>;
    sessionIds: (projectPath: string, agentId?: string) => Promise<string[]>;
    sessionsExist: (items: { projectPath: string; sessionId: string | null; agentId?: string }[]) => Promise<boolean[]>;
    liveSessionId: (projectPath: string, opts: unknown) => Promise<string | null>;
    liveAgent: (id: string) => Promise<import('../shared/types').AgentId | null>;
    gitInfo: (projectPath: string) => Promise<{ branch: string | null; dirty: number } | null>;
    receiveImage: (base64: string) => Promise<string | null>;
    receiveFile: (name: string, base64: string) => Promise<string | null>;
    uploadStart: (name: string, size: number) => Promise<import('../shared/sentFiles').UploadStart>;
    uploadChunk: (id: string, offset: number, base64: string) => Promise<number | null>;
    uploadFinish: (id: string) => Promise<string | null>;
    uploadAbort: (id: string) => Promise<void>;
    createWorktree: (repoPath: string) => Promise<{ worktree?: import('../main/worktrees').Worktree; error?: string }>;
    backgroundAgents: () => Promise<import('../shared/backgroundAgents').BackgroundAgent[]>;
    worktreeInfo: (path: string) => Promise<{ worktree: import('../main/worktrees').Worktree; changes: import('../main/worktrees').WorktreeChanges } | null>;
    removeWorktree: (path: string, force: boolean) => Promise<{ removed: boolean; reason?: string; error?: string }>;
    sessionTurns: (projectPath: string, sessionId: string, agentId?: string) => Promise<import('../shared/sessionImages').SessionTurn[]>;
    sessionImages: (projectPath: string, sessionId: string, agentId?: string) => Promise<import('../shared/sessionImages').SessionImageRef[]>;
    sessionImage: (projectPath: string, sessionId: string, imageId: string, size?: 'thumb' | 'full') => Promise<import('../main/imageView').ViewImage | null>;
    imageFile: (projectPath: string, filePath: string, size?: 'thumb' | 'full') => Promise<import('../main/imageView').ViewImage | null>;
  };
}

let selected = LOCAL_MACHINE_ID;
let selectionVersion = 0;
const selectionListeners = new Set<() => void>();
let machines: MachineStatus[] = [];
const listeners = new Set<() => void>();

/**
 * The API for one machine.
 *
 * The local branch is not `window.devdeck.machine(LOCAL)` on purpose: routing local work through the
 * link's generic channel would put every deck refresh behind an extra hop and make a link failure
 * able to break a single-machine install. Local stays exactly as it was.
 */
export function deckFor(machineId: string): DeckFacade {
  if (machineId === LOCAL_MACHINE_ID) {
    return {
      listProjects: () => window.devdeck.listProjects(),
      projectMemory: (path, fresh) => window.devdeck.projectMemory(path, fresh),
      setNote: (path, note) => window.devdeck.setNote(path, note),
      saveNote: (path, note, revision) => window.devdeck.saveNote(path, note, revision),
      setTodos: (path, todos, revision) => window.devdeck.setTodos(path, todos, revision),
      setPinned: (path, pinned) => window.devdeck.setPinned(path, pinned),
      setHidden: (path, hidden) => window.devdeck.setHidden(path, hidden),
      usageReport: (sinceMs) => window.devdeck.usageReport(sinceMs),
      cockpit: window.devdeck.cockpit as unknown as DeckFacade['cockpit'],
    };
  }
  const remote = window.devdeck.machine(machineId);
  return {
    listProjects: () => remote.listProjects(),
    projectMemory: (path, fresh) => remote.projectMemory(path, fresh),
    setNote: (path, note) => remote.setNote(path, note),
    saveNote: async (path, note, revision) => {
      try { return await remote.saveNote(path, note, revision); }
      catch (error) {
        if (!/no such method/.test(error instanceof Error ? error.message : String(error))) throw error;
        await remote.setNote(path, note);
        return { ok: true, note, revision };
      }
    },
    setTodos: (path, todos, revision) => remote.setTodos(path, todos, revision),
    setPinned: (path, pinned) => remote.setPinned(path, pinned),
    setHidden: (path, hidden) => remote.setHidden(path, hidden),
    usageReport: (sinceMs) => remote.usageReport(sinceMs),
    cockpit: {
      open: (req) => remote.cockpit.open(req),
      sessionMeta: (projectPath, sessionId, agentId, wantAi) => remote.cockpit.sessionMeta(projectPath, sessionId, agentId, wantAi) as Promise<never>,
      sessionIds: (projectPath, agentId) => remote.cockpit.sessionIds(projectPath, agentId),
      sessionsExist: (items) => remote.cockpit.sessionsExist(items),
      liveSessionId: (projectPath, opts) => remote.cockpit.liveSessionId(projectPath, opts),
      // The id a tile carries is qualified with its machine so that input/resize/close route
      // themselves; the machine's own API only knows the bare id it minted.
      liveAgent: (id) => remote.cockpit.liveAgent(parseRemoteId(id).hostId),
      gitInfo: (projectPath) => remote.cockpit.gitInfo(projectPath),
      receiveImage: (base64) => remote.cockpit.receiveImage(base64),
      // An older host has no receiveFile: its 'no such method' is passed on, so the sender can say why.
      receiveFile: (name, base64) => remote.cockpit.receiveFile(name, base64),
      // An older host has no uploads either; the sender falls back to receiveFile on 'no such method'.
      uploadStart: (name, size) => remote.cockpit.uploadStart(name, size),
      uploadChunk: (id, offset, base64) => remote.cockpit.uploadChunk(id, offset, base64),
      uploadFinish: (id) => remote.cockpit.uploadFinish(id),
      uploadAbort: (id) => remote.cockpit.uploadAbort(id).catch(() => undefined),
      // An older host has no workspaces: creating one says so, reading one finds none.
      createWorktree: (repoPath) => remote.cockpit.createWorktree(repoPath).catch((error: unknown) => ({ error: /no such method/.test(String(error)) ? HOST_TOO_OLD : String(error) })),
      worktreeInfo: (path) => remote.cockpit.worktreeInfo(path).catch(() => null),
      // An older host does not list them; it simply has none to show.
      backgroundAgents: () => remote.cockpit.backgroundAgents().catch(() => []),
      removeWorktree: (path, force) => remote.cockpit.removeWorktree(path, force).catch((error: unknown) => ({ removed: false, reason: 'error', error: String(error) })),
      // A host older than the timeline is said so (the panel tells the person to update it); any other
      // failure is an empty list for now, read again on the next turn.
      sessionTurns: (projectPath, sessionId, agentId) => remote.cockpit.sessionTurns(projectPath, sessionId, agentId).catch((error: unknown) => {
        if (/no such method/.test(error instanceof Error ? error.message : String(error))) throw new Error(HOST_TOO_OLD);
        return [];
      }),
      // A host older than the image panel has no such method; it simply has no images to show.
      sessionImages: (projectPath, sessionId, agentId) => remote.cockpit.sessionImages(projectPath, sessionId, agentId).catch(() => []),
      sessionImage: (projectPath, sessionId, imageId, size) => remote.cockpit.sessionImage(projectPath, sessionId, imageId, size).catch(() => null),
      imageFile: (projectPath, filePath, size) => remote.cockpit.imageFile(projectPath, filePath, size).catch(() => null),
    },
  };
}

export function selectedMachineId(): string { return selected; }
export function machineSelectionVersion(): number { return selectionVersion; }
export function onMachineSelected(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

export function selectMachine(machineId: string): void {
  if (machineId === selected) return;
  selected = machineId;
  selectionVersion++;
  for (const listener of selectionListeners) listener();
  emit();
}

export function knownMachines(): readonly MachineStatus[] { return machines; }

export function machineName(machineId: string): string {
  if (machineId === LOCAL_MACHINE_ID) return '';
  return machines.find((m) => m.machineId === machineId)?.machineName ?? machineId.slice(0, 8);
}

export function machineState(machineId: string): MachineStatus['state'] | 'local' {
  if (machineId === LOCAL_MACHINE_ID) return 'local';
  return machines.find((m) => m.machineId === machineId)?.state ?? 'offline';
}

export function onMachinesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void { for (const listener of listeners) listener(); }

/**
 * Refresh the machine list.
 *
 * If the machine currently being viewed disappears (it was forgotten in Settings), the deck falls
 * back to this one rather than showing an empty view of a machine that is no longer known.
 */
let refreshVersion = 0;
export async function refreshMachines(): Promise<void> {
  const version = ++refreshVersion;
  let next: MachineStatus[] = [];
  try {
    next = await window.devdeck.link.machines();
  } catch {
    return; // a failed read does not mean the user forgot every paired machine
  }
  if (version !== refreshVersion) return;
  const before = JSON.stringify(machines);
  const wasConnected = new Set(machines.filter((m) => m.state === 'connected').map((m) => m.machineId));
  machines = next;
  if (selected !== LOCAL_MACHINE_ID && !next.some((m) => m.machineId === selected)) selectMachine(LOCAL_MACHINE_ID);
  // The moment a machine comes up, ask what it is already running. Connecting to a machine that is
  // mid-work and being shown nothing is the thing this exists to prevent — and it has to happen on
  // every transition INTO connected, not just the first, because a reconnect is how a laptop that
  // slept comes back.
  for (const machine of next) {
    if (machine.state === 'connected' && !wasConnected.has(machine.machineId)) {
      for (const listener of connectListeners) listener(machine.machineId);
    }
  }
  if (before !== JSON.stringify(next)) emit();
}

const connectListeners = new Set<(machineId: string) => void>();

/** Called with a machine's id each time it becomes reachable. */
export function onMachineConnected(listener: (machineId: string) => void): () => void {
  connectListeners.add(listener);
  return () => connectListeners.delete(listener);
}

/** Start following link changes. Safe to call on a machine where the link never started. */
export function watchMachines(): void {
  try { window.devdeck.link.onChanged(() => void refreshMachines()); } catch { /* no link here */ }
  void refreshMachines();
}
