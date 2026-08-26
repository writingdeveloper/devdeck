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
 *  - A GLOBAL IPv6 address is the one candidate that needs no router configuration at all: IPv6 has
 *    no NAT, so there is nothing to forward and nothing to translate — only a firewall to allow. It
 *    is placed after the LAN address rather than before it so that the common case (both machines on
 *    one network, IPv6 inbound blocked by the router as it usually is) does not pay a dial timeout
 *    before reaching the address that was going to work anyway.
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
  /** A global IPv6 address (2000::/3). No NAT in front of it — reachable from any network the
   *  host's firewall allows in, with no port forwarding anywhere. */
  | 'global6'
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

const KIND_ORDER: Record<AddressKind, number> = { overlay: 0, lan: 1, global6: 2, hostname: 3, mdns: 4, public: 5 };

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

/**
 * Tailscale's IPv6 range. It is a ULA prefix like any other, but a well-known one, and an address in
 * it reaches the same places the overlay's IPv4 does — so it is labelled for what it is.
 */
const TAILSCALE_ULA = 'fd7a:115c:a1e0';

function ipv6Kind(address: string): AddressKind | null {
  const a = address.toLowerCase().split('%')[0]; // drop any zone id: it means nothing on the other machine
  if (a === '::1' || a === '::') return null;                       // loopback / unspecified
  if (a.startsWith('fe80:')) return null;                           // link-local: only routable with a zone id
  if (a.startsWith('ff')) return null;                              // multicast
  if (a.startsWith(TAILSCALE_ULA)) return 'overlay';
  // fc00::/7 — unique local. Another machine on the same overlay or site can reach it; the open
  // internet cannot. Same standing as an RFC1918 address, so: same label.
  if (/^f[cd]/.test(a)) return 'lan';
  // 2000::/3 — global unicast. The first hex digit of a global address is 2 or 3.
  if (/^[23]/.test(a)) return 'global6';
  return null;
}

function isIpv6(info: NetworkInterfaceInfo): boolean {
  return info.family === 'IPv6' || (info.family as unknown as number) === 6;
}

function isIpv4(info: NetworkInterfaceInfo): boolean {
  // Node has reported `family` as both 'IPv4' and 4 across versions; accept either rather than
  // silently advertising nothing on the version that disagrees.
  return info.family === 'IPv4' || (info.family as unknown as number) === 4;
}

/**
 * @param interfaces `os.networkInterfaces()`
 * @param hostname   `os.hostname()`
 * @param extra      Addresses this machine holds but cannot see on an interface — specifically the
 *                   public address a router reports after opening a port on our behalf. It belongs
 *                   in the list on the same terms as the rest: sorted by kind, deduplicated, and
 *                   subject to the same budget.
 */
export function addressCandidates(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  hostname: string,
  extra: readonly AddressCandidate[] = [],
): AddressCandidate[] {
  const rows: AddressCandidate[] = [...extra];

  for (const [via, list] of Object.entries(interfaces ?? {})) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      const kind = isIpv4(info) ? ipv4Kind(info.address)
        : isIpv6(info) ? ipv6Kind(info.address)
          : null;
      if (kind) rows.push({ address: info.address.split('%')[0], kind, via });
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

  rows.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    // Within the IPv6 globals, the compact address first. A machine typically holds three: one from
    // DHCPv6 or set by hand (short, and stable), one stable SLAAC address, and one TEMPORARY privacy
    // address that is rotated every day or so. Node reports no flag telling them apart, but the
    // assigned one is the one that compresses to something like `2600:db8::41`, and only two of the
    // three fit in an invite — so length is used as the tiebreak it is: a heuristic, in the direction
    // of the address most likely to still be there tomorrow.
    || (a.kind === 'global6' ? a.address.length - b.address.length : 0)
    || a.address.localeCompare(b.address));

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
  const budget = Math.max(1, MAX_ADVERTISED_ADDRESSES - named.length);
  // One of each KIND before a second of any. A working machine has several LAN addresses — Docker,
  // WSL, Hyper-V and a VPN client each add one — and taking the sorted list in order would spend the
  // whole budget on them before ever reaching the global IPv6, which is the one candidate that is
  // reachable from another network with no router configuration at all.
  const byKind = new Map<AddressKind, AddressCandidate[]>(); // insertion order follows KIND_ORDER: numeric is sorted
  for (const candidate of numeric) {
    const list = byKind.get(candidate.kind) ?? [];
    list.push(candidate);
    byKind.set(candidate.kind, list);
  }
  const kept: AddressCandidate[] = [];
  for (let round = 0; kept.length < budget; round++) {
    let added = false;
    for (const list of byKind.values()) {
      if (kept.length >= budget) break;
      const pick = list[round];
      if (!pick) continue;
      kept.push(pick);
      added = true;
    }
    if (!added) break; // every kind is exhausted
  }
  const keep = new Set<AddressCandidate>([...named, ...kept]);
  return candidates
    .filter((c) => keep.has(c))
    .slice(0, MAX_ADVERTISED_ADDRESSES)
    .map((c) => c.address);
}
