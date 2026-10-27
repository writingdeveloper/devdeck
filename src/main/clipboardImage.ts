// src/main/clipboardImage.ts
// The image on the OS clipboard, as PNG bytes — and the reverse. Electron 44 removed
// `clipboard.readImage()` / `writeImage()` in favour of the W3C-shaped `clipboard.read()` /
// `write()` (ClipboardItem + Blob), so the paste-a-screenshot and copy-an-image paths go through here.
import { ClipboardItem, clipboard, nativeImage } from 'electron';

/**
 * PNG bytes of the image on the clipboard, or null when there is none. A screenshot on Windows is a
 * bitmap; Chromium offers it as `image/png` through `read()`. Any other image type is converted.
 */
export async function readClipboardPng(): Promise<Buffer | null> {
  let items: Electron.ClipboardItem[];
  try { items = await clipboard.read(); } catch { return null; }
  for (const item of items) {
    const type = item.types.includes('image/png') ? 'image/png' : item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    try {
      const blob = await item.getType(type) as Blob;
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (!bytes.length) continue;
      if (type === 'image/png') return bytes;
      const img = nativeImage.createFromBuffer(bytes);
      if (!img.isEmpty()) return img.toPNG();
    } catch { /* try the next item */ }
  }
  return null;
}

/** Put PNG bytes on the clipboard as an image. */
export async function writeClipboardPng(png: Buffer): Promise<void> {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
}
