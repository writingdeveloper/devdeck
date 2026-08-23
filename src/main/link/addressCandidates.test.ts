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
