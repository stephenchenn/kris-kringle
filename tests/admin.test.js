const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const path=require('node:path');
const {startServer}=require('./support/server');
async function login(server){
 const result=await server.request('POST','/api/admin/session',{secret:server.secret});assert.equal(result.status,200);
 assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=Strict/);
 assert.match(result.headers.get('cache-control'),/no-store/);assert(!JSON.stringify(result.data).includes(server.secret));
 return {Cookie:result.headers.get('set-cookie').split(';')[0],'X-Admin-CSRF':result.data.csrf};
}
const config=()=>({requestKey:randomUUID(),eventName:'New family event',eventDate:'2026-12-25',location:'Home',
 participants:['One','Two','Three'].map(name=>({name,email:name+'@example.test'})),
 tiers:[{name:'BIG GIFT',budgetCents:5000},{name:'small gift',budgetCents:2000}]});

test('admin sessions protect event data and writes, reject CSRF, and revoke on sign-out or restart',async t=>{
 let server=await startServer({adminEmail:'alex@example.test'});t.after(async()=>{await server.stop();server.remove();});
 const family=await server.seed();await server.request('POST','/api/draw',{token:family.people[0].token});
 assert.equal((await server.request('GET','/api/admin/events')).status,401);
 assert.equal((await server.request('GET','/api/admin/events?token='+family.people[0].token)).status,401,'wishlist admin is not global admin');
 assert.equal((await server.request('POST','/api/admin/session',{secret:'wrong'})).status,403);
 assert.equal((await server.request('POST','/api/admin/session',{secret:server.secret},{Origin:'https://evil.example'})).status,403);
 const headers=await login(server);
 assert.equal((await server.request('POST','/api/admin/events',config(),{Cookie:headers.Cookie})).status,403);
 assert.equal((await server.request('POST','/api/admin/events',config(),{...headers,Origin:'https://evil.example'})).status,403);
 assert.equal((await server.request('POST','/api/admin/send-invites',{eventId:family.event.id},{Cookie:headers.Cookie})).status,403);
 assert.equal((await server.request('POST','/api/admin/send-invites',{},headers)).status,400);
 assert.equal((await server.request('POST','/api/admin/reset',{},headers)).status,403,'web session cannot invoke database reset');
 assert.equal((await server.request('GET','/api/admin/events',undefined,headers)).data.events.length,1);
 assert.equal((await server.request('DELETE','/api/admin/session',undefined,headers)).status,200);
 assert.equal((await server.request('GET','/api/admin/events',undefined,headers)).status,401);
 const next=await login(server);const {directory,secret}=server;await server.stop();server=await startServer({directory,secret});
 assert.equal((await server.request('GET','/api/admin/events',undefined,next)).status,401);
});

test('web admin creates idempotently, configures and invites selected people without touching another event',async t=>{
 const server=await startServer();t.after(async()=>{await server.stop();server.remove();});
 const family=await server.seed();await server.request('POST','/api/draw',{token:family.people[0].token});
 await server.request('POST','/api/wishlist/item',{token:family.people[0].token,title:'Family keepsake'});
 const snapshot=()=>{const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});try{return JSON.stringify({
  event:db.prepare('SELECT * FROM events WHERE id=?').get(family.event.id),
  people:db.prepare('SELECT * FROM participants WHERE event_id=? ORDER BY id').all(family.event.id),
  allocations:db.prepare('SELECT * FROM assignments WHERE event_id=? ORDER BY id').all(family.event.id),
  wishes:db.prepare('SELECT * FROM wishlist_items ORDER BY id').all(),
 });}finally{db.close();}};
 const before=snapshot(),headers=await login(server),body=config();
 const create=()=>server.request('POST','/api/admin/events',body,headers);
 const created=await create();assert.equal(created.status,200);const id=created.data.event.id;
 const repeated=await create();assert.equal(repeated.status,200);assert.equal(repeated.data.event.id,id);assert.equal(repeated.data.reused,true);
 assert.equal((await server.request('POST','/api/admin/events',{...body,eventName:'Accidentally changed'},headers)).status,409);
 assert.equal((await server.request('POST','/api/admin/events',{...body,requestKey:randomUUID(),eventDate:'2026-02-30'},headers)).status,400);
 const listing=await server.request('GET','/api/admin/events',undefined,headers);assert.equal(listing.data.events.length,2);
 const detail=(await server.request('GET','/api/admin/events/'+id,undefined,headers)).data;
 assert.equal(detail.participants.length,3);assert(detail.participants.every(p=>!p.has_drawn&&p.invitation_sent_at===null));
 const countBefore=server.emails().length;
 const foreignId=(await server.request('GET','/api/me?token='+family.people[0].token)).data.me.id;
 assert.equal((await server.request('POST','/api/admin/send-invites',{eventId:id,participantIds:[foreignId]},headers)).status,400);
 assert.equal(server.emails().length,countBefore);
 const chosen=detail.participants.slice(0,2);
 const delivered=await server.request('POST','/api/admin/send-invites',{eventId:id,participantIds:chosen.map(p=>p.id)},headers);
 assert.equal(delivered.status,200);assert.equal(delivered.data.sent,2);assert.equal(server.emails().length,countBefore+2);
 const status=(await server.request('GET','/api/admin/events/'+id,undefined,headers)).data;
 assert.equal(status.participants.filter(p=>p.invitation_sent_at).length,2);
 const person=chosen[0],token=new URL(person.draw_link).searchParams.get('token');await server.request('POST','/api/draw',{token});
 const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});const assignments=db.prepare('SELECT * FROM assignments WHERE event_id=? ORDER BY id').all(id);db.close();
 const changed=await server.request('PUT','/api/admin/events/'+id,{eventName:'Updated event',eventDate:'2026-12-26',location:'New location',
  tiers:detail.event.tiers.map(tier=>({id:tier.id,name:tier.name,budgetCents:2500}))},headers);
 assert.equal(changed.status,200);assert(changed.data.event.tiers.every(tier=>tier.budget_cents===2500));
 const current=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
 assert.deepEqual(current.prepare('SELECT * FROM assignments WHERE event_id=? ORDER BY id').all(id),assignments);
 assert.equal(current.prepare('SELECT has_drawn FROM participants WHERE id=?').get(person.id).has_drawn,1);
 assert.deepEqual(current.pragma('foreign_key_check'),[]);current.close();assert.equal(snapshot(),before);
});

test('admin login limits repeated wrong secrets',async t=>{
 const server=await startServer();t.after(async()=>{await server.stop();server.remove();});
 for(let i=0;i<10;i++)assert.equal((await server.request('POST','/api/admin/session',{secret:'wrong'})).status,403);
 const limited=await server.request('POST','/api/admin/session',{secret:'wrong'});assert.equal(limited.status,429);assert(Number(limited.headers.get('retry-after'))>0);
});
