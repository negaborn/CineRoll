import { test, expect } from '@playwright/test';
import { makePositionImage } from './fixtures/position-image';

// Current (v150) behavior: in Free ratio mode, a crop box near a known ratio
// shows a green label badge. It does not snap the box or recolor the frame.
test('smart-snap badge labels crop boxes near known ratios in Free mode', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: await makePositionImage(browser, 1600, 1200) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(150);

  // pixel aspect = (w*1600)/(h*1200); with h = 0.5 → w = aspect * 0.375
  const badgeFor = async (aspect: number) => {
    await page.evaluate((a) => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.1, y: 0.2, width: a * 0.375, height: 0.5 }), aspect);
    await page.waitForTimeout(150);
    return page.evaluate(() => {
      const b = document.getElementById('smart-snap-badge')!;
      return b.classList.contains('opacity-0') ? null : b.innerText.toUpperCase();
    });
  };

  expect(await badgeFor(1.76)).toBe('16:9 LANDSCAPE');
  expect(await badgeFor(0.8)).toBe('4:5 VERTICAL IG');
  expect(await badgeFor(1.0)).toBe('1:1 SQUARE');
  expect(await badgeFor(1.5)).toBe('3:2 HORIZONTAL');
  expect(await badgeFor(1.2)).toBeNull();
});
