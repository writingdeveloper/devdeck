/**
 * Why one address did not answer.
 *
 * A dial walks every address the host advertises, and most of them are EXPECTED to fail from where
 * the caller is standing: a LAN address is meaningless from another network, a hostname resolves
 * nowhere outside the office, an overlay address needs the same overlay at both ends. Reporting the
 * whole list as "nothing answered" therefore says almost nothing — the one address that could have
 * worked is buried among five that never could, with no way to tell which was which.
 *
 * The distinction that matters is between "this network cannot even route to that address" and "the
 * route exists and something along it stayed silent". The first is the caller's own connectivity —
 * most often no IPv6 at all, which no amount of configuration on the far end will fix. The second
 * points at the far end's router or firewall. They are indistinguishable in a flat list and obvious
 * once separated, which is the whole reason this exists.
 */
export type DialReason =
  /** Nothing on this machine's routing table leads there — commonly: this network has no IPv6. */
  | 'no-route'
  /** Something answered and said no. A host that is up with nothing listening on the port. */
  | 'refused'
  /** The route exists and the packets vanished — the far side's firewall, or the machine is asleep. */
  | 'timed-out'
  /** The name resolved to nothing. Expected for a hostname or an mDNS name from another network. */
  | 'unknown-name'
  /** Reached, but the two ends could not agree on TLS. */
  | 'tls'
  | 'other';

export interface DialAttempt { address: string; reason: DialReason }

/** Classify a socket error. Node reports the useful part in `code`; the message is for humans. */
export function dialReasonFor(code: string | undefined, message = ''): DialReason {
  switch (code) {
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'no-route';
    case 'ECONNREFUSED':
      return 'refused';
    case 'ETIMEDOUT':
      return 'timed-out';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'unknown-name';
    default:
      return message.includes('timed out') ? 'timed-out' : 'other';
  }
}

/** An IPv6 literal — `[` and `]` are never present in the addresses this app advertises. */
export function isIpv6Literal(address: string): boolean {
  return address.includes(':') && !address.includes('/');
}

/**
 * The one sentence worth putting under the list.
 *
 * Chosen from the attempts rather than written per case at the call site, because the answer depends
 * on which KIND of address failed and how — and that reasoning belongs in one place with the
 * classification it reads.
 */
export type DialAdvice =
  /** Every address that could work from outside a LAN is IPv6, and this machine has no IPv6 route. */
  | 'no-ipv6-here'
  /** An IPv6 address is routable from here and the packets went nowhere — the far side is blocking. */
  | 'far-side-blocking'
  /** Only LAN-shaped addresses were on offer: this is a different network, and that is all it means. */
  | 'same-network-only'
  | null;

export function adviseFromAttempts(attempts: readonly DialAttempt[]): DialAdvice {
  const routable = attempts.filter((a) => isIpv6Literal(a.address));
  if (routable.length === 0) return attempts.length ? 'same-network-only' : null;
  // A single routable address that this machine cannot even reach says the problem is local, and
  // says it regardless of what the unroutable ones did.
  if (routable.every((a) => a.reason === 'no-route')) return 'no-ipv6-here';
  if (routable.some((a) => a.reason === 'timed-out')) return 'far-side-blocking';
  return null;
}
