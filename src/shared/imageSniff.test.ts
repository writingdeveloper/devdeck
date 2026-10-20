// src/shared/imageSniff.test.ts
import { describe, it, expect } from 'vitest';
import { sniffImageType } from './imageSniff';

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('sniffImageType', () => {
  it('names each supported format by its magic bytes', () => {
    expect(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(bytes('BM', new Array(30).fill(0)))).toBe('image/bmp');
  });

  it('refuses anything else, whatever it is called — text, keys, a truncated header', () => {
    expect(sniffImageType(bytes('-----BEGIN OPENSSH PRIVATE KEY-----'))).toBeNull();
    expect(sniffImageType(bytes('{"token":"x"}'))).toBeNull();
    expect(sniffImageType(bytes([0x89], 'PN'))).toBeNull();
    expect(sniffImageType(bytes('BM'))).toBeNull(); // two letters are not a bitmap
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});
