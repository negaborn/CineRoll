import { test, expect, type Page } from './fixtures/test';

// Technical plan v2, P0-1 (decided 2026-10-05: Lossless = TIFF).
// Lossless used to be one PNG canvas: on iOS (16.7 MP per-canvas limit) a 24 MP
// photo was silently shrunk to 16.7 MP (6008x4008 -> 5014x3345). Lossless is now
// an uncompressed TIFF written band by band -- no canvas ever holds the whole
// image -- so every device gets the crop's full resolution. Bands must not show:
// the result equals rendering it in one piece.

const IOS_CANVAS_LIMIT = 16_777_216;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

type Dbg = {
  exportFiles(): { name: string; type: string; size: number }[];
  decodeExport(i: number): Promise<HTMLCanvasElement>;
  tiffInfo(i: number): Promise<Record<string, unknown>>;
  setExportBandRows(n: number | null): void;
};

async function load(page: Page, w: number, h: number) {
  await page.goto('/');
  const jpg = await page.evaluate(({ w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#203a5c'); g.addColorStop(0.5, '#c9a36a'); g.addColorStop(1, '#f4efe6'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    let s = 3; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 60000; i++) { const v = Math.floor(rnd() * 255); x.fillStyle = `rgb(${v},${(v * 0.8) | 0},${(v * 0.6) | 0})`; x.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 2 + rnd() * 6); }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, { w, h });
  await page.setInputFiles('#upload-input', { name: 'src.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(400);
}

async function exportLossless(page: Page) {
  await page.selectOption('#exportQuality', 'tiff');
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 180_000 });
}

const dbg = (page: Page) => page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).exportFiles());

test('Lossless is an uncompressed RGB TIFF at the crop\'s exact resolution, matching the preview', async ({ page }) => {
  test.setTimeout(240_000);
  await load(page, 6008, 4008);
  await page.click('#strategy-btns [data-val="single"]');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await exportLossless(page);
  const files = await dbg(page);
  expect(files.map((f) => [f.type, f.name.endsWith('.tif')])).toEqual([['image/tiff', true]]);
  const info = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).tiffInfo(0));
  expect(info).toMatchObject({ width: 6008, height: 4008, bitsPerSample: [8, 8, 8], samplesPerPixel: 3, compression: 1, photometric: 2 });
  expect(files[0].size, 'uncompressed RGB').toBeGreaterThanOrEqual(6008 * 4008 * 3);
  // Gallery shows something viewable (browsers can't render TIFF).
  expect(await page.locator('.export-img-item').first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
});

test.describe('on an iPhone', () => {
  test.use({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA });
  test('Lossless keeps all 24 MP (was silently shrunk to 16.7 MP) and no canvas exceeds the iOS limit', async ({ page }) => {
    test.setTimeout(240_000);
    await page.addInitScript(() => {
      (navigator as unknown as { canShare: () => boolean }).canShare = () => false; // land in the gallery
      const w = window as unknown as { __maxCanvasArea: number; __track: boolean };
      w.__maxCanvasArea = 0; w.__track = false;
      const proto = HTMLCanvasElement.prototype;
      for (const prop of ['width', 'height'] as const) {
        const d = Object.getOwnPropertyDescriptor(proto, prop)!;
        Object.defineProperty(proto, prop, { configurable: true, get() { return d.get!.call(this); }, set(v: number) { d.set!.call(this, v); if (w.__track) w.__maxCanvasArea = Math.max(w.__maxCanvasArea, d.get!.call(this) * (prop === 'width' ? (this as HTMLCanvasElement).height : (this as HTMLCanvasElement).width)); } });
      }
    });
    await load(page, 6008, 4008);
    await page.click('#strategy-btns [data-val="single"]');
    await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    await page.evaluate(() => { (window as unknown as { __track: boolean; __maxCanvasArea: number }).__track = true; (window as unknown as { __maxCanvasArea: number }).__maxCanvasArea = 0; });
    await exportLossless(page);
    const peak = await page.evaluate(() => { const w = window as unknown as { __track: boolean; __maxCanvasArea: number }; w.__track = false; return w.__maxCanvasArea; });
    const info = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).tiffInfo(0));
    expect([info.width, info.height], 'full resolution on a phone').toEqual([6008, 4008]);
    expect(peak, `largest canvas during export: ${peak} px`).toBeLessThan(IOS_CANVAS_LIMIT);
  });
});

test('band-by-band output equals rendering in one piece (film, tone, margin, border, caption, logo, panorama slides)', async ({ page }) => {
  test.setTimeout(300_000);
  await load(page, 3600, 2400);
  // Seamless 3 slides, Free ratio, full frame
  await page.selectOption('#select-ratio', 'NaN');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.updateState({
    frame: { margin: true, marginScale: 0.85, bgColor: '#ffffff', border: 'fineart', borderWeight: 4 },
    tone: { lut: 'velvia-50', lutIntensity: 70, highlights: 20, brightness: 105, saturation: 110, grain: 0 },
    typo: { text: 'BANDS MUST NOT SHOW', fontScale: 180, glow: true, target: 'all' },
    appWatermark: true,
  }));
  await page.waitForFunction(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmReady: boolean } }).preview().filmReady, null, { timeout: 120_000 });
  const logo = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 120; const x = c.getContext('2d')!; x.fillStyle = '#00c8ff'; x.fillRect(0, 0, 300, 120); x.fillStyle = '#000'; x.fillRect(40, 30, 220, 60); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('#uploadLogo', { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(logo, 'base64') });
  await page.waitForTimeout(400);
  // Decode the exported slides and keep them in the page (too big to ship out).
  const keep = (slot: string) => page.evaluate(async (slot) => {
    const d = window.__CINEROLL_DEBUG__ as unknown as Dbg;
    const out: Uint8ClampedArray[] = [];
    for (let i = 0; i < d.exportFiles().length; i++) { const c = await d.decodeExport(i); out.push(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data); }
    (window as unknown as Record<string, Uint8ClampedArray[]>)[slot] = out;
    return out.length;
  }, slot);
  await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).setExportBandRows(100_000)); // one band per slide
  await exportLossless(page);
  await keep('__whole');
  await page.click('#btn-close-export'); await page.waitForTimeout(300);
  await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).setExportBandRows(97)); // many odd-sized bands
  await exportLossless(page);
  expect(await keep('__banded')).toBe(3);
  const cmp = await page.evaluate(() => {
    const w = window as unknown as Record<string, Uint8ClampedArray[]>;
    return w.__whole.map((a, s) => { const b = w.__banded[s]; let max = 0; let sum = 0; for (let i = 0; i < a.length; i++) { const e = Math.abs(a[i] - b[i]); if (e > max) max = e; sum += e; } return { sameSize: a.length === b.length, max, mean: sum / a.length }; });
  });
  cmp.forEach((c, s) => {
    expect(c.sameSize).toBe(true);
    expect(c.max, `slide ${s + 1}: max difference`).toBeLessThanOrEqual(2);
    expect(c.mean, `slide ${s + 1}: mean difference`).toBeLessThan(0.05);
  });
});
