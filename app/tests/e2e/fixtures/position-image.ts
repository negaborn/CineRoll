import type { Browser, Page } from '@playwright/test';
import './debug-types';

/**
 * Position-coded test image: R = x/(w-1)*255, G = y/(h-1)*255, B = 128.
 * Any sampled output pixel can be decoded back to the normalized source
 * location it came from, so crop/rotate/desqueeze mapping is checked
 * pixel-exactly rather than by eyeballing.
 */
export async function makePositionImage(browser: Browser, w: number, h: number, mime: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Buffer> {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(
    ({ w, h, mime }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const g = Math.round((y / (h - 1)) * 255);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          id.data[i] = Math.round((x / (w - 1)) * 255);
          id.data[i + 1] = g;
          id.data[i + 2] = 128;
          id.data[i + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
      return c.toDataURL(mime, 0.95);
    },
    { w, h, mime },
  );
  await page.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Solid-color PNG (used as a logo that's trivially detectable in output pixels). */
export async function makeSolidPng(browser: Browser, w: number, h: number, color: string): Promise<Buffer> {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(
    ({ w, h, color }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      return c.toDataURL('image/png');
    },
    { w, h, color },
  );
  await page.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Inserts an EXIF APP1 segment carrying only an Orientation tag, right after SOI/JFIF. */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // 1 IFD entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22); // next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);

  let insertAt = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) insertAt = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, insertAt), header, payload, jpeg.subarray(insertAt)]);
}

export interface Sample {
  a: number;
  b: number;
  r: number;
  g: number;
  bl: number;
}

export interface SampledImage {
  w: number;
  h: number;
  samples: Sample[];
}

const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];

/** Samples the first exported image (the gallery <img>) on a normalized grid. */
export async function sampleExport(page: Page): Promise<SampledImage> {
  return page.evaluate(async (grid) => {
    const img = document.querySelector('.export-img-item') as HTMLImageElement;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const samples = [];
    for (const a of grid) for (const b of grid) {
      const d = ctx.getImageData(Math.floor(a * (c.width - 1)), Math.floor(b * (c.height - 1)), 1, 1).data;
      samples.push({ a, b, r: d[0], g: d[1], bl: d[2] });
    }
    return { w: c.width, h: c.height, samples };
  }, GRID);
}

/** Samples the first preview slide canvas on the same grid. */
export async function samplePreview(page: Page): Promise<SampledImage> {
  return page.evaluate((grid) => {
    const c = document.querySelector('.preview-slide-canvas') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const samples = [];
    for (const a of grid) for (const b of grid) {
      const d = ctx.getImageData(Math.floor(a * (c.width - 1)), Math.floor(b * (c.height - 1)), 1, 1).data;
      samples.push({ a, b, r: d[0], g: d[1], bl: d[2] });
    }
    return { w: c.width, h: c.height, samples };
  }, GRID);
}

/** Maps a point in the (base-rotated) plane back to the original image's normalized coords. */
export function planeToOriginal(u: number, v: number, baseRotation: number): [number, number] {
  switch (((baseRotation % 360) + 360) % 360) {
    case 90: return [v, 1 - u];
    case 180: return [1 - u, 1 - v];
    case 270: return [1 - v, u];
    default: return [u, v];
  }
}

/**
 * Like maxPositionError, but for a crop taken with a fine (straighten) angle.
 * Crop fractions are relative to the rotated frame's bounding box (what
 * Cropper.js crops within); samples falling outside the source are skipped.
 */
export function maxPositionErrorStraightened(img: SampledImage, crop: { x: number; y: number; width: number; height: number }, origW: number, origH: number, squeezePct: number, baseRotation: number, fineDeg: number): number {
  const W0 = origW * (squeezePct / 100);
  const H0 = origH;
  const swapped = baseRotation === 90 || baseRotation === 270;
  const pw = swapped ? H0 : W0;
  const ph = swapped ? W0 : H0;
  const t = (fineDeg * Math.PI) / 180;
  const fw = pw * Math.abs(Math.cos(t)) + ph * Math.abs(Math.sin(t));
  const fh = pw * Math.abs(Math.sin(t)) + ph * Math.abs(Math.cos(t));
  const phi = ((baseRotation + fineDeg) * Math.PI) / 180;
  let worst = 0;
  for (const s of img.samples) {
    const dx = (crop.x + s.a * crop.width) * fw - fw / 2;
    const dy = (crop.y + s.b * crop.height) * fh - fh / 2;
    const px = dx * Math.cos(phi) + dy * Math.sin(phi);
    const py = -dx * Math.sin(phi) + dy * Math.cos(phi);
    const u = px / W0 + 0.5;
    const v = py / H0 + 0.5;
    if (u < 0.02 || u > 0.98 || v < 0.02 || v > 0.98) continue;
    worst = Math.max(worst, Math.abs(s.r / 255 - u), Math.abs(s.g / 255 - v));
  }
  return worst;
}

/** Max decoded-position error (0..1 units of the original image) over all samples. */
export function maxPositionError(img: SampledImage, crop: { x: number; y: number; width: number; height: number }, baseRotation: number, displayTransform: (u: number, v: number) => [number, number] = (u, v) => [u, v]): number {
  let worst = 0;
  for (const s of img.samples) {
    const pu = crop.x + s.a * crop.width;
    const pv = crop.y + s.b * crop.height;
    const [ou, ov] = displayTransform(...planeToOriginal(pu, pv, baseRotation));
    const du = Math.abs(s.r / 255 - ou);
    const dv = Math.abs(s.g / 255 - ov);
    worst = Math.max(worst, du, dv);
  }
  return worst;
}
