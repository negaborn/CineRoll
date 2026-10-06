import { test, expect, type Page } from './fixtures/test';
import fs from 'node:fs';
import { exportedDims } from './fixtures/pixels';

// Technical plan v2, P1-1: RAW files (rw2/cr2/cr3/nef/arw/dng) go through
// libraw-wasm in the real upload path. Runs on Chromium and WebKit.
// Uses the owner's Panasonic S5IIX RW2 samples (local files; skipped if absent).

const DIR = '/Users/kunst/Documents/#02_Projects/Project_on/chirrion works/IMG_TEM';
const LANDSCAPE = `${DIR}/P1036334.RW2`;
const PORTRAIT = '/Users/kunst/Pictures/Tlapalcalli.cocatalog/Originals/2026/02/11/1/P1036509.RW2'; // EXIF flip = 5
const haveSamples = fs.existsSync(LANDSCAPE) && fs.existsSync(PORTRAIT);

async function upload(page: Page, path: string) {
  await page.setInputFiles('#upload-input', path);
}

/** LibRaw's own 8-bit decode of the file, straight from the library (reference). */
async function referenceDecode(page: Page, path: string) {
  await page.route('**/__file/**', (r) => r.fulfill({ status: 200, body: fs.readFileSync(decodeURIComponent(new URL(r.request().url()).pathname.replace('/__file/', ''))) }));
  return page.evaluate(async (p) => {
    const LibRaw = (await import('/node_modules/libraw-wasm/dist/index.js')).default;
    const lr = new LibRaw();
    await lr.open(new Uint8Array(await (await fetch('/__file/' + encodeURIComponent(p))).arrayBuffer()), { useCameraWb: true, outputBps: 8 });
    const img = await lr.imageData(); lr.dispose();
    (window as unknown as { __ref: { w: number; h: number; d: Uint8Array } }).__ref = { w: img!.width, h: img!.height, d: img!.data as Uint8Array };
    return [img!.width, img!.height];
  }, path);
}

test.describe('RAW upload', () => {
  test.skip(!haveSamples, 'RW2 samples not on this machine');

  test('an RW2 opens in the editor at full sensor resolution, shows a decoding message, and previews', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await upload(page, LANDSCAPE);
    await expect(page.locator('#uploadText')).toContainText('RAW');
    await page.waitForSelector('.cropper-container', { timeout: 60_000 });
    const size = await page.evaluate(() => { const o = (window.__CINEROLL_DEBUG__ as unknown as { originalSize(): number[] }).originalSize(); return o; });
    expect(size).toEqual([6008, 4008]);
    await page.click('#strategy-btns [data-val="single"]');
    await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    const lit = await page.evaluate(() => { const c = document.querySelector('.preview-slide-canvas') as HTMLCanvasElement; const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i + 1]; return s / (d.length / 4); });
    expect(lit, 'preview is not blank').toBeGreaterThan(20);
  });

  test('Lossless TIFF from an RW2 is LibRaw\'s decode, pixel for pixel (no lossy step in between)', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    expect(await referenceDecode(page, LANDSCAPE)).toEqual([6008, 4008]);
    await upload(page, LANDSCAPE);
    await page.waitForSelector('.cropper-container', { timeout: 60_000 });
    await page.click('#strategy-btns [data-val="single"]');
    await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    await page.selectOption('#exportQuality', 'tiff');
    await page.click('#btn-export');
    await page.waitForSelector('#export-modal.show', { timeout: 180_000 });
    expect(await exportedDims(page)).toEqual([[6008, 4008]]);
    const r = await page.evaluate(async () => {
      const ref = (window as unknown as { __ref: { w: number; h: number; d: Uint8Array } }).__ref;
      const c = await (window.__CINEROLL_DEBUG__ as unknown as { decodeExport(i: number): Promise<HTMLCanvasElement> }).decodeExport(0);
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let max = 0; let sum = 0;
      for (let p = 0, q = 0; p < d.length; p += 4, q += 3) for (let k = 0; k < 3; k++) { const e = Math.abs(d[p + k] - ref.d[q + k]); if (e > max) max = e; sum += e; }
      return { max, mean: sum / (ref.w * ref.h * 3) };
    });
    expect(r.max, 'max channel difference vs LibRaw').toBeLessThanOrEqual(1);
    expect(r.mean).toBeLessThan(0.01);
  });

  test('a portrait RW2 (EXIF flip) comes in upright', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await upload(page, PORTRAIT);
    await page.waitForSelector('.cropper-container', { timeout: 60_000 });
    const size = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { originalSize(): number[] }).originalSize());
    expect(size).toEqual([4008, 6008]);
  });
});

test('a broken RAW file shows a clear message and the app stays usable', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const messages: string[] = [];
  page.on('dialog', async (d) => { messages.push(d.message()); await d.dismiss(); });
  await page.setInputFiles('#upload-input', { name: 'broken.NEF', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a raw file'.repeat(500)) });
  await expect.poll(() => messages.length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(messages[0]).toContain('RAW');
  expect(messages[0]).toContain('TIFF');
  await expect(page.locator('#uploadText')).not.toContainText('RAW 디코딩');
  // still usable: a normal photo loads afterwards
  const jpg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; c.getContext('2d')!.fillRect(0, 0, 10, 10); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.setInputFiles('#upload-input', { name: 'ok.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container', { timeout: 30_000 });
});
