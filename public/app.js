// Personal draw page. Assignments stay hidden until the server confirms a draw.
(function () {
  const token = new URLSearchParams(location.search).get('token');
  const el = id => document.getElementById(id);
  const drawBtn = el('drawBtn');
  const resendBtn = el('resendBtn');
  const wishlistBtn = el('wishlistBtn');
  const money = new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2,
    trailingZeroDisplay: 'stripIfInteger',
  });

  function showError(message) {
    el('error').textContent = message;
    el('loading').hidden = true;
  }

  function renderByTier(list) {
    el('recipients').replaceChildren();
    el('none').hidden = list.length > 0;
    for (const tier of list) {
      const tile = document.createElement('li');
      tile.className = `gift-tile${tier.recipient ? '' : ' unrevealed'}`;
      const label = document.createElement('div');
      label.className = 'gift-label';
      const name = document.createElement('span');
      name.className = 'gift-tier';
      name.textContent = tier.name;
      const budget = document.createElement('span');
      budget.className = 'gift-budget';
      budget.textContent = money.format(tier.budget_cents / 100);
      const recipient = document.createElement('strong');
      recipient.className = 'gift-recipient';
      recipient.textContent = tier.recipient || 'A little mystery…';
      const hint = document.createElement('span');
      hint.className = 'gift-hint';
      hint.textContent = tier.recipient ? 'A thoughtful gift, chosen by you.' : 'Draw to reveal your recipient.';
      label.append(name, budget);
      tile.append(label, recipient, hint);
      el('recipients').append(tile);
    }
  }

  async function loadMe() {
    el('error').textContent = '';
    try {
      const res = await fetch(`/api/me?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open your invitation. Please try again.');
      const list = data.recipients_by_tier || [];
      const complete = data.me.has_drawn && list.length > 0 && list.every(tier => !!tier.recipient);
      document.title = `${data.event.name} — Draw`;
      el('title').textContent = complete ? 'The secret’s yours to keep.' : 'A little Christmas mystery.';
      el('intro').textContent = complete
        ? 'Your recipients are revealed. Take a peek at their wishlists for a few good hints, then leave some of your own.'
        : 'Find out who you’re gifting to, gather a few hints, and make their day. Your part in the surprise starts here.';
      el('hello').textContent = `Hello, ${data.me.name}.`;
      el('eventName').textContent = data.event.name;
      el('gpp').textContent = data.event.tiers.length;
      el('recipients-title').textContent = complete ? 'Your recipients' : 'Who will you surprise?';
      el('draw-state').textContent = complete ? 'Draw saved' : 'Ready when you are';
      renderByTier(list);
      drawBtn.disabled = complete;
      drawBtn.hidden = complete;
      drawBtn.textContent = 'Draw now';
      wishlistBtn.hidden = !complete;
      resendBtn.hidden = !complete;
      resendBtn.disabled = !complete;
      el('status').hidden = false;
      el('loading').hidden = true;
      el('note').textContent = complete
        ? 'Your recipients are saved. We’ll also email you a copy with your wishlist link.'
        : 'One gift of each budget, with a different recipient for each whenever possible. Ready to find out?';
      return data;
    } catch (error) {
      showError(error.message || 'Could not open your invitation. Please try again.');
      drawBtn.disabled = true;
      resendBtn.disabled = true;
      return null;
    }
  }

  drawBtn.addEventListener('click', async () => {
    drawBtn.disabled = true;
    drawBtn.textContent = 'Drawing…';
    el('error').textContent = '';
    try {
      const response = await fetch('/api/draw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Draw failed. Please try again.');
      await loadMe();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && window.triggerConfetti) {
        window.triggerConfetti(0, 5000);
      }
    } catch (error) {
      showError(error.message || 'Draw failed. Please try again.');
      drawBtn.disabled = false;
    } finally {
      drawBtn.textContent = 'Draw now';
    }
  });

  wishlistBtn.addEventListener('click', () => { location.href = `/wishlists?token=${encodeURIComponent(token)}`; });
  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending…';
    el('error').textContent = '';
    try {
      const response = await fetch('/api/resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not resend your email.');
      el('note').textContent = 'Email re-sent. Check your inbox.';
    } catch (error) {
      showError(error.message || 'Could not resend your email.');
    } finally {
      resendBtn.textContent = 'Resend my email';
      resendBtn.disabled = false;
    }
  });

  if (token) loadMe();
  else showError('This invitation link is missing. Open the personal link in your invitation email, or ask the organiser to resend it.');
})();
