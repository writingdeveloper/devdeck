import { describe, it, expect } from 'vitest';
import {
  sanitizePairedDevices, sanitizeKnownHosts, findPairedDevice,
  upsertPairedDevice, removePairedDevice, upsertKnownHost, removeKnownHost,
  dialOrder, noteHostReached, type PairedDevice, type KnownHost,
} from './devices';

const FP_A = ('AB'.repeat(32).match(/../g) ?? []).join(':');
const FP_B = ('CD'.repeat(32).match(/../g) ?? []).join(':');
const ID_A = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const ID_B = '11111111-2222-4333-8444-555555555555';

const device = (over: Partial<PairedDevice> = {}): PairedDevice => ({
  machineId: ID_A, machineName: 'laptop', fingerprint: FP_A,
  permissions: ['observe', 'control'], pairedAtMs: 1000, lastSeenMs: null, ...over,
});

const host = (over: Partial<KnownHost> = {}): KnownHost => ({
  machineId: ID_A, machineName: 'SIHYEONG-MAIN', fingerprint: FP_A,
  addresses: ['100.96.248.54', '192.168.1.69', 'SIHYEONG-MAIN'],
  port: 47820, lastAddress: null, lastSeenMs: null, ...over,
});

describe('sanitizePairedDevices', () => {
  it('keeps a well-formed device', () => {
    expect(sanitizePairedDevices([device()])).toEqual([device()]);
  });

  it('drops an entry with no usable fingerprint — it could never authenticate anyone', () => {
    // Keeping it would put a row in the permission UI that grants access to nobody.
    for (const fingerprint of ['', 'AB:CD', FP_A.slice(0, -3), null, 42]) {
      expect(sanitizePairedDevices([{ ...device(), fingerprint }]), String(fingerprint)).toEqual([]);
    }
  });

  it('degrades a corrupted permission list to nothing, never to the defaults', () => {
    // Silently restoring a working set would re-grant access the person never approved.
    expect(sanitizePairedDevices([{ ...device(), permissions: 'all' }])[0].permissions).toEqual([]);
    expect(sanitizePairedDevices([{ ...device(), permissions: ['observe', 'root', 7] }])[0].permissions).toEqual(['observe']);
  });

  it('deduplicates by fingerprint and survives junk input', () => {
    expect(sanitizePairedDevices([device(), device()])).toHaveLength(1);
    expect(sanitizePairedDevices(null)).toEqual([]);
    expect(sanitizePairedDevices(['x', null, {}])).toEqual([]);
  });
});

describe('sanitizeKnownHosts', () => {
  it('keeps hostnames intact rather than scrubbing characters out of them', () => {
    // Deleting the hyphen would leave `SIHYEONGMAIN`, which resolves to nothing — and would then be
    // reported to the user as the address that failed.
    const out = sanitizeKnownHosts([host()], 47820);
    expect(out[0].addresses).toEqual(['100.96.248.54', '192.168.1.69', 'SIHYEONG-MAIN']);
  });

  it('rejects an address that is not one, instead of repairing it', () => {
    const out = sanitizeKnownHosts([{ ...host(), addresses: ['ok.example', 'bad host', 'evil;rm -rf', 'a\nb', ''] }], 47820);
    expect(out[0].addresses).toEqual(['ok.example']);
  });

  it('drops a host with no fingerprint — connecting without a pin is the thing this prevents', () => {
    expect(sanitizeKnownHosts([{ ...host(), fingerprint: '' }], 47820)).toEqual([]);
  });

  it('drops a host with nowhere to dial', () => {
    expect(sanitizeKnownHosts([{ ...host(), addresses: [] }], 47820)).toEqual([]);
  });

  it('falls back to the default port for an impossible one', () => {
    expect(sanitizeKnownHosts([{ ...host(), port: 0 }], 47820)[0].port).toBe(47820);
    expect(sanitizeKnownHosts([{ ...host(), port: 99999 }], 47820)[0].port).toBe(47820);
    expect(sanitizeKnownHosts([{ ...host(), port: 1234 }], 47820)[0].port).toBe(1234);
  });
});

describe('findPairedDevice', () => {
  it('identifies by fingerprint, in whatever format the peer reported it', () => {
    const devices = [device(), device({ machineId: ID_B, fingerprint: FP_B })];
    expect(findPairedDevice(devices, FP_B.toLowerCase().replace(/:/g, ''))?.machineId).toBe(ID_B);
  });

  it('never matches an absent fingerprint', () => {
    // A peer that presented no certificate reports undefined; matching that would authenticate anyone.
    expect(findPairedDevice([device()], undefined)).toBeNull();
    expect(findPairedDevice([device()], '')).toBeNull();
  });
});

describe('upsertPairedDevice', () => {
  it('replaces a re-paired device\'s permissions rather than merging them', () => {
    // Pairing shows a permission set and the person approves THAT set. Keeping an old permission that
    // is no longer on screen would grant access nobody agreed to.
    const before = [device({ permissions: ['observe', 'control', 'spawn', 'power'] })];
    const after = upsertPairedDevice(before, device({ permissions: ['observe'] }));
    expect(after).toHaveLength(1);
    expect(after[0].permissions).toEqual(['observe']);
  });

  it('adds a second device and removes by fingerprint', () => {
    const two = upsertPairedDevice([device()], device({ machineId: ID_B, fingerprint: FP_B }));
    expect(two).toHaveLength(2);
    expect(removePairedDevice(two, FP_A.toLowerCase())).toHaveLength(1);
  });
});

describe('known host bookkeeping', () => {
  it('replaces an entry for the same machine and removes by id', () => {
    const one = upsertKnownHost([host()], host({ machineName: 'renamed' }));
    expect(one).toHaveLength(1);
    expect(one[0].machineName).toBe('renamed');
    expect(removeKnownHost(one, ID_A)).toEqual([]);
  });
});

describe('dialOrder', () => {
  it('tries the address that worked last time first', () => {
    // The whole reconnect strategy: yesterday's address is almost always today's.
    expect(dialOrder({ addresses: ['a', 'b', 'c'], lastAddress: 'c' })).toEqual(['c', 'a', 'b']);
  });

  it('keeps the host\'s own order when nothing has worked yet', () => {
    expect(dialOrder({ addresses: ['a', 'b'], lastAddress: null })).toEqual(['a', 'b']);
  });

  it('does not list the last-good address twice', () => {
    expect(dialOrder({ addresses: ['a', 'b'], lastAddress: 'A' })).toEqual(['A', 'b']);
  });
});

describe('noteHostReached', () => {
  it('remembers the address that answered and adopts the host\'s refreshed list', () => {
    // This is what keeps a pairing alive across a move: the host re-enumerates its interfaces on every
    // connect, so the address that still worked teaches the client the new ones.
    const moved = noteHostReached(host(), {
      address: '100.96.248.54',
      addresses: ['100.96.248.54', '10.0.5.22', 'SIHYEONG-MAIN'],
      port: 47820, nowMs: 5_000,
    });
    expect(moved.lastAddress).toBe('100.96.248.54');
    expect(moved.addresses).toContain('10.0.5.22'); // learned the office address
    expect(moved.lastSeenMs).toBe(5_000);
    expect(dialOrder(moved)[0]).toBe('100.96.248.54');
  });

  it('keeps the address that actually worked even if the host stopped advertising it', () => {
    // A tunnel endpoint (ssh -L to 127.0.0.1) is never in the host's own interface list, but it is the
    // one piece of evidence that beats the host's opinion about how to reach itself.
    const viaTunnel = noteHostReached(host(), {
      address: '127.0.0.1', addresses: ['192.168.1.69'], nowMs: 1,
    });
    expect(viaTunnel.addresses[0]).toBe('127.0.0.1');
    expect(dialOrder(viaTunnel)[0]).toBe('127.0.0.1');
  });

  it('adopts a renamed host but ignores an empty name', () => {
    expect(noteHostReached(host(), { address: 'x.example', machineName: 'Studio', nowMs: 1 }).machineName).toBe('Studio');
    expect(noteHostReached(host(), { address: 'x.example', machineName: '', nowMs: 1 }).machineName).toBe('SIHYEONG-MAIN');
  });
});
