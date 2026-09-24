import { test, expect } from '@playwright/test';
import { createTestImageBuffer } from './fixtures/generate-test-image';

// iOS Safari caps a single canvas at 16,777,216 px (4096²); anything larger
// fails silently or throws. Exporting a small crop of a big, heavily
// desqueezed photo must never allocate a canvas the size of the whole photo.
const IOS_CANVAS_LIMIT = 16_777_216;

test('export of a small crop from a 6000x4000 @ 2.0x photo stays under the iOS canvas limit', async ({ page, browser }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __maxCanvasArea: number };
    w.__maxCanvasArea = 0;
    for (const prop of ['width', 'height'] as const) {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop)!;
      Object.defineProperty(HTMLCanvasElement.prototype, prop, {
        configurable: true,
        get: d.get,
        set(v: number) {
          d.set!.call(this, v);
          w.__maxCanvasArea = Math.max(w.__maxCanvasArea, this.width * this.height);
        },
      });
    }
  });
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: await createTestImageBuffer(browser, 6000, 4000) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.selectOption('#select-ratio', 'NaN');
  await page.selectOption('#select-squeeze', '200');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.4, y: 0.4, width: 0.25, height: 0.25 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');
  await page.selectOption('#exportQuality', 'png');

  await page.evaluate(() => { (window as unknown as { __maxCanvasArea: number }).__maxCanvasArea = 0; });
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 60000 });
  const peak = await page.evaluate(() => (window as unknown as { __maxCanvasArea: number }).__maxCanvasArea);
  const out = await page.locator('.export-img-item').first().evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);

  // 25% of a 12000x4000 desqueezed frame = 3000x1000 native pixels.
  expect(out[0]).toBe(3000);
  expect(peak, `peak canvas area during export (${peak} px)`).toBeLessThan(IOS_CANVAS_LIMIT);
});
