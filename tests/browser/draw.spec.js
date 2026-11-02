const { test, expect } = require('@playwright/test');
const { startServer } = require('../support/server');

test('missing and invalid invitations show helpful errors without exposing draw controls', async ({ page }) => {
  const server = await startServer();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const suffix of ['', '?token=invalid']) {
      await page.goto(`${server.baseUrl}/draw${suffix}`);
      await expect(page.locator('#error')).not.toBeEmpty();
      await expect(page.locator('#status')).toBeHidden();
      await expect(page.locator('#loading')).toBeHidden();
      await expect(page.locator('#wishlistBtn')).toBeHidden();
    }
    expect(errors).toEqual([]);
  } finally { await server.stop(); server.remove(); }
});

test('a failed draw can be retried; gift prices and saved state survive refresh', async ({ page }) => {
  const server = await startServer();
  try {
    const { people } = await server.seed({ tiers: [{ name: 'Little treat', budgetCents: 2050 }] });
    let fail = true;
    await page.route('**/api/draw', route => {
      if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Please try again.' } }); }
      return route.continue();
    });
    await page.goto(people[0].link);
    await expect(page.locator('#drawBtn')).toBeEnabled();
    await expect(page.locator('.gift-budget')).toHaveText('$20.50');
    await page.locator('#drawBtn').click();
    await expect(page.locator('#error')).toHaveText('Please try again.');
    await expect(page.locator('#drawBtn')).toBeEnabled();
    await expect(page.locator('#wishlistBtn')).toBeHidden();
    await page.locator('#drawBtn').click();
    await expect(page.locator('#wishlistBtn')).toBeVisible();
    await expect(page.locator('#error')).toBeEmpty();
    await expect(page.locator('#draw-state')).toHaveText('Draw saved');
    const recipient = await page.locator('.gift-recipient').textContent();
    await page.reload();
    await expect(page.locator('.gift-recipient')).toHaveText(recipient);
    await expect(page.locator('#drawBtn')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await server.stop(); server.remove(); }
});
