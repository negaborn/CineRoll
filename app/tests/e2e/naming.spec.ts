import { test, expect } from './fixtures/test';

// Film looks are shown by their own preset names only; the real films they were
// modelled on stay in code/comments (reference/film-sim, film.ts), never in the UI.

const BRANDS = /\b(velvia|provia|fuji(film)?|kodak|ilford|hp5|tri-?x|portra|ektar|cinestill|agfa)\b/i; // whole words ("Portrait" is fine)

test('no real film brand or model name appears in the UI', async ({ page }) => {
  await page.goto('/');
  const texts = await page.evaluate(() => [
    document.body.innerText,
    ...Array.from(document.querySelectorAll('option')).map((o) => o.textContent ?? ''),
    ...Array.from(document.querySelectorAll('[title],[placeholder],[aria-label]')).map((e) => [e.getAttribute('title'), e.getAttribute('placeholder'), e.getAttribute('aria-label')].join(' ')),
  ].join('\n'));
  expect(texts.match(BRANDS)?.[0] ?? null).toBeNull();
  const films = await page.$$eval('#select-lut option', (os) => os.map((o) => o.textContent!.trim()));
  expect(films).toEqual(expect.arrayContaining(['Classic Pan 400 (B&W)', 'Newsprint 400 (B&W)', 'Vivid Slide 50', 'Natural Slide 100']));
});
