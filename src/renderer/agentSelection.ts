import type { AgentId } from '../shared/types';

export interface AgentSelectionStore {
  installed(): AgentId[];
  selected(): AgentId;
  select(id: AgentId): void;
  subscribe(listener: (id: AgentId) => void): () => void;
}

export function createAgentSelectionStore(installed: readonly AgentId[], selected: AgentId): AgentSelectionStore {
  const ids = [...new Set(installed)];
  if (ids.length === 0) ids.push(selected);
  let current = ids.includes(selected) ? selected : ids[0];
  const listeners = new Set<(id: AgentId) => void>();
  return {
    installed: () => [...ids],
    selected: () => current,
    select: (id) => {
      if (!ids.includes(id) || id === current) return;
      current = id;
      for (const listener of listeners) listener(current);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = createAgentSelectionStore(['claude'], 'claude');

export function initializeAgentSelection(installed: readonly AgentId[], selected: AgentId): void {
  shared = createAgentSelectionStore(installed, selected);
}
export function installedAgents(): AgentId[] { return shared.installed(); }
export function selectedAgent(): AgentId { return shared.selected(); }
export function setSelectedAgent(id: AgentId): void { shared.select(id); }
export function subscribeAgentSelection(listener: (id: AgentId) => void): () => void { return shared.subscribe(listener); }
