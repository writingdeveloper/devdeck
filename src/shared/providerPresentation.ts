import { toAgentId, type AgentId } from './types';

/** How a provider is PRESENTED (mark + localized name), kept independent of the main-process
 *  AgentProvider implementations so the renderer never builds a label from a raw identifier. */
export interface ProviderPresentation { nameKey: string; logoSrc: string; }

// Marks are bundled local SVGs (copied to dist/renderer/assets) — the renderer runs under
// `connect-src 'none'`, so no remote image, font, or data: URL may be used here.
export const PROVIDER_PRESENTATION: Record<AgentId, ProviderPresentation> = {
  claude: { nameKey: 'agent.claude', logoSrc: './assets/provider-claude.svg' },
  codex: { nameKey: 'agent.codex', logoSrc: './assets/provider-codex.svg' },
  antigravity: { nameKey: 'agent.antigravity', logoSrc: './assets/provider-antigravity.svg' },
};

/** Presentation for an id, falling back to Claude the same way persisted state does. */
export function providerPresentation(id: AgentId): ProviderPresentation {
  return PROVIDER_PRESENTATION[toAgentId(id) ?? 'claude'];
}

/** Stable display order for provider lists (footer cluster, usage modal sections). */
export const PROVIDER_ORDER: AgentId[] = ['claude', 'codex', 'antigravity'];
