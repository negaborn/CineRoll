// Camera RAW decoding (technical plan v2, P1-1) via libraw-wasm, which runs
// LibRaw in its own Web Worker -- the page stays responsive while it decodes.
//
// The rest of the app works on an <img> (crop UI, preview, export). The decoded
// RGB is wrapped in an uncompressed BMP rather than drawn into a canvas and
// re-encoded: a canvas can't hold a 24 MP photo on iOS (16.7 MP limit), and a
// JPEG re-encode would make "Lossless" exports lossy. BMP needs neither.

import LibRaw from 'libraw-wasm';

export const RAW_EXT = /\.(rw2|cr2|cr3|nef|arw|dng)$/i;

export class RawDecodeError extends Error {}

/** 24-bit top-down BMP (BGR, rows padded to 4 bytes) from packed 8-bit RGB. */
export function rgbToBmp(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; // "BM"
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true); // pixel data offset
  dv.setUint32(14, 40, true); // BITMAPINFOHEADER
  dv.setInt32(18, width, true);
  dv.setInt32(22, -height, true); // negative = top-down rows
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(30, 0, true); // BI_RGB, uncompressed
  dv.setUint32(34, rowSize * height, true);
  dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true); // 72 dpi
  for (let y = 0; y < height; y++) {
    let o = 54 + y * rowSize;
    let i = y * width * 3;
    for (let x = 0; x < width; x++, i += 3) { out[o++] = rgb[i + 2]; out[o++] = rgb[i + 1]; out[o++] = rgb[i]; }
  }
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new RawDecodeError('decoded image could not be loaded'));
    img.src = url;
  });
}

/**
 * Decodes a camera RAW file into an <img>: camera white balance, sRGB, 8 bits
 * per channel, the camera's orientation applied. Throws RawDecodeError when the
 * file can't be decoded (unsupported camera/compression, damaged file).
 */
export async function decodeRaw(file: File): Promise<HTMLImageElement> {
  const lr = new LibRaw();
  try {
    await lr.open(new Uint8Array(await file.arrayBuffer()), { useCameraWb: true, outputBps: 8 });
    const img = await lr.imageData();
    if (!img || img.colors !== 3 || img.bits !== 8 || !img.width || !img.height) throw new RawDecodeError('unsupported RAW output');
    const bmp = rgbToBmp(img.data as Uint8Array, img.width, img.height);
    return await loadImage(URL.createObjectURL(new Blob([bmp as BlobPart], { type: 'image/bmp' })));
  } catch (e) {
    throw e instanceof RawDecodeError ? e : new RawDecodeError((e as Error)?.message ?? String(e));
  } finally {
    lr.dispose();
  }
}
