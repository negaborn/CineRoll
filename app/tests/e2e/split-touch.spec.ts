import { test, expect, type CDPSession, type Page } from '@playwright/test';

// The before/after split slider only listened to mouse events (and was a 3px
// line), so on a phone it could not be dragged. Real touch input here
// (CDP touch events -> pointer events), phone-sized viewport.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

async function touchDrag(cdp: CDPSession, from: { x: number; y: number }, toX: number) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (toX - from.x) * i / 12, y: from.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const split = (page: Page) => page.evaluate(() => {
  const p = document.getElementById('preview-wrapper-parent')!.getBoundingClientRect();
  const h = document.getElementById('split-handle')!.getBoundingClientRect();
  return { pct: ((h.left + h.width / 2 - p.left) / p.width) * 100, clip: document.getElementById('layer-images-before')!.style.clipPath, parent: { x: p.left, y: p.top, w: p.width, h: p.height } };
});

test('the before/after split can be dragged with a finger, even grabbed slightly off the line', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const jpg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2000; c.height = 1500; const x = c.getContext('2d')!; x.fillStyle = '#c84'; x.fillRect(0, 0, 2000, 1500); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.setInputFiles('#upload-input', { name: 'p.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container');
  await page.locator('#strategy-btns [data-val="single"]').tap();
  await page.locator('#btn-apply-crop').tap();
  await page.waitForSelector('.preview-slide-canvas');
  await page.locator('#btn-split-view').tap();
  await page.waitForSelector('#split-handle');
  const cdp = await page.context().newCDPSession(page);
  const s0 = await split(page);
  expect(s0.pct).toBeCloseTo(50, 0);
  const y = s0.parent.y + s0.parent.h / 2;
  // Grab 14px to the right of the line (a fingertip is not 3px wide) and drag to ~20%.
  await touchDrag(cdp, { x: s0.parent.x + s0.parent.w * 0.5 + 14, y }, s0.parent.x + s0.parent.w * 0.2 + 14);
  const s1 = await split(page);
  expect(s1.pct, 'handle followed the finger').toBeLessThan(28);
  expect(s1.pct).toBeGreaterThan(12);
  expect(s1.clip, 'before layer clipped to the handle').toContain(`${s1.pct.toFixed(0)}`.slice(0, 1));
  // And back to the right.
  const hx = s1.parent.x + s1.parent.w * (s1.pct / 100);
  await touchDrag(cdp, { x: hx, y }, s1.parent.x + s1.parent.w * 0.8);
  expect((await split(page)).pct).toBeGreaterThan(72);
});
