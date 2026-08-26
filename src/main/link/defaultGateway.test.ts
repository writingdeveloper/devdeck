import { describe, it, expect } from 'vitest';
import { defaultGateway, localAddressFor, parseIpRoute, parseNetstatRoute, parseWindowsRouteTable } from './defaultGateway';

// Captured verbatim from the developer's own machine, headings and all. The headings arrive in the
// system language — Korean here — which is exactly why the parser reads rows by shape.
const WINDOWS_KO = `===========================================================================
IPv4 경로 테이블
===========================================================================
활성 경로:
네트워크 대상      네트워크 마스크     게이트웨이      인터페이스    메트릭
          0.0.0.0          0.0.0.0    192.168.1.254     192.168.1.69     20
    100.90.120.31  255.255.255.255             온-링크     100.96.248.54      5
        127.0.0.0        255.0.0.0             온-링크         127.0.0.1    331
      192.168.1.0    255.255.255.0             온-링크      192.168.1.69    276
===========================================================================`;

describe('parseWindowsRouteTable', () => {
  it('reads the default route out of a table printed in another language', () => {
    expect(parseWindowsRouteTable(WINDOWS_KO)).toBe('192.168.1.254');
  });

  it('takes the lowest metric when several interfaces offer a default route', () => {
    // A laptop on Wi-Fi and Ethernet at once, or with a VPN client up, has more than one.
    const table = [
      '          0.0.0.0          0.0.0.0      10.8.0.1        10.8.0.66      5',
      '          0.0.0.0          0.0.0.0 192.168.1.254     192.168.1.69     20',
    ].join('\n');
    expect(parseWindowsRouteTable(table)).toBe('10.8.0.1');
  });

  it('skips an on-link default route, whose third column is a word and not an address', () => {
    expect(parseWindowsRouteTable('          0.0.0.0          0.0.0.0             온-링크     192.168.1.69    276')).toBeNull();
    expect(parseWindowsRouteTable('          0.0.0.0          0.0.0.0             On-link      192.168.1.69    276')).toBeNull();
  });

  it('answers null on a table with no default route at all', () => {
    expect(parseWindowsRouteTable('      192.168.1.0    255.255.255.0   On-link   192.168.1.69   276')).toBeNull();
    expect(parseWindowsRouteTable('')).toBeNull();
  });

  it('rejects a row that only looks like an address', () => {
    expect(parseWindowsRouteTable('0.0.0.0 0.0.0.0 192.168.1.999 192.168.1.69 20')).toBeNull();
    expect(parseWindowsRouteTable('0.0.0.0 0.0.0.0 192.168.1 192.168.1.69 20')).toBeNull();
  });
});

describe('parseIpRoute', () => {
  it('reads the gateway out of iproute2 output', () => {
    expect(parseIpRoute('default via 192.168.1.254 dev eth0 proto dhcp src 192.168.1.69 metric 100')).toBe('192.168.1.254');
  });

  it('ignores a default route with no gateway, which reaches no router to ask', () => {
    expect(parseIpRoute('default dev tun0 scope link')).toBeNull();
    expect(parseIpRoute('')).toBeNull();
  });
});

describe('parseNetstatRoute', () => {
  it('reads the gateway out of BSD/macOS output', () => {
    const table = [
      'Routing tables', '', 'Internet:',
      'Destination        Gateway            Flags        Netif Expire',
      'default            192.168.1.254      UGScg          en0',
      '127                127.0.0.1          UCS            lo0',
    ].join('\n');
    expect(parseNetstatRoute(table)).toBe('192.168.1.254');
  });

  it('ignores a default route pointing at an interface rather than an address', () => {
    expect(parseNetstatRoute('default            utun4              UGScI         utun4')).toBeNull();
  });
});

describe('defaultGateway on this machine', () => {
  it('finds a gateway, or says so plainly', async () => {
    // Not asserted to any particular value — this runs on CI runners too. What matters is that it
    // answers with an address or with null, and never throws or hangs.
    const gateway = await defaultGateway();
    expect(gateway === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)).toBe(true);
  });

  it('answers null for a platform whose command is not there', async () => {
    expect(await defaultGateway('plan9', 1000)).toBeNull();
  });
});

describe('localAddressFor', () => {
  it('asks the OS which of this machine\'s addresses reaches a given target', async () => {
    // Loopback is the one target whose answer is knowable everywhere this runs.
    expect(await localAddressFor('127.0.0.1')).toBe('127.0.0.1');
  });

  it('answers null rather than throwing when handed something that is not a target', async () => {
    expect(await localAddressFor('not-an-address', 500)).toBeNull();
  });
});
