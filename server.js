const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "db.sqlite"));
db.pragma("journal_mode = WAL");

// --- DB schema (idempotent) ---
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gifts_per_person INTEGER NOT NULL CHECK (gifts_per_person > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  invite_token TEXT NOT NULL UNIQUE,
  has_drawn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, email),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (giver_id <> recipient_id),
  UNIQUE(event_id, giver_id, recipient_id),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(giver_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY(recipient_id) REFERENCES participants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
CREATE INDEX IF NOT EXISTS idx_assignments_giver ON assignments(event_id, giver_id);
CREATE INDEX IF NOT EXISTS idx_assignments_recipient ON assignments(event_id, recipient_id);
`);

// --- Email transport ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465, // true for 465, false for 587/2525
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
});

// --- Helpers ---
function getParticipantByToken(token) {
  const stmt = db.prepare(`
    SELECT p.id, p.name, p.email, p.has_drawn, p.event_id,
           e.name AS event_name, e.gifts_per_person
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE p.invite_token = ?
  `);
  return stmt.get(token);
}

function listParticipants(event_id) {
  return db
    .prepare(`SELECT id, name, email FROM participants WHERE event_id = ?`)
    .all(event_id);
}

function getRecipientsForGiver(event_id, giver_id) {
  return db
    .prepare(
      `
      SELECT r.id, r.name
      FROM assignments a
      JOIN participants r ON r.id = a.recipient_id
      WHERE a.event_id = ? AND a.giver_id = ?
    `
    )
    .all(event_id, giver_id);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function sendAssignmentEmail({
  to,
  participantName,
  recipients,
  eventName,
}) {
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#111111 !important;">
      <p>Hi ${participantName},</p>
      <p>Your Kris Kringle recipients for <b>${eventName}</b> are:</p>
      <ul>${recipients.map((r) => `<li>${r}</li>`).join("")}</ul>
      <p>Happy gifting! 🎁</p>
    </div>`;
  await transporter.sendMail({
    from: process.env.FROM_EMAIL,
    to,
    subject: `Your Kris Kringle recipients for ${eventName}`,
    html,
  });
}

// --- API: who am I + recipients ---
app.get("/api/me", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  const me = getParticipantByToken(token);
  if (!me) return res.status(404).json({ error: "Invalid token" });

  const recs = getRecipientsForGiver(me.event_id, me.id);
  res.json({
    me: {
      id: me.id,
      name: me.name,
      email: me.email,
      has_drawn: Boolean(me.has_drawn),
    },
    event: {
      id: me.event_id,
      name: me.event_name,
      gifts_per_person: me.gifts_per_person,
    },
    recipients: recs.map((r) => r.name),
  });
});

// Count how many gifts each recipient already has in this event
function recipientCounts(event_id) {
  const rows = db.prepare(`
    SELECT recipient_id AS id, COUNT(*) AS c
    FROM assignments
    WHERE event_id = ?
    GROUP BY recipient_id
  `).all(event_id);
  const map = new Map(rows.map(r => [r.id, Number(r.c)]));
  return map;
}

app.post("/api/draw", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const me = getParticipantByToken(token);
  if (!me) return res.status(404).json({ error: "Invalid token" });

  const giftsPerPerson = me.gifts_per_person;
  const existing = getRecipientsForGiver(me.event_id, me.id);
  if (existing.length >= giftsPerPerson) {
    return res.json({ ok: true, recipients: existing.map((r) => r.name) });
  }

  const participants = listParticipants(me.event_id);
  const candidates = participants.filter((p) => p.id !== me.id);

  // ---- NEW: balance by current recipient load
  const counts = recipientCounts(me.event_id);
  // sort: least-assigned first, then random to break ties
  const sorted = shuffle(candidates).sort((a, b) => {
    const ca = counts.get(a.id) || 0;
    const cb = counts.get(b.id) || 0;
    return ca - cb;
  });

  const alreadyIds = new Set(existing.map((x) => x.id));
  const need = giftsPerPerson - existing.length;
  const chosen = [];

  for (const c of sorted) {
    if (chosen.length >= need) break;
    const rc = counts.get(c.id) || 0;
    if (rc >= giftsPerPerson) continue;        // hit the cap, skip
    if (alreadyIds.has(c.id)) continue;        // giver already has this recipient

    try {
      db.prepare(
        `INSERT INTO assignments (id, event_id, giver_id, recipient_id) VALUES (?,?,?,?)`
      ).run(randomUUID(), me.event_id, me.id, c.id);

      counts.set(c.id, rc + 1); // update live so later picks stay balanced
      chosen.push(c);
    } catch {
      // unique/race => skip
    }
  }
  // ---- END NEW

  const after = getRecipientsForGiver(me.event_id, me.id);
  if (after.length > 0 && !me.has_drawn) {
    db.prepare(`UPDATE participants SET has_drawn = 1 WHERE id = ?`).run(me.id);
  }

  const names = after.map((r) => r.name);

  try {
    await sendAssignmentEmail({
      to: me.email,
      participantName: me.name,
      recipients: names,
      eventName: me.event_name,
    });
  } catch (e) {
    console.error("Email error:", e.message);
  }

  if (after.length < giftsPerPerson) {
    return res.status(400).json({
      error: "Not enough unique recipients available right now.",
      recipients: names,
    });
  }

  res.json({ ok: true, recipients: names });
});

// --- API: admin seed ---
app.post("/api/admin/seed", (req, res) => {
  const { secret, eventName, giftsPerPerson, participants } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "Forbidden" });

  if (!eventName || !Number.isInteger(giftsPerPerson) || giftsPerPerson <= 0) {
    return res.status(400).json({ error: "Invalid event payload" });
  }
  if (!Array.isArray(participants) || participants.length < 2) {
    return res.status(400).json({ error: "Need at least 2 participants" });
  }

  const eventId = randomUUID();
  const insertEvent = db.prepare(
    `INSERT INTO events (id, name, gifts_per_person) VALUES (?,?,?)`
  );
  const insertParticipant = db.prepare(`
    INSERT INTO participants (id, event_id, name, email, invite_token)
    VALUES (?,?,?,?,?)
  `);

  const tx = db.transaction(() => {
    insertEvent.run(eventId, eventName, giftsPerPerson);
    for (const p of participants) {
      const pid = randomUUID();
      const token = randomUUID();
      insertParticipant.run(pid, eventId, p.name, p.email, token);
    }
  });

  try {
    tx();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const rows = db
    .prepare(
      `SELECT name, email, invite_token FROM participants WHERE event_id = ?`
    )
    .all(eventId);

  const base = process.env.BASE_URL || "http://localhost:3000";
  const invites = rows.map((r) => ({
    name: r.name,
    email: r.email,
    link: `${base}/draw?token=${r.invite_token}`,
  }));

  res.json({
    event: { id: eventId, name: eventName, gifts_per_person: giftsPerPerson },
    invites,
  });
});

app.post("/api/admin/send-invites", async (req, res) => {
  const { secret, eventId } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });

  // pick event: use provided ID or the most recent
  const evt = eventId ||
    db.prepare(`SELECT id, name FROM events ORDER BY created_at DESC LIMIT 1`).get()?.id;
  if (!evt) return res.status(404).json({ error: "No event found" });

  const eventRow = db.prepare(`SELECT id, name, gifts_per_person FROM events WHERE id = ?`).get(evt);
  const base = process.env.BASE_URL || "http://localhost:3000";
  const people = db.prepare(`SELECT name, email, invite_token FROM participants WHERE event_id = ?`).all(evt);

  const send = (to, subject, html) =>
    transporter.sendMail({ from: process.env.FROM_EMAIL, to, subject, html });

  let sent = 0, failed = [];
  for (const p of people) {
    const link = `${base}/draw?token=${p.invite_token}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#111111 !important;">
        <p>Hi ${p.name},</p>
        <p>You’re invited to join <b>${eventRow.name}</b>!</p>
        <p>Click this link to draw your recipients: <a href="${link}">${link}</a></p>
        <p>Each person gives <b>${eventRow.gifts_per_person}</b> gift(s).</p>
        <p>Happy gifting! 🎁</p>
      </div>
    `;
    try {
      // eslint-disable-next-line no-await-in-loop
      await send(p.email, `You're invited: ${eventRow.name}`, html);
      sent++;
    } catch (e) {
      failed.push({ email: p.email, error: e.message });
    }
  }

  res.json({ ok: true, sent, failed });
});

app.post("/api/resend", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const me = getParticipantByToken(token);
  if (!me) return res.status(404).json({ error: "Invalid token" });

  const recs = getRecipientsForGiver(me.event_id, me.id).map(r => r.name);
  if (!recs.length) return res.status(400).json({ error: "You haven’t drawn yet." });

  try {
    await sendAssignmentEmail({
      to: me.email,
      participantName: me.name,
      recipients: recs,
      eventName: me.event_name,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to send email" });
  }
});


const indexFile = path.join(__dirname, "public", "index.html");

// Serve SPA for / and /draw
app.get("/", (req, res) => res.sendFile(indexFile));
app.get("/draw", (req, res) => res.sendFile(indexFile));

// --- Fallback to SPA (if you later add more pages) ---
// app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const port = Number(process.env.PORT || 3000);
app.listen(port, () =>
  console.log(`KK server running on http://localhost:${port}`)
);
