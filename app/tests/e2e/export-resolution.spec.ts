import { test, expect } from '@playwright/test';
import { uploadTestImage } from './fixtures/generate-test-image';
import './fixtures/debug-types';

test('6000x4000 @ 1.33x squeeze, Lossless export targets a 7980px-based width', async ({ page }) => {
  await page.goto('/');
  await uploadTestImage(page, page.context().browser()!, 6000, 4000);

  await page.click('#strategy-btns [data-val="single"]');
  // Free ratio, so the full-frame rect below isn't coerced by Cropper.js's
  // locked-aspect-ratio enforcement (single strategy defaults to a 4:5 lock).
  await page.selectOption('#select-ratio', 'NaN');
  await page.selectOption('#select-squeeze', '133');
  await page.waitForTimeout(400);

  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');

  await page.selectOption('#exportQuality', 'png');
  await page.click('#btn-export');
  await page.waitForSelector('.export-img-item', { timeout: 20000 });

  const width = await page.locator('.export-img-item').first().evaluate((img: HTMLImageElement) => img.naturalWidth);
  expect(width).toBeGreaterThanOrEqual(7978);
  expect(width).toBeLessThanOrEqual(7982);
});
