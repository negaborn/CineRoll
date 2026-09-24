import { test, expect } from '@playwright/test';
import { makePositionImage } from './fixtures/position-image';

// The caption is painted on a canvas, which (unlike DOM text) doesn't reflow
// when a web font finishes loading. Picking a not-yet-loaded font must still
// end up painted in that font without the user touching anything else.
test('caption canvas repaints once a newly selected web font has loaded', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: await makePositionImage(browser, 1600, 1200) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');
  await page.click('[data-tab="typo"]');
  await page.fill('#watermarkText', 'WIDE HEADLINE TEXT');
  await page.selectOption('#fontSelect', 'Bebas Neue');
  await page.waitForTimeout(2500);

  const loaded = await page.evaluate(() => document.fonts.check("16px 'Bebas Neue'"));
  test.skip(!loaded, 'Google Fonts unreachable in this environment');

  const snapshot = () => page.evaluate(() => (document.querySelector('.preview-slide-canvas') as HTMLCanvasElement).toDataURL());
  const settled = await snapshot();
  // Force a redraw with nothing changed: if the canvas differs, the settled
  // frame was still painted in the fallback font.
  await page.evaluate(() => document.getElementById('slider-grain')!.dispatchEvent(new Event('input')));
  await page.waitForTimeout(200);
  expect(await snapshot() === settled, 'canvas was stale (fallback font) until an unrelated redraw').toBe(true);
});
