import { test, expect, type Page } from '@playwright/test';
import { makePositionImage } from './fixtures/position-image';
import { previewStats, exportStats, runExport, meanDiff } from './fixtures/pixels';

// Real-device report (2026-09-26): Tone adjustments lagged -- nothing changed
// while dragging a slider, then on release the screen flickered (loading
// overlay) and the change appeared. Every tone/color slider must update
// EditState and the preview *while dragging*, with no loading overlay, and the
// settled preview must still match the export.

/** Mean-color change plus saturation change (desaturation barely moves the mean). */
const change = (a: Awaited<ReturnType<typeof previewStats>>, b: Awaited<ReturnType<typeof previewStats>>) => meanDiff(a, b) + Math.abs(a.sat - b.sat);

const state = (page: Page) => page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());

async function start(page: Page, browser: import('@playwright/test').Browser) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: await makePositionImage(browser, 3000, 2000) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForTimeout(400);
  // Record every moment the full-screen loading overlay becomes visible from here on.
  await page.evaluate(() => {
    const o = document.getElementById('loading-overlay')!;
    (window as unknown as { __overlayShown: number }).__overlayShown = 0;
    new MutationObserver(() => { if (!o.classList.contains('hidden')) (window as unknown as { __overlayShown: number }).__overlayShown++; })
      .observe(o, { attributes: true, attributeFilter: ['class'] });
  });
}
const overlayShown = (page: Page) => page.evaluate(() => (window as unknown as { __overlayShown: number }).__overlayShown);

/** Presses on the slider thumb and drags to `frac` of its range -- the mouse stays down. */
async function dragAndHold(page: Page, sel: string, frac: number) {
  const b = (await page.locator(sel).boundingBox())!;
  const y = b.y + b.height / 2;
  const cur = await page.$eval(sel, (e: HTMLInputElement) => (Number(e.value) - Number(e.min)) / (Number(e.max) - Number(e.min)));
  await page.mouse.move(b.x + b.width * cur, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width * (cur + (frac - cur) * i / 10), y);
}

const cases = [
  { tab: 'tone', sel: '#slider-hl', frac: 0.9, key: 'highlights' },
  { tab: 'tone', sel: '#slider-sh', frac: 0.1, key: 'shadows' },
  { tab: 'color', sel: '#slider-br', frac: 0.85, key: 'brightness' },
  { tab: 'color', sel: '#slider-sa', frac: 0.1, key: 'saturation' },
] as const;

for (const c of cases) {
  test(`${c.sel}: state and preview follow the drag before release, no loading overlay`, async ({ page, browser }) => {
    await start(page, browser);
    await page.click(`[data-tab="${c.tab}"]`);
    const before = await previewStats(page);
    const v0 = (await state(page)).tone[c.key];
    await dragAndHold(page, c.sel, c.frac);
    await page.waitForTimeout(300);
    const slider = Number(await page.inputValue(c.sel));
    expect((await state(page)).tone[c.key], 'EditState follows the thumb while dragging').toBe(slider);
    expect(slider).not.toBe(v0);
    expect(change(before, await previewStats(page)), 'preview changes while dragging').toBeGreaterThan(3);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await overlayShown(page), 'no loading overlay flash').toBe(0);
  });
}

test('LUT intensity (CSS LUT) follows the drag before release', async ({ page, browser }) => {
  await start(page, browser);
  await page.click('[data-tab="tone"]');
  await page.selectOption('#select-lut', 'kodak');
  await page.waitForTimeout(300);
  const before = await previewStats(page);
  await dragAndHold(page, '#slider-lut-intensity', 0.05);
  await page.waitForTimeout(300);
  expect((await state(page)).tone.lutIntensity).toBe(Number(await page.inputValue('#slider-lut-intensity')));
  expect(await page.innerText('#val-lut-intensity')).toBe(`${await page.inputValue('#slider-lut-intensity')}%`);
  expect(change(before, await previewStats(page)), 'preview changes while dragging').toBeGreaterThan(3);
  await page.mouse.up();
  expect(await overlayShown(page)).toBe(0);
});

test('custom .cube LUT intensity follows the drag before release', async ({ page, browser }) => {
  await start(page, browser);
  await page.click('[data-tab="tone"]');
  // 2x2x2 inverting LUT: an obvious change at any intensity.
  const cube = ['LUT_3D_SIZE 2', '1 1 1', '0 1 1', '1 0 1', '0 0 1', '1 1 0', '0 1 0', '1 0 0', '0 0 0'].join('\n');
  await page.setInputFiles('#uploadLut', { name: 'invert.cube', mimeType: 'text/plain', buffer: Buffer.from(cube) });
  await page.waitForFunction(() => window.__CINEROLL_DEBUG__!.getState().tone.lut === 'custom');
  await page.waitForTimeout(500);
  const full = await previewStats(page);
  await dragAndHold(page, '#slider-lut-intensity', 0.5);
  await page.waitForTimeout(400);
  expect((await state(page)).tone.lutIntensity).toBe(Number(await page.inputValue('#slider-lut-intensity')));
  expect(change(full, await previewStats(page)), 'custom LUT preview changes while dragging').toBeGreaterThan(3);
  await page.mouse.up();
});

test('fast scrubbing across all tone sliders settles on the final values -- preview matches export', async ({ page, browser }) => {
  await start(page, browser);
  await page.click('[data-tab="tone"]');
  // Many input events in a row, no waiting in between (like a fast finger).
  await page.evaluate(() => {
    const fire = (id: string, v: number) => { const s = document.getElementById(id) as HTMLInputElement; s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); };
    for (let v = 0; v <= 60; v += 3) fire('slider-hl', v);
    for (let v = 0; v >= -40; v -= 4) fire('slider-sh', v);
  });
  await page.waitForTimeout(800);
  const s = (await state(page)).tone;
  expect([s.highlights, s.shadows]).toEqual([60, -40]);
  const p = await previewStats(page);
  await runExport(page);
  expect(meanDiff(p, await exportStats(page)), 'settled preview == export').toBeLessThan(6);
});
