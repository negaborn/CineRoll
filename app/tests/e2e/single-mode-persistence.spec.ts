import { test, expect, type Page } from '@playwright/test';
import { makePositionImage, makeSolidPng } from './fixtures/position-image';

type Box = { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; w: number; h: number } | null;
type Geo = { text: Box; logo: Box; image: Box; size: [number, number] };

// Classifies pixels: magenta caption, cyan logo, and the position-coded photo (B≈128).
const CLASSIFY = `(d, w, h) => {
  const acc = { text: [1e9,1e9,-1,-1], logo: [1e9,1e9,-1,-1], image: [1e9,1e9,-1,-1] };
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4, r = d[i], g = d[i+1], b = d[i+2];
    let k = null;
    if (r > 180 && g < 90 && b > 180) k = 'text';
    else if (r < 90 && g > 180 && b > 180) k = 'logo';
    else if (b > 95 && b < 160) k = 'image';
    if (!k) continue;
    const a = acc[k]; a[0] = Math.min(a[0], x); a[1] = Math.min(a[1], y); a[2] = Math.max(a[2], x); a[3] = Math.max(a[3], y);
  }
  const box = (a) => a[2] < 0 ? null : { x0: a[0]/w, y0: a[1]/h, x1: a[2]/w, y1: a[3]/h, cx: (a[0]+a[2])/2/w, cy: (a[1]+a[3])/2/h, w: (a[2]-a[0])/w, h: (a[3]-a[1])/h };
  return { text: box(acc.text), logo: box(acc.logo), image: box(acc.image), size: [w, h] };
}`;

async function previewGeo(page: Page): Promise<Geo> {
  return page.evaluate(`(() => { const c = document.querySelector('.preview-slide-canvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; return (${CLASSIFY})(d, c.width, c.height); })()`) as Promise<Geo>;
}
async function exportGeo(page: Page): Promise<Geo> {
  await page.selectOption('#exportQuality', 'ig');
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 30000 });
  const g = await page.evaluate(`(async () => { const img = document.querySelector('.export-img-item'); await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img,0,0); return (${CLASSIFY})(x.getImageData(0,0,c.width,c.height).data, c.width, c.height); })()`) as Geo;
  await page.click('#btn-close-export');
  await page.waitForTimeout(350);
  return g;
}
async function hitTargetVsCanvas(page: Page) {
  return page.evaluate(() => {
    const pane = document.getElementById('glass-pane-1')!.getBoundingClientRect();
    const span = document.querySelector('.draggable-text span')!.getBoundingClientRect();
    const logo = document.querySelector('.draggable-logo img')?.getBoundingClientRect();
    return {
      textHit: { cx: (span.x + span.width / 2 - pane.x) / pane.width, cy: (span.y + span.height / 2 - pane.y) / pane.height, w: span.width / pane.width },
      logoHit: logo ? { cx: (logo.x + logo.width / 2 - pane.x) / pane.width, cy: (logo.y + logo.height / 2 - pane.y) / pane.height, w: logo.width / pane.width } : null,
    };
  });
}
async function dragCenterTo(page: Page, selector: string, fx: number, fy: number) {
  const el = await page.locator(selector).boundingBox();
  const pane = await page.locator('#glass-pane-1').boundingBox();
  await page.mouse.move(el!.x + el!.width / 2, el!.y + el!.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane!.x + pane!.width * fx, pane!.y + pane!.height * fy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}
function expectClose(label: string, a: Box, b: Box, tol: number) {
  expect(a, `${label}: missing in first render`).not.toBeNull();
  expect(b, `${label}: missing in second render`).not.toBeNull();
  for (const k of ['cx', 'cy', 'w', 'h'] as const) {
    expect(Math.abs(a![k] - b![k]), `${label}.${k}`).toBeLessThan(tol);
  }
}

async function settingsOf(page: Page) {
  return page.evaluate(() => ({
    margin: (document.getElementById('slider-margin-scale') as HTMLInputElement).value,
    border: (document.getElementById('select-border') as HTMLSelectElement).value,
    borderWeight: (document.getElementById('slider-borderWeight') as HTMLInputElement).value,
    font: (document.getElementById('fontSelect') as HTMLSelectElement).value,
    fontScale: (document.getElementById('slider-fontScale') as HTMLInputElement).value,
    color: (document.getElementById('textColorPicker') as HTMLInputElement).value,
    logoScale: (document.getElementById('sliderLogoScale') as HTMLInputElement).value,
    logoOn: (document.getElementById('toggle-logo') as HTMLInputElement).checked,
  }));
}

/** Preview must match export (WYSIWYG), and the invisible drag hit-targets must sit on the painted caption/logo. */
async function verifyFrame(page: Page) {
  const p = await previewGeo(page);
  const hit = await hitTargetVsCanvas(page);
  const e = await exportGeo(page);
  expectClose('caption preview vs export', p.text, e.text, 0.02);
  expectClose('logo preview vs export', p.logo, e.logo, 0.02);
  expectClose('photo rect preview vs export', p.image, e.image, 0.02);
  expect(Math.abs(hit.textHit.cx - p.text!.cx), 'caption hit-target x').toBeLessThan(0.015);
  expect(Math.abs(hit.textHit.cy - p.text!.cy), 'caption hit-target y').toBeLessThan(0.015);
  expect(Math.abs(hit.logoHit!.cx - p.logo!.cx), 'logo hit-target x').toBeLessThan(0.015);
  expect(Math.abs(hit.logoHit!.cy - p.logo!.cy), 'logo hit-target y').toBeLessThan(0.015);
  return p;
}

test('single mode: margin/border, caption font/size/color, and logo survive re-framing and rotation', async ({ page, browser }) => {
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: await makePositionImage(browser, 1600, 1200) });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.selectOption('#select-ratio', 'NaN');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.1, y: 0.1, width: 0.6, height: 0.7 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');

  await page.click('[data-bg="#ffffff"]');
  await page.click('#btn-margin');
  await page.evaluate(() => { const s = document.getElementById('slider-margin-scale') as HTMLInputElement; s.value = '70'; s.dispatchEvent(new Event('input')); });
  await page.selectOption('#select-border', 'fineart');
  await page.evaluate(() => { const s = document.getElementById('slider-borderWeight') as HTMLInputElement; s.value = '6'; s.dispatchEvent(new Event('input')); });

  await page.click('[data-tab="typo"]');
  await page.fill('#watermarkText', 'CINE CAPTION');
  await page.evaluate(() => { const c = document.getElementById('textColorPicker') as HTMLInputElement; c.value = '#ff00ff'; c.dispatchEvent(new Event('input')); });
  await page.click('#btnGlow'); // glow off so the caption's own pixels are measurable
  await page.click('#btnBold');
  await page.selectOption('#fontSelect', 'Inter');
  await page.evaluate(() => { const s = document.getElementById('slider-fontScale') as HTMLInputElement; s.value = '160'; s.dispatchEvent(new Event('input')); });
  await page.setInputFiles('#uploadLogo', { name: 'logo.png', mimeType: 'image/png', buffer: await makeSolidPng(browser, 300, 150, '#00ffff') });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const s = document.getElementById('sliderLogoScale') as HTMLInputElement; s.value = '60'; s.dispatchEvent(new Event('input')); });
  await dragCenterTo(page, '.draggable-text', 0.3, 0.35);
  await dragCenterTo(page, '.draggable-logo', 0.7, 0.72);

  const settingsBefore = await settingsOf(page);
  const before = await verifyFrame(page);
  expect(before.text!.cx).toBeCloseTo(0.3, 1);
  expect(before.text!.cy).toBeCloseTo(0.35, 1);
  expect(before.logo!.cx).toBeCloseTo(0.7, 1);
  expect(before.logo!.cy).toBeCloseTo(0.72, 1);

  // Re-frame: back to Format, rotate 90°, new crop, Apply.
  await page.click('[data-tab="format"]');
  await page.waitForTimeout(400);
  await page.click('#btn-rotate-90');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.15, y: 0.2, width: 0.7, height: 0.5 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)');
  await page.waitForTimeout(600);

  expect(await settingsOf(page)).toEqual(settingsBefore);
  const after = await verifyFrame(page);
  // Caption/logo keep their position within the slide; the photo keeps its margin inset.
  expect(Math.abs(after.text!.cx - before.text!.cx)).toBeLessThan(0.01);
  expect(Math.abs(after.text!.cy - before.text!.cy)).toBeLessThan(0.01);
  expect(Math.abs(after.logo!.cx - before.logo!.cx)).toBeLessThan(0.01);
  expect(Math.abs(after.logo!.cy - before.logo!.cy)).toBeLessThan(0.01);
  expect(Math.abs(after.image!.x0 - before.image!.x0)).toBeLessThan(0.015);
  expect(Math.abs(after.image!.y0 - before.image!.y0)).toBeLessThan(0.015);
});
