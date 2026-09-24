import { test, expect, type Page, type Browser } from '@playwright/test';
import { makePositionImage, makeSolidPng } from './fixtures/position-image';
import { previewStats, exportStats, previewCount, runExport, closeExport, meanDiff, setControl } from './fixtures/pixels';

// Characterization: pins down how strategy / frame / color / tone / typo /
// logo settings look today -- in the preview and in the export -- so moving
// them into EditState can't silently change what the user sees.

async function start(page: Page, browser: Browser, buf: Buffer, strategy: 'single' | 'seamless' | 'triptych' = 'single') {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'src.png', mimeType: 'image/png', buffer: buf });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click(`#strategy-btns [data-val="${strategy}"]`);
  if (strategy === 'single') await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(200);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForTimeout(300);
  void browser;
}

test('color: brightness/contrast/saturation and a CSS LUT look the same in preview and export', async ({ page, browser }) => {
  await start(page, browser, await makePositionImage(browser, 1600, 1200));
  const base = await previewStats(page);
  await page.click('[data-tab="color"]');
  await setControl(page, '#slider-br', '130');
  await setControl(page, '#slider-co', '80');
  await setControl(page, '#slider-sa', '0');
  await page.waitForTimeout(200);
  const p = await previewStats(page);
  expect(p.sat, 'saturation 0 -> grayscale preview').toBeLessThan(6);
  expect(p.mean[0], 'brighter than baseline').toBeGreaterThan(base.mean[0]);
  await runExport(page);
  const e = await exportStats(page);
  expect(e.sat, 'grayscale export').toBeLessThan(6);
  expect(meanDiff(p, e), 'preview vs export mean color').toBeLessThan(6);
  await closeExport(page);

  await page.click('#btn-reset-color');
  await page.click('[data-tab="tone"]');
  await setControl(page, '#select-lut', 'kodak', ['change']);
  await setControl(page, '#slider-lut-intensity', '60', ['input', 'change']);
  await page.waitForTimeout(400);
  const pl = await previewStats(page);
  expect(meanDiff(pl, base), 'LUT changes the look').toBeGreaterThan(4);
  await runExport(page);
  expect(meanDiff(pl, await exportStats(page)), 'LUT preview vs export').toBeLessThan(6);
});

test('tone: WebGL highlights look the same in preview and export', async ({ page, browser }) => {
  await start(page, browser, await makePositionImage(browser, 1600, 1200));
  const base = await previewStats(page);
  await page.click('[data-tab="tone"]');
  await setControl(page, '#slider-hl', '60', ['input', 'change']);
  await page.waitForFunction(() => document.getElementById('loading-overlay')!.classList.contains('hidden'));
  await page.waitForTimeout(400);
  const p = await previewStats(page);
  expect(p.mean[1], 'highlights lift the image').toBeGreaterThan(base.mean[1] + 2);
  await runExport(page);
  expect(meanDiff(p, await exportStats(page))).toBeLessThan(6);
});

test('grain appears in both preview and export', async ({ page, browser }) => {
  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#808080'));
  expect((await previewStats(page)).lumaStd).toBeLessThan(2);
  await page.click('[data-tab="color"]');
  await setControl(page, '#slider-grain', '60');
  await page.waitForTimeout(200);
  expect((await previewStats(page)).lumaStd, 'grainy preview').toBeGreaterThan(8);
  await runExport(page);
  expect((await exportStats(page)).lumaStd, 'grainy export').toBeGreaterThan(8);
});

for (const strategy of ['seamless', 'triptych'] as const) {
  test(`${strategy}: margin + border on every slide, caption only on the targeted slide`, async ({ page, browser }) => {
    await start(page, browser, await makeSolidPng(browser, 2400, 1000, '#404040'), strategy);
    expect(await previewCount(page)).toBe(3);
    await page.click('[data-tab="frame"]');
    await page.click('[data-bg="#ffffff"]');
    await page.click('#btn-margin');
    await setControl(page, '#select-border', 'fineart', ['change']);
    await page.click('[data-tab="typo"]');
    await page.fill('#watermarkText', 'SLIDE TWO');
    await setControl(page, '#textColorPicker', '#ff00ff', ['input']);
    await page.click('#btnGlow');
    await page.click('#btnBold');
    await setControl(page, '#slider-fontScale', '200'); // big enough for solid, measurable strokes
    await setControl(page, '#watermarkTarget', '2', ['change']);
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      const s = await previewStats(page, i);
      expect(s.white, `preview slide ${i + 1} has a white margin`).toBeGreaterThan(0.1);
      expect(s.magenta > 0.0005, `preview slide ${i + 1} caption`).toBe(i === 1);
    }
    expect(await runExport(page)).toBe(3);
    for (let i = 0; i < 3; i++) {
      const s = await exportStats(page, i);
      expect(s.white, `export slide ${i + 1} has a white margin`).toBeGreaterThan(0.1);
      expect(s.magenta > 0.0005, `export slide ${i + 1} caption`).toBe(i === 1);
    }
  });
}

test('presets: save, reload the page, load -- caption settings come back', async ({ page, browser }) => {
  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#303030'));
  await page.evaluate(() => localStorage.removeItem('cineroll_presets_v4'));
  await page.click('[data-tab="typo"]');
  await page.fill('#watermarkText', 'MY SIGNATURE');
  await setControl(page, '#fontSelect', 'Oswald', ['change']);
  await page.click('#btnBold');
  await page.click('#btn-preset-gold');
  await page.click('#btn-save-preset');

  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#303030'));
  const blank = await previewStats(page, 0, [0.2, 0.85, 0.8, 1]);
  await page.click('[data-tab="typo"]');
  await page.locator('.preset-chip', { hasText: 'MY SIGNATURE' }).locator('div').first().click();
  await page.waitForTimeout(300);
  expect(await page.inputValue('#watermarkText')).toBe('MY SIGNATURE');
  expect(await page.inputValue('#fontSelect')).toBe('Oswald');
  expect(await page.locator('#btnBold').getAttribute('class')).toContain('active');
  expect(await page.locator('#btn-preset-gold').getAttribute('class')).toContain('active');
  const s = await previewStats(page, 0, [0.2, 0.85, 0.8, 1]);
  expect(blank.sat, 'no caption before loading').toBeLessThan(0.5);
  expect(s.sat, 'gold caption painted').toBeGreaterThan(1);
});

test('reset buttons restore defaults in controls and preview', async ({ page, browser }) => {
  await start(page, browser, await makePositionImage(browser, 1600, 1200));
  const base = await previewStats(page);
  await page.click('[data-tab="color"]');
  await setControl(page, '#slider-br', '140');
  await setControl(page, '#slider-grain', '50');
  await page.click('#btn-reset-color');
  await page.click('[data-tab="tone"]');
  await setControl(page, '#select-lut', 'fuji', ['change']);
  await page.waitForTimeout(300);
  await page.click('#btn-reset-tone');
  await page.waitForTimeout(400);
  expect(await page.inputValue('#slider-br')).toBe('100');
  expect(await page.inputValue('#slider-grain')).toBe('0');
  expect(await page.inputValue('#select-lut')).toBe('none');
  expect(meanDiff(await previewStats(page), base)).toBeLessThan(2);
});

test('logo and app watermark toggles show/hide them in preview and export', async ({ page, browser }) => {
  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#000000'));
  await page.click('[data-tab="typo"]');
  await page.setInputFiles('#uploadLogo', { name: 'logo.png', mimeType: 'image/png', buffer: await makeSolidPng(browser, 300, 150, '#00ffff') });
  await page.waitForTimeout(400);
  expect((await previewStats(page)).cyan, 'logo on').toBeGreaterThan(0.001);
  await page.click('#toggle-logo');
  await page.waitForTimeout(200);
  expect((await previewStats(page)).cyan, 'logo off').toBe(0);
  await runExport(page);
  expect((await exportStats(page)).cyan, 'logo off in export').toBe(0);
  await closeExport(page);
  await page.click('#toggle-logo');
  await page.waitForTimeout(200);
  expect((await previewStats(page)).cyan, 'logo back on').toBeGreaterThan(0.001);

  const corner = [0.6, 0.85, 1, 1] as [number, number, number, number];
  const before = (await previewStats(page, 0, corner)).mean[0];
  await page.locator('#toggleAppLogo').evaluate((el: HTMLInputElement) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(200);
  expect((await previewStats(page, 0, corner)).mean[0], 'watermark on').toBeGreaterThan(before + 1);
  await runExport(page);
  expect((await exportStats(page, 0, corner)).mean[0], 'watermark in export').toBeGreaterThan(before + 1);
});
