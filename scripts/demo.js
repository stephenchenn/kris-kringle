const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const directory = path.resolve('.local', `demo-${randomUUID()}`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
// Override all sensitive settings before dotenv loads last year's configuration.
process.env.NODE_ENV = 'development';
process.env.DB_PATH = path.join(directory, 'db.sqlite');
process.env.EMAIL_MODE = 'preview';
process.env.EMAIL_PREVIEW_DIR = path.join(directory, 'emails');
process.env.FROM_EMAIL = 'Demo Kris Kringle <no-reply@example.test>';
process.env.ADMIN_SECRET = randomUUID();
process.env.PORT = process.env.DEMO_PORT || '3000';
process.env.BASE_URL = `http://localhost:${process.env.PORT}`;

const { app, db, transporter } = require('../server');
const server = app.listen(Number(process.env.PORT), '127.0.0.1', async () => {
  const base = process.env.BASE_URL;
  try {
    const response = await fetch(`${base}/api/admin/seed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.ADMIN_SECRET,
        eventName: 'Family Christmas 2026 — Local Demo',
        eventDate: '2026-12-25T18:00:00+10:30',
        location: 'Demo family gathering',
        participants: ['Alex', 'Blair', 'Casey', 'Drew', 'Eden'].map(name => ({
          name, email: `${name.toLowerCase()}@example.test`,
        })),
        tiers: [{ name: 'Gift 1', budgetCents: 10000 }, { name: 'Gift 2', budgetCents: 5000 }],
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const send = await fetch(`${base}/api/admin/send-invites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.ADMIN_SECRET, eventId: result.event.id }),
    });
    const delivery = await send.json();
    if (!send.ok || delivery.failed?.length) throw new Error('Failed to capture invitation emails');
    const details = { ...result, directory, baseUrl: base };
    fs.writeFileSync(path.resolve('.local/demo.json'), JSON.stringify(details, null, 2), { mode: 0o600 });
    console.log('\nLocal demo ready. All email is captured; no real messages are sent.');
    console.log(`Database and email previews: ${directory}`);
    console.log('Participant links (also saved in .local/demo.json):');
    for (const invite of result.invites) console.log(`${invite.name}: ${invite.link}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    shutdown();
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Port is already in use. Stop the other server or set DEMO_PORT=3001.' : error.message);
  db.close();
  transporter.close();
  process.exitCode = 1;
});
function shutdown() {
  server.close(() => {
    transporter.close();
    db.close();
  });
  server.closeIdleConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
