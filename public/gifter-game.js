(() => {
  const token=new URLSearchParams(location.search).get('token');
  if(!token)return;
  const section=document.getElementById('gifter-game');
  const form=document.getElementById('gifter-guess-form');
  const fields=document.getElementById('gifter-guess-fields');
  const status=document.getElementById('gifter-game-status');
  const feedback=document.getElementById('guesses-feedback');
  const save=document.getElementById('save-guesses');
  const board=document.getElementById('guesses-board');
  const boardTitle=document.getElementById('guesses-board-title');
  let state=null,dirty=false,saving=false;
  const money=cents=>new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}).format(cents/100);
  const date=(value,precise=false)=>value?new Date(value).toLocaleString('en-AU',{timeZone:state.timezone,dateStyle:'medium',timeStyle:precise?'medium':'short'}):'—';
  function duplicateOptions(){
    const selects=[...fields.querySelectorAll('select')];
    for(const select of selects)for(const option of select.options){
      option.disabled=!!option.value && selects.some(other=>other!==select && other.value===option.value &&
        (other.dataset.tierId===select.dataset.tierId || (state.tiers.length<=state.participants.length-1 && other.dataset.recipientId===select.dataset.recipientId)));
    }
    const completed=selects.filter(select=>select.value).length;
    document.getElementById('guess-progress').textContent=`${completed} of ${state.guess_count} guesses picked · Your ${state.known_assignments.length} gifts are already known and don’t count.`;
  }
  function render(data){
    state=data;section.hidden=false;
    const results=data.phase==='results',open=data.phase==='open';
    section.classList.toggle('results',results);
    boardTitle.textContent=results?'The great gifter reveal':'Everyone’s guesses';
    status.textContent=data.phase==='unavailable'?'The organiser needs to set the event date before guesses open.'
      : open?`Who’s gifting to whom? Edits close ${date(data.locks_at)} (${data.timezone}). Results appear ${date(data.reveals_at)}.`
      : results?'The secret’s out! Most correct guesses wins. Ties go to the earliest average last-edit time of correct guesses.'
      : `Guesses are locked for the event. The reveal is ${date(data.reveals_at)} (${data.timezone}).`;
    if(!dirty || !open){
      fields.replaceChildren();dirty=false;
      const own=data.rows.find(row=>row.participant.id===data.me_id);
      for(const recipient of data.participants){
        const group=document.createElement('fieldset');group.className='guess-recipient';
        const legend=document.createElement('legend');legend.textContent=recipient.name+(recipient.id===data.me_id?' (you)':'');group.append(legend);
        const tierFields=document.createElement('div');tierFields.className='guess-recipient-tiers';group.append(tierFields);
        for(const tier of data.tiers){
          const row=document.createElement('div');row.className='guess-field';
          const label=document.createElement('label');label.htmlFor=`guess-${recipient.id}-${tier.id}`;label.textContent=`${tier.name} · ${money(tier.budget_cents)}`;
          row.append(label);
          if(data.known_assignments.some(known=>known.recipient_id===recipient.id && known.tier_id===tier.id)){
            const known=document.createElement('p');known.className='guess-known';known.textContent='🎁 You’re gifting this';
            const hint=document.createElement('span');hint.className='guess-edited';hint.textContent='Already known · not scored';row.append(known,hint);
          }else{
            const select=document.createElement('select');select.id=label.htmlFor;select.dataset.tierId=tier.id;select.dataset.recipientId=recipient.id;select.className='input';select.disabled=!open;
            const unsure=document.createElement('option');unsure.value='';unsure.textContent='Not sure yet…';select.append(unsure);
            for(const person of data.participants.filter(person=>person.id!==data.me_id && person.id!==recipient.id)){
              const option=document.createElement('option');option.value=person.id;option.textContent=person.name;select.append(option);
            }
            const guess=own?.guesses.find(guess=>guess.recipient_id===recipient.id && guess.tier_id===tier.id);
            select.value=guess?.guessed_gifter_id || '';
            const edited=document.createElement('span');edited.className='guess-edited';edited.textContent=guess?.edited_at?`Last changed ${date(guess.edited_at,true)}`:'Who do you reckon?';
            select.addEventListener('change',()=>{dirty=true;feedback.textContent='You have unsaved guesses.';duplicateOptions();});
            row.append(select,edited);
          }
          tierFields.append(row);
        }
        fields.append(group);
      }
      duplicateOptions();
    }
    save.disabled=!open || saving;save.textContent=saving?'Saving…':open?'Save my guesses':'Guesses locked';
    document.getElementById('your-guesses-title').textContent=results?'Your guesses, revealed':'A little detective work';
    const expanded=new Set([...board.querySelectorAll('details[open]')].map(details=>details.dataset.participantId));
    board.replaceChildren();
    for(const row of data.rows){
      const card=document.createElement('article');card.className='guess-card';
      const heading=document.createElement('div');heading.className='guess-card-heading';
      const name=document.createElement('h4');name.textContent=row.participant.name+(row.participant.id===data.me_id?' (you)':'');
      if(results){const rank=document.createElement('span');rank.className='guess-rank';rank.textContent=`#${row.rank}`;heading.append(rank);}
      heading.append(name);card.append(heading);
      if(results){
        const score=document.createElement('p');score.className='guess-score';score.textContent=`${row.correct_count} of ${row.possible_count} correct`;card.append(score);
      }
      const details=document.createElement('details');details.dataset.participantId=row.participant.id;details.open=expanded.has(row.participant.id);
      const summary=document.createElement('summary');summary.textContent=results?'See guesses & answers':'See their guesses';details.append(summary);
      for(const recipient of data.participants){
        const recipientHeading=document.createElement('h5');recipientHeading.className='public-guess-recipient';recipientHeading.textContent=`Gifts for ${recipient.name}`;details.append(recipientHeading);
        for(const guess of row.guesses.filter(guess=>guess.recipient_id===recipient.id)){
          const line=document.createElement('p');line.className='public-guess';
          const tier=document.createElement('span');tier.className='public-guess-tier';tier.textContent=guess.tier_name;
          const gifter=document.createElement('strong');gifter.textContent=guess.excluded?'Already known':guess.guessed_gifter_name || '—';
          line.append(tier,gifter);details.append(line);
          if(results){
            const verdict=document.createElement('p');verdict.className=`guess-verdict ${guess.excluded?'excluded':guess.correct?'correct':'incorrect'}`;
            verdict.textContent=guess.excluded?`Their gift · not scored (${guess.actual_gifter_name})`:guess.correct?'✓ Correct!':`Actual gifter: ${guess.actual_gifter_name || '—'}`;details.append(verdict);
          }
        }
      }
      card.append(details);
      if(results && row.average_correct_guess_at){
        const timing=document.createElement('p');timing.className='guess-timing';timing.textContent=`Average correct guess: ${date(row.average_correct_guess_at,true)}`;timing.title=row.average_correct_guess_at;card.append(timing);
      }
      board.append(card);
    }
  }
  async function load(){
    try{
      const response=await fetch(`/api/wishlist/guesses?token=${encodeURIComponent(token)}`,{cache:'no-store'});
      if([401,403].includes(response.status))return;
      const data=await response.json();if(!response.ok)throw new Error(data.error || 'Could not load guesses.');
      render(data);
    }catch(error){section.hidden=false;status.textContent='The guesses board couldn’t load. Refresh the page to try again.';}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(saving || state?.phase!=='open')return;
    saving=true;save.disabled=true;save.textContent='Saving…';feedback.textContent='';
    try{
      const guesses=[...fields.querySelectorAll('select')].map(select=>({recipient_id:select.dataset.recipientId,tier_id:select.dataset.tierId,guessed_gifter_id:select.value || null}));
      const response=await fetch('/api/wishlist/guesses',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,guesses})});
      const data=await response.json();if(!response.ok){if(response.status===409)await load();throw new Error(data.error || 'Could not save guesses.');}
      dirty=false;render(data);feedback.textContent='Guesses saved. Everyone can see them on the board.';
    }catch(error){feedback.textContent=error.message;}
    finally{saving=false;save.disabled=state?.phase!=='open';save.textContent=state?.phase==='open'?'Save my guesses':'Guesses locked';}
  });
  load();
  setInterval(()=>{if(!document.hidden && !saving)load();},30000);
})();
