import { test, expect } from '@playwright/test';
import { uploadTestImage } from './fixtures/generate-test-image';
import './fixtures/debug-types';

test('crop box survives Format -> Frame -> resize -> Format round trip (normalized coords)', async ({ page }) => {
  await page.goto('/');
  await uploadTestImage(page, page.context().browser()!, 6000, 4000);

  // Free (unconstrained) ratio, so the arbitrary rect below isn't coerced by
  // Cropper.js's locked-aspect-ratio enforcement -- this test is about
  // round-tripping the stored rect, not about aspect-ratio semantics.
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.12, y: 0.18, width: 0.4, height: 0.35 }));
  const before = await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState().crop);

  await page.click('[data-tab="frame"]');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(200);
  await page.click('[data-tab="format"]');
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState().crop);

  expect(after.x).toBeCloseTo(before.x, 2);
  expect(after.y).toBeCloseTo(before.y, 2);
  expect(after.width).toBeCloseTo(before.width, 2);
  expect(after.height).toBeCloseTo(before.height, 2);
});
