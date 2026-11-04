const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const path=require('node:path');
const {startServer}=require('./support/server');

async function ready(now='2026-12-24T00:00:00Z'){
 const server=await startServer({now});const seeded=await server.seed();
 for(const p of seeded.people){const result=await server.request('POST','/api/draw',{token:p.token});assert.equal(result.status,200);p.id=(await server.request('GET',`/api/me?token=${p.token}`)).data.me.id;}
 return {server,seeded};
}
const get=(server,p)=>server.request('GET',`/api/wishlist/guesses?token=${p.token}`);
const save=(server,p,guesses,extra={})=>server.request('PUT','/api/wishlist/guesses',{token:p.token,guesses,...extra});
function answers(server,seeded,p){
 const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
 try{return db.prepare('SELECT tier_id,giver_id guessed_gifter_id FROM assignments WHERE event_id=? AND recipient_id=?').all(seeded.event.id,p.id);}
 finally{db.close();}
}

test('guesses are public, tier-specific and validated without exposing answers before the reveal',async t=>{
 const {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 const {people}=seeded,p=people[0],q=people[1],tiers=seeded.event.tiers;
 const initial=await get(server,p);assert.equal(initial.status,200);assert.equal(initial.data.phase,'open');
 assert.equal(initial.data.locks_at,'2026-12-24T13:30:00.000Z');assert.equal(initial.data.reveals_at,'2026-12-25T07:30:00.000Z');
 assert.equal(initial.data.rows.length,5);
 assert(!JSON.stringify(initial.data).includes('actual_gifter'));assert(!JSON.stringify(initial.data).includes('correct_count'));
 assert.equal((await get(server,{token:'invalid'})).status,401);
 const other=await server.seed({eventName:'Other family'});
 const otherToken=other.people[0].token;
 assert.equal((await get(server,{token:otherToken})).status,403);
 const wrongPerson=(await server.request('GET',`/api/me?token=${otherToken}`)).data.me.id;
 const invalid=[null,[],[{tier_id:tiers[0].id,guessed_gifter_id:p.id}],
  [{tier_id:tiers[0].id,guessed_gifter_id:wrongPerson}],
  [{tier_id:other.event.tiers[0].id,guessed_gifter_id:q.id}],
  [{tier_id:tiers[0].id,guessed_gifter_id:q.id},{tier_id:tiers[0].id,guessed_gifter_id:people[2].id}],
  tiers.map(tier=>({tier_id:tier.id,guessed_gifter_id:q.id}))];
 for(const guesses of invalid)assert.equal((await save(server,p,guesses)).status,400);
 const valid=answers(server,seeded,p);
 const saved=await save(server,p,valid,{participant_id:q.id,edited_at:'2000-01-01T00:00:00Z'});
 assert.equal(saved.status,200);
 const own=saved.data.rows.find(row=>row.participant.id===p.id);
 assert(own.guesses.every(g=>g.edited_at==='2026-12-24T00:00:00.000Z'),'server supplies timestamps');
 assert(saved.data.rows.find(row=>row.participant.id===q.id).guesses.every(g=>!g.guessed_gifter_id),'cannot edit somebody else’s guesses');
 const publicView=await get(server,q);
 assert.deepEqual(publicView.data.rows.find(row=>row.participant.id===p.id),own);
 assert(!JSON.stringify(publicView.data).includes('actual_gifter'));
 for(const person of people)assert(!JSON.stringify(publicView.data).includes(person.token));
 const clear=await save(server,p,[{tier_id:valid[0].tier_id,guessed_gifter_id:null}]);assert.equal(clear.status,200);
 assert.equal(clear.data.rows.find(row=>row.participant.id===p.id).guesses.filter(g=>g.guessed_gifter_id).length,1);
});

test('unchanged guesses preserve time, changes update only that tier, and event-day edits are locked',async t=>{
 let {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 const p=seeded.people[0],actual=answers(server,seeded,p);
 const first=(await save(server,p,actual)).data.rows.find(row=>row.participant.id===p.id);
 const restart=async now=>{const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now});};
 await restart('2026-12-24T01:00:00Z');
 const repeated=(await save(server,p,actual)).data.rows.find(row=>row.participant.id===p.id);assert.deepEqual(repeated,first);
 const replacement=seeded.people.find(person=>person.id!==p.id && !actual.some(guess=>guess.guessed_gifter_id===person.id));
 const partial=(await save(server,p,[{tier_id:actual[0].tier_id,guessed_gifter_id:replacement.id}])).data.rows.find(row=>row.participant.id===p.id);
 assert.equal(partial.guesses.find(g=>g.tier_id===actual[0].tier_id).edited_at,'2026-12-24T01:00:00.000Z');
 assert.equal(partial.guesses.find(g=>g.tier_id===actual[1].tier_id).edited_at,'2026-12-24T00:00:00.000Z');
 // Swap the gifters so both remain distinct and only changed rows get new times.
 const swapped=actual.map((guess,i)=>({...guess,guessed_gifter_id:actual[1-i].guessed_gifter_id}));
 const updated=(await save(server,p,swapped)).data.rows.find(row=>row.participant.id===p.id);
 assert(updated.guesses.every(g=>g.edited_at==='2026-12-24T01:00:00.000Z'));
 await restart('2026-12-24T13:29:59.999Z');assert.equal((await save(server,p,actual)).status,200);
 await restart('2026-12-24T13:30:00Z');
 assert.equal((await save(server,p,swapped)).status,409);
 const locked=(await get(server,p)).data;assert.equal(locked.phase,'locked');
 assert(!JSON.stringify(locked).includes('actual_gifter'));assert(!JSON.stringify(locked).includes('correct_count'));
 await restart('2026-12-25T07:29:59.999Z');assert.equal((await get(server,p)).data.phase,'locked');
 await restart('2026-12-25T07:30:00Z');
 assert.equal((await get(server,p)).data.phase,'results');assert.equal((await save(server,p,swapped)).status,409);
});

test('leaderboard ranks by correct tiers, average last-edit time and shared ranks for exact ties',async t=>{
 let {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 for(const p of seeded.people.slice(0,4))await save(server,p,answers(server,seeded,p));
 const db=new Database(path.join(server.directory,'db.sqlite'));
 const base=Date.parse('2026-12-24T00:00:00Z');
 const [a,b,c,d,e]=seeded.people;
 const update=db.prepare('UPDATE gifter_guesses SET edited_at=? WHERE participant_id=?');
 update.run(base,b.id);update.run(base+1,c.id);update.run(base-100000,d.id);
 const aGuesses=db.prepare('SELECT tier_id FROM gifter_guesses WHERE participant_id=?').all(a.id);
 db.prepare('UPDATE gifter_guesses SET edited_at=? WHERE participant_id=? AND tier_id=?').run(base-10000,a.id,aGuesses[0].tier_id);
 db.prepare('UPDATE gifter_guesses SET edited_at=? WHERE participant_id=? AND tier_id=?').run(base+10000,a.id,aGuesses[1].tier_id);
 const dGuesses=db.prepare('SELECT tier_id FROM gifter_guesses WHERE participant_id=?').all(d.id);
 db.prepare('DELETE FROM gifter_guesses WHERE participant_id=? AND tier_id=?').run(d.id,dGuesses[0].tier_id);
 const allocation=db.prepare('SELECT * FROM assignments ORDER BY id').all();db.close();
 const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now:'2026-12-25T07:30:00Z'});
 const results=(await get(server,a)).data;assert.equal(results.phase,'results');
 const row=p=>results.rows.find(row=>row.participant.id===p.id);
 assert.equal(row(a).correct_count,2);assert.equal(row(b).correct_count,2);assert.equal(row(c).correct_count,2);
 assert.equal(row(a).average_correct_guess_ms,base);assert.equal(row(b).average_correct_guess_ms,base);
 assert.equal(row(a).rank,1);assert.equal(row(b).rank,1);assert.equal(row(c).rank,3);
 assert.equal(row(d).correct_count,1);assert.equal(row(d).rank,4);assert.equal(row(e).correct_count,0);assert.equal(row(e).rank,5);
 assert(row(a).guesses.every(g=>g.correct&&g.actual_gifter_name));
 const after=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
 try{assert.deepEqual(after.prepare('SELECT * FROM assignments ORDER BY id').all(),allocation);}finally{after.close();}
});

test('repeated gifters are allowed when there are more tiers than other participants; no date keeps guessing closed',async t=>{
 const server=await startServer({now:'2026-12-24T00:00:00Z'});t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed({participants:[{name:'One',email:'one@example.test'},{name:'Two',email:'two@example.test'}],
  tiers:[1,2,3].map(i=>({name:`Gift ${i}`,budgetCents:2000})),eventDate:null});
 const [p,q]=seeded.people;
 for(const person of seeded.people){await server.request('POST','/api/draw',{token:person.token});person.id=(await server.request('GET',`/api/me?token=${person.token}`)).data.me.id;}
 const guesses=seeded.event.tiers.map(tier=>({tier_id:tier.id,guessed_gifter_id:q.id}));
 assert.equal((await get(server,p)).data.phase,'unavailable');assert.equal((await save(server,p,guesses)).status,409);
 await server.request('POST','/api/admin/event/update',{secret:server.secret,eventId:seeded.event.id,eventDate:'2026-12-25T18:00:00+10:30'});
 assert.equal((await save(server,p,guesses)).status,200);
});
