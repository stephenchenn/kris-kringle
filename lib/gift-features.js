const { randomUUID } = require('node:crypto');
const DAY = 24 * 60 * 60 * 1000;

function installGiftFeatures({ app, db, transporter, fromEmail, requireMeByToken, publicBaseUrl, escapeHtml, now = Date.now }) {
  const columns = db.prepare('PRAGMA table_info(events)').all();
  if (!columns.some(column => column.name === 'event_timezone')) {
    db.exec("ALTER TABLE events ADD COLUMN event_timezone TEXT NOT NULL DEFAULT 'Australia/Adelaide'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS wishlist_subscriptions (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      giver_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      PRIMARY KEY(event_id,giver_id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS gift_email_jobs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('wishlist','reminder')),
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      locked_at INTEGER,
      sent_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gift_email_pending ON gift_email_jobs(status,available_at);
    CREATE TABLE IF NOT EXISTS wishlist_reminders (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES gift_email_jobs(id) ON DELETE CASCADE,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY(event_id,owner_id)
    );
    CREATE TABLE IF NOT EXISTS gifter_guesses (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      tier_id TEXT NOT NULL REFERENCES gift_tiers(id) ON DELETE CASCADE,
      guessed_gifter_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      edited_at INTEGER NOT NULL,
      PRIMARY KEY(event_id,participant_id,recipient_id,tier_id)
    );
  `);

  const isGiver = (me, ownerId) => !!me && ownerId !== me.pid && !!db.prepare(`
    SELECT 1 FROM assignments WHERE event_id=? AND giver_id=? AND recipient_id=?
  `).get(me.event_id, me.pid, ownerId);
  const httpUrl = value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  };
  const fmtMoney = cents => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
  const iso = value => value == null ? null : new Date(value).toISOString();

  function reminderState(eventId, ownerId) {
    // Include queued requests in the quota so concurrent gifters cannot race it.
    // Legacy jobs have no requested_at payload; retain their original send time.
    const rows = db.prepare(`SELECT status,COALESCE(json_extract(payload,'$.requested_at'),sent_at,available_at) requested
      FROM gift_email_jobs WHERE event_id=? AND owner_id=? AND kind='reminder'
      AND status IN ('pending','sending','sent')`).all(eventId,ownerId)
      .filter(row => row.requested > now()-DAY || row.status!=='sent');
    const remaining = Math.max(0,2-rows.length);
    return { can_remind: remaining>0, reminders_remaining: remaining,
      next_reminder_at: remaining ? null : iso(Math.max(now()+1000,Math.min(...rows.map(row=>row.requested))+DAY)) };
  }

  function recipientSettings(me) {
    const recipients = db.prepare('SELECT DISTINCT recipient_id id FROM assignments WHERE event_id=? AND giver_id=?').all(me.event_id, me.pid);
    const subscriptions = db.prepare('SELECT owner_id,enabled FROM wishlist_subscriptions WHERE event_id=? AND giver_id=?').all(me.event_id, me.pid);
    return Object.fromEntries(recipients.map(person => [person.id, {
      notifications_enabled: !!subscriptions.find(row => row.owner_id === person.id)?.enabled,
      ...reminderState(me.event_id, person.id),
    }]));
  }

  function queue(kind, eventId, recipientId, ownerId, payload) {
    const id = randomUUID();
    db.prepare(`INSERT INTO gift_email_jobs(id,event_id,recipient_id,owner_id,kind,payload,available_at)
      VALUES(?,?,?,?,?,?,?)`).run(id,eventId,recipientId,ownerId,kind,JSON.stringify(payload),now());
    return id;
  }

  function enqueueWishlistItem(me, item) {
    const subscribers = db.prepare(`SELECT s.giver_id FROM wishlist_subscriptions s
      JOIN participants p ON p.id=s.giver_id
      WHERE s.event_id=? AND s.owner_id=? AND s.enabled=1 AND p.has_drawn=1
      AND EXISTS (SELECT 1 FROM assignments a WHERE a.event_id=s.event_id AND a.giver_id=s.giver_id AND a.recipient_id=s.owner_id)`)
      .all(me.event_id,me.pid);
    for (const subscriber of subscribers) queue('wishlist',me.event_id,subscriber.giver_id,me.pid,{ item });
    kick();
  }

  function enqueueReservation(ownerId, eventId, item, reserverId) {
    const others=db.prepare(`SELECT DISTINCT a.giver_id FROM assignments a JOIN participants p ON p.id=a.giver_id
      WHERE a.event_id=? AND a.recipient_id=? AND a.giver_id<>? AND p.has_drawn=1`).all(eventId,ownerId,reserverId);
    for(const other of others)queue('wishlist',eventId,other.giver_id,ownerId,{type:'reservation_taken',item,reserverId});
    kick();
  }

  function enqueueReservedDeletion(ownerId,eventId,item) {
    if(!item.reserved_by || !db.prepare(`SELECT 1 FROM assignments WHERE event_id=? AND recipient_id=? AND giver_id=?`)
      .get(eventId,ownerId,item.reserved_by))return;
    queue('wishlist',eventId,item.reserved_by,ownerId,{type:'reservation_deleted',item});
    kick();
  }

  function emailFor(job) {
    const recipient = db.prepare('SELECT * FROM participants WHERE id=? AND event_id=?').get(job.recipient_id,job.event_id);
    const owner = db.prepare('SELECT * FROM participants WHERE id=? AND event_id=?').get(job.owner_id,job.event_id);
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(job.event_id);
    if (!recipient || !owner || !event) return null;
    const link = `${publicBaseUrl()}/wishlists?token=${encodeURIComponent(recipient.invite_token)}`;
    if (job.kind === 'reminder') {
      const {message=''}=JSON.parse(job.payload);
      const subject = `A little wishlist nudge for ${event.name}`;
      const text = `Hi ${owner.name},\n\nSomeone gifting to you would love a few hints! Add a few ideas to your wishlist for ${event.name}.${message?'\n\nTheir anonymous message:\n'+message:''}\n\nOpen your wishlist: ${link}\n\nHappy gifting! 🎁`;
      const html = `<p>Hi ${escapeHtml(owner.name)},</p><p>Someone gifting to you would love a few hints! Add a few ideas to your wishlist for <b>${escapeHtml(event.name)}</b>.</p>${message?`<p><b>Their anonymous message:</b></p><blockquote style="white-space:pre-wrap">${escapeHtml(message)}</blockquote>`:''}<p><a href="${escapeHtml(link)}">Open your wishlist</a></p><p>Happy gifting! 🎁</p>`;
      return { to: owner.email, subject, text, html };
    }
    // Reservation changes are transactional alerts, independent of new-item bells.
    // Never include the other gifter's name, email, token or assigned gift tier.
    const payload=JSON.parse(job.payload);
    if(payload.type==='reservation_taken' || payload.type==='reservation_deleted') {
      if(!isGiver({pid:recipient.id,event_id:job.event_id},owner.id))return null;
      const {item}=payload;
      const deleted=payload.type==='reservation_deleted';
      if(!deleted && db.prepare('SELECT reserved_by FROM wishlist_items WHERE id=?').get(item.id)?.reserved_by!==payload.reserverId)return null;
      const subject=deleted?`A gift you reserved was removed — ${event.name}`:`Reserve soon! A gift for ${owner.name} was reserved`;
      const note=deleted?`${owner.name} removed “${item.title}” from their wishlist. You had reserved it, so check their current list before buying.`
        :`Another gifter reserved “${item.title}” on ${owner.name}’s wishlist. Reserve soon — choose another available idea and reserve it if you plan to buy it.`;
      return {to:recipient.email,subject,text:`Hi ${recipient.name},\n\n${note}\n\nView wishlists: ${link}`,
        html:`<p>Hi ${escapeHtml(recipient.name)},</p><p>${escapeHtml(note)}</p><p><a href="${escapeHtml(link)}">View wishlists</a></p>`};
    }
    const subscribed = db.prepare('SELECT enabled FROM wishlist_subscriptions WHERE event_id=? AND giver_id=? AND owner_id=?').get(job.event_id,job.recipient_id,job.owner_id);
    const { item } = JSON.parse(job.payload);
    if (!subscribed?.enabled || !db.prepare('SELECT 1 FROM wishlist_items WHERE id=?').get(item.id)) return null;
    const productLink = httpUrl(item.url), image = httpUrl(item.image_url);
    const price = Number.isSafeInteger(item.price_cents) ? fmtMoney(item.price_cents) : null;
    const subject = `${owner.name} added a wishlist idea — ${event.name}`;
    const text = [`Hi ${recipient.name},`, '', `${owner.name} added a new wishlist item:`, item.title,
      price ? `Price: ${price}` : null, item.notes ? `Notes: ${item.notes}` : null, productLink ? `Product: ${productLink}` : null,
      '', `View wishlists: ${link}`, '', 'You can turn off these emails using the bell on their wishlist card.'].filter(value => value !== null).join('\n');
    const html = `<p>Hi ${escapeHtml(recipient.name)},</p><p><b>${escapeHtml(owner.name)}</b> added a wishlist idea:</p>
      <h2>${escapeHtml(item.title)}</h2>${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.title)}" width="180" style="max-width:100%;height:auto;">` : ''}
      ${price ? `<p><b>Price:</b> ${escapeHtml(price)}</p>` : ''}${item.notes ? `<p><b>Notes:</b> ${escapeHtml(item.notes)}</p>` : ''}
      ${productLink ? `<p><a href="${escapeHtml(productLink)}">View product</a></p>` : ''}<p><a href="${escapeHtml(link)}">View wishlists</a></p>
      <p>You can turn off these emails using the bell on their wishlist card.</p>`;
    return { to: recipient.email, subject, text, html };
  }

  let active = null, stopped = false;
  async function drain() {
    for (;;) {
      if (stopped || !db.open) return;
      const job = db.transaction(() => {
        const row = db.prepare(`SELECT * FROM gift_email_jobs WHERE
          (status='pending' AND available_at<=?) OR (status='sending' AND locked_at<?)
          ORDER BY available_at LIMIT 1`).get(now(),now()-10*60*1000);
        if (row) db.prepare("UPDATE gift_email_jobs SET status='sending',locked_at=?,attempts=attempts+1 WHERE id=?").run(now(),row.id);
        return row;
      })();
      if (!job) return;
      try {
        const mail = emailFor(job);
        if (!mail) { db.prepare("UPDATE gift_email_jobs SET status='cancelled' WHERE id=?").run(job.id); continue; }
        await transporter.sendMail({ from: fromEmail, ...mail,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#243c34;">${mail.html}</div>` });
        db.prepare("UPDATE gift_email_jobs SET status='sent',sent_at=?,last_error=NULL WHERE id=?").run(now(),job.id);
      } catch (error) {
        const attempts = job.attempts + 1;
        db.prepare('UPDATE gift_email_jobs SET status=?,available_at=?,last_error=? WHERE id=?')
          .run(attempts >= 5 ? 'failed' : 'pending',now()+Math.min(30*60*1000,30000*2**(attempts-1)),String(error.message || error).slice(0,1000),job.id);
        console.error(`Gift email ${job.id} will ${attempts >= 5 ? 'not retry' : 'retry'}`);
      }
    }
  }
  function kick() {
    if (!active && !stopped) active = Promise.resolve().then(drain).catch(error => {
      console.error('Gift email queue:', error.message);
    }).finally(() => { active = null; });
    return active;
  }
  const timer = setInterval(kick,5000); timer.unref();
  kick();

  app.put('/api/wishlist/recipients/:ownerId/notifications',(req,res) => {
    const me = requireMeByToken(req.body?.token);
    if (!isGiver(me,req.params.ownerId)) return res.status(403).json({ error: 'Only assigned gift givers can follow this wishlist.' });
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'Choose whether notifications are enabled.' });
    db.prepare(`INSERT INTO wishlist_subscriptions(event_id,giver_id,owner_id,enabled) VALUES(?,?,?,?)
      ON CONFLICT(event_id,giver_id,owner_id) DO UPDATE SET enabled=excluded.enabled`)
      .run(me.event_id,me.pid,req.params.ownerId,Number(req.body.enabled));
    res.json({ ok:true, ...recipientSettings(me)[req.params.ownerId] });
  });

  const requestReminder = db.transaction((me,ownerId,message) => {
    const state = reminderState(me.event_id,ownerId);
    if (!state.can_remind) return state;
    const id = queue('reminder',me.event_id,ownerId,ownerId,{message,requested_at:now()});
    db.prepare(`INSERT INTO wishlist_reminders(event_id,owner_id,job_id,requested_at) VALUES(?,?,?,?)
      ON CONFLICT(event_id,owner_id) DO UPDATE SET job_id=excluded.job_id,requested_at=excluded.requested_at`)
      .run(me.event_id,ownerId,id,now());
    return null;
  });
  app.post('/api/wishlist/recipients/:ownerId/remind',(req,res) => {
    const me = requireMeByToken(req.body?.token);
    if (!isGiver(me,req.params.ownerId)) return res.status(403).json({ error: 'Only assigned gift givers can send a wishlist reminder.' });
    const message=req.body.message ?? '';
    if(typeof message!=='string' || message.length>500)return res.status(400).json({error:'Keep your anonymous message to 500 characters or fewer.'});
    const limited = requestReminder(me,req.params.ownerId,message.trim());
    if (limited) {
      res.set('Retry-After',String(Math.max(1,Math.ceil((Date.parse(limited.next_reminder_at)-now())/1000))));
      return res.status(429).json({ error: 'This person has already had two nudges in 24 hours. Please wait before sending another.', ...limited });
    }
    kick();
    res.status(202).json({ ok:true, ...recipientSettings(me)[req.params.ownerId] });
  });

  return { recipientSettings, enqueueWishlistItem, enqueueReservation, enqueueReservedDeletion,
    async stop() { stopped=true;clearInterval(timer);await active; },
    flushEmails: kick, now };
}
module.exports = { installGiftFeatures, DAY };
