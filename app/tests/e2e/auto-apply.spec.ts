import { test, expect, type Page } from '@playwright/test';
import { makePositionImage, sampleExport, samplePreview, maxPositionError } from './fixtures/position-image';

// Leaving the Format tab must apply the current framing automatically, so the
// preview never shows a stale crop that no longer matches what Export produces.
async function setup(page: Page, buf: Buffer) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: buf });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(150);
}

async function exportSample(page: Page) {
  await page.selectOption('#exportQuality', 'png');
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 30000 });
  return sampleExport(page);
}

test('re-framing then switching tabs without Apply Crop updates the preview', async ({ page, browser }) => {
  await setup(page, await makePositionImage(browser, 1600, 1200));
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.2, y: 0.25, width: 0.5, height: 0.4 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');

  await page.click('[data-tab="format"]');
  await page.waitForTimeout(400);
  const B = { x: 0.05, y: 0.1, width: 0.3, height: 0.8 };
  await page.evaluate((b) => window.__CINEROLL_DEBUG__!.setCropForTest(b), B);
  await page.click('[data-tab="color"]'); // any non-Format tab, not just Frame
  await page.waitForFunction(() => {
    const c = document.querySelector('.preview-slide-canvas') as HTMLCanvasElement | null;
    return !!c && Math.abs(c.width / c.height - 0.5) < 0.02;
  }, null, { timeout: 5000 }).catch(() => {});

  const preview = await samplePreview(page);
  expect(maxPositionError(preview, B, 0), 'preview shows the new crop').toBeLessThan(0.03);
  const exported = await exportSample(page);
  expect(maxPositionError(exported, B, 0), 'export uses the new crop').toBeLessThan(0.02);
  expect(Math.abs(preview.w / preview.h - exported.w / exported.h)).toBeLessThan(0.02);
});

test('going straight from upload to another tab (never pressing Apply) shows the framed preview', async ({ page, browser }) => {
  await setup(page, await makePositionImage(browser, 1600, 1200));
  const A = { x: 0.1, y: 0.2, width: 0.6, height: 0.5 };
  await page.evaluate((a) => window.__CINEROLL_DEBUG__!.setCropForTest(a), A);
  await page.click('[data-tab="frame"]');
  await page.waitForSelector('.preview-slide-canvas', { timeout: 5000 });
  await page.waitForTimeout(300);
  expect(maxPositionError(await samplePreview(page), A, 0)).toBeLessThan(0.03);
});

test('returning to Format and leaving again without changes does not re-render', async ({ page, browser }) => {
  await setup(page, await makePositionImage(browser, 1600, 1200));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');
  await page.waitForTimeout(300);
  await page.evaluate(() => { (document.querySelector('.preview-slide-canvas') as HTMLElement).dataset.marker = 'kept'; });
  await page.click('[data-tab="format"]');
  await page.waitForTimeout(500);
  await page.click('[data-tab="frame"]');
  await page.waitForTimeout(400);
  // Same canvas element still in place => the preview wasn't torn down and rebuilt.
  expect(await page.evaluate(() => (document.querySelector('.preview-slide-canvas') as HTMLElement).dataset.marker)).toBe('kept');
});
