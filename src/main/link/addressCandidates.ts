/**
 * The addresses a host can honestly advertise for itself.
 *
 * Making someone find their own IP is where remote tools lose people — they open `ipconfig`, guess
 * wrong, hit a firewall, and go back to screen sharing. The host knows its own interfaces, so it
 * enumerates them, labels them, and puts them straight into the invite code. Nobody types an address.
 *
 * Several travel together on purpose. A laptop that moves between home and the office changes its LAN
 * address under itself, so the client tries the list and remembers whichever answered (reconnect.ts).
 *
 * ORDER IS NOT COSMETIC — it is the order the client dials, and it is ordered by what actually
 * resolves rather than by what reads nicely:
 *
 *  - An overlay address (Tailscale et al.) is stable per device and routes on the same LAN too, so it
 *    is the single candidate that works in the most situations. First.
 *  - A LAN address is known-reachable at the moment the invite is created. Second.
 *  - NAMES COME AFTER ADDRESSES, which is the opposite of the intuitive ordering. `hostname.local`
 *    only resolves if something on the host ANSWERS mDNS queries, and Windows does not: Windows 10
 *    1703+/11 ship DNS-SD browsing but no mDNS responder, so a Windows host is not reachable as
 *    `HOST.local` unless Bonjour was installed by something else (iTunes, Adobe). DevDeck's cockpit is
 *    win32-only, which makes Windows the COMMON host — so `.local` is a fallback, not the headline.
 *  - The bare hostname is kept because it is what works in the two cases `.local` does not: Windows to
 *    Windows on a home LAN (LLMNR/NetBIOS — deprecated by Microsoft and often disabled by policy, but
 *    still on by default today), and Tailscale MagicDNS, which resolves the bare device name.
 *
 * The practical consequence for the docs: if you want a name that keeps working after the IP changes,
 * an overlay network or a DHCP reservation is the answer — not mDNS.
 */
import type { NetworkInterfaceInfo } from 'node:os';

export type AddressKind =
  /** 100.64.0.0/10. Tailscale hands these out; so does carrier-grade NAT. Stable per device and
   *  reachable from anywhere the overlay reaches — including the same LAN. */
  | 'overlay'
  /** RFC1918 private address. Known-reachable right now, on this network only. */
  | 'lan'
  /** The machine's bare name. Resolves via Tailscale MagicDNS, or Windows-to-Windows LLMNR/NetBIOS. */
  | 'hostname'
  /** `hostname.local`. Needs an mDNS responder ON THE HOST — standard on macOS/Linux, absent on
   *  Windows unless Bonjour is installed. */
  | 'mdns'
  /** A routable address: reachable from the open internet, firewall permitting. */
  | 'public';

export interface AddressCandidate {
  address: string;
  kind: AddressKind;
  /** Interface name (or 'hostname'), so a person can recognize which network this is. */
  via: string;
}

const KIND_ORDER: Record<AddressKind, number> = { overlay: 0, lan: 1, hostname: 2, mdns: 3, public: 4 };

function ipv4Kind(address: string): AddressKind | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b] = parts;
  if (a === 127) return null;                       // loopback: never advertised to another machine
  if (a === 169 && b === 254) return null;          // link-local autoconfig: no DHCP answered, reaches nothing
  if (a === 100 && b >= 64 && b <= 127) return 'overlay';
  if (a === 10) return 'lan';
  if (a === 172 && b >= 16 && b <= 31) return 'lan';
  if (a === 192 && b === 168) return 'lan';
  return 'public';
}

function isIpv4(info: NetworkInterfaceInfo): boolean {
  // Node has reported `family` as both 'IPv4' and 4 across versions; accept either rather than
  // silently advertising nothing on the version that disagrees.
  return info.family === 'IPv4' || (info.family as unknown as number) === 4;
}

/**
 * @param interfaces `os.networkInterfaces()`
 * @param hostname   `os.hostname()`
 */
export function addressCandidates(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  hostname: string,
): AddressCandidate[] {
  const rows: AddressCandidate[] = [];

  for (const [via, list] of Object.entries(interfaces ?? {})) {
    for (const info of list ?? []) {
      if (info.internal || !isIpv4(info)) continue;
      const kind = ipv4Kind(info.address);
      if (kind) rows.push({ address: info.address, kind, via });
    }
  }

  const full = String(hostname ?? '').trim();
  const bare = full.split('.')[0];
  if (full.includes('.')) {
    // Already qualified (a tailnet name, a corporate FQDN): use it as given, and do not invent a
    // `.local` variant of a name that already names a real zone.
    rows.push({ address: full, kind: 'hostname', via: 'hostname' });
  } else if (bare) {
    rows.push({ address: bare, kind: 'hostname', via: 'hostname' });
    rows.push({ address: `${bare}.local`, kind: 'mdns', via: 'hostname' });
  }

  rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.address.localeCompare(b.address));

  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * How many addresses travel in an invite code. Bounded because the code is a string a person pastes,
 * and a machine with a dozen virtual adapters (Docker, WSL, VPN clients) would otherwise fill it with
 * addresses that reach nothing.
 */
export const MAX_ADVERTISED_ADDRESSES = 6;

/**
 * Trim to what fits in an invite, without letting a pile of virtual adapters push the NAMES out.
 * Names are the candidates that still work after the machine's address changes, so at least the
 * host's own name always travels even when the numeric list is long.
 */
export function advertisableAddresses(candidates: readonly AddressCandidate[]): string[] {
  const named = candidates.filter((c) => c.kind === 'hostname' || c.kind === 'mdns');
  const numeric = candidates.filter((c) => c.kind !== 'hostname' && c.kind !== 'mdns');
  const keptNumeric = numeric.slice(0, Math.max(1, MAX_ADVERTISED_ADDRESSES - named.length));
  return candidates
    .filter((c) => named.includes(c) || keptNumeric.includes(c))
    .slice(0, MAX_ADVERTISED_ADDRESSES)
    .map((c) => c.address);
}
