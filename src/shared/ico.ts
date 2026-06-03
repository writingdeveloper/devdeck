/**
 * Pack PNG-encoded images into a Windows `.ico` byte stream. Entries store the
 * PNG bytes verbatim (PNG-compressed icons, supported on Windows Vista+), so no
 * BMP conversion is needed. `sizes[i]` is the pixel dimension of `pngs[i]`.
 */
export function packIco(pngs: Uint8Array[], sizes: number[]): Uint8Array {
  if (pngs.length !== sizes.length) throw new Error('packIco: pngs and sizes length mismatch');
  const count = pngs.length;
  const dirStart = 6;
  const dataStart = dirStart + 16 * count;

  const out = new Uint8Array(dataStart + pngs.reduce((n, p) => n + p.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true); // reserved
  dv.setUint16(2, 1, true); // type: 1 = icon
  dv.setUint16(4, count, true);

  let imgOffset = dataStart;
  for (let i = 0; i < count; i++) {
    const entry = dirStart + i * 16;
    const sz = sizes[i] >= 256 ? 0 : sizes[i]; // 0 means 256 in ICO
    out[entry + 0] = sz;       // width
    out[entry + 1] = sz;       // height
    out[entry + 2] = 0;        // palette color count
    out[entry + 3] = 0;        // reserved
    dv.setUint16(entry + 4, 1, true);   // color planes
    dv.setUint16(entry + 6, 32, true);  // bits per pixel
    dv.setUint32(entry + 8, pngs[i].length, true);  // bytes in resource
    dv.setUint32(entry + 12, imgOffset, true);      // offset to image data
    out.set(pngs[i], imgOffset);
    imgOffset += pngs[i].length;
  }
  return out;
}
