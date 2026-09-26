import { test, expect, type Page, type Browser } from '@playwright/test';
import { makePositionImage, makeSolidPng, sampleExport, samplePreview } from './fixtures/position-image';
import { previewStats, exportStats, runExport, closeExport, meanDiff, setControl } from './fixtures/pixels';

// EditState must be the single source of truth for every edit setting:
// controls write it, preview/export read only from it, and changing it
// updates the controls. Plus two state/view desync bugs found while mapping
// the code (reset after a 90-degree rotate; a second photo on the Format tab).

const state = (page: Page) => page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());

async function start(page: Page, browser: Browser, buf?: Buffer) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'src.png', mimeType: 'image/png', buffer: buf ?? await makePositionImage(browser, 1600, 1200) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
}

test('every edit control is reflected in EditState immediately', async ({ page, browser }) => {
  await start(page, browser);
  const tick = () => page.waitForTimeout(60);

  await page.click('#strategy-btns [data-val="triptych"]'); await tick();
  expect((await state(page)).strategy).toBe('triptych');
  await setControl(page, '#select-ratio', '1.5', ['change']); await tick();
  expect((await state(page)).baseRatio).toBe(1.5);
  await setControl(page, '#select-slides', '4', ['change']); await tick();
  expect((await state(page)).slides).toBe(4);
  await setControl(page, '#select-squeeze', '150', ['change']); await tick();
  expect((await state(page)).squeeze, 'squeeze in state right away, not only after the rebuild').toBe(150);
  await page.waitForTimeout(800);
  await page.click('#strategy-btns [data-val="single"]');
  await setControl(page, '#select-ratio', 'NaN', ['change']);
  await page.waitForTimeout(200);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');

  await page.click('[data-tab="frame"]');
  await page.click('[data-bg="#ffffff"]'); await tick();
  await page.click('#btn-margin'); await tick();
  await setControl(page, '#slider-margin-scale', '70'); await tick();
  await setControl(page, '#select-border', 'fineart', ['change']); await tick();
  await setControl(page, '#slider-borderWeight', '6'); await tick();
  expect((await state(page)).frame).toEqual({ margin: true, marginScale: 0.7, bgColor: '#ffffff', border: 'fineart', borderWeight: 6 });

  await page.click('[data-tab="color"]');
  await setControl(page, '#slider-br', '120'); await setControl(page, '#slider-co', '90');
  await setControl(page, '#slider-sa', '110'); await setControl(page, '#slider-grain', '30'); await tick();
  await page.click('[data-tab="tone"]');
  await setControl(page, '#select-lut', 'fuji', ['change']);
  await setControl(page, '#slider-lut-intensity', '70');
  await setControl(page, '#slider-hl', '20');
  await setControl(page, '#slider-sh', '-10');
  await page.waitForFunction(() => document.getElementById('loading-overlay')!.classList.contains('hidden'));
  const tone = (await state(page)).tone;
  expect({ lut: tone.lut, lutIntensity: tone.lutIntensity, highlights: tone.highlights, shadows: tone.shadows, brightness: tone.brightness, contrast: tone.contrast, saturation: tone.saturation, grain: tone.grain })
    .toEqual({ lut: 'fuji', lutIntensity: 70, highlights: 20, shadows: -10, brightness: 120, contrast: 90, saturation: 110, grain: 30 });

  await page.click('[data-tab="typo"]');
  await page.fill('#watermarkText', 'HELLO');
  await setControl(page, '#fontSelect', 'Cinzel', ['change']);
  await setControl(page, '#textColorPicker', '#123456', ['input']);
  await page.click('#btnBold'); await page.click('#btnGlow');
  await setControl(page, '#slider-glow-amount', '30');
  await setControl(page, '#slider-fontScale', '150');
  await setControl(page, '#watermarkTarget', '2', ['change']); await tick();
  const typo = (await state(page)).typo;
  expect({ text: typo.text, font: typo.font, color: typo.color.toLowerCase(), bold: typo.bold, glow: typo.glow, glowAmount: typo.glowAmount, fontScale: typo.fontScale, target: typo.target, preset: typo.preset })
    .toEqual({ text: 'HELLO', font: 'Cinzel', color: '#123456', bold: true, glow: false, glowAmount: 30, fontScale: 150, target: 2, preset: 'none' });
  await page.click('#btn-preset-gold'); await tick();
  expect((await state(page)).typo.preset).toBe('gold');

  await page.setInputFiles('#uploadLogo', { name: 'logo.png', mimeType: 'image/png', buffer: await makeSolidPng(browser, 300, 150, '#00ffff') });
  await page.waitForTimeout(300);
  await setControl(page, '#sliderLogoScale', '60'); await setControl(page, '#sliderLogoOp', '40'); await tick();
  let logo = (await state(page)).logo;
  expect({ enabled: logo.enabled, scale: logo.scale, opacity: logo.opacity }).toEqual({ enabled: true, scale: 60, opacity: 40 });
  await page.click('#toggle-logo'); await tick();
  logo = (await state(page)).logo;
  expect(logo.enabled).toBe(false);
  await page.locator('#toggleAppLogo').evaluate((el: HTMLInputElement) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }); await tick();
  expect((await state(page)).appWatermark).toBe(true);

  // Caption position: select it and nudge with the arrow keys.
  await setControl(page, '#watermarkTarget', 'all', ['change']);
  const hit = page.locator('.draggable-text').first();
  const box = (await hit.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const x0 = (await state(page)).typo.pos.x;
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await tick();
  expect((await state(page)).typo.pos.x).toBeCloseTo(x0 + 1, 5);
});

test('changing EditState drives the controls, the preview and the export (the DOM is not read)', async ({ page, browser }) => {
  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#404040'));
  await page.click('#strategy-btns [data-val="single"]');
  await setControl(page, '#select-ratio', 'NaN', ['change']);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForTimeout(300);

  await page.evaluate(() => window.__CINEROLL_DEBUG__!.updateState!({
    frame: { margin: true, bgColor: '#ffffff', marginScale: 0.7 },
    tone: { brightness: 130 },
    typo: { text: 'FROM STATE', color: '#ff00ff', glow: false, bold: true, fontScale: 200 },
  }));
  await page.waitForTimeout(300);
  expect(await page.locator('#btn-margin').getAttribute('class')).toContain('active');
  expect(await page.inputValue('#slider-margin-scale')).toBe('70');
  expect(await page.inputValue('#slider-br')).toBe('130');
  expect(await page.inputValue('#watermarkText')).toBe('FROM STATE');
  const p = await previewStats(page);
  expect(p.white, 'margin drawn from state').toBeGreaterThan(0.2);
  expect(p.magenta, 'caption drawn from state').toBeGreaterThan(0.001);

  // Tamper with the controls without firing events: output must still follow EditState.
  await page.evaluate(() => {
    (document.getElementById('slider-br') as HTMLInputElement).value = '60';
    (document.getElementById('watermarkText') as HTMLInputElement).value = '';
    (document.getElementById('slider-margin-scale') as HTMLInputElement).value = '100';
  });
  await runExport(page);
  const e = await exportStats(page);
  expect(meanDiff(p, e), 'export matches the state-driven preview').toBeLessThan(6);
  expect(e.magenta, 'caption from state, not the emptied text box').toBeGreaterThan(0.001);
  expect(e.white, 'margin from state, not the tampered slider').toBeGreaterThan(0.2);
  expect((await state(page)).tone.brightness).toBe(130);
});

test('loading a saved preset updates EditState', async ({ page, browser }) => {
  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#303030'));
  await page.evaluate(() => localStorage.setItem('cineroll_presets_v4', JSON.stringify([{ id: 1, text: 'PRESET', color: '#ff0000', bold: true, glow: false, font: 'Lora', glowAmt: '22', type: 'silver' }])));
  await page.reload();
  await start(page, browser, await makeSolidPng(browser, 1600, 1200, '#303030'));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.click('[data-tab="typo"]');
  await page.locator('.preset-chip', { hasText: 'PRESET' }).locator('div').first().click();
  await page.waitForTimeout(200);
  const t = (await state(page)).typo;
  expect({ text: t.text, font: t.font, bold: t.bold, glow: t.glow, glowAmount: t.glowAmount, preset: t.preset }).toEqual({ text: 'PRESET', font: 'Lora', bold: true, glow: false, glowAmount: 22, preset: 'silver' });
});

test('Reset framing after a 90-degree rotate keeps the Cropper view and the state in agreement', async ({ page, browser }) => {
  await start(page, browser);
  await page.click('#strategy-btns [data-val="single"]');
  await setControl(page, '#select-ratio', 'NaN', ['change']);
  await page.click('#btn-rotate-90');
  await page.waitForTimeout(600);
  await page.click('#btn-reset-framing');
  await page.waitForTimeout(900);
  const view = await page.evaluate(() => { const i = document.querySelector('#image-container .cropper-canvas img') as HTMLImageElement; return i.naturalWidth / i.naturalHeight; });
  expect((await state(page)).rotation.base).toBe(0);
  expect(view, 'cropper shows the un-rotated (landscape) photo').toBeGreaterThan(1);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForTimeout(300);
  const preview = await samplePreview(page);
  await runExport(page);
  const exported = await sampleExport(page);
  const worst = Math.max(...preview.samples.map((s, i) => Math.max(Math.abs(s.r - exported.samples[i].r), Math.abs(s.g - exported.samples[i].g)) / 255));
  expect(worst, 'preview and export show the same pixels').toBeLessThan(0.05);
});

test('a second photo uploaded while on the Format tab replaces the first everywhere', async ({ page, browser }) => {
  await start(page, browser);
  await page.setInputFiles('#upload-input', { name: 'green.png', mimeType: 'image/png', buffer: await makeSolidPng(browser, 1000, 1000, '#00ff00') });
  await page.waitForTimeout(1200);
  const view = await page.evaluate(() => { const i = document.querySelector('#image-container .cropper-canvas img') as HTMLImageElement; return i.naturalWidth / i.naturalHeight; });
  expect(view, 'cropper shows the new square photo').toBeCloseTo(1, 2);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForTimeout(300);
  const p = await previewStats(page);
  expect(p.mean[1], 'preview is the green photo').toBeGreaterThan(200);
  await runExport(page);
  const e = await exportStats(page);
  expect(e.mean[1], 'export is the green photo').toBeGreaterThan(200);
  expect(e.mean[0]).toBeLessThan(40);
  await closeExport(page);
});
