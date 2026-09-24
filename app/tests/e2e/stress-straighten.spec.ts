import { test, type Page } from '@playwright/test';
import path from 'path';
import { makePositionImage } from './fixtures/position-image';

// Opt-in: STRESS=1 npx playwright test stress-straighten
// Runs the same Straighten -> Apply -> Export flow many times against both
// the deployed v150 build and the current build, and measures the rotation
// that actually ended up in the preview and export *pixels* (decoded from the
// position-coded source) -- no reliance on app state, so v150 can be probed too.
test.skip(!process.env.STRESS, 'stress run is opt-in (STRESS=1)');
test.setTimeout(20 * 60 * 1000);

const RUNS = Number(process.env.STRESS_RUNS || 25);
const ANGLE = 10;
const W = 1600;
const H = 1200;
const V150 = 'file://' + path.resolve(process.cwd(), '../index.html');

type Target = 'v150' | 'current';
type Scenario = 'direct' | 'during-squeeze-rebuild' | 'rapid-double-squeeze' | 'angle-before-cropper-ready';

/** Least-squares affine fit over a 9x9 grid: output -> source pixels. Returns the output x-axis angle in source space (null if too few opaque samples). */
const MEASURE = `(async (src, W0, H0) => {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const pts = [];
  for (let i = 1; i <= 9; i++) for (let j = 1; j <= 9; j++) {
    const d = x.getImageData(Math.floor(i / 10 * (c.width - 1)), Math.floor(j / 10 * (c.height - 1)), 1, 1).data;
    if (d[3] < 250) continue;
    pts.push([i / 10 * c.width, j / 10 * c.height, d[0] / 255 * W0, d[1] / 255 * H0]);
  }
  if (pts.length < 20) return null;
  const solve = (k) => { const S = [[0,0,0],[0,0,0],[0,0,0]], t = [0,0,0];
    for (const p of pts) { const r = [p[0], p[1], 1]; for (let m=0;m<3;m++){ t[m]+=r[m]*p[k]; for(let n=0;n<3;n++) S[m][n]+=r[m]*r[n]; } }
    const det = (M) => M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1]) - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0]) + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
    const D = det(S); return [0,1,2].map(col => det(S.map((row,ri)=>row.map((v,ci)=> ci===col ? t[ri] : v))) / D); };
  const U = solve(2), V = solve(3);
  return Math.round(Math.atan2(V[0], U[0]) * 1800 / Math.PI) / 10;
})`;

async function previewSrc(page: Page, target: Target) {
  return target === 'v150'
    ? page.evaluate(() => (document.querySelector('.preview-img') as HTMLImageElement).src)
    : page.evaluate(() => (document.querySelector('.preview-slide-canvas') as HTMLCanvasElement).toDataURL());
}

async function once(page: Page, target: Target, buf: Buffer, scenario: Scenario) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { errors.push('dialog: ' + d.message()); await d.dismiss(); });
  await page.goto(target === 'v150' ? V150 : '/');
  await page.setInputFiles('#upload-input', { name: 'p.png', mimeType: 'image/png', buffer: buf });
  let sf = 1;
  if (scenario === 'angle-before-cropper-ready') {
    // Set the angle the instant the upload is accepted, before Cropper has mounted.
    await page.evaluate((deg) => { const s = document.getElementById('slider-angle') as HTMLInputElement; s.value = String(deg); s.dispatchEvent(new Event('input')); }, ANGLE);
  }
  await page.waitForSelector('.cropper-container', { timeout: 10000 });
  await page.click('#strategy-btns [data-val="single"]');
  if (scenario === 'rapid-double-squeeze') {
    // Two squeeze changes 40ms apart: two overlapping rebuilds (v150 schedules setTimeout(setupCropper, 300) per change).
    await page.selectOption('#select-squeeze', '133');
    await page.waitForTimeout(40);
    await page.selectOption('#select-squeeze', '150');
    sf = 1.5;
    await page.waitForTimeout(150);
  }
  if (scenario === 'during-squeeze-rebuild') {
    await page.selectOption('#select-squeeze', '133');
    sf = 1.33;
    await page.waitForTimeout(150); // inside the 300ms rebuild window
  }
  if (scenario !== 'angle-before-cropper-ready') {
    await page.evaluate((deg) => { const s = document.getElementById('slider-angle') as HTMLInputElement; s.value = String(deg); s.dispatchEvent(new Event('input')); }, ANGLE);
  }
  await page.waitForTimeout(600);
  if (target === 'v150') await page.getByRole('button', { name: 'Apply Crop' }).click();
  else await page.click('#btn-apply-crop');
  await page.waitForSelector('#tab-frame:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(400);
  const pv = await page.evaluate(`${MEASURE}(${JSON.stringify(await previewSrc(page, target))}, ${W * sf}, ${H})`) as number | null;
  await page.selectOption('#exportQuality', 'png');
  await page.click('#btn-export');
  await page.waitForSelector('.export-img-item', { timeout: 30000 });
  await page.waitForTimeout(300);
  const exSrc = await page.evaluate(() => (document.querySelector('.export-img-item') as HTMLImageElement).src);
  const ex = await page.evaluate(`${MEASURE}(${JSON.stringify(exSrc)}, ${W * sf}, ${H})`) as number | null;
  return { preview: pv, export: ex, errors };
}

const SCENARIOS = (process.env.STRESS_SCENARIOS?.split(',') ?? ['direct', 'during-squeeze-rebuild', 'rapid-double-squeeze', 'angle-before-cropper-ready']) as Scenario[];
for (const scenario of SCENARIOS) {
  for (const target of ['v150', 'current'] as const) {
    test(`stress: ${target} · ${scenario} · ${RUNS} runs`, async ({ browser }) => {
      const buf = await makePositionImage(browser, W, H);
      const tally: Record<string, number> = {};
      const rows: string[] = [];
      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ baseURL: 'http://localhost:5183', acceptDownloads: true });
        const page = await ctx.newPage();
        let key: string;
        try {
          const r = await once(page, target, buf, scenario);
          const cls = (a: number | null) => (a === null ? 'n/a' : Math.abs(Math.abs(a) - ANGLE) < 1 ? 'rotated' : Math.abs(a) < 1 ? 'flat' : `off(${a})`);
          key = `preview=${cls(r.preview)} export=${cls(r.export)}${r.errors.length ? ' errors' : ''}`;
          rows.push(`#${i + 1} preview=${r.preview} export=${r.export}${r.errors.length ? ' ' + r.errors.join('|') : ''}`);
        } catch (e) {
          key = 'FAILED: ' + (e as Error).message.split('\n')[0];
          rows.push(`#${i + 1} ${key}`);
        }
        tally[key] = (tally[key] || 0) + 1;
        await ctx.close();
      }
      console.log(`STRESS ${target} ${scenario}\n  ` + Object.entries(tally).map(([k, v]) => `${v}x ${k}`).join('\n  ') + '\n  -- ' + rows.join('\n  -- '));
    });
  }
}
