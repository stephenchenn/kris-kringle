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
  const {people}=await server.seed();await drawAll(server,people);
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
  const selects=viewer.page.locator('.guess-field select');await expect(selects).toHaveCount(2);
  await selects.nth(0).selectOption(owner.id);await selects.nth(1).selectOption(outsider.id);
  await viewer.page.getByRole('button',{name:'Save my guesses',exact:true}).click();
  await expect(viewer.page.locator('#guesses-feedback')).toContainText('Guesses saved');
  await owner.page.reload();
  const publicGuess=owner.page.locator('.guess-card').filter({has:owner.page.getByRole('heading',{name:viewer.name,exact:true})});
  await expect(publicGuess).toContainText(outsider.name);await expect(publicGuess).toContainText(owner.name);
  const replacement=people.find(p=>p!==viewer&&p!==owner&&p!==outsider);
  await selects.nth(0).selectOption(replacement.id);await viewer.page.getByRole('button',{name:'Save my guesses',exact:true}).click();
  await expect(viewer.page.locator('#guesses-feedback')).toContainText('Guesses saved');await owner.page.reload();
  await expect(publicGuess).toContainText(replacement.name);
  expect(await viewer.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
 }finally{for(const context of contexts)await context.close();await server.stop();server.remove();}
});

test('event-day lock and results leaderboard appear at the correct times',async({page})=>{
 let server=await startServer({now:'2026-12-24T00:00:00Z'});
 try{
  const seeded=await server.seed();await drawAll(server,seeded.people);const person=seeded.people[0];
  const db=new Database(path.join(server.directory,'db.sqlite'),{readonly:true});
  const guesses=db.prepare('SELECT tier_id,giver_id guessed_gifter_id FROM assignments WHERE recipient_id=?').all(person.id);db.close();
  await server.request('PUT','/api/wishlist/guesses',{token:person.token,guesses});
  const visit=()=>page.goto(`${server.baseUrl}/wishlists?token=${person.token}`);
  await visit();await expect(page.locator('#save-guesses')).toBeEnabled();
  await expect(page.locator('#guesses-board-title')).toHaveText('Everyone’s guesses');
  const restart=async now=>{const {directory,secret}=server;await server.stop();server=await startServer({directory,secret,now});};
  await restart('2026-12-24T13:30:00Z');await visit();
  await expect(page.locator('#gifter-game-status')).toContainText('Guesses are locked');
  await expect(page.locator('#save-guesses')).toBeDisabled();
  for(const select of await page.locator('.guess-field select').all())await expect(select).toBeDisabled();
  await expect(page.locator('.guess-verdict')).toHaveCount(0);
  await restart('2026-12-25T07:30:00Z');await visit();
  await expect(page.locator('#guesses-board-title')).toHaveText('The great gifter reveal');
  await expect(page.locator('#save-guesses')).toBeDisabled();
  const first=page.locator('.guess-card').first();await expect(first).toContainText(person.name);
  await expect(first).toContainText('2 of 2 correct');await expect(first.locator('.guess-rank')).toHaveText('#1');
  await expect(first.locator('.guess-verdict.correct')).toHaveCount(2);
 }finally{await server.stop();server.remove();}
});
