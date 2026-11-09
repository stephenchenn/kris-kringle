const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const Database=require('better-sqlite3');
const path=require('node:path');
const {startServer}=require('./support/server');
const {installGiftFeatures}=require('../lib/gift-features');
const {eventSchedule}=require('../lib/event-time');

async function until(check){for(let i=0;i<150;i++){if(check())return;await delay(20);}assert.fail('Timed out waiting for captured email');}
async function drawPeople(server,people,skip){
 for(const person of people){
  const me=await server.request('GET',`/api/me?token=${person.token}`);person.id=me.data.me.id;
  if(person===skip)continue;
  const drawn=await server.request('POST','/api/draw',{token:person.token});person.recipients=drawn.data.recipients_by_tier;
 }
 await until(()=>server.emails().length===people.length-(skip?1:0));
}
const settings=(server,person)=>server.request('GET',`/api/wishlists/all?token=${person.token}`);
const preference=(server,person,owner,enabled)=>server.request('PUT',`/api/wishlist/recipients/${owner.id}/notifications`,{token:person.token,enabled});
const reminder=(server,person,owner)=>server.request('POST',`/api/wishlist/recipients/${owner.id}/remind`,{token:person.token});

test('notification subscriptions are recipient-specific, private, persistent and opt-in',async t=>{
 let server=await startServer();t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed(),people=seeded.people;await drawPeople(server,people);
 const owner=people[0],givers=people.filter(p=>p.recipients.some(r=>r.recipient===owner.name));
 const outsider=people.find(p=>p!==owner&&!givers.includes(p));
 assert.equal((await preference(server,owner,owner,true)).status,403);
 assert.equal((await preference(server,outsider,owner,true)).status,403);
 assert.equal((await preference(server,{token:'invalid'},owner,true)).status,401);
 assert.equal((await preference(server,givers[0],owner,'true')).status,400);
 const other=await server.seed({eventName:'Other family'});
 assert.equal((await preference(server,other.people[0],owner,true)).status,403);
 assert.equal((await settings(server,givers[0])).data.recipient_settings[owner.id].notifications_enabled,false);
 assert(!((await settings(server,owner)).data.recipient_settings[owner.id]));
 const add=async title=>server.request('POST','/api/wishlist/item',{token:owner.token,title,url:'https://shop.example.test/p?size=M&colour=blue',price_cents:2495,notes:'Blue, size M <please>',image_url:'https://cdn.example.test/tee.jpg'});
 await add('Before subscribing');assert.equal(server.emails().length,5);
 assert.equal((await preference(server,givers[0],owner,true)).status,200);
 await preference(server,givers[0],owner,true);assert.equal(server.emails().length,5);
 const created=await add('<img src=x onerror=alert(1)> Cotton tee');
 assert.equal(created.status,200);
 const notices=()=>server.emails().filter(mail=>mail.subject.includes('added a wishlist idea'));
 await until(()=>notices().length===1);
 const mail=notices()[0];assert.equal(mail.to[0].address,givers[0].email);
 assert(mail.text.includes('AUD')||mail.text.includes('$24.95'));
 assert(mail.text.includes('Blue, size M <please>'));
 assert(mail.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
 assert(!mail.html.includes('<img src=x onerror='));
 assert(mail.html.includes('https://cdn.example.test/tee.jpg'));
 assert(mail.text.includes(`/wishlists?token=${givers[0].token}`));
 for(const p of people.filter(p=>p!==givers[0]))assert(!mail.text.includes(p.token));
 await server.request('PUT',`/api/wishlist/item/${created.data.item.id}`,{token:owner.token,title:'Edited tee'});
 await delay(50);assert.equal(notices().length,1,'edits do not trigger new-item emails');
 await preference(server,givers[1],owner,true);await add('Second item');await until(()=>notices().length===3);
 await preference(server,givers[0],owner,false);await preference(server,givers[1],owner,false);
 await add('After disabling');await delay(50);assert.equal(notices().length,3);
 await preference(server,givers[0],owner,true);
 const {directory,secret}=server;await server.stop();server=await startServer({directory,secret});
 assert.equal((await settings(server,givers[0])).data.recipient_settings[owner.id].notifications_enabled,true);
 await add('After restart');await until(()=>notices().length===4);
});

test('two anonymous nudges per recipient share a rolling 24-hour quota across gifters and restarts',async t=>{
 const start='2026-11-10T00:00:00Z';
 let server=await startServer({now:start});t.after(async()=>{await server.stop();server.remove();});
 const {people}=await server.seed();const owner=people[0];await drawPeople(server,people,owner);
 const givers=people.filter(p=>p.recipients?.some(r=>r.recipient===owner.name));
 const outsider=people.find(p=>p!==owner&&!givers.includes(p));
 assert.equal((await reminder(server,outsider,owner)).status,403);
 assert.equal((await reminder(server,owner,owner)).status,403,'undrawn participants cannot send reminders');
 const race=await Promise.all(givers.map(person=>reminder(server,person,owner)));
 assert.deepEqual(race.map(r=>r.status).sort(),[202,202]);
 assert.equal((await reminder(server,givers[0],owner)).status,429);
 const notices=()=>server.emails().filter(mail=>mail.subject.startsWith('A little wishlist nudge'));
 await until(()=>notices().length===2);
 const mail=notices()[0];assert.equal(mail.to[0].address,owner.email);
 assert(mail.text.includes(`/wishlists?token=${owner.token}`));
 for(const giver of givers){assert(!mail.text.includes(giver.name));assert(!mail.text.includes(giver.token));}
 const preference=(await settings(server,givers[1])).data.recipient_settings[owner.id];assert.equal(preference.can_remind,false);
 const restart=async now=>{const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now});};
 await restart('2026-11-10T23:59:59Z');
 const early=await reminder(server,givers[1],owner);assert.equal(early.status,429);assert.equal(early.headers.get('retry-after'),'1');
 await restart('2026-11-11T00:00:00Z');
 assert.equal((await reminder(server,givers[1],owner)).status,202);
 await until(()=>notices().length===3);
});

test('nudge messages are optional, validated, escaped and never include the requesting gifter',async t=>{
 const server=await startServer();t.after(async()=>{await server.stop();server.remove();});
 const {people}=await server.seed();await drawPeople(server,people);const owner=people[0];
 const giver=people.find(p=>p.recipients.some(r=>r.recipient===owner.name));
 const send=message=>server.request('POST',`/api/wishlist/recipients/${owner.id}/remind`,{token:giver.token,message});
 for(const message of [42,{},'x'.repeat(501)])assert.equal((await send(message)).status,400);
 assert.equal((await settings(server,giver)).data.recipient_settings[owner.id].reminders_remaining,2);
 const note='Please add a few ideas! <script>alert(1)</script>\nDifferent price ranges would help.';
 assert.equal((await send(note)).status,202);
 const notices=()=>server.emails().filter(mail=>mail.subject.startsWith('A little wishlist nudge'));
 await until(()=>notices().length===1);const mail=notices()[0];
 assert(mail.text.includes(note));assert(mail.html.includes('&lt;script&gt;'));assert(!mail.html.includes('<script>'));
 assert(!JSON.stringify(mail).includes(giver.token));assert(!mail.text.includes(giver.name));
 assert.equal((await settings(server,giver)).data.recipient_settings[owner.id].reminders_remaining,1);
 assert.equal((await reminder(server,giver,owner)).status,202);await until(()=>notices().length===2);
 assert(!notices()[1].text.includes('Their anonymous message'));
 assert.equal((await settings(server,giver)).data.recipient_settings[owner.id].reminders_remaining,0);
});

test('email jobs survive restart, retry failures and respect disabling pending notifications',async t=>{
 const server=await startServer();const {people}=await server.seed();await drawPeople(server,people);
 const owner=people[0],giver=people.find(p=>p.recipients.some(r=>r.recipient===owner.name));
 const item=(await server.request('POST','/api/wishlist/item',{token:owner.token,title:'Durable gift',price_cents:2000})).data.item;
 await server.stop();
 const db=new Database(path.join(server.directory,'db.sqlite'));
 let worker;
 t.after(async()=>{await worker?.stop();db.close();server.remove();});
 const eventId=db.prepare('SELECT event_id FROM participants WHERE id=?').get(owner.id).event_id;
 db.prepare('INSERT INTO wishlist_subscriptions(event_id,giver_id,owner_id,enabled) VALUES(?,?,?,1)').run(eventId,giver.id,owner.id);
 let clock=Date.parse('2026-11-10T00:00:00Z');const delivered=[];
 const options={app:{put(){},post(){}},db,fromEmail:'test@example.test',requireMeByToken:()=>null,
   publicBaseUrl:()=> 'http://localhost:3000',escapeHtml:String,now:()=>clock};
 worker=installGiftFeatures({...options,transporter:{async sendMail(){throw new Error('Temporary SMTP failure');}}});
 worker.enqueueWishlistItem({event_id:eventId,pid:owner.id},item);await worker.flushEmails();
 const pending=db.prepare('SELECT * FROM gift_email_jobs').get();
 assert.equal(pending.status,'pending');assert.equal(pending.attempts,1);assert.equal(pending.available_at,clock+30000);
 await worker.stop();clock+=30001;
 worker=installGiftFeatures({...options,transporter:{async sendMail(mail){delivered.push(mail);}}});
 await worker.flushEmails();assert.equal(delivered.length,1);
 assert.equal(db.prepare('SELECT status FROM gift_email_jobs WHERE id=?').get(pending.id).status,'sent');
 assert(delivered[0].text.includes('Durable gift'));
 worker.enqueueWishlistItem({event_id:eventId,pid:owner.id},item);
 db.prepare('UPDATE wishlist_subscriptions SET enabled=0').run();
 await worker.flushEmails();assert.equal(delivered.length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM gift_email_jobs WHERE status='cancelled'").get().n,1);
});

test('event schedule uses Adelaide midnight and handles DST, date-only and missing dates',()=>{
 const event={event_date:'2026-12-25T18:00:00+10:30'};
 const schedule=eventSchedule(event,Date.parse('2026-12-24T13:29:59.999Z'));
 assert.equal(schedule.phase,'open');assert.equal(schedule.locks_at,'2026-12-24T13:30:00.000Z');assert.equal(schedule.published_at,null);
 assert.equal(eventSchedule(event,Date.parse(schedule.locks_at)).phase,'locked');
 assert.equal(eventSchedule(event,Date.parse('2026-12-26T07:30:00Z')).phase,'locked');
 assert.equal(eventSchedule({...event,gifter_results_published_at:Date.parse('2026-12-25T06:00:00Z')},Date.parse('2026-12-25T06:00:00Z')).phase,'results');
 assert.equal(eventSchedule({event_date:'2026-07-25T18:00:00+09:30'},0).locks_at,'2026-07-24T14:30:00.000Z');
 assert.equal(eventSchedule({event_date:'2026-12-25'},Date.parse('2026-12-27T00:00:00Z')).phase,'locked');
 assert.equal(eventSchedule({},0).phase,'unavailable');assert.equal(eventSchedule({event_date:'bad-date'},0).phase,'unavailable');
});

test('new tables migrate an existing event without changing allocations, tokens or wishlist items',async t=>{
 let server=await startServer();t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed();await drawPeople(server,seeded.people);
 const owner=seeded.people[0];await server.request('POST','/api/wishlist/item',{token:owner.token,title:'Existing wish'});
 const {directory,secret}=server;await server.stop();
 const legacy=new Database(path.join(directory,'db.sqlite'));
 const beforePeople=legacy.prepare('SELECT * FROM participants ORDER BY id').all();
 const beforeAssignments=legacy.prepare('SELECT * FROM assignments ORDER BY id').all();
 const beforeItems=legacy.prepare('SELECT * FROM wishlist_items ORDER BY id').all();
 legacy.exec('DROP TABLE wishlist_reminders; DROP TABLE gift_email_jobs; DROP TABLE wishlist_subscriptions; DROP TABLE gifter_guesses; ALTER TABLE events DROP COLUMN event_timezone;');legacy.close();
 server=await startServer({directory,secret});
 const current=new Database(path.join(directory,'db.sqlite'),{readonly:true});
 try{
  assert.deepEqual(current.prepare('SELECT * FROM participants ORDER BY id').all(),beforePeople);
  assert.deepEqual(current.prepare('SELECT * FROM assignments ORDER BY id').all(),beforeAssignments);
  assert.deepEqual(current.prepare('SELECT * FROM wishlist_items ORDER BY id').all(),beforeItems);
  assert.equal(current.prepare('SELECT event_timezone FROM events WHERE id=?').get(seeded.event.id).event_timezone,'Australia/Adelaide');
  assert.deepEqual(current.pragma('foreign_key_check'),[]);assert.equal(current.pragma('integrity_check',{simple:true}),'ok');
  assert.equal((await server.request('GET',`/api/wishlists/all?token=${owner.token}`)).status,200);
 }finally{current.close();}
});
