import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { previewStats, meanDiff } from './fixtures/pixels';

// Technical plan v2, P2-4: work is auto-saved to IndexedDB (photo file + every
// setting); on the next visit, a draft younger than 24 h is offered for restore.

const state = (page: Page) => page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());
const RW2 = '/Users/kunst/Documents/#02_Projects/Project_on/chirrion works/IMG_TEM/P1036334.RW2';

async function photo(page: Page) {
  const jpg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const x = c.getContext('2d')!;
    for (let i = 0; i < 12; i++) { x.fillStyle = `hsl(${i * 30},70%,50%)`; x.fillRect((i % 4) * 750, Math.floor(i / 4) * 667, 750, 667); }
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  return { name: 'trip.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') };
}

async function editSomething(page: Page) {
  await page.click('#strategy-btns [data-val="single"]');
  await page.selectOption('#select-squeeze', '133');
  await page.waitForTimeout(800);
  await page.click('#btn-rotate-90');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.12, y: 0.2, width: 0.55, height: 0.5 }));
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.updateState({ tone: { brightness: 120, lut: 'classic-pan-400' }, typo: { text: 'DRAFT' }, frame: { margin: true, bgColor: '#ffffff' } }));
}

test('reloading offers the draft; restoring brings back the photo, the crop and every setting', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.setInputFiles('#upload-input', await photo(page));
  await page.waitForSelector('.cropper-container'); await page.waitForTimeout(300);
  await editSomething(page);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForFunction(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmReady: boolean } }).preview().filmReady, null, { timeout: 120_000 });
  const before = await state(page);
  const pv = await previewStats(page);
  await page.waitForTimeout(1800); // autosave debounce

  await page.reload();
  await expect(page.locator('#draft-banner')).toBeVisible();
  await expect(page.locator('#draft-banner')).toContainText('trip.jpg');
  await page.click('#btn-draft-restore');
  await page.waitForSelector('.cropper-container', { timeout: 60_000 });
  await page.waitForTimeout(600);
  const after = await state(page);
  for (const k of ['strategy', 'squeeze', 'rotation', 'tone', 'typo', 'frame'] as const) expect(after[k], k).toEqual(before[k]);
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(after.crop[k], `crop.${k}`).toBeCloseTo(before.crop[k], 3);
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.waitForFunction(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmReady: boolean } }).preview().filmReady, null, { timeout: 120_000 });
  await page.waitForTimeout(400);
  expect(meanDiff(await previewStats(page), pv), 'same picture as before the reload').toBeLessThan(2);
});

test('"Start fresh" discards the draft; New Photo discards it too', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.setInputFiles('#upload-input', await photo(page));
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(1800);
  await page.reload();
  await expect(page.locator('#draft-banner')).toBeVisible();
  await page.click('#btn-draft-discard');
  await expect(page.locator('#draft-banner')).toBeHidden();
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator('#draft-banner')).toBeHidden();

  await page.setInputFiles('#upload-input', await photo(page));
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(1800);
  await page.click('#btn-new-photo'); // reloads
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  await expect(page.locator('#draft-banner')).toBeHidden();
});

test('a draft older than 24 hours is not offered', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.setInputFiles('#upload-input', await photo(page));
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(1800);
  // Age the stored draft by 25 hours (idb-keyval's default store).
  await page.evaluate(() => new Promise<void>((res, rej) => {
    const open = indexedDB.open('keyval-store');
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite'); const st = tx.objectStore('keyval');
      const g = st.get('cineroll-draft');
      g.onsuccess = () => { const d = g.result; d.timestamp -= 25 * 3600 * 1000; st.put(d, 'cineroll-draft'); };
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    };
    open.onerror = () => rej(open.error);
  }));
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator('#draft-banner')).toBeHidden();
});

test('a RAW draft restores from the RAW file', async ({ page }) => {
  test.skip(!fs.existsSync(RW2), 'RW2 sample not on this machine');
  test.setTimeout(240_000);
  await page.goto('/');
  await page.setInputFiles('#upload-input', RW2);
  await page.waitForSelector('.cropper-container', { timeout: 60_000 });
  await page.waitForTimeout(1800);
  await page.reload();
  await page.click('#btn-draft-restore');
  await page.waitForSelector('.cropper-container', { timeout: 60_000 });
  expect(await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { originalSize(): number[] }).originalSize())).toEqual([6008, 4008]);
  expect(await page.locator('#exportQuality option[value="tiff16"]').isDisabled(), '16-bit master available again').toBe(false);
});
