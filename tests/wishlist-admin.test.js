const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startServer}=require('./support/server');

test('only the configured participant can edit another wishlist, within the same event and without extra reservation or delete rights',async t=>{
 const server=await startServer({adminEmail:'chen.stephen151@gmail.com'});t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed({participants:[
  {name:'Stephen',email:'chen.stephen151@gmail.com'},
  {name:'Stephen',email:'chen.stephen141@gmail.com'},
  ...['Alex','Blair','Casey','Drew','Eden'].map(name=>({name,email:`${name.toLowerCase()}@example.test`}))]});
 for(const p of seeded.people){await server.request('POST','/api/draw',{token:p.token});p.id=(await server.request('GET',`/api/me?token=${p.token}`)).data.me.id;}
 const [admin,impostor]=seeded.people;
 const all=p=>server.request('GET',`/api/wishlists/all?token=${p.token}`);
 const initial=(await all(admin)).data;
 assert.equal(initial.me.is_wishlist_admin,true);
 for(const p of seeded.people.slice(1))assert.equal((await all(p)).data.me.is_wishlist_admin,false);
 const owner=seeded.people.find(p=>p!==admin&&p!==impostor&&!initial.allowed_owner_ids.includes(p.id));
 const created=await server.request('POST','/api/wishlist/item',{token:owner.token,title:'Mistyped original',url:'https://example.com/borken'});
 const id=created.data.item.id;
 const actualGivers=[];
 for(const p of seeded.people)if((await all(p)).data.allowed_owner_ids.includes(owner.id))actualGivers.push(p);
 assert.equal((await server.request('POST',`/api/wishlist/item/${id}/reserve`,{token:actualGivers[0].token})).status,200);
 const payload={title:'Corrected item',url:'https://example.com/fixed',image_url:'https://example.com/product.jpg',notes:'Correct size',price_cents:2000};
 assert.equal((await server.request('PUT',`/api/wishlist/item/${id}`,{token:'invalid',...payload})).status,401);
 assert.equal((await server.request('PUT',`/api/wishlist/item/${id}`,{token:impostor.token,...payload,is_wishlist_admin:true,email:admin.email,owner_id:admin.id})).status,403);
 const edit=await server.request('PUT',`/api/wishlist/item/${id}`,{token:admin.token,...payload});
 assert.equal(edit.status,200);assert.equal(edit.data.item.title,payload.title);assert.equal(edit.data.item.price_cents,2000);
 assert(!JSON.stringify(edit.data).includes('reserved'));
 const adminView=(await all(admin)).data.wishlists.find(list=>list.owner.id===owner.id).items[0];
 assert.equal(adminView.title,payload.title);assert.equal(adminView.is_reserved,0);assert.equal(adminView.reserved_by_me,0);
 assert.equal((await server.request('POST',`/api/wishlist/item/${id}/reserve`,{token:admin.token})).status,403);
 assert.equal((await server.request('POST',`/api/wishlist/item/${id}/unreserve`,{token:admin.token})).status,403);
 assert.equal((await server.request('DELETE',`/api/wishlist/item/${id}`,{token:admin.token})).status,403);
 const ownerView=(await all(owner)).data.wishlists.find(list=>list.owner.id===owner.id).items[0];
 assert.equal(ownerView.is_reserved,0);
 const giverView=(await all(actualGivers[0])).data.wishlists.find(list=>list.owner.id===owner.id).items[0];
 assert.equal(giverView.is_reserved,1,'editing preserves the private reservation');
 // POST cannot insert into another person's list, even with a forged owner_id.
 await server.request('POST','/api/wishlist/item',{token:admin.token,title:'Admin’s own idea',owner_id:owner.id,wishlist_id:edit.data.item.wishlist_id});
 assert.equal((await all(owner)).data.wishlists.find(list=>list.owner.id===owner.id).items.length,1);
 assert((await all(admin)).data.wishlists.find(list=>list.owner.id===admin.id).items.some(item=>item.title==='Admin’s own idea'));
 const foreign=await server.seed({eventName:'Another family'});
 await server.request('POST','/api/draw',{token:foreign.people[0].token});
 const foreignItem=await server.request('POST','/api/wishlist/item',{token:foreign.people[0].token,title:'Private event item'});
 assert.equal((await server.request('PUT',`/api/wishlist/item/${foreignItem.data.item.id}`,{token:admin.token,...payload})).status,403);
 assert.equal((await server.request('PUT',`/api/wishlist/item/${id}`,{token:owner.token,...payload,title:'Owner can still edit'})).status,200);
});

test('wishlist administration is disabled for empty configuration and still requires drawing',async t=>{
 const server=await startServer({adminEmail:''});t.after(async()=>{await server.stop();server.remove();});
 const seeded=await server.seed({participants:[{name:'Stephen',email:'chen.stephen151@gmail.com'},{name:'Another',email:'another@example.test'}]});
 const [a,b]=seeded.people;
 await server.request('POST','/api/draw',{token:b.token});
 const item=(await server.request('POST','/api/wishlist/item',{token:b.token,title:'Owner item'})).data.item;
 assert.equal((await server.request('PUT',`/api/wishlist/item/${item.id}`,{token:a.token,title:'Attempt'})).status,403);
 await server.request('POST','/api/draw',{token:a.token});
 assert.equal((await server.request('GET',`/api/wishlists/all?token=${a.token}`)).data.me.is_wishlist_admin,false);
 assert.equal((await server.request('PUT',`/api/wishlist/item/${item.id}`,{token:a.token,title:'Attempt'})).status,403);
});
