const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const Database=require('better-sqlite3');
const run=promisify(execFile);

test('the isolated three-person runner captures invitations, resumes without duplicates and safely removes only its test data',async t=>{
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
 const state=JSON.parse(fs.readFileSync(stateFile));assert.equal(state.emailMode,'preview');assert.equal(state.invitationsAccepted,3);
 const emails=()=>fs.readdirSync(path.join(directory,'emails')).filter(file=>file.endsWith('.json'));
 assert.equal(emails().length,3);const originalFiles=emails().sort();
 const html=await(await fetch(first.baseUrl+'/test-event')).text();assert(html.includes('Stephen · admin'));assert(html.includes('Not drawn yet'));
 const db=new Database(path.join(directory,'db.sqlite'),{readonly:true});
 assert.equal(db.prepare('SELECT COUNT(*) count FROM events').get().count,1);
 const people=db.prepare('SELECT name,email,has_drawn FROM participants ORDER BY name').all();
 assert.deepEqual(people.map(person=>person.email),['chen.stephen141@gmail.com','stephen.chen@cognitive.earth','chen.stephen151@gmail.com']);
 assert(people.every(person=>person.has_drawn===0));db.close();
 const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;
 const second=await start();assert.equal(second.eventId,first.eventId);assert.deepEqual(emails().sort(),originalFiles);
 // A directory with an unrecognised marker cannot be deleted or its server killed.
 const current=JSON.parse(fs.readFileSync(stateFile));fs.writeFileSync(stateFile,JSON.stringify({...current,kind:'not-a-test'}));
 await assert.rejects(run(process.execPath,[path.join(root,'scripts/test-event.js'),'clean'],{cwd:root}),/not a marked manual test/);
 assert(fs.existsSync(directory));assert.equal((await fetch(second.baseUrl+'/healthz')).status,200);
 fs.writeFileSync(stateFile,JSON.stringify(current));
 const cleaned=await run(process.execPath,[path.join(root,'scripts/test-event.js'),'clean'],{cwd:root,timeout:15000});
 assert(cleaned.stdout.includes('Deleted only .local/manual-test'));assert(!fs.existsSync(directory));
 assert.equal(fs.readFileSync(familyFile,'utf8'),'family config sentinel');assert.deepEqual(fs.readFileSync(familyDb),before);
});
