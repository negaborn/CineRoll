import { test, expect, type Page } from './fixtures/test';
import { previewStats, exportStats, runExport, meanDiff, setControl } from './fixtures/pixels';

// Technical plan v2, P1-3: never hand the GPU a texture larger than it supports.
// Engine3D assumed 4096 (preview) / 2048 tiles (export) without asking the GPU;
// on a GPU with a smaller MAX_TEXTURE_SIZE the tone pass would come out black.
// Here the GPU reports 1024: every texture upload must fit, and the tone pass
// must look the same as on an unrestricted GPU.

const FAKE_MAX = 1024;

async function fakeGpu(page: Page) {
  await page.addInitScript((max) => {
    const w = window as unknown as { __maxTexUpload: number };
    w.__maxTexUpload = 0;
    const proto = WebGL2RenderingContext.prototype;
    const getParameter = proto.getParameter;
    proto.getParameter = function (p: number) {
      if (p === this.MAX_TEXTURE_SIZE || p === this.MAX_RENDERBUFFER_SIZE) return max;
      if (p === this.MAX_VIEWPORT_DIMS) return new Int32Array([max, max]);
      return getParameter.call(this, p);
    };
    const texImage2D = proto.texImage2D as (...a: unknown[]) => void;
    proto.texImage2D = function (...args: unknown[]) {
      const src = args[args.length - 1] as { width?: number; height?: number } | null;
      const dims = typeof args[3] === 'number' && typeof args[4] === 'number' && args.length > 6 ? [args[3] as number, args[4] as number] : [src?.width ?? 0, src?.height ?? 0];
      w.__maxTexUpload = Math.max(w.__maxTexUpload, ...dims);
      return texImage2D.apply(this, args);
    } as typeof proto.texImage2D;
  }, FAKE_MAX);
}

async function photo(page: Page, w: number, h: number) {
  const jpg = await page.evaluate(({ w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#102030'); g.addColorStop(0.5, '#a08060'); g.addColorStop(1, '#f0f0e0'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, { w, h });
  return Buffer.from(jpg, 'base64');
}

async function run(page: Page, gpuLimited: boolean) {
  if (gpuLimited) await fakeGpu(page);
  await page.goto('/');
  await page.setInputFiles('#upload-input', { name: 'p.jpg', mimeType: 'image/jpeg', buffer: await photo(page, 6000, 4000) });
  await page.waitForSelector('.cropper-container'); await page.waitForTimeout(300);
  await page.click('#strategy-btns [data-val="single"]');
  await page.evaluate(() => window.__CINEROLL_DEBUG__!.setCropForTest({ x: 0, y: 0, width: 1, height: 1 }));
  await page.click('#btn-apply-crop');
  await page.waitForSelector('.preview-slide-canvas');
  await page.click('[data-tab="tone"]');
  await setControl(page, '#slider-hl', '50', ['input']);
  await setControl(page, '#slider-sh', '30', ['input']);
  await page.waitForTimeout(1500);
  const preview = await previewStats(page);
  await runExport(page, 'tiff');
  const exported = await exportStats(page);
  const maxUpload = await page.evaluate(() => (window as unknown as { __maxTexUpload?: number }).__maxTexUpload ?? 0);
  return { preview, exported, maxUpload };
}

test('a GPU with MAX_TEXTURE_SIZE 1024 gets only textures it supports, with the same result', async ({ browser }) => {
  test.setTimeout(400_000);
  const normal = await run(await browser.newPage(), false);
  const limited = await run(await browser.newPage(), true);
  expect(limited.maxUpload, 'largest texture uploaded').toBeLessThanOrEqual(FAKE_MAX);
  expect(limited.maxUpload).toBeGreaterThan(0);
  expect(meanDiff(limited.preview, normal.preview), 'preview tone pass unchanged').toBeLessThan(2);
  expect(meanDiff(limited.exported, normal.exported), 'export tone pass unchanged').toBeLessThan(2);
  expect(limited.exported.lumaStd).toBeGreaterThan(10); // not black
});
