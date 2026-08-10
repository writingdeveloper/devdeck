import { createIcon, type IconName } from './icons';
import { tr } from './i18n-runtime';
import {
  buildSessionGroups,
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
}): ShellController {
  const sidebar = document.getElementById('app-sidebar')!;
  const collapse = document.getElementById('shell-collapse') as HTMLButtonElement;
  const quickOpen = document.getElementById('shell-quick-open') as HTMLInputElement;
  const resultHost = document.getElementById('shell-quick-results')!;
  const sessionHost = document.getElementById('shell-session-groups')!;
  const projectHost = document.getElementById('shell-projects')!;
  let sessions: ShellSessionInput[] = [];
  let projects: ShellProjectInput[] = [];
  let activeEntityKey = '';
  const sessionRows = new Map<string, HTMLButtonElement>();
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
    if (row && document.activeElement !== row) row.focus();
  };

  const createSessionRow = (key: string): HTMLButtonElement => {
    const row = document.createElement('button'); row.type = 'button';
    row.addEventListener('click', () => {
      const id = row.dataset.sessionId;
      if (!id) return;
      updateActiveEntity(row, key);
      options.onSession(id);
    });
    sessionRows.set(key, row);
    return row;
  };

  const updateSessionRow = (row: HTMLButtonElement, item: ShellSessionInput, key: string): void => {
    row.dataset.sessionId = item.id;
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
    copy.querySelector('small')!.textContent = item.detail;
    applyEntityState(row, key);
  };

  const renderSessions = (items: ShellSessionInput[]): void => {
    const focusedKey = document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset.shellEntityKey : undefined;
    const nextKeys = new Set(items.map((item) => shellEntityKey('session', item.id)));
    for (const [key, row] of sessionRows) {
      if (!nextKeys.has(key)) { row.remove(); sessionRows.delete(key); }
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
        section.appendChild(row);
      }
      sessionHost.appendChild(section);
    }
    const visibleGroups = new Set(buildSessionGroups(items).map((group) => group.kind));
    for (const [kind, section] of sessionSections) {
      if (!visibleGroups.has(kind)) { section.remove(); sessionSections.delete(kind); }
    }
    preserveFocusedRow(focusedKey, sessionRows);
  };

  const createProjectRow = (key: string): HTMLButtonElement => {
    const row = document.createElement('button'); row.type = 'button';
    row.addEventListener('click', () => {
      const path = row.dataset.projectPath;
      if (!path) return;
      updateActiveEntity(row, key);
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
      options.onSession(item.id);
      quickOpen.value = ''; applyQuery();
    };
    const activateProject = (item: ShellProjectInput): void => {
      markActiveEntity(shellEntityKey('project', item.path));
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
    setCollapsed(sidebar.classList.contains('collapsed'));
    renderSessions(sessions);
    renderProjects(projects);
  };
  refreshLabels();

  return {
    showView: options.showView,
    setCockpitAvailable: (available) => {
      document.getElementById('shell-session-section')!.classList.toggle('hidden', !available);
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
