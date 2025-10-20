const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "db.sqlite");
const db = new Database(DB_PATH);
// const db = new Database(path.join(__dirname, "db.sqlite"));
db.pragma("journal_mode = WAL");

// --- DB schema (idempotent) ---
db.exec(`
-- events: one Secret Santa group
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gifts_per_person INTEGER NOT NULL CHECK (gifts_per_person > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- participants: each person in an event
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

-- gift_tiers: budgets / tiers for an event (e.g. Gift 1 $100, Gift 2 $50)
CREATE TABLE IF NOT EXISTS gift_tiers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, sort_order),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- assignments: who gives which recipient for which tier
-- constraints:
--  - one assignment per giver per tier (giver gives exactly one per tier)
--  - one assignment per recipient per tier (recipient receives exactly one per tier)
DROP TABLE IF EXISTS assignments;
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (giver_id <> recipient_id),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(tier_id) REFERENCES gift_tiers(id) ON DELETE CASCADE,
  FOREIGN KEY(giver_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY(recipient_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE(event_id, tier_id, giver_id),
  UNIQUE(event_id, tier_id, recipient_id),
  UNIQUE(event_id, tier_id, giver_id, recipient_id)
);

-- helpful indexes
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
CREATE INDEX IF NOT EXISTS idx_tiers_event ON gift_tiers(event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_assignments_ev_tier_giver ON assignments(event_id, tier_id, giver_id);
CREATE INDEX IF NOT EXISTS idx_assignments_ev_tier_recipient ON assignments(event_id, tier_id, recipient_id);
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
// GET /api/me
app.get("/api/me", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  // who am I + event
  const meRow = db.prepare(`
    SELECT p.id, p.name, p.email, p.has_drawn, p.event_id,
           e.name AS event_name
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE p.invite_token = ?
  `).get(token);

  if (!meRow) return res.status(404).json({ error: "Invalid token" });

  // list tiers
  const tiers = db.prepare(`
    SELECT id, name, budget_cents, sort_order
    FROM gift_tiers
    WHERE event_id = ?
    ORDER BY sort_order
  `).all(meRow.event_id);

  let recipients_by_tier = tiers.map(t => ({
    tier_id: t.id,
    name: t.name,
    budget_cents: t.budget_cents,
    recipient: null, // default hidden
  }));

  // Only fetch assigned recipients if user has_drawn
  if (meRow.has_drawn) {
    const rows = db.prepare(`
      SELECT a.tier_id, r.name AS recipient_name
      FROM assignments a
      JOIN participants r ON r.id = a.recipient_id
      WHERE a.event_id = ? AND a.giver_id = ?
    `).all(meRow.event_id, meRow.id);

    recipients_by_tier = tiers.map(t => ({
      tier_id: t.id,
      name: t.name,
      budget_cents: t.budget_cents,
      recipient: (rows.find(r => r.tier_id === t.id) || {}).recipient_name || null,
    }));
  }

  return res.json({
    me: { id: meRow.id, name: meRow.name, email: meRow.email, has_drawn: Boolean(meRow.has_drawn) },
    event: { id: meRow.event_id, name: meRow.event_name, tiers: tiers.map(t => ({ id: t.id, name: t.name, budget_cents: t.budget_cents })) },
    recipients_by_tier,
  });
});



// Count how many gifts each recipient already has in this event
function recipientCounts(event_id) {
  const rows = db
    .prepare(
      `
    SELECT recipient_id AS id, COUNT(*) AS c
    FROM assignments
    WHERE event_id = ?
    GROUP BY recipient_id
  `
    )
    .all(event_id);
  const map = new Map(rows.map((r) => [r.id, Number(r.c)]));
  return map;
}

// POST /api/draw
app.post("/api/draw", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const meRow = db.prepare(`
    SELECT p.id, p.name, p.email, p.has_drawn, p.event_id,
           e.name AS event_name
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE p.invite_token = ?
  `).get(token);

  if (!meRow) return res.status(404).json({ error: "Invalid token" });

  // fetch tiers
  const tiers = db.prepare(`
    SELECT id, name, budget_cents, sort_order
    FROM gift_tiers WHERE event_id = ?
    ORDER BY sort_order
  `).all(meRow.event_id);

  // fetch assigned recipients (they exist because we preassigned at seed)
  const rows = db.prepare(`
    SELECT a.tier_id, r.name AS recipient_name
    FROM assignments a
    JOIN participants r ON r.id = a.recipient_id
    WHERE a.event_id = ? AND a.giver_id = ?
  `).all(meRow.event_id, meRow.id);

  const recipients_by_tier = tiers.map(t => ({
    tier_id: t.id,
    name: t.name,
    budget_cents: t.budget_cents,
    recipient: (rows.find(r => r.tier_id === t.id) || {}).recipient_name || null,
  }));

  // If they haven't drawn yet, mark as drawn and send email
  if (!meRow.has_drawn) {
    try {
      db.prepare(`UPDATE participants SET has_drawn = 1 WHERE id = ?`).run(meRow.id);
    } catch (e) {
      console.error("Failed to mark has_drawn:", e.message);
      // continue — we can still return recipients
    }

    // send email (fire-and-forget but catch errors)
    (async () => {
      try {
        const fmt = (cents) => `$${(cents/100).toFixed(0)}`;
        const items = recipients_by_tier.map(t => `<li><b>${t.name}</b> (${fmt(t.budget_cents)}): ${t.recipient}</li>`).join("");
        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#111;padding:24px;">
            <p>Hi ${meRow.name},</p>
            <p>Your Kris Kringle recipients for <b>${meRow.event_name}</b>:</p>
            <ul style="margin:0 0 16px 20px;padding:0;">${items}</ul>
            <p style="color:#6b7280;font-size:14px;margin:16px 0 0 0;">Happy gifting! 🎁</p>
          </div>`;
        await transporter.sendMail({
          from: process.env.FROM_EMAIL,
          to: meRow.email,
          subject: `Your recipients for ${meRow.event_name}`,
          html,
        });
      } catch (e) {
        console.error("Email error:", e && e.message ? e.message : e);
      }
    })();
  }

  // Return the recipients now so the client can immediately show them
  return res.json({ ok: true, recipients_by_tier });
});



// --- API: admin seed ---
// server.js (replace your /api/admin/seed endpoint)


// Simple derangement: shuffle until no one maps to themselves.
// For small N (~10) this is fast & fine.
function derange(ids) {
  const a = ids.slice();
  for (let attempts = 0; attempts < 1000; attempts++) {
    // Fisher-Yates
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    let ok = true;
    for (let i = 0; i < a.length; i++) if (a[i] === ids[i]) { ok = false; break; }
    if (ok) return a;
  }
  throw new Error("Failed to create derangement");
}

app.post("/api/admin/seed", (req, res) => {
  const { secret, eventName, giftsPerPerson, participants, tiers } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });

  if (!eventName) return res.status(400).json({ error: "Missing eventName" });
  const people = Array.isArray(participants) ? participants : [];
  if (people.length < 2) return res.status(400).json({ error: "Need at least 2 participants" });

  // tiers: if not provided, fall back to giftsPerPerson (uniform, no budgets)
  let tierDefs = [];
  if (Array.isArray(tiers) && tiers.length > 0) {
    tierDefs = tiers.map((t, i) => ({
      id: randomUUID(),
      name: t.name || `Gift ${i + 1}`,
      budget_cents: Number(t.budgetCents ?? 0) | 0,
      sort_order: i + 1,
    }));
  } else if (Number.isInteger(giftsPerPerson) && giftsPerPerson > 0) {
    tierDefs = Array.from({ length: giftsPerPerson }, (_, i) => ({
      id: randomUUID(),
      name: `Gift ${i + 1}`,
      budget_cents: 0,
      sort_order: i + 1,
    }));
  } else {
    return res.status(400).json({ error: "Provide tiers[] or giftsPerPerson > 0" });
  }

  const eventId = randomUUID();
  const insertEvent = db.prepare(`INSERT INTO events (id, name, gifts_per_person) VALUES (?,?,?)`);
  const insertParticipant = db.prepare(`
    INSERT INTO participants (id, event_id, name, email, invite_token)
    VALUES (?,?,?,?,?)
  `);
  const insertTier = db.prepare(`
    INSERT INTO gift_tiers (id, event_id, name, budget_cents, sort_order)
    VALUES (?,?,?,?,?)
  `);
  const insertAssignment = db.prepare(`
    INSERT INTO assignments (id, event_id, tier_id, giver_id, recipient_id)
    VALUES (?,?,?,?,?)
  `);

  const tx = db.transaction(() => {
    insertEvent.run(eventId, eventName, tierDefs.length);

    // add participants
    const pRows = [];
    for (const p of people) {
      const pid = randomUUID();
      const token = randomUUID();
      insertParticipant.run(pid, eventId, p.name, p.email, token);
      pRows.push({ id: pid, name: p.name, email: p.email, token });
    }

    // add tiers
    for (const t of tierDefs) {
      insertTier.run(t.id, eventId, t.name, t.budget_cents, t.sort_order);
    }

    // PREASSIGN: build one derangement per tier
    // Ensure a giver doesn't get the SAME recipient across different tiers
    const giverIds = pRows.map((p) => p.id);
    const alreadyForGiver = new Map(giverIds.map((g) => [g, new Set()]));

    for (const t of tierDefs) {
      let perm;
      // Try derangements until they also avoid duplicates across tiers for a giver
      attempt: for (let tries = 0; tries < 200; tries++) {
        perm = derange(giverIds);
        // verify cross-tier distinct recipients for each giver
        for (let i = 0; i < giverIds.length; i++) {
          const giver = giverIds[i];
          const recip = perm[i];
          if (alreadyForGiver.get(giver).has(recip)) {
            continue attempt; // try another derangement
          }
        }
        break; // good perm
      }
      // Insert assignments & record recipient per giver
      for (let i = 0; i < giverIds.length; i++) {
        const giver = giverIds[i];
        const recip = perm[i];
        insertAssignment.run(randomUUID(), eventId, t.id, giver, recip);
        alreadyForGiver.get(giver).add(recip);
      }
    }

    return pRows;
  });

  let inserted;
  try {
    inserted = tx();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const base = (req.get("x-forwarded-proto") && req.get("x-forwarded-host"))
    ? `${req.get("x-forwarded-proto")}://${req.get("x-forwarded-host")}`
    : (process.env.BASE_URL || "http://localhost:3000");

  const invites = inserted.map((r) => ({
    name: r.name,
    email: r.email,
    link: `${base}/draw?token=${r.token}`,
  }));

  res.json({
    event: { id: eventId, name: eventName, tiers: tierDefs.map(t => ({ id: t.id, name: t.name, budget_cents: t.budget_cents })) },
    invites,
  });
});

app.post("/api/admin/send-invites", async (req, res) => {
  const { secret, eventId } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "Forbidden" });

  // pick event: use provided ID or the most recent
  const evt =
    eventId ||
    db
      .prepare(`SELECT id, name FROM events ORDER BY created_at DESC LIMIT 1`)
      .get()?.id;
  if (!evt) return res.status(404).json({ error: "No event found" });

  const eventRow = db
    .prepare(`SELECT id, name, gifts_per_person FROM events WHERE id = ?`)
    .get(evt);
  const base = process.env.BASE_URL || "http://localhost:3000";
  const people = db
    .prepare(
      `SELECT name, email, invite_token FROM participants WHERE event_id = ?`
    )
    .all(evt);

  const send = (to, subject, html) =>
    transporter.sendMail({ from: process.env.FROM_EMAIL, to, subject, html });

  let sent = 0,
    failed = [];
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

  const recs = getRecipientsForGiver(me.event_id, me.id).map((r) => r.name);
  if (!recs.length)
    return res.status(400).json({ error: "You haven’t drawn yet." });

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

// lightweight liveness check
app.get("/healthz", (req, res) => {
  res.type("text/plain").send("ok"); // status 200 by default
});

app.post("/api/admin/reset", (req, res) => {
  const { secret } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "Forbidden" });
  try {
    db.exec(`
		PRAGMA foreign_keys=ON;
		DELETE FROM assignments;
		DELETE FROM participants;
		DELETE FROM events;
		VACUUM;
	  `);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
