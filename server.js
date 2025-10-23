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
  event_date TEXT,
  location TEXT,
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
CREATE TABLE IF NOT EXISTS assignments (
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

CREATE TABLE IF NOT EXISTS wishlists (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, owner_id),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id) REFERENCES participants(id) ON DELETE CASCADE
);

-- wishlist_items: items inside a wishlist
CREATE TABLE IF NOT EXISTS wishlist_items (
  id TEXT PRIMARY KEY,
  wishlist_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  notes TEXT,
  price_cents INTEGER,
  image_url TEXT,
  reserved_by TEXT, -- participant id (optional)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(wishlist_id) REFERENCES wishlists(id) ON DELETE CASCADE,
  FOREIGN KEY(reserved_by) REFERENCES participants(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_wishlist_owner ON wishlists(event_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_items_wl ON wishlist_items(wishlist_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_items_reserved ON wishlist_items(reserved_by);
`);

// --- Safe migration: add date & location to events if missing ---
(function migrateEventsTable() {
  const cols = db.prepare(`PRAGMA table_info(events)`).all();
  const names = new Set(cols.map(c => c.name));

  if (!names.has('event_date')) {
    db.exec(`ALTER TABLE events ADD COLUMN event_date TEXT`); // nullable
  }
  if (!names.has('location')) {
    db.exec(`ALTER TABLE events ADD COLUMN location TEXT`);   // nullable
  }
})();

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

// --- Wishlist helpers ---
function requireMeByToken(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT p.id AS pid, p.name AS pname, p.email, p.event_id,
      e.name AS ename, e.event_date AS edate, e.location AS elocation
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE p.invite_token = ?
  `).get(token);
}

function upsertWishlistForOwner(event_id, owner_id) {
  const existing = db.prepare(
    `SELECT id FROM wishlists WHERE event_id = ? AND owner_id = ?`
  ).get(event_id, owner_id);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO wishlists (id, event_id, owner_id) VALUES (?,?,?)`
  ).run(id, event_id, owner_id);
  return id;
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

/**
 * Send assignment email showing recipients grouped by tier (with budgets).
 *
 * @param {Object} opts
 * @param {string} opts.to                - recipient email address
 * @param {string} opts.participantName   - recipient display name
 * @param {string} opts.eventName         - event name
 * @param {Array}  opts.recipients_by_tier - [{ name, budget_cents, recipient }]
 * @param {string} [opts.replyTo]         - optional reply-to header
 */
async function sendAssignmentEmail({ to, participantName, eventName, recipients_by_tier, replyTo }) {
  // Small helper to format cents -> "$100"
  const fmt = (cents) => {
    if (typeof cents !== "number") return "";
    // show as integer dollars (no decimals) per your example
    return `$${(cents / 100).toFixed(0)}`;
  };

  // Build list items. Guard in case some recipient is still null.
  const items = (Array.isArray(recipients_by_tier) ? recipients_by_tier : [])
    .map(t => {
      const r = t.recipient ? t.recipient : "—";
      const budget = (typeof t.budget_cents === "number" && t.budget_cents > 0) ? ` (${fmt(t.budget_cents)})` : "";
      return `<li style="margin:6px 0;"><b>${escapeHtml(t.name)}</b>${budget}: ${escapeHtml(r)}</li>`;
    })
    .join("");

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#111111;">
      <p>Hi ${escapeHtml(participantName)},</p>
      <p>Your Kris Kringle recipients for <b>${escapeHtml(eventName)}</b> are:</p>
      <ul style="margin:0 0 16px 20px;padding:0;">${items}</ul>
      <p>Happy gifting! 🎁</p>
    </div>
  `;

  // Compose mail options
  const mailOptions = {
    from: process.env.FROM_EMAIL,
    to,
    subject: `Your Kris Kringle recipients for ${eventName}`,
    html,
  };
  if (replyTo) mailOptions.replyTo = replyTo;

  // Send; let errors bubble to caller to handle/log
  await transporter.sendMail(mailOptions);
}

// tiny helper to escape user-provided text for HTML (very small)
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicBaseUrl(req) {
  const proto = req.get('x-forwarded-proto');
  const host = req.get('x-forwarded-host');
  if (proto && host) return `${proto}://${host}`;
  return process.env.BASE_URL || "http://localhost:3000";
}



// --- API: who am I + recipients ---
// GET /api/me
app.get("/api/me", (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  // who am I + event
  const meRow = db.prepare(`
    SELECT p.id, p.name, p.email, p.has_drawn, p.event_id,
          e.name AS event_name, e.event_date, e.location
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
    event: { id: meRow.event_id, name: meRow.event_name, date: meRow.event_date || null, location: meRow.location || null, tiers: tiers.map(t => ({ id: t.id, name: t.name, budget_cents: t.budget_cents })) },
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

    // send email using centralized helper (fire-and-forget)
    sendAssignmentEmail({
      to: meRow.email,
      participantName: meRow.name,
      eventName: meRow.event_name,
      recipients_by_tier,
      // replyTo: "Your Name <you@yourdomain.com>", // optional
    })
      .catch((e) => console.error("Email error:", e && e.message ? e.message : e));

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
  const {
    secret,
    eventName,
    giftsPerPerson,
    participants,
    tiers,
    // 👇 NEW: allow optional event meta
    eventDate,   // e.g. "2025-12-20" or ISO
    location     // e.g. "123 Candy Cane Ln, North Pole"
  } = req.body || {};

  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!eventName) return res.status(400).json({ error: "Missing eventName" });

  const people = Array.isArray(participants) ? participants : [];
  if (people.length < 2) return res.status(400).json({ error: "Need at least 2 participants" });

  // Build tiers (same as before)
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

  const insertEvent = db.prepare(`
    INSERT INTO events (id, name, gifts_per_person, event_date, location)
    VALUES (?,?,?,?,?)
  `);
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
    // 👇 FIX: use eventDate/location from body (or null)
    insertEvent.run(
      eventId,
      eventName,
      tierDefs.length,
      eventDate || null,
      location || null
    );

    // participants
    const pRows = [];
    for (const p of people) {
      const pid = randomUUID();
      const token = randomUUID();
      insertParticipant.run(pid, eventId, p.name, p.email, token);
      pRows.push({ id: pid, name: p.name, email: p.email, token });
    }

    // tiers
    for (const t of tierDefs) {
      insertTier.run(t.id, eventId, t.name, t.budget_cents, t.sort_order);
    }

    // assignments (unchanged)
    const giverIds = pRows.map(p => p.id);
    const alreadyForGiver = new Map(giverIds.map(g => [g, new Set()]));
    for (const t of tierDefs) {
      let perm;
      attempt: for (let tries = 0; tries < 200; tries++) {
        // derange
        const a = giverIds.slice();
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        // no self
        if (a.some((v, i) => v === giverIds[i])) continue attempt;
        // avoid duplicate recipients across tiers
        for (let i = 0; i < giverIds.length; i++) {
          if (alreadyForGiver.get(giverIds[i]).has(a[i])) continue attempt;
        }
        perm = a; break;
      }
      for (let i = 0; i < giverIds.length; i++) {
        insertAssignment.run(randomUUID(), eventId, t.id, giverIds[i], perm[i]);
        alreadyForGiver.get(giverIds[i]).add(perm[i]);
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

  res.json({
    event: {
      id: eventId,
      name: eventName,
      event_date: eventDate || null,   // 👈 include in response (optional)
      location: location || null,      // 👈 include in response (optional)
      tiers: tierDefs.map(t => ({ id: t.id, name: t.name, budget_cents: t.budget_cents })),
    },
    invites: inserted.map(r => ({
      name: r.name,
      email: r.email,
      link: `${base}/draw?token=${r.token}`,
    })),
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

app.post("/api/admin/send-wishlists", async (req, res) => {
  const { secret, eventId } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Use provided event or the most-recent one
  const evt =
    eventId ||
    db.prepare(`SELECT id FROM events ORDER BY created_at DESC LIMIT 1`).get()?.id;

  if (!evt) return res.status(404).json({ error: "No event found" });

  const eventRow = db
    .prepare(`SELECT id, name FROM events WHERE id = ?`)
    .get(evt);

  const base = publicBaseUrl(req); // or: (process.env.BASE_URL || "http://localhost:3000")

  const people = db
    .prepare(`SELECT name, email, invite_token FROM participants WHERE event_id = ?`)
    .all(evt);

  // gently paced transporter helps too
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    rateLimit: 10,   // <= 10 msgs/sec
    rateDelta: 1000
  });

  function buildWishlistEmail({ personName, eventName, link }) {
    const subject = `Your wishlist link for ${eventName}`;

    // PLAIN TEXT (important)
    const text = [
      `Hi ${personName},`,
      ``,
      `Your wishlist page for ${eventName} is ready.`,
      `Open your personal link: ${link}`,
      ``,
      `This link is authenticated by your invite token. Do not share it.`,
      ``,
      `Thanks!`
    ].join('\n');

    // MINIMAL HTML (one link, no emojis, minimal styling)
    const html =
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;color:#111">` +
      `<p>Hi ${escapeHtml(personName)},</p>` +
      `<p>Your wishlist page for ${escapeHtml(eventName)} is ready.</p>` +
      `<p><a href="${link}" rel="noopener">Open your personal link</a></p>` +
      `<p style="color:#6b7280;font-size:14px">This link is authenticated by your invite token. Do not share it.</p>` +
      `<p>Thanks!</p>` +
      `</div>`;

    return { subject, text, html };
  }

  async function sendWishlist({ to, subject, text, html }) {
    return transporter.sendMail({
      from: process.env.FROM_EMAIL,                    // e.g. "Wong's Kris Kringle <noreply@mail.wongskringle.online>"
      to,
      subject,
      text,    // 👈 include text
      html,
      // If your ESP supports per-message tracking flags, disable them:
      // headers: { 'X-MJ-TrackOpen': '0', 'X-MJ-TrackClick': '0' } // (Mailjet SMTP header names vary; use dashboard if unsure)
    });
  }


  let sent = 0;
  const failed = [];

  for (const p of people) {
    const wl = `${base}/wishlists?token=${encodeURIComponent(p.invite_token)}`;
    const { subject, text, html } = buildWishlistEmail({
      personName: p.name, eventName: eventRow.name, link: wl
    });

    try {
      await sendWishlist({ to: p.email, subject, text, html });
      sent++;
    } catch (e) {
      failed.push({ email: p.email, error: e.message });
    }
  }

  return res.json({ ok: true, sent, failed });
});

app.post('/api/admin/event/update', (req, res) => {
  const { secret, eventId, eventDate, location } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  // default to most recent if not provided
  const evt = eventId || db.prepare(`SELECT id FROM events ORDER BY created_at DESC LIMIT 1`).get()?.id;
  if (!evt) return res.status(404).json({ error: 'No event found' });

  db.prepare(`
    UPDATE events
    SET event_date = COALESCE(?, event_date),
        location   = COALESCE(?, location)
    WHERE id = ?
  `).run(eventDate || null, location || null, evt);

  const out = db.prepare(`SELECT id, name, event_date, location FROM events WHERE id = ?`).get(evt);
  res.json({ ok: true, event: out });
});


app.post("/api/resend", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const me = getParticipantByToken(token);
  if (!me) return res.status(404).json({ error: "Invalid token" });

  // fetch tiers
  const tiers = db.prepare(`
    SELECT id, name, budget_cents, sort_order
    FROM gift_tiers
    WHERE event_id = ?
    ORDER BY sort_order
  `).all(me.event_id);

  // fetch assigned recipients for this giver (tier-aware)
  const rows = db.prepare(`
    SELECT a.tier_id, r.name AS recipient_name
    FROM assignments a
    JOIN participants r ON r.id = a.recipient_id
    WHERE a.event_id = ? AND a.giver_id = ?
  `).all(me.event_id, me.id);

  const recipients_by_tier = tiers.map(t => ({
    tier_id: t.id,
    name: t.name,
    budget_cents: t.budget_cents,
    recipient: (rows.find(r => r.tier_id === t.id) || {}).recipient_name || null,
  }));

  // If there are no recipients yet (not drawn), bail
  const any = recipients_by_tier.some(t => !!t.recipient);
  if (!any) return res.status(400).json({ error: "You haven’t drawn yet." });

  try {
    await sendAssignmentEmail({
      to: me.email,
      participantName: me.name,
      eventName: me.event_name,
      recipients_by_tier,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Resend email error:", e && e.message ? e.message : e);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// --- Wishlist: me (owner/manage) ---
app.get('/api/wishlist/me', (req, res) => {
  const me = requireMeByToken(req.query.token);
  if (!me) return res.status(401).json({ error: 'invalid token' });

  const wid = upsertWishlistForOwner(me.event_id, me.pid);
  const wl = db.prepare(`SELECT id,event_id,owner_id,created_at,updated_at FROM wishlists WHERE id=?`).get(wid);

  // do not return reserved_by — only a boolean
  const items = db.prepare(`
    SELECT id, title, url, notes, price_cents, image_url,
           CASE WHEN reserved_by IS NULL THEN 0 ELSE 1 END AS is_reserved,
           created_at, updated_at
    FROM wishlist_items
    WHERE wishlist_id=?
    ORDER BY created_at DESC
  `).all(wid);

  res.json({ wishlist: wl, items });
});

// --- Wishlist: create item (owner only) ---
app.post('/api/wishlist/item', (req, res) => {
  const { token, title, url, notes, price_cents, image_url } = req.body || {};
  const me = requireMeByToken(token);
  if (!me) return res.status(401).json({ error: 'invalid token' });
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });

  const wid = upsertWishlistForOwner(me.event_id, me.pid);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO wishlist_items (id, wishlist_id, title, url, notes, price_cents, image_url)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    id,
    wid,
    String(title).trim(),
    url || null,
    notes || null,
    Number.isInteger(price_cents) ? price_cents : null,
    image_url || null
  );

  const row = db.prepare(`SELECT * FROM wishlist_items WHERE id=?`).get(id);
  res.json({ ok: true, item: row });
});

// --- Wishlist: update item (owner only) ---
app.put('/api/wishlist/item/:id', (req, res) => {
  const id = req.params.id;
  const { token, title, url, notes, price_cents, image_url } = req.body || {};
  const me = requireMeByToken(token);
  if (!me) return res.status(401).json({ error: 'invalid token' });

  const row = db.prepare(`
    SELECT wi.id, wl.owner_id
    FROM wishlist_items wi
    JOIN wishlists wl ON wl.id = wi.wishlist_id
    WHERE wi.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.owner_id !== me.pid) return res.status(403).json({ error: 'forbidden' });

  db.prepare(`
    UPDATE wishlist_items SET
      title       = COALESCE(?, title),
      url         = COALESCE(?, url),
      notes       = COALESCE(?, notes),
      price_cents = COALESCE(?, price_cents),
      image_url   = COALESCE(?, image_url),
      updated_at  = datetime('now')
    WHERE id = ?
  `).run(
    title || null,
    url || null,
    notes || null,
    Number.isInteger(price_cents) ? price_cents : null,
    image_url || null,
    id
  );

  const updated = db.prepare(`SELECT * FROM wishlist_items WHERE id=?`).get(id);
  res.json({ ok: true, item: updated });
});

// --- Wishlist: delete item (owner only) ---
app.delete('/api/wishlist/item/:id', (req, res) => {
  const id = req.params.id;
  const { token } = req.body || {};
  const me = requireMeByToken(token);
  if (!me) return res.status(401).json({ error: 'invalid token' });

  const row = db.prepare(`
    SELECT wi.id, wl.owner_id
    FROM wishlist_items wi
    JOIN wishlists wl ON wl.id = wi.wishlist_id
    WHERE wi.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.owner_id !== me.pid) return res.status(403).json({ error: 'forbidden' });

  db.prepare(`DELETE FROM wishlist_items WHERE id=?`).run(id);
  res.json({ ok: true });
});

// --- Wishlist: reserve / unreserve (optional claiming) ---
app.post('/api/wishlist/item/:id/reserve', (req, res) => {
  const id = req.params.id;
  const { token } = req.body || {};
  const me = requireMeByToken(token);
  if (!me) return res.status(401).json({ error: 'invalid token' });

  // Load item + wishlist owner + event
  const row = db.prepare(`
    SELECT wi.id, wi.reserved_by, wl.owner_id, wl.event_id
    FROM wishlist_items wi
    JOIN wishlists wl ON wl.id = wi.wishlist_id
    WHERE wi.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.event_id !== me.event_id) return res.status(403).json({ error: 'forbidden' });
  if (row.owner_id === me.pid) return res.status(400).json({ error: "can't reserve your own item" });

  // ✅ NEW: only givers assigned to this owner may reserve
  const myRecipients = getRecipientsForGiver(me.event_id, me.pid); // [{id, name}]
  const allowedRecipientIds = new Set(myRecipients.map(r => r.id));
  if (!allowedRecipientIds.has(row.owner_id)) {
    return res.status(403).json({ error: 'not assigned to this participant' });
  }

  if (row.reserved_by && row.reserved_by !== me.pid) {
    return res.status(409).json({ error: 'already reserved' });
  }

  db.prepare(`UPDATE wishlist_items SET reserved_by=?, updated_at=datetime('now') WHERE id=?`)
    .run(me.pid, id);
  res.json({ ok: true });
});


app.post('/api/wishlist/item/:id/unreserve', (req, res) => {
  const id = req.params.id;
  const { token } = req.body || {};
  const me = requireMeByToken(token);
  if (!me) return res.status(401).json({ error: 'invalid token' });

  const row = db.prepare(`
    SELECT wi.id, wi.reserved_by, wl.event_id
    FROM wishlist_items wi
    JOIN wishlists wl ON wl.id = wi.wishlist_id
    WHERE wi.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.event_id !== me.event_id) return res.status(403).json({ error: 'forbidden' });
  if (row.reserved_by && row.reserved_by !== me.pid) {
    return res.status(403).json({ error: 'not your reservation' });
  }

  db.prepare(`UPDATE wishlist_items SET reserved_by=NULL, updated_at=datetime('now') WHERE id=?`).run(id);
  res.json({ ok: true });
});


// List everyone’s wishlists for the event (anonymized).
// GET /api/wishlists/all?token=...
app.get('/api/wishlists/all', (req, res) => {
  const me = requireMeByToken(req.query.token);
  if (!me) return res.status(401).json({ error: 'invalid token' });

  // also fetch my draw status + token
  const meExtra = db.prepare(`
    SELECT has_drawn, invite_token
    FROM participants
    WHERE id = ?
  `).get(me.pid) || { has_drawn: 0, invite_token: null };


  const people = db.prepare(`
    SELECT id, name FROM participants
    WHERE event_id = ?
    ORDER BY name COLLATE NOCASE
  `).all(me.event_id);

  const myRecipients = getRecipientsForGiver(me.event_id, me.pid); // [{id,name}]
  const allowedOwnerIds = new Set(myRecipients.map(r => r.id));

  const rows = db.prepare(`
    SELECT wl.owner_id,
           wi.id AS item_id, wi.title, wi.url, wi.notes, wi.price_cents, wi.image_url,
           CASE WHEN wi.reserved_by IS NULL THEN 0 ELSE 1 END AS is_reserved,
           CASE WHEN wi.reserved_by = ? THEN 1 ELSE 0 END AS reserved_by_me,
           wi.created_at
    FROM wishlists wl
    LEFT JOIN wishlist_items wi ON wi.wishlist_id = wl.id
    WHERE wl.event_id = ?
    ORDER BY wi.created_at DESC
  `).all(me.pid, me.event_id);  // 👈 pass me.pid

  const byOwner = new Map(people.map(p => [p.id, { owner: p, items: [] }]));
  for (const r of rows) {
    const bucket = byOwner.get(r.owner_id);
    if (!bucket) continue;
    if (r.item_id) {
      // 🔒 Visibility rule: only givers to this owner can see the reserved state.
      const canSee = allowedOwnerIds.has(r.owner_id); // A or B gifting to C -> canSee=true for C's items
      bucket.items.push({
        id: r.item_id,
        title: r.title,
        url: r.url,
        notes: r.notes,
        price_cents: r.price_cents,
        image_url: r.image_url,
        is_reserved: canSee ? r.is_reserved : 0,
        reserved_by_me: canSee ? r.reserved_by_me : 0,
      });
    }
  }

  const tiers = db.prepare(`
    SELECT id, name, budget_cents, sort_order
    FROM gift_tiers
    WHERE event_id = ?
    ORDER BY sort_order
  `).all(me.event_id);

  // Build recipients_by_tier for the current user
  let recipients_by_tier = tiers.map(t => ({
    tier_id: t.id,
    name: t.name,
    budget_cents: t.budget_cents,
    recipient: null
  }));
  if (meExtra.has_drawn) {
    const rows = db.prepare(`
     SELECT a.tier_id, r.name AS recipient_name
     FROM assignments a
     JOIN participants r ON r.id = a.recipient_id
     WHERE a.event_id = ? AND a.giver_id = ?
   `).all(me.event_id, me.pid);
    recipients_by_tier = tiers.map(t => ({
      tier_id: t.id,
      name: t.name,
      budget_cents: t.budget_cents,
      recipient: (rows.find(r => r.tier_id === t.id) || {}).recipient_name || null,
    }));
  }

  res.json({
    me: {
      id: me.pid,
      name: me.pname,
      has_drawn: !!meExtra.has_drawn,
      invite_token: meExtra.invite_token
    },
    event: { id: me.event_id, name: me.ename, date: me.edate, location: me.elocation },
    tiers: tiers.map(t => ({ id: t.id, name: t.name, budget_cents: t.budget_cents })),
    recipients_by_tier,
    allowed_owner_ids: Array.from(allowedOwnerIds),
    participants: people,
    wishlists: people.map(p => byOwner.get(p.id) || { owner: p, items: [] })
  });
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
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

app.get('/wishlists', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wishlists.html'));
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
