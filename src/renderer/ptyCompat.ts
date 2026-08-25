import { windowsPtyCompat, type WindowsPtyCompat } from '../shared/windowsPty';
import { LOCAL_MACHINE_ID } from '../shared/link/machine';

/**
 * The Windows-pty compatibility of the machine a terminal's pty runs on, cached per machine.
 *
 * Asked of the OWNING machine, not this one: a DevDeck Link tile draws a terminal here for a pty
 * running over there, and it is that machine's ConPTY whose resize behaviour xterm has to match.
 * Meant to be awaited BEFORE the Terminal is constructed rather than patched in afterwards, so no
 * terminal ever spends its first resizes on the wrong rule. Only answers are cached — a machine that
 * was unreachable for one open must be allowed to answer for the next.
 */
const byMachine = new Map<string, WindowsPtyCompat | undefined>();

export async function ptyCompatFor(machineId: string = LOCAL_MACHINE_ID): Promise<WindowsPtyCompat | undefined> {
  if (byMachine.has(machineId)) return byMachine.get(machineId);
  try {
    const settings = (machineId === LOCAL_MACHINE_ID
      ? await window.devdeck.getSettings()
      : await window.devdeck.machine(machineId).getSettings()) as { platform?: string; osRelease?: string } | null;
    const compat = windowsPtyCompat(settings?.platform, settings?.osRelease);
    byMachine.set(machineId, compat);
    return compat;
  } catch {
    return undefined; // uncached: the next open asks again
  }
}
