import { mountProjects } from './projectsView';
import { mountNav } from './nav';

const toastHost = document.getElementById('toast-host')!;
window.devdeck.onError((msg) => {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  toastHost.appendChild(t); setTimeout(() => t.remove(), 6000);
});

mountProjects();
mountNav((view) => { void view; });
