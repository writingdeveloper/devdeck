import { createIcon, type IconName } from './icons';
import { tr } from './i18n-runtime';
import {
  buildSessionGroups,
  attentionCount,
  filterShellItems,
  sessionAccessibleLabel,
  shellEntityKey,
  type ShellGroupKind,
  type ShellProjectInput,
  type ShellSessionInput,
} from '../shared/shellNavigation';
import type { ViewId } from './nav';

const viewIcons: Record<ViewId, IconName> = {
  projects: 'projects', usage: 'usage', settings: 'settings', next: 'tasks', cockpit: 'sessions',
};

const viewLabels: Record<ViewId, string> = {
  projects: 'nav.projects', usage: 'nav.usage', settings: 'nav.settings', next: 'nav.next', cockpit: 'nav.cockpit',
};

const groupLabels: Record<string, string> = {
  attention: 'shell.needs_you', working: 'shell.working', pinned: 'cockpit.grp_pinned',
  turn: 'cockpit.grp_turn', quiet: 'cockpit.grp_idle', previous: 'cockpit.prev_sessions',
};

export interface ShellController {
  showView(view: ViewId): void;
  setCockpitAvailable(available: boolean): void;
  setSessionGroups(items: ShellSessionInput[]): void;
  setProjects(items: ShellProjectInput[]): void;
  setActiveProject(path: string | null): void;
  setActiveSession(id: string | null): void;
  setCollapsed(collapsed: boolean): void;
  activeView(): ViewId;
  refreshLabels(): void;
}

export function mountShell(options: {
  initialCollapsed: boolean;
  showView(view: ViewId): void;
  activeView(): ViewId;
  onCollapse(collapsed: boolean): void;
  onProject(path: string): void;
  onSession(id: string): void;
  onPreviousAction(id: string, action: 'pin' | 'unpin' | 'forget'): void;
  onRestoreAll(): void;
}): ShellController {
  const sidebar = document.getElementById('app-sidebar')!;
  const collapse = document.getElementById('shell-collapse') as HTMLButtonElement;
  const quickOpen = document.getElementById('shell-quick-open') as HTMLInputElement;
  const resultHost = document.getElementById('shell-quick-results')!;
  const sessionHost = document.getElementById('shell-session-groups')!;
  const projectHost = document.getElementById('shell-projects')!;
  const restoreAll = document.getElementById('shell-restore-all') as HTMLButtonElement;
  const mobileToggle = document.getElementById('shell-mobile-toggle') as HTMLButtonElement;
  const mobileToggleLabel = document.getElementById('shell-mobile-toggle-label')!;
  const mobileBackdrop = document.getElementById('shell-mobile-backdrop') as HTMLButtonElement;
  let sessions: ShellSessionInput[] = [];
  let projects: ShellProjectInput[] = [];
  let activeEntityKey = '';
  const sessionRows = new Map<string, HTMLButtonElement>();
  const sessionWraps = new Map<string, HTMLElement>();
  const sessionMenus = new Map<string, HTMLElement>();
  const projectRows = new Map<string, HTMLButtonElement>();
  const sessionSections = new Map<ShellGroupKind, HTMLElement>();

  const markActiveEntity = (key: string | null): void => {
    activeEntityKey = key ?? '';
    for (const item of Array.from(sidebar.querySelectorAll<HTMLButtonElement>('.shell-entity'))) {
      const active = item.dataset.shellEntityKey === activeEntityKey;
      item.classList.toggle('selected', active);
      if (active) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
    }
  };

  const updateActiveEntity = (row: HTMLButtonElement, key: string): void => {
    activeEntityKey = key;
    for (const item of Array.from(sidebar.querySelectorAll<HTMLButtonElement>('.shell-entity'))) {
      const active = item === row;
      item.classList.toggle('selected', active);
      if (active) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
    }
  };

  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-item[data-view]'))) {
    const view = button.dataset.view as ViewId;
    button.prepend(createIcon(viewIcons[view]));
  }
  collapse.prepend(createIcon('panel-left'));
  document.querySelector('#shell-quick-wrap .shell-search-icon')?.append(createIcon('search'));

  const setCollapsed = (collapsed: boolean): void => {
    sidebar.classList.toggle('collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    collapse.title = tr(collapsed ? 'shell.expand' : 'shell.collapse');
    collapse.setAttribute('aria-label', collapse.title);
  };

  const applyEntityState = (row: HTMLButtonElement, key: string): void => {
    row.dataset.shellEntityKey = key;
    row.classList.toggle('selected', activeEntityKey === key);
    if (activeEntityKey === key) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  };

  const preserveFocusedRow = (focusedKey: string | undefined, rows: Map<string, HTMLButtonElement>): void => {
    const row = focusedKey ? rows.get(focusedKey) : undefined;
    if (row && (document.activeElement === document.body || document.activeElement == null)) row.focus();
  };

  mobileToggle.querySelector('.shell-mobile-toggle-icon')?.append(createIcon('sessions'));
  restoreAll.prepend(createIcon('restart'));

  const closeSessionMenus = (restoreFocus = false): void => {
    for (const [key, menu] of sessionMenus) {
      if (menu.classList.contains('hidden')) continue;
      menu.classList.add('hidden');
      const trigger = sessionWraps.get(key)?.querySelector<HTMLButtonElement>('.shell-session-actions');
      trigger?.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger?.focus();
    }
  };

  const mobileFocusable = (): HTMLElement[] => Array.from(sidebar.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.closest('.hidden') && element.getClientRects().length > 0);
  const closeMobileDrawer = (restoreFocus = false): void => {
    if (!sidebar.classList.contains('mobile-open')) return;
    sidebar.classList.remove('mobile-open');
    sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal');
    mobileBackdrop.classList.add('hidden');
    mobileToggle.setAttribute('aria-expanded', 'false');
    closeSessionMenus();
    if (restoreFocus) mobileToggle.focus();
  };
  const openMobileDrawer = (): void => {
    if (!matchMedia('(max-width: 720px)').matches) return;
    sidebar.classList.add('mobile-open');
    sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true');
    mobileBackdrop.classList.remove('hidden');
    mobileToggle.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => (quickOpen.getClientRects().length ? quickOpen : mobileFocusable()[0])?.focus());
  };
  const updateMobileToggle = (): void => {
    const waiting = attentionCount(sessions);
    const label = waiting > 0
      ? `${tr('shell.needs_you')} · ${waiting}/${sessions.length}`
      : `${tr('shell.mobile_sessions')} · ${sessions.length}`;
    mobileToggleLabel.textContent = label;
    mobileToggle.title = label; mobileToggle.setAttribute('aria-label', label);
    mobileToggle.classList.toggle('has-attention', waiting > 0);
  };

  const createSessionRow = (key: string): HTMLButtonElement => {
    const wrap = document.createElement('div'); wrap.className = 'shell-session-wrap';
    const row = document.createElement('button'); row.type = 'button';
    row.addEventListener('click', () => {
      const id = row.dataset.sessionId;
      if (!id) return;
      updateActiveEntity(row, key);
      closeMobileDrawer();
      options.onSession(id);
    });
    const actions = document.createElement('button'); actions.type = 'button'; actions.className = 'shell-session-actions hidden';
    actions.append(createIcon('more')); actions.setAttribute('aria-haspopup', 'menu'); actions.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'menu shell-session-menu hidden'; menu.setAttribute('role', 'menu');
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'menu-item'; pin.setAttribute('role', 'menuitem'); pin.dataset.sessionAction = 'pin';
    const forget = document.createElement('button'); forget.type = 'button'; forget.className = 'menu-item'; forget.setAttribute('role', 'menuitem'); forget.dataset.sessionAction = 'forget';
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = row.dataset.sessionId; if (!id) return;
      options.onPreviousAction(id, row.dataset.pinned === 'true' ? 'unpin' : 'pin');
      closeSessionMenus(true);
    });
    forget.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = row.dataset.sessionId; if (!id) return;
      closeSessionMenus(); options.onPreviousAction(id, 'forget');
    });
    actions.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.classList.contains('hidden');
      closeSessionMenus();
      if (opening) { menu.classList.remove('hidden'); actions.setAttribute('aria-expanded', 'true'); }
    });
    actions.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (menu.classList.contains('hidden')) actions.click();
      menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    menu.addEventListener('keydown', (event) => {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSessionMenus(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(current + step + items.length) % items.length]?.focus();
      }
    });
    menu.append(pin, forget); wrap.append(row, actions, menu);
    sessionRows.set(key, row);
    sessionWraps.set(key, wrap);
    sessionMenus.set(key, menu);
    return row;
  };

  const updateSessionRow = (row: HTMLButtonElement, item: ShellSessionInput, key: string): void => {
    const wrap = sessionWraps.get(key)!;
    row.dataset.sessionId = item.id;
    row.dataset.pinned = String(item.pinned);
    row.className = `shell-entity shell-session activity-${item.activity}`;
    row.setAttribute('aria-label', sessionAccessibleLabel(item, tr(`shell.status_${item.activity}`)));
    let signal = row.querySelector<HTMLElement>('.shell-signal');
    let copy = row.querySelector<HTMLElement>('.shell-entity-copy');
    if (!signal || !copy) {
      signal = document.createElement('span'); signal.className = 'shell-signal'; signal.setAttribute('aria-hidden', 'true');
      copy = document.createElement('span'); copy.className = 'shell-entity-copy';
      copy.append(document.createElement('strong'), document.createElement('small'));
      row.replaceChildren(signal, copy);
    }
    copy.querySelector('strong')!.textContent = item.label;
    const detail = copy.querySelector('small')!;
    detail.textContent = item.detail;
    detail.classList.toggle('shell-session-warning', item.conversationGone === true);
    wrap.className = `shell-session-wrap${item.previous ? ' is-previous' : ''}${item.conversationGone ? ' is-gone' : ''}`;
    wrap.dataset.previous = String(item.previous === true);
    wrap.dataset.conversationGone = String(item.conversationGone === true);
    const actions = wrap.querySelector<HTMLButtonElement>('.shell-session-actions')!;
    actions.classList.toggle('hidden', item.previous !== true);
    actions.title = tr('shell.session_actions'); actions.setAttribute('aria-label', `${tr('shell.session_actions')}: ${item.label}`);
    const pin = wrap.querySelector<HTMLButtonElement>('[data-session-action="pin"]')!;
    pin.replaceChildren(createIcon('pin'), document.createTextNode(tr(item.pinned ? 'cockpit.unpin' : 'cockpit.pin')));
    pin.dataset.sessionAction = 'pin';
    const forget = wrap.querySelector<HTMLButtonElement>('[data-session-action="forget"]')!;
    forget.replaceChildren(createIcon('trash'), document.createTextNode(tr('cockpit.forget')));
    applyEntityState(row, key);
  };

  const renderSessions = (items: ShellSessionInput[]): void => {
    const focusedKey = document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset.shellEntityKey : undefined;
    const nextKeys = new Set(items.map((item) => shellEntityKey('session', item.id)));
    for (const [key, row] of sessionRows) {
      if (!nextKeys.has(key)) {
        sessionWraps.get(key)?.remove(); sessionRows.delete(key); sessionWraps.delete(key); sessionMenus.delete(key);
      }
    }
    for (const group of buildSessionGroups(items)) {
      let section = sessionSections.get(group.kind);
      if (!section) {
        section = document.createElement('section'); section.className = `shell-group group-${group.kind}`;
        const heading = document.createElement('h2'); heading.className = 'shell-section-label'; heading.id = `shell-session-${group.kind}`;
        section.setAttribute('aria-labelledby', heading.id); section.appendChild(heading);
        sessionSections.set(group.kind, section);
      }
      const heading = section.querySelector<HTMLHeadingElement>('.shell-section-label')!;
      heading.textContent = `${tr(groupLabels[group.kind])} · ${group.items.length}`;
      for (const item of group.items) {
        const key = shellEntityKey('session', item.id);
        const row = sessionRows.get(key) ?? createSessionRow(key);
        updateSessionRow(row, item, key);
        section.appendChild(sessionWraps.get(key)!);
      }
      sessionHost.appendChild(section);
    }
    const visibleGroups = new Set(buildSessionGroups(items).map((group) => group.kind));
    for (const [kind, section] of sessionSections) {
      if (!visibleGroups.has(kind)) { section.remove(); sessionSections.delete(kind); }
    }
    const previousCount = items.filter((item) => item.previous).length;
    restoreAll.classList.toggle('hidden', previousCount === 0);
    restoreAll.disabled = previousCount === 0;
    restoreAll.replaceChildren(createIcon('restart'), document.createTextNode(`${tr('cockpit.restore_all')} · ${previousCount}`));
    updateMobileToggle();
    preserveFocusedRow(focusedKey, sessionRows);
  };

  const createProjectRow = (key: string): HTMLButtonElement => {
    const row = document.createElement('button'); row.type = 'button';
    row.addEventListener('click', () => {
      const path = row.dataset.projectPath;
      if (!path) return;
      updateActiveEntity(row, key);
      closeMobileDrawer();
      options.onProject(path);
    });
    projectRows.set(key, row);
    return row;
  };

  const updateProjectRow = (row: HTMLButtonElement, item: ShellProjectInput, key: string): void => {
    row.dataset.projectPath = item.path;
    row.className = 'shell-entity shell-project';
    let copy = row.querySelector<HTMLElement>('.shell-entity-copy');
    if (!copy) {
      copy = document.createElement('span'); copy.className = 'shell-entity-copy';
      copy.append(document.createElement('strong'), document.createElement('small'));
      row.replaceChildren(copy);
    }
    copy.querySelector('strong')!.textContent = item.name;
    copy.querySelector('small')!.textContent = item.branch ?? '—';
    applyEntityState(row, key);
  };

  const renderProjects = (items: ShellProjectInput[]): void => {
    const focusedKey = document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset.shellEntityKey : undefined;
    const nextKeys = new Set(items.map((item) => shellEntityKey('project', item.path)));
    for (const [key, row] of projectRows) {
      if (!nextKeys.has(key)) { row.remove(); projectRows.delete(key); }
    }
    for (const item of items) {
      const key = shellEntityKey('project', item.path);
      const row = projectRows.get(key) ?? createProjectRow(key);
      updateProjectRow(row, item, key);
      projectHost.appendChild(row);
    }
    preserveFocusedRow(focusedKey, projectRows);
  };

  const applyQuery = (): void => {
    const filtered = filterShellItems(quickOpen.value, sessions, projects);
    const hasQuery = quickOpen.value.trim().length > 0;
    resultHost.classList.toggle('hidden', !hasQuery);
    sessionHost.classList.toggle('quick-filtered', hasQuery);
    projectHost.classList.toggle('quick-filtered', hasQuery);
    if (!hasQuery) { resultHost.replaceChildren(); return; }
    resultHost.replaceChildren();
    const activateSession = (item: ShellSessionInput): void => {
      markActiveEntity(shellEntityKey('session', item.id));
      closeMobileDrawer();
      options.onSession(item.id);
      quickOpen.value = ''; applyQuery();
    };
    const activateProject = (item: ShellProjectInput): void => {
      markActiveEntity(shellEntityKey('project', item.path));
      closeMobileDrawer();
      options.onProject(item.path);
      quickOpen.value = ''; applyQuery();
    };
    for (const item of buildSessionGroups(filtered.sessions).flatMap((group) => group.items)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'shell-quick-result';
      button.textContent = `${item.label} — ${item.detail}`; button.addEventListener('click', () => activateSession(item)); resultHost.appendChild(button);
    }
    for (const item of filtered.projects) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'shell-quick-result';
      button.textContent = `${item.name} — ${item.branch ?? '—'}`; button.addEventListener('click', () => activateProject(item)); resultHost.appendChild(button);
    }
  };

  quickOpen.addEventListener('input', applyQuery);
  quickOpen.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { quickOpen.value = ''; applyQuery(); }
    else if (event.key === 'Enter') (resultHost.querySelector<HTMLButtonElement>('button'))?.click();
  });
  restoreAll.addEventListener('click', () => { closeMobileDrawer(); options.onRestoreAll(); });
  mobileToggle.addEventListener('click', () => {
    if (sidebar.classList.contains('mobile-open')) closeMobileDrawer(true); else openMobileDrawer();
  });
  mobileBackdrop.addEventListener('click', () => closeMobileDrawer(true));
  sidebar.addEventListener('keydown', (event) => {
    if (!sidebar.classList.contains('mobile-open') || event.key !== 'Tab') return;
    const focusable = mobileFocusable(); if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-item[data-view]'))) {
    button.addEventListener('click', () => closeMobileDrawer());
  }
  document.addEventListener('click', () => closeSessionMenus());
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !sidebar.classList.contains('mobile-open')) return;
    event.preventDefault(); closeMobileDrawer(true);
  });
  window.addEventListener('resize', () => {
    if (!matchMedia('(max-width: 720px)').matches) closeMobileDrawer();
  });
  collapse.addEventListener('click', () => {
    const next = !sidebar.classList.contains('collapsed'); setCollapsed(next); options.onCollapse(next);
  });
  setCollapsed(options.initialCollapsed);

  const refreshLabels = (): void => {
    quickOpen.placeholder = tr('shell.quick_open'); quickOpen.setAttribute('aria-label', tr('shell.quick_open'));
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-item[data-view]'))) {
      const view = button.dataset.view as ViewId;
      const label = tr(viewLabels[view]);
      const text = button.querySelector<HTMLElement>('.rail-label'); if (text) text.textContent = label;
      button.title = label; button.setAttribute('aria-label', label);
    }
    document.getElementById('shell-projects-label')!.textContent = tr('shell.projects');
    document.getElementById('shell-projects-label')!.setAttribute('role', 'heading');
    document.getElementById('shell-projects-label')!.setAttribute('aria-level', '2');
    document.getElementById('shell-project-section')!.setAttribute('aria-labelledby', 'shell-projects-label');
    mobileBackdrop.setAttribute('aria-label', tr('shell.collapse'));
    setCollapsed(sidebar.classList.contains('collapsed'));
    renderSessions(sessions);
    renderProjects(projects);
  };
  refreshLabels();

  return {
    showView: options.showView,
    setCockpitAvailable: (available) => {
      document.getElementById('shell-session-section')!.classList.toggle('hidden', !available);
      mobileToggle.classList.toggle('hidden', !available);
      if (!available) closeMobileDrawer();
      document.querySelector<HTMLElement>('.rail-item[data-view="cockpit"]')?.classList.toggle('hidden', !available);
    },
    setSessionGroups: (items) => { sessions = [...items]; renderSessions(sessions); applyQuery(); },
    setProjects: (items) => { projects = [...items]; renderProjects(projects); applyQuery(); },
    setActiveProject: (path) => { markActiveEntity(path == null ? null : shellEntityKey('project', path)); },
    setActiveSession: (id) => { markActiveEntity(id == null ? null : shellEntityKey('session', id)); },
    setCollapsed,
    activeView: options.activeView,
    refreshLabels,
  };
}
