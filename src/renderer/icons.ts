export type IconName =
  | 'search' | 'projects' | 'sessions' | 'tasks' | 'usage'
  | 'settings' | 'refresh' | 'more' | 'play' | 'panel-left'
  | 'folder' | 'plus' | 'restart' | 'close' | 'pin' | 'edit' | 'brain' | 'clock'
  | 'trash' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'minimize' | 'maximize' | 'restore' | 'moon' | 'power' | 'globe';

const paths: Record<IconName, string> = {
  search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
  projects: '<path d="M3 7.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M3 7.5v-2a2 2 0 0 1 2-2h4l2 2h4"></path>',
  sessions: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3"></path><path d="M13 15h4"></path>',
  tasks: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="m8 9 1.5 1.5L12 8"></path><path d="M14 9h2"></path><path d="m8 15 1.5 1.5L12 14"></path><path d="M14 15h2"></path>',
  usage: '<path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20H2"></path>',
  settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"></path>',
  refresh: '<path d="M20 6v5h-5"></path><path d="M18.5 16a8 8 0 1 1 .8-7.5L20 11"></path>',
  more: '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
  play: '<path d="m8 5 11 7-11 7z"></path>',
  'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path>',
  folder: '<path d="M3 7.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M3 7.5v-2a2 2 0 0 1 2-2h4l2 2h4"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  restart: '<path d="M20 6v5h-5"></path><path d="M18.5 16a8 8 0 1 1 .8-7.5L20 11"></path>',
  close: '<path d="m6 6 12 12M18 6 6 18"></path>',
  pin: '<path d="m9 3 6 6"></path><path d="m6 10 8 8"></path><path d="m14 5 5 5-3 3-2-1-5 5-2-2 5-5-1-2z"></path><path d="m7 17-4 4"></path>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"></path><path d="m13.5 6.5 4 4"></path>',
  brain: '<path d="M9.5 4.5A3 3 0 0 0 4 6a3 3 0 0 0 0 5 3 3 0 0 0 1 5.5A3 3 0 0 0 10 19V5"></path><path d="M14.5 4.5A3 3 0 0 1 20 6a3 3 0 0 1 0 5 3 3 0 0 1-1 5.5A3 3 0 0 1 14 19V5"></path><path d="M7 9h3M14 9h3M7 14h3M14 14h3"></path>',
  clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  trash: '<path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m6 7 1 14h10l1-14"></path><path d="M10 11v6M14 11v6"></path>',
  'chevron-left': '<path d="m15 18-6-6 6-6"></path>',
  'chevron-right': '<path d="m9 18 6-6-6-6"></path>',
  'chevron-down': '<path d="m6 9 6 6 6-6"></path>',
  // The language control used to be the glyph 文, which only reads as "language" if you already read
  // CJK — to everyone else it was an unlabelled foreign character. A globe is the universal sign.
  globe: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"></path>',
  minimize: '<path d="M5 18h14"></path>',
  maximize: '<rect x="5" y="5" width="14" height="14" rx="1"></rect>',
  restore: '<rect x="7" y="7" width="12" height="12" rx="1"></rect><path d="M5 17V5h12"></path>',
  moon: '<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5z"></path>',
  power: '<path d="M12 2v10"></path><path d="M6.2 5.2a8 8 0 1 0 11.6 0"></path>',
};

export function iconMarkup(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export function createIcon(name: IconName, className = 'ui-icon'): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = iconMarkup(name);
  const icon = template.content.firstElementChild as SVGSVGElement;
  icon.classList.add(...className.split(/\s+/).filter(Boolean));
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  return icon;
}
