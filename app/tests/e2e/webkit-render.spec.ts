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

test('the preview working image is an engine-independent area-average of the photo (no WebKit aliasing)', async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const photo = await detailedPhoto(page);
  await startFullFrame(page, photo);
  const r = await page.evaluate(async (b64) => {
    const src = (window.__CINEROLL_DEBUG__ as unknown as { preview(): { source: HTMLCanvasElement } }).preview().source;
    const W = src.width; const H = src.height;
    // Independent reference: straightforward box filter over the full-resolution pixels.
    const img = new Image(); img.src = `data:image/jpeg;base64,${b64}`; await img.decode();
    const full = document.createElement('canvas'); full.width = img.naturalWidth; full.height = img.naturalHeight;
    full.getContext('2d')!.drawImage(img, 0, 0);
    const fd = full.getContext('2d')!.getImageData(0, 0, full.width, full.height).data;
    const sx = full.width / W; const sy = full.height / H;
    const ref = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a0 = x * sx; const a1 = (x + 1) * sx; const b0 = y * sy; const b1 = (y + 1) * sy; let acc = 0; let wsum = 0;
      for (let v = Math.floor(b0); v < Math.min(b1, full.height); v++) { const wy = Math.min(b1, v + 1) - Math.max(b0, v); for (let u = Math.floor(a0); u < Math.min(a1, full.width); u++) { const wx = Math.min(a1, u + 1) - Math.max(a0, u); acc += fd[(v * full.width + u) * 4 + 1] * wx * wy; wsum += wx * wy; } }
      ref[y * W + x] = acc / wsum;
    }
    const a = src.getContext('2d')!.getImageData(0, 0, W, H).data;
    let diff = 0; let ta = 0; let tr = 0;
    for (let i = 0; i < W * H; i++) { diff += Math.abs(a[i * 4 + 1] - ref[i]); if (i % W < W - 1) { ta += Math.abs(a[i * 4 + 1] - a[i * 4 + 5]); tr += Math.abs(ref[i] - ref[i + 1]); } }
    return { meanAbs: diff / (W * H), app: ta / (W * H), ref: tr / (W * H) };
  }, photo.toString('base64'));
  console.log(browserName, 'area-average reference: meanAbs', r.meanAbs.toFixed(2), 'texture app/ref', r.app.toFixed(2), r.ref.toFixed(2));
  expect(r.meanAbs, 'matches an exact box filter').toBeLessThan(1);
  expect(r.app / r.ref, 'no extra aliasing').toBeLessThan(1.05);
  expect(r.app / r.ref).toBeGreaterThan(0.95);
});

test('the on-screen preview is reduced without aliasing (canvas drawImage is coarse on WebKit)', async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await startFullFrame(page, await detailedPhoto(page));
  const r = await page.evaluate(() => {
    const cv = document.querySelector('.preview-slide-canvas') as HTMLCanvasElement;
    const src = (window.__CINEROLL_DEBUG__ as unknown as { preview(): { source: HTMLCanvasElement } }).preview().source;
    const W = cv.width; const H = cv.height;
    // Reference: box-average of the working image to the canvas size (same geometry: single, no margin).
    const sd = src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data;
    const sx = src.width / W; const sy = src.height / H; let diff = 0; let n = 0;
    const d = cv.getContext('2d')!.getImageData(0, 0, W, H).data;
    for (let y = 2; y < H - 2; y += 3) for (let x = 2; x < W - 2; x += 3) {
      let acc = 0; let ws = 0; const a0 = x * sx; const a1 = (x + 1) * sx; const b0 = y * sy; const b1 = (y + 1) * sy;
      for (let v = Math.floor(b0); v < b1; v++) for (let u = Math.floor(a0); u < a1; u++) { const w = (Math.min(b1, v + 1) - Math.max(b0, v)) * (Math.min(a1, u + 1) - Math.max(a0, u)); acc += sd[(v * src.width + u) * 4 + 1] * w; ws += w; }
      diff += Math.abs(d[(y * W + x) * 4 + 1] - acc / ws); n++;
    }
    return { canvas: [W, H], meanAbs: diff / n };
  });
  console.log(browserName, 'display vs box-average', JSON.stringify(r));
  expect(r.meanAbs, 'display close to an ideal reduction').toBeLessThan(6);
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
