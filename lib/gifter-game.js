const { eventSchedule } = require('./event-time');

function installGifterGame({ app, db, requireMeByToken, now = Date.now }) {
  const eventFor = me => db.prepare('SELECT * FROM events WHERE id=?').get(me.event_id);
  const tiersFor = me => db.prepare('SELECT id,name,budget_cents FROM gift_tiers WHERE event_id=? ORDER BY sort_order').all(me.event_id);

  function board(me) {
    const event = eventFor(me), schedule = eventSchedule(event,now());
    const tiers = tiersFor(me);
    const people = db.prepare('SELECT id,name FROM participants WHERE event_id=? ORDER BY name COLLATE NOCASE').all(me.event_id);
    const guesses = db.prepare('SELECT * FROM gifter_guesses WHERE event_id=?').all(me.event_id);
    // Do not even fetch the answers until the reveal time.
    const answers = schedule.phase === 'results'
      ? db.prepare('SELECT tier_id,giver_id,recipient_id FROM assignments WHERE event_id=?').all(me.event_id) : [];
    const rows = people.map(person => {
      const guessesByTier = tiers.map(tier => {
        const guess = guesses.find(row => row.participant_id===person.id && row.tier_id===tier.id);
        const gifter = people.find(p => p.id===guess?.guessed_gifter_id);
        const item = { tier_id:tier.id, tier_name:tier.name, budget_cents:tier.budget_cents,
          guessed_gifter_id:gifter?.id ?? null, guessed_gifter_name:gifter?.name ?? null,
          edited_at:guess ? new Date(guess.edited_at).toISOString() : null };
        if (schedule.phase === 'results') {
          const answer = answers.find(row => row.recipient_id===person.id && row.tier_id===tier.id);
          item.actual_gifter_name = people.find(p => p.id===answer?.giver_id)?.name ?? null;
          item.correct = !!guess && guess.guessed_gifter_id===answer?.giver_id;
        }
        return item;
      });
      const row = { participant:person, guesses:guessesByTier };
      if (schedule.phase === 'results') {
        const correct = guessesByTier.filter(guess => guess.correct);
        row.correct_count = correct.length;
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
      rules:'One guess per gift tier. Most correct guesses wins; ties use the average last-edit time of correct guesses, earliest first.' };
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
    if (!Array.isArray(submitted) || !submitted.length || submitted.length>tiers.length) return {status:400,error:'Choose a valid gift tier and gifter.'};
    if (new Set(submitted.map(row=>row?.tier_id)).size!==submitted.length) return {status:400,error:'Each gift tier can have only one guess.'};
    const people=db.prepare('SELECT id FROM participants WHERE event_id=?').all(me.event_id);
    for (const row of submitted) {
      if (!row || !tiers.some(tier=>tier.id===row.tier_id) ||
          (row.guessed_gifter_id!==null && (row.guessed_gifter_id===me.pid || !people.some(p=>p.id===row.guessed_gifter_id)))) {
        return {status:400,error:'Choose another participant from this event for each gift tier.'};
      }
    }
    const existing=db.prepare('SELECT * FROM gifter_guesses WHERE event_id=? AND participant_id=?').all(me.event_id,me.pid);
    const proposed=new Map(existing.map(row=>[row.tier_id,row.guessed_gifter_id]));
    for(const row of submitted) {
      if(row.guessed_gifter_id===null) proposed.delete(row.tier_id);
      else proposed.set(row.tier_id,row.guessed_gifter_id);
    }
    if(tiers.length<=people.length-1 && new Set(proposed.values()).size!==proposed.size) {
      return {status:400,error:'Choose different gifters for your gift tiers.'};
    }
    const timestamp=now();
    for (const row of submitted) {
      const old=existing.find(guess=>guess.tier_id===row.tier_id);
      if(row.guessed_gifter_id===null) {
        db.prepare('DELETE FROM gifter_guesses WHERE event_id=? AND participant_id=? AND tier_id=?').run(me.event_id,me.pid,row.tier_id);
      } else if(old?.guessed_gifter_id!==row.guessed_gifter_id) {
        db.prepare(`INSERT INTO gifter_guesses(event_id,participant_id,tier_id,guessed_gifter_id,edited_at) VALUES(?,?,?,?,?)
          ON CONFLICT(event_id,participant_id,tier_id) DO UPDATE SET guessed_gifter_id=excluded.guessed_gifter_id,edited_at=excluded.edited_at`)
          .run(me.event_id,me.pid,row.tier_id,row.guessed_gifter_id,timestamp);
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
