import { describe, it, expect } from 'vitest';
import {
  LOCAL_MACHINE_ID, isValidMachineId, toMachineId, isLocalMachine,
  sanitizeMachineName, machineScopedKey, parseMachineScopedKey,
  qualifyRemoteId, isRemoteId, parseRemoteId,
} from './machine';

const UUID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('machine ids', () => {
  it('accepts a generated uuid and the reserved local id', () => {
    expect(isValidMachineId(UUID)).toBe(true);
    expect(isValidMachineId(LOCAL_MACHINE_ID)).toBe(true);
  });

  it('rejects anything else, so a malformed id cannot address a machine', () => {
    for (const bad of ['', 'desktop', '../../etc', UUID + 'x', null, 42, {}]) {
      expect(isValidMachineId(bad), String(bad)).toBe(false);
    }
  });

  it('falls back to the viewer itself rather than to an arbitrary machine', () => {
    // An unreadable id in persisted state must mean "this machine", never "some machine": resolving it
    // to a remote would send a project path to a host that has a different project at that path.
    expect(toMachineId(undefined)).toBe(LOCAL_MACHINE_ID);
    expect(toMachineId('garbage')).toBe(LOCAL_MACHINE_ID);
    expect(toMachineId(UUID)).toBe(UUID);
    expect(isLocalMachine(undefined)).toBe(true);
    expect(isLocalMachine(UUID)).toBe(false);
  });
});

describe('sanitizeMachineName', () => {
  it('keeps an ordinary hostname', () => {
    expect(sanitizeMachineName('SIHYEONG-MAIN', 'DevDeck')).toBe('SIHYEONG-MAIN');
  });

  it('falls back when the name is empty or not a string', () => {
    expect(sanitizeMachineName('   ', 'desktop')).toBe('desktop');
    expect(sanitizeMachineName(null, 'desktop')).toBe('desktop');
    expect(sanitizeMachineName('', '')).toBe('DevDeck');
  });

  it('strips control characters — a paired name is drawn in the sidebar, not just stored', () => {
    expect(sanitizeMachineName('lap\ntop\u001b[31m', 'x')).toBe('lap top [31m');
    expect(sanitizeMachineName('a\u0000b', 'x')).toBe('a b');
  });

  it('caps the length so one machine cannot push the others off the row', () => {
    expect(sanitizeMachineName('x'.repeat(200), 'y')).toHaveLength(40);
  });

  it('trims a long generated hostname from the middle, keeping what distinguishes it', () => {
    // A real macOS CI runner. Machines like these share a prefix and differ only in the trailing id,
    // so cutting the tail would make two of them display identically — and this label is what tells
    // you which terminal you are about to type into.
    const a = 'sat12-bq154-ac99a524-1123-4271-b1f4-a8122e02bd5b-5691A934C60D.local';
    const b = 'sat12-bq154-ac99a524-1123-4271-b1f4-a8122e02bd5b-0000DEADBEEF.local';
    expect(sanitizeMachineName(a, 'x')).toHaveLength(40);
    expect(sanitizeMachineName(a, 'x')).not.toBe(sanitizeMachineName(b, 'x'));
    expect(sanitizeMachineName(a, 'x')).toContain('…');
    // The end of the name survives — that is the half that differs between two managed machines.
    expect(sanitizeMachineName(a, 'x').endsWith(a.slice(-12))).toBe(true);
    expect(sanitizeMachineName(b, 'x').endsWith(b.slice(-12))).toBe(true);
  });
});

describe('machineScopedKey', () => {
  it('leaves local keys byte-identical to the bare path', () => {
    // Existing persisted state and the deck's reconcile signatures are keyed by path today; a local
    // deck must not see a single changed key just because machine scoping now exists.
    expect(machineScopedKey(LOCAL_MACHINE_ID, 'C:\\repo')).toBe('C:\\repo');
    expect(machineScopedKey(undefined, 'C:\\repo')).toBe('C:\\repo');
  });

  it('separates the same path on two different machines', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    expect(machineScopedKey(UUID, 'C:\\repo')).not.toBe(machineScopedKey(other, 'C:\\repo'));
    expect(machineScopedKey(UUID, 'C:\\repo')).not.toBe('C:\\repo');
  });

  it('round-trips', () => {
    expect(parseMachineScopedKey(machineScopedKey(UUID, 'C:\\a b\\c'))).toEqual({ machineId: UUID, path: 'C:\\a b\\c' });
    expect(parseMachineScopedKey('C:\\plain')).toEqual({ machineId: LOCAL_MACHINE_ID, path: 'C:\\plain' });
  });
});

describe('qualified remote ids', () => {
  it('round-trips a host-minted id, colons and backslashes included', () => {
    // A host's pty id embeds a Windows path, so it contains both. The machine id is a fixed-length
    // UUID, which is what keeps the split point unambiguous.
    const hostId = 'C:\\Users\\me\\GitHub\\devdeck#7';
    const qualified = qualifyRemoteId(UUID, hostId);
    expect(isRemoteId(qualified)).toBe(true);
    expect(parseRemoteId(qualified)).toEqual({ machineId: UUID, hostId });
  });

  it('passes a local id through unchanged, so callers need not ask which kind it is', () => {
    for (const id of ['C:\\repo#1', '/home/me/repo#2', 'usage-login:claude:3', '']) {
      expect(parseRemoteId(id), id).toEqual({ machineId: LOCAL_MACHINE_ID, hostId: id });
      expect(isRemoteId(id), id).toBe(false);
    }
  });

  it('treats a malformed qualified id as local rather than inventing a machine', () => {
    // Routing a call to a machine that does not exist is worse than running it here and failing
    // visibly — and a forged prefix must not become a way to name an arbitrary machine.
    for (const id of ['link:', 'link:not-a-uuid:x', `link:${UUID}`, `link:${UUID}x:y`, 'link:local:x']) {
      expect(parseRemoteId(id).machineId, id).toBe(LOCAL_MACHINE_ID);
    }
  });
});
