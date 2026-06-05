export function mountNav(onShow: (view: string) => void): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-item[data-view]'));
  const views = new Map<string, HTMLElement>();
  for (const id of ['projects', 'usage', 'settings', 'next']) views.set(id, document.getElementById('view-' + id)!);
  function show(view: string): void {
    for (const it of items) {
      const isActive = it.dataset.view === view;
      it.classList.toggle('active', isActive);
      if (isActive) it.setAttribute('aria-current', 'page');
      else it.removeAttribute('aria-current');
    }
    for (const [id, el] of views) el.classList.toggle('active', id === view);
    onShow(view);
  }
  for (const it of items) it.addEventListener('click', () => show(it.dataset.view!));
}
