// src/main/imageView.ts
// Images sized for showing in the cockpit: a small thumbnail for the strip, a bounded full view.
// Encoded where the image lives, so a remote machine sends kilobytes, not a raw 4K screenshot.
import { nativeImage } from 'electron';
import { sniffImageType } from '../shared/imageSniff';

export interface ViewImage { mediaType: string; data: string; width: number; height: number }

export const VIEWABLE_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
export const MAX_VIEW_IMAGE_FILE_BYTES = 40 * 1024 * 1024;
const THUMB_WIDTH = 360;
const FULL_MAX_WIDTH = 2560;
const FULL_MAX_HEIGHT = 8192;
/** Under the link's 8MB frame once base64 has grown it by a third. */
const MAX_SENT_BYTES = 5 * 1024 * 1024;

/**
 * `size` 'thumb' → a ~360px-wide JPEG; anything else → the original when it is small enough to send,
 * else a downscaled JPEG that is guaranteed to fit a link frame (or nothing). Formats Electron cannot
 * decode (webp, gif) go as they are — the renderer's <img> can — or not at all when too large.
 * Null for anything that does not sniff as an image.
 */
export function encodeImageForView(bytes: Buffer, size?: string): ViewImage | null {
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return null;
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
  if (bytes.length <= MAX_SENT_BYTES) return { mediaType, data: bytes.toString('base64'), width, height };
  // Bounded on BOTH sides: a full-page screenshot is narrow and 20,000px tall, and only capping its
  // width would send a JPEG bigger than the link carries — which drops the whole connection.
  const scale = Math.min(1, FULL_MAX_WIDTH / width, FULL_MAX_HEIGHT / height);
  const scaled = scale < 1 ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : img;
  const ss = scaled.getSize();
  for (const quality of [88, 75, 60, 45]) {
    const jpeg = scaled.toJPEG(quality);
    if (jpeg.length <= MAX_SENT_BYTES) return { mediaType: 'image/jpeg', data: jpeg.toString('base64'), width: ss.width, height: ss.height };
  }
  return null;
}
