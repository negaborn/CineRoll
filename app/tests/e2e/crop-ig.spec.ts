import { test, expect, type CDPSession, type Page } from './fixtures/test';

// Instagram-style cropping (2026-10-05): with a fixed ratio the crop frame is
// fixed (centred, as large as the stage allows), the photo fills it on upload
// ("cover"), and the user moves the PHOTO -- one finger to pan, two to zoom --
// never leaving empty space in the frame. Real touch input, phone-sized viewport.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

const IMG_W = 3000;
const IMG_H = 2000;
type P = { x: number; y: number };

const st = (page: Page) => page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());
const rects = (page: Page) => page.evaluate(() => {
  const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  return { box: r('#image-container .cropper-crop-box'), stage: r('#image-container .cropper-container') };
});
const center = (b: { x: number; y: number; w: number; h: number }): P => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: P[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
}
async function drag(cdp: CDPSession, from: P, to: P) {
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= 12; i++) await touch(cdp, 'touchMove', [{ x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 }]);
  await touch(cdp, 'touchEnd', []);
}
async function pinch(cdp: CDPSession, c: P, d0: number, d1: number) {
  const pts = (d: number) => [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }];
  await touch(cdp, 'touchStart', pts(d0));
  for (let i = 1; i <= 12; i++) await touch(cdp, 'touchMove', pts(d0 + (d1 - d0) * i / 12));
  await touch(cdp, 'touchEnd', []);
}

async function start(page: Page) {
  await page.goto('/');
  const jpg = await page.evaluate(({ w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#234'); g.addColorStop(1, '#eda'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, { w: IMG_W, h: IMG_H });
  await page.setInputFiles('#upload-input', { name: 'p.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(500);
  return page.context().newCDPSession(page);
}

test('on upload the photo fills the fixed frame (cover), and the frame is centred and large', async ({ page }) => {
  await start(page); // Seamless 3 x 4:5 = 2.4:1
  const s = await st(page);
  expect(s.crop.width, 'cover: the full photo width').toBeCloseTo(1, 3);
  expect(s.crop.height).toBeCloseTo((IMG_W / 2.4) / IMG_H, 3);
  expect(s.crop.y + s.crop.height / 2, 'centred').toBeCloseTo(0.5, 3);
  const { box, stage } = await rects(page);
  expect(Math.max(box.w / stage.w, box.h / stage.h), 'frame fills the stage').toBeGreaterThan(0.88);
  expect(Math.abs(center(box).x - center(stage).x)).toBeLessThan(2);
  expect(Math.abs(center(box).y - center(stage).y)).toBeLessThan(2);
});

test('one finger moves the photo, not the frame; it can\'t uncover the frame', async ({ page }) => {
  const cdp = await start(page);
  await page.locator('#strategy-btns [data-val="single"]').tap();
  await page.selectOption('#select-ratio', '1'); // 1:1 fixed
  await page.waitForTimeout(400);
  const b0 = (await rects(page)).box;
  const c0 = (await st(page)).crop;
  await drag(cdp, center(b0), { x: center(b0).x + 60, y: center(b0).y });
  await page.waitForTimeout(250);
  const b1 = (await rects(page)).box;
  const c1 = (await st(page)).crop;
  expect(Math.abs(b1.x - b0.x) + Math.abs(b1.w - b0.w), 'frame stays put').toBeLessThan(1.5);
  expect(c1.x, 'photo moved right = crop moved left').toBeLessThan(c0.x - 0.01);
  expect(c1.width).toBeCloseTo(c0.width, 4);
  // Drag much further than the photo allows: the frame must stay covered.
  await drag(cdp, center(b1), { x: center(b1).x + 2000, y: center(b1).y + 2000 });
  await page.waitForTimeout(250);
  const c2 = (await st(page)).crop;
  expect(c2.x).toBeGreaterThanOrEqual(-1e-6);
  expect(c2.y).toBeGreaterThanOrEqual(-1e-6);
});

test('two fingers zoom the photo inside the fixed frame; zooming out stops at "cover"', async ({ page }) => {
  const cdp = await start(page);
  await page.locator('#strategy-btns [data-val="single"]').tap();
  await page.selectOption('#select-ratio', '1');
  await page.waitForTimeout(400);
  const b0 = (await rects(page)).box;
  const c0 = (await st(page)).crop;
  await pinch(cdp, center(b0), 30, 110); // spread = zoom in
  await page.waitForTimeout(300);
  const b1 = (await rects(page)).box;
  const c1 = (await st(page)).crop;
  expect(Math.abs(b1.w - b0.w) + Math.abs(b1.x - b0.x), 'frame stays put').toBeLessThan(1.5);
  expect(c1.width, 'zoomed in: a smaller part of the photo').toBeLessThan(c0.width * 0.8);
  const ratio = (c: typeof c1) => (c.width * IMG_W) / (c.height * IMG_H);
  expect(ratio(c1), 'still 1:1').toBeCloseTo(1, 2);
  await pinch(cdp, center(b1), 140, 10); // pinch hard = zoom out
  await page.waitForTimeout(300);
  const c2 = (await st(page)).crop;
  expect(Math.max(c2.width, c2.height), 'never smaller than cover').toBeLessThanOrEqual(1 + 1e-4);
  expect(ratio(c2)).toBeCloseTo(1, 2);
});

test('a stored crop is shown in the fixed, centred frame (state stays as stored)', async ({ page }) => {
  await start(page);
  await page.locator('#strategy-btns [data-val="single"]').tap();
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(300);
  const rect = { x: 0.2, y: 0.3, width: 0.3, height: 0.25 };
  await page.evaluate((r) => window.__CINEROLL_DEBUG__!.setCropForTest(r), rect);
  await page.waitForTimeout(300);
  const c = (await st(page)).crop;
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(c[k], k).toBeCloseTo(rect[k], 3);
  const { box, stage } = await rects(page);
  expect(Math.max(box.w / stage.w, box.h / stage.h), 'shown large, not as a small box').toBeGreaterThan(0.88);
});

test('a wheel / trackpad scroll zooms the photo too, the frame stays put', async ({ page }) => {
  await start(page);
  await page.locator('#strategy-btns [data-val="single"]').tap();
  await page.selectOption('#select-ratio', '1');
  await page.waitForTimeout(400);
  const b0 = (await rects(page)).box;
  const c0 = (await st(page)).crop;
  await page.mouse.move(center(b0).x, center(b0).y);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120); // scroll up = zoom in
  await page.waitForTimeout(300);
  const b1 = (await rects(page)).box;
  expect(Math.abs(b1.w - b0.w) + Math.abs(b1.x - b0.x)).toBeLessThan(1.5);
  expect((await st(page)).crop.width).toBeLessThan(c0.width * 0.9);
});
