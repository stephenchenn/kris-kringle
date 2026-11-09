window.createWishlistProductPreview = ({urlInput,button,status,message,heading,dots,preview,fields,editing=false}) => {
  const token = new URLSearchParams(location.search).get('token');
  const autoValues = new Map(), versions = new Map();
  let timer, controller, sequence = 0, activeUrl = '';
  const initialMessage = editing?'Use Autofill details to refresh the name, image and price from this link.':'Paste a product link to fill in the name, image and price.';
  const validUrl = value => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); }
    catch { return false; }
  };

  function setLoading(loading) {
    status.classList.toggle('is-loading', loading);
    heading.hidden = !loading;
    heading.textContent = loading ? 'Finding product details' : '';
    dots.hidden = !loading;
    button.setAttribute('aria-busy', String(loading));
    button.textContent = loading ? 'Finding details…' : editing ? 'Autofill details' : 'Get details';
    button.disabled = loading || !urlInput.value.trim();
    if (loading) message.textContent = 'Hang tight — fetching the name, photo and price. This can take a few seconds.';
  }

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
    setLoading(false);
  }

  async function lookup() {
    clearTimeout(timer);
    const url = urlInput.value.trim();
    if (!url) return;
    if (!validUrl(url)) {
      message.textContent = 'Use a full product link starting with https://.';
      return;
    }
    stop();
    const requestId = sequence;
    const snapshot = new Map(Object.entries(fields).map(([key, field]) => [key, {
      version: versions.get(key),
      eligible: editing || !field.value.trim() || field.value === autoValues.get(key),
    }]));
    const pending = new AbortController();
    controller = pending;
    setLoading(true);
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
        if (value == null || !snapshot.get(key).eligible || versions.get(key) !== snapshot.get(key).version) continue;
        fields[key].value = value;
        autoValues.set(key, value);
        filled++;
      }
      showImage();
      message.textContent = foreignPrice
        ? `Item found. The shop’s price is ${product.currency} ${(product.price_cents / 100).toFixed(2)}; enter an AUD price below.`
        : filled ? `Details filled. You can edit them before ${editing?'saving':'adding'} the item.` : 'Item found. Your edits have been kept.';
      if (product.price_cents === null && !fields.price_cents.value.trim()) {
        message.textContent += ' A clear price wasn’t available; you can add it below.';
      }
    } catch (error) {
      if (requestId === sequence && error.name !== 'AbortError') message.textContent = error.message || 'Could not read this page. You can enter the details below.';
    } finally {
      if (requestId === sequence) {
        controller = null;
        setLoading(false);
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
    message.textContent = url ? 'Looking up this link will fill any empty details.' : initialMessage;
    if (validUrl(url) && !editing) {
      // Show progress during the debounce too, before people start typing.
      setLoading(true);
      timer = setTimeout(lookup, 600);
    }
  });
  button.addEventListener('click', lookup);
  message.textContent=initialMessage;setLoading(false);
  return {
    stop,
    reset() {
      stop();
      autoValues.clear();
      activeUrl = '';
      message.textContent = initialMessage;
      preview.hidden = true;
      preview.removeAttribute('src');
      button.disabled = true;
    },
  };
};
window.wishlistProductPreview=window.createWishlistProductPreview({
  urlInput:document.getElementById('f_url'),button:document.getElementById('btn_product_lookup'),
  status:document.getElementById('product_lookup_status'),message:document.getElementById('product_lookup_message'),
  heading:document.getElementById('product_lookup_title'),dots:document.getElementById('product_lookup_dots'),
  preview:document.getElementById('product_image_preview'),fields:{title:document.getElementById('f_title'),
    image_url:document.getElementById('f_image'),price_cents:document.getElementById('f_price')},
});
