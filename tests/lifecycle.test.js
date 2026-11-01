const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');
const path = require('node:path');
const { startServer } = require('./support/server');

test('event lifecycle, email links, wishlist privacy, reservations and persistence', async t => {
  let server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  const seeded = await server.seed({}, {
    'X-Forwarded-Host': 'untrusted.example', 'X-Forwarded-Proto': 'https',
  });
  const people = seeded.people;
  const eventId = seeded.event.id;
  const getMe = person => server.request('GET', `/api/me?token=${person.token}`);
  const getAll = person => server.request('GET', `/api/wishlists/all?token=${person.token}`);
  const itemIn = (response, ownerId, itemId) => response.data.wishlists
    .find(wishlist => wishlist.owner.id === ownerId).items.find(item => item.id === itemId);
  const admin = route => server.request('POST', `/api/admin/${route}`, { secret: server.secret, eventId });
  const act = (person, item, verb) => server.request('POST', `/api/wishlist/item/${item}/${verb}`, { token: person.token });

  await t.test('admin authentication, input validation and missing events', async () => {
    assert.equal((await server.request('POST', '/api/admin/seed', {})).status, 403);
    assert.equal((await server.request('POST', '/api/admin/seed', { secret: server.secret, eventName: 'Invalid', participants: [{ name: 'One' }, { name: 'Two' }], giftsPerPerson: 1 })).status, 400);
    assert.equal((await server.request('POST', '/api/admin/send-invites', { secret: server.secret, eventId: 'missing' })).status, 404);
    assert.equal((await server.request('POST', '/api/admin/send-wishlists', { secret: server.secret, eventId: 'missing' })).status, 404);
    assert.equal((await server.request('POST', '/api/admin/event/update', { secret: server.secret, eventId: 'missing' })).status, 404);
    assert.equal((await server.request('GET', '/api/wishlists/all?token=invalid')).status, 401);
  });

  await t.test('invitation emails contain the canonical hostname and personal tokens', async () => {
    assert(people.every(person => person.link.startsWith(server.baseUrl)));
    const result = await admin('send-invites');
    assert.equal(result.data.sent, 5);
    assert.deepEqual(result.data.failed, []);
    assert.equal(server.emails().length, 5);
    for (const person of people) {
      const email = server.emails().find(mail => mail.to[0].address === person.email);
      assert(email.html.includes(person.link));
      assert(email.text.includes(person.link));
      assert(email.text.includes(person.name));
      assert(email.text.includes(seeded.event.name));
      assert(email.text.includes('Keep this link private'));
      assert(!email.html.includes('untrusted.example'));
      assert(!email.text.includes('untrusted.example'));
      for (const other of people.filter(other => other !== person)) {
        assert(!email.text.includes(other.token));
      }
    }
  });

  await t.test('draw stays hidden until revealed; all wishlist APIs require a draw', async () => {
    for (const person of people) {
      const me = await getMe(person);
      person.id = me.data.me.id;
      assert.equal(me.data.me.has_drawn, false);
      assert(me.data.recipients_by_tier.every(tier => tier.recipient === null));
      assert.equal(me.headers.get('cache-control'), 'no-store');
      assert.equal((await getAll(person)).status, 403);
      assert.equal((await server.request('GET', `/api/wishlist/me?token=${person.token}`)).status, 403);
      assert.equal((await server.request('POST', '/api/wishlist/item', { token: person.token, title: 'Too early' })).status, 403);
      assert.equal((await server.request('POST', '/api/resend', { token: person.token })).status, 400);
    }
    assert.equal(server.emails().length, 5);
  });

  await t.test('every participant gives and receives each budget with no self or duplicate recipients', async () => {
    for (const person of people) {
      const result = await server.request('POST', '/api/draw', { token: person.token }, {
        'X-Forwarded-Host': 'untrusted.example', 'X-Forwarded-Proto': 'https',
      });
      assert.equal(result.status, 200);
      person.recipients = result.data.recipients_by_tier;
      assert.deepEqual(person.recipients.map(tier => tier.budget_cents), [10000, 5000]);
      assert(!person.recipients.some(tier => tier.recipient === person.name));
      assert.equal(new Set(person.recipients.map(tier => tier.recipient)).size, 2);
      assert.equal((await getMe(person)).data.me.has_drawn, true);
    }
    for (let tier = 0; tier < 2; tier++) {
      assert.equal(new Set(people.map(person => person.recipients[tier].recipient)).size, 5);
    }
    for (let i = 0; server.emails().length < 10 && i < 100; i++) await delay(20);
    assert.equal(server.emails().length, 10);
    const repeated = await server.request('POST', '/api/draw', { token: people[0].token });
    assert.deepEqual(repeated.data.recipients_by_tier, people[0].recipients);
    await delay(50);
    assert.equal(server.emails().length, 10);
    assert.equal((await server.request('POST', '/api/resend', { token: people[0].token })).status, 200);
    assert.equal(server.emails().length, 11);
  });

  await t.test('draw confirmations and resends link to the correct participant’s wishlist', async () => {
    const confirmations = server.emails().filter(mail => mail.subject === `Your Kris Kringle recipients for ${seeded.event.name}`);
    for (const person of people) {
      const emails = confirmations.filter(mail => mail.to[0].address === person.email);
      assert.equal(emails.length, person === people[0] ? 2 : 1);
      const link = `${server.baseUrl}/wishlists?token=${encodeURIComponent(person.token)}`;
      for (const mail of emails) {
        assert(mail.html.includes(`href="${link}"`));
        assert(mail.text.includes(link));
        assert(!mail.html.includes('untrusted.example'));
        for (const other of people.filter(other => other !== person)) {
          assert(!mail.html.includes(other.token));
          assert(!mail.text.includes(other.token));
        }
      }
    }
  });

  const owner = people[0];
  const givers = people.filter(person => person.recipients.some(tier => tier.recipient === owner.name));
  const outsider = people.find(person => person !== owner && !givers.includes(person));
  let itemId;
  await t.test('wishlist CRUD is owner-only; reservations visible only to assigned givers', async () => {
    const created = await server.request('POST', '/api/wishlist/item', {
      token: owner.token, title: 'Coffee grinder', url: 'https://example.test/grinder',
      notes: 'Black please', price_cents: 10000, image_url: 'https://example.test/grinder.jpg',
    });
    assert.equal(created.status, 200);
    assert(!('reserved_by' in created.data.item));
    itemId = created.data.item.id;
    assert.equal((await act(outsider, itemId, 'reserve')).status, 403);
    assert.equal((await act(outsider, itemId, 'unreserve')).status, 403);
    assert.equal((await act(owner, itemId, 'reserve')).status, 400);
    assert.equal((await act(givers[0], itemId, 'reserve')).status, 200);
    assert.equal((await act(givers[0], itemId, 'reserve')).status, 200);
    assert.equal((await act(givers[1], itemId, 'reserve')).status, 409);
    assert.equal((await act(givers[1], itemId, 'unreserve')).status, 403);
    const firstView = itemIn(await getAll(givers[0]), owner.id, itemId);
    assert.equal(firstView.is_reserved, 1);
    assert.equal(firstView.reserved_by_me, 1);
    const secondView = itemIn(await getAll(givers[1]), owner.id, itemId);
    assert.equal(secondView.is_reserved, 1);
    assert.equal(secondView.reserved_by_me, 0);
    assert(!('reserved_by' in secondView));
    for (const person of [owner, outsider]) {
      const view = itemIn(await getAll(person), owner.id, itemId);
      assert.equal(view.is_reserved, 0);
      assert.equal(view.reserved_by_me, 0);
    }
    const privateView = await server.request('GET', `/api/wishlist/me?token=${owner.token}`);
    assert(!('reserved_by' in privateView.data.items[0]));
    assert(!('is_reserved' in privateView.data.items[0]));
    assert.equal((await server.request('PUT', `/api/wishlist/item/${itemId}`, { token: outsider.token, title: 'Changed' })).status, 403);
    assert.equal((await server.request('DELETE', `/api/wishlist/item/${itemId}`, { token: outsider.token })).status, 403);
    const edited = await server.request('PUT', `/api/wishlist/item/${itemId}`, { token: owner.token, title: 'Updated grinder', price_cents: 9900 });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.item.title, 'Updated grinder');
    assert(!('reserved_by' in edited.data.item));
    assert(!('is_reserved' in edited.data.item));
    assert.equal((await act(givers[0], itemId, 'unreserve')).status, 200);
    assert.equal(itemIn(await getAll(givers[1]), owner.id, itemId).is_reserved, 0);
    assert.equal((await act(givers[1], itemId, 'reserve')).status, 200);
  });

  await t.test('other events cannot view or change this event’s items', async () => {
    const other = await server.seed({ eventName: 'Other event' });
    const person = other.people[0];
    await server.request('POST', '/api/draw', { token: person.token });
    const otherLists = await getAll(person);
    assert(!otherLists.data.wishlists.some(wishlist => wishlist.owner.id === owner.id));
    assert.equal((await act(person, itemId, 'reserve')).status, 403);
    assert.equal((await act(person, itemId, 'unreserve')).status, 403);
    assert.equal((await server.request('DELETE', `/api/wishlist/item/${itemId}`, { token: person.token })).status, 403);
  });

  await t.test('wishlist emails and event updates use the correct event and address', async () => {
    const result = await admin('send-wishlists');
    assert.equal(result.data.sent, 5);
    assert.deepEqual(result.data.failed, []);
    const mail = server.emails().find(email => email.subject === `Your wishlist link for ${seeded.event.name}`);
    assert(mail.text.includes(`${server.baseUrl}/wishlists?token=`));
    assert.equal((await server.request('POST', '/api/admin/event/update', { secret: server.secret, eventId, location: 'New venue' })).status, 200);
    assert.equal((await getMe(owner)).data.event.location, 'New venue');
  });

  await t.test('draws, wishlist edits and reservations survive a full server restart', async () => {
    const { directory, secret } = server;
    await server.stop();
    server = await startServer({ directory, secret });
    assert.deepEqual((await getMe(owner)).data.recipients_by_tier, owner.recipients);
    assert.equal((await getMe(owner)).data.event.location, 'New venue');
    const item = itemIn(await getAll(givers[1]), owner.id, itemId);
    assert.equal(item.title, 'Updated grinder');
    assert.equal(item.is_reserved, 1);
    assert.equal(item.reserved_by_me, 1);
    assert.equal((await server.request('DELETE', `/api/wishlist/item/${itemId}`, { token: owner.token })).status, 200);
    assert.equal((await act(givers[1], itemId, 'reserve')).status, 404);
  });

  await t.test('two participants can exchange more gifts than available unique recipients', async () => {
    const small = await server.seed({
      participants: [{ name: 'One', email: 'one@example.test' }, { name: 'Two', email: 'two@example.test' }],
      tiers: Array.from({ length: 5 }, (_, i) => ({ name: `Gift ${i + 1}`, budgetCents: (i + 1) * 1000 })),
    });
    for (const person of small.people) {
      const drawn = await server.request('POST', '/api/draw', { token: person.token });
      assert.equal(drawn.data.recipients_by_tier.length, 5);
      assert(drawn.data.recipients_by_tier.every(tier => tier.recipient !== person.name));
    }
  });

  await t.test('reset cascades cleanly through all tables in the isolated test database', async () => {
    assert.equal((await admin('reset')).status, 200);
    const snapshot = new Database(path.join(server.directory, 'db.sqlite'), { readonly: true });
    try {
      for (const table of ['events', 'participants', 'gift_tiers', 'assignments', 'wishlists', 'wishlist_items']) {
        assert.equal(snapshot.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
      }
      assert.deepEqual(snapshot.pragma('foreign_key_check'), []);
    } finally { snapshot.close(); }
  });
});
