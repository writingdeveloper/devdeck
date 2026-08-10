import { createIcon, type IconName } from './icons';
import { tr } from './i18n-runtime';
import {
  buildSessionGroups,
  filterShellItems,
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

  const markActiveEntity = (row: HTMLButtonElement, key: string): void => {
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

  const renderSessions = (items: ShellSessionInput[]): void => {
    sessionHost.replaceChildren();
    for (const group of buildSessionGroups(items)) {
      const section = document.createElement('section'); section.className = `shell-group group-${group.kind}`;
      const heading = document.createElement('div'); heading.className = 'shell-section-label';
      heading.textContent = `${tr(groupLabels[group.kind])} · ${group.items.length}`;
      section.appendChild(heading);
      for (const item of group.items) {
        const row = document.createElement('button'); row.type = 'button'; row.className = `shell-entity shell-session activity-${item.activity}`;
        const key = `session:${item.id}`;
        const signal = document.createElement('span'); signal.className = 'shell-signal'; signal.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span'); copy.className = 'shell-entity-copy';
        const label = document.createElement('strong'); label.textContent = item.label;
        const detail = document.createElement('small'); detail.textContent = item.detail;
        copy.append(label, detail); row.append(signal, copy);
        row.classList.toggle('selected', activeEntityKey === key);
        if (activeEntityKey === key) row.setAttribute('aria-current', 'true');
        row.addEventListener('click', () => { markActiveEntity(row, key); options.onSession(item.id); });
        section.appendChild(row);
      }
      sessionHost.appendChild(section);
    }
  };

  const renderProjects = (items: ShellProjectInput[]): void => {
    projectHost.replaceChildren();
    for (const item of items) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'shell-entity shell-project';
      const key = `project:${item.path}`;
      const copy = document.createElement('span'); copy.className = 'shell-entity-copy';
      const label = document.createElement('strong'); label.textContent = item.name;
      const detail = document.createElement('small'); detail.textContent = item.branch ?? '—';
      copy.append(label, detail); row.appendChild(copy);
      row.classList.toggle('selected', activeEntityKey === key);
      if (activeEntityKey === key) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => { markActiveEntity(row, key); options.onProject(item.path); });
      projectHost.appendChild(row);
    }
  };

  const applyQuery = (): void => {
    const filtered = filterShellItems(quickOpen.value, sessions, projects);
    const hasQuery = quickOpen.value.trim().length > 0;
    resultHost.classList.toggle('hidden', !hasQuery);
    sessionHost.classList.toggle('quick-filtered', hasQuery);
    projectHost.classList.toggle('quick-filtered', hasQuery);
    if (!hasQuery) { resultHost.replaceChildren(); renderSessions(sessions); renderProjects(projects); return; }
    resultHost.replaceChildren();
    for (const item of filtered.sessions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'shell-quick-result';
      button.textContent = `${item.label} — ${item.detail}`; button.addEventListener('click', () => options.onSession(item.id)); resultHost.appendChild(button);
    }
    for (const item of filtered.projects) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'shell-quick-result';
      button.textContent = `${item.name} — ${item.branch ?? '—'}`; button.addEventListener('click', () => options.onProject(item.path)); resultHost.appendChild(button);
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
    setCollapsed(sidebar.classList.contains('collapsed'));
    renderSessions(sessions);
  };
  refreshLabels();

  return {
    showView: options.showView,
    setCockpitAvailable: (available) => {
      document.getElementById('shell-session-section')!.classList.toggle('hidden', !available);
      document.querySelector<HTMLElement>('.rail-item[data-view="cockpit"]')?.classList.toggle('hidden', !available);
    },
    setSessionGroups: (items) => { sessions = [...items]; applyQuery(); },
    setProjects: (items) => { projects = [...items]; applyQuery(); },
    setCollapsed,
    activeView: options.activeView,
    refreshLabels,
  };
}
