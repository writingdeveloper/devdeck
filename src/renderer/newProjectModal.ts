import { tr } from './i18n-runtime';
import { validateProjectName } from '../shared/projectName';
import type { Folder } from '../shared/types';

// Local toast, mirroring the inline pattern in main.ts (#toast-host + auto-remove).
function toast(msg: string): void {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  host.appendChild(el); setTimeout(() => el.remove(), 6000);
}

// Cosmetic path join for the live preview — infer the separator from the parent.
function joinPreview(parent: string, name: string): string {
  const sep = parent.includes('\\') ? '\\' : '/';
  return name ? parent + sep + name : parent + sep;
}

// Map a name/create error code to a human message. Codes come from
// validateProjectName (NameError) and createProject (CreateError).
function errorMessage(reason: string): string {
  switch (reason) {
    case 'long': return tr('newproj.err_long');
    case 'exists': return tr('newproj.err_exists');
    case 'parent_not_allowed':
    case 'mkdir_failed': return tr('newproj.err_create');
    default: return tr('newproj.err_name'); // chars, reserved, empty
  }
}

/**
 * Open the "new project" modal. On success it calls `onCreated(path)` with the
 * freshly created project folder (the caller opens it and refreshes the deck).
 */
export function openNewProjectModal(onCreated: (path: string) => void): void {
  if (document.querySelector('.np-overlay')) return; // single instance

  const overlay = document.createElement('div'); overlay.className = 'np-overlay';
  const panel = document.createElement('div'); panel.className = 'np-panel';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', tr('newproj.title'));

  const title = document.createElement('h3'); title.className = 'np-title'; title.textContent = tr('newproj.title');

  const locRow = document.createElement('div'); locRow.className = 'np-row';
  const locLabel = document.createElement('label'); locLabel.htmlFor = 'np-loc-select'; locLabel.textContent = tr('newproj.location');
  const locWrap = document.createElement('div'); locWrap.className = 'np-loc';
  const select = document.createElement('select'); select.id = 'np-loc-select'; select.className = 'np-input';
  const addLoc = document.createElement('button'); addLoc.type = 'button'; addLoc.className = 'iconbtn';
  addLoc.textContent = '📁'; addLoc.title = tr('newproj.add_location'); addLoc.setAttribute('aria-label', tr('newproj.add_location'));
  locWrap.append(select, addLoc);
  locRow.append(locLabel, locWrap);

  const nameRow = document.createElement('div'); nameRow.className = 'np-row';
  const nameLabel = document.createElement('label'); nameLabel.htmlFor = 'np-name'; nameLabel.textContent = tr('newproj.name');
  const nameInput = document.createElement('input'); nameInput.id = 'np-name'; nameInput.type = 'text'; nameInput.className = 'np-input';
  nameInput.placeholder = tr('newproj.name_ph'); nameInput.autocomplete = 'off'; nameInput.spellcheck = false;
  nameRow.append(nameLabel, nameInput);

  const preview = document.createElement('div'); preview.className = 'np-preview'; preview.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div'); actions.className = 'np-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'chip'; cancel.textContent = tr('newproj.cancel');
  const create = document.createElement('button'); create.type = 'button'; create.className = 'primary'; create.textContent = tr('newproj.create');
  actions.append(cancel, create);

  panel.append(title, locRow, nameRow, preview, actions);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let roots: Folder[] = [];

  const close = (): void => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  cancel.addEventListener('click', close);

  const parentPath = (): string => select.value;

  const refresh = (): void => {
    if (roots.length === 0) {
      preview.className = 'np-preview err'; preview.textContent = tr('newproj.no_location');
      create.disabled = true; return;
    }
    const check = validateProjectName(nameInput.value);
    if (!check.ok) {
      preview.className = check.reason === 'empty' ? 'np-preview' : 'np-preview err';
      preview.textContent = check.reason === 'empty' ? joinPreview(parentPath(), '') : errorMessage(check.reason);
      create.disabled = true; return;
    }
    preview.className = 'np-preview'; preview.textContent = joinPreview(parentPath(), check.name);
    create.disabled = false;
  };

  const loadRoots = async (selectPath?: string): Promise<void> => {
    const folders = await window.devdeck.getFolders();
    roots = folders.filter((f) => f.kind === 'root');
    select.replaceChildren(...roots.map((f) => {
      const o = document.createElement('option'); o.value = f.path; o.textContent = f.path; return o;
    }));
    if (selectPath && roots.some((f) => f.path === selectPath)) select.value = selectPath;
    refresh();
  };

  addLoc.addEventListener('click', async () => {
    const picked = await window.devdeck.pickFolder();
    if (!picked) return;
    await window.devdeck.addFolder(picked); // a fresh dir registers as a scan root
    await loadRoots(picked);
    nameInput.focus();
  });

  nameInput.addEventListener('input', refresh);
  select.addEventListener('change', refresh);

  const submit = async (): Promise<void> => {
    const check = validateProjectName(nameInput.value);
    if (roots.length === 0 || !check.ok) { refresh(); return; }
    create.disabled = true;
    const res = await window.devdeck.createProject(parentPath(), check.name);
    if (res.ok && res.path) {
      if (res.gitInitialized === false) toast(tr('newproj.warn_git'));
      close();
      onCreated(res.path);
      return;
    }
    preview.className = 'np-preview err'; preview.textContent = errorMessage(res.error ?? 'mkdir_failed');
    create.disabled = false;
  };
  create.addEventListener('click', () => void submit());
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });

  void loadRoots().then(() => nameInput.focus());
}
