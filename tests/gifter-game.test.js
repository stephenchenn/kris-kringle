const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const path=require('node:path');
const {startServer}=require('./support/server');

async function ready(now='2026-12-24T00:00:00Z'){
 const server=await startServer({now,adminEmail:'alex@example.test'});const seeded=await server.seed();
 for(const p of seeded.people){const result=await server.request('POST','/api/draw',{token:p.token});assert.equal(result.status,200);p.id=(await server.request('GET',`/api/me?token=${p.token}`)).data.me.id;}
 return {server,seeded};
}
const get=(server,p)=>server.request('GET',`/api/wishlist/guesses?token=${p.token}`);
const save=(server,p,guesses,extra={})=>server.request('PUT','/api/wishlist/guesses',{token:p.token,guesses,...extra});
function answers(server,seeded,p){
 const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
 try{return db.prepare('SELECT recipient_id,tier_id,giver_id guessed_gifter_id FROM assignments WHERE event_id=? AND recipient_id=?').all(seeded.event.id,p.id);}
 finally{db.close();}
}

test('guesses are public, tier-specific and validated without exposing answers before the reveal',async t=>{
 const {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 const {people}=seeded,p=people[0],q=people[1],tiers=seeded.event.tiers;
 const initial=await get(server,p);assert.equal(initial.status,200);assert.equal(initial.data.phase,'open');
 assert.equal(initial.data.locks_at,'2026-12-24T13:30:00.000Z');assert.equal(initial.data.published_at,null);
 assert.equal(initial.data.rows.length,5);
 assert(!JSON.stringify(initial.data).includes('actual_gifter'));assert(!JSON.stringify(initial.data).includes('correct_count'));
 assert.equal((await get(server,{token:'invalid'})).status,401);
 const other=await server.seed({eventName:'Other family'});
 const otherToken=other.people[0].token;
 assert.equal((await get(server,{token:otherToken})).status,403);
 const wrongPerson=(await server.request('GET',`/api/me?token=${otherToken}`)).data.me.id;
 const invalid=[null,[],[{recipient_id:p.id,tier_id:tiers[0].id,guessed_gifter_id:p.id}],
  [{recipient_id:p.id,tier_id:tiers[0].id,guessed_gifter_id:wrongPerson}],
  [{recipient_id:p.id,tier_id:other.event.tiers[0].id,guessed_gifter_id:q.id}],
  [{recipient_id:p.id,tier_id:tiers[0].id,guessed_gifter_id:q.id},{recipient_id:p.id,tier_id:tiers[0].id,guessed_gifter_id:people[2].id}],
  tiers.map(tier=>({recipient_id:p.id,tier_id:tier.id,guessed_gifter_id:q.id}))];
 for(const guesses of invalid)assert.equal((await save(server,p,guesses)).status,400);
 const valid=answers(server,seeded,p);
 const saved=await save(server,p,valid,{participant_id:q.id,edited_at:'2000-01-01T00:00:00Z'});
 assert.equal(saved.status,200);
 const own=saved.data.rows.find(row=>row.participant.id===p.id);
 assert(own.guesses.filter(g=>g.guessed_gifter_id).every(g=>g.edited_at==='2026-12-24T00:00:00.000Z'),'server supplies timestamps');
 assert(saved.data.rows.find(row=>row.participant.id===q.id).guesses.every(g=>!g.guessed_gifter_id),'cannot edit somebody else’s guesses');
 const publicView=await get(server,q);
 assert.deepEqual(publicView.data.rows.find(row=>row.participant.id===p.id),own);
 assert(!JSON.stringify(publicView.data).includes('actual_gifter'));
 for(const person of people)assert(!JSON.stringify(publicView.data).includes(person.token));
 const clear=await save(server,p,[{recipient_id:p.id,tier_id:valid[0].tier_id,guessed_gifter_id:null}]);assert.equal(clear.status,200);
 assert.equal(clear.data.rows.find(row=>row.participant.id===p.id).guesses.filter(g=>g.guessed_gifter_id).length,1);
});

test('unchanged guesses preserve time, changes update only that tier, and event-day edits are locked',async t=>{
 let {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 const p=seeded.people[0],actual=answers(server,seeded,p);
 const first=(await save(server,p,actual)).data.rows.find(row=>row.participant.id===p.id);
 const restart=async now=>{const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now,adminEmail:'alex@example.test'});};
 await restart('2026-12-24T01:00:00Z');
 const repeated=(await save(server,p,actual)).data.rows.find(row=>row.participant.id===p.id);assert.deepEqual(repeated,first);
 const replacement=seeded.people.find(person=>person.id!==p.id && !actual.some(guess=>guess.guessed_gifter_id===person.id));
 const partial=(await save(server,p,[{recipient_id:p.id,tier_id:actual[0].tier_id,guessed_gifter_id:replacement.id}])).data.rows.find(row=>row.participant.id===p.id);
 assert.equal(partial.guesses.find(g=>g.recipient_id===p.id && g.tier_id===actual[0].tier_id).edited_at,'2026-12-24T01:00:00.000Z');
 assert.equal(partial.guesses.find(g=>g.recipient_id===p.id && g.tier_id===actual[1].tier_id).edited_at,'2026-12-24T00:00:00.000Z');
 // Swap the gifters so both remain distinct and only changed rows get new times.
 const swapped=actual.map((guess,i)=>({...guess,guessed_gifter_id:actual[1-i].guessed_gifter_id}));
 const updated=(await save(server,p,swapped)).data.rows.find(row=>row.participant.id===p.id);
 assert(updated.guesses.filter(g=>g.guessed_gifter_id).every(g=>g.edited_at==='2026-12-24T01:00:00.000Z'));
 await restart('2026-12-24T13:29:59.999Z');assert.equal((await save(server,p,actual)).status,200);
 await restart('2026-12-24T13:30:00Z');
 assert.equal((await save(server,p,swapped)).status,409);
 const locked=(await get(server,p)).data;assert.equal(locked.phase,'locked');
 assert(!JSON.stringify(locked).includes('actual_gifter'));assert(!JSON.stringify(locked).includes('correct_count'));
 await restart('2026-12-25T07:29:59.999Z');assert.equal((await get(server,p)).data.phase,'locked');
 await restart('2026-12-25T07:30:00Z');
 assert.equal((await get(server,p)).data.phase,'locked','scheduled time never publishes results');
 const published=await server.request('POST','/api/wishlist/guesses/publish',{token:p.token});
 assert.equal(published.status,200);assert.equal(published.data.phase,'results');
 assert.equal((await save(server,p,swapped)).status,409);
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
 const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now:'2026-12-25T07:30:00Z',adminEmail:'alex@example.test'});
 assert.equal((await server.request('POST','/api/wishlist/guesses/publish',{token:a.token})).status,200);
 const results=(await get(server,a)).data;assert.equal(results.phase,'results');
 const row=p=>results.rows.find(row=>row.participant.id===p.id);
 assert.equal(row(a).correct_count,2);assert.equal(row(b).correct_count,2);assert.equal(row(c).correct_count,2);
 assert.equal(row(a).average_correct_guess_ms,base);assert.equal(row(b).average_correct_guess_ms,base);
 assert.equal(row(a).rank,1);assert.equal(row(b).rank,1);assert.equal(row(c).rank,3);
 assert.equal(row(d).correct_count,1);assert.equal(row(d).rank,4);assert.equal(row(e).correct_count,0);assert.equal(row(e).rank,5);
 assert(row(a).guesses.filter(g=>g.guessed_gifter_id).every(g=>g.correct&&g.actual_gifter_name));
 const after=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
 try{assert.deepEqual(after.prepare('SELECT * FROM assignments ORDER BY id').all(),allocation);}finally{after.close();}
});

test('repeated gifters are allowed when there are more tiers than other participants; no date keeps guessing closed',async t=>{
 const server=await startServer({now:'2026-12-24T00:00:00Z'});t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed({participants:[{name:'One',email:'one@example.test'},{name:'Two',email:'two@example.test'}],
  tiers:[1,2,3].map(i=>({name:`Gift ${i}`,budgetCents:2000})),eventDate:null});
 const [p,q]=seeded.people;
 for(const person of seeded.people){await server.request('POST','/api/draw',{token:person.token});person.id=(await server.request('GET',`/api/me?token=${person.token}`)).data.me.id;}
 const guesses=seeded.event.tiers.map(tier=>({recipient_id:p.id,tier_id:tier.id,guessed_gifter_id:q.id}));
 assert.equal((await get(server,p)).data.phase,'unavailable');assert.equal((await save(server,p,guesses)).status,409);
 await server.request('POST','/api/admin/event/update',{secret:server.secret,eventId:seeded.event.id,eventDate:'2026-12-25T18:00:00+10:30'});
 assert.equal((await save(server,p,guesses)).status,200);
});

test('seven-person ballots have 12 guesses, exclude known outgoing gifts, and score every other recipient',async t=>{
 let server=await startServer({now:'2026-12-24T00:00:00Z',adminEmail:'a@example.test'});t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed({participants:['A','B','C','D','E','F','G'].map(name=>({name,email:`${name}@example.test`}))});
 for(const p of seeded.people){await server.request('POST','/api/draw',{token:p.token});p.id=(await server.request('GET',`/api/me?token=${p.token}`)).data.me.id;}
 const [p,q]=seeded.people;
 const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
 const allocation=db.prepare('SELECT recipient_id,tier_id,giver_id FROM assignments WHERE event_id=?').all(seeded.event.id);db.close();
 const initial=(await get(server,p)).data;
 assert.equal(initial.guess_count,12);assert.equal(initial.known_assignments.length,2);
 assert.deepEqual(initial.known_assignments.map(g=>`${g.recipient_id}:${g.tier_id}`).sort(),allocation.filter(g=>g.giver_id===p.id).map(g=>`${g.recipient_id}:${g.tier_id}`).sort());
 const valid=allocation.filter(g=>g.giver_id!==p.id).map(g=>({recipient_id:g.recipient_id,tier_id:g.tier_id,guessed_gifter_id:g.giver_id}));
 assert.equal((await save(server,p,valid)).status,200);
 // No answer oracle: a valid, consistent but wrong pick is accepted as a guess.
 const target=allocation.find(g=>g.giver_id!==q.id);
 const replacement=seeded.people.find(person=>person.id!==q.id && person.id!==target.recipient_id && person.id!==target.giver_id);
 assert.equal((await save(server,q,[{recipient_id:target.recipient_id,tier_id:target.tier_id,guessed_gifter_id:replacement.id}])).status,200);
 // A giver cannot be used twice in the same tier, even for different people.
 const qKnown=(await get(server,q)).data.known_assignments;
 const sameTier=seeded.event.tiers[0].id;
 const guessGiver=seeded.people.find(person=>person.id!==q.id);
 const recipients=seeded.people.filter(person=>person.id!==guessGiver.id && !qKnown.some(known=>known.recipient_id===person.id && known.tier_id===sameTier)).slice(0,2);
 const beforeRejected=(await get(server,q)).data.rows;
 assert.equal((await save(server,q,recipients.map(person=>({recipient_id:person.id,tier_id:sameTier,guessed_gifter_id:guessGiver.id})))).status,400);
 assert.deepEqual((await get(server,q)).data.rows,beforeRejected,'invalid batches do not partially overwrite a ballot');
 for(const known of initial.known_assignments)assert.equal((await save(server,p,[{...known,guessed_gifter_id:q.id}])).status,400);
 assert.equal((await save(server,p,[{...valid[0],guessed_gifter_id:valid[0].recipient_id}])).status,400);
 assert.equal((await save(server,p,[{...valid[0],guessed_gifter_id:p.id}])).status,400);
 const foreign=await server.seed({eventName:'Different event'});
 const foreignId=(await server.request('GET',`/api/me?token=${foreign.people[0].token}`)).data.me.id;
 assert.equal((await save(server,p,[{...valid[0],recipient_id:foreignId}])).status,400);
 // Public rows are identical for every viewer, with uniform unguessed blanks.
 const publicView=(await get(server,q)).data;
 assert.deepEqual(publicView.rows, (await get(server,p)).data.rows);
 assert(!JSON.stringify(publicView.rows).includes('excluded'));
 assert(!JSON.stringify(publicView.rows).includes('actual_gifter'));
 const next={directory:server.directory,secret:server.secret,now:'2026-12-25T07:30:00Z',adminEmail:'a@example.test'};await server.stop();server=await startServer(next);
 assert.equal((await server.request('POST','/api/wishlist/guesses/publish',{token:p.token})).status,200);
 const result=(await get(server,p)).data.rows.find(row=>row.participant.id===p.id);
 assert.equal(result.correct_count,12);assert.equal(result.possible_count,12);
 assert.equal(result.guesses.filter(g=>g.excluded).length,2);
});

test('legacy own-gifter guesses migrate to the same recipient with original picks and times',async t=>{
 let {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 const person=seeded.people[0],guess=answers(server,seeded,person)[0],timestamp=Date.parse('2026-12-20T00:00:00Z');
 const {directory,secret}=server;await server.stop();
 const db=new Database(path.join(directory,'db.sqlite'));
 db.exec(`DROP TABLE gifter_guesses; CREATE TABLE gifter_guesses (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES gift_tiers(id) ON DELETE CASCADE,
  guessed_gifter_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  edited_at INTEGER NOT NULL, PRIMARY KEY(event_id,participant_id,tier_id));`);
 db.prepare('INSERT INTO gifter_guesses VALUES(?,?,?,?,?)').run(seeded.event.id,person.id,guess.tier_id,guess.guessed_gifter_id,timestamp);db.close();
 server=await startServer({directory,secret,now:'2026-12-24T00:00:00Z'});
 const migrated=(await get(server,person)).data.rows.find(row=>row.participant.id===person.id).guesses.filter(g=>g.guessed_gifter_id);
 assert.equal(migrated.length,1);assert.equal(migrated[0].recipient_id,person.id);
 assert.equal(migrated[0].guessed_gifter_id,guess.guessed_gifter_id);assert.equal(Date.parse(migrated[0].edited_at),timestamp);
 const check=new Database(path.join(directory,'db.sqlite'),{readonly:true});assert.deepEqual(check.pragma('foreign_key_check'),[]);check.close();
});

test('only the drawn event admin can publish; publication is event-scoped, permanent, atomic and survives restarts',async t=>{
 let {server,seeded}=await ready();t.after(async()=>{await server.stop();server.remove();});
 const [admin,other]=seeded.people;
 const publish=(person,extra={})=>server.request('POST','/api/wishlist/guesses/publish',{token:person.token,...extra});
 const foreign=await server.seed({eventName:'Real family sentinel — must not change'});
 await server.request('POST','/api/draw',{token:foreign.people[1].token});
 await server.request('POST','/api/wishlist/item',{token:foreign.people[1].token,title:'Sentinel wish'});
 const snapshot=()=>{const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});try{
  return Object.fromEntries(['events','participants','gift_tiers','assignments','wishlists','wishlist_items'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().filter(row=>row.event_id===foreign.event.id||row.id===foreign.event.id||table==='wishlist_items')]));
 }finally{db.close();}};
 const before=snapshot();
 assert.equal((await publish({token:'invalid'})).status,401);
 assert.equal((await publish(other,{is_wishlist_admin:true,eventId:seeded.event.id})).status,403);
 const foreignAdmin=foreign.people.find(person=>person.name==='Alex');
 assert.equal((await publish(foreignAdmin)).status,403,'admin still needs to draw');
 const guesses=answers(server,seeded,admin);assert.equal((await save(server,admin,guesses)).status,200);
 const concurrent=await Promise.all([publish(admin,{eventId:foreign.event.id,published_at:'2000-01-01'}),save(server,other,answers(server,seeded,other))]);
 assert.equal(concurrent[0].status,200);assert([200,409].includes(concurrent[1].status));
 const result=concurrent[0].data;assert.equal(result.phase,'results');assert.equal(result.published_at,'2026-12-24T00:00:00.000Z');
 assert.equal(result.can_publish_results,true);assert.equal(result.event.id,seeded.event.id);
 assert.equal((await save(server,admin,guesses)).status,409);
 assert.equal((await get(server,other)).data.phase,'results');assert.equal((await get(server,other)).data.can_publish_results,false);
 assert.equal((await publish(admin)).data.published_at,result.published_at,'double click does not change publication time');
 assert.deepEqual(snapshot(),before,'publishing another event leaves the sentinel event untouched');
 const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now:'2026-12-23T00:00:00Z',adminEmail:'alex@example.test'});
 assert.equal((await get(server,other)).data.phase,'results','a restart or earlier clock cannot reopen published guesses');
 assert.equal((await publish(admin)).data.published_at,result.published_at);
 await server.request('POST','/api/admin/event/update',{secret:server.secret,eventId:seeded.event.id,eventDate:'2027-12-25T18:00:00+10:30'});
 assert.equal((await get(server,other)).data.phase,'results','moving the date cannot hide published answers or reopen edits');
 assert.equal((await save(server,admin,guesses)).status,409);
});
