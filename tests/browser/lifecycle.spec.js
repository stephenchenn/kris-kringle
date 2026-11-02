const { test, expect } = require('@playwright/test');
const { startServer } = require('../support/server');

test('12 participants: invitation → draw → wishlist → private reservations → edit and delete', async ({ browser }, testInfo) => {
  const server = await startServer();
  const contexts = [];
  const errors = [];
  try {
    const seeded = await server.seed({
      participants: ['Alex', 'Blair', 'Casey', 'Drew', 'Eden', 'Finley', 'Georgia', 'Harper', 'Isla', 'Jamie', 'Kai', 'Logan']
        .map(name => ({ name: `Test ${name}`, email: `test+${name.toLowerCase()}@example.test` })),
      tiers: [{ name: 'BIG GIFT', budgetCents: 5000 }, { name: 'small gift', budgetCents: 2000 }],
    });
    await server.request('POST', '/api/admin/send-invites', { secret: server.secret, eventId: seeded.event.id });
    const people = seeded.people;
    for (const person of people) {
      const context = await browser.newContext({ ...testInfo.project.use, reducedMotion: 'reduce' });
      contexts.push(context);
      await context.route('**/api/wishlist/preview', route => route.fulfill({ status: 422,
        json: { error: 'Test product has no automatic details. Enter them below.' } }));
      person.page = await context.newPage();
      person.page.on('pageerror', error => errors.push(error.message));
      const email = server.emails().find(mail => mail.to[0].address === person.email);
      const link = email.html.match(/href="([^"]+\/draw\?token=[^"]+)"/)[1];
      await person.page.goto(link);
      await expect(person.page.locator('#drawBtn')).toBeEnabled();
      await expect(person.page.locator('#wishlistBtn')).toBeHidden();
      await expect(person.page.locator('#recipients')).not.toContainText(person.name);
      await person.page.locator('#drawBtn').click();
      await expect(person.page.locator('#drawBtn')).toBeDisabled();
      await expect(person.page.locator('#wishlistBtn')).toBeVisible();
      await expect(person.page.locator('#recipients li')).toHaveCount(2);
      const me = await server.request('GET', `/api/me?token=${person.token}`);
      person.id = me.data.me.id;
      person.recipients = me.data.recipients_by_tier;
    }
    const owner = people[0];
    const givers = people.filter(person => person.recipients.some(tier => tier.recipient === owner.name));
    const outsider = people.find(person => person !== owner && !givers.includes(person));
    const originalRecipients = await owner.page.locator('#recipients').textContent();
    await owner.page.reload();
    await expect(owner.page.locator('#recipients')).toHaveText(originalRecipients);
    await owner.page.locator('#resendBtn').click();
    await expect(owner.page.locator('#note')).toHaveText('Email re-sent. Check your inbox.');
    const confirmation = server.emails().filter(mail =>
      mail.to[0].address === owner.email && mail.subject === `Your Kris Kringle recipients for ${seeded.event.name}`
    ).at(-1);
    const wishlistLink = confirmation.html.match(/href="([^"]+\/wishlists\?token=[^"]+)"/)[1];
    expect(wishlistLink).toBe(`${server.baseUrl}/wishlists?token=${owner.token}`);
    await owner.page.goto(wishlistLink);
    await expect(owner.page.locator('#greeting')).toContainText(owner.name);
    await owner.page.locator('#btn_toggle_add').click();
    await owner.page.locator('#f_title').fill('Coffee grinder');
    await owner.page.locator('#f_url').fill('https://example.test/grinder');
    await owner.page.locator('#f_price').fill('99.50');
    await owner.page.locator('#f_notes').fill('Black please');
    await owner.page.locator('#btn_add').click();
    await expect(owner.page.locator('#msg_add')).toHaveText('Added!');
    const card = person => person.page.locator('#root > .card').filter({ has: person.page.locator('.owner', { hasText: new RegExp(`^${owner.name}$`) }) });
    const expandCard = async person => {
      const expand = card(person).locator('.btn-toggle[aria-expanded="false"]');
      if (await expand.count()) await expand.click();
    };
    await expect(card(owner)).toContainText('Coffee grinder');
    await expandCard(owner);
    for (const person of [...givers, outsider]) {
      await person.page.goto(`${server.baseUrl}/wishlists?token=${person.token}`);
      await expect(card(person)).toBeVisible();
      // Wishlist sections can be collapsed; expand this recipient when needed.
      await expandCard(person);
    }
    await givers[0].page.getByRole('button', { name: 'Reserve', exact: true }).first().click();
    await expect(card(givers[0]).getByRole('button', { name: 'Unreserve', exact: true })).toBeVisible();
    await givers[1].page.reload();
    await expect(card(givers[1])).toContainText('Reserved');
    await expect(card(givers[1]).getByRole('button', { name: 'Reserve', exact: true })).toHaveCount(0);
    await expect(card(givers[1]).getByRole('button', { name: 'Unreserve', exact: true })).toHaveCount(0);
    for (const person of [owner, outsider]) {
      await person.page.reload();
      await expect(card(person)).not.toContainText('Reserved');
      await expect(card(person).getByRole('button', { name: 'Reserve', exact: true })).toHaveCount(0);
    }
    await card(givers[0]).getByRole('button', { name: 'Unreserve', exact: true }).click();
    await expect(card(givers[0]).getByRole('button', { name: 'Reserve', exact: true })).toBeVisible();
    await givers[1].page.reload();
    await card(givers[1]).getByRole('button', { name: 'Reserve', exact: true }).click();
    await expect(card(givers[1]).getByRole('button', { name: 'Unreserve', exact: true })).toBeVisible();

    await card(owner).getByRole('button', { name: 'Edit', exact: true }).click();
    await card(owner).getByPlaceholder('Title *').fill('Updated grinder');
    await card(owner).getByRole('button', { name: 'Update', exact: true }).click();
    await expect(card(owner)).toContainText('Updated grinder');
    await expect(card(owner)).not.toContainText('Reserved');
    await givers[1].page.reload();
    await expect(card(givers[1])).toContainText('Updated grinder');
    await expect(card(givers[1])).toContainText('Reserved');
    owner.page.once('dialog', dialog => dialog.accept());
    await card(owner).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(card(owner)).not.toContainText('Updated grinder');
    await givers[1].page.reload();
    await expect(card(givers[1])).not.toContainText('Updated grinder');
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await server.stop();
    server.remove();
  }
});

test('direct wishlist URL before drawing returns to the draw page', async ({ page }) => {
  const server = await startServer();
  try {
    const seeded = await server.seed();
    await page.goto(`${server.baseUrl}/wishlists?token=${seeded.people[0].token}`);
    await expect(page).toHaveURL(/\/draw\?token=/);
    await expect(page.locator('#drawBtn')).toBeEnabled();
  } finally {
    await server.stop();
    server.remove();
  }
});
