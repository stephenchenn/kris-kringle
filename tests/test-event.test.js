const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const Database=require('better-sqlite3');
const run=promisify(execFile);

test('the isolated six-person runner supports the gift lifecycle and safely removes only its test data',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kringle-manual-runner-'));
 fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'.local'));
 for(const file of ['server.js','scripts/test-event.js'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
 for(const directory of ['lib','public'])fs.cpSync(path.join(__dirname,'..',directory),path.join(root,directory),{recursive:true});
 fs.symlinkSync(path.join(__dirname,'../node_modules'),path.join(root,'node_modules'),'dir');
 const familyFile=path.join(root,'.local/event-2026.json');fs.writeFileSync(familyFile,'family config sentinel');
 const familyDb=path.join(root,'.local/family.sqlite');const sentinel=new Database(familyDb);sentinel.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'family data\')');sentinel.close();
 const before=fs.readFileSync(familyDb);
 let child;
 t.after(async()=>{if(child && child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});});
 async function start(){
  child=fork('scripts/test-event.js',[],{cwd:root,env:{...process.env,TEST_EVENT_PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
  let logs='';child.stdout.on('data',data=>{logs+=data;});child.stderr.on('data',data=>{logs+=data;});
  return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Manual runner timed out')),10000);child.once('message',message=>{clearTimeout(timeout);resolve(message);});child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Manual runner exited ${code}: ${logs}`));});});
 }
 const first=await start();const directory=path.join(root,'.local/manual-test');const stateFile=path.join(directory,'state.json');
 const state=JSON.parse(fs.readFileSync(stateFile));assert.equal(state.emailMode,'preview');assert.equal(state.invitationsAccepted,6);
 const emails=()=>fs.readdirSync(path.join(directory,'emails')).filter(file=>file.endsWith('.json'));
 assert.equal(emails().length,6);const originalFiles=emails().sort();
 const html=await(await fetch(first.baseUrl+'/test-event')).text();assert(html.includes('Stephen · admin'));assert(html.includes('Not drawn yet'));
 const db=new Database(path.join(directory,'db.sqlite'),{readonly:true});
 assert.equal(db.prepare('SELECT COUNT(*) count FROM events').get().count,1);
 const people=db.prepare('SELECT name,email,has_drawn FROM participants ORDER BY name').all();
 assert.deepEqual(people.map(person=>person.email),['chen.stephen141@gmail.com','chen.stephen141+kk-test-clarisse1@gmail.com','stephen.chen@cognitive.earth','chen.stephen151+kk-test-liezel1@gmail.com','chen.stephen151@gmail.com','chen.stephen151+kk-test-stephen1@gmail.com']);
 assert(people.every(person=>person.has_drawn===0));db.close();
 const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;
 const second=await start();assert.equal(second.eventId,first.eventId);assert.deepEqual(emails().sort(),originalFiles);
 async function request(method,route,body){
  const response=await fetch(second.baseUrl+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
 }
 const check=new Database(path.join(directory,'db.sqlite'),{readonly:true});
 const testers=check.prepare('SELECT id,name,invite_token token FROM participants ORDER BY name').all();
 const assignments=check.prepare('SELECT recipient_id,tier_id,giver_id FROM assignments').all();check.close();
 const admin=testers.find(person=>person.name==='Stephen');const duplicate=testers.find(person=>person.name==='Stephen1');
 await t.test('all six give and receive one gift per tier with distinct recipients',async()=>{
  const draws=[];
  for(const person of testers){
   const draw=await request('POST','/api/draw',{token:person.token});assert.equal(draw.status,200);
   const tiers=draw.data.recipients_by_tier;draws.push(tiers);
   assert.deepEqual(tiers.map(tier=>tier.budget_cents),[5000,2000]);
   assert.equal(new Set(tiers.map(tier=>tier.recipient)).size,2);
   assert(tiers.every(tier=>tier.recipient!==person.name));
   const view=await request('GET',`/api/wishlists/all?token=${person.token}`);
   assert.equal(view.status,200);assert.equal(view.data.me.is_wishlist_admin,person===admin);
  }
  for(let tier=0;tier<2;tier++)assert.deepEqual(draws.map(draw=>draw[tier].recipient).sort(),testers.map(person=>person.name).sort());
 });
 await t.test('only assigned givers can reserve and see reservations',async()=>{
  const owner=duplicate;const givers=testers.filter(person=>assignments.some(row=>row.recipient_id===owner.id&&row.giver_id===person.id));
  assert.equal(givers.length,2);
  const outsiders=testers.filter(person=>person!==owner&&!givers.includes(person));
  const created=await request('POST','/api/wishlist/item',{token:owner.token,title:'Six-person test wish',price_cents:2000});
  assert.equal(created.status,200);const itemId=created.data.item.id;
  for(const person of outsiders)assert.equal((await request('POST',`/api/wishlist/item/${itemId}/reserve`,{token:person.token})).status,403);
  assert.equal((await request('POST',`/api/wishlist/item/${itemId}/reserve`,{token:owner.token})).status,400);
  assert.equal((await request('POST',`/api/wishlist/item/${itemId}/reserve`,{token:givers[0].token})).status,200);
  assert.equal((await request('POST',`/api/wishlist/item/${itemId}/reserve`,{token:givers[1].token})).status,409);
  assert.equal((await request('PUT',`/api/wishlist/item/${itemId}`,{token:admin.token,title:'Corrected by Stephen'})).status,200);
  for(const person of testers){
   const view=(await request('GET',`/api/wishlists/all?token=${person.token}`)).data;
   const item=view.wishlists.find(list=>list.owner.id===owner.id).items.find(item=>item.id===itemId);
   assert.equal(item.title,'Corrected by Stephen');assert.equal(item.is_reserved,Number(givers.includes(person)));
   assert.equal(item.reserved_by_me,Number(person===givers[0]));
  }
 });
 await t.test('ten private guesses per person score correctly only after Stephen publishes',async()=>{
  for(const person of testers){
   const guesses=assignments.filter(row=>row.giver_id!==person.id).map(row=>({recipient_id:row.recipient_id,tier_id:row.tier_id,guessed_gifter_id:row.giver_id}));
   assert.equal(guesses.length,10);
   const saved=await request('PUT','/api/wishlist/guesses',{token:person.token,guesses});
   assert.equal(saved.status,200);assert.equal(saved.data.guess_count,10);
   assert.equal(saved.data.my_guesses.filter(guess=>guess.guessed_gifter_id).length,10);
   assert(saved.data.rows.every(row=>row.guesses.length===2&&row.guesses.every(guess=>guess.recipient_id===row.participant.id)));
  }
  assert.equal((await request('POST','/api/wishlist/guesses/publish',{token:duplicate.token})).status,403);
  const published=await request('POST','/api/wishlist/guesses/publish',{token:admin.token});
  assert.equal(published.status,200);assert.equal(published.data.phase,'results');
  for(const row of published.data.rows){assert.equal(row.correct_count,10);assert.equal(row.possible_count,10);}
  assert.equal((await request('PUT','/api/wishlist/guesses',{token:duplicate.token,guesses:[]})).status,409);
 });
 // A directory with an unrecognised marker cannot be deleted or its server killed.
 const current=JSON.parse(fs.readFileSync(stateFile));fs.writeFileSync(stateFile,JSON.stringify({...current,kind:'not-a-test'}));
 await assert.rejects(run(process.execPath,[path.join(root,'scripts/test-event.js'),'clean'],{cwd:root}),/not a marked manual test/);
 assert(fs.existsSync(directory));assert.equal((await fetch(second.baseUrl+'/healthz')).status,200);
 fs.writeFileSync(stateFile,JSON.stringify(current));
 const cleaned=await run(process.execPath,[path.join(root,'scripts/test-event.js'),'clean'],{cwd:root,timeout:15000});
 assert(cleaned.stdout.includes('Deleted only .local/manual-test'));assert(!fs.existsSync(directory));
 assert.equal(fs.readFileSync(familyFile,'utf8'),'family config sentinel');assert.deepEqual(fs.readFileSync(familyDb),before);
});
