import { createIcon, type IconName } from './icons';
import { tr } from './i18n-runtime';
import { undoToast } from './loadError';
import {
  buildSessionGroups,
  attentionCount,
  clampSidebarWidth,
  filterShellItems,
  normalizeCollapsedGroups,
  normalizeSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  sessionAccessibleLabel,
  sessionActionsFor,
  sessionGroupKey,
  isRemoteSession,
  type ShellSessionGroup,
  sessionStatusCounts,
  sessionStatusShape,
  shellEntityKey,
  toggleCollapsedGroup,
  truncateList,
  unpinDestination,
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
  remote: 'shell.grp_remote', turn: 'cockpit.grp_turn', quiet: 'cockpit.grp_idle',
  previous: 'cockpit.prev_sessions',
};

const actionLabels: Record<ShellSessionAction, string> = {
  pin: 'cockpit.pin', unpin: 'cockpit.unpin', rename: 'cockpit.rename',
  close: 'cockpit.close', forget: 'cockpit.forget',
};

const actionIcons: Record<ShellSessionAction, IconName> = {
  pin: 'pin', unpin: 'pin', rename: 'edit', close: 'close', forget: 'trash',
};

/**
 * How many rows a group renders before it offers "show N more".
 *
 * The two unbounded groups are what buried the rail: `previous` holds up to 50 saved entries and
 * `quiet` grows with every session left open. The urgent groups are deliberately uncapped — hiding a
 * session that is *waiting on you* behind a "show more" would defeat the reason the sidebar exists.
 */
const groupLimits: Record<ShellGroupKind, number> = {
  attention: Infinity, working: Infinity, pinned: 10, remote: 10, turn: 8, quiet: 6, previous: 5,
};

/** Recent-first project rows shown before the list offers the full deck. Pinned ones are never cut. */
const PROJECT_LIMIT = 8;
const COLLAPSED_GROUPS_KEY = 'devdeck.shell.collapsedGroups';
const PROJECTS_COLLAPSED_KEY = 'devdeck.shell.projectsCollapsed';
const QUICK_OPEN_CHORD = 'Ctrl+Shift+P';
const SIDEBAR_WIDTH_KEY = 'devdeck.shell.width';

function readCollapsedGroups(): string[] {
  try { return normalizeCollapsedGroups(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]')); }
  catch { return []; }
}

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
  /** Close (or forget) every session in one group, asked once rather than row by row. */
  onGroupClose?(group: ShellSessionGroup): void;
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
  const projectsToggle = document.getElementById('shell-projects-toggle') as HTMLButtonElement;
  const projectsMore = document.getElementById('shell-projects-more') as HTMLButtonElement;
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
  const sessionSections = new Map<string, HTMLElement>();
  let collapsedGroups = readCollapsedGroups();
  /** Groups the user asked to see in full. Deliberately NOT persisted: "show all 40 previous
   *  sessions" answers one moment's question and should not be the shape of the next launch. */
  const expandedGroups = new Set<string>();
  let projectsExpanded = false;
  let projectsCollapsed = localStorage.getItem(PROJECTS_COLLAPSED_KEY) === '1';

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
  projectsToggle.append(
    createIcon('chevron-down', 'ui-icon shell-group-chevron'),
    Object.assign(document.createElement('span'), { className: 'shell-group-name' }),
    Object.assign(document.createElement('span'), { className: 'shell-group-count' }),
  );
  projectsToggle.addEventListener('click', () => {
    projectsCollapsed = !projectsCollapsed;
    try { localStorage.setItem(PROJECTS_COLLAPSED_KEY, projectsCollapsed ? '1' : '0'); } catch { /* private mode / quota */ }
    renderProjects(projects);
  });
  projectsMore.addEventListener('click', () => { projectsExpanded = true; renderProjects(projects); });

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
    requestAnimationFrame(() => {
      // The drawer can be gone before this frame runs — Escape right after opening it, which is what
      // a keyboard user does when they opened it by accident. Focusing into a drawer that is already
      // closed strands the caret on something invisible AND takes it back off the toggle that
      // closeMobileDrawer just returned it to, so the next Tab starts from nowhere.
      if (!sidebar.classList.contains('mobile-open')) return;
      (quickOpen.getClientRects().length ? quickOpen : mobileFocusable()[0])?.focus();
    });
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

  /**
   * Unpinning was the one action nobody dared use. The row silently relocates to a group that may be
   * folded or below the fold, so "unpin" felt indistinguishable from "lose it", and pins piled up until
   * the pinned group was as unreadable as the list it was supposed to shortcut. Naming the destination
   * group and offering one click back makes it an ordinary, reversible move.
   */
  const announceUnpin = (item: ShellSessionInput): void => {
    const group = tr(groupLabels[unpinDestination(item)]);
    undoToast(
      tr('shell.unpinned_to', { label: item.label, group }),
      tr('shell.undo'),
      () => options.onSessionAction(item.id, 'pin'),
    );
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
        // Capture the model BEFORE the action lands — afterwards the row has already moved.
        const before = action === 'unpin' ? sessions.find((entry) => entry.id === id) : undefined;
        options.onSessionAction(id, action);
        if (before) announceUnpin(before);
      });
      menu.appendChild(item);
    }
    actions.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.classList.contains('hidden');
      closeSessionMenus();
      if (!opening) return;
      menu.classList.remove('hidden'); actions.setAttribute('aria-expanded', 'true');
      // The session list is its own `overflow-y: auto` box, so a menu dropping DOWN from a row near
      // the bottom is clipped by the scroller and its lower items become unreachable. Flip it above
      // the row when there isn't room below.
      menu.classList.remove('drop-up');
      const scroller = menu.closest('#shell-session-groups');
      if (scroller && menu.getBoundingClientRect().bottom > scroller.getBoundingClientRect().bottom) {
        menu.classList.add('drop-up');
      }
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
    // Every line is single-line + ellipsis, so hovering has to be able to reveal what was cut —
    // otherwise a truncated model name or summary is simply unreadable at narrow widths.
    row.title = [`${item.label} · ${status}`, item.detail, item.summary].filter(Boolean).join('\n');
    wrap.className = `shell-session-wrap${item.previous ? ' is-previous' : ''}${item.conversationGone ? ' is-gone' : ''}${isRemoteSession(item) ? ' is-remote' : ''}`;
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

  /** A counted, foldable header. The count is the point: a folded group has to keep advertising that
   *  its rows still exist, or folding becomes another way to lose track of a session. */
  const createGroupSection = (group: ShellSessionGroup): HTMLElement => {
    const { kind, key } = group;
    const domId = key.replace(/[^A-Za-z0-9_-]/g, '-');
    const section = document.createElement('section'); section.className = `shell-group group-${kind}`;
    section.dataset.groupKey = key;
    const heading = document.createElement('h2'); heading.className = 'shell-group-heading'; heading.id = `shell-session-${domId}`;
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'shell-group-toggle'; toggle.setAttribute('aria-controls', `shell-session-${domId}-body`);
    toggle.append(
      createIcon('chevron-down', 'ui-icon shell-group-chevron'),
      // A remote group is marked at the heading as well as on every row: the point of splitting them
      // out is that you can tell, without reading, that these terminals are on another computer.
      ...(kind === 'remote' ? [createIcon('machine', 'ui-icon shell-group-machine')] : []),
      Object.assign(document.createElement('span'), { className: 'shell-group-name' }),
      Object.assign(document.createElement('span'), { className: 'shell-group-count' }),
    );
    toggle.addEventListener('click', () => {
      collapsedGroups = toggleCollapsedGroup(collapsedGroups, key);
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedGroups)); } catch { /* private mode / quota — folding just won't survive the restart */ }
      renderSessions(sessions);
    });
    heading.appendChild(toggle);
    // Close (or forget) a whole group at once. Shutting down a dozen sessions one confirmation at a
    // time is the kind of chore people simply stop doing, and the groups are already the units
    // someone thinks in: everything idle, everything that has exited, everything on that machine.
    const bulk = document.createElement('button');
    bulk.type = 'button'; bulk.className = 'shell-group-bulk';
    bulk.appendChild(createIcon('close', 'ui-icon'));
    bulk.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = buildSessionGroups(sessions).find((entry) => entry.key === key);
      if (current) options.onGroupClose?.(current);
    });
    heading.appendChild(bulk);
    const body = document.createElement('div'); body.className = 'shell-group-body'; body.id = `shell-session-${domId}-body`;
    const more = document.createElement('button'); more.type = 'button'; more.className = 'shell-more hidden';
    more.addEventListener('click', () => { expandedGroups.add(key); renderSessions(sessions); });
    section.setAttribute('aria-labelledby', heading.id);
    section.append(heading, body, more);
    return section;
  };

  const renderSessions = (items: ShellSessionInput[]): void => {
    const focusedKey = document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset.shellEntityKey : undefined;
    const groups = buildSessionGroups(items);
    // Only rows that are actually RENDERED may keep their DOM: a row cut by a "show more" limit is
    // gone from the rail, so leaving its node cached would resurrect it under the next group.
    const rendered = new Map<string, { shown: ShellSessionInput[]; hidden: number }>();
    for (const group of groups) {
      const collapsed = collapsedGroups.includes(group.key);
      const cut = truncateList(group.items, { limit: groupLimits[group.kind], expanded: expandedGroups.has(group.key) });
      rendered.set(group.key, collapsed ? { shown: [], hidden: 0 } : cut);
    }
    const liveKeys = new Set([...rendered.values()].flatMap((cut) => cut.shown).map((item) => shellEntityKey('session', item.id)));
    for (const [key, row] of sessionRows) {
      if (!liveKeys.has(key)) {
        sessionWraps.get(key)?.remove(); sessionRows.delete(key); sessionWraps.delete(key); sessionMenus.delete(key);
      }
    }
    for (const group of groups) {
      let section = sessionSections.get(group.key);
      if (!section) { section = createGroupSection(group); sessionSections.set(group.key, section); }
      const collapsed = collapsedGroups.includes(group.key);
      const toggle = section.querySelector<HTMLButtonElement>('.shell-group-toggle')!;
      // A remote group is named after the machine. "Remote" as a heading would be no better than the
      // marker it replaces once two machines are paired — the point is knowing WHICH computer.
      const name = group.kind === 'remote' ? (group.machineLabel ?? tr(groupLabels.remote)) : tr(groupLabels[group.kind]);
      toggle.querySelector<HTMLElement>('.shell-group-name')!.textContent = name;
      // A folded group still has to advertise a session that is WAITING ON YOU. The urgent groups are
      // deliberately never truncated for that reason, and folding must not become the loophole —
      // most of all for a remote machine's group, which is the one holding a mix of states.
      const waiting = sessionStatusCounts(group.items).attention;
      const count = collapsed && waiting > 0 ? `${waiting}/${group.items.length}` : String(group.items.length);
      const countEl = toggle.querySelector<HTMLElement>('.shell-group-count')!;
      countEl.textContent = count;
      countEl.classList.toggle('has-attention', collapsed && waiting > 0);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      // Screen readers get the plain word too: an unfamiliar machine name alone does not say that
      // these sessions are somewhere else.
      const spoken = group.kind === 'remote' ? `${tr(groupLabels.remote)}: ${name}` : name;
      toggle.setAttribute('aria-label', collapsed && waiting > 0
        ? `${spoken}, ${group.items.length}, ${tr('shell.needs_you')} ${waiting}`
        : `${spoken}, ${group.items.length}`);
      toggle.title = tr(collapsed ? 'shell.group_expand' : 'shell.group_collapse', { name: spoken });
      section.classList.toggle('is-collapsed', collapsed);
      // Bulk close: live groups close their terminals, the saved group forgets its entries. Both are
      // asked about first, so the button is a shortcut and never a surprise.
      const bulk = section.querySelector<HTMLButtonElement>('.shell-group-bulk')!;
      const bulkLabel = tr(group.kind === 'previous' ? 'shell.forget_group' : 'shell.close_group', { n: String(group.items.length), name: spoken });
      bulk.title = bulkLabel;
      bulk.setAttribute('aria-label', bulkLabel);
      bulk.classList.toggle('hidden', collapsed || group.items.length < 2); // one row already has its own ⋯ close
      const body = section.querySelector<HTMLElement>('.shell-group-body')!;
      body.classList.toggle('hidden', collapsed);
      const cut = rendered.get(group.key)!;
      for (const item of cut.shown) {
        const key = shellEntityKey('session', item.id);
        const row = sessionRows.get(key) ?? createSessionRow(key);
        updateSessionRow(row, item, key);
        body.appendChild(sessionWraps.get(key)!);
      }
      const hidden = cut.hidden;
      const more = section.querySelector<HTMLButtonElement>('.shell-more')!;
      more.classList.toggle('hidden', hidden === 0);
      if (hidden > 0) more.textContent = tr('shell.show_more', { n: hidden });
      sessionHost.appendChild(section);
    }
    const visibleGroups = new Set(groups.map((group) => group.key));
    for (const [key, section] of sessionSections) {
      if (!visibleGroups.has(key)) { section.remove(); sessionSections.delete(key); expandedGroups.delete(key); }
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

  /** Selecting a session that lives in a folded (or truncated-away) group must not select something
   *  invisible — open whatever is hiding it, and say so by leaving the group open. */
  const revealSession = (id: string): void => {
    const item = sessions.find((entry) => entry.id === id);
    if (!item) return;
    const key = sessionGroupKey(item);
    const group = buildSessionGroups(sessions).find((entry) => entry.key === key);
    const cut = group ? truncateList(group.items, { limit: groupLimits[group.kind], expanded: expandedGroups.has(key) }) : null;
    const truncatedAway = cut != null && !cut.shown.some((entry) => entry.id === id);
    if (!collapsedGroups.includes(key) && !truncatedAway) return;
    if (collapsedGroups.includes(key)) {
      collapsedGroups = toggleCollapsedGroup(collapsedGroups, key);
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedGroups)); } catch { /* see above */ }
    }
    if (truncatedAway) expandedGroups.add(key);
    renderSessions(sessions);
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
      // The path is what disambiguates two repos with the same folder name, and it never fits the row.
      row.title = [label, row.dataset.projectPath].filter(Boolean).join('\n');
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
    // The deck sorts pinned projects first; without a mark on the row, that ordering reads as arbitrary.
    const pin = row.querySelector('.shell-project-pin');
    if (item.pinned && !pin) {
      const icon = createIcon('pin', 'ui-icon shell-project-pin');
      icon.setAttribute('aria-hidden', 'true');
      row.appendChild(icon);
    } else if (!item.pinned && pin) pin.remove();
    applyEntityState(row, key);
  };

  const renderProjects = (items: ShellProjectInput[]): void => {
    const focusedKey = document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset.shellEntityKey : undefined;
    const collapsed = projectsCollapsed;
    // Pinned projects survive the cut wherever they sit — pinning one must never be what removes it.
    const cut = truncateList(items, { limit: PROJECT_LIMIT, expanded: projectsExpanded, keep: (item) => item.pinned === true });
    const shown = collapsed ? [] : cut.shown;
    const shownKeys = new Set(shown.map((item) => shellEntityKey('project', item.path)));
    for (const [key, row] of projectRows) {
      if (!shownKeys.has(key)) { row.remove(); projectRows.delete(key); }
    }
    for (const item of shown) {
      const key = shellEntityKey('project', item.path);
      const row = projectRows.get(key) ?? createProjectRow(key);
      updateProjectRow(row, item, key);
      projectHost.appendChild(row);
    }
    // Naming the truncated state is what makes the list legible: "why these eight?" is answered by the
    // heading itself rather than left for the user to infer from an unexplained cut.
    const truncated = !collapsed && cut.hidden > 0;
    const name = tr(truncated ? 'shell.projects_recent' : 'shell.projects');
    projectsToggle.querySelector<HTMLElement>('.shell-group-name')!.textContent = name;
    projectsToggle.querySelector<HTMLElement>('.shell-group-count')!.textContent = String(items.length);
    projectsToggle.setAttribute('aria-expanded', String(!collapsed));
    projectsToggle.setAttribute('aria-label', `${name}, ${items.length}`);
    projectsToggle.title = tr(collapsed ? 'shell.group_expand' : 'shell.group_collapse', { name });
    projectSection.classList.toggle('is-collapsed', collapsed);
    projectHost.classList.toggle('hidden', collapsed);
    projectsMore.classList.toggle('hidden', !truncated);
    if (truncated) projectsMore.textContent = tr('shell.show_all_projects', { n: items.length });
    applyProjectActivity();
    preserveFocusedRow(focusedKey, projectRows);
  };

  /** Same contract as revealSession: a project selected from Quick Open (or restored on boot) must
   *  end up VISIBLE, even when it sits past the recent-N cut or the section is folded shut. */
  const revealProject = (path: string): void => {
    if (!projects.some((item) => item.path === path)) return;
    const rendered = projectRows.has(shellEntityKey('project', path));
    if (rendered && !projectsCollapsed) return;
    if (projectsCollapsed) {
      projectsCollapsed = false;
      try { localStorage.setItem(PROJECTS_COLLAPSED_KEY, '0'); } catch { /* see above */ }
    }
    if (!rendered) projectsExpanded = true;
    renderProjects(projects);
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
    // Sessions and projects can share a name (a session is usually NAMED after its project), so a flat
    // result list left the user guessing which of two identical-looking rows opened a terminal.
    const heading = (key: string, count: number): void => {
      const label = document.createElement('div'); label.className = 'shell-quick-heading';
      label.setAttribute('role', 'presentation'); label.textContent = `${tr(key)} · ${count}`;
      resultHost.appendChild(label);
    };
    let index = 0;
    const matchedSessions = buildSessionGroups(filtered.sessions).flatMap((group) => group.items);
    if (matchedSessions.length) heading('shell.quick_sessions', matchedSessions.length);
    for (const item of matchedSessions) {
      const mark = document.createElement('span'); mark.className = `shell-signal signal-${sessionStatusShape(item)}`; mark.setAttribute('aria-hidden', 'true');
      resultHost.appendChild(quickResultRow(`shell-quick-${index++}`, mark, item.label, item.detail, () => {
        markActiveEntity(shellEntityKey('session', item.id));
        closeMobileDrawer(); options.onSession(item.id); dismiss();
      }));
    }
    if (filtered.projects.length) heading('shell.quick_projects', filtered.projects.length);
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
  /**
   * One chord to reach any session or project from anywhere, including from inside a terminal — the
   * sidebar's search was previously only reachable by taking your hands off the keyboard. Ctrl+Shift+P
   * is the palette chord users already know, and the cockpit swallows it before the PTY can see it.
   */
  const focusQuickOpen = (): void => {
    if (matchMedia('(max-width: 720px)').matches) openMobileDrawer();
    else if (sidebar.classList.contains('collapsed')) { setCollapsed(false); options.onCollapse(false); }
    requestAnimationFrame(() => { quickOpen.focus(); quickOpen.select(); });
  };
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault(); focusQuickOpen(); return;
    }
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

  // ---- user-sized rail ----
  // 224px could never hold "master ✎1 · Claude · Opus 4.8 · 35%", so every row ended in an ellipsis no
  // matter how much window was going spare. The width is a preference now, dragged from the right edge.
  const shell = document.getElementById('shell')!;
  const resizer = document.getElementById('shell-resizer') as HTMLElement;
  let sidebarWidth = normalizeSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  const applyWidth = (width: number, persist: boolean): void => {
    sidebarWidth = clampSidebarWidth(width);
    // On #shell, not the rail: the handle is a sibling and positions itself from the same variable.
    shell.style.setProperty('--shell-width', `${sidebarWidth}px`);
    resizer.setAttribute('aria-valuenow', String(sidebarWidth));
    if (persist) { try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch { /* private mode / quota */ } }
  };
  resizer.setAttribute('aria-valuemin', String(SIDEBAR_WIDTH_MIN));
  resizer.setAttribute('aria-valuemax', String(SIDEBAR_WIDTH_MAX));
  applyWidth(sidebarWidth, false);
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || sidebar.classList.contains('collapsed')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    resizer.setPointerCapture(event.pointerId);
    shell.classList.add('is-resizing');
    const move = (moveEvent: PointerEvent): void => applyWidth(startWidth + (moveEvent.clientX - startX), false);
    const finish = (): void => {
      resizer.removeEventListener('pointermove', move);
      shell.classList.remove('is-resizing');
      applyWidth(sidebarWidth, true); // one write at the end, not one per pointermove
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', finish, { once: true });
    resizer.addEventListener('pointercancel', finish, { once: true });
  });
  // A pointer-only resize is unusable without a mouse, and a separator is expected to take arrow keys.
  resizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') applyWidth(sidebarWidth - step, true);
    else if (event.key === 'ArrowRight') applyWidth(sidebarWidth + step, true);
    else if (event.key === 'Home') applyWidth(SIDEBAR_WIDTH_MIN, true);
    else if (event.key === 'End') applyWidth(SIDEBAR_WIDTH_MAX, true);
    else if (event.key !== 'Enter') return;
    else applyWidth(SIDEBAR_WIDTH_DEFAULT, true);
    event.preventDefault();
  });
  resizer.addEventListener('dblclick', () => applyWidth(SIDEBAR_WIDTH_DEFAULT, true));

  setCollapsed(options.initialCollapsed);

  const refreshLabels = (): void => {
    // The chord is discoverable only if the field advertises it; the accessible name stays clean.
    quickOpen.placeholder = `${tr('shell.quick_open')}  ${QUICK_OPEN_CHORD}`;
    quickOpen.setAttribute('aria-label', tr('shell.quick_open'));
    quickOpen.title = `${tr('shell.quick_open')} (${QUICK_OPEN_CHORD})`;
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-item[data-view]'))) {
      const view = button.dataset.view as ViewId;
      const label = tr(viewLabels[view]);
      const text = button.querySelector<HTMLElement>('.rail-label'); if (text) text.textContent = label;
      button.title = label; button.setAttribute('aria-label', label);
    }
    projectSection.setAttribute('aria-labelledby', 'shell-projects-label');
    resizer.title = tr('shell.resize');
    resizer.setAttribute('aria-label', tr('shell.resize'));
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
    setActiveProject: (path) => {
      if (path != null) revealProject(path);
      markActiveEntity(path == null ? null : shellEntityKey('project', path));
    },
    setActiveSession: (id) => {
      if (id != null) revealSession(id);
      markActiveEntity(id == null ? null : shellEntityKey('session', id));
    },
    setCollapsed,
    activeView: options.activeView,
    refreshLabels,
  };
}
