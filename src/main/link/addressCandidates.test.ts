import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { addressCandidates, advertisableAddresses, MAX_ADVERTISED_ADDRESSES } from './addressCandidates';

const ip = (address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({
  address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00',
  internal: false, cidr: `${address}/24`, ...extra,
} as NetworkInterfaceInfo);

describe('addressCandidates', () => {
  it('dials real addresses before names, because Windows answers no mDNS', () => {
    // Measured on the developer's own machine: 100.96.248.54 via Tailscale, 192.168.1.69 via Ethernet.
    // The intuitive ordering (name first, "it survives a DHCP change") is wrong here: DevDeck's
    // cockpit is win32-only, so the host is usually Windows, and Windows ships no mDNS responder —
    // HOST.local reaches it only if Bonjour happens to be installed. Names are the fallback.
    const out = addressCandidates({ Tailscale: [ip('100.96.248.54')], Ethernet: [ip('192.168.1.69')] }, 'SIHYEONG-MAIN');
    expect(out.map((c) => [c.address, c.kind])).toEqual([
      ['100.96.248.54', 'overlay'],
      ['192.168.1.69', 'lan'],
      ['SIHYEONG-MAIN', 'hostname'],
      ['SIHYEONG-MAIN.local', 'mdns'],
    ]);
  });

  it('keeps the bare hostname, which is what works where .local does not', () => {
    // Two cases the .local name misses: Tailscale MagicDNS (resolves the bare device name) and
    // Windows-to-Windows LLMNR/NetBIOS on a home LAN.
    const out = addressCandidates({}, 'SIHYEONG-MAIN');
    expect(out.map((c) => c.address)).toEqual(['SIHYEONG-MAIN', 'SIHYEONG-MAIN.local']);
  });

  it('uses an already-qualified hostname as given, without inventing a .local variant', () => {
    const out = addressCandidates({}, 'desktop.tailnet-abcd.ts.net');
    expect(out.map((c) => [c.address, c.kind])).toEqual([['desktop.tailnet-abcd.ts.net', 'hostname']]);
  });

  it('recognizes every private range, not just 192.168', () => {
    const out = addressCandidates({ a: [ip('10.1.2.3')], b: [ip('172.20.0.5')], c: [ip('192.168.0.2')] }, '');
    expect(out.every((c) => c.kind === 'lan')).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('labels a routable address as public rather than hiding it, and dials it last', () => {
    // Advertising it is the user's choice; mislabeling it as ordinary LAN would hide what it means.
    const out = addressCandidates({ wan: [ip('203.0.113.7')], lan: [ip('192.168.1.5')] }, '');
    expect(out.map((c) => c.kind)).toEqual(['lan', 'public']);
  });

  it('drops loopback, link-local autoconfig, internal interfaces and IPv6', () => {
    const out = addressCandidates({
      Loopback: [ip('127.0.0.1', { internal: true })],
      Stale: [ip('169.254.10.1')],          // no DHCP answered — reaches nothing
      Docker: [ip('127.0.0.2')],
      v6: [ip('fe80::1', { family: 'IPv6' } as Partial<NetworkInterfaceInfo>)],
    }, '');
    expect(out).toEqual([]);
  });

  it('accepts the numeric family Node reports on some versions', () => {
    // Node has reported `family` as both 'IPv4' and 4; a strict string check silently advertises
    // nothing on the version that disagrees.
    const out = addressCandidates({ eth: [ip('192.168.5.5', { family: 4 as unknown as 'IPv4' })] }, '');
    expect(out.map((c) => c.address)).toEqual(['192.168.5.5']);
  });

  it('deduplicates an address exposed by two interfaces', () => {
    const out = addressCandidates({ a: [ip('192.168.1.4')], b: [ip('192.168.1.4')] }, '');
    expect(out).toHaveLength(1);
  });

  it('survives an empty or missing interface table', () => {
    expect(addressCandidates({}, '')).toEqual([]);
    expect(addressCandidates({ empty: undefined }, '')).toEqual([]);
  });
});

describe('advertisableAddresses', () => {
  it('caps the list so virtual adapters cannot bloat a pasted code', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`veth${i}`, [ip(`10.0.${i}.1`)]]),
    );
    expect(advertisableAddresses(addressCandidates(many, 'host'))).toHaveLength(MAX_ADVERTISED_ADDRESSES);
  });

  it('never lets a pile of virtual adapters push the names out', () => {
    // Docker/WSL/VPN adapters reach nothing from another machine, but the host's NAME is what still
    // works after its address changes — losing that to a truncation would strand the pairing.
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`veth${i}`, [ip(`10.0.${i}.1`)]]),
    );
    const out = advertisableAddresses(addressCandidates(many, 'host'));
    expect(out).toContain('host');
    expect(out).toContain('host.local');
  });

  it('keeps at least one real address even when names fill the budget', () => {
    const out = advertisableAddresses(addressCandidates({ Tailscale: [ip('100.64.0.9')] }, 'host'));
    expect(out[0]).toBe('100.64.0.9');
  });
});

// ---- IPv6 ----

const ip6 = (address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({
  address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00',
  internal: false, cidr: `${address}/64`, scopeid: 0, ...extra,
} as NetworkInterfaceInfo);

describe('addressCandidates, IPv6', () => {
  it('advertises a global address — the one candidate needing no router configuration', () => {
    // Measured on the developer's machine: AT&T hands out a real /64, so there is no NAT in front of
    // this address at all. Nothing to forward; only a firewall to allow.
    const out = addressCandidates({ Ethernet: [ip('192.168.1.69'), ip6('2600:1700:1420:6a10::41')] }, '');
    expect(out.map((c) => [c.address, c.kind])).toEqual([
      ['192.168.1.69', 'lan'],
      ['2600:1700:1420:6a10::41', 'global6'],
    ]);
  });

  it('dials the LAN address first, so the common case pays no timeout for a blocked IPv6', () => {
    const out = addressCandidates({ e: [ip6('2600:db8::41'), ip('192.168.1.69')] }, 'HOST');
    expect(out.map((c) => c.kind)).toEqual(['lan', 'global6', 'hostname', 'mdns']);
  });

  it('drops the addresses that mean nothing on another machine', () => {
    const out = addressCandidates({
      e: [ip6('fe80::1c4f:2a1b:9d3e:5f70'), ip6('::1'), ip6('ff02::1')],
    }, '');
    expect(out).toEqual([]);
  });

  it('reads a Tailscale ULA as the overlay it is, and any other ULA as a LAN address', () => {
    const out = addressCandidates({ ts: [ip6('fd7a:115c:a1e0::8c3a:f837')], z: [ip6('fd00:1234::5')] }, '');
    expect(out.map((c) => c.kind)).toEqual(['overlay', 'lan']);
  });

  it('strips a zone id, which names an interface on THIS machine and nothing on the other one', () => {
    const out = addressCandidates({ e: [ip6('2600:db8::41%12')] }, '');
    expect(out.map((c) => c.address)).toEqual(['2600:db8::41']);
  });

  it('puts the assigned global address ahead of the rotating privacy one', () => {
    // A machine holds three globals: one assigned (short, stable), one stable SLAAC, and one
    // temporary address the OS rotates. Only two fit in an invite, and nothing in Node says which is
    // which — so the compact one, which is the assigned one, goes first.
    const out = addressCandidates({
      e: [
        ip6('2600:1700:1420:6a10:4c24:8866:9f88:c7cb'),
        ip6('2600:1700:1420:6a10:ca9d:b6b3:4793:6229'),
        ip6('2600:1700:1420:6a10::41'),
      ],
    }, '');
    expect(out[0].address).toBe('2600:1700:1420:6a10::41');
  });
});

describe('advertisableAddresses with several kinds', () => {
  it('keeps the global IPv6 even when virtual adapters fill the LAN slots', () => {
    // Docker, WSL and Hyper-V each add a LAN address. Taking the sorted list in order spent the whole
    // budget on them and dropped the only address reachable from another network.
    const out = advertisableAddresses(addressCandidates({
      Docker: [ip('172.17.0.1')],
      WSL: [ip('172.20.16.1')],
      HyperV: [ip('192.168.56.1')],
      Ethernet: [ip('192.168.1.69'), ip6('2600:db8::41')],
      Tailscale: [ip('100.96.248.54')],
    }, 'HOST'));
    expect(out).toContain('2600:db8::41');
    expect(out).toContain('100.96.248.54');
    expect(out).toContain('HOST');
    expect(out.length).toBeLessThanOrEqual(MAX_ADVERTISED_ADDRESSES);
  });

  it('still spends the whole budget when there is only one kind to spend it on', () => {
    const out = advertisableAddresses(addressCandidates({
      a: [ip('192.168.1.2')], b: [ip('192.168.2.2')], c: [ip('192.168.3.2')], d: [ip('192.168.4.2')],
    }, ''));
    expect(out).toHaveLength(4);
  });
});

describe('an address the router reported on our behalf', () => {
  it('travels in the invite even when the machine is full of virtual adapters', () => {
    // The public address is not on any interface here — the ROUTER holds it, and hands it over after
    // opening a port. It is the only candidate that reaches this machine from another network, so a
    // pile of Docker/WSL addresses must not push it out of the invite.
    const candidates = addressCandidates(
      { Docker: [ip('172.17.0.1')], WSL: [ip('172.20.16.1')], HyperV: [ip('192.168.56.1')], Ethernet: [ip('192.168.1.69')] },
      'HOST',
      [{ address: '203.0.113.7', kind: 'public', via: 'nat-pmp' }],
    );
    expect(candidates.find((c) => c.address === '203.0.113.7')?.kind).toBe('public');
    // Dialed last: the addresses before it are the ones that work from THIS network, and trying the
    // router's own public address from inside the LAN is the one that commonly hairpins or hangs.
    expect(candidates[candidates.length - 1].address).toBe('203.0.113.7');
    expect(advertisableAddresses(candidates)).toContain('203.0.113.7');
  });

  it('is deduplicated against an interface that already carries it', () => {
    const candidates = addressCandidates(
      { Ethernet: [ip('203.0.113.7')] },
      '',
      [{ address: '203.0.113.7', kind: 'public', via: 'nat-pmp' }],
    );
    expect(candidates.filter((c) => c.address === '203.0.113.7')).toHaveLength(1);
  });
});
