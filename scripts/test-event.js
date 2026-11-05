const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');

const root=path.resolve(__dirname,'..');
const directory=path.join(root,'.local','manual-test');
const filename=path.join(directory,'state.json');
const kind='kris-kringle-isolated-manual-test';
const participants=[
 {name:'Stephen',email:'chen.stephen151@gmail.com'},
 {name:'Stephen1',email:'chen.stephen151+kk-test-stephen1@gmail.com'},
 {name:'Clarisse',email:'chen.stephen141@gmail.com'},
 {name:'Clarisse1',email:'chen.stephen141+kk-test-clarisse1@gmail.com'},
 {name:'Liezel',email:'stephen.chen@cognitive.earth'},
 {name:'Liezel1',email:'chen.stephen151+kk-test-liezel1@gmail.com'},
];
const eventName=`TEST ONLY — Kris Kringle (${participants.length} participants)`;
const guessCount=(participants.length-1)*2;
const command=process.argv[2];
if(command && !['clean','--send-email'].includes(command))throw new Error('Use npm run test:event [-- --send-email], or npm run test:event:clean.');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function readState(){
 if(fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory)!==path.join(fs.realpathSync(root),'.local','manual-test'))throw new Error('Refusing a test directory outside this repository.');
 const saved=JSON.parse(fs.readFileSync(filename,'utf8'));
 if(saved.kind!==kind)throw new Error('This directory is not a marked manual test. Refusing to use or delete it.');
 return saved;
}
function checkDatabase(state){
 const dbFile=path.join(directory,'db.sqlite');
 if(!fs.existsSync(dbFile))return;
 const check=new Database(dbFile,{readonly:true});
 try{
  const tables=check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").all();
  if(!tables.length)return;
  const events=check.prepare('SELECT id,name FROM events').all();
  if(events.some(event=>event.name!==eventName || (state.eventId && event.id!==state.eventId)) || events.length>1)throw new Error('Unexpected event in test database. Refusing to use or delete it.');
  if(events.length){
   const people=check.prepare('SELECT name,email FROM participants ORDER BY name').all();
   if(JSON.stringify(people)!==JSON.stringify([...participants].sort((a,b)=>a.name.localeCompare(b.name))))throw new Error('Unexpected participants in test database. Refusing to use or delete it.');
  }
 }finally{check.close();}
}
function processInfo(pid){try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(')').at(-1).trim().split(/\s+/);return {running:stat[0]!=='Z',started:stat[19]};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return {running:false};throw error;}}
const isRunning=pid=>processInfo(pid).running;
async function clean(){
 if(!fs.existsSync(directory)){console.log('No isolated test data to delete.');return;}
 const saved=readState();
 if(saved.pid && isRunning(saved.pid)){
  const args=fs.readFileSync(`/proc/${saved.pid}/cmdline`,'utf8').split('\0');
  const workingDirectory=fs.realpathSync(`/proc/${saved.pid}/cwd`);
  const correctScript=args.slice(1).some(argument=>argument && path.resolve(workingDirectory,argument)===__filename);
  if(!correctScript || processInfo(saved.pid).started!==saved.processStart)throw new Error('The saved PID belongs to another process. Refusing to stop it.');
  process.kill(saved.pid,'SIGTERM');
  for(let attempt=0;attempt<150 && isRunning(saved.pid);attempt++)await new Promise(resolve=>setTimeout(resolve,200));
  if(isRunning(saved.pid))throw new Error('Test server is still stopping. Try cleanup again in a moment.');
 }
 checkDatabase(saved);
 fs.rmSync(directory,{recursive:true});
 console.log('Deleted only .local/manual-test: test event, database, links and captured emails. Family event files are untouched.');
}
async function start(){
 if(!fs.existsSync(directory)){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.writeFileSync(filename,JSON.stringify({kind,secret:randomUUID(),emailMode:command==='--send-email'?'smtp':'preview'},null,2),{mode:0o600});
 }
 const state=readState();checkDatabase(state);
 if(state.pid && isRunning(state.pid))throw new Error('The isolated test is already running. Open its /test-event page or clean it first.');
 if(command==='--send-email' && state.emailMode!=='smtp')throw new Error('This is a captured-email test. Clean it first before creating a real-email test.');
 const saveState=()=>{fs.writeFileSync(filename+'.tmp',JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(filename+'.tmp',filename);};
 require('dotenv').config({path:path.join(root,'.env'),quiet:true});
 const port=Number(process.env.TEST_EVENT_PORT ?? state.port ?? 3002);
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid test port.');
 Object.assign(process.env,{NODE_ENV:'development',DB_PATH:path.join(directory,'db.sqlite'),
  EMAIL_MODE:state.emailMode,EMAIL_PREVIEW_DIR:path.join(directory,'emails'),
  WISHLIST_ADMIN_EMAIL:participants[0].email,ADMIN_SECRET:state.secret,PORT:String(port),BASE_URL:`http://127.0.0.1:${port}`});
 if(state.emailMode==='preview')process.env.FROM_EMAIL='Local test <test@example.test>';
 if(state.emailMode==='smtp' && (!process.env.SMTP_USER || !process.env.SMTP_PASS || process.env.SMTP_HOST!=='smtp.gmail.com'))throw new Error('Configure the Gmail SMTP settings in .env before sending this test.');
 const {app,db,transporter,giftFeatures}=require('../server');
 let invites=[];
 app.get('/test-event',(_req,res)=>{
  const drawn=db.prepare('SELECT name,has_drawn FROM participants').all();
  res.send(`<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated ${participants.length}-person test</title><link rel="stylesheet" href="/theme.css"><style>main{max-width:850px;margin:auto;padding:30px 20px}article{padding:20px;border:1px solid var(--line);background:var(--surface);border-radius:12px;margin:20px 0}p{line-height:1.8}nav{display:flex;gap:20px;flex-wrap:wrap}</style><main><p>LOCAL TEST ONLY · SEPARATE DATABASE</p><h1>Your ${participants.length}-person test</h1><p>Draw your recipients, add wishlist items, try bells and nudges, and make ${guessCount} guesses each. Stephen can edit existing items and publish results. Publishing is permanent for this test; create a fresh test to start again.</p><p>${state.emailMode==='smtp'?'Emails are sent to your existing inboxes below. Gmail +aliases give the duplicate participants separate identities. Links open this local server; keep it running.':'Emails are captured locally. No messages are delivered.'}</p>${invites.map(person=>`<article><h2>${escape(person.name)}${person.name==='Stephen'?' · admin':''}</h2><p>${escape(person.email)} · ${drawn.find(row=>row.name===person.name)?.has_drawn?'Drawn':'Not drawn yet'}</p><nav><a href="${escape(person.link)}">Open invitation / draw</a><a href="/wishlists?token=${encodeURIComponent(new URL(person.link).searchParams.get('token'))}">Open wishlist</a></nav></article>`).join('')}<p>When finished: <code>npm run test:event:clean</code>. This deletes only this isolated test and its saved data. It cannot recall emails already delivered.</p></main>`);
 });
 const server=app.listen(port,'127.0.0.1',async()=>{
  try{
   const base=`http://127.0.0.1:${server.address().port}`;process.env.BASE_URL=base;
   state.pid=process.pid;state.processStart=processInfo(process.pid).started;state.port=server.address().port;saveState();
   async function request(route,body){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||`Test setup failed (${response.status})`);return data;}
   const existing=db.prepare('SELECT id FROM events').all();
   if(existing.length){
    state.eventId=existing[0].id;
    invites=db.prepare('SELECT name,email,invite_token FROM participants ORDER BY name').all().map(person=>({name:person.name,email:person.email,link:`${base}/draw?token=${encodeURIComponent(person.invite_token)}`}));
   }else{
    const result=await request('/api/admin/seed',{secret:state.secret,eventName,eventDate:'2026-12-25T18:00:00+10:30',location:'Isolated local test',participants,
     tiers:[{name:'BIG GIFT',budgetCents:5000},{name:'small gift',budgetCents:2000}]});
    state.eventId=result.event.id;invites=result.invites;
   }
   saveState();
   if(!state.invitationsAttemptedAt){
    if(state.emailMode==='smtp')await transporter.verify();
    state.invitationsAttemptedAt=new Date().toISOString();saveState();
    const delivery=await request('/api/admin/send-invites',{secret:state.secret,eventId:state.eventId});
    state.invitationsAccepted=delivery.sent;state.invitationsFailed=delivery.failed;saveState();
    if(delivery.failed?.length)throw new Error('Some test invitations failed. Existing successful invitations will not be resent automatically.');
    console.log(`Test invitations accepted: ${delivery.sent?.length ?? delivery.sent}`);
   }
   console.log(`Test ready: ${base}/test-event`);console.log(`Test data: ${directory}`);console.log(`Email mode: ${state.emailMode}`);
   if(process.send)process.send({baseUrl:base,eventId:state.eventId});
  }catch(error){console.error(error.message);process.exitCode=1;shutdown();}
 });
 server.on('error',async error=>{console.error(error.code==='EADDRINUSE'?'Test port is busy. Stop the existing test server or set TEST_EVENT_PORT.':error.message);await giftFeatures.stop();transporter.close();db.close();process.exitCode=1;});
 let stopping=false;
 function shutdown(){if(stopping)return;stopping=true;server.close(async()=>{await giftFeatures.stop();transporter.close();db.close();state.pid=null;saveState();});server.closeIdleConnections();}
 process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
(command==='clean'?clean():start()).catch(error=>{console.error(error.message);process.exitCode=1;});
