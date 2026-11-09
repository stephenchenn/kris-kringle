const {test,expect}=require('@playwright/test');
const {startServer}=require('../support/server');

test('admin creates and configures a separate event, reviews selected invitations and sees draw progress',async({page})=>{
 const server=await startServer();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  const family=await server.seed({eventName:'Existing family event'});
  await page.goto(server.baseUrl+'/admin');await expect(page.getByRole('heading',{name:'Admin sign in'})).toBeVisible();
  await page.getByLabel('Admin secret',{exact:true}).fill('wrong');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.locator('#admin-feedback')).toContainText('Incorrect admin secret');
  await page.getByLabel('Admin secret',{exact:true}).fill(server.secret);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.locator('#admin-console')).toBeVisible();await expect(page.locator('#admin-secret')).toHaveValue('');
  await expect(page.locator('#event-list')).toContainText('Existing family event');
  await page.locator('#event-name').fill('Friends holiday event');await page.locator('#event-date').fill('2026-12-25');await page.locator('#event-location').fill('At home');
  await page.getByRole('button',{name:'Add participant',exact:true}).click();
  const people=page.locator('#create-people .form-row');
  for(let i=0;i<3;i++){
   await people.nth(i).locator('input[data-key=name]').fill('Friend '+(i+1));
   await people.nth(i).locator('input[data-key=email]').fill(`friend${i+1}@example.test`);
  }
  await page.getByRole('button',{name:'Create event',exact:true}).click();
  await expect(page.locator('#selected-event-title')).toHaveText('Friends holiday event');
  await expect(page.locator('#event-progress')).toContainText('0 of 3');expect(server.emails()).toHaveLength(0);
  await page.locator('#edit-event-location').fill('The new venue');await page.getByRole('button',{name:'Save event details',exact:true}).click();
  await expect(page.locator('#admin-feedback')).toContainText('Event details saved');
  const participants=page.locator('#event-participants .participant');await expect(participants).toHaveCount(3);
  await participants.last().locator('input[type=checkbox]').uncheck();
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Send selected invitations'}).click();
  await expect(page.locator('#admin-feedback')).toContainText('Invitations not sent');expect(server.emails()).toHaveLength(0);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Send selected invitations'}).click();
  await expect(page.locator('#invite-feedback')).toContainText('2 invitations accepted');expect(server.emails()).toHaveLength(2);
  expect(server.emails().every(mail=>mail.subject.includes('Friends holiday event'))).toBe(true);
  await expect(participants.filter({hasText:'Invited · waiting to draw'})).toHaveCount(2);
  expect(await participants.locator('input:checked').count()).toBe(1);
  const link=await participants.first().getByRole('link',{name:'Draw link',exact:true}).getAttribute('href');
  await server.request('POST','/api/draw',{token:new URL(link).searchParams.get('token')});
  await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.locator('#event-progress')).toContainText('1 of 3');
  await page.reload();await expect(page.locator('#admin-console')).toBeVisible();
  await page.getByRole('button',{name:/Friends holiday event/}).click();await expect(page.locator('#edit-event-location')).toHaveValue('The new venue');
  await page.getByRole('button',{name:/Existing family event/}).click();await expect(page.locator('#event-progress')).toContainText('0 of 5');
  expect((await server.request('GET','/api/me?token='+family.people[0].token)).data.me.has_drawn).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.locator('#login-panel')).toBeVisible();
  await page.reload();await expect(page.locator('#login-panel')).toBeVisible();expect(errors).toEqual([]);
 }finally{await server.stop();server.remove();}
});
