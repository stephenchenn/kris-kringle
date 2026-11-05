(() => {
  const dialog=document.getElementById('guess-picker');
  if(!dialog || typeof dialog.showModal!=='function')return;
  const options=document.getElementById('guess-picker-options');
  const context=document.getElementById('guess-picker-context');
  const clear=document.getElementById('guess-picker-clear');
  const mobile=matchMedia('(max-width: 640px)');
  const controls=new WeakMap();
  let active=null;

  function update(select){
    const control=controls.get(select);if(!control)return;
    const name=select.selectedOptions[0]?.textContent || 'Not sure yet…';
    if(control.value.textContent!==name)control.value.textContent=name;
    control.button.disabled=select.disabled;
    control.button.classList.toggle('is-empty',!select.value);
    control.button.setAttribute('aria-label',`Choose gifter for ${select.dataset.recipientName}, ${select.dataset.tierName}: ${name}`);
    control.label.htmlFor=mobile.matches?control.button.id:select.id;
  }
  function unavailableReason(select,value){
    const others=[...document.querySelectorAll('#gifter-guess-fields select')].filter(other=>other!==select && other.value===value);
    const other=others.find(other=>other.dataset.tierId===select.dataset.tierId) || others.find(other=>other.dataset.recipientId===select.dataset.recipientId);
    return other?`Already chosen for ${other.dataset.recipientName} · ${other.dataset.tierName}`:'Already chosen elsewhere in your guesses';
  }
  function choose(value){
    if(!active || active.disabled || !active.isConnected)return;
    const option=[...active.options].find(option=>option.value===value);
    if(!option || option.disabled)return;
    if(active.value!==value){active.value=value;active.dispatchEvent(new Event('change',{bubbles:true}));}
    dialog.close();
  }
  function open(select){
    if(select.disabled || !select.isConnected || dialog.open)return;
    active=select;
    context.textContent=`${select.dataset.recipientName} · ${select.dataset.tierName} · ${select.dataset.budget}`;
    options.replaceChildren();
    for(const option of [...select.options].filter(option=>option.value)){
      const button=document.createElement('button');button.type='button';button.className='guess-picker-option';button.dataset.value=option.value;
      button.disabled=option.disabled;button.setAttribute('aria-pressed',String(option.selected));
      const copy=document.createElement('span');copy.className='guess-picker-copy';
      const name=document.createElement('span');name.textContent=option.textContent;copy.append(name);
      if(option.disabled){const reason=document.createElement('small');reason.textContent=unavailableReason(select,option.value);copy.append(reason);}
      const mark=document.createElement('span');mark.className='guess-picker-mark';mark.setAttribute('aria-hidden','true');mark.textContent=option.selected?'✓':'○';
      button.append(copy,mark);button.addEventListener('click',()=>choose(option.value));options.append(button);
    }
    clear.disabled=!select.value;
    document.documentElement.classList.add('guess-picker-open');
    const trigger=controls.get(select).button;trigger.setAttribute('aria-expanded','true');
    dialog.showModal();
    const focus=options.querySelector('[aria-pressed="true"]:enabled') || options.querySelector('button:enabled') || document.getElementById('guess-picker-close');
    focus.focus({preventScroll:true});
    // Scroll only the names, leaving the page and the fixed close/clear actions
    // in place. This also brings a previously selected name into view.
    if(options.contains(focus)){
      const target=focus.getBoundingClientRect(),list=options.getBoundingClientRect();
      if(target.top<list.top)options.scrollTop+=target.top-list.top;
      else if(target.bottom>list.bottom)options.scrollTop+=target.bottom-list.bottom;
    }
  }
  function enhance(select,label){
    const button=document.createElement('button');button.type='button';button.className='guess-picker-trigger';button.id=select.id+'-picker';
    button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls',dialog.id);button.setAttribute('aria-expanded','false');
    const value=document.createElement('span');
    const chevron=document.createElement('span');chevron.className='guess-picker-chevron';chevron.setAttribute('aria-hidden','true');chevron.textContent='⌄';
    button.append(value,chevron);select.after(button);select.parentElement.classList.add('guess-has-picker');
    controls.set(select,{button,value,label});button.addEventListener('click',()=>open(select));update(select);
  }
  document.getElementById('guess-picker-close').addEventListener('click',()=>dialog.close());
  clear.addEventListener('click',()=>choose(''));
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const bounds=dialog.getBoundingClientRect();
    if(event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom)dialog.close();
  });
  dialog.addEventListener('close',()=>{
    document.documentElement.classList.remove('guess-picker-open');
    const select=active;active=null;
    if(!select)return;
    const control=controls.get(select);control.button.setAttribute('aria-expanded','false');
    if(select.isConnected && !select.disabled)(mobile.matches?control.button:select).focus({preventScroll:true});
  });
  mobile.addEventListener('change',()=>{
    if(dialog.open)dialog.close();
    for(const select of document.querySelectorAll('#gifter-guess-fields select'))update(select);
  });
  window.gifterPicker={enhance,update,isOpen:()=>dialog.open,close:()=>{if(dialog.open)dialog.close();}};
})();
