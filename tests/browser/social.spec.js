const {test,expect}=require('@playwright/test');
const Database=require('better-sqlite3');
const path=require('node:path');
const {startServer}=require('../support/server');

async function drawAll(server,people){for(const person of people){
 const draw=await server.request('POST','/api/draw',{token:person.token});person.recipients=draw.data.recipients_by_tier;
 person.id=(await server.request('GET',`/api/me?token=${person.token}`)).data.me.id;
}}
const card=(page,owner)=>page.locator('#root > .card').filter({has:page.locator('.owner',{hasText:new RegExp(`^${owner.name}$`)})});

test('recipient bells, anonymous nudges and public editable guesses work together',async({browser},testInfo)=>{
 const server=await startServer();const contexts=[];const errors=[];
 try{
  const {people}=await server.seed({participants:['Alex','Blair','Casey','Drew','Eden','Finley','Georgia'].map(name=>({name,email:`${name.toLowerCase()}@example.test`}))});await drawAll(server,people);
  const owner=people[0],givers=people.filter(p=>p.recipients.some(r=>r.recipient===owner.name));
  const viewer=givers[0],outsider=people.find(p=>p!==owner&&!givers.includes(p));
  for(const person of [owner,...givers,outsider]){
   const context=await browser.newContext({...testInfo.project.use});contexts.push(context);person.page=await context.newPage();
   person.page.on('pageerror',error=>errors.push(error.message));
   await person.page.goto(`${server.baseUrl}/wishlists?token=${person.token}`);
   await expect(card(person.page,owner)).toBeVisible();
  }
  for(const person of [owner,outsider]){
   await expect(card(person.page,owner).locator('.recipient-bell')).toHaveCount(0);
   await expect(card(person.page,owner).locator('.recipient-nudge')).toHaveCount(0);
  }
  const recipient=card(viewer.page,owner);
  await recipient.getByRole('button',{name:`Enable email updates for ${owner.name}`}).click();
  await expect(recipient.locator('.recipient-bell')).toHaveAttribute('aria-pressed','true');
  await expect(recipient).toContainText('Not spam');
  await viewer.page.reload();await expect(card(viewer.page,owner).locator('.recipient-bell')).toHaveAttribute('aria-pressed','true');
  await card(viewer.page,owner).getByRole('button',{name:`Send a wishlist reminder to ${owner.name}`}).click();
  await expect(card(viewer.page,owner).locator('.recipient-nudge')).toBeDisabled();
  await givers[1].page.reload();await expect(card(givers[1].page,owner).locator('.recipient-nudge')).toBeDisabled();
  await owner.page.locator('#btn_toggle_add').click();
  await owner.page.locator('#f_title').fill('A lovely blue mug');await owner.page.locator('#f_price').fill('20');
  await owner.page.locator('#f_notes').fill('Blue please');await owner.page.locator('#btn_add').click();
  await expect(owner.page.locator('#msg_add')).toHaveText('Added!');
  const notices=()=>server.emails().filter(mail=>mail.subject.includes('added a wishlist idea'));
  await expect.poll(()=>notices().length).toBe(1);
  expect(notices()[0].text).toContain('A lovely blue mug');expect(notices()[0].text).toContain('$20.00');
  expect(notices()[0].to[0].address).toBe(viewer.email);
  await card(viewer.page,owner).getByRole('button',{name:`Disable email updates for ${owner.name}`}).click();
  await expect(card(viewer.page,owner).locator('.recipient-bell')).toHaveAttribute('aria-pressed','false');
  await expect(card(viewer.page,owner)).toContainText('Email updates are off.');
  await server.request('POST','/api/wishlist/item',{token:owner.token,title:'Silent new item'});
  await expect.poll(()=>server.emails().filter(mail=>mail.subject.includes('added a wishlist idea')).length).toBe(1);

  await expect(viewer.page.locator('#gifter-game')).toBeVisible();
  const selects=viewer.page.locator('.guess-field select');await expect(selects).toHaveCount(12);
  await expect(viewer.page.locator('.guess-known')).toHaveCount(2);
  const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
  const publicPicks=db.prepare('SELECT recipient_id,tier_id,giver_id FROM assignments WHERE recipient_id=?').all(viewer.id);
  const privatePick=db.prepare('SELECT recipient_id,tier_id,giver_id FROM assignments WHERE giver_id<>? AND recipient_id<>?').all(viewer.id,viewer.id)
    .find(guess=>!publicPicks.some(pick=>pick.giver_id===guess.giver_id));db.close();
  const guesses=[...publicPicks,privatePick];
  const selectFor=guess=>viewer.page.locator(`select[data-recipient-id="${guess.recipient_id}"][data-tier-id="${guess.tier_id}"]`);
  for(const guess of guesses)await selectFor(guess).selectOption(guess.giver_id);
  await viewer.page.getByRole('button',{name:'Save my guesses',exact:true}).click();
  await expect(viewer.page.locator('#guesses-feedback')).toContainText('Guesses saved');
  await owner.page.reload();
  const publicGuess=owner.page.locator('.guess-card').filter({has:owner.page.getByRole('heading',{name:viewer.name,exact:true})});
  await publicGuess.locator('summary').click();
  for(const guess of publicPicks)await expect(publicGuess).toContainText(people.find(p=>p.id===guess.giver_id).name);
  await expect(publicGuess.locator('.public-guess')).toHaveCount(2);
  await expect(publicGuess.locator('.public-guess-recipient')).toHaveCount(1);
  await expect(publicGuess.locator('.guess-known')).toHaveCount(0);
  await expect(publicGuess).not.toContainText('Already known');
  const privateName=people.find(person=>person.id===privatePick.giver_id).name;
  expect(await publicGuess.locator('.public-guess strong').allTextContents()).not.toContain(privateName);
  await viewer.page.reload();await expect(selectFor(privatePick)).toHaveValue(privatePick.giver_id);
  const options=await selectFor(guesses[0]).locator('option').evaluateAll(options=>options.filter(option=>option.value&&!option.disabled&&!option.selected).map(option=>option.value));
  const replacement=people.find(p=>p.id===options[0]);expect(replacement).toBeTruthy();
  await selectFor(guesses[0]).selectOption(replacement.id);await viewer.page.getByRole('button',{name:'Save my guesses',exact:true}).click();
  await expect(viewer.page.locator('#guesses-feedback')).toContainText('Guesses saved');await owner.page.reload();
  await publicGuess.locator('summary').click();await expect(publicGuess).toContainText(replacement.name);
  expect(await viewer.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
 }finally{for(const context of contexts)await context.close();await server.stop();server.remove();}
});

test('event-day lock keeps results hidden until the admin publishes',async({page})=>{
 let server=await startServer({now:'2026-12-24T00:00:00Z',adminEmail:'alex@example.test'});
 try{
  const seeded=await server.seed();await drawAll(server,seeded.people);const person=seeded.people[0];
  const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
  const guesses=db.prepare('SELECT recipient_id,tier_id,giver_id guessed_gifter_id FROM assignments WHERE giver_id<>?').all(person.id);db.close();
  await server.request('PUT','/api/wishlist/guesses',{token:person.token,guesses});
  const visit=()=>page.goto(`${server.baseUrl}/wishlists?token=${person.token}`);
  await visit();await expect(page.locator('#save-guesses')).toBeEnabled();
  await expect(page.locator('#guesses-board-title')).toHaveText('Everyone’s guesses');
  const restart=async now=>{const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now,adminEmail:'alex@example.test'});};
  await restart('2026-12-24T13:30:00Z');await visit();
  await expect(page.locator('#gifter-game-status')).toContainText('Guesses are locked');
  await expect(page.locator('#save-guesses')).toBeDisabled();
  for(const select of await page.locator('.guess-field select').all())await expect(select).toBeDisabled();
  await expect(page.locator('.guess-verdict')).toHaveCount(0);
  await restart('2026-12-25T07:30:00Z');await visit();
  await expect(page.locator('#guesses-board-title')).toHaveText('Everyone’s guesses');
  await expect(page.locator('.guess-verdict')).toHaveCount(0);
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'Publish results',exact:true}).click();
  await expect(page.locator('.guess-verdict')).toHaveCount(0);
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Publish results',exact:true}).click();
  await expect(page.locator('#guesses-board-title')).toHaveText('The great gifter reveal');
  await expect(page.locator('#save-guesses')).toBeDisabled();
  const first=page.locator('.guess-card').first();await expect(first).toContainText(person.name);
  await expect(first).toContainText('8 of 8 correct');await expect(first.locator('.guess-rank')).toHaveText('#1');
  await expect(first.locator('.guess-verdict.correct')).toHaveCount(8);
 }finally{await server.stop();server.remove();}
});

test('wishlist admin sees Edit on other lists while owners retain Delete and other users cannot edit',async({browser},testInfo)=>{
 const server=await startServer({adminEmail:'alex@example.test'});const contexts=[];
 try{
  const {people}=await server.seed();await drawAll(server,people);const [admin,owner,other]=people;
  await server.request('POST','/api/wishlist/item',{token:owner.token,title:'Broken product',url:'https://example.com/borken',price_cents:5000});
  for(const person of [admin,owner,other]){
   const context=await browser.newContext({...testInfo.project.use});contexts.push(context);person.page=await context.newPage();
   await person.page.goto(`${server.baseUrl}/wishlists?token=${person.token}`);
   if(await card(person.page,owner).locator('.btn-toggle').getAttribute('aria-expanded')==='false')await card(person.page,owner).locator('.btn-toggle').click();
  }
  await expect(admin.page.locator('#wishlist-admin-note')).toBeVisible();
  await expect(other.page.locator('#wishlist-admin-note')).toBeHidden();
  await expect(card(other.page,owner).getByRole('button',{name:'Edit',exact:true})).toHaveCount(0);
  await expect(card(admin.page,owner).getByRole('button',{name:'Delete',exact:true})).toHaveCount(0);
  await expect(card(owner.page,owner).getByRole('button',{name:'Delete',exact:true})).toHaveCount(1);
  const target=card(admin.page,owner);
  await target.getByRole('button',{name:'Edit',exact:true}).click();
  await target.getByLabel('Title *',{exact:true}).fill('Fixed product');
  await target.getByLabel('Product link',{exact:true}).fill('https://example.com/fixed');
  await target.getByLabel('Gift Price',{exact:true}).fill('20');
  await target.getByRole('button',{name:'Update',exact:true}).click();
  await expect(target).toContainText('Fixed product');
  await owner.page.reload();
  if(await card(owner.page,owner).locator('.btn-toggle').getAttribute('aria-expanded')==='false')await card(owner.page,owner).locator('.btn-toggle').click();
  await expect(card(owner.page,owner)).toContainText('Fixed product');
  await expect(card(owner.page,owner).getByRole('link',{name:/^View link/})).toHaveAttribute('href','https://example.com/fixed');
  expect(await admin.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{for(const context of contexts)await context.close();await server.stop();server.remove();}
});
