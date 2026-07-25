import { providerPresentation } from '../shared/providerPresentation';
import type { AgentId } from '../shared/types';
import { tr } from './i18n-runtime';

/** The one place a provider mark is built. Every surface (live row, previous row, cockpit header,
 *  usage footer/modal) uses this so identity never depends on color alone or on a raw identifier:
 *  the localized provider name is always carried as alt + title. */
export function createProviderLogo(agentId: AgentId, className = 'ck-provider-logo'): HTMLImageElement {
  const { logoSrc, nameKey } = providerPresentation(agentId);
  const img = document.createElement('img');
  img.className = className;
  img.src = logoSrc;
  const name = tr(nameKey);
  img.alt = name;
  img.title = name;
  img.draggable = false;
  return img;
}

/** Localized provider display name (never the raw AgentId). */
export function providerName(agentId: AgentId): string {
  return tr(providerPresentation(agentId).nameKey);
}
