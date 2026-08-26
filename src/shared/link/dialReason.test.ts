import { describe, it, expect } from 'vitest';
import { adviseFromAttempts, dialReasonFor, isIpv6Literal, type DialAttempt } from './dialReason';

describe('dialReasonFor', () => {
  it('separates "this network cannot route there" from "the route exists and nothing answered"', () => {
    // The distinction the whole feature turns on. The first is the caller's own connectivity and no
    // setting on the far machine can fix it; the second points squarely at the far machine's router.
    expect(dialReasonFor('ENETUNREACH')).toBe('no-route');
    expect(dialReasonFor('EHOSTUNREACH')).toBe('no-route');
    expect(dialReasonFor('ETIMEDOUT')).toBe('timed-out');
  });

  it('reads a refusal as an answer, not a miss', () => {
    // Something IS there and said no — a machine that is up with nothing listening on the port.
    expect(dialReasonFor('ECONNREFUSED')).toBe('refused');
  });

  it('names a resolution failure as such, which is expected for a hostname from another network', () => {
    expect(dialReasonFor('ENOTFOUND')).toBe('unknown-name');
    expect(dialReasonFor('EAI_AGAIN')).toBe('unknown-name');
  });

  it('falls back on the message when there is no code, and to "other" when there is nothing', () => {
    // Our own connect deadline arrives as a plain Error with no code.
    expect(dialReasonFor(undefined, 'timed out')).toBe('timed-out');
    expect(dialReasonFor(undefined, '')).toBe('other');
    expect(dialReasonFor('EPIPE')).toBe('other');
  });
});

describe('isIpv6Literal', () => {
  it('recognises the only address kind that reaches a machine from another network', () => {
    expect(isIpv6Literal('2600:1700:1420:6a10::41')).toBe(true);
    expect(isIpv6Literal('fd7a:115c:a1e0::8c3a:f837')).toBe(true);
    expect(isIpv6Literal('192.168.1.69')).toBe(false);
    expect(isIpv6Literal('SIHYEONG-MAIN.local')).toBe(false);
  });
});

describe('adviseFromAttempts', () => {
  // The real failure this was written for: six addresses tried from another network, five of which
  // could never have worked from there, reported as one flat "nothing answered".
  const realWorld = (ipv6Reason: DialAttempt['reason']): DialAttempt[] => [
    { address: '100.96.248.54', reason: 'timed-out' },        // overlay — needs Tailscale at both ends
    { address: 'fd7a:115c:a1e0::8c3a:f837', reason: 'no-route' }, // overlay, same
    { address: '192.168.1.69', reason: 'no-route' },          // LAN — meaningless from outside
    { address: '2600:1700:1420:6a10::41', reason: ipv6Reason }, // the ONLY one that could work
    { address: 'SIHYEONG-MAIN', reason: 'unknown-name' },
    { address: 'SIHYEONG-MAIN.local', reason: 'unknown-name' },
  ];

  it('blames the caller\'s own network when nothing routable can even be routed to', () => {
    // No IPv6 here at all. Telling this person to open a port on the far router would send them
    // after a setting that cannot help.
    expect(adviseFromAttempts(realWorld('no-route'))).toBe('no-ipv6-here');
  });

  it('blames the far side when the route exists and the packets vanished', () => {
    expect(adviseFromAttempts(realWorld('timed-out'))).toBe('far-side-blocking');
  });

  it('says nothing when the routable address gave a definite answer', () => {
    // A refusal means the machine is reachable and something else is wrong; guessing would mislead.
    expect(adviseFromAttempts(realWorld('refused'))).toBeNull();
  });

  it('says the addresses were LAN-only when none of them could ever leave the network', () => {
    expect(adviseFromAttempts([
      { address: '192.168.1.69', reason: 'no-route' },
      { address: 'OFFICE-PC', reason: 'unknown-name' },
    ])).toBe('same-network-only');
    expect(adviseFromAttempts([])).toBeNull();
  });
});
