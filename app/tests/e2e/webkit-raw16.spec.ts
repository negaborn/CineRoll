import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

// Technical plan v2, P0-2 (decided 2026-10-05: geometry only).
// A RAW source can be exported as a 16-bit TIFF "master": desqueeze, rotation,
// straighten, crop and slide split are applied to LibRaw's 16-bit decode;
// film / tone / colour / frame / caption / logo are not (and the export says so).
// Runs on Chromium and WebKit. Uses the owner's RW2 samples (skipped if absent).

const RW2 = '/Users/kunst/Documents/#02_Projects/Project_on/chirrion works/IMG_TEM/P1036334.RW2';
const have = fs.existsSync(RW2);

type Dbg = { exportFiles(): { name: string; type: string; size: number }[]; exportBlob(i: number): Blob; tiffInfo(i: number): Promise<Record<string, unknown>>; decodeExport(i: number): Promise<HTMLCanvasElement> };

/** Parses our baseline TIFF in the page: [w, h, bits, Uint16 samples or Uint8 samples] kept on window[slot]. */
const KEEP_TIFF = `async (i, slot) => {
  const buf = await window.__CINEROLL_DEBUG__.exportBlob(i).arrayBuffer();
  const dv = new DataView(buf); const le = dv.getUint16(0) === 0x4949;
  const ifd = dv.getUint32(4, le); const n = dv.getUint16(ifd, le); const tags = {};
  for (let k = 0; k < n; k++) { const o = ifd + 2 + k * 12; const tag = dv.getUint16(o, le); const type = dv.getUint16(o + 2, le); tags[tag] = type === 3 ? dv.getUint16(o + 8, le) : dv.getUint32(o + 8, le); }
  const bits = dv.getUint16(tags[258], le);
  const px = tags[256] * tags[257] * 3;
  const data = bits === 16 ? new Uint16Array(buf.slice(tags[273], tags[273] + px * 2)) : new Uint8Array(buf, tags[273], px);
  window[slot] = { w: tags[256], h: tags[257], bits, data };
  return [tags[256], tags[257], bits];
}`;

async function openRaw(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#upload-input', RW2);
  await page.waitForSelector('.cropper-container', { timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function exportAs(page: Page, q: 'tiff' | 'tiff16') {
  await page.selectOption('#exportQuality', q);
  await page.click('#btn-export');
  await page.waitForSelector('#export-modal.show', { timeout: 240_000 });
}

test.describe('16-bit TIFF from RAW', () => {
  test.skip(!have, 'RW2 sample not on this machine');

  test('full frame: a 16-bit RGB TIFF equal to LibRaw\'s 16-bit decode, with a geometry-only notice', async ({ page }) => {
    test.setTimeout(300_000);
    await page.route('**/__file/**', (r) => r.fulfill({ status: 200, body: fs.readFileSync(RW2) }));
    await openRaw(page);
    expect(await page.locator('#exportQuality option[value="tiff16"]').isDisabled()).toBe(false);
    await page.click('#strategy-btns [data-val="single"]');
    await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    await exportAs(page, 'tiff16');
    const info = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).tiffInfo(0));
    expect(info).toMatchObject({ width: 6008, height: 4008, bitsPerSample: [16, 16, 16], samplesPerPixel: 3 });
    expect(await page.evaluate(`(${KEEP_TIFF})(0, '__t16')`)).toEqual([6008, 4008, 16]);
    const r = await page.evaluate(async () => {
      const LibRaw = (await import('/node_modules/libraw-wasm/dist/index.js')).default;
      const lr = new LibRaw();
      await lr.open(new Uint8Array(await (await fetch('/__file/x')).arrayBuffer()), { useCameraWb: true, outputBps: 16 });
      const ref = await lr.imageData(); lr.dispose();
      const t = (window as unknown as { __t16: { data: Uint16Array } }).__t16;
      let max = 0; let distinct = new Set<number>();
      for (let i = 0; i < t.data.length; i++) { const e = Math.abs(t.data[i] - (ref!.data as Uint16Array)[i]); if (e > max) max = e; if (i % 101 === 0 && distinct.size < 5000) distinct.add(t.data[i]); }
      return { max, distinct: distinct.size };
    });
    expect(r.max, 'identical to LibRaw 16-bit').toBe(0);
    expect(r.distinct, 'real 16-bit precision (far more than 256 levels)').toBeGreaterThan(1000);
    const note = await page.textContent('#export-note');
    expect(note).toContain('16');
    expect(note).toContain('필름');
  });

  test('geometry (1.33x squeeze, 90° + 3° rotation, crop, 3 panorama slides) matches the 8-bit Lossless TIFF', async ({ page }) => {
    test.setTimeout(400_000);
    await openRaw(page);
    await page.selectOption('#select-squeeze', '133');
    await page.waitForTimeout(900);
    await page.click('#btn-rotate-90');
    await page.waitForTimeout(900);
    await page.evaluate(() => { const s = document.getElementById('slider-angle') as HTMLInputElement; s.value = '3'; s.dispatchEvent(new Event('input')); });
    await page.waitForTimeout(500);
    await page.selectOption('#select-ratio', 'NaN');
    await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0.1, y: 0.15, width: 0.8, height: 0.5 }));
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    await exportAs(page, 'tiff');
    const n8 = (await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as Dbg).exportFiles())).length;
    const dims8: number[][] = [];
    for (let i = 0; i < n8; i++) dims8.push(await page.evaluate(`(${KEEP_TIFF})(${i}, '__e8_${i}')`) as number[]);
    await page.click('#btn-close-export'); await page.waitForTimeout(300);
    await exportAs(page, 'tiff16');
    const dims16: number[][] = [];
    for (let i = 0; i < n8; i++) dims16.push(await page.evaluate(`(${KEEP_TIFF})(${i}, '__e16_${i}')`) as number[]);
    expect(n8).toBe(3);
    expect(dims16.map((d) => d.slice(0, 2)), 'same slide sizes').toEqual(dims8.map((d) => d.slice(0, 2)));
    const cmp = await page.evaluate((n) => {
      const w = window as unknown as Record<string, { data: Uint8Array | Uint16Array; w: number; h: number }>;
      const out: { mean: number; corr: number }[] = [];
      for (let s = 0; s < n; s++) {
        const a = w[`__e8_${s}`].data; const b = w[`__e16_${s}`].data; let d = 0; let ma = 0; let mb = 0; let k = 0;
        for (let i = 0; i < a.length; i += 7) { ma += a[i]; mb += b[i] / 257; k++; }
        ma /= k; mb /= k; let sab = 0; let saa = 0; let sbb = 0;
        for (let i = 0; i < a.length; i += 7) { const x = a[i] - ma; const y = b[i] / 257 - mb; sab += x * y; saa += x * x; sbb += y * y; d += Math.abs(a[i] - b[i] / 257); }
        out.push({ mean: d / k, corr: sab / Math.sqrt(saa * sbb) });
      }
      return out;
    }, n8);
    cmp.forEach((c, s) => {
      expect(c.mean, `slide ${s + 1}: mean |8-bit - 16-bit/257|`).toBeLessThan(2.5);
      expect(c.corr, `slide ${s + 1}: same picture`).toBeGreaterThan(0.995);
    });
  });
});

test('a JPEG source does not offer the 16-bit RAW master', async ({ page }) => {
  await page.goto('/');
  const jpg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; c.getContext('2d')!.fillRect(0, 0, 9, 9); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.setInputFiles('#upload-input', { name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await page.waitForSelector('.cropper-container');
  expect(await page.locator('#exportQuality option[value="tiff16"]').isDisabled()).toBe(true);
});
