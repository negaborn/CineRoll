import { test, expect, type Page } from '@playwright/test';
import { makePositionImage, sampleExport, samplePreview, maxPositionError } from './fixtures/position-image';

// Every source aspect ratio x base rotation x desqueeze: the crop must land on
// exactly the right source pixels (decoded from the position-coded image) in
// both the preview and the Lossless export, at the right aspect ratio.

const FORMATS = [
  { name: 'portrait 3:4', w: 1200, h: 1600 },
  { name: 'landscape 4:3', w: 1600, h: 1200 },
  { name: 'square 1:1', w: 1400, h: 1400 },
  { name: 'panorama 5:1', w: 4000, h: 800 },
  { name: 'tall 1:4', w: 700, h: 2800 },
];
const COMBOS = [
  { rot90: 0, squeeze: '100' },
  { rot90: 1, squeeze: '133' },
  { rot90: 3, squeeze: '200' },
];
const CROP = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 };

async function runPipeline(page: Page, buf: Buffer, rot90: number, squeeze: string) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'pos.png', mimeType: 'image/png', buffer: buf });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.selectOption('#select-ratio', 'NaN');
  await page.selectOption('#select-squeeze', squeeze);
  await page.waitForTimeout(600);
  for (let i = 0; i < rot90; i++) { await page.click('#btn-rotate-90'); await page.waitForTimeout(350); }
  await page.evaluate((c) => window.__CINEROLL_DEBUG__!.setCropForTest(c), CROP);
  const stateAtApply = await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');
  await page.waitForTimeout(300);
  const preview = await samplePreview(page);
  await page.selectOption('#exportQuality', 'png');
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 30000 });
  const exported = await sampleExport(page);
  return { stateAtApply, preview, exported };
}

for (const f of FORMATS) {
  for (const c of COMBOS) {
    test(`${f.name} · rot ${c.rot90 * 90}° · squeeze ${c.squeeze}`, async ({ page, browser }) => {
      const buf = await makePositionImage(browser, f.w, f.h);
      const { stateAtApply, preview, exported } = await runPipeline(page, buf, c.rot90, c.squeeze);
      const base = stateAtApply.rotation.base;
      const sf = Number(c.squeeze) / 100;
      const rotated = base === 90 || base === 270;
      const planeW = rotated ? f.h : f.w * sf;
      const planeH = rotated ? f.w * sf : f.h;
      const expectedAspect = (stateAtApply.crop.width * planeW) / (stateAtApply.crop.height * planeH);

      const report = {
        exportAspect: exported.w / exported.h,
        previewAspect: preview.w / preview.h,
        exportPosErr: maxPositionError(exported, stateAtApply.crop, base),
        previewPosErr: maxPositionError(preview, stateAtApply.crop, base),
      };

      expect(base).toBe((c.rot90 * 90) % 360);
      expect(stateAtApply.crop.x).toBeCloseTo(CROP.x, 3);
      expect(stateAtApply.crop.width).toBeCloseTo(CROP.width, 3);
      expect(report.exportAspect / expectedAspect).toBeGreaterThan(0.98);
      expect(report.exportAspect / expectedAspect).toBeLessThan(1.02);
      expect(report.previewAspect / expectedAspect).toBeGreaterThan(0.97);
      expect(report.previewAspect / expectedAspect).toBeLessThan(1.03);
      expect(report.exportPosErr).toBeLessThan(0.02);
      expect(report.previewPosErr).toBeLessThan(0.03);
    });
  }
}
