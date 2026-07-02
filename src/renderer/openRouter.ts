import { openProjectsInCockpit, type OpenReq } from './cockpitView';

// Shared "open in terminal" routing so BOTH the Projects deck and the task board open the same way —
// the embedded cockpit on Windows, the external terminal elsewhere. Kept in its own module (rather than
// on projectsView) to avoid a projectsView ↔ nextView import cycle: the task board opening a project was
// previously calling window.devdeck.open directly, which always launched the EXTERNAL terminal even when
// the cockpit was available.
let cockpitEnabled = false;

/** Set by boot() once the platform is known — the cockpit is Windows-only (see isCockpitPlatform). */
export function setCockpitEnabled(enabled: boolean): void { cockpitEnabled = enabled; }

/** Route "open" to the embedded cockpit (Windows) or the external terminal (other OSes). */
export function openInTerminal(reqs: OpenReq[]): void {
  if (cockpitEnabled) { void openProjectsInCockpit(reqs); return; }
  void window.devdeck.open(reqs.map((r) => ({ path: r.path, sessionId: r.sessionId ?? null })));
}
