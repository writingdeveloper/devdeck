// src/shared/imageSniff.ts

const ascii = (b: Uint8Array, start: number, text: string): boolean =>
  b.length >= start + text.length && [...text].every((ch, i) => b[start + i] === ch.charCodeAt(0));

/**
 * What the bytes ARE, from their first bytes — never from a file name or a claimed type. A file that
 * is not one of these is not an image, whatever it is called, and is never sent.
 */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 'GIF8')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (ascii(b, 0, 'BM') && b.length >= 26) return 'image/bmp';
  return null;
}
