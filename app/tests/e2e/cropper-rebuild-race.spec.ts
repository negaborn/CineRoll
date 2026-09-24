import { test, expect } from '@playwright/test';
import { createTestImageBuffer } from './fixtures/generate-test-image';

// Every squeeze change schedules its own async Cropper rebuild. Changing it
// twice in quick succession used to overlap two rebuilds: the older one would
// build Cropper on an <img> the newer one had already detached (Cropper.js:
// "Cannot read properties of null (reading 'insertBefore')"), and which
// instance survived depended on timing. Superseded rebuilds must now cancel.
test.setTimeout(5 * 60 * 1000);

const RUNS = 12;

test(`rapid squeeze changes never overlap Cropper rebuilds (${RUNS} runs)`, async ({ browser }) => {
  const buf = await createTestImageBuffer(browser, 6000, 4000);
  const failures: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:5183' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.setInputFiles('#upload-input', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: buf });
    await page.waitForSelector('.cropper-container', { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.selectOption('#select-squeeze', '200');
    await page.waitForTimeout(20 + (i % 5) * 20); // 20..100ms between the two changes
    await page.selectOption('#select-squeeze', '100');
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('#image-container .cropper-canvas img')) as HTMLImageElement[];
      return {
        containers: document.querySelectorAll('#image-container .cropper-container').length,
        proxyRatio: imgs[0] ? imgs[0].naturalWidth / imgs[0].naturalHeight : null,
        stateSqueeze: window.__CINEROLL_DEBUG__!.getState().squeeze,
      };
    });
    // squeeze 100 on a 6000x4000 source => proxy ratio 1.5
    if (errors.length) failures.push(`#${i + 1} page error: ${errors[0].slice(0, 70)}`);
    if (r.containers !== 1) failures.push(`#${i + 1} ${r.containers} cropper containers`);
    if (r.proxyRatio === null || Math.abs(r.proxyRatio - 1.5) > 0.01) failures.push(`#${i + 1} cropper shows ratio ${r.proxyRatio}, expected 1.5`);
    if (r.stateSqueeze !== 100) failures.push(`#${i + 1} state squeeze ${r.stateSqueeze}`);
    await ctx.close();
  }
  expect(failures, failures.join('\n')).toEqual([]);
});
