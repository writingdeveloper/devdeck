// src/main/imageView.ts
// Images sized for showing in the cockpit: a small thumbnail for the strip, a bounded full view.
// Encoded where the image lives, so a remote machine sends kilobytes, not a raw 4K screenshot.
import { nativeImage } from 'electron';

export interface ViewImage { mediaType: string; data: string; width: number; height: number }

export const VIEWABLE_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};
export const MAX_VIEW_IMAGE_FILE_BYTES = 40 * 1024 * 1024;
const THUMB_WIDTH = 360;
const FULL_MAX_WIDTH = 2560;
/** Under the link's 8MB frame once base64 has grown it by a third. */
const MAX_SENT_BYTES = 5 * 1024 * 1024;

/**
 * `size` 'thumb' → a ~360px-wide JPEG; anything else → the original when it is small enough to send,
 * else a downscaled JPEG. Formats Electron cannot decode (webp, gif) go as they are — the renderer's
 * <img> can — or not at all when too large.
 */
export function encodeImageForView(bytes: Buffer, mediaType: string, size?: string): ViewImage | null {
  const img = nativeImage.createFromBuffer(bytes);
  if (img.isEmpty()) {
    if (bytes.length > MAX_SENT_BYTES) return null;
    return { mediaType, data: bytes.toString('base64'), width: 0, height: 0 };
  }
  const { width, height } = img.getSize();
  if (size === 'thumb') {
    const t = width > THUMB_WIDTH ? img.resize({ width: THUMB_WIDTH, quality: 'good' }) : img;
    const ts = t.getSize();
    return { mediaType: 'image/jpeg', data: t.toJPEG(78).toString('base64'), width: ts.width, height: ts.height };
  }
  if (bytes.length <= MAX_SENT_BYTES && width <= FULL_MAX_WIDTH * 2) return { mediaType, data: bytes.toString('base64'), width, height };
  const scaled = width > FULL_MAX_WIDTH ? img.resize({ width: FULL_MAX_WIDTH, quality: 'best' }) : img;
  const ss = scaled.getSize();
  return { mediaType: 'image/jpeg', data: scaled.toJPEG(88).toString('base64'), width: ss.width, height: ss.height };
}
