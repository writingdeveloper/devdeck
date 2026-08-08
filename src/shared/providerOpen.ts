import type { AgentId } from './types';

export type ProviderOpenOutcome = 'focus' | 'continue' | 'new';

export interface ProviderOpenOption {
  agentId: AgentId;
  selected: boolean;
  outcome: ProviderOpenOutcome;
}

/** Describe what an automatic open will do for one provider, independent of other providers. */
export function providerOpenOutcome(
  agentId: AgentId,
  historyAgentIds: readonly AgentId[],
  liveAgentIds: readonly AgentId[],
): ProviderOpenOutcome {
  if (liveAgentIds.includes(agentId)) return 'focus';
  return historyAgentIds.includes(agentId) ? 'continue' : 'new';
}

/** Selected provider first, then the remaining installed providers in their stable input order. */
export function providerOpenOptions(
  installed: readonly AgentId[],
  selected: AgentId,
  historyAgentIds: readonly AgentId[],
  liveAgentIds: readonly AgentId[],
): ProviderOpenOption[] {
  const ids = installed.includes(selected)
    ? [selected, ...installed.filter((id) => id !== selected)]
    : [...installed];
  return ids.map((agentId) => ({
    agentId,
    selected: agentId === selected,
    outcome: providerOpenOutcome(agentId, historyAgentIds, liveAgentIds),
  }));
}
