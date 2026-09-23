import { test, expect } from '@playwright/test';
import { uploadTestImage } from './fixtures/generate-test-image';
import './fixtures/debug-types';

test('rotating 90 degrees four times returns crop scale/position to initial', async ({ page }) => {
  await page.goto('/');
  await uploadTestImage(page, page.context().browser()!, 6000, 4000);

  const baseline = await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState().crop);

  for (let i = 0; i < 4; i++) {
    await page.click('#btn-rotate-90');
    await page.waitForTimeout(150);
  }

  const state = await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());
  expect(state.rotation.base % 360).toBe(0);
  expect(state.crop.x).toBeCloseTo(baseline.x, 6);
  expect(state.crop.y).toBeCloseTo(baseline.y, 6);
  expect(state.crop.width).toBeCloseTo(baseline.width, 6);
  expect(state.crop.height).toBeCloseTo(baseline.height, 6);
});
