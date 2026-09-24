import { test, expect, type Page } from '@playwright/test';
import { makePositionImage } from './fixtures/position-image';

// Smart snap (restored from v35-v40, extended): in Free ratio mode, a crop box
// within ±2% of a known ratio turns the frame green while dragging and snaps
// to that exact ratio on release.

// Mirrors src/snap.ts on purpose: the UI must show exactly these ratios/labels.
const SNAP_TARGETS = [
  { id: '1:1', ratio: 1, label: '1:1 Square' },
  { id: '4:5', ratio: 4 / 5, label: '4:5 Vertical IG' },
  { id: '4:3', ratio: 4 / 3, label: '4:3 Classic' },
  { id: '3:4', ratio: 3 / 4, label: '3:4 Classic' },
  { id: '3:2', ratio: 3 / 2, label: '3:2 Horizontal' },
  { id: '2:3', ratio: 2 / 3, label: '2:3 Vertical' },
  { id: '16:9', ratio: 16 / 9, label: '16:9 Landscape' },
  { id: '9:16', ratio: 9 / 16, label: '9:16 Vertical' },
  { id: '2.39:1', ratio: 2.39, label: '2.39:1 Cinemascope' },
];

async function setupFree(page: Page, browser: import('@playwright/test').Browser) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: await makePositionImage(browser, 1600, 1200) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(200);
}

const frameState = (page: Page) => page.evaluate(() => {
  const box = document.querySelector('#image-container .cropper-crop-box') as HTMLElement;
  const r = box.getBoundingClientRect();
  const vb = document.querySelector('#image-container .cropper-view-box') as HTMLElement;
  const badge = document.getElementById('smart-snap-badge')!;
  return {
    green: !!document.querySelector('#image-container .cropper-container.cropper-snap'),
    outline: getComputedStyle(vb).outlineColor,
    badge: badge.classList.contains('opacity-0') ? null : badge.innerText,
    box: { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, ratio: r.width / r.height },
  };
});

test('every target ratio shows the green frame and its label; others do not', async ({ page, browser }) => {
  await setupFree(page, browser);
  // pixel aspect = (w*1600)/(h*1200); with h = 0.4 -> w = ratio * 0.3
  for (const t of SNAP_TARGETS) {
    await page.evaluate((r) => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.02, y: 0.3, width: r * 0.3, height: 0.4 }), t.ratio * 0.995);
    await page.waitForTimeout(120);
    const s = await frameState(page);
    expect(s.green, `${t.id} green`).toBe(true);
    expect(s.outline, `${t.id} outline`).toBe('rgba(34, 197, 94, 0.9)');
    expect(s.badge?.toUpperCase(), `${t.id} label`).toBe(t.label.toUpperCase());
  }
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.1, y: 0.3, width: 1.2 * 0.3, height: 0.4 }));
  await page.waitForTimeout(120);
  const off = await frameState(page);
  expect(off.green).toBe(false);
  expect(off.badge).toBeNull();
});

/** Drags the crop box's bottom-right handle so the box becomes `ratio`, keeping its current height. Returns state mid-drag and after release. */
async function dragToRatio(page: Page, ratio: number) {
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.3, y: 0.35, width: 0.15, height: 0.2 }));
  await page.waitForTimeout(150);
  const start = await frameState(page);
  const handle = (await page.locator('#image-container .cropper-point.point-se').boundingBox())!;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  const left = start.box.cx - start.box.w / 2;
  const targetX = left + start.box.h * ratio;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(targetX, hy, { steps: 12 });
  const mid = await frameState(page);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await frameState(page);
  return { mid, after };
}

test('dragging near 16:9 turns green mid-drag and snaps exactly on release (center kept, carried into export)', async ({ page, browser }) => {
  await setupFree(page, browser);
  const { mid, after } = await dragToRatio(page, 1.745);
  expect(mid.green, 'green while dragging').toBe(true);
  expect(Math.abs(mid.box.ratio - 16 / 9) / (16 / 9), 'not yet snapped mid-drag').toBeGreaterThan(0.005);
  expect(Math.abs(after.box.ratio - 16 / 9) / (16 / 9), 'exact 16:9 after release').toBeLessThan(0.002);
  expect(Math.abs(after.box.cx - mid.box.cx), 'center x kept').toBeLessThan(2);
  expect(Math.abs(after.box.cy - mid.box.cy), 'center y kept').toBeLessThan(2);
  expect(after.badge?.toUpperCase()).toBe('16:9 LANDSCAPE');

  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');
  await page.selectOption('#exportQuality', 'png');
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 30000 });
  const [w, h] = await page.locator('.export-img-item').first().evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  expect(Math.abs(w / h - 16 / 9) / (16 / 9), `export ${w}x${h} is 16:9`).toBeLessThan(0.003);
});

test('dragging near 2.39:1 snaps to cinemascope', async ({ page, browser }) => {
  await setupFree(page, browser);
  const { after } = await dragToRatio(page, 2.36);
  expect(Math.abs(after.box.ratio - 2.39) / 2.39).toBeLessThan(0.002);
});

test('dragging to a non-target ratio neither turns green nor snaps', async ({ page, browser }) => {
  await setupFree(page, browser);
  const { mid, after } = await dragToRatio(page, 1.2);
  expect(mid.green).toBe(false);
  expect(after.green).toBe(false);
  expect(Math.abs(after.box.ratio - mid.box.ratio) / mid.box.ratio, 'left alone').toBeLessThan(0.003);
});

test('with a locked ratio (not Free), the frame never turns green', async ({ page, browser }) => {
  await setupFree(page, browser);
  await page.selectOption('#select-ratio', '0.8');
  await page.waitForTimeout(200);
  const s = await frameState(page);
  expect(Math.abs(s.box.ratio - 0.8)).toBeLessThan(0.01);
  expect(s.green).toBe(false);
  expect(s.badge).toBeNull();
});
