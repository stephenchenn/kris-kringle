const { eventSchedule } = require('./event-time');
const key = row => `${row.recipient_id}:${row.tier_id}`;

function installGifterGame({ app, db, requireMeByToken, now = Date.now }) {
  // Existing ballots guessed the participant's own gifters. Preserve every pick
  // and its original time when expanding the primary key to include recipients.
  if (!db.prepare('PRAGMA table_info(gifter_guesses)').all().some(column => column.name === 'recipient_id')) {
    db.transaction(() => {
      db.exec(`ALTER TABLE gifter_guesses RENAME TO gifter_guesses_legacy;
        CREATE TABLE gifter_guesses (
          event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          tier_id TEXT NOT NULL REFERENCES gift_tiers(id) ON DELETE CASCADE,
          guessed_gifter_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          edited_at INTEGER NOT NULL,
          PRIMARY KEY(event_id,participant_id,recipient_id,tier_id)
        );
        INSERT INTO gifter_guesses SELECT event_id,participant_id,participant_id,tier_id,guessed_gifter_id,edited_at FROM gifter_guesses_legacy;
        DROP TABLE gifter_guesses_legacy;`);
    })();
  }
  const eventFor = me => db.prepare('SELECT * FROM events WHERE id=?').get(me.event_id);
  const tiersFor = me => db.prepare('SELECT id,name,budget_cents FROM gift_tiers WHERE event_id=? ORDER BY sort_order').all(me.event_id);
  const knownFor = me => db.prepare('SELECT recipient_id,tier_id FROM assignments WHERE event_id=? AND giver_id=?').all(me.event_id,me.pid);

  function board(me) {
    const event = eventFor(me), schedule = eventSchedule(event,now());
    const tiers = tiersFor(me);
    const people = db.prepare('SELECT id,name FROM participants WHERE event_id=? ORDER BY name COLLATE NOCASE').all(me.event_id);
    const guesses = db.prepare('SELECT * FROM gifter_guesses WHERE event_id=?').all(me.event_id);
    // Before the reveal, only fetch this viewer's already-known outgoing gifts.
    // Never mark another guesser's omitted cells as known: that would give away
    // their recipients. Public blanks all look the same.
    const known = knownFor(me);
    const answers = schedule.phase === 'results'
      ? db.prepare('SELECT tier_id,giver_id,recipient_id FROM assignments WHERE event_id=?').all(me.event_id) : [];
    const maximum = people.length*tiers.length-tiers.length;
    const rows = people.map(person => {
      const ballot = guesses.filter(guess => guess.participant_id===person.id);
      const cells = people.flatMap(recipient => tiers.map(tier => {
        const answer = answers.find(row => row.recipient_id===recipient.id && row.tier_id===tier.id);
        const excluded = schedule.phase==='results' && answer?.giver_id===person.id;
        const guess = excluded ? null : ballot.find(row => row.recipient_id===recipient.id && row.tier_id===tier.id);
        const gifter = people.find(p => p.id===guess?.guessed_gifter_id);
        const item = { recipient_id:recipient.id, recipient_name:recipient.name,
          tier_id:tier.id, tier_name:tier.name, budget_cents:tier.budget_cents,
          guessed_gifter_id:gifter?.id ?? null, guessed_gifter_name:gifter?.name ?? null,
          edited_at:guess ? new Date(guess.edited_at).toISOString() : null };
        if (schedule.phase === 'results') {
          item.excluded = excluded;
          item.actual_gifter_name = people.find(p => p.id===answer?.giver_id)?.name ?? null;
          item.correct = !excluded && !!guess && guess.guessed_gifter_id===answer?.giver_id;
        }
        return item;
      }));
      const row = { participant:person, guesses:cells };
      if (schedule.phase === 'results') {
        const correct = cells.filter(guess => guess.correct);
        row.correct_count = correct.length;
        row.possible_count = cells.filter(guess => !guess.excluded).length;
        row.average_correct_guess_ms = correct.length
          ? correct.reduce((sum,guess)=>sum+Date.parse(guess.edited_at),0)/correct.length : null;
        row.average_correct_guess_at = correct.length ? new Date(row.average_correct_guess_ms).toISOString() : null;
      }
      return row;
    });
    if (schedule.phase === 'results') {
      rows.sort((a,b) => b.correct_count-a.correct_count ||
        (a.average_correct_guess_ms ?? Infinity)-(b.average_correct_guess_ms ?? Infinity) ||
        a.participant.name.localeCompare(b.participant.name));
      let previous=null;
      rows.forEach((row,index) => {
        row.rank = previous && row.correct_count===previous.correct_count && row.average_correct_guess_ms===previous.average_correct_guess_ms
          ? previous.rank : index+1;
        previous=row;
      });
    }
    return { me_id:me.pid, ...schedule, event:{id:event.id,name:event.name}, tiers, participants:people, rows,
      known_assignments:known, guess_count:maximum,
      rules:'Guess every recipient’s gifter for each tier, except gifts you are giving. Most correct guesses wins; ties use the average last-edit time of correct guesses, earliest first.' };
  }

  app.get('/api/wishlist/guesses',(req,res) => {
    const me = requireMeByToken(req.query.token);
    if(!me)return res.status(401).json({error:'invalid token'});
    res.json(board(me));
  });

  const save = db.transaction((me,submitted) => {
    const schedule = eventSchedule(eventFor(me),now());
    if (schedule.phase !== 'open') return { status:409, error:schedule.phase==='unavailable'
      ? 'The organiser needs to set an event date before guesses can open.' : 'Guesses are locked for the event.', ...schedule };
    const tiers=tiersFor(me);
    const people=db.prepare('SELECT id FROM participants WHERE event_id=?').all(me.event_id);
    const known=new Set(knownFor(me).map(key));
    if (!Array.isArray(submitted) || !submitted.length || submitted.length>people.length*tiers.length-known.size) return {status:400,error:'Choose a valid recipient, gift tier and gifter.'};
    if (new Set(submitted.map(row=>row && key(row))).size!==submitted.length) return {status:400,error:'Each recipient and gift tier can have only one guess.'};
    for (const row of submitted) {
      if (!row || !people.some(person=>person.id===row.recipient_id) || !tiers.some(tier=>tier.id===row.tier_id) ||
          known.has(key(row)) || (row.guessed_gifter_id!==null &&
          (row.guessed_gifter_id===me.pid || row.guessed_gifter_id===row.recipient_id || !people.some(p=>p.id===row.guessed_gifter_id)))) {
        return {status:400,error:'Choose a participant from this event. You cannot guess gifts you are giving, or someone gifting to themselves.'};
      }
    }
    const existing=db.prepare('SELECT * FROM gifter_guesses WHERE event_id=? AND participant_id=?').all(me.event_id,me.pid);
    const proposed=new Map(existing.filter(row=>!known.has(key(row))).map(row=>[key(row),row]));
    for(const row of submitted) {
      if(row.guessed_gifter_id===null) proposed.delete(key(row));
      else proposed.set(key(row),row);
    }
    const ballot=[...proposed.values()];
    for (const row of ballot) {
      if (ballot.some(other=>key(other)!==key(row) && other.guessed_gifter_id===row.guessed_gifter_id &&
          (other.tier_id===row.tier_id || (tiers.length<=people.length-1 && other.recipient_id===row.recipient_id)))) {
        return {status:400,error:'Each gifter gives once per tier, and each recipient gets different gifters across tiers.'};
      }
    }
    const timestamp=now();
    for (const row of submitted) {
      const old=existing.find(guess=>key(guess)===key(row));
      if(row.guessed_gifter_id===null) {
        db.prepare('DELETE FROM gifter_guesses WHERE event_id=? AND participant_id=? AND recipient_id=? AND tier_id=?').run(me.event_id,me.pid,row.recipient_id,row.tier_id);
      } else if(old?.guessed_gifter_id!==row.guessed_gifter_id) {
        db.prepare(`INSERT INTO gifter_guesses(event_id,participant_id,recipient_id,tier_id,guessed_gifter_id,edited_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(event_id,participant_id,recipient_id,tier_id) DO UPDATE SET guessed_gifter_id=excluded.guessed_gifter_id,edited_at=excluded.edited_at`)
          .run(me.event_id,me.pid,row.recipient_id,row.tier_id,row.guessed_gifter_id,timestamp);
      }
    }
    return {status:200};
  });
  app.put('/api/wishlist/guesses',(req,res) => {
    const me=requireMeByToken(req.body?.token);
    if(!me) return res.status(401).json({error:'invalid token'});
    const result=save(me,req.body.guesses);
    if(result.status!==200) {const {status,...body}=result;return res.status(status).json(body);}
    res.json({ok:true,...board(me)});
  });
  return { board };
}
module.exports={installGifterGame};
