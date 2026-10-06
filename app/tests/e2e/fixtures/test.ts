// Shared test entry point: Playwright's own, with every collapsible settings
// section opened on load -- most specs click controls that live in groups the
// app shows collapsed by default (layout.spec checks the collapsed defaults).
import { test as base } from '@playwright/test';

export * from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll<HTMLDetailsElement>('details[data-section]').forEach((d) => { d.open = true; });
      });
    });
    await use(page);
  },
});
