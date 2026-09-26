import { test, expect, type Page, type Browser, type CDPSession } from '@playwright/test';
import { makePositionImage } from './fixtures/position-image';

// Found on a real iPhone, missed by the desktop-mouse-only suite:
//  - switching to Single kept the 4:5 lock, so smart snap (Free-only) never showed;
//  - a two-finger pinch or a wheel/trackpad scroll over the crop area zoomed the
//    *photo* behind a fixed crop box, silently changing the crop.
// These specs drive real touch/wheel input on a phone-sized viewport.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

type P = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const IMG_W = 4000;
const IMG_H = 3000;

const state = (page: Page) => page.evaluate(() => window.__CINEROLL_DEBUG__!.getState());

async function view(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => { const b = document.querySelector(sel)!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const badge = document.getElementById('smart-snap-badge')!;
    return {
      image: r('#image-container .cropper-canvas'),
      box: r('#image-container .cropper-crop-box'),
      snap: !!document.querySelector('#image-container .cropper-container.cropper-snap'),
      badge: badge.classList.contains('opacity-0') ? null : badge.innerText,
    };
  });
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: P[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
}

async function touchDrag(cdp: CDPSession, from: P, to: P, release = true) {
  const steps = 12;
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
  if (release) await touch(cdp, 'touchEnd', []);
}

async function pinch(cdp: CDPSession, c: P, d0: number, d1: number) {
  const steps = 12;
  const pts = (d: number) => [{ x: c.x - d, y: c.y - d * 0.6 }, { x: c.x + d, y: c.y + d * 0.6 }];
  await touch(cdp, 'touchStart', pts(d0));
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', pts(d0 + (d1 - d0) * i / steps));
  await touch(cdp, 'touchEnd', []);
}

const center = (r: Rect): P => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const handle = async (page: Page, dir: 'e' | 'se') => center(await page.locator(`#image-container .cropper-point.point-${dir}`).boundingBox().then((b) => ({ x: b!.x, y: b!.y, w: b!.width, h: b!.height })));
const srcRatio = (c: { width: number; height: number }) => (c.width * IMG_W) / (c.height * IMG_H);

async function start(page: Page, browser: Browser) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'src.png', mimeType: 'image/png', buffer: await makePositionImage(browser, IMG_W, IMG_H) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(500);
  return page.context().newCDPSession(page);
}

test.describe('Single mode switches to Free (Smart Snap)', () => {
  test('tapping Single from the default Seamless 4:5 selects Free', async ({ page, browser }) => {
    await start(page, browser);
    expect((await state(page)).baseRatio).toBe(0.8);
    await page.locator('#strategy-btns [data-val="single"]').tap();
    await page.waitForTimeout(200);
    expect((await state(page)).baseRatio, 'Single -> Free').toBeNull();
    expect(await page.inputValue('#select-ratio')).toBe('NaN');
  });

  test('tapping Single from Triptych with a fixed ratio also selects Free', async ({ page, browser }) => {
    await start(page, browser);
    await page.locator('#strategy-btns [data-val="triptych"]').tap();
    await page.selectOption('#select-ratio', '1.5');
    await page.waitForTimeout(200);
    await page.locator('#strategy-btns [data-val="single"]').tap();
    await page.waitForTimeout(200);
    expect((await state(page)).baseRatio).toBeNull();
    expect(await page.inputValue('#select-ratio')).toBe('NaN');
  });

  test('in Single, a touch drag near 1:1 turns the frame green and snaps on release -- no ratio menu needed', async ({ page, browser }) => {
    const cdp = await start(page, browser);
    await page.locator('#strategy-btns [data-val="single"]').tap();
    await page.waitForTimeout(300);
    const e = await handle(page, 'e');
    // Single starts as a 4:5 box; walk the east edge out until it is ~1:1
    // (within snap tolerance, not exact) -- the finger is still down.
    expect((await view(page)).box.w / (await view(page)).box.h).toBeCloseTo(0.8, 1);
    await touch(cdp, 'touchStart', [e]);
    let x = e.x;
    let mid = await view(page);
    for (let i = 0; i < 200 && mid.box.w / mid.box.h < 0.988; i++) {
      x += 2;
      await touch(cdp, 'touchMove', [{ x, y: e.y }]);
      mid = await view(page);
    }
    expect(mid.box.w / mid.box.h).toBeLessThan(0.998); // near, not already exact
    expect(mid.snap, 'green frame while dragging').toBe(true);
    expect(mid.badge ?? '').toMatch(/1:1/i);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(200);
    expect(srcRatio((await state(page)).crop), 'exact 1:1 after release').toBeCloseTo(1, 2);
  });

  test('Single with an explicitly chosen fixed ratio keeps it (only the switch picks Free)', async ({ page, browser }) => {
    await start(page, browser);
    await page.locator('#strategy-btns [data-val="single"]').tap();
    await page.selectOption('#select-ratio', '1');
    await page.waitForTimeout(200);
    await page.locator('#strategy-btns [data-val="single"]').tap(); // tapping the active strategy again
    await page.waitForTimeout(200);
    expect((await state(page)).baseRatio).toBe(1);
  });
});

test.describe('the photo never zooms behind the crop box', () => {
  for (const strategy of ['single', 'seamless'] as const) {
    test(`${strategy}: two-finger pinch (in and out) on the crop box`, async ({ page, browser }) => {
      const cdp = await start(page, browser);
      if (strategy === 'single') { await page.locator('#strategy-btns [data-val="single"]').tap(); await page.waitForTimeout(300); }
      const before = await view(page);
      const crop0 = (await state(page)).crop;
      await pinch(cdp, center(before.box), 70, 25);
      await page.waitForTimeout(250);
      await pinch(cdp, center(before.box), 25, 90);
      await page.waitForTimeout(250);
      const after = await view(page);
      expect(after.image.w, 'photo width on screen unchanged').toBeCloseTo(before.image.w, 0);
      expect(after.image.h, 'photo height on screen unchanged').toBeCloseTo(before.image.h, 0);
      const crop1 = (await state(page)).crop;
      for (const k of ['x', 'y', 'width', 'height'] as const) expect(crop1[k], `crop.${k} unchanged`).toBeCloseTo(crop0[k], 3);
    });
  }

  test('a second finger landing mid-drag puts the box back and ignores the rest of the gesture', async ({ page, browser }) => {
    const cdp = await start(page, browser);
    await page.locator('#strategy-btns [data-val="single"]').tap();
    await page.waitForTimeout(300);
    const before = await view(page);
    const crop0 = (await state(page)).crop;
    const a = center(before.box);
    await touch(cdp, 'touchStart', [a]);
    for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [{ x: a.x + 5 * i, y: a.y }]); // box moves 30px
    const b = { x: a.x + 30, y: a.y };
    await touch(cdp, 'touchStart', [b, { x: b.x + 60, y: b.y + 40 }]);
    for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: b.x - 4 * i, y: b.y }, { x: b.x + 60 + 6 * i, y: b.y + 40 }]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(250);
    const after = await view(page);
    expect(after.image.w).toBeCloseTo(before.image.w, 0);
    const crop1 = (await state(page)).crop;
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(crop1[k], `crop.${k} back to the gesture start`).toBeCloseTo(crop0[k], 3);
  });

  test('wheel / trackpad scroll over the crop area', async ({ page, browser }) => {
    await start(page, browser);
    await page.locator('#strategy-btns [data-val="single"]').tap();
    await page.waitForTimeout(300);
    const before = await view(page);
    const crop0 = (await state(page)).crop;
    await page.mouse.move(before.box.x + 10, before.box.y + 10);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 120);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
    await page.waitForTimeout(250);
    const after = await view(page);
    expect(after.image.w).toBeCloseTo(before.image.w, 0);
    const crop1 = (await state(page)).crop;
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(crop1[k], `crop.${k} unchanged`).toBeCloseTo(crop0[k], 3);
  });

  test('one-finger crop edits still work: resize a corner, move the box', async ({ page, browser }) => {
    const cdp = await start(page, browser);
    const v0 = await view(page);
    const c0 = (await state(page)).crop;
    const se = await handle(page, 'se');
    await touchDrag(cdp, se, { x: se.x - 60, y: se.y - 20 });
    await page.waitForTimeout(200);
    const c1 = (await state(page)).crop;
    expect(c1.width, 'corner drag shrinks the box').toBeLessThan(c0.width - 0.05);
    const v1 = await view(page);
    await touchDrag(cdp, center(v1.box), { x: center(v1.box).x + 30, y: center(v1.box).y });
    await page.waitForTimeout(200);
    const c2 = (await state(page)).crop;
    expect(c2.x, 'box moved right').toBeGreaterThan(c1.x + 0.03);
    expect(c2.width).toBeCloseTo(c1.width, 3);
    expect((await view(page)).image.w, 'photo never zoomed').toBeCloseTo(v0.image.w, 0);
  });
});

// Intended behavior (confirmed): in Seamless, smart snap targets the ratio of the
// whole panorama (the cinema look across all slides), not a single slide.
test('Seamless Free snaps the whole panorama ratio (e.g. 2.39:1 across 3 slides)', async ({ page, browser }) => {
  const cdp = await start(page, browser);
  await page.selectOption('#select-ratio', 'NaN');
  await page.waitForTimeout(200);
  // Panorama at ~2.36:1 in source pixels -- within 2% of 2.39.
  const h = 0.45;
  const w = (2.36 * h * IMG_H) / IMG_W;
  await page.evaluate((r) => window.__CINEROLL_DEBUG__!.setCropForTest(r), { x: 0.05, y: 0.2, width: w, height: h });
  await page.waitForTimeout(200);
  const e = await handle(page, 'e');
  await touchDrag(cdp, e, { x: e.x + 1, y: e.y }, false);
  const mid = await view(page);
  expect(mid.badge ?? '').toMatch(/2\.39/);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(200);
  const s = await state(page);
  expect(s.strategy).toBe('seamless');
  expect(srcRatio(s.crop), 'whole panorama snapped to 2.39:1').toBeCloseTo(2.39, 2);
});
