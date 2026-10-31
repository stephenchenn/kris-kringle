const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');

async function startServer(options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'kris-kringle-test-'));
  const secret = options.secret || randomUUID();
  const child = fork(path.join(__dirname, 'serve.js'), [], {
    env: {
      ...process.env, NODE_ENV: 'test', ADMIN_SECRET: secret,
      DB_PATH: path.join(directory, 'db.sqlite'), EMAIL_MODE: 'preview',
      EMAIL_PREVIEW_DIR: path.join(directory, 'emails'),
      FROM_EMAIL: 'Test Kris Kringle <no-reply@example.test>',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const { baseUrl } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Test server timed out: ${logs}`)); }, 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited (${code}): ${logs}`)); });
  });
  async function request(method, route, body, extraHeaders = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return {
    directory, secret, baseUrl, request,
    async seed(overrides = {}, headers) {
      const response = await request('POST', '/api/admin/seed', {
        secret, eventName: 'Family Christmas 2026',
        eventDate: '2026-12-25T18:00:00+10:30', location: 'Test gathering',
        participants: ['Alex', 'Blair', 'Casey', 'Drew', 'Eden'].map(name => ({
          name, email: `${name.toLowerCase()}@example.test`,
        })),
        tiers: [{ name: 'Gift 1', budgetCents: 10000 }, { name: 'Gift 2', budgetCents: 5000 }],
        ...overrides,
      }, headers);
      if (response.status !== 200) throw new Error(JSON.stringify(response));
      return {
        ...response.data,
        people: response.data.invites.map(invite => ({
          ...invite, token: new URL(invite.link).searchParams.get('token'),
        })),
      };
    },
    emails() {
      const mailDirectory = path.join(directory, 'emails');
      if (!fs.existsSync(mailDirectory)) return [];
      return fs.readdirSync(mailDirectory).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(fs.readFileSync(path.join(mailDirectory, name), 'utf8')));
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    },
    remove() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

module.exports = { startServer };
