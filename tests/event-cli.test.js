const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const { startServer } = require('./support/server');

const execute = promisify(execFile);
const script = path.join(__dirname, '../scripts/event.js');
function config(secret) {
  return { secret, eventName: 'CLI Christmas 2026', eventDate: '2026-12-25T18:00:00+10:30', location: 'CLI test venue',
    participants: ['Alex', 'Blair', 'Casey', 'Drew'].map(name => ({ name, email: `${name.toLowerCase()}@example.test` })),
    tiers: [{ name: 'Big gift', budgetCents: 10000 }, { name: 'Small gift', budgetCents: 5000 }] };
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function run(command, filename, url, ...options) {
  try {
    const output = await execute(process.execPath, [script, command, '--file', filename, '--url', url, ...options], { timeout: 15000 });
    return { code: 0, ...output };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('event CLI creates, emails, reuses assignments and manages reminders using saved IDs', async t => {
  const server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  const file = path.join(server.directory, 'event-cli.json');
  const resultFile = path.join(server.directory, 'event-cli-result.json');
  const stateFile = path.join(server.directory, 'event-cli-state.json');
  const sendFile = path.join(server.directory, 'send-cli.json');
  const input = config(server.secret);
  write(file, input);
  // A previous curl validation error must not be mistaken for a created event.
  write(resultFile, { error: 'Each participant needs a name and valid email' });

  const created = await run('create', file, server.baseUrl);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /Invitations: 4 sent, 0 failed/);
  assert(!created.stdout.includes(server.secret));
  const first = read(resultFile);
  assert.equal(read(stateFile).invitations.status, 'sent');
  assert.deepEqual(read(sendFile), { secret: server.secret, eventId: first.event.id });
  assert.equal(server.emails().length, 4);
  if (process.platform !== 'win32') {
    for (const saved of [resultFile, stateFile, sendFile]) assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  }
  const db = new Database(path.join(server.directory, 'db.sqlite'), { readonly: true });
  t.after(() => db.close());
  const originalAssignments = db.prepare('SELECT * FROM assignments ORDER BY id').all();

  const repeated = await run('create', file, server.baseUrl);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.match(repeated.stdout, /Invitations were already sent/);
  assert.equal(read(resultFile).event.id, first.event.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
  assert.deepEqual(db.prepare('SELECT * FROM assignments ORDER BY id').all(), originalAssignments);
  assert.equal(server.emails().length, 4);

  const links = await run('links', file, server.baseUrl);
  assert.equal(links.code, 0, links.stderr);
  assert(links.stdout.includes(first.invites[0].link));
  assert(links.stdout.includes(first.invites[0].link.replace('/draw?', '/wishlists?')));
  assert(!links.stdout.includes(server.secret));

  const reminder = await run('wishlists', file, server.baseUrl);
  assert.equal(reminder.code, 0, reminder.stderr);
  assert.equal(server.emails().length, 8);
  assert.equal(read(stateFile).wishlists.sent, 4);
  const resent = await run('invite', file, server.baseUrl);
  assert.equal(resent.code, 0, resent.stderr);
  assert.equal(server.emails().length, 12);

  input.eventName = 'A different Christmas';
  write(file, input);
  const changed = await run('create', file, server.baseUrl);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /differs from the saved event/);
  assert.equal(server.emails().length, 12);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);

  const fresh = await run('create', file, server.baseUrl, '--new', '--no-email');
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.notEqual(read(resultFile).event.id, first.event.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 2);
  assert.equal(server.emails().length, 12);
  const history = path.join(server.directory, 'event-cli-history');
  const archived = path.join(history, fs.readdirSync(history)[0]);
  assert.equal(read(path.join(archived, 'event-cli-result.json')).event.id, first.event.id);
  assert.equal(read(path.join(archived, 'send-cli.json')).eventId, first.event.id);
  const inviteNew = await run('invite', file, server.baseUrl);
  assert.equal(inviteNew.code, 0, inviteNew.stderr);
  assert.equal(server.emails().length, 16);

  await server.request('POST', '/api/admin/reset', { secret: server.secret });
  const deleted = await run('create', file, server.baseUrl);
  assert.equal(deleted.code, 1);
  assert.match(deleted.stderr, /saved event was deleted/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
});

test('event CLI adopts an event previously created by curl without creating another', async t => {
  const server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  const input = config(server.secret);
  const created = await server.request('POST', '/api/admin/seed', input);
  const file = path.join(server.directory, 'event-cli.json');
  write(file, input);
  write(path.join(server.directory, 'event-cli-result.json'), created.data);
  const adopted = await run('create', file, server.baseUrl);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.match(adopted.stdout, /Using saved event/);
  assert.equal(read(path.join(server.directory, 'send-cli.json')).eventId, created.data.event.id);
  assert.equal(server.emails().length, 4);
  const db = new Database(path.join(server.directory, 'db.sqlite'), { readonly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1); }
  finally { db.close(); }
});

test('invalid participant details stop before contacting a server', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kringle-cli-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = config('private-test-admin-secret');
  input.participants[3].email = input.participants[0].email;
  const file = path.join(directory, 'event-cli.json');
  write(file, input);
  const output = await run('create', file, 'http://127.0.0.1:1');
  assert.equal(output.code, 1);
  assert.match(output.stderr, /unique email address/);
  assert(!output.stderr.includes(input.secret));
  assert.deepEqual(fs.readdirSync(directory), ['event-cli.json']);
});

async function fakeServer(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kringle-cli-network-'));
  const input = config('private-test-admin-secret');
  const file = path.join(directory, 'event-cli.json');
  write(file, input);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ method: req.method, route: req.url, body: text ? JSON.parse(text) : null });
    const reply = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    await handler(req, res, reply);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { input, file, directory, baseUrl, requests };
}

test('a lost creation response does not trigger a duplicate event on the next run', async t => {
  const fixture = await fakeServer(t, (req, res) => res.destroy());
  const first = await run('create', fixture.file, fixture.baseUrl);
  assert.equal(first.code, 1);
  assert.equal(fixture.requests.length, 1);
  assert.equal(read(path.join(fixture.directory, 'event-cli-state.json')).creation, 'pending');
  const repeated = await run('create', fixture.file, fixture.baseUrl);
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /previous creation may have reached the server/);
  assert.equal(fixture.requests.length, 1);
});

test('partial email failure keeps the event and requires explicit resend instead of duplicating mail', async t => {
  let fixture;
  let mailRequests = 0;
  fixture = await fakeServer(t, (req, res, reply) => {
    if (req.url === '/api/admin/seed') return reply({ event: {
      id: 'fake-event', name: fixture.input.eventName, event_date: fixture.input.eventDate,
      location: fixture.input.location, tiers: fixture.input.tiers.map((tier, i) => ({ id: `tier-${i}`, name: tier.name, budget_cents: tier.budgetCents })),
    }, invites: fixture.input.participants.map((person, i) => ({ ...person, link: `${fixture.baseUrl}/draw?token=token-${i}` })) });
    if (req.url.startsWith('/api/me?')) return reply({ event: { id: 'fake-event' } });
    if (req.url === '/api/admin/send-invites') {
      mailRequests++;
      return reply(mailRequests === 1
        ? { ok: true, sent: 3, failed: [{ email: 'drew@example.test', error: 'Test SMTP failure' }] }
        : { ok: true, sent: 4, failed: [] });
    }
    res.statusCode = 404;
    reply({ error: 'Not found' });
  });
  const failed = await run('create', fixture.file, fixture.baseUrl);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /drew@example.test: Test SMTP failure/);
  assert.equal(read(path.join(fixture.directory, 'event-cli-result.json')).event.id, 'fake-event');
  assert.equal(read(path.join(fixture.directory, 'event-cli-state.json')).invitations.status, 'partial');
  const repeated = await run('create', fixture.file, fixture.baseUrl);
  assert.equal(repeated.code, 1);
  assert.equal(mailRequests, 1);
  const resent = await run('invite', fixture.file, fixture.baseUrl);
  assert.equal(resent.code, 0, resent.stderr);
  assert.equal(mailRequests, 2);
  assert.equal(read(path.join(fixture.directory, 'event-cli-state.json')).invitations.status, 'sent');
  assert(fixture.requests.filter(r => r.route === '/api/admin/send-invites').every(r => r.body.eventId === 'fake-event'));
  const wrongServer = await run('invite', fixture.file, 'http://127.0.0.1:1');
  assert.equal(wrongServer.code, 1);
  assert.match(wrongServer.stderr, /belongs to another server/);
});

test('an interrupted email request releases the lock and does not resend automatically', async t => {
  let fixture;
  let started;
  const mailStarted = new Promise(resolve => { started = resolve; });
  let mailRequests = 0;
  fixture = await fakeServer(t, (req, res, reply) => {
    if (req.url === '/api/admin/seed') return reply({ event: {
      id: 'interrupted-event', name: fixture.input.eventName, event_date: fixture.input.eventDate,
      location: fixture.input.location, tiers: fixture.input.tiers.map(tier => ({ name: tier.name, budget_cents: tier.budgetCents })),
    }, invites: fixture.input.participants.map((person, i) => ({ ...person, link: `${fixture.baseUrl}/draw?token=token-${i}` })) });
    if (req.url.startsWith('/api/me?')) return reply({ event: { id: 'interrupted-event' } });
    if (req.url === '/api/admin/send-invites') {
      mailRequests++;
      started(); // Leave the response pending until the CLI is interrupted.
      return;
    }
    res.statusCode = 404;
    reply({ error: 'Not found' });
  });
  const child = spawn(process.execPath, [script, 'create', '--file', fixture.file, '--url', fixture.baseUrl]);
  child.stdout.resume();
  child.stderr.resume();
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  let timer;
  try {
    await Promise.race([mailStarted, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CLI did not start sending email')), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const simultaneous = await run('links', fixture.file, fixture.baseUrl);
  assert.equal(simultaneous.code, 1);
  assert.match(simultaneous.stderr, /Another event command may be running/);
  child.kill('SIGINT');
  const [exitCode] = await exited;
  assert.equal(exitCode, 130);
  assert(!fs.existsSync(path.join(fixture.directory, 'event-cli.lock')));
  assert.equal(read(path.join(fixture.directory, 'event-cli-state.json')).invitations.status, 'pending');
  const repeated = await run('create', fixture.file, fixture.baseUrl);
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /previous invitation request may have sent some emails/);
  assert.equal(mailRequests, 1);
});
