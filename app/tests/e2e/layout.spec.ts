import { test, expect } from '@playwright/test';

// Editing layout (2026-10-05): on a phone the photo gets most of the screen, and
// secondary setting groups start collapsed (they open on tap). Uses plain
// @playwright/test on purpose -- the shared fixture opens every section.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const SECONDARY = ['rotate', 'borders', 'advanced-tone', 'grain', 'typo-style', 'typo-logo'];

test('on a phone the photo area takes most of the screen, and secondary groups start collapsed', async ({ page }) => {
  await page.goto('/');
  const jpg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; c.getContext('2d')!.fillRect(0, 0, 9, 9); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.setInputFiles('#upload-input', { name: 'p.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container');
  const stageShare = await page.evaluate(() => document.getElementById('main-stage')!.getBoundingClientRect().height / window.innerHeight);
  expect(stageShare, 'photo area share of the screen height').toBeGreaterThan(0.55);

  const open = await page.$$eval('details[data-section]', (ds) => ds.map((d) => [(d as HTMLElement).dataset.section, (d as HTMLDetailsElement).open]));
  expect(open.map((o) => o[0]).sort()).toEqual([...SECONDARY].sort());
  expect(open.every((o) => o[1] === false), 'all secondary groups collapsed').toBe(true);

  // Primary controls stay visible on their tabs.
  await expect(page.locator('#select-ratio')).toBeVisible();
  await expect(page.locator('#select-squeeze')).toBeVisible();
  await expect(page.locator('#btn-rotate-90')).toBeHidden();
  await page.locator('details[data-section="rotate"] > summary').tap();
  await expect(page.locator('#btn-rotate-90')).toBeVisible();

  await page.locator('[data-tab="tone"]').tap();
  await expect(page.locator('#select-lut')).toBeVisible();
  await expect(page.locator('#slider-hl')).toBeHidden();
  await page.locator('[data-tab="color"]').tap();
  await expect(page.locator('#slider-br')).toBeVisible();
  await expect(page.locator('#slider-grain')).toBeHidden();
  await page.locator('[data-tab="typo"]').tap();
  await expect(page.locator('#watermarkText')).toBeVisible();
  await expect(page.locator('#fontSelect')).toBeVisible();
  await expect(page.locator('#toggle-logo')).toBeHidden();
});

test('an opened group stays open after a reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('details[data-section="rotate"] > summary').tap();
  await page.reload();
  expect(await page.$eval('details[data-section="rotate"]', (d) => (d as HTMLDetailsElement).open)).toBe(true);
});
