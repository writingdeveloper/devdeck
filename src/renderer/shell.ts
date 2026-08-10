import { createIcon, type IconName } from './icons';
import { tr } from './i18n-runtime';
import {
  buildSessionGroups,
  attentionCount,
  filterShellItems,
  sessionAccessibleLabel,
  sessionActionsFor,
  sessionStatusCounts,
  sessionStatusShape,
  shellEntityKey,
  type ShellGroupKind,
  type ShellProjectInput,
  type ShellSessionAction,
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

const actionLabels: Record<ShellSessionAction, string> = {
  pin: 'cockpit.pin', unpin: 'cockpit.unpin', rename: 'cockpit.rename',
  close: 'cockpit.close', forget: 'cockpit.forget',
};

const actionIcons: Record<ShellSessionAction, IconName> = {
  pin: 'pin', unpin: 'pin', rename: 'edit', close: 'close', forget: 'trash',
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
  onSessionAction(id: string, action: ShellSessionAction): void;
  onRestoreAll(): void;
}): ShellController {
  const sidebar = document.getElementById('app-sidebar')!;
  const collapse = document.getElementById('shell-collapse') as HTMLButtonElement;
  const quickOpen = document.getElementById('shell-quick-open') as HTMLInputElement;
  const resultHost = document.getElementById('shell-quick-results')!;
  const sessionHost = document.getElementById('shell-session-groups')!;
  const projectHost = document.getElementById('shell-projects')!;
  const sessionSection = document.getElementById('shell-session-section')!;
  const projectSection = document.getElementById('shell-project-section')!;
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

  // Collapsing hides the whole session list to buy terminal width. Without this pill, a session that
  // needs you would then have NO in-app signal at all — the very state the sidebar exists to surface.
  const collapsedStatus = document.getElementById('shell-collapsed-status') as HTMLButtonElement;
  const renderCollapsedStatus = (): void => {
    const { attention, working } = sessionStatusCounts(sessions);
    const collapsed = sidebar.classList.contains('collapsed');
    collapsedStatus.classList.toggle('hidden', !collapsed || attention + working === 0);
    collapsedStatus.classList.toggle('has-attention', attention > 0);
    if (!collapsed || attention + working === 0) return;
    const parts = [
      attention > 0 ? `${tr('shell.needs_you')} ${attention}` : '',
      working > 0 ? `${tr('shell.working')} ${working}` : '',
    ].filter(Boolean);
    collapsedStatus.replaceChildren(
      createIcon(attention > 0 ? 'sessions' : 'restart', 'ui-icon shell-collapsed-icon'),
      Object.assign(document.createElement('span'), { textContent: String(attention > 0 ? attention : working) }),
    );
    collapsedStatus.title = parts.join(' · ');
    collapsedStatus.setAttribute('aria-label', parts.join(' · '));
  };

  const setCollapsed = (collapsed: boolean): void => {
    sidebar.classList.toggle('collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    collapse.title = tr(collapsed ? 'shell.expand' : 'shell.collapse');
    collapse.setAttribute('aria-label', collapse.title);
    renderCollapsedStatus();
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

  /** Only the actions this row currently offers take part in roving focus — the rest stay `.hidden`. */
  const menuItems = (menu: HTMLElement): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter((item) => !item.classList.contains('hidden'));

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
    const actions = document.createElement('button'); actions.type = 'button'; actions.className = 'shell-session-actions';
    actions.append(createIcon('more')); actions.setAttribute('aria-haspopup', 'menu'); actions.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'menu shell-session-menu hidden'; menu.setAttribute('role', 'menu');
    // One menu item per action the row can currently offer. `close` and `forget` both destroy state,
    // so they keep the destructive styling — and `close` still routes through cockpit's confirm.
    for (const action of ['pin', 'unpin', 'rename', 'close', 'forget'] as ShellSessionAction[]) {
      const item = document.createElement('button');
      item.type = 'button'; item.className = `menu-item${action === 'close' || action === 'forget' ? ' menu-item-danger' : ''}`;
      item.setAttribute('role', 'menuitem'); item.dataset.sessionAction = action;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        const id = row.dataset.sessionId; if (!id) return;
        // Pin keeps the menu anchored (its label flips in place); the rest change or remove the row.
        if (action === 'pin' || action === 'unpin') closeSessionMenus(true); else closeSessionMenus();
        options.onSessionAction(id, action);
      });
      menu.appendChild(item);
    }
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
      menuItems(menu)[0]?.focus();
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    menu.addEventListener('keydown', (event) => {
      const items = menuItems(menu);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSessionMenus(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(current + step + items.length) % items.length]?.focus();
      }
    });
    wrap.append(row, actions, menu);
    sessionRows.set(key, row);
    sessionWraps.set(key, wrap);
    sessionMenus.set(key, menu);
    return row;
  };

  const updateSessionRow = (row: HTMLButtonElement, item: ShellSessionInput, key: string): void => {
    const wrap = sessionWraps.get(key)!;
    row.dataset.sessionId = item.id;
    row.dataset.pinned = String(item.pinned);
    const status = tr(`shell.status_${item.activity}`);
    row.className = `shell-entity shell-session activity-${item.activity}`;
    row.setAttribute('aria-label', sessionAccessibleLabel(item, status));
    let signal = row.querySelector<HTMLElement>('.shell-signal');
    let copy = row.querySelector<HTMLElement>('.shell-entity-copy');
    if (!signal || !copy) {
      signal = document.createElement('span'); signal.className = 'shell-signal'; signal.setAttribute('aria-hidden', 'true');
      copy = document.createElement('span'); copy.className = 'shell-entity-copy';
      copy.append(document.createElement('strong'), document.createElement('small'), document.createElement('em'));
      row.replaceChildren(signal, copy);
    }
    // Shape (not just hue) carries the state, and "working" spins — a still sidebar reads as a dead one.
    signal.className = `shell-signal signal-${sessionStatusShape(item)}`;
    copy.querySelector('strong')!.textContent = item.label;
    const detail = copy.querySelector('small')!;
    detail.textContent = item.detail;
    detail.classList.toggle('shell-session-warning', item.conversationGone === true);
    // Third line: what this session is working on right now. Absent for previous rows and until the
    // first summary lands, and then it must not reserve empty height.
    const summary = copy.querySelector('em')!;
    summary.textContent = item.summary ?? '';
    summary.title = item.summary ? `${tr('cockpit.summary')}: ${item.summary}` : '';
    summary.classList.toggle('hidden', !item.summary);
    row.title = `${item.label} · ${status}`;
    wrap.className = `shell-session-wrap${item.previous ? ' is-previous' : ''}${item.conversationGone ? ' is-gone' : ''}`;
    wrap.dataset.previous = String(item.previous === true);
    wrap.dataset.conversationGone = String(item.conversationGone === true);
    const actions = wrap.querySelector<HTMLButtonElement>('.shell-session-actions')!;
    actions.title = tr('shell.session_actions'); actions.setAttribute('aria-label', `${tr('shell.session_actions')}: ${item.label}`);
    const offered = new Set(sessionActionsFor(item));
    for (const entry of Array.from(wrap.querySelectorAll<HTMLButtonElement>('[data-session-action]'))) {
      const action = entry.dataset.sessionAction as ShellSessionAction;
      const shown = offered.has(action);
      entry.classList.toggle('hidden', !shown);
      if (shown) entry.replaceChildren(createIcon(actionIcons[action]), document.createTextNode(tr(actionLabels[action])));
    }
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
    renderCollapsedStatus();
    applyProjectActivity(); // session state changed → the project rows' inherited marks follow
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

  /** A project inherits the loudest state of its live sessions — the sidebar must answer "which repo
   *  is waiting on me" without first expanding the session groups (the deck stripe already does this
   *  in the main pane). Derived from the session models the shell already holds, so no extra plumbing. */
  const projectActivity = (): Map<string, 'attention' | 'working'> => {
    const map = new Map<string, 'attention' | 'working'>();
    for (const item of sessions) {
      if (item.previous) continue;
      if (item.activity === 'attention') map.set(item.projectPath, 'attention');
      else if (item.activity === 'working' && map.get(item.projectPath) !== 'attention') map.set(item.projectPath, 'working');
    }
    return map;
  };

  const applyProjectActivity = (): void => {
    const activity = projectActivity();
    for (const row of projectRows.values()) {
      const state = activity.get(row.dataset.projectPath ?? '') ?? null;
      const signal = row.querySelector<HTMLElement>('.shell-signal');
      if (!signal) continue;
      signal.className = `shell-signal ${state === 'attention' ? 'signal-diamond' : state === 'working' ? 'signal-spinner' : 'signal-blank'}`;
      const label = state ? `${row.dataset.projectName ?? ''}, ${tr(state === 'attention' ? 'shell.needs_you' : 'shell.working')}` : row.dataset.projectName ?? '';
      row.setAttribute('aria-label', label);
      row.title = label;
    }
  };

  const updateProjectRow = (row: HTMLButtonElement, item: ShellProjectInput, key: string): void => {
    row.dataset.projectPath = item.path;
    row.dataset.projectName = item.name;
    row.className = 'shell-entity shell-project';
    let copy = row.querySelector<HTMLElement>('.shell-entity-copy');
    if (!copy) {
      const signal = document.createElement('span'); signal.className = 'shell-signal signal-blank'; signal.setAttribute('aria-hidden', 'true');
      copy = document.createElement('span'); copy.className = 'shell-entity-copy';
      copy.append(document.createElement('strong'), document.createElement('small'));
      row.replaceChildren(signal, copy);
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
    applyProjectActivity();
    preserveFocusedRow(focusedKey, projectRows);
  };

  let quickIndex = 0;
  const quickResults = (): HTMLButtonElement[] => Array.from(resultHost.querySelectorAll<HTMLButtonElement>('.shell-quick-result'));
  const highlightQuickResult = (index: number, focus = false): void => {
    const results = quickResults();
    if (!results.length) { quickIndex = 0; return; }
    quickIndex = (index + results.length) % results.length;
    results.forEach((button, position) => {
      button.classList.toggle('active', position === quickIndex);
      button.setAttribute('aria-selected', String(position === quickIndex));
    });
    quickOpen.setAttribute('aria-activedescendant', results[quickIndex].id);
    if (focus) results[quickIndex].scrollIntoView({ block: 'nearest' });
  };

  const quickResultRow = (id: string, mark: Element | null, title: string, detail: string, onPick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'shell-quick-result'; button.id = id; button.setAttribute('role', 'option');
    const copy = document.createElement('span'); copy.className = 'shell-entity-copy';
    const strong = document.createElement('strong'); strong.textContent = title;
    const small = document.createElement('small'); small.textContent = detail;
    copy.append(strong, small);
    if (mark) button.append(mark);
    button.append(copy);
    button.setAttribute('aria-label', `${title}, ${detail}`);
    button.addEventListener('click', onPick);
    return button;
  };

  const applyQuery = (): void => {
    const filtered = filterShellItems(quickOpen.value, sessions, projects);
    const hasQuery = quickOpen.value.trim().length > 0;
    resultHost.classList.toggle('hidden', !hasQuery);
    quickOpen.setAttribute('aria-expanded', String(hasQuery));
    // Whole SECTIONS step aside while filtering — hiding only the inner lists left the "Projects"
    // heading and the "Restore all" button floating above an empty rail.
    sessionSection.classList.toggle('quick-filtered', hasQuery);
    projectSection.classList.toggle('quick-filtered', hasQuery);
    if (!hasQuery) { resultHost.replaceChildren(); quickOpen.removeAttribute('aria-activedescendant'); return; }
    resultHost.replaceChildren();
    const dismiss = (): void => { quickOpen.value = ''; applyQuery(); };
    let index = 0;
    for (const item of buildSessionGroups(filtered.sessions).flatMap((group) => group.items)) {
      const mark = document.createElement('span'); mark.className = `shell-signal signal-${sessionStatusShape(item)}`; mark.setAttribute('aria-hidden', 'true');
      resultHost.appendChild(quickResultRow(`shell-quick-${index++}`, mark, item.label, item.detail, () => {
        markActiveEntity(shellEntityKey('session', item.id));
        closeMobileDrawer(); options.onSession(item.id); dismiss();
      }));
    }
    for (const item of filtered.projects) {
      resultHost.appendChild(quickResultRow(`shell-quick-${index++}`, createIcon('projects', 'ui-icon shell-quick-icon'), item.name, item.branch ?? '—', () => {
        markActiveEntity(shellEntityKey('project', item.path));
        closeMobileDrawer(); options.onProject(item.path); dismiss();
      }));
    }
    if (!index) {
      const empty = document.createElement('div'); empty.className = 'shell-quick-empty'; empty.setAttribute('role', 'status');
      empty.textContent = tr('shell.no_results');
      resultHost.appendChild(empty);
      quickOpen.removeAttribute('aria-activedescendant');
      return;
    }
    highlightQuickResult(0);
  };

  quickOpen.addEventListener('input', applyQuery);
  quickOpen.addEventListener('keydown', (event) => {
    // Arrow keys walk the results from the input itself (aria-activedescendant), so a second match is
    // reachable without leaving the field — Enter used to always fire the FIRST result and nothing else.
    if (event.key === 'Escape') { quickOpen.value = ''; applyQuery(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); highlightQuickResult(quickIndex + 1, true); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlightQuickResult(quickIndex - 1, true); }
    else if (event.key === 'Home') { if (quickResults().length) { event.preventDefault(); highlightQuickResult(0, true); } }
    else if (event.key === 'End') { if (quickResults().length) { event.preventDefault(); highlightQuickResult(quickResults().length - 1, true); } }
    else if (event.key === 'Enter') { event.preventDefault(); quickResults()[quickIndex]?.click(); }
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
  collapsedStatus.addEventListener('click', () => { setCollapsed(false); options.onCollapse(false); });
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
      sessionSection.classList.toggle('hidden', !available);
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
