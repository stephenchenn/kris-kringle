const {randomBytes,createHash,timingSafeEqual}=require('node:crypto');
const path=require('node:path');
const {eventSchedule}=require('./event-time');
const HOURS=8*60*60*1000;

function installAdmin({app,db,publicBaseUrl,createEvent}) {
  const sessions=new Map(),attempts=new Map();
  const digest=value=>createHash('sha256').update(value).digest();
  const cookieName='kringle_admin';
  db.exec(`CREATE TABLE IF NOT EXISTS admin_event_requests (
    request_key TEXT PRIMARY KEY,config_hash TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE
  )`);
  function sameOrigin(req){return req.get('sec-fetch-site')!=='cross-site' && (!req.get('origin')||req.get('origin')===publicBaseUrl());}
  function sessionFor(req){
    const token=(req.get('cookie')||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(!token)return null;
    const key=digest(token).toString('hex');const saved=sessions.get(key);
    if(saved?.expires>Date.now())return saved;
    sessions.delete(key);return null;
  }
  function cookie(res,value,maxAge){res.cookie(cookieName,value,{httpOnly:true,sameSite:'strict',secure:publicBaseUrl().startsWith('https:'),path:'/api/admin',maxAge});}
  function requireAdmin(req,res,next){
    const saved=sessionFor(req);
    if(!saved)return res.status(401).json({error:'Sign in with the admin secret.'});
    if(!['GET','HEAD'].includes(req.method) && (!sameOrigin(req)||req.get('x-admin-csrf')!==saved.csrf))return res.status(403).json({error:'Reload the admin page and try again.'});
    next();
  }
  app.get('/admin',(_req,res)=>res.set('Cache-Control','no-store').sendFile(path.join(__dirname,'../public/admin.html')));
  app.post('/api/admin/session',(req,res)=>{
    if(!sameOrigin(req))return res.status(403).json({error:'Open the admin page on this site.'});
    const now=Date.now(),key=req.ip;
    for(const [id,value] of attempts)if(value.reset<=now)attempts.delete(id);
    for(const [id,value] of sessions)if(value.expires<=now)sessions.delete(id);
    const counter=attempts.get(key)||{count:0,reset:now+15*60*1000};
    if(counter.count>=10){res.set('Retry-After',String(Math.ceil((counter.reset-now)/1000)));return res.status(429).json({error:'Too many sign-in attempts. Try again in 15 minutes.'});}
    counter.count++;attempts.set(key,counter);
    if(typeof req.body?.secret!=='string'||!timingSafeEqual(digest(req.body.secret),digest(process.env.ADMIN_SECRET)))return res.status(403).json({error:'Incorrect admin secret.'});
    attempts.delete(key);
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
    sessions.set(digest(token).toString('hex'),{csrf,expires:now+HOURS});cookie(res,token,HOURS);
    res.json({ok:true,csrf});
  });
  app.get('/api/admin/session',requireAdmin,(req,res)=>res.json({ok:true,csrf:sessionFor(req).csrf}));
  app.delete('/api/admin/session',requireAdmin,(req,res)=>{
    const saved=sessionFor(req);for(const [id,value] of sessions)if(value===saved)sessions.delete(id);
    cookie(res,'',0);res.json({ok:true});
  });
  function detail(id){
    const event=db.prepare('SELECT id,name,event_date,location FROM events WHERE id=?').get(id);
    if(!event)return null;
    event.tiers=db.prepare('SELECT id,name,budget_cents FROM gift_tiers WHERE event_id=? ORDER BY sort_order').all(id);
    const participants=db.prepare('SELECT id,name,email,has_drawn,invitation_sent_at,invite_token FROM participants WHERE event_id=? ORDER BY name COLLATE NOCASE').all(id).map(person=>{
      const {invite_token,...fields}=person;const query='?token='+encodeURIComponent(invite_token);
      return {...fields,has_drawn:!!fields.has_drawn,draw_link:publicBaseUrl()+'/draw'+query,wishlist_link:publicBaseUrl()+'/wishlists'+query};
    });
    return {event,participants};
  }
  app.get('/api/admin/events',requireAdmin,(_req,res)=>res.json({events:db.prepare(`SELECT e.id,e.name,e.event_date,e.created_at,
    COUNT(p.id) participant_count,COALESCE(SUM(p.has_drawn),0) drawn_count FROM events e
    LEFT JOIN participants p ON p.event_id=e.id GROUP BY e.id ORDER BY e.created_at DESC,e.id`).all()}));
  app.get('/api/admin/events/:id',requireAdmin,(req,res)=>{
    const data=detail(req.params.id);if(!data)return res.status(404).json({error:'Event not found.'});res.json(data);
  });
  const text=(value,max)=>typeof value==='string'&&value.trim()&&value.trim().length<=max;
  function validMeta(body){return text(body.eventName,150) && typeof body.location==='string'&&body.location.length<=500 &&
    typeof body.eventDate==='string'&&eventSchedule({event_date:body.eventDate},0).phase!=='unavailable';}
  function validTiers(tiers){return Array.isArray(tiers)&&tiers.length>0&&tiers.length<=50&&tiers.every(t=>t&&text(t.name,80)&&Number.isSafeInteger(t.budgetCents)&&t.budgetCents>=0&&t.budgetCents<=100000000);}
  app.post('/api/admin/events',requireAdmin,(req,res)=>{
    const body=req.body||{};
    if(!validMeta(body)||!validTiers(body.tiers)||!Array.isArray(body.participants)||body.participants.length<2||body.participants.length>100||
      body.participants.some(p=>!p||!text(p.name,100)||typeof p.email!=='string'||p.email.length>254))return res.status(400).json({error:'Check the event date, participants and gift tiers.'});
    if(typeof body.requestKey!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestKey))return res.status(400).json({error:'Reload the page before creating an event.'});
    const config={eventName:body.eventName.trim(),eventDate:body.eventDate,location:body.location.trim(),
      participants:body.participants.map(p=>({name:p.name.trim(),email:p.email.trim().toLowerCase()})),
      tiers:body.tiers.map(t=>({name:t.name.trim(),budgetCents:t.budgetCents}))};
    const configHash=digest(JSON.stringify(config)).toString('hex');
    const previous=db.prepare('SELECT event_id,config_hash FROM admin_event_requests WHERE request_key=?').get(body.requestKey);
    if(previous){
      if(previous.config_hash!==configHash)return res.status(409).json({error:'This creation request already created an event. Open it in the event list, or choose New event.'});
      return res.json({...detail(previous.event_id),reused:true});
    }
    req.adminCreation={requestKey:body.requestKey,configHash};
    req.body={...config,secret:process.env.ADMIN_SECRET};createEvent(req,res);
  });
  app.put('/api/admin/events/:id',requireAdmin,(req,res)=>{
    const data=detail(req.params.id);if(!data)return res.status(404).json({error:'Event not found.'});
    const body=req.body||{};
    if(!validMeta(body)||!validTiers(body.tiers)||body.tiers.length!==data.event.tiers.length||new Set(body.tiers.map(t=>t.id)).size!==data.event.tiers.length||
      body.tiers.some(t=>!data.event.tiers.some(existing=>existing.id===t.id)))return res.status(400).json({error:'Check the event details and existing gift tiers.'});
    db.transaction(()=>{
      db.prepare('UPDATE events SET name=?,event_date=?,location=? WHERE id=?').run(body.eventName.trim(),body.eventDate,body.location.trim(),req.params.id);
      for(const tier of body.tiers)db.prepare('UPDATE gift_tiers SET name=?,budget_cents=? WHERE id=? AND event_id=?').run(tier.name.trim(),tier.budgetCents,tier.id,req.params.id);
    })();
    res.json({...detail(req.params.id),ok:true});
  });
  // Existing CLI routes keep using the secret. Web sessions may only invoke
  // these specific operations with CSRF validation and an explicit event ID.
  app.use('/api/admin',(req,res,next)=>{
    if(!['/send-invites','/send-wishlists'].includes(req.path)||req.method!=='POST'||req.body?.secret!==undefined)return next();
    requireAdmin(req,res,()=>{
      if(typeof req.body?.eventId!=='string'||!req.body.eventId)return res.status(400).json({error:'Select an event first.'});
      req.body.secret=process.env.ADMIN_SECRET;next();
    });
  });
}
module.exports={installAdmin};
