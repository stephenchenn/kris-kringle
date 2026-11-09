(() => {
  const token = new URLSearchParams(location.search).get('token');
  window.wishlistSocial = {
    decorate(card, owner, initial) {
      const toolbar=document.createElement('div');toolbar.className='recipient-actions';
      const buttons=document.createElement('div');buttons.className='recipient-action-buttons';
      const bell=document.createElement('button');bell.type='button';bell.className='recipient-bell';
      const nudge=document.createElement('button');nudge.type='button';nudge.className='recipient-nudge';
      const feedback=document.createElement('p');feedback.className='recipient-action-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
      const hint=document.createElement('p');hint.className='recipient-action-hint';
      const dialog=document.createElement('dialog');dialog.className='nudge-dialog';
      const form=document.createElement('form');
      const title=document.createElement('h2');title.textContent=`Nudge ${owner.name}`;
      title.id=`nudge-title-${owner.id}`;dialog.setAttribute('aria-labelledby',title.id);
      const privacy=document.createElement('p');privacy.textContent='Keep the surprise! Don’t reveal your name or clues that identify you. Your message will be sent anonymously.';
      privacy.id=`nudge-privacy-${owner.id}`;
      const label=document.createElement('label');label.textContent='Anonymous message (optional)';
      const note=document.createElement('textarea');note.rows=4;note.maxLength=500;note.className='input';
      note.id=`nudge-message-${owner.id}`;label.htmlFor=note.id;note.setAttribute('aria-describedby',privacy.id);
      const limit=document.createElement('p');limit.className='muted';limit.textContent='Up to 500 characters. Two nudges per recipient every 24 hours, shared by their gifters.';
      const actions=document.createElement('div');actions.className='nudge-dialog-actions';
      const cancel=document.createElement('button');cancel.type='button';cancel.className='btn-lite';cancel.textContent='Cancel';cancel.onclick=()=>dialog.close();
      const send=document.createElement('button');send.type='submit';send.textContent='Send anonymous nudge';
      actions.append(cancel,send);form.append(title,privacy,label,note,limit,actions);dialog.append(form);
      let state=initial || {notifications_enabled:false,can_remind:true}, busy=false;
      function paint() {
        bell.replaceChildren();
        const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');icon.textContent=state.notifications_enabled?'🔔':'';
        // Use an outlined bell rather than relying on platform emoji for the off state.
        if(!state.notifications_enabled) {
          icon.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="17" height="17"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>';
        }
        bell.append(icon,document.createTextNode(state.notifications_enabled?'Updates on':'Notify me'));
        bell.setAttribute('aria-pressed',String(state.notifications_enabled));
        bell.setAttribute('aria-label',`${state.notifications_enabled?'Disable':'Enable'} email updates for ${owner.name}`);
        bell.title='Email me when this person adds a wishlist item';bell.disabled=busy;
        nudge.textContent=state.can_remind?'Send a nudge':'Reminder requested';
        nudge.setAttribute('aria-label',`Send a wishlist reminder to ${owner.name}`);
        nudge.disabled=busy || !state.can_remind;
        nudge.title='Two nudges per recipient every 24 hours, shared by all their gifters';
        hint.textContent=state.notifications_enabled?'Emails can go to Spam. Mark our messages as “Not spam” to help future updates reach your inbox.':'';
        if(state.can_remind && state.reminders_remaining!=null)hint.textContent+=(hint.textContent?' ':'')+`${state.reminders_remaining} of 2 nudges available. The limit is shared over 24 hours.`;
        if(!state.can_remind && state.next_reminder_at) {
          const next=new Date(state.next_reminder_at).toLocaleString('en-AU',{dateStyle:'medium',timeStyle:'short'});
          hint.textContent+=(hint.textContent?' ':'')+`Another nudge is available after ${next}.`;
        }
      }
      async function act(kind,message='') {
        busy=true;feedback.textContent=kind==='notifications'?'Updating email preference…':'Requesting a reminder…';paint();
        try {
          const response=await fetch(`/api/wishlist/recipients/${encodeURIComponent(owner.id)}/${kind}`,{
            method:kind==='notifications'?'PUT':'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({token,...(kind==='notifications'?{enabled:!state.notifications_enabled}:{message})}),
          });
          const data=await response.json();
          if(typeof data.can_remind==='boolean')state={...state,...data};
          if(!response.ok)throw new Error(data.error || 'Please try again.');
          feedback.textContent=kind==='notifications'
            ? state.notifications_enabled?`Email updates are on for ${owner.name}.`:'Email updates are off.'
            : 'Reminder requested. They’ll get an email asking for a few gift ideas.';
        } catch(error){feedback.textContent=error.message || 'Please try again.';}
        finally {busy=false;paint();}
      }
      bell.addEventListener('click',()=>act('notifications'));
      nudge.addEventListener('click',()=>{dialog.showModal();note.focus();});
      form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity())return;dialog.close();act('remind',note.value.trim());});
      dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
      buttons.append(bell,nudge);toolbar.append(buttons,feedback,hint,dialog);card.appendChild(toolbar);paint();
    },
  };
})();
