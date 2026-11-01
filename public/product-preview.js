(() => {
  const urlInput = document.getElementById('f_url');
  const button = document.getElementById('btn_product_lookup');
  const status = document.getElementById('product_lookup_status');
  const preview = document.getElementById('product_image_preview');
  const token = new URLSearchParams(location.search).get('token');
  const fields = {
    title: document.getElementById('f_title'),
    image_url: document.getElementById('f_image'),
    price_cents: document.getElementById('f_price'),
  };
  const autoValues = new Map(), versions = new Map();
  let timer, controller, sequence = 0, activeUrl = '';
  const initialMessage = 'Paste a product link to fill in the name, image and price.';
  const validUrl = value => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
  };

  function showImage() {
    preview.hidden = true;
    const value = fields.image_url.value.trim();
    if (!value || !validUrl(value)) { preview.removeAttribute('src'); return; }
    preview.onload = () => { preview.hidden = false; };
    preview.onerror = () => { preview.hidden = true; };
    preview.alt = fields.title.value.trim() || 'Product image preview';
    if (preview.getAttribute('src') !== value) preview.src = value;
    else if (preview.complete && preview.naturalWidth) preview.hidden = false;
  }

  for (const [key, field] of Object.entries(fields)) {
    versions.set(key, 0);
    field.addEventListener('input', () => {
      versions.set(key, versions.get(key) + 1);
      autoValues.delete(key);
      if (key === 'image_url' || key === 'title') showImage();
    });
  }

  function stop() {
    clearTimeout(timer);
    sequence++;
    controller?.abort();
    controller = null;
    button.textContent = 'Get details';
    button.disabled = !urlInput.value.trim();
  }

  async function lookup() {
    clearTimeout(timer);
    const url = urlInput.value.trim();
    if (!url) return;
    if (!validUrl(url)) {
      status.textContent = 'Use a full product link starting with https://.';
      return;
    }
    stop();
    const requestId = sequence;
    const snapshot = new Map(Object.entries(fields).map(([key, field]) => [key, {
      version: versions.get(key),
      eligible: !field.value.trim() || field.value === autoValues.get(key),
    }]));
    const pending = new AbortController();
    controller = pending;
    button.disabled = true;
    button.textContent = 'Finding details…';
    status.textContent = 'Finding the item’s name, image and price…';
    try {
      const response = await fetch('/api/wishlist/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, url }), signal: pending.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (requestId !== sequence || url !== urlInput.value.trim()) return;
      if (!response.ok || !data.product) throw new Error(data.error || 'Could not read this product page. You can enter the details below.');
      const product = data.product;
      const foreignPrice = product.currency && product.currency !== 'AUD' && product.price_cents !== null;
      const values = { title: product.title, image_url: product.image_url,
        price_cents: product.price_cents === null || foreignPrice ? null : (product.price_cents / 100).toFixed(2) };
      let filled = 0;
      for (const [key, value] of Object.entries(values)) {
        if (value === null || !snapshot.get(key).eligible || versions.get(key) !== snapshot.get(key).version) continue;
        fields[key].value = value;
        autoValues.set(key, value);
        filled++;
      }
      showImage();
      status.textContent = foreignPrice
        ? `Item found. The shop’s price is ${product.currency} ${(product.price_cents / 100).toFixed(2)}; enter an AUD price below.`
        : filled ? 'Details filled. You can edit them before adding the item.' : 'Item found. Your edits have been kept.';
      if (product.price_cents === null && !fields.price_cents.value.trim()) {
        status.textContent += ' A clear price wasn’t available; you can add it below.';
      }
    } catch (error) {
      if (requestId === sequence && error.name !== 'AbortError') status.textContent = error.message || 'Could not read this page. You can enter the details below.';
    } finally {
      if (requestId === sequence) {
        controller = null;
        button.textContent = 'Get details';
        button.disabled = !urlInput.value.trim();
      }
    }
  }

  urlInput.addEventListener('input', () => {
    stop();
    const url = urlInput.value.trim();
    if (url !== activeUrl) {
      for (const [key, value] of autoValues) if (fields[key].value === value) fields[key].value = '';
      autoValues.clear();
      showImage();
      activeUrl = url;
    }
    status.textContent = url ? 'Looking up this link will fill any empty details.' : initialMessage;
    if (validUrl(url)) timer = setTimeout(lookup, 600);
  });
  button.addEventListener('click', lookup);
  window.wishlistProductPreview = {
    reset() {
      stop();
      autoValues.clear();
      activeUrl = '';
      status.textContent = initialMessage;
      preview.hidden = true;
      preview.removeAttribute('src');
      button.disabled = true;
    },
  };
})();
