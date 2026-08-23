import { describe, it, expect } from 'vitest';
import { allow, blocked, localOnly, makeMethodTable, mayCallRemotely, remotableMethods } from './methods';

describe('makeMethodTable', () => {
  it('records the invoke/send distinction, which the link layer needs to know whether to await a reply', () => {
    const { invoke, send, table } = makeMethodTable();
    invoke('a:read', allow('observe'), () => 1);
    send('a:fire', allow('control'), () => undefined);
    expect(table['a:read'].channel).toBe('invoke');
    expect(table['a:fire'].channel).toBe('send');
  });

  it('refuses a duplicate name instead of shadowing the first handler', () => {
    const { invoke, table } = makeMethodTable();
    invoke('a:read', allow('observe'), () => 1);
    // A silent overwrite could also DOWNGRADE the policy — the second registration's `allow` would
    // replace a `blocked`. Startup must fail loudly rather than ship a quietly widened surface.
    expect(() => invoke('a:read', blocked('nope'), () => 2)).toThrow(/duplicate method 'a:read'/);
    expect(table['a:read'].remote).toEqual(allow('observe'));
  });
});

describe('mayCallRemotely', () => {
  const { invoke, table } = makeMethodTable();
  invoke('deck:read', allow('observe'), () => null);
  invoke('deck:type', allow('control'), () => null);
  invoke('deck:power', allow('power'), () => null);
  invoke('win:close', localOnly, () => null);
  invoke('settings:addFolder', blocked('picker invariant'), () => null);

  it('admits an allowed method when the device holds its permission', () => {
    expect(mayCallRemotely(table['deck:read'], ['observe'])).toBe(true);
    expect(mayCallRemotely(table['deck:type'], ['observe', 'control'])).toBe(true);
  });

  it('refuses an allowed method when the device lacks that permission', () => {
    expect(mayCallRemotely(table['deck:type'], ['observe'])).toBe(false);
    // 'power' is off by default: observing a machine must never imply being able to shut it down.
    expect(mayCallRemotely(table['deck:power'], ['observe', 'control', 'spawn', 'write'])).toBe(false);
  });

  it('refuses local-only and blocked methods no matter what the device holds', () => {
    const everything = ['observe', 'control', 'spawn', 'write', 'power'] as const;
    expect(mayCallRemotely(table['win:close'], everything)).toBe(false);
    expect(mayCallRemotely(table['settings:addFolder'], everything)).toBe(false);
  });

  it('refuses a method name that does not exist — an unknown name is not an open door', () => {
    expect(mayCallRemotely(table['nope:missing'], ['observe', 'control'])).toBe(false);
  });
});

describe('remotableMethods', () => {
  it('lists only the allowed names, sorted, for the pairing UI to show', () => {
    const { invoke, table } = makeMethodTable();
    invoke('z:read', allow('observe'), () => null);
    invoke('a:read', allow('observe'), () => null);
    invoke('win:close', localOnly, () => null);
    invoke('settings:pickFolder', blocked('native dialog'), () => null);
    expect(remotableMethods(table)).toEqual(['a:read', 'z:read']);
  });
});
