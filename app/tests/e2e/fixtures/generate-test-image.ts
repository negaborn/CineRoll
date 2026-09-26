import type { Browser, Page } from '@playwright/test';

export async function createTestImageBuffer(browser: Browser, width: number, height: number): Promise<Buffer> {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(
    ({ width, height }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d')!;
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#ff4040');
      grad.addColorStop(0.5, '#40ff90');
      grad.addColorStop(1, '#4060ff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = Math.max(1, width / 400);
      for (let x = 0; x < width; x += width / 10) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += height / 10) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      return c.toDataURL('image/jpeg', 0.85);
    },
    { width, height },
  );
  await page.close();
  const base64 = dataUrl.split(',')[1];
  return Buffer.from(base64, 'base64');
}

export async function uploadTestImage(page: Page, browser: Browser, width = 6000, height = 4000) {
  const buffer = await createTestImageBuffer(browser, width, height);
  await page.setInputFiles('#upload-input', { name: 'test.jpg', mimeType: 'image/jpeg', buffer });
  await page.waitForSelector('#tab-format:not(.hidden)');
  await page.waitForTimeout(300);
}
