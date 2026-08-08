import { providerOpenOptions, type ProviderOpenOutcome } from '../shared/providerOpen';
import type { AgentId, ProjectOpenIntent } from '../shared/types';
import { installedAgents, selectedAgent, subscribeAgentSelection } from './agentSelection';
import { tr } from './i18n-runtime';
import { createProviderLogo, providerName } from './providerLogo';

export interface ProviderOpenControlOptions {
  path: string;
  historyAgentIds: readonly AgentId[];
  liveAgentIds(): readonly AgentId[];
  compact?: boolean;
  onOpen(intent: ProjectOpenIntent): void;
}

const outcomeKey: Record<ProviderOpenOutcome, string> = {
  focus: 'open.status_focus',
  continue: 'open.status_continue',
  new: 'open.status_new',
};

// One shared selection subscription updates only controls that are still in the document. Keeping
// renderers in a WeakMap avoids retaining every control ever replaced by a view re-render.
const primaryRenderers = new WeakMap<HTMLElement, () => void>();
subscribeAgentSelection(() => {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>('.provider-open'))) {
    primaryRenderers.get(root)?.();
  }
});

/** One provider-aware Open control shared by project cards, project rows, and task rows. */
export function createProviderOpenControl(opts: ProviderOpenControlOptions): HTMLElement {
  const root = document.createElement('span');
  root.className = 'provider-open' + (opts.compact ? ' compact' : '');

  const primary = document.createElement('button');
  primary.className = 'primary provider-open-primary';
  const menuButton = document.createElement('button');
  menuButton.className = 'primary provider-open-menu-button';
  menuButton.type = 'button';
  menuButton.textContent = '▾';
  menuButton.setAttribute('aria-haspopup', 'menu');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', tr('open.choose_provider'));

  const menu = document.createElement('div');
  menu.className = 'menu provider-open-menu hidden';
  menu.setAttribute('role', 'menu');

  let open = false;
  const emit = (agentId: AgentId, mode: 'auto' | 'new'): void => {
    opts.onOpen({ path: opts.path, sessionId: null, agentId, mode });
  };

  const renderPrimary = (): void => {
    const agentId = selectedAgent();
    const name = providerName(agentId);
    primary.replaceChildren(createProviderLogo(agentId, 'provider-open-logo'));
    const label = document.createElement('span');
    label.className = 'provider-open-primary-text';
    label.textContent = opts.compact ? '▶' : `▶ ${tr('proj.open')}`;
    primary.appendChild(label);
    primary.setAttribute('aria-label', tr('open.with_provider', { provider: name }));
    primary.title = tr('open.with_provider', { provider: name });
  };

  const closeMenu = (restoreFocus = false): void => {
    if (!open) return;
    open = false;
    menu.classList.add('hidden');
    menuButton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointer);
    document.removeEventListener('keydown', onDocumentKey);
    if (restoreFocus) menuButton.focus();
  };

  const activate = (agentId: AgentId, mode: 'auto' | 'new'): void => {
    closeMenu();
    emit(agentId, mode);
  };

  const menuItems = (): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
  const onMenuKey = (event: KeyboardEvent): void => {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault(); items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault(); items.at(-1)?.focus();
    }
  };

  const renderMenu = (): void => {
    menu.replaceChildren();
    for (const option of providerOpenOptions(installedAgents(), selectedAgent(), opts.historyAgentIds, opts.liveAgentIds())) {
      const row = document.createElement('div'); row.className = 'provider-open-row'; row.setAttribute('role', 'none');
      const automatic = document.createElement('button');
      automatic.type = 'button'; automatic.className = 'provider-open-option'; automatic.setAttribute('role', 'menuitem');
      const name = providerName(option.agentId);
      automatic.appendChild(createProviderLogo(option.agentId, 'provider-open-logo'));
      const copy = document.createElement('span'); copy.className = 'provider-open-copy';
      const provider = document.createElement('strong'); provider.textContent = name;
      const status = document.createElement('span'); status.className = 'provider-open-status'; status.textContent = tr(outcomeKey[option.outcome]);
      copy.append(provider, status); automatic.appendChild(copy);
      automatic.setAttribute('aria-label', `${name} — ${status.textContent}`);
      automatic.addEventListener('click', () => activate(option.agentId, 'auto'));

      const fresh = document.createElement('button');
      fresh.type = 'button'; fresh.className = 'provider-open-new'; fresh.setAttribute('role', 'menuitem');
      fresh.textContent = '＋'; fresh.title = `${name} — ${tr('open.new_session')}`;
      fresh.setAttribute('aria-label', fresh.title);
      fresh.addEventListener('click', () => activate(option.agentId, 'new'));
      row.append(automatic, fresh); menu.appendChild(row);
    }
  };

  const onOutsidePointer = (event: PointerEvent): void => {
    if (!root.contains(event.target as Node)) closeMenu();
  };
  const onDocumentKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  };
  const openMenu = (focusFirst = false): void => {
    renderMenu();
    open = true;
    menu.classList.remove('hidden');
    menuButton.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutsidePointer);
    document.addEventListener('keydown', onDocumentKey);
    if (focusFirst) requestAnimationFrame(() => menuItems()[0]?.focus());
  };

  primary.type = 'button';
  primary.addEventListener('click', () => emit(selectedAgent(), 'auto'));
  menuButton.addEventListener('click', (event) => {
    // projectsView has a legacy document-level click closer for its ⋯ menus. Do not let the same
    // disclosure click bubble there and immediately close this newly opened provider menu.
    event.stopPropagation();
    if (open) closeMenu(); else openMenu();
  });
  menuButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      requestAnimationFrame(() => {
        const items = menuItems();
        (event.key === 'ArrowDown' ? items[0] : items.at(-1))?.focus();
      });
    }
  });
  menu.addEventListener('keydown', onMenuKey);

  renderPrimary();
  primaryRenderers.set(root, () => {
    renderPrimary();
    if (open) renderMenu();
  });
  root.append(primary, menuButton, menu);
  return root;
}
