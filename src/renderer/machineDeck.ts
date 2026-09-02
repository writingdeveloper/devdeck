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
  setTodos: (path: string, todos: import('../shared/tasks').Todo[]) => Promise<void>;
  setPinned: (path: string, pinned: boolean) => Promise<void>;
  setHidden: (path: string, hidden: boolean) => Promise<void>;
  usageReport: (sinceMs: number) => Promise<import('../shared/types').UsageReport>;
  cockpit: {
    open: (req: { projectPath: string; sessionId: string | null; cols: number; rows: number; mode: import('../shared/types').OpenMode; agentId: string }) => Promise<{ id: string; agentId: import('../shared/types').AgentId; sessionId: string | null; error?: string; adopted?: boolean }>;
    sessionMeta: (projectPath: string, sessionId: string, agentId?: string, wantAi?: boolean) => Promise<never>;
    sessionIds: (projectPath: string, agentId?: string) => Promise<string[]>;
    sessionsExist: (items: { projectPath: string; sessionId: string | null; agentId?: string }[]) => Promise<boolean[]>;
    liveSessionId: (projectPath: string, opts: unknown) => Promise<string | null>;
    liveAgent: (id: string) => Promise<import('../shared/types').AgentId | null>;
    gitInfo: (projectPath: string) => Promise<{ branch: string | null; dirty: number } | null>;
  };
}

let selected = LOCAL_MACHINE_ID;
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
      setTodos: (path, todos) => window.devdeck.setTodos(path, todos),
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
    setTodos: (path, todos) => remote.setTodos(path, todos),
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
    },
  };
}

export function selectedMachineId(): string { return selected; }

export function selectMachine(machineId: string): void {
  if (machineId === selected) return;
  selected = machineId;
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
export async function refreshMachines(): Promise<void> {
  let next: MachineStatus[] = [];
  try {
    next = await window.devdeck.link.machines();
  } catch {
    next = []; // the link is unavailable on this machine; there is simply nothing to switch to
  }
  const before = JSON.stringify(machines);
  const wasConnected = new Set(machines.filter((m) => m.state === 'connected').map((m) => m.machineId));
  machines = next;
  if (selected !== LOCAL_MACHINE_ID && !next.some((m) => m.machineId === selected)) selected = LOCAL_MACHINE_ID;
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
