import { test, expect } from '@playwright/test';
import { uploadTestImage } from './fixtures/generate-test-image';
import './fixtures/debug-types';

test('changing ratio/slides/squeeze preserves the crop center', async ({ page }) => {
  await page.goto('/');
  await uploadTestImage(page, page.context().browser()!, 6000, 4000);

  // Use the Single strategy so the target aspect is the raw ratio value,
  // not ratio*slides (which would blow the crop past [0,1] and hit the
  // documented clamp path -- this test targets the non-boundary case).
  await page.click('#strategy-btns [data-val="single"]');
  // Free ratio while seeding the rect, so Cropper.js doesn't coerce it to
  // whatever aspect happened to be locked -- the ratio change below is the
  // thing actually under test.
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.1, y: 0.2, width: 0.3, height: 0.3 }));
  const centerBefore = await page.evaluate(() => {
    const c = window.__CINEROLL_DEBUG__!.getState().crop;
    return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  });

  await page.selectOption('#select-ratio', '1.5');
  await page.waitForTimeout(200);

  const centerAfterRatio = await page.evaluate(() => {
    const c = window.__CINEROLL_DEBUG__!.getState().crop;
    return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  });
  expect(centerAfterRatio.x).toBeCloseTo(centerBefore.x, 2);
  expect(centerAfterRatio.y).toBeCloseTo(centerBefore.y, 2);

  await page.selectOption('#select-squeeze', '150');
  await page.waitForTimeout(300);

  const centerAfterSqueeze = await page.evaluate(() => {
    const c = window.__CINEROLL_DEBUG__!.getState().crop;
    return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  });
  expect(centerAfterSqueeze.x).toBeCloseTo(centerBefore.x, 2);
  expect(centerAfterSqueeze.y).toBeCloseTo(centerBefore.y, 2);
});
