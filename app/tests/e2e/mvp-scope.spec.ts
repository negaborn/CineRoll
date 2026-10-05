import { test, expect } from '@playwright/test';

// MVP scope (decided 2026-10-05, P2-3): Triptych is hidden for the MVP. It
// sliced a 4:5 crop into three 4:15 strips (same as v150), which Instagram's
// feed (4:5 at its tallest) would crop to a third. The code stays; only the
// option is not offered.

test('only Seamless and Single are offered as strategies', async ({ page }) => {
  await page.goto('/');
  const visible = await page.$$eval('#strategy-btns .min-btn', (bs) => bs.filter((b) => (b as HTMLElement).offsetParent !== null).map((b) => (b as HTMLElement).dataset.val));
  expect(visible).toEqual(['seamless', 'single']);
});
