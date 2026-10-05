import { test, expect, type Page } from '@playwright/test';
import { exportedDims } from './fixtures/pixels';

// Technical plan v2, P0-3: IG/Web exports used fixed canvas sizes, so a small
// crop was blown up (a 1502px crop -> 6000px Web, 4x) -- inventing pixels.
// The crop's own resolution is now the ceiling; when it is below the mode's
// size the export says so instead of upscaling. Also: Lossless came out 1px
// short (6008 -> 6007) from flooring a float crop width.

const SRC_W = 6008;
const SRC_H = 4008;

async function load(page: Page) {
  await page.goto('/');
  const jpg = await page.evaluate(({ w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#345'); g.addColorStop(1, '#dca'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, { w: SRC_W, h: SRC_H });
  await page.setInputFiles('#upload-input', { name: 'src.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(400);
}

async function exportDims(page: Page, quality: 'ig' | 'web' | 'tiff') {
  await page.selectOption('#exportQuality', quality);
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 120_000 });
  const dims = await exportedDims(page);
  const note = await page.evaluate(() => { const n = document.getElementById('export-note'); return n && !n.classList.contains('hidden') ? n.textContent : null; });
  await page.click('#btn-close-export');
  await page.waitForTimeout(400);
  return { dims, note };
}

test('a small crop is never upscaled: IG and Web stop at the crop\'s own pixels, and say so', async ({ page }) => {
  test.setTimeout(180_000);
  await load(page);
  await page.click('#strategy-btns [data-val="single"]');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.3, y: 0.3, width: 0.25, height: 0.25 })); // 1502 x 1002
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  for (const q of ['ig', 'web'] as const) {
    const r = await exportDims(page, q);
    expect(r.dims, `${q}: crop resolution, not upscaled`).toEqual([[1502, 1002]]);
    expect(r.note, `${q}: tells the user why it is smaller`).toContain('1502');
  }
});

test('a large crop still gets the mode\'s size (downscaling is fine), with no notice', async ({ page }) => {
  test.setTimeout(180_000);
  await load(page);
  await page.click('#strategy-btns [data-val="single"]');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  const ig = await exportDims(page, 'ig');
  expect(ig.dims[0][0]).toBe(2160);
  expect(ig.note).toBeNull();
});

test('Lossless is exactly the crop\'s pixels (no 1px loss)', async ({ page }) => {
  test.setTimeout(180_000);
  await load(page);
  await page.click('#strategy-btns [data-val="single"]');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  const r = await exportDims(page, 'tiff');
  expect(r.dims).toEqual([[SRC_W, SRC_H]]);
  expect(r.note).toBeNull();
});

test('Seamless: each slide is capped by its share of the crop (no upscale per slide)', async ({ page }) => {
  test.setTimeout(240_000);
  await load(page); // default Seamless, 3 x 4:5
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  const lossless = await exportDims(page, 'tiff');
  const ig = await exportDims(page, 'ig');
  const web = await exportDims(page, 'web');
  expect(lossless.dims.length).toBe(3);
  // Each slide's share of this crop is ~1702px wide: below IG's 2160 and Web's 6000.
  expect(ig.dims, 'IG slides = the crop\'s own pixels').toEqual(lossless.dims);
  expect(web.dims, 'Web slides = the crop\'s own pixels').toEqual(lossless.dims);
  expect(ig.note).toContain('1702');
});
