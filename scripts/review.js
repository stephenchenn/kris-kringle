const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kris-kringle-review-'));
const port=Number(process.env.REVIEW_PORT || 3001);
Object.assign(process.env,{NODE_ENV:'development',DB_PATH:path.join(directory,'db.sqlite'),
 WISHLIST_ADMIN_EMAIL:'alex@example.test',EMAIL_MODE:'preview',EMAIL_PREVIEW_DIR:path.join(directory,'emails'),
 FROM_EMAIL:'Family Kris Kringle Preview <preview@example.test>',ADMIN_SECRET:randomUUID(),
 PORT:String(port),BASE_URL:`http://127.0.0.1:${port}`});
const {app,db,transporter,giftFeatures}=require('../server');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const emailDirectory=process.env.EMAIL_PREVIEW_DIR;
const emailFiles=()=>fs.existsSync(emailDirectory)?fs.readdirSync(emailDirectory).filter(name=>name.endsWith('.json')).sort().reverse():[];
let scenarios=[];
function shell(title,body){return `<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/theme.css"><style>main{max-width:960px;margin:auto;padding:36px 24px}h1{font-size:42px}h2{font:26px Georgia,serif;margin:0 0 12px}.review-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:24px;margin:20px 0}p,li{line-height:1.8}ul{padding-left:22px}nav{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:26px}.review-tag{background:var(--soft);padding:8px 12px;border-radius:8px;font-size:12px}.people{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.people a{background:var(--soft);padding:10px 14px;border-radius:7px;text-decoration:none}small{color:var(--muted)}</style><main><nav><a href="/review">Review home</a><a href="/review/emails">Email preview inbox</a></nav>${body}</main></html>`;}
app.get('/review',(_req,res)=>res.send(shell('Kris Kringle feature review',`
 <span class="review-tag">LOCAL PREVIEW · Emails are captured here</span>
 <h1>A little more Christmas magic.</h1>
 <p>Try the notification bells, send a wishlist nudge, and inspect the captured emails. Each person’s button opens their own session. Alex has edit access to everyone’s existing items. Each seven-person event has 12 guesses per person. The three events below demonstrate each guessing phase.</p>
 ${scenarios.map(s=>`<section class="review-card"><h2>${escape(s.label)}</h2><p>${escape(s.description)}</p><div class="people">${s.people.map(p=>`<a href="/wishlists?token=${encodeURIComponent(p.token)}" target="_blank" rel="noopener">Open as ${escape(p.name)}${p.name==='Alex'?' · admin':''}</a>`).join('')}</div>${s.kind==='open'?`<small>Alex is gifting to ${s.recipients.map(escape).join(' and ')}. Open Alex’s session and one of those recipient sessions side by side: enable their bell, then add an item as the recipient.</small>`:''}</section>`).join('')}
 <p><a href="/review/emails">Open the email preview inbox ↗</a></p>`)));
app.get('/review/emails',(_req,res)=>res.send(shell('Email preview inbox',`
 <h1>A little Christmas post.</h1><p>Notifications and nudges appear here. Refresh after trying an action.</p>
 ${emailFiles().length?emailFiles().map(name=>{const mail=JSON.parse(fs.readFileSync(path.join(emailDirectory,name),'utf8'));return `<article class="review-card"><h2><a href="/review/email/${escape(name.slice(0,-5))}">${escape(mail.subject)}</a></h2><p>To: ${escape(mail.to.map(p=>p.address).join(', '))}</p></article>`;}).join(''):'<div class="review-card">No messages yet. Send a nudge or add an item to a followed wishlist.</div>'}`)));
app.get('/review/email/:id',(req,res)=>{
 if(!/^\d+-[a-f0-9-]+$/.test(req.params.id))return res.sendStatus(404);
 const filename=path.join(emailDirectory,req.params.id+'.html');
 if(!fs.existsSync(filename))return res.sendStatus(404);
 res.send(fs.readFileSync(filename,'utf8'));
});

async function seed(kind,date,label,description){
 const base=process.env.BASE_URL;
 const response=await fetch(base+'/api/admin/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  secret:process.env.ADMIN_SECRET,eventName:`Family Christmas — ${label}`,eventDate:date,location:'Preview family gathering',
  participants:['Alex','Blair','Casey','Drew','Eden','Finley','Georgia'].map(name=>({name,email:`${name.toLowerCase()}@example.test`})),
  tiers:[{name:'BIG GIFT',budgetCents:5000},{name:'small gift',budgetCents:2000}],
 })});
 const result=await response.json();if(!response.ok)throw new Error(result.error || 'Could not create review event');
 const people=result.invites.map(person=>({...person,token:new URL(person.link).searchParams.get('token')}));
 const editTime=Date.now()-4*24*60*60*1000;
 for(const [index,person] of people.entries()){
  const me=db.prepare('SELECT * FROM participants WHERE invite_token=?').get(person.token);person.id=me.id;
  db.prepare('UPDATE participants SET has_drawn=1 WHERE id=?').run(person.id);
  await fetch(base+'/api/wishlist/item',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:person.token,
   title:['A lovely coffee mug','A cosy winter scarf','A new favourite book','Something for the garden','A little skincare treat','A puzzle for a rainy day','A handy little toolbox'][index],
   price_cents:[2000,4900,1850,3500,2500,2000,4500][index],notes:['Blue or forest green, please.','Soft wool, any neutral colour.','I love a good mystery.','A pair of gardening gloves would be lovely.','Something gentle for sensitive skin.','A landscape with lots of detail.','Something small for everyday fixes.'][index]})});
  let answers=db.prepare('SELECT tier_id,recipient_id,giver_id FROM assignments WHERE event_id=? AND giver_id<>? ORDER BY recipient_id,tier_id').all(result.event.id,person.id);
  // Complete correct ballots demonstrate score/average ties. Other sample
  // participants leave some guesses blank so the board has realistic variety.
  if(index>=2)answers=answers.slice(0,Math.max(0,12-index*2));
  for(const answer of answers)db.prepare('INSERT INTO gifter_guesses(event_id,participant_id,recipient_id,tier_id,guessed_gifter_id,edited_at) VALUES(?,?,?,?,?,?)')
   .run(result.event.id,person.id,answer.recipient_id,answer.tier_id,answer.giver_id,editTime+index*60*1000);

 }
 const recipients=db.prepare('SELECT DISTINCT p.name FROM assignments a JOIN participants p ON p.id=a.recipient_id WHERE a.event_id=? AND a.giver_id=?').all(result.event.id,people[0].id).map(row=>row.name);
 if(kind==='results'){
  const published=await fetch(base+'/api/wishlist/guesses/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:people[0].token})});
  if(!published.ok)throw new Error('Could not publish sample results');
 }
 return {kind,label,description,people,recipients};
}
const server=app.listen(port,'127.0.0.1',async()=>{
 try{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Adelaide',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  scenarios=[
   await seed('open',new Date(Date.now()+7*24*60*60*1000).toISOString(),'Before the event','Try saving guesses, then use Alex’s Publish results button whenever you’re ready. You can also follow wishlists and send a nudge.'),
   await seed('locked',today,'Event day · guesses locked','Guesses remain public, editing is locked, and the answers are still hidden.'),
   await seed('results',new Date(Date.now()-24*60*60*1000).toISOString(),'Published results · leaderboard','Alex has published this sample event. See correct answers, scores and the earlier-guess tie-breaker.'),
  ];
  console.log(`\nReview ready: ${process.env.BASE_URL}/review`);
  console.log(`Email previews: ${process.env.BASE_URL}/review/emails`);
  console.log(`Temporary data: ${directory}`);
 }catch(error){console.error(error.message);process.exitCode=1;shutdown();}
});
server.on('error',async error=>{console.error(error.code==='EADDRINUSE'?'Review port is busy. Set REVIEW_PORT=3002 to use another port.':error.message);await giftFeatures.stop();db.close();transporter.close();process.exitCode=1;});
let stopping=false;
function shutdown(){if(stopping)return;stopping=true;server.close(async()=>{await giftFeatures.stop();transporter.close();db.close();});server.closeIdleConnections();}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
