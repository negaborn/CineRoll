import { test, expect } from '@playwright/test';
import { makePositionImage, sampleExport, samplePreview, maxPositionErrorStraightened } from './fixtures/position-image';

// The Straighten slider must affect preview and export identically, and both
// must land on the right source pixels -- including after a 90° base rotation
// (which is already baked into the crop proxy and must not be applied twice).
const CASES = [
  { name: 'no base rotation, +10°', rot90: 0, fine: 10, squeeze: '100' },
  { name: 'base 90°, -8°', rot90: 1, fine: -8, squeeze: '100' },
  { name: 'base 0°, +6°, 1.33x squeeze', rot90: 0, fine: 6, squeeze: '133' },
];
const CROP = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };

for (const c of CASES) {
  test(`straighten: ${c.name}`, async ({ page, browser }) => {
    await page.goto('/');
    await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: await makePositionImage(browser, 1600, 1200) });
    await page.waitForSelector('.cropper-container');
    await page.waitForTimeout(300);
    await page.click('#strategy-btns [data-val="single"]');
    await page.selectOption('#select-ratio', 'NaN');
    await page.selectOption('#select-squeeze', c.squeeze);
    await page.waitForTimeout(600);
    for (let i = 0; i < c.rot90; i++) { await page.click('#btn-rotate-90'); await page.waitForTimeout(400); }
    await page.evaluate((deg) => { const s = document.getElementById('slider-angle') as HTMLInputElement; s.value = String(deg); s.dispatchEvent(new Event('input')); }, c.fine);
    await page.waitForTimeout(300);
    await page.evaluate((r) => window.__CINEROLL_DEBUG__!.setCropForTest(r), CROP);
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());
    await page.click('#btn-apply-crop');
    await page.waitForSelector('#tab-frame:not(.hidden)');
    await page.waitForTimeout(300);
    const preview = await samplePreview(page);
    await page.selectOption('#exportQuality', 'png');
    await page.click('#btn-export');
    await page.waitForSelector('#export-modal.show', { timeout: 30000 });
    const exported = await sampleExport(page);

    expect(st.rotation.fine).toBe(c.fine);
    const args = [1600, 1200, Number(c.squeeze), st.rotation.base, st.rotation.fine] as const;
    expect(maxPositionErrorStraightened(preview, st.crop, ...args), 'preview position').toBeLessThan(0.03);
    expect(maxPositionErrorStraightened(exported, st.crop, ...args), 'export position').toBeLessThan(0.02);
    expect(Math.abs(preview.w / preview.h - exported.w / exported.h) / (exported.w / exported.h), 'aspect parity').toBeLessThan(0.02);
  });
}
