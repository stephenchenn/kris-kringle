const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer } = require('./support/server');

const participants = count => Array.from({ length: count }, (_, i) => ({
  name: `Test guest ${String(i + 1).padStart(2, '0')}`, email: `guest+${i + 1}@example.test`,
}));

// Exercise the real HTTP routes and SQLite, rather than just the allocator.
test('larger events conserve every tier, including the unique-recipient limit', async t => {
  const server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  for (const [size, tierCount] of [[12, 2], [30, 3], [12, 11], [12, 14]]) {
    await t.test(`${size} participants and ${tierCount} tiers`, async () => {
      const seeded = await server.seed({ participants: participants(size),
        tiers: Array.from({ length: tierCount }, (_, i) => ({ name: `Tier ${i + 1}`, budgetCents: 5000 - i * 100 })),
      });
      const people = seeded.people;
      for (const person of people) {
        const before = await server.request('GET', `/api/me?token=${person.token}`);
        assert.equal(before.data.me.has_drawn, false);
        assert(before.data.recipients_by_tier.every(tier => tier.recipient === null));
      }
      const draws = await Promise.all(people.map(person => server.request('POST', '/api/draw', { token: person.token })));
      for (const [i, draw] of draws.entries()) {
        assert.equal(draw.status, 200);
        const tiers = draw.data.recipients_by_tier;
        assert.equal(tiers.length, tierCount);
        assert.deepEqual(tiers.map(tier => tier.budget_cents), seeded.event.tiers.map(tier => tier.budget_cents));
        assert.equal(new Set(tiers.map(tier => tier.tier_id)).size, tierCount);
        assert(tiers.every(tier => tier.recipient !== people[i].name));
        const counts = people.filter(person => person !== people[i]).map(person => tiers.filter(tier => tier.recipient === person.name).length);
        assert.equal(new Set(tiers.map(tier => tier.recipient)).size, Math.min(tierCount, size - 1));
        assert(Math.max(...counts) - Math.min(...counts) <= 1);
        const repeat = await server.request('POST', '/api/draw', { token: people[i].token });
        assert.deepEqual(repeat.data.recipients_by_tier, tiers);
      }
      for (let tier = 0; tier < tierCount; tier++) {
        assert.deepEqual(draws.map(draw => draw.data.recipients_by_tier[tier].recipient).sort(), people.map(person => person.name).sort());
      }
    });
  }
});

test('12 participants: reservation permissions and privacy for every owner/viewer pair', async t => {
  const server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  const seeded = await server.seed({ participants: participants(12),
    tiers: [{ name: 'BIG GIFT', budgetCents: 5000 }, { name: 'small gift', budgetCents: 2000 }],
  });
  const people = seeded.people;
  const request = server.request;
  for (const person of people) {
    const draws = await Promise.all([1, 2].map(() => request('POST', '/api/draw', { token: person.token })));
    assert.deepEqual(draws[0].data, draws[1].data);
    person.recipients = draws[0].data.recipients_by_tier;
    person.id = (await request('GET', `/api/me?token=${person.token}`)).data.me.id;
  }
  for (let i = 0; server.emails().length < 12 && i < 100; i++) await delay(20);
  assert.equal(server.emails().length, 12, 'simultaneous draw clicks send only one confirmation each');

  for (const owner of people) {
    await t.test(`private reservation for ${owner.name}`, async () => {
      const givers = people.filter(person => person.recipients.some(tier => tier.recipient === owner.name));
      assert.equal(givers.length, 2);
      const outsiders = people.filter(person => person !== owner && !givers.includes(person));
      const created = await request('POST', '/api/wishlist/item', { token: owner.token, title: `Wish for ${owner.name}`, price_cents: 2000 });
      assert.equal(created.status, 200);
      const itemId = created.data.item.id;
      const ownerBefore = await request('GET', `/api/wishlist/me?token=${owner.token}`);
      const act = (person, verb) => request('POST', `/api/wishlist/item/${itemId}/${verb}`, { token: person.token });
      assert.equal((await act(owner, 'reserve')).status, 400);
      for (const outsider of outsiders) {
        assert.equal((await act(outsider, 'reserve')).status, 403);
        assert.equal((await act(outsider, 'unreserve')).status, 403);
        assert.equal((await request('PUT', `/api/wishlist/item/${itemId}`, { token: outsider.token, title: 'Forged edit' })).status, 403);
        assert.equal((await request('DELETE', `/api/wishlist/item/${itemId}`, { token: outsider.token })).status, 403);
      }
      const race = await Promise.all(givers.map(person => act(person, 'reserve')));
      assert.deepEqual(race.map(result => result.status).sort(), [200, 409], 'exactly one reservation wins');
      const winner = givers[race.findIndex(result => result.status === 200)];
      const other = givers.find(person => person !== winner);
      assert.equal((await act(winner, 'reserve')).status, 200, 'repeat reservation is idempotent');
      assert.equal((await act(other, 'unreserve')).status, 403);
      for (const viewer of people) {
        const all = await request('GET', `/api/wishlists/all?token=${viewer.token}`);
        assert.equal(all.status, 200);
        const item = all.data.wishlists.find(list => list.owner.id === owner.id).items.find(item => item.id === itemId);
        assert.equal(item.is_reserved, Number(givers.includes(viewer)));
        assert.equal(item.reserved_by_me, Number(viewer === winner));
        assert(!('reserved_by' in item));
        assert(!('updated_at' in item));
        for (const person of people.filter(person => person !== viewer)) assert(!JSON.stringify(all.data).includes(person.token));
      }
      const ownerAfter = await request('GET', `/api/wishlist/me?token=${owner.token}`);
      assert.deepEqual(ownerAfter.data, ownerBefore.data, 'even owner-visible timestamps must not disclose a reservation');
      assert.equal((await act(winner, 'unreserve')).status, 200);
      assert.equal((await act(other, 'reserve')).status, 200);
      const edited = await request('PUT', `/api/wishlist/item/${itemId}`, { token: owner.token, title: 'Updated wish', price_cents: 1999 });
      assert.equal(edited.status, 200);
      assert(!('reserved_by' in edited.data.item));
      assert.equal((await request('DELETE', `/api/wishlist/item/${itemId}`, { token: owner.token })).status, 200);
      assert.equal((await act(other, 'reserve')).status, 404);
    });
  }
});

test('different query/body tokens cannot bypass the completed-draw requirement', async t => {
  const server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  const { people } = await server.seed();
  await server.request('POST', '/api/draw', { token: people[0].token });
  const body = { token: people[1].token, title: 'Before drawing' };
  assert.equal((await server.request('POST', '/api/wishlist/item', body)).status, 403);
  assert.equal((await server.request('POST', `/api/wishlist/item?token=${people[0].token}`, body)).status, 400);
});
