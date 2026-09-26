import { test, expect } from '@playwright/test';
import { makePositionImage, sampleExport, samplePreview, maxPositionError, withExifOrientation } from './fixtures/position-image';

// Phone photos store pixels in sensor orientation plus an EXIF Orientation tag.
// The image must be rotated exactly once (not zero, not twice) in both the
// preview and the export. Stored pixels are 800x600, position-coded.
const CASES: { o: number; toStored: (u: number, v: number) => [number, number]; swaps: boolean }[] = [
  { o: 3, toStored: (u, v) => [1 - u, 1 - v], swaps: false }, // 180°
  { o: 6, toStored: (u, v) => [v, 1 - u], swaps: true }, // 90° CW (typical iPhone portrait)
  { o: 8, toStored: (u, v) => [1 - v, u], swaps: true }, // 90° CCW
];
const CROP = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 };

for (const { o, toStored, swaps } of CASES) {
  for (const squeeze of ['100', '133']) {
    test(`EXIF orientation ${o} · squeeze ${squeeze} is applied exactly once`, async ({ page, browser }) => {
      const jpeg = withExifOrientation(await makePositionImage(browser, 800, 600, 'image/jpeg'), o);
      await page.goto('/');
      await page.setInputFiles('#upload-input', { name: 'exif.jpg', mimeType: 'image/jpeg', buffer: jpeg });
      await page.waitForSelector('.cropper-container');
      await page.waitForTimeout(300);
      await page.click('#strategy-btns [data-val="single"]');
      await page.selectOption('#select-ratio', 'NaN');
      await page.selectOption('#select-squeeze', squeeze);
      await page.waitForTimeout(600);
      await page.evaluate((c) => window.__CINEROLL_DEBUG__!.setCropForTest(c), CROP);
      await page.click('#btn-apply-crop');
      await page.waitForSelector('#tab-frame:not(.hidden)');
      await page.waitForTimeout(300);
      const preview = await samplePreview(page);
      await page.selectOption('#exportQuality', 'png');
      await page.click('#btn-export');
      await page.waitForSelector('#export-modal.show', { timeout: 30000 });
      const exported = await sampleExport(page);

      const dispW = ((swaps ? 600 : 800) * Number(squeeze)) / 100;
      const dispH = swaps ? 800 : 600;
      const expectedAspect = (CROP.width * dispW) / (CROP.height * dispH);

      expect(maxPositionError(exported, CROP, 0, toStored)).toBeLessThan(0.03);
      expect(maxPositionError(preview, CROP, 0, toStored)).toBeLessThan(0.04);
      expect(exported.w / exported.h / expectedAspect).toBeGreaterThan(0.98);
      expect(exported.w / exported.h / expectedAspect).toBeLessThan(1.02);
    });
  }
}
