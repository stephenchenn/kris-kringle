(() => {
  const $=id=>document.getElementById(id);
  let csrf='',selected=null,busy=false,rowId=0;
  const feedback=$('admin-feedback');
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
  function signedIn(value){
    $('login-panel').hidden=value;$('admin-console').hidden=!value;$('sign-out').hidden=!value;
    if(!value){csrf='';selected=null;$('event-list').replaceChildren();$('event-participants').replaceChildren();$('admin-secret').value='';}
  }
  async function api(method,route,body){
    const response=await fetch('/api/admin/'+route,{method,headers:{'Content-Type':'application/json',...(csrf?{'X-Admin-CSRF':csrf}:{})},credentials:'same-origin',
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json().catch(()=>({}));
    if(response.status===401)signedIn(false);
    if(!response.ok)throw new Error(data.error||'Something went wrong. Please try again.');
    return data;
  }
  async function action(work){
    if(busy)return;busy=true;feedback.textContent='Working…';
    const buttons=Array.from(document.querySelectorAll('button'));for(const button of buttons)button.disabled=true;
    try{await work();}catch(error){feedback.textContent=error.message;}
    finally{busy=false;for(const button of buttons)if(button.isConnected)button.disabled=false;}
  }
  function addRow(host,kind,values={},removable=true){
    const row=element('div','','form-row');row.dataset.id=values.id||'';
    const fields=element('div','','form-row-fields');const number=++rowId;
    for(const [key,label,type] of kind==='person'?[['name','Name','text'],['email','Email address','email']]:[['name','Tier name','text'],['budget','Budget · AUD','number']]){
      const wrapper=element('div');const input=element('input');input.type=type;input.required=true;input.dataset.key=key;input.id=`admin-row-${number}-${key}`;
      const title=element('label',label);title.htmlFor=input.id;
      if(key==='budget'){input.min='0';input.max='1000000';input.step='0.01';input.value=values.budget??'';}
      else{input.maxLength=key==='email'?254:kind==='person'?100:80;input.value=values[key]||'';}
      wrapper.append(title,input);fields.append(wrapper);
    }
    row.append(fields);
    if(removable){const remove=element('button',kind==='person'?'Remove participant':'Remove tier','secondary remove-row');remove.type='button';remove.onclick=()=>row.remove();row.append(remove);}
    host.append(row);return row;
  }
  function rows(host){return Array.from(host.children).map(row=>({id:row.dataset.id,...Object.fromEntries(Array.from(row.querySelectorAll('input')).map(input=>[input.dataset.key,input.value.trim()]))}));}
  function tiers(host){return rows(host).map(row=>({id:row.id,name:row.name,budgetCents:Math.round(Number(row.budget)*100)}));}
  function newEvent(){
    selected=null;sessionStorage.removeItem('admin-create-request');$('create-panel').hidden=false;$('event-panel').hidden=true;
    $('create-form').reset();$('create-people').replaceChildren();$('create-tiers').replaceChildren();
    addRow($('create-tiers'),'tier',{name:'BIG GIFT',budget:'50'});addRow($('create-tiers'),'tier',{name:'small gift',budget:'20'});
    addRow($('create-people'),'person');addRow($('create-people'),'person');feedback.textContent='';
  }
  async function listEvents(){
    const {events}=await api('GET','events');$('event-list').replaceChildren();
    if(!events.length)$('event-list').append(element('p','Your first event starts here.','muted'));
    for(const event of events){
      const button=element('button',event.name,'event-choice');button.type='button';button.setAttribute('aria-current',String(selected?.event.id===event.id));
      button.append(element('span',`${event.drawn_count} of ${event.participant_count} drawn`));
      button.onclick=()=>action(async()=>{await openEvent(event.id);feedback.textContent='';});$('event-list').append(button);
    }
  }
  function renderEvent(data){
    selected=data;const {event,participants}=data;
    $('create-panel').hidden=true;$('event-panel').hidden=false;$('selected-event-title').textContent=event.name;
    $('event-progress').textContent=`${participants.filter(p=>p.has_drawn).length} of ${participants.length} participants have drawn.`;
    $('edit-event-name').value=event.name;$('edit-event-date').value=(event.event_date||'').slice(0,10);$('edit-event-location').value=event.location||'';
    $('edit-tiers').replaceChildren();for(const tier of event.tiers)addRow($('edit-tiers'),'tier',{id:tier.id,name:tier.name,budget:(tier.budget_cents/100).toFixed(2)},false);
    $('event-participants').replaceChildren();$('invite-feedback').textContent='';
    for(const person of participants){
      const card=element('article','','participant'),label=element('label'),checkbox=element('input');checkbox.type='checkbox';checkbox.value=person.id;checkbox.checked=!person.has_drawn&&!person.invitation_sent_at;
      const name=element('span');name.append(element('strong',person.name),element('span',person.email,'participant-email'));label.append(checkbox,name);
      const status=element('p',person.has_drawn?'Drawn':person.invitation_sent_at?'Invited · waiting to draw':'Waiting · no recorded invitation','participant-status');
      const links=element('nav','','participant-links');
      for(const [text,url] of [['Draw link',person.draw_link],['Wishlist link',person.wishlist_link]]){const link=element('a',text);link.href=url;link.target='_blank';link.rel='noopener noreferrer';links.append(link);}
      card.append(label,status,links);$('event-participants').append(card);
    }
  }
  async function openEvent(id){renderEvent(await api('GET','events/'+encodeURIComponent(id)));await listEvents();}
  $('login-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
    const session=await api('POST','session',{secret:$('admin-secret').value});csrf=session.csrf;$('admin-secret').value='';signedIn(true);
    newEvent();await listEvents();feedback.textContent='Signed in. Choose an event or create a new one.';
  });});
  $('sign-out').onclick=()=>action(async()=>{await api('DELETE','session');signedIn(false);feedback.textContent='Signed out.';});
  $('new-event').onclick=()=>{newEvent();listEvents().catch(error=>{feedback.textContent=error.message;});};
  $('add-person').onclick=()=>addRow($('create-people'),'person');$('add-tier').onclick=()=>addRow($('create-tiers'),'tier');
  $('create-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
    const participants=rows($('create-people')).map(({name,email})=>({name,email}));
    if(participants.length<2)throw new Error('Add at least two participants.');
    if(new Set(participants.map(p=>p.email.toLowerCase())).size!==participants.length)throw new Error('Each participant needs a different email address.');
    if(!sessionStorage.getItem('admin-create-request'))sessionStorage.setItem('admin-create-request',crypto.randomUUID());
    const result=await api('POST','events',{requestKey:sessionStorage.getItem('admin-create-request'),eventName:$('event-name').value,eventDate:$('event-date').value,
      location:$('event-location').value,participants,tiers:tiers($('create-tiers'))});
    sessionStorage.removeItem('admin-create-request');await openEvent(result.event.id);feedback.textContent='Event created. Review the participants, then send their invitations below.';
  });});
  $('edit-event-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
    const date=$('edit-event-date').value;const original=selected.event.event_date||'';
    const result=await api('PUT','events/'+encodeURIComponent(selected.event.id),{eventName:$('edit-event-name').value,eventDate:date===original.slice(0,10)?original:date,
      location:$('edit-event-location').value,tiers:tiers($('edit-tiers'))});
    renderEvent(result);await listEvents();feedback.textContent='Event details saved. Existing draws and wishlists are preserved.';
  });});
  $('select-uninvited').onclick=()=>{for(const input of $('event-participants').querySelectorAll('input')){const person=selected.participants.find(p=>p.id===input.value);input.checked=!person.has_drawn&&!person.invitation_sent_at;}};
  $('clear-selection').onclick=()=>{for(const input of $('event-participants').querySelectorAll('input'))input.checked=false;};
  $('refresh-event').onclick=()=>action(async()=>{await openEvent(selected.event.id);feedback.textContent='Draw status refreshed.';});
  $('send-invitations').onclick=()=>action(async()=>{
    const ids=Array.from($('event-participants').querySelectorAll('input:checked')).map(input=>input.value);
    if(!ids.length)throw new Error('Select at least one participant to invite.');
    if(!confirm(`Send ${ids.length} invitation email${ids.length===1?'':'s'} for “${selected.event.name}”?`)){feedback.textContent='Invitations not sent.';return;}
    const result=await api('POST','send-invites',{eventId:selected.event.id,participantIds:ids});await openEvent(selected.event.id);
    feedback.textContent='Invitation sending complete.';
    $('invite-feedback').textContent=`${result.sent} invitation${result.sent===1?'':'s'} accepted by the email server.`+(result.failed.length?' Could not send to: '+result.failed.map(p=>p.email).join(', ')+'. Select only those participants to retry.':'');
  });
  newEvent();
  api('GET','session').then(async session=>{csrf=session.csrf;signedIn(true);await listEvents();}).catch(error=>{signedIn(false);if(!error.message.includes('Sign in'))feedback.textContent=error.message;});
})();
