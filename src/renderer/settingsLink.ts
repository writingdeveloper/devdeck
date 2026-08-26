/**
 * Settings → Machines: turn this PC into a host, and connect to other machines.
 *
 * The entire design goal of this screen is that nobody types an address, a port, or a fingerprint.
 * The host presses one button and gets a code; the other machine pastes it — and usually does not
 * even paste, because if the code is already in the clipboard this screen offers it directly.
 *
 * The second goal is that failures name themselves. "Could not connect" sends a person to their
 * firewall no matter what actually went wrong, so every failure the link can produce has its own
 * sentence and its own next step (an expired code, a version gap, a machine that is not the one
 * paired with).
 */
import { tr } from './i18n-runtime';
import { LINK_PERMISSIONS, LINK_PERMISSION_LABEL_KEY, type LinkPermission } from '../shared/link/permissions';
import type { HostStatus, MachineStatus } from '../main/link/linkService';
import type { HostLogEntry } from '../main/link/hostServer';

type Refresh = () => void;

let logOpen = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function chip(labelKey: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const button = el('button', `chip ${extra}`.trim(), tr(labelKey));
  button.addEventListener('click', onClick);
  return button;
}

/** Fingerprints are 95 characters. Nobody compares all of it; the first and last groups are enough
 *  to tell two machines apart, and the full value stays available on hover and for copying. */
function shortFingerprint(fingerprint: string): string {
  const groups = fingerprint.split(':');
  return groups.length < 8 ? fingerprint : `${groups.slice(0, 4).join(':')}…${groups.slice(-4).join(':')}`;
}

function relativeTime(ms: number | null): string {
  if (!ms) return tr('link.never');
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return tr('link.just_now');
  if (minutes < 60) return tr('link.minutes_ago', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tr('link.hours_ago', { n: hours });
  return tr('link.days_ago', { n: Math.round(hours / 24) });
}

/**
 * The sentence a failed connection gets. `problem` comes straight from the dial, so each branch here
 * corresponds to a distinct thing that went wrong rather than to a generic "offline".
 */
function machineProblemText(machine: MachineStatus): string {
  const problem = machine.problem;
  if (!problem) return '';
  switch (problem.kind) {
    case 'unreachable':
      return tr('link.err_unreachable', { addresses: problem.tried.join(', ') || '—' });
    case 'tls':
      return tr('link.err_tls');
    case 'fingerprint':
      // Deliberately alarming, and deliberately not retried: this is the case pinning exists for.
      return tr('link.err_fingerprint');
    case 'refused':
      return problem.code === 'unpaired' ? tr('link.err_unpaired')
        : problem.code === 'token-expired' ? tr('link.err_expired')
          : problem.code === 'protocol-mismatch' ? tr('link.err_version')
            : problem.message;
    default:
      return '';
  }
}

const STATE_LABEL: Record<MachineStatus['state'], string> = {
  connected: 'link.state_connected',
  connecting: 'link.state_connecting',
  offline: 'link.state_offline',
  refused: 'link.state_refused',
  impostor: 'link.state_impostor',
};

function permissionChips(permissions: readonly LinkPermission[]): HTMLElement {
  const wrap = el('div', 'link-perms');
  for (const permission of LINK_PERMISSIONS) {
    if (!permissions.includes(permission)) continue;
    wrap.appendChild(el('span', 'link-perm', tr(LINK_PERMISSION_LABEL_KEY[permission])));
  }
  if (!wrap.childElementCount) wrap.appendChild(el('span', 'link-perm link-perm-none', tr('link.perm_none')));
  return wrap;
}

/**
 * The one-line verdict on automatic port opening.
 *
 * Null while it is still in flight — a router that answers neither protocol takes a couple of
 * seconds to say so, and a line that appears and then changes reads worse than one that appears once.
 * 'carrier-nat' is styled as a problem because it is the case nothing in this app can fix: the
 * router opened a port behind the ISP's own translator, and the address it reports routes nowhere.
 */
function portMappingLine(status: HostStatus): HTMLElement | null {
  const map = status.portMap;
  if (!map) return null;
  if (map.state === 'mapped') {
    return el('p', 'set-hint', tr('link.portmap_mapped', { address: map.externalAddress ?? '', via: map.via ?? '' }));
  }
  if (map.state === 'carrier-nat') {
    const note = el('p', 'link-row-problem', tr('link.portmap_carrier'));
    note.setAttribute('role', 'status');
    return note;
  }
  if (map.state === 'failed') return el('p', 'link-row-problem', tr('link.portmap_failed', { detail: map.detail ?? '' }));
  return el('p', 'set-hint', tr('link.portmap_unsupported'));
}

// ---- this machine ----

function hostSection(status: HostStatus, refresh: Refresh): HTMLElement {
  const wrap = el('div', 'link-block');

  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = status.enabled;
  toggle.id = 'link-host-toggle';
  toggle.addEventListener('change', async () => { await window.devdeck.link.setHostMode(toggle.checked); refresh(); });
  const toggleRow = el('div', 'link-toggle');
  const toggleLabel = el('label', 'link-toggle-label', tr('link.host_enable'));
  toggleLabel.htmlFor = toggle.id;
  toggleRow.append(toggle, toggleLabel);
  wrap.appendChild(toggleRow);
  wrap.appendChild(el('p', 'set-hint', tr('link.host_hint')));

  // The code button is shown even while host mode is off, because asking for a code IS asking to
  // accept connections — createInvite turns it on. Hiding it behind the switch would put a step in
  // front of the one action this screen exists for, and leave someone looking at a toggle wondering
  // what to do next.
  if (!status.enabled) {
    wrap.appendChild(inviteArea(status, refresh));
    return wrap;
  }

  if (status.error) {
    const problem = el('p', 'link-error', tr('link.host_error', { error: status.error }));
    problem.setAttribute('role', 'alert');
    wrap.appendChild(problem);
  }

  // What the person would otherwise have gone to `ipconfig` for. The host enumerates its own
  // interfaces, so this is informational — the code below already carries all of it.
  const meta = el('div', 'link-meta');
  meta.appendChild(el('div', 'link-meta-row', tr('link.port', { port: String(status.port) })));
  const addresses = el('div', 'link-meta-row', tr('link.reachable_at', { addresses: status.addresses.join('  ·  ') || '—' }));
  meta.appendChild(addresses);
  const fingerprint = el('div', 'link-meta-row', tr('link.fingerprint', { value: shortFingerprint(status.fingerprint) }));
  fingerprint.title = status.fingerprint;
  meta.appendChild(fingerprint);
  wrap.appendChild(meta);

  // What came of asking the router to open the port. Worth a line of its own: it is the difference
  // between an invite that works from another network and one that only works from this room, and
  // the person creating the invite is the only one who can act on it.
  const mapping = portMappingLine(status);
  if (mapping) wrap.appendChild(mapping);

  wrap.appendChild(inviteArea(status, refresh));
  wrap.appendChild(deviceList(status, refresh));
  return wrap;
}

function inviteArea(status: HostStatus, refresh: Refresh): HTMLElement {
  const wrap = el('div', 'link-invite');
  if (!status.invite) {
    wrap.appendChild(chip('link.create_code', async () => { await window.devdeck.link.createInvite(); refresh(); }, 'chip-primary'));
    wrap.appendChild(el('p', 'set-hint', tr('link.create_code_hint')));
    return wrap;
  }

  const code = el('code', 'link-code', status.invite.code);
  code.tabIndex = 0;
  // Selecting it on focus/click means "copy" also works the way people actually do it, with the
  // keyboard, on a string far too long to select by dragging.
  const selectAll = (): void => {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  code.addEventListener('focus', selectAll);
  code.addEventListener('click', selectAll);

  const copied = el('span', 'link-copied');
  copied.setAttribute('aria-live', 'polite');
  const copy = chip('link.copy_code', () => {
    window.devdeck.clipboard.writeText(status.invite!.code);
    copied.textContent = tr('link.copied');
    setTimeout(() => { copied.textContent = ''; }, 2_000);
  }, 'chip-primary');

  const remaining = Math.max(0, Math.round((status.invite.expiresAtMs - Date.now()) / 60_000));
  const expiry = el('span', 'link-expiry', tr('link.expires_in', { n: remaining }));

  const actions = el('div', 'link-invite-actions');
  actions.append(copy, chip('link.revoke_code', async () => { await window.devdeck.link.revokeInvite(); refresh(); }), expiry, copied);

  wrap.append(el('p', 'set-hint', tr('link.paste_on_other')), code, actions);
  return wrap;
}

function deviceList(status: HostStatus, refresh: Refresh): HTMLElement {
  const wrap = el('div', 'link-devices');
  wrap.appendChild(el('h4', 'link-sub', tr('link.allowed_devices')));
  if (status.devices.length === 0) {
    wrap.appendChild(el('p', 'set-hint', tr('link.no_devices')));
    return wrap;
  }
  const connected = new Set(status.connections.map((c) => c.fingerprint));
  for (const device of status.devices) {
    const row = el('div', 'link-row');
    const name = el('div', 'link-row-name', device.machineName || shortFingerprint(device.fingerprint));
    name.title = device.fingerprint;
    const live = connected.has(device.fingerprint);
    const state = el('span', `link-state ${live ? 'is-on' : ''}`.trim(), tr(live ? 'link.state_connected' : 'link.state_idle'));
    const seen = el('span', 'link-row-meta', relativeTime(device.lastSeenMs ?? device.pairedAtMs));

    const actions = el('div', 'link-row-actions');
    if (live) {
      actions.appendChild(chip('link.disconnect', async () => { await window.devdeck.link.disconnectDevice(device.fingerprint); refresh(); }));
    }
    actions.appendChild(chip('link.revoke_device', async () => { await window.devdeck.link.revokeDevice(device.fingerprint); refresh(); }, 'chip-danger'));

    const perms = el('div', 'link-row-perms');
    for (const permission of LINK_PERMISSIONS) {
      const box = el('input');
      box.type = 'checkbox';
      box.checked = device.permissions.includes(permission);
      box.id = `link-perm-${device.fingerprint.slice(0, 8)}-${permission}`;
      box.addEventListener('change', async () => {
        const next = LINK_PERMISSIONS.filter((p) => (p === permission ? box.checked : device.permissions.includes(p)));
        await window.devdeck.link.setDevicePermissions(device.fingerprint, next);
        refresh();
      });
      const label = el('label', 'link-perm-toggle', tr(LINK_PERMISSION_LABEL_KEY[permission]));
      label.htmlFor = box.id;
      const holder = el('span', 'link-perm-holder');
      holder.append(box, label);
      perms.appendChild(holder);
    }

    row.append(name, state, seen, actions, perms);
    wrap.appendChild(row);
  }
  return wrap;
}

// ---- other machines ----

function clientSection(machines: MachineStatus[], clipboard: { code: string; machineName: string } | null, refresh: Refresh): HTMLElement {
  const wrap = el('div', 'link-block');

  const status = el('p', 'link-add-status');
  status.setAttribute('aria-live', 'polite');

  const submit = async (code: string): Promise<void> => {
    if (!code.trim()) return;
    status.textContent = tr('link.connecting');
    const result = await window.devdeck.link.addMachine(code.trim());
    if (result.ok) { status.textContent = ''; refresh(); return; }
    // Each of these is a different next step, which is the entire reason they are separate codes.
    status.textContent = result.problem === 'not-a-code' ? tr('link.err_not_a_code')
      : result.problem === 'truncated' ? tr('link.err_truncated')
        : result.problem === 'expired' ? tr('link.err_expired')
          : result.problem === 'unsupported-version' ? tr('link.err_version')
            : result.problem === 'malformed' ? tr('link.err_malformed')
              : result.failure ? machineProblemText({ problem: result.failure } as MachineStatus)
                : tr('link.err_malformed');
  };

  // The usual case should be one click, not a paste into an empty field.
  if (clipboard) {
    const banner = el('div', 'link-banner');
    banner.appendChild(el('span', 'link-banner-text', tr('link.clipboard_found', { name: clipboard.machineName })));
    banner.appendChild(chip('link.connect', () => void submit(clipboard.code), 'chip-primary'));
    wrap.appendChild(banner);
  }

  const input = el('input', 'set-input link-code-input');
  input.type = 'text';
  input.placeholder = tr('link.paste_placeholder');
  input.spellcheck = false;
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') void submit(input.value); });
  const addRow = el('div', 'link-add-row');
  addRow.append(input, chip('link.connect', () => void submit(input.value)));
  wrap.append(addRow, status);

  if (machines.length === 0) {
    wrap.appendChild(el('p', 'set-hint', tr('link.no_machines')));
    return wrap;
  }

  for (const machine of machines) {
    const row = el('div', 'link-row');
    row.appendChild(el('div', 'link-row-name', machine.machineName || machine.machineId.slice(0, 8)));
    const state = el('span', `link-state is-${machine.state}`, tr(STATE_LABEL[machine.state]));
    row.appendChild(state);
    row.appendChild(el('span', 'link-row-meta', machine.address ?? relativeTime(machine.lastSeenMs)));
    const actions = el('div', 'link-row-actions');
    actions.appendChild(chip('link.forget_machine', async () => { await window.devdeck.link.removeMachine(machine.machineId); refresh(); }, 'chip-danger'));
    row.appendChild(actions);

    const problem = machineProblemText(machine);
    if (problem) {
      const note = el('p', `link-row-problem${machine.state === 'impostor' ? ' is-alarming' : ''}`, problem);
      if (machine.state === 'impostor') note.setAttribute('role', 'alert');
      row.appendChild(note);
    } else if (machine.state === 'connected') {
      row.appendChild(permissionChips(machine.permissions));
    }
    wrap.appendChild(row);
  }
  return wrap;
}

// ---- audit ----

function logSection(entries: HostLogEntry[], refresh: Refresh): HTMLElement {
  const wrap = el('div', 'link-block');
  const toggle = el('button', 'chip link-log-toggle', tr(logOpen ? 'link.hide_log' : 'link.show_log', { n: entries.length }));
  toggle.setAttribute('aria-expanded', String(logOpen));
  toggle.addEventListener('click', () => { logOpen = !logOpen; refresh(); });
  wrap.appendChild(toggle);
  if (!logOpen) return wrap;

  if (entries.length === 0) {
    wrap.appendChild(el('p', 'set-hint', tr('link.no_log')));
    return wrap;
  }
  const list = el('div', 'link-log');
  for (const entry of entries.slice(0, 100)) {
    const row = el('div', `link-log-row is-${entry.kind}`);
    row.append(
      el('span', 'link-log-time', new Date(entry.at).toLocaleString()),
      el('span', 'link-log-kind', tr(`link.log_${entry.kind}`)),
      el('span', 'link-log-who', entry.machineName || shortFingerprint(entry.fingerprint)),
      el('span', 'link-log-detail', entry.detail),
    );
    list.appendChild(row);
  }
  wrap.appendChild(list);
  wrap.appendChild(chip('link.clear_log', async () => { await window.devdeck.link.clearLog(); refresh(); }));
  return wrap;
}

/**
 * Build the whole section. Returns null when the link is unavailable on this machine — the settings
 * screen then simply has no such section, rather than an inert one nobody can explain.
 */
export async function renderLinkSettings(refresh: Refresh): Promise<HTMLElement | null> {
  let status: HostStatus;
  try {
    status = await window.devdeck.link.hostStatus();
  } catch {
    return null;
  }
  const [machines, clipboardCode, entries] = await Promise.all([
    window.devdeck.link.machines().catch(() => [] as MachineStatus[]),
    window.devdeck.link.clipboardInvite().catch(() => null),
    window.devdeck.link.log(100).catch(() => [] as HostLogEntry[]),
  ]);

  const section = el('div', 'link-section');
  section.append(
    el('h3', 'link-heading', tr('link.this_machine', { name: status.machineName })),
    hostSection(status, refresh),
    el('h3', 'link-heading', tr('link.other_machines')),
    clientSection(machines, clipboardCode, refresh),
    logSection(entries, refresh),
  );
  return section;
}
