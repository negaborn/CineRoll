import { test, expect, type Page, type Browser } from '@playwright/test';
import { previewStats, exportStats, runExport, closeExport, meanDiff, setControl } from './fixtures/pixels';

// Film simulations (Classic Pan 400, Newsprint 400, Vivid Slide 50 Velvia/Provia),
// ported from the verified prototypes in reference/film-sim/.
//  1. Fidelity: at each film's tuning resolution, our port reproduces the
//     prototype's own render() output for the same photo.
//  2. Integration: selected in the Tone tab, applied identically in the preview
//     and the export, any aspect ratio kept, processed at >= 2600px.
//  3. The guarded details: no double gain (Newsprint), base/detail split
//     (Vivid), confirmed defaults, always-on dither, texture-aware shadow lift,
//     strip processing == whole frame.

type FilmId = 'classic-pan-400' | 'newsprint-400' | 'velvia-50' | 'provia-100f';

const REFS: { film: FilmId; file: string; w: number; h: number; dpr: number; provia?: boolean }[] = [
  { film: 'classic-pan-400', file: 'classic-pan-400-CURRENT.html', w: 900, h: 600, dpr: 1 },
  { film: 'newsprint-400', file: 'newsprint-400-CURRENT.html', w: 1100, h: 733, dpr: 1 },
  { film: 'velvia-50', file: 'vivid-slide-50-FINAL.html', w: 2600, h: 1733, dpr: 2 },
  { film: 'provia-100f', file: 'vivid-slide-50-FINAL.html', w: 2600, h: 1733, dpr: 2, provia: true },
];

/**
 * A deterministic photo-like test scene: sky gradient, flat deep-blue field,
 * textured shadow, foliage, skin, saturated warm/cool swatches, fine texture,
 * a bright light source (halation) and a smooth gray ramp (banding).
 */
async function makeScene(page: Page, w: number, h: number, variant: 'day' | 'night' | 'food' = 'day'): Promise<Buffer> {
  const b64 = await page.evaluate(({ w, h, variant }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    if (variant === 'night') {
      x.fillStyle = '#07090f'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) { const g = x.createRadialGradient(rnd() * w, rnd() * h * 0.7, 1, rnd() * w, rnd() * h, 30 + rnd() * 90); g.addColorStop(0, ['#ffd27a', '#ff7a3c', '#9fd0ff', '#ffffff'][i % 4]); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); }
      for (let i = 0; i < 6000; i++) { const v = 10 + rnd() * 40; x.fillStyle = `rgb(${v},${v * 0.9},${v * 1.1})`; x.fillRect(rnd() * w, h * 0.6 + rnd() * h * 0.4, 3, 3); }
    } else if (variant === 'food') {
      x.fillStyle = '#e9e1d4'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#fafafa'; x.beginPath(); x.ellipse(w * 0.5, h * 0.55, w * 0.33, h * 0.36, 0, 0, Math.PI * 2); x.fill();
      const cols = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#8e44ad', '#d35400'];
      for (let i = 0; i < 260; i++) { x.fillStyle = cols[i % cols.length]; x.beginPath(); x.arc(w * 0.5 + (rnd() - 0.5) * w * 0.45, h * 0.55 + (rnd() - 0.5) * h * 0.5, 6 + rnd() * 26, 0, Math.PI * 2); x.fill(); }
      x.fillStyle = 'rgba(80,50,30,0.35)'; x.fillRect(0, h * 0.85, w, h * 0.15);
    } else {
      const sky = x.createLinearGradient(0, 0, 0, h * 0.5); sky.addColorStop(0, '#2f6fae'); sky.addColorStop(1, '#bcd8ec');
      x.fillStyle = sky; x.fillRect(0, 0, w, h * 0.5);
      x.fillStyle = '#16284f'; x.fillRect(w * 0.02, h * 0.04, w * 0.22, h * 0.2); // flat, dark, textureless
      x.fillStyle = '#2b241c'; x.fillRect(0, h * 0.5, w, h * 0.5);
      for (let i = 0; i < 9000; i++) { const v = rnd() * 70; x.fillStyle = `rgb(${v},${v * 0.9},${v * 0.8})`; x.fillRect(rnd() * w * 0.5, h * 0.55 + rnd() * h * 0.4, 2 + rnd() * 3, 2 + rnd() * 3); } // textured shadow
      x.fillStyle = '#3d7a34'; x.beginPath(); x.ellipse(w * 0.16, h * 0.44, w * 0.12, h * 0.16, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#caa07a'; x.beginPath(); x.ellipse(w * 0.42, h * 0.40, w * 0.07, h * 0.14, 0, 0, Math.PI * 2); x.fill();
      ['#c23b2e', '#e0812f', '#b5326b', '#2e5fae', '#f2c230'].forEach((col, i) => { x.fillStyle = col; x.fillRect(w * (0.58 + i * 0.07), h * 0.30, w * 0.06, h * 0.1); });
      for (let i = 0; i < 4000; i++) { x.fillStyle = rnd() > 0.5 ? '#8a7a66' : '#5c5040'; x.fillRect(w * 0.6 + rnd() * w * 0.35, h * 0.55 + rnd() * h * 0.2, 1 + rnd() * 2, 1 + rnd() * 2); } // fine texture
      const glow = x.createRadialGradient(w * 0.82, h * 0.15, 2, w * 0.82, h * 0.15, w * 0.06); glow.addColorStop(0, '#fffdf6'); glow.addColorStop(1, 'rgba(255,247,230,0)');
      x.fillStyle = glow; x.fillRect(0, 0, w, h);
      x.fillStyle = '#fffdf6'; x.beginPath(); x.arc(w * 0.82, h * 0.15, w * 0.015, 0, Math.PI * 2); x.fill();
      const ramp = x.createLinearGradient(w * 0.05, 0, w * 0.55, 0); ramp.addColorStop(0, '#303030'); ramp.addColorStop(1, '#d0d0d0');
      x.fillStyle = ramp; x.fillRect(w * 0.05, h * 0.9, w * 0.5, h * 0.07);
    }
    return c.toDataURL('image/png').split(',')[1];
  }, { w, h, variant });
  return Buffer.from(b64, 'base64');
}

const debugFilm = (page: Page) => page.evaluate(() => typeof (window.__CINEROLL_DEBUG__ as unknown as { film?: unknown }).film);

test.describe('fidelity: the port reproduces each prototype render()', () => {
  for (const ref of REFS) {
    test.describe(ref.film, () => {
      test.use({ deviceScaleFactor: ref.dpr });
      test(`${ref.film} at ${ref.w}x${ref.h} matches ${ref.file}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
        await page.goto('/');
        expect(await debugFilm(page), 'film engine exposed to tests').toBe('object');
        const png = await makeScene(page, ref.w, ref.h);
        await page.evaluate((file) => new Promise<void>((res) => {
          const f = document.createElement('iframe'); f.id = 'ref'; f.style.cssText = 'width:1200px;height:900px'; f.src = `/reference/film-sim/${file}`;
          f.onload = () => res(); document.body.appendChild(f);
        }), ref.file);
        const frame = page.frameLocator('#ref');
        await frame.locator('#fileInput').setInputFiles({ name: 'scene.png', mimeType: 'image/png', buffer: png });
        await expect(frame.locator('#uploadHint')).toContainText('scene.png');
        if (ref.provia) await frame.locator('#filmProvia').click();
        const r = await page.evaluate(async ({ film, b64 }) => {
          const ifr = (document.getElementById('ref') as HTMLIFrameElement).contentDocument!;
          const rc = ifr.getElementById('canvasProcessed') as HTMLCanvasElement;
          const refData = rc.getContext('2d')!.getImageData(0, 0, rc.width, rc.height).data;
          const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
          const src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
          src.getContext('2d')!.drawImage(img, 0, 0);
          const dbg = window.__CINEROLL_DEBUG__ as unknown as { film: { apply(c: HTMLCanvasElement, id: string): Promise<HTMLCanvasElement> } };
          const out = await dbg.film.apply(src, film);
          const d = out.getContext('2d')!.getImageData(0, 0, out.width, out.height).data;
          let max = 0; let sum = 0; let off = 0;
          for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const e = Math.abs(d[i + c] - refData[i + c]); max = Math.max(max, e); sum += e; if (e > 1) off++; }
          return { size: [out.width, out.height, rc.width, rc.height], max, mean: sum / (d.length * 0.75), offFrac: off / (d.length * 0.75) };
        }, { film: ref.film, b64: png.toString('base64') });
        console.log(`${ref.film}: ${JSON.stringify(r)}`);
        expect(r.size).toEqual([ref.w, ref.h, ref.w, ref.h]);
        expect(r.mean, 'mean abs difference per channel').toBeLessThan(0.05);
        expect(r.offFrac, 'share of channel values off by more than 1 level').toBeLessThan(0.001);
        expect(r.max).toBeLessThanOrEqual(3);
      });
    });
  }
});

type FilmApi = {
  apply(c: HTMLCanvasElement, id: string, opts?: { stripPixels?: number }): Promise<HTMLCanvasElement>;
  analyze(c: HTMLCanvasElement, id: string): { shadowCoverage: number; shadowLift: number; spread: number; contrast: number };
  specs: Record<string, Record<string, unknown>>;
  newsprintToneCurve(v: number, s: number, lift: number): number;
  newsprintCurvePoints: [number, number][];
};

test.describe('guarded details', () => {
  test('confirmed defaults (no re-tuning): Velvia 62/75/55/52, Provia 58/18, B&W sliders', async ({ page }) => {
    await page.goto('/');
    const specs = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { film: FilmApi }).film.specs);
    expect(specs['velvia-50']).toMatchObject({ contrast: 0.62, saturation: 0.75, warmPriority: 0.55, localContrast: 0.52, grain: 0.09, halation: 0.16, autoContrast: true });
    expect(specs['provia-100f']).toMatchObject({ contrast: 0.62, saturation: 0.58, warmPriority: 0.18, localContrast: 0.52 });
    expect(specs['classic-pan-400']).toMatchObject({ redWeight: 0.74, contrast: 0.55, grain: 0.19, halation: 0.10, exposureShift: 0 });
    expect(specs['newsprint-400']).toMatchObject({ redWeight: 0.65, contrast: 0.70, grain: 0.24, halation: 0.08, localContrast: 0.38, exposureShift: 0 });
  });

  test('Newsprint: the curve is an identity->keyframe blend with no extra global gain', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      const f = (window.__CINEROLL_DEBUG__ as unknown as { film: FilmApi }).film;
      const P = f.newsprintCurvePoints;
      const shape = (v: number) => { for (let i = 0; i < P.length - 1; i++) { const [a, b] = [P[i], P[i + 1]]; if (v >= a[0] && v <= b[0]) return a[1] + ((v - a[0]) / (b[0] - a[0])) * (b[1] - a[1]); } return v; };
      let worst = 0;
      for (let v = 0; v <= 1.0001; v += 0.01) for (const s of [0, 0.35, 0.7, 1]) worst = Math.max(worst, Math.abs(f.newsprintToneCurve(v, s, 0) - (v + (shape(v) - v) * s)));
      return { worst, mid: f.newsprintToneCurve(0.5, 1, 0), p30: f.newsprintToneCurve(0.3, 1, 0), white: f.newsprintToneCurve(1, 1, 0) };
    });
    expect(r.worst).toBeLessThan(1e-9);
    expect(r).toMatchObject({ mid: 0.5, white: 1 });
    expect(r.p30).toBeCloseTo(0.205, 9);
  });

  test('B&W shadow lift detects "dark AND textured" -- a flat dark sky is not a shadow', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      const f = (window.__CINEROLL_DEBUG__ as unknown as { film: FilmApi }).film;
      const mk = (textured: boolean) => {
        const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const x = c.getContext('2d')!;
        x.fillStyle = '#1b2d5c'; x.fillRect(0, 0, 1200, 800); // deep blue: dark in luminance
        if (textured) { let s = 7; for (let i = 0; i < 60000; i++) { s = (s * 16807) % 2147483647; const v = (s % 90); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect((s >> 3) % 1200, (s >> 11) % 800, 3, 3); } }
        return c;
      };
      return { flat: f.analyze(mk(false), 'classic-pan-400'), textured: f.analyze(mk(true), 'classic-pan-400'), flatNews: f.analyze(mk(false), 'newsprint-400') };
    });
    expect(r.flat.shadowLift, 'flat dark blue field: no lift').toBe(0);
    expect(r.flatNews.shadowLift).toBe(0);
    expect(r.textured.shadowCoverage).toBeGreaterThan(0.2);
    expect(r.textured.shadowLift).toBeGreaterThan(0.2);
  });

  test('always-on dither: a smooth ramp comes out without flat 8-bit bands', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const f = (window.__CINEROLL_DEBUG__ as unknown as { film: FilmApi }).film;
      const c = document.createElement('canvas'); c.width = 1100; c.height = 400; const x = c.getContext('2d')!;
      const g = x.createLinearGradient(0, 0, 1100, 0); g.addColorStop(0, '#3a3a3a'); g.addColorStop(1, '#5a5a5a'); x.fillStyle = g; x.fillRect(0, 0, 1100, 400);
      const out = await f.apply(c, 'newsprint-400');
      const d = out.getContext('2d')!.getImageData(0, 0, 1100, 1).data;
      // Longest run of identical values along the row: dithering breaks the steps up.
      let run = 1; let longest = 1;
      for (let i = 4; i < d.length; i += 4) { run = d[i] === d[i - 4] ? run + 1 : 1; longest = Math.max(longest, run); }
      return longest;
    });
    expect(r, 'no long flat band').toBeLessThan(12);
  });

  test('Vivid: fine detail survives the contrast curve (base/detail split)', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const f = (window.__CINEROLL_DEBUG__ as unknown as { film: FilmApi }).film;
      const W = 2600; const H = 1400;
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d')!;
      x.fillStyle = '#2a2622'; x.fillRect(0, 0, W, H);
      for (let yy = 0; yy < H; yy += 2) for (let xx = (yy / 2) % 2 ? 0 : 2; xx < W; xx += 4) { x.fillStyle = '#3a342e'; x.fillRect(xx, yy, 2, 2); } // fine shadow texture
      const hp = (cv: HTMLCanvasElement) => {
        const d = cv.getContext('2d')!.getImageData(400, 400, 800, 400).data; let s = 0; let n = 0;
        for (let i = 4; i < d.length - 4; i += 4) { const l = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722; const r2 = d[i + 4] * 0.2126 + d[i + 5] * 0.7152 + d[i + 6] * 0.0722; s += Math.abs(l - r2); n++; }
        return s / n;
      };
      const out = await f.apply(c, 'velvia-50');
      return { before: hp(c), after: hp(out) };
    });
    expect(r.after, 'shadow texture kept (or enhanced), not crushed').toBeGreaterThan(r.before * 0.9);
  });

  test('strip processing gives the same pixels as the whole frame', async ({ page }) => {
    await page.goto('/');
    const png = await makeScene(page, 1600, 1000);
    const r = await page.evaluate(async (b64) => {
      const f = (window.__CINEROLL_DEBUG__ as unknown as { film: FilmApi }).film;
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d')!.drawImage(img, 0, 0);
      const res: Record<string, number> = {};
      for (const id of ['classic-pan-400', 'newsprint-400', 'velvia-50']) {
        const a = (await f.apply(c, id, { stripPixels: 1e9 })).getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        const b = (await f.apply(c, id, { stripPixels: 60000 })).getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
        res[id] = diff;
      }
      return res;
    }, png.toString('base64'));
    expect(r).toEqual({ 'classic-pan-400': 0, 'newsprint-400': 0, 'velvia-50': 0 });
  });
});

async function startWithScene(page: Page, browser: Browser, w: number, h: number, variant: 'day' | 'night' | 'food' = 'day') {
  void browser;
  await page.goto('/');
  const png = await makeScene(page, w, h, variant);
  await page.setInputFiles('#upload-input', { name: `${variant}.png`, mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.cropper-container');
  await page.waitForTimeout(300);
}

async function selectFilm(page: Page, film: FilmId) {
  await page.click('[data-tab="tone"]');
  await setControl(page, '#select-lut', film, ['change']);
  await page.waitForFunction(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmReady: boolean } }).preview().filmReady, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
}

test.describe('integration: Tone tab film selector', () => {
  test('the four films replace the old CSS "LUTs" in the selector', async ({ page }) => {
    await page.goto('/');
    const opts = await page.$$eval('#select-lut option', (os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(opts).toEqual(expect.arrayContaining(['none', 'classic-pan-400', 'newsprint-400', 'velvia-50', 'provia-100f']));
    expect(opts).not.toContain('kodak');
    expect(opts).not.toContain('fuji');
    expect(opts).not.toContain('cinematic');
  });

  for (const film of ['classic-pan-400', 'newsprint-400', 'velvia-50', 'provia-100f'] as FilmId[]) {
    test(`${film}: preview (>=2600px) and full-resolution export match`, async ({ page, browser }) => {
      test.setTimeout(180_000);
      await startWithScene(page, browser, 6000, 4000);
      await page.click('#strategy-btns [data-val="single"]');
      await page.click('#btn-apply-crop');
      await page.waitForSelector('.preview-slide-canvas');
      const plain = await previewStats(page);
      await selectFilm(page, film);
      expect((await page.evaluate(() => window.__CINEROLL_DEBUG__!.getState())).tone.lut).toBe(film);
      const info = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { w: number; h: number; filmReady: boolean } }).preview());
      expect(Math.max(info.w, info.h), 'preview film processed at >= 2600px').toBeGreaterThanOrEqual(2600);
      const p = await previewStats(page);
      expect(meanDiff(plain, p), 'the film changes the look').toBeGreaterThan(3);
      if (film.includes('pan') || film.includes('news')) expect(p.sat, 'B&W').toBeLessThan(8);
      await runExport(page, 'png');
      const e = await exportStats(page);
      const dims = await page.$eval('.export-img-item', (i) => [(i as HTMLImageElement).naturalWidth, (i as HTMLImageElement).naturalHeight]);
      expect(Math.max(...dims), 'export at full resolution').toBeGreaterThan(5000);
      console.log(`${film}: preview ${info.w}x${info.h} mean=${p.mean.map((v) => v.toFixed(1))} sat=${p.sat.toFixed(1)} std=${p.lumaStd.toFixed(1)} | export ${dims.join('x')} mean=${e.mean.map((v) => v.toFixed(1))} sat=${e.sat.toFixed(1)} std=${e.lumaStd.toFixed(1)}`);
      expect(meanDiff(p, e), 'preview colour == export colour').toBeLessThan(3);
      expect(Math.abs(p.sat - e.sat), 'same saturation').toBeLessThan(3);
      expect(Math.abs(p.lumaStd - e.lumaStd), 'same contrast').toBeLessThan(3);
      await closeExport(page);
    });
  }

  test('2.4:1 anamorphic panorama keeps its ratio through film + export (no crop to 3:2)', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await startWithScene(page, browser, 4800, 2000);
    await setControl(page, '#select-ratio', 'NaN', ['change']); // Seamless, Free
    await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    await selectFilm(page, 'velvia-50');
    const info = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { w: number; h: number } }).preview());
    expect(info.w / info.h).toBeCloseTo(2.4, 2);
    expect(await runExport(page, 'png')).toBe(3);
    const dims = await page.$$eval('.export-img-item', (is) => is.map((i) => [(i as HTMLImageElement).naturalWidth, (i as HTMLImageElement).naturalHeight]));
    const totalW = dims.reduce((a, d) => a + d[0], 0);
    expect(totalW / dims[0][1], 'three slides together are still 2.4:1').toBeCloseTo(2.4, 1);
  });

  test('tone sliders stay live on top of a film (the film is not re-developed per scrub step)', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await startWithScene(page, browser, 3000, 2000);
    await page.click('#strategy-btns [data-val="single"]');
    await page.click('#btn-apply-crop');
    await page.waitForSelector('.preview-slide-canvas');
    await selectFilm(page, 'velvia-50');
    const runs0 = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmRuns: number } }).preview().filmRuns);
    const before = await previewStats(page);
    await page.evaluate(() => { const s = document.getElementById('slider-hl') as HTMLInputElement; for (let v = 0; v <= 60; v += 5) { s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.waitForTimeout(600);
    expect(meanDiff(before, await previewStats(page)), 'highlights applied on top of the film').toBeGreaterThan(1);
    const runs1 = await page.evaluate(() => (window.__CINEROLL_DEBUG__ as unknown as { preview(): { filmRuns: number } }).preview().filmRuns);
    expect(runs1, 'film developed once, not per slider step').toBe(runs0);
  });
});

test.describe('categories the prototypes barely covered', () => {
  for (const variant of ['night', 'food'] as const) {
    for (const film of ['classic-pan-400', 'newsprint-400', 'velvia-50', 'provia-100f'] as FilmId[]) {
      test(`${variant} scene / ${film}: nothing clips to a flat field, preview == export`, async ({ page, browser }) => {
        test.setTimeout(180_000);
        await startWithScene(page, browser, 3000, 2000, variant);
        await page.click('#strategy-btns [data-val="single"]');
        await page.click('#btn-apply-crop');
        await page.waitForSelector('.preview-slide-canvas');
        await selectFilm(page, film);
        const p = await previewStats(page);
        await runExport(page, 'png');
        const e = await exportStats(page);
        console.log(`${variant}/${film}: mean=${p.mean.map((v) => v.toFixed(1))} std=${p.lumaStd.toFixed(1)} sat=${p.sat.toFixed(1)}`);
        expect(p.lumaStd, 'tonal variation kept').toBeGreaterThan(variant === 'night' ? 4 : 10);
        expect(meanDiff(p, e)).toBeLessThan(3);
        await page.screenshot({ path: `test-results/film-shots/${variant}-${film}.png` });
      });
    }
  }
});
