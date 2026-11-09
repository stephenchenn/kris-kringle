const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {startServer}=require('./support/server');
const Database=require('better-sqlite3');
const path=require('node:path');
const {installGiftFeatures}=require('../lib/gift-features');
async function until(check){for(let i=0;i<150;i++){if(check())return;await delay(20);}assert.fail('Timed out waiting for reservation email');}

test('reservation alerts reach only other gifters; deletion reaches only the reserver, independently of bells',async t=>{
 const server=await startServer();t.after(async()=>{await server.stop();server.remove();});
 const {people}=await server.seed({participants:['A','B','C','D','E','F'].map(name=>({name,email:name+'@example.test'})),
  tiers:[{name:'Big',budgetCents:5000},{name:'Small',budgetCents:2000},{name:'Tiny',budgetCents:1000}]});
 for(const p of people){p.id=(await server.request('GET',`/api/me?token=${p.token}`)).data.me.id;
  p.recipients=(await server.request('POST','/api/draw',{token:p.token})).data.recipients_by_tier;}
 const owner=people[0],givers=people.filter(p=>p.recipients.some(r=>r.recipient===owner.name));
 const outsiders=people.filter(p=>p!==owner&&!givers.includes(p));assert.equal(givers.length,3);
 const add=async title=>(await server.request('POST','/api/wishlist/item',{token:owner.token,title})).data.item;
 const act=(person,item,verb)=>server.request('POST',`/api/wishlist/item/${item.id}/${verb}`,{token:person.token});
 const title='Gift <b>blue</b>',item=await add(title);
 assert.equal((await act(outsiders[0],item,'reserve')).status,403);
 assert.equal((await act(owner,item,'reserve')).status,400);
 assert.equal((await act(givers[0],item,'reserve')).status,200);
 assert.equal((await act(givers[0],item,'reserve')).status,200,'repeat reserve is idempotent');
 assert.equal((await act(givers[1],item,'reserve')).status,409);
 const notices=()=>server.emails().filter(mail=>mail.subject.startsWith('Reserve soon!'));
 await until(()=>notices().length===2);await delay(50);assert.equal(notices().length,2);
 assert.deepEqual(notices().map(mail=>mail.to[0].address).sort(),givers.slice(1).map(p=>p.email.toLowerCase()).sort());
 for(const mail of notices()){
  assert(mail.text.includes(title));assert(mail.html.includes('&lt;b&gt;blue&lt;/b&gt;'));
  const recipient=givers.find(p=>p.email.toLowerCase()===mail.to[0].address);
  assert(mail.text.includes('/wishlists?token='+recipient.token));
  for(const other of people.filter(p=>p!==recipient))assert(!JSON.stringify(mail).includes(other.token));
  assert(!mail.text.includes('Hi '+givers[0].name+','));
 }
 assert.equal((await server.request('DELETE',`/api/wishlist/item/${item.id}`,{token:outsiders[0].token})).status,403);
 const deleted=await server.request('DELETE',`/api/wishlist/item/${item.id}`,{token:owner.token});
 assert.deepEqual(deleted.data,{ok:true},'owner response never reveals a reservation');
 const removals=()=>server.emails().filter(mail=>mail.subject.startsWith('A gift you reserved was removed'));
 await until(()=>removals().length===1);
 assert.equal(removals()[0].to[0].address,givers[0].email.toLowerCase());assert(removals()[0].text.includes(title));
 assert(removals()[0].text.includes('/wishlists?token='+givers[0].token));
 assert.equal((await server.request('DELETE',`/api/wishlist/item/${item.id}`,{token:owner.token})).status,404);
 const unreserved=await add('Not reserved');await server.request('DELETE',`/api/wishlist/item/${unreserved.id}`,{token:owner.token});
 const released=await add('Released before deletion');await act(givers[0],released,'reserve');await act(givers[0],released,'unreserve');
 await server.request('DELETE',`/api/wishlist/item/${released.id}`,{token:owner.token});
 await delay(100);assert.equal(removals().length,1,'unreserved deletions send no alert');
});

test('a deleted-item alert survives SMTP failure and restart; stale reservation alerts are cancelled',async t=>{
 const server=await startServer();const {people,event}=await server.seed();
 for(const p of people){p.id=(await server.request('GET',`/api/me?token=${p.token}`)).data.me.id;
  p.recipients=(await server.request('POST','/api/draw',{token:p.token})).data.recipients_by_tier;}
 const owner=people[0],giver=people.find(p=>p.recipients.some(r=>r.recipient===owner.name));
 const item=(await server.request('POST','/api/wishlist/item',{token:owner.token,title:'Removed gift'})).data.item;
 await server.stop();const db=new Database(path.join(server.directory,'db.sqlite'));
 let worker,clock=Date.parse('2026-11-09T00:00:00Z');const delivered=[];
 t.after(async()=>{await worker?.stop();db.close();server.remove();});
 const options={app:{post(){},put(){}},db,fromEmail:'test@example.test',requireMeByToken:()=>null,
  publicBaseUrl:()=>server.baseUrl,escapeHtml:value=>value,now:()=>clock};
 worker=installGiftFeatures({...options,transporter:{async sendMail(){throw new Error('Temporary SMTP failure');}}});
 db.transaction(()=>{worker.enqueueReservedDeletion(owner.id,event.id,{...item,reserved_by:giver.id});db.prepare('DELETE FROM wishlist_items WHERE id=?').run(item.id);})();
 await worker.flushEmails();const pending=db.prepare('SELECT * FROM gift_email_jobs').get();assert.equal(pending.status,'pending');
 assert.equal(pending.attempts,1);await worker.stop();clock+=30001;
 worker=installGiftFeatures({...options,transporter:{async sendMail(mail){delivered.push(mail);}}});
 await worker.flushEmails();assert.equal(delivered.length,1);assert.equal(delivered[0].to,giver.email);assert(delivered[0].text.includes('Removed gift'));
 assert.equal(db.prepare('SELECT status FROM gift_email_jobs WHERE id=?').get(pending.id).status,'sent');
 worker.enqueueReservation(owner.id,event.id,{id:'already-removed',title:'No longer reserved'},giver.id);
 await worker.flushEmails();assert.equal(delivered.length,1);
 assert(db.prepare("SELECT COUNT(*) n FROM gift_email_jobs WHERE status='cancelled'").get().n>0);
});
