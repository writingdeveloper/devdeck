import type { ProjectViewModel } from './types';

export interface NextItem {
  path: string;
  name: string;
  text: string;
  kind: 'note' | 'cue';
}

type NextSource = Pick<ProjectViewModel, 'path' | 'name' | 'note' | 'resumeCue' | 'hidden' | 'activityMs'>;

/**
 * Cross-project "what's next" list: each visible project's manual note (preferred)
 * or, if it has none, its auto resume cue. Projects with neither are omitted.
 * Sorted by recent activity.
 */
export function collectNextItems(projects: NextSource[]): NextItem[] {
  const items: (NextItem & { activityMs: number | null })[] = [];
  for (const p of projects) {
    if (p.hidden) continue;
    const note = (p.note ?? '').trim();
    if (note) {
      items.push({ path: p.path, name: p.name, text: note, kind: 'note', activityMs: p.activityMs });
    } else if (p.resumeCue) {
      items.push({ path: p.path, name: p.name, text: p.resumeCue.text, kind: 'cue', activityMs: p.activityMs });
    }
  }
  items.sort((a, b) => (b.activityMs ?? -Infinity) - (a.activityMs ?? -Infinity));
  return items.map((i) => ({ path: i.path, name: i.name, text: i.text, kind: i.kind }));
}
