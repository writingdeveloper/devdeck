import type { ProjectMemory, ProjectViewModel } from '../shared/types';
import { tr, localeTag } from './i18n-runtime';
import { createProviderLogo, providerName } from './providerLogo';
import { createProviderOpenControl } from './providerOpenControl';
import { liveProjectProviders } from './cockpitView';
import { openInTerminal } from './openRouter';
import { presetBoardProject } from './nextView';
import { toast } from './loadError';
import { snapshotRows, timelineRows, type MemoryAction } from './projectMemoryPresentation';
import { memorySurfaceMode } from './projectMemorySurface';
import { createIcon } from './icons';
import { deckFor, selectedMachineId } from './machineDeck';

let currentOverlay: HTMLElement | null = null;
let closeCurrent: (() => void) | null = null;

function when(at: number): string {
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

function button(label: string, className = 'chip'): HTMLButtonElement {
  const el = document.createElement('button'); el.type = 'button'; el.className = className; el.textContent = label;
  return el;
}

export function openProjectMemoryModal(project: ProjectViewModel, trigger: HTMLElement): void {
  closeCurrent?.();
  const overlay = document.createElement('div'); overlay.className = 'pm-overlay';
  const modal = document.createElement('section'); modal.className = 'pm-modal loading';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'pm-title');
  const head = document.createElement('header'); head.className = 'pm-head';
  const heading = document.createElement('div'); heading.className = 'pm-heading';
  const title = document.createElement('h2'); title.id = 'pm-title'; title.textContent = project.name;
  const subtitle = document.createElement('div'); subtitle.className = 'pm-subtitle'; subtitle.textContent = tr('memory.title');
  heading.append(title, subtitle);
  const refresh = button(tr('memory.refresh'), 'chip pm-refresh'); refresh.setAttribute('aria-label', tr('memory.refresh'));
  const closeButton = button('', 'iconbtn pm-close'); closeButton.appendChild(createIcon('close')); closeButton.setAttribute('aria-label', tr('memory.close')); closeButton.title = tr('memory.close');
  head.append(heading, refresh, closeButton);
  const body = document.createElement('div'); body.className = 'pm-body';
  const loading = document.createElement('div'); loading.className = 'pm-loading'; loading.setAttribute('role', 'status'); loading.textContent = tr('memory.loading');
  body.appendChild(loading);
  const foot = document.createElement('footer'); foot.className = 'pm-foot';
  const footHint = document.createElement('span'); footHint.textContent = tr('memory.open_hint');
  const open = createProviderOpenControl({
    path: project.path, historyAgentIds: project.agentIds, liveAgentIds: () => liveProjectProviders(project.path),
    onOpen: (intent) => {
      close();
      openInTerminal([{ ...intent, name: project.name, staleLevel: project.stale.level, branch: project.branch, dirty: project.uncommitted }]);
    },
  });
  foot.append(footHint, open);
  modal.append(head, body, foot); overlay.appendChild(modal); document.body.appendChild(overlay); currentOverlay = overlay;

  const applySurfaceMode = (): void => {
    const mode = memorySurfaceMode(window.innerWidth);
    overlay.classList.toggle('pm-mode-drawer', mode === 'drawer');
    overlay.classList.toggle('pm-mode-sheet', mode === 'sheet');
    modal.classList.toggle('pm-drawer', mode === 'drawer');
    modal.classList.toggle('pm-sheet', mode === 'sheet');
    modal.dataset.surface = mode;
  };
  applySurfaceMode();
  window.addEventListener('resize', applySurfaceMode);

  const close = (): void => {
    if (currentOverlay !== overlay) return;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', applySurfaceMode);
    overlay.remove(); currentOverlay = null;
    closeCurrent = null;
    const focusTarget = trigger.isConnected
      ? trigger
      : Array.from(document.querySelectorAll<HTMLElement>('.project-memory-button'))
        .find((button) => button.dataset.projectPath === project.path);
    focusTarget?.focus();
  };
  closeCurrent = close;
  const focusable = (): HTMLElement[] => Array.from(
    modal.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'),
  ).filter((item) => {
    if (item.matches(':disabled') || item.closest('[hidden], [inert], [aria-hidden="true"], .hidden')) return false;
    const style = getComputedStyle(item);
    return style.display !== 'none' && style.visibility !== 'hidden' && item.getClientRects().length > 0;
  });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // A nested disclosure owns the first Escape. This capture listener deliberately lets the
      // event continue to the provider control's document listener; a later Escape closes us.
      if (modal.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      event.preventDefault(); event.stopPropagation(); close(); return;
    }
    if (event.key !== 'Tab') return;
    const list = focusable(); if (!list.length) return;
    const first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || !modal.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  closeButton.addEventListener('click', close);
  requestAnimationFrame(() => closeButton.focus());

  const runAction = (action: MemoryAction): void => {
    if (action.kind === 'session') {
      close();
      openInTerminal([{
        path: project.path, name: project.name, staleLevel: project.stale.level, branch: project.branch,
        dirty: project.uncommitted, sessionId: action.sessionId, agentId: action.agentId, mode: 'auto',
      }]);
    } else if (action.kind === 'tasks') {
      close(); presetBoardProject(project.path);
      document.querySelector<HTMLButtonElement>('.rail-item[data-view="next"]')?.click();
    } else {
      window.devdeck.clipboard.writeText(action.text); toast(tr('memory.copied'));
    }
  };

  const render = (memory: ProjectMemory): void => {
    body.replaceChildren(); modal.classList.remove('loading');
    if (memory.partial.length) {
      const warning = document.createElement('div'); warning.className = 'pm-warning'; warning.setAttribute('role', 'status');
      warning.textContent = tr(memory.partial.length === 2 ? 'memory.partial_all' : memory.partial[0] === 'git' ? 'memory.partial_git' : 'memory.partial_sessions');
      body.appendChild(warning);
    }
    const snapshot = document.createElement('section'); snapshot.className = 'pm-section';
    const snapshotTitle = document.createElement('h3'); snapshotTitle.textContent = tr('memory.snapshot'); snapshot.appendChild(snapshotTitle);
    const snapshotList = document.createElement('div'); snapshotList.className = 'pm-snapshot';
    for (const row of snapshotRows(memory, Date.now())) {
      const item = document.createElement('article'); item.className = `pm-snapshot-row pm-${row.kind}`;
      const label = document.createElement('div'); label.className = 'pm-label'; label.textContent = tr(row.labelKey);
      const value = document.createElement('div'); value.className = 'pm-value';
      if (row.agentId) value.appendChild(createProviderLogo(row.agentId, 'ck-provider-logo sm'));
      const text = document.createElement('span'); text.textContent = row.valueKey ? tr(row.valueKey, row.vars) : row.value ?? '';
      value.appendChild(text);
      if (row.items) {
        const list = document.createElement('ul');
        for (const raw of row.items) { const li = document.createElement('li'); li.textContent = raw; list.appendChild(li); }
        value.appendChild(list);
        if ((row.vars?.remaining as number) > 0) {
          const more = document.createElement('small'); more.textContent = tr('memory.more_tasks', row.vars); value.appendChild(more);
        }
      }
      if (row.at) { const time = document.createElement('time'); time.dateTime = new Date(row.at).toISOString(); time.textContent = when(row.at); value.appendChild(time); }
      if (row.detail) { const detail = document.createElement('code'); detail.textContent = row.detail; value.appendChild(detail); }
      if (row.action) {
        const action = button(tr(row.action.kind === 'session' ? 'memory.resume' : row.action.kind === 'tasks' ? 'memory.view_tasks' : 'memory.copy'), 'chip pm-row-action');
        action.addEventListener('click', () => runAction(row.action!)); value.appendChild(action);
      }
      item.append(label, value); snapshotList.appendChild(item);
    }
    snapshot.appendChild(snapshotList); body.appendChild(snapshot);

    const timeline = document.createElement('section'); timeline.className = 'pm-section';
    const timelineTitle = document.createElement('h3'); timelineTitle.textContent = tr('memory.timeline'); timeline.appendChild(timelineTitle);
    const list = document.createElement('ol'); list.className = 'pm-timeline';
    for (const row of timelineRows(memory)) {
      const item = document.createElement('li'); item.className = `pm-timeline-item pm-event-${row.kind}`;
      const icon = document.createElement('span'); icon.className = 'pm-event-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.textContent = row.kind === 'session' ? '◇' : row.kind === 'commit' ? '⌘' : row.kind === 'task-created' ? '✓' : '↗';
      const copy = document.createElement('div'); copy.className = 'pm-event-copy';
      const meta = document.createElement('div'); meta.className = 'pm-event-meta';
      if (row.agentId) meta.appendChild(createProviderLogo(row.agentId, 'ck-provider-logo sm'));
      const kind = document.createElement('span'); kind.textContent = tr(`memory.event_${row.kind.replace('-', '_')}`); meta.appendChild(kind);
      const time = document.createElement('time'); time.dateTime = new Date(row.at).toISOString(); time.textContent = when(row.at); meta.appendChild(time);
      const eventTitle = document.createElement('div'); eventTitle.className = 'pm-event-title'; eventTitle.textContent = row.titleKey ? tr(row.titleKey) : row.title;
      copy.append(meta, eventTitle);
      if (row.detail) { const detail = document.createElement('div'); detail.className = 'pm-event-detail'; detail.textContent = row.detail; copy.appendChild(detail); }
      if (row.due) { const due = document.createElement('small'); due.textContent = tr('memory.due', { date: row.due }); copy.appendChild(due); }
      item.append(icon, copy);
      if (row.action) {
        const action = button(tr(row.action.kind === 'session' ? 'memory.resume' : row.action.kind === 'tasks' ? 'memory.view_tasks' : 'memory.copy'), 'chip');
        action.setAttribute('aria-label', `${action.textContent} · ${row.agentId ? providerName(row.agentId) : eventTitle.textContent}`);
        action.addEventListener('click', () => runAction(row.action!)); item.appendChild(action);
      }
      list.appendChild(item);
    }
    if (!memory.events.length) { const empty = document.createElement('div'); empty.className = 'pm-empty'; empty.textContent = tr('memory.empty'); timeline.appendChild(empty); }
    else timeline.appendChild(list);
    body.appendChild(timeline);
  };

  const load = async (fresh = false): Promise<void> => {
    refresh.disabled = true;
    if (fresh) { modal.classList.add('loading'); body.replaceChildren(loading); }
    // The snapshot is assembled from git, transcripts and stored notes that all live on the machine
    // holding the project — reading it here would describe unrelated local work.
    try { render(await deckFor(selectedMachineId()).projectMemory(project.path, fresh)); }
    catch {
      modal.classList.remove('loading'); body.replaceChildren();
      const error = document.createElement('div'); error.className = 'pm-error'; error.textContent = tr('memory.load_failed');
      const retry = button(tr('memory.retry')); retry.addEventListener('click', () => void load(true)); error.appendChild(retry); body.appendChild(error);
    } finally { refresh.disabled = false; }
  };
  refresh.addEventListener('click', () => void load(true));
  void load();
}
