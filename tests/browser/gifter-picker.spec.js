const {test,expect}=require('@playwright/test');
const {startServer}=require('../support/server');

async function prepare(){
 const server=await startServer({adminEmail:'alex@example.test'});
 const seeded=await server.seed({participants:['Alex','Blair','Casey','Drew','Eden','Finley','Georgia'].map(name=>({name,email:`${name.toLowerCase()}@example.test`}))});
 for(const person of seeded.people){await server.request('POST','/api/draw',{token:person.token});person.id=(await server.request('GET',`/api/me?token=${person.token}`)).data.me.id;}
 return {server,seeded};
}
const trigger=select=>select.locator('..').locator('.guess-picker-trigger');
async function choose(page,select,value,mobile){
 if(!mobile){await select.selectOption(value);return;}
 await trigger(select).tap();
 if(value)await page.locator(`#guess-picker-options button[data-value="${value}"]`).tap();
 else await page.getByRole('button',{name:'Clear this guess',exact:true}).tap();
}

test('background refresh preserves an active guess control; publication closes and locks it',async({page},testInfo)=>{
 const {server,seeded}=await prepare();
 try{
  const mobile=!!testInfo.project.use.isMobile,[viewer,peer]=seeded.people;
  await page.clock.install();await page.goto(`${server.baseUrl}/wishlists?token=${viewer.token}`);
  const select=page.locator('.guess-field select').first();await expect(select).toHaveCount(1);
  if(mobile)await trigger(select).tap();else await select.focus();
  const handle=await select.elementHandle();
  const update=await server.request('PUT','/api/wishlist/guesses',{token:peer.token,guesses:[{recipient_id:peer.id,tier_id:seeded.event.tiers[0].id,guessed_gifter_id:viewer.id}]});
  expect(update.status).toBe(200);
  const response=page.waitForResponse(response=>response.url().includes('/api/wishlist/guesses'));
  await page.clock.fastForward(30000);await response;
  const peerCard=page.locator('.guess-card').filter({has:page.locator('h4',{hasText:new RegExp(`^${peer.name}$`)})});
  await expect(peerCard).toContainText(viewer.name);
  expect(await handle.evaluate(element=>element.isConnected)).toBe(true);
  if(mobile){
   await expect(page.locator('#guess-picker')).toBeVisible();
   await expect(page.locator('#guess-picker-options button:enabled').first()).toBeFocused();
   await expect(page.locator('#guess-picker-context')).toContainText(viewer.name);
  }else await expect(select).toBeFocused();
  // A later change to this ballot from another tab also must not detach the
  // control currently being used. It can refresh after the user leaves it.
  const ownUpdate=await server.request('PUT','/api/wishlist/guesses',{token:viewer.token,guesses:[{recipient_id:viewer.id,tier_id:seeded.event.tiers[0].id,guessed_gifter_id:peer.id}]});
  expect(ownUpdate.status).toBe(200);
  const ownResponse=page.waitForResponse(response=>response.url().includes('/api/wishlist/guesses'));
  await page.clock.fastForward(30000);await ownResponse;
  const ownCard=page.locator('.guess-card').filter({has:page.locator('h4',{hasText:`${viewer.name} (you)`})});
  await expect(ownCard).toContainText(peer.name);
  expect(await handle.evaluate(element=>element.isConnected)).toBe(true);
  if(mobile)await expect(page.locator('#guess-picker')).toBeVisible();else await expect(select).toBeFocused();
  const publication=await server.request('POST','/api/wishlist/guesses/publish',{token:viewer.token});expect(publication.status).toBe(200);
  const publishedResponse=page.waitForResponse(response=>response.url().includes('/api/wishlist/guesses'));
  await page.clock.fastForward(30000);await publishedResponse;
  await expect(page.locator('#guesses-board-title')).toHaveText('The great gifter reveal');
  await expect(page.locator('#guess-picker')).not.toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/guess-picker-open/);
  for(const control of await page.locator('.guess-field select').all())await expect(control).toBeDisabled();
  if(mobile)for(const button of await page.locator('.guess-picker-trigger').all())await expect(button).toBeDisabled();
 }finally{await server.stop();server.remove();}
});

test('guess controls support choosing, clearing, availability hints and saving on touch and desktop',async({page},testInfo)=>{
 const {server,seeded}=await prepare();
 try{
  const mobile=!!testInfo.project.use.isMobile,[viewer,choice]=seeded.people;
  await page.goto(`${server.baseUrl}/wishlists?token=${viewer.token}`);
  const first=page.locator(`select[data-recipient-id="${viewer.id}"]`).first();await expect(first).toHaveCount(1);
  await choose(page,first,choice.id,mobile);await expect(first).toHaveValue(choice.id);
  if(mobile){
   await expect(page.locator('#guess-picker')).not.toBeVisible();await expect(trigger(first)).toBeFocused();
   const bounds=await trigger(first).boundingBox();expect(bounds.height).toBeGreaterThanOrEqual(48);
  }
  const tier=await first.getAttribute('data-tier-id');
  const secondId=await page.locator(`select[data-tier-id="${tier}"]`).evaluateAll((selects,{viewerId,choiceId})=>selects.find(select=>![viewerId,choiceId].includes(select.dataset.recipientId)).id,{viewerId:viewer.id,choiceId:choice.id});
  const second=page.locator('#'+secondId);
  await expect(second.locator(`option[value="${choice.id}"]`)).toBeDisabled();
  if(mobile){
   await trigger(second).tap();
   const unavailable=page.locator(`#guess-picker-options button[data-value="${choice.id}"]`);
   await expect(unavailable).toBeDisabled();await expect(unavailable).toContainText('Already chosen for Alex');
   await page.keyboard.press('Escape');await expect(page.locator('#guess-picker')).not.toBeVisible();
   await expect(trigger(second)).toBeFocused();
   await trigger(first).tap();const scroll=await page.evaluate(()=>scrollY);
   await page.touchscreen.tap(10,10);await expect(page.locator('#guess-picker')).not.toBeVisible();
   expect(await page.evaluate(()=>scrollY)).toBe(scroll);
   await expect(first).toHaveValue(choice.id,'closing without a choice must preserve the selection');
  }
  await choose(page,first,'',mobile);await expect(first).toHaveValue('');
  await expect(second.locator(`option[value="${choice.id}"]`)).toBeEnabled();
  await choose(page,second,choice.id,mobile);
  await page.getByRole('button',{name:'Save my guesses',exact:true}).click();
  await expect(page.locator('#guesses-feedback')).toContainText('Guesses saved');
  await page.reload();await expect(second).toHaveValue(choice.id);await expect(first).toHaveValue('');
  if(mobile){
   await page.setViewportSize({width:390,height:568});
   await trigger(second).tap();
   await expect(page.locator(`#guess-picker-options button[data-value="${choice.id}"]`)).toHaveAttribute('aria-pressed','true');
   const clear=await page.locator('#guess-picker-clear').boundingBox();expect(clear.y+clear.height).toBeLessThanOrEqual(568);
   const list=page.locator('#guess-picker-options');expect(await list.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
   await page.getByRole('button',{name:'Close gifter picker',exact:true}).tap();
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await server.stop();server.remove();}
});
