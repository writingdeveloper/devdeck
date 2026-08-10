export type ViewId = 'projects' | 'usage' | 'settings' | 'next' | 'cockpit';

export function mountNav(onShow: (view: ViewId) => void): { show(view: ViewId): void; active(): ViewId } {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-item[data-view]'));
  const views = new Map<string, HTMLElement>();
  for (const id of ['projects', 'usage', 'settings', 'next', 'cockpit']) views.set(id, document.getElementById('view-' + id)!);
  let activeView: ViewId = 'projects';
  function show(view: ViewId): void {
    if (!views.has(view)) return;
    activeView = view;
    for (const it of items) {
      const isActive = it.dataset.view === view;
      it.classList.toggle('active', isActive);
      if (isActive) it.setAttribute('aria-current', 'page');
      else it.removeAttribute('aria-current');
    }
    for (const [id, el] of views) el.classList.toggle('active', id === view);
    onShow(view);
  }
  for (const it of items) it.addEventListener('click', () => show(it.dataset.view as ViewId));
  return { show, active: () => activeView };
}
