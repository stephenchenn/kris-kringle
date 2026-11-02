#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');

const DEFAULT_URL = 'https://kris-kringle.onrender.com';
const HELP = `Usage: npm run event:<command> -- [options]

Commands:
  create       Create/reuse the event and send its invitations once
  invite       Send or resend invitations for the saved event
  wishlists    Send wishlist reminder emails for the saved event
  links        Print the saved personal draw and wishlist links
  status       Check who has drawn and who is still waiting (read-only)

Options:
  --file PATH  Event JSON (default: .local/event-2026.json)
  --url URL    Server address (default: ${DEFAULT_URL})
  --no-email   Create/reuse the event without sending invitations
  --new        Archive saved local event files and create a new event
  --help       Show this help

The create command saves the event ID automatically and keeps existing draws.
The invite and wishlists commands send emails each time you run them.
`;

function readJson(filename, optional = false) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') throw new Error(`Missing ${filename}. Add your event details there first.`);
    throw new Error(`Cannot read valid JSON from ${filename}.`);
  }
}

function writeJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function definition(config) {
  if (typeof config?.secret !== 'string' || !config.secret.trim()) throw new Error('The event JSON needs its admin secret.');
  if (typeof config.eventName !== 'string' || !config.eventName.trim()) throw new Error('The event JSON needs an eventName.');
  if (!Array.isArray(config.participants) || config.participants.length < 2) throw new Error('Add at least two participants.');
  const participants = config.participants.map((person, index) => {
    if (typeof person?.name !== 'string' || !person.name.trim() ||
        typeof person.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email.trim())) {
      throw new Error(`Participant ${index + 1} needs a name and valid email.`);
    }
    return { name: person.name.trim(), email: person.email.trim().toLowerCase() };
  });
  if (new Set(participants.map(person => person.email)).size !== participants.length) throw new Error('Each participant needs a unique email address.');
  let tiers;
  if (Array.isArray(config.tiers) && config.tiers.length) {
    tiers = config.tiers.map((tier, index) => {
      if (!tier || !Number.isSafeInteger(tier.budgetCents ?? 0) || (tier.budgetCents ?? 0) < 0) throw new Error('Gift budgets must be non-negative integer cents.');
      return { name: tier.name || `Gift ${index + 1}`, budgetCents: tier.budgetCents ?? 0 };
    });
  } else if (Number.isSafeInteger(config.giftsPerPerson) && config.giftsPerPerson > 0) {
    tiers = Array.from({ length: config.giftsPerPerson }, (_, index) => ({ name: `Gift ${index + 1}`, budgetCents: 0 }));
  } else throw new Error('Add tiers with gift budgets to the event JSON.');
  return { eventName: config.eventName.trim(), eventDate: config.eventDate || null,
    location: config.location || null, participants, tiers };
}

function fromResult(result, secret) {
  return definition({ secret, eventName: result.event.name, eventDate: result.event.event_date,
    location: result.event.location, participants: result.invites,
    tiers: result.event.tiers.map(tier => ({ name: tier.name, budgetCents: tier.budget_cents })) });
}

function fingerprint(value) {
  const normalized = { ...value, participants: [...value.participants].sort((a, b) => a.email.localeCompare(b.email)) };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function showStatus(result, baseUrl) {
  if (!result?.event?.id || !Array.isArray(result.invites) || !result.invites.length) {
    throw new Error('No saved event. Create the event first with npm run event:create.');
  }
  const people = result.invites.map(person => {
    const link = new URL(person.link);
    const token = link.searchParams.get('token');
    if (link.origin !== baseUrl || link.pathname !== '/draw' || !token) {
      throw new Error('Saved invitations do not match this server. Check --url.');
    }
    return { ...person, token };
  });
  const rows = await Promise.all(people.map(async person => {
    try {
      const response = await fetch(`${baseUrl}/api/me?token=${encodeURIComponent(person.token)}`, {
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      if (response.status === 404) throw new Error('Invitation no longer exists; the event may have been reset.');
      if (!response.ok) throw new Error(`Status check returned HTTP ${response.status}.`);
      const data = await response.json();
      if (data.event?.id !== result.event.id || typeof data.me?.has_drawn !== 'boolean') {
        throw new Error('Server returned incomplete status or a different event.');
      }
      return { Participant: data.me.name, Email: data.me.email, Status: data.me.has_drawn ? 'Drawn' : 'Waiting' };
    } catch (error) {
      return { Participant: person.name, Email: person.email, Status: 'Unavailable',
        error: error.name === 'TimeoutError' ? 'Status check timed out.' : error.message };
    }
  }));
  const drawn = rows.filter(row => row.Status === 'Drawn').length;
  const waiting = rows.filter(row => row.Status === 'Waiting').length;
  const unavailable = rows.filter(row => row.Status === 'Unavailable');
  console.log(`Server: ${baseUrl}\nEvent: ${result.event.name} (${result.event.id})`);
  console.table(rows.map(({ Participant, Email, Status }) => ({ Participant, Email, Status })));
  console.log(`Drawn: ${drawn}/${people.length} | Waiting: ${waiting}${unavailable.length ? ` | Unavailable: ${unavailable.length}` : ''}`);
  console.log(`Checked live at ${new Date().toISOString()}`);
  if (unavailable.length) {
    for (const row of unavailable) console.error(`${row.Participant}: ${row.error}`);
    throw new Error('Some participant statuses could not be checked.');
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    file: { type: 'string', default: '.local/event-2026.json' },
    url: { type: 'string', default: DEFAULT_URL },
    'no-email': { type: 'boolean' }, new: { type: 'boolean' }, help: { type: 'boolean' },
  }, allowPositionals: true });
  if (values.help) { console.log(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['create', 'invite', 'wishlists', 'links', 'status'].includes(command)) throw new Error(HELP);
  if ((values.new || values['no-email']) && command !== 'create') throw new Error('--new and --no-email apply to event:create only.');
  const server = new URL(values.url);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password ||
      server.pathname !== '/' || server.search || server.hash) throw new Error('--url must be a server origin, such as http://localhost:3000.');
  const baseUrl = server.origin;
  const filename = path.resolve(values.file);
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  const directory = path.dirname(filename);
  const resultFile = path.join(directory, `${stem}-result.json`);
  const stateFile = path.join(directory, `${stem}-state.json`);
  const sendFile = path.join(directory, stem.startsWith('event-') ? `send-${stem.slice(6)}.json` : `${stem}-send.json`);
  const lockFile = path.join(directory, `${stem}.lock`);
  if (command === 'status') {
    await showStatus(readJson(resultFile, true), baseUrl);
    return;
  }
  const config = readJson(filename);
  const payload = definition(config);
  const hash = fingerprint(payload);
  const quoteArgument = value => /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const hint = (action, extra = []) => {
    const args = [...(filename !== path.resolve('.local/event-2026.json') ? ['--file', values.file] : []),
      ...(baseUrl !== DEFAULT_URL ? ['--url', baseUrl] : []), ...extra];
    return `npm run event:${action}${args.length ? ` -- ${args.map(quoteArgument).join(' ')}` : ''}`;
  };
  let lock;
  try { lock = fs.openSync(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another event command may be running. If it has stopped, delete ${lockFile} and try again.`);
    throw error;
  }
  fs.writeFileSync(lock, `${process.pid}\n`);
  const releaseLock = () => {
    if (lock === undefined) return;
    fs.closeSync(lock);
    lock = undefined;
    fs.rmSync(lockFile, { force: true });
  };
  const interrupted = () => { releaseLock(); process.exit(130); };
  const terminated = () => { releaseLock(); process.exit(143); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);
  try {
    if (values.new) {
      const oldFiles = [resultFile, stateFile, sendFile].filter(file => fs.existsSync(file));
      if (oldFiles.length) {
        const archive = path.join(directory, `${stem}-history`, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
        fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
        for (const old of oldFiles) fs.renameSync(old, path.join(archive, path.basename(old)));
        console.log(`Archived previous local files in ${archive}. Existing server events are kept.`);
      }
    }
    let result = readJson(resultFile, true);
    let state = readJson(stateFile, true);
    const saveState = () => writeJson(stateFile, state);
    async function request(method, route, body) {
      let response;
      try {
        response = await fetch(`${baseUrl}${route}`, { method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'error', signal: AbortSignal.timeout(120000) });
      } catch {
        throw new Error('The request did not finish. It was not retried; the server may have processed it.');
      }
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`Server returned an unreadable response (HTTP ${response.status}).`); }
      if (!response.ok) {
        const error = new Error(`Server returned HTTP ${response.status}: ${String(data.error || response.statusText).replaceAll(config.secret, '[hidden]')}`);
        error.status = response.status;
        throw error;
      }
      return data;
    }
    console.log(`Server: ${baseUrl}\nEvent: ${payload.eventName}\nParticipants: ${payload.participants.length}`);
    if (!result?.event?.id) {
      if (command !== 'create') throw new Error(`Create the event first with ${hint('create')}.`);
      if (state?.creation === 'pending' || state?.eventId) throw new Error(`A previous creation may have reached the server. Check the saved event before using ${hint('create', ['--new'])}.`);
      if (result && !result.error) throw new Error(`The saved result in ${resultFile} is incomplete. Check it before using --new.`);
      state = { baseUrl, fingerprint: hash, creation: 'pending' };
      saveState();
      try { result = await request('POST', '/api/admin/seed', { secret: config.secret, ...payload }); }
      catch (error) {
        if (error.status && error.status < 500) { state.creation = 'rejected'; saveState(); }
        throw error;
      }
      // Save the returned ID before attempting any email request.
      writeJson(resultFile, result);
      console.log(`Created event ${result.event?.id}.`);
    } else console.log(`Using saved event ${result.event.id}; assignments are unchanged.`);

    if (!Array.isArray(result.invites) || !result.invites.length || !Array.isArray(result.event.tiers)) throw new Error('The saved server response is incomplete.');
    if (fingerprint(fromResult(result, config.secret)) !== hash) throw new Error(`The JSON differs from the saved event. Restore its original details, or use ${hint('create', ['--new'])} to create another event.`);
    if (state?.baseUrl && state.baseUrl !== baseUrl) throw new Error(`The saved event belongs to another server. Use ${hint('create', ['--new'])} to create one on this server.`);
    for (const person of result.invites) {
      const link = new URL(person.link);
      if (link.origin !== baseUrl || link.pathname !== '/draw' || !link.searchParams.get('token')) throw new Error('Saved invitation links do not match this server. Check --url and the result JSON.');
    }
    state = { ...state, baseUrl, fingerprint: hash, creation: 'created', eventId: result.event.id };
    saveState();
    writeJson(sendFile, { secret: config.secret, eventId: result.event.id });
    if (command === 'links') {
      for (const person of result.invites) {
        const wishlist = new URL(person.link);
        wishlist.pathname = '/wishlists';
        console.log(`\n${person.name}\n  Draw: ${person.link}\n  Wishlist: ${wishlist.href}`);
      }
      return;
    }
    // Verify that a saved event still exists, without drawing or sending mail.
    try {
      const me = await request('GET', `/api/me?token=${encodeURIComponent(new URL(result.invites[0].link).searchParams.get('token'))}`);
      if (me.event?.id !== result.event.id) throw new Error('Saved invitation does not belong to this event.');
    } catch (error) {
      if (error.status === 404) throw new Error(`The saved event was deleted from this server. Use ${hint('create', ['--new'])} to create another.`);
      throw error;
    }
    if (command === 'create' && values['no-email']) {
      console.log(`Event saved. Send invitations with ${hint('invite')}.`);
      return;
    }
    if (command === 'create' && state.invitations?.status === 'sent') {
      console.log(`Invitations were already sent. To resend them, run ${hint('invite')}.`);
      return;
    }
    if (command === 'create' && ['pending', 'partial'].includes(state.invitations?.status)) throw new Error(`The previous invitation request may have sent some emails. Run ${hint('invite')} to explicitly resend invitations to everyone.`);
    const kind = command === 'wishlists' ? 'wishlists' : 'invitations';
    const route = kind === 'wishlists' ? 'send-wishlists' : 'send-invites';
    state[kind] = { status: 'pending', requestedAt: new Date().toISOString() };
    saveState();
    let mail;
    try { mail = await request('POST', `/api/admin/${route}`, { secret: config.secret, eventId: result.event.id }); }
    catch (error) {
      if (error.status && error.status < 500) { state[kind].status = 'rejected'; saveState(); }
      throw error;
    }
    if (!Number.isInteger(mail.sent) || !Array.isArray(mail.failed)) throw new Error('The server did not report a valid email result.');
    const complete = mail.sent === payload.participants.length && mail.failed.length === 0;
    state[kind] = { status: complete ? 'sent' : 'partial', sent: mail.sent,
      failed: mail.failed.map(item => ({ email: item.email, error: String(item.error).replaceAll(config.secret, '[hidden]') })),
      completedAt: new Date().toISOString() };
    saveState();
    console.log(`${kind === 'wishlists' ? 'Wishlist reminders' : 'Invitations'}: ${mail.sent} sent, ${mail.failed.length} failed.`);
    if (!complete) {
      for (const item of state[kind].failed) console.error(`  ${item.email}: ${item.error}`);
      throw new Error(`Some emails were not sent. Fix email delivery, then run ${hint(kind === 'wishlists' ? 'wishlists' : 'invite')} to resend to everyone.`);
    }
    console.log(`Saved event details in ${resultFile}.\nView personal links with ${hint('links')}.`);
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    releaseLock();
  }
}

main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
