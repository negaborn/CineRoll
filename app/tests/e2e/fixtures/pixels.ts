import type { Page } from '@playwright/test';

export interface Stats {
  mean: [number, number, number];
  /** std-dev of luma -- grain/noise indicator on flat images */
  lumaStd: number;
  /** mean (max-min) channel spread -- 0 for grayscale */
  sat: number;
  /** fraction of pixels that are caption-magenta / logo-cyan / near-white */
  magenta: number;
  cyan: number;
  white: number;
  w: number;
  h: number;
}

export type Region = [number, number, number, number];

const STATS = `(d, w, h, rx0, ry0, rx1, ry1) => {
  let n = 0, r = 0, g = 0, b = 0, l = 0, l2 = 0, sat = 0, mag = 0, cy = 0, wh = 0;
  const x0 = Math.floor(rx0 * w), x1 = Math.floor(rx1 * w), y0 = Math.floor(ry0 * h), y1 = Math.floor(ry1 * h);
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * w + x) * 4; if (d[i + 3] < 250) continue;
    const R = d[i], G = d[i + 1], B = d[i + 2]; n++; r += R; g += G; b += B;
    const L = 0.299 * R + 0.587 * G + 0.114 * B; l += L; l2 += L * L;
    sat += Math.max(R, G, B) - Math.min(R, G, B);
    if (R > 180 && G < 90 && B > 180) mag++;
    if (R < 90 && G > 180 && B > 180) cy++;
    if (R > 235 && G > 235 && B > 235) wh++;
  }
  n = Math.max(1, n); const ml = l / n;
  return { mean: [r / n, g / n, b / n], lumaStd: Math.sqrt(Math.max(0, l2 / n - ml * ml)), sat: sat / n, magenta: mag / n, cyan: cy / n, white: wh / n, w, h };
}`;

export async function previewStats(page: Page, index = 0, region: Region = [0, 0, 1, 1]): Promise<Stats> {
  return page.evaluate(`(() => {
    const c = document.querySelectorAll('.preview-slide-canvas')[${index}];
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return (${STATS})(d, c.width, c.height, ${region.join(',')});
  })()`) as Promise<Stats>;
}

export async function exportStats(page: Page, index = 0, region: Region = [0, 0, 1, 1]): Promise<Stats> {
  return page.evaluate(`(async () => {
    const img = document.querySelectorAll('.export-img-item')[${index}];
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    return (${STATS})(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, ${region.join(',')});
  })()`) as Promise<Stats>;
}

export const previewCount = (page: Page) => page.locator('.preview-slide-canvas').count();

/** Runs an export and leaves the modal open so export stats can be read; call closeExport() afterwards. */
export async function runExport(page: Page, quality: 'png' | 'ig' = 'png') {
  await page.selectOption('#exportQuality', quality);
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 60000 });
  return page.locator('.export-img-item').count();
}

export async function closeExport(page: Page) {
  await page.click('#btn-close-export');
  await page.waitForTimeout(350);
}

export const meanDiff = (a: Stats, b: Stats) => Math.max(...a.mean.map((v, i) => Math.abs(v - b.mean[i])));

/** Sets a range/number/text/color input or select the way a user would, firing the given events. */
export async function setControl(page: Page, selector: string, value: string, events: ('input' | 'change')[] = ['input', 'change']) {
  await page.evaluate(({ selector, value, events }) => {
    const el = document.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
    el.value = value;
    for (const ev of events) el.dispatchEvent(new Event(ev, { bubbles: true }));
  }, { selector, value, events });
}
