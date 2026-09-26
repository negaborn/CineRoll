import { test, expect, type Page } from '@playwright/test';
import { previewStats, exportStats, runExport, closeExport, meanDiff, setControl } from './fixtures/pixels';

// Runs on Chromium AND WebKit (iPhone Safari's engine) -- the three real-device
// problems after the film port were all invisible on Chromium:
//  1. The preview's working image (film input) came out ~50% harsher on WebKit:
//     WebKit's transformed drawImage downscale aliases where a plain scaled
//     drawImage (what the prototypes use) does not. The film's detail boost then
//     amplified it -- "the film looks different from the prototype".
//  2. Brightness/contrast/saturation used the canvas `ctx.filter`, which WebKit
//     ignores: state updated, pixels didn't (only Film Grain, drawn without a
//     filter, worked).
//  3. The Intensity slider was locked for films (it only mixed custom .cube LUTs).

const state = (page: Page) => page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());
const filmReady = (page: Page) => page.waitForFunction(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmReady: boolean } }).preview().filmReady, null, { timeout: 120_000 });

/** A detailed 5328x4000 "photo": smooth colour fields plus dense fine texture (foliage-like). */
async function detailedPhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const W = 5328; const H = 4000;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#35506e'); g.addColorStop(1, '#c8a878'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    let s = 99;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 400000; i++) { const v = Math.floor(rnd() * 200); x.fillStyle = `rgb(${v * 0.6},${v},${v * 0.5})`; x.fillRect(rnd() * W, rnd() * H * 0.6, 1 + rnd() * 3, 1 + rnd() * 3); }
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function startFullFrame(page: Page, buf: Buffer) {
  await page.setInputFiles('#upload-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: buf });
  await page.waitForSelector('.cropper-container', { timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.click('#strategy-btns [data-val="single"]');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForTimeout(500);
}

test('the preview working image is downscaled as smoothly as a plain drawImage (the prototypes\' path)', async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const photo = await detailedPhoto(page);
  await startFullFrame(page, photo);
  const r = await page.evaluate(async (b64) => {
    const src = (window.__CINEROLL_DEBUG__ as unknown as { preview(): { source: HTMLCanvasElement } }).preview().source;
    const W = src.width; const H = src.height;
    const img = new Image(); img.src = `data:image/jpeg;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d')!; x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, W, H);
    const tex = (p: Uint8ClampedArray) => { let hp = 0; let n = 0; for (let i = 0; i < p.length - 4; i += 4) { if ((i / 4) % W === W - 1) continue; hp += Math.abs(p[i + 1] - p[i + 5]); n++; } return hp / n; };
    return { app: tex(src.getContext('2d')!.getImageData(0, 0, W, H).data), plain: tex(x.getImageData(0, 0, W, H).data) };
  }, photo.toString('base64'));
  console.log(browserName, 'texture app/plain', r.app.toFixed(2), r.plain.toFixed(2));
  expect(r.app / r.plain, 'no extra aliasing in the film input').toBeLessThan(1.1);
  expect(r.app / r.plain).toBeGreaterThan(0.9);
});

test('Color tab brightness / contrast / saturation change the preview and the export', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await startFullFrame(page, await detailedPhoto(page));
  const base = await previewStats(page);
  await page.click('[data-tab="color"]');
  await setControl(page, '#slider-br', '140', ['input']);
  await page.waitForTimeout(500);
  const bright = await previewStats(page);
  expect((await state(page)).tone.brightness).toBe(140);
  expect(bright.mean[1], 'brightness applied').toBeGreaterThan(base.mean[1] * 1.25);
  await setControl(page, '#slider-co', '60', ['input']);
  await page.waitForTimeout(500);
  const flat = await previewStats(page);
  expect(flat.lumaStd, 'contrast applied').toBeLessThan(bright.lumaStd * 0.8);
  await setControl(page, '#slider-sa', '0', ['input']);
  await page.waitForTimeout(500);
  const gray = await previewStats(page);
  expect(gray.sat, 'saturation applied').toBeLessThan(3);
  await runExport(page);
  const e = await exportStats(page);
  expect(e.sat, 'export saturation').toBeLessThan(3);
  expect(meanDiff(gray, e), 'export == preview').toBeLessThan(4);
  await closeExport(page);
});

test('Intensity mixes a film: 0% = no film, 50% = in between, 100% = full film -- in preview and export', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await startFullFrame(page, await detailedPhoto(page));
  const plain = await previewStats(page);
  await page.click('[data-tab="tone"]');
  await setControl(page, '#select-lut', 'classic-pan-400', ['change']);
  await filmReady(page);
  await page.waitForTimeout(300);
  const full = await previewStats(page);
  expect(await page.getAttribute('#lut-intensity-wrapper', 'class'), 'slider usable with a film').not.toContain('pointer-events-none');
  await setControl(page, '#slider-lut-intensity', '50', ['input']);
  await page.waitForTimeout(600);
  expect((await state(page)).tone.lutIntensity).toBe(50);
  const half = await previewStats(page);
  await setControl(page, '#slider-lut-intensity', '0', ['input']);
  await page.waitForTimeout(600);
  const none = await previewStats(page);
  expect(meanDiff(none, plain), '0% = the unfilmed photo').toBeLessThan(1.5);
  expect(full.sat, '100% = B&W').toBeLessThan(3);
  expect(half.sat, '50% = half the colour').toBeGreaterThan(full.sat + 3);
  expect(half.sat).toBeLessThan(none.sat - 3);
  await setControl(page, '#slider-lut-intensity', '50', ['input']);
  await page.waitForTimeout(600);
  await runExport(page);
  const e = await exportStats(page);
  expect(meanDiff(half, e), '50% export == 50% preview').toBeLessThan(4);
  expect(Math.abs(e.sat - half.sat)).toBeLessThan(3);
});
