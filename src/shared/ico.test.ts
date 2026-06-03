import { describe, it, expect } from 'vitest';
import { packIco } from './ico';

describe('packIco', () => {
  const a = new Uint8Array([1, 2, 3]);      // fake PNG #1 (len 3)
  const b = new Uint8Array([4, 5, 6, 7]);   // fake PNG #2 (len 4)

  it('writes the ICONDIR magic and image count', () => {
    const ico = packIco([a, b], [16, 32]);
    expect([...ico.slice(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]); // reserved, type=1, count=2 (LE)
  });

  it('lays out directory entries and image offsets', () => {
    const ico = packIco([a, b], [16, 32]);
    const dv = new DataView(ico.buffer);
    expect(ico[6]).toBe(16);                 // entry0 width
    expect(ico[6 + 16]).toBe(32);            // entry1 width
    expect(dv.getUint32(6 + 12, true)).toBe(6 + 16 * 2);        // entry0 offset = 38
    expect(dv.getUint32(6 + 16 + 12, true)).toBe(6 + 16 * 2 + 3); // entry1 offset = 41
    expect(dv.getUint32(6 + 8, true)).toBe(3);  // entry0 bytesInRes = len(a)
    expect(ico.length).toBe(6 + 16 * 2 + 3 + 4); // 45
    expect([...ico.slice(38, 41)]).toEqual([1, 2, 3]); // image #1 bytes appended
  });

  it('encodes 256 as width/height byte 0', () => {
    const ico = packIco([a], [256]);
    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
  });

  it('throws when pngs and sizes mismatch', () => {
    expect(() => packIco([a], [16, 32])).toThrow();
  });
});
