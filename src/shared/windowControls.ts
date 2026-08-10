export interface MaximizeActionPresentation {
  icon: 'maximize' | 'restore';
  labelKey: 'window.maximize' | 'window.restore';
}

export function maximizeActionPresentation(maximized: boolean): MaximizeActionPresentation {
  return maximized
    ? { icon: 'restore', labelKey: 'window.restore' }
    : { icon: 'maximize', labelKey: 'window.maximize' };
}
