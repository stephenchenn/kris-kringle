const cheerio = require('cheerio');
const { fetchPublicPage, publicUrl, PreviewError } = require('./public-page');

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

function priceInCents(value) {
  if (typeof value === 'number') return value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  let price = value.trim().replace(/\b[A-Z]{3}\b/g, '').replace(/[$£€¥\s\u00a0]/g, '');
  if (!/^\d[\d.,]*$/.test(price)) return null;
  const comma = price.lastIndexOf(','), dot = price.lastIndexOf('.');
  if (comma > dot && /,\d{1,2}$/.test(price)) price = price.replace(/\./g, '').replace(',', '.');
  else price = price.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(price)) return null;
  return priceInCents(Number(price));
}

function imageUrl(value, base) {
  for (const image of Array.isArray(value) ? value : [value]) {
    const candidate = typeof image === 'string' ? image : image?.contentUrl || image?.url || image?.['@id'];
    if (!candidate) continue;
    try { return publicUrl(candidate, base).href; } catch { /* Try another image. */ }
  }
  return null;
}

function extractProduct(buffer, pageUrl, contentType = '') {
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  const $ = cheerio.loadBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), {
    encoding: { transportLayerEncodingLabel: charset || undefined },
  });
  const meta = new Map();
  $('meta').each((i, el) => {
    const key = ($(el).attr('property') || $(el).attr('name') || $(el).attr('itemprop') || '').toLowerCase();
    if (key && !meta.has(key)) meta.set(key, $(el).attr('content') || '');
  });
  const firstMeta = (...names) => names.map(name => meta.get(name)).find(value => value?.trim()) || '';
  const title = text($('title').first().text());
  if (/^(just a moment|access denied|robot check|attention required|security check|verify (you are|your identity)|please wait)\b/i.test(title)) {
    throw new PreviewError('This shop blocks automatic lookups. You can enter the item details below.');
  }
  const nodes = [];
  function collect(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 15 || nodes.length >= 3000) return;
    if (Array.isArray(value)) { for (const child of value) collect(child, depth + 1); return; }
    nodes.push(value);
    for (const child of Object.values(value)) collect(child, depth + 1);
  }
  $('script').each((i, el) => {
    if (($(el).attr('type') || '').split(';')[0].trim().toLowerCase() !== 'application/ld+json') return;
    try { collect(JSON.parse($(el).text().trim().replace(/^<!--\s*|\s*-->$/g, ''))); }
    catch { /* Open Graph and ordinary metadata can still work. */ }
  });
  const references = new Map();
  for (const node of nodes.filter(node => node['@id'])) {
    if (Object.keys(node).length > Object.keys(references.get(node['@id']) || {}).length) references.set(node['@id'], node);
  }
  const resolve = node => node?.['@id'] ? references.get(node['@id']) || node : node;
  const isType = (node, type) => [node['@type']].flat().some(t => typeof t === 'string' && t.split(/[\/#]/).at(-1) === type);
  const products = nodes.filter(node => isType(node, 'Product') || isType(node, 'ProductGroup'));
  const score = product => {
    let score = (product.name ? 2 : 0) + (product.image ? 1 : 0) + (product.offers ? 2 : 0);
    const candidates = [product.url, product['@id']].filter(value => typeof value === 'string');
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate, pageUrl), page = new URL(pageUrl);
        url.hash = ''; page.hash = '';
        if (url.origin === page.origin && url.pathname === page.pathname) score += 10;
        if (url.href === page.href) score += 20;
      } catch { /* Ignore invalid product IDs. */ }
    }
    return score;
  };
  const product = products.sort((a, b) => score(b) - score(a))[0];
  let price = null, currency = '';
  for (const offerRef of [product?.offers || []].flat()) {
    const offer = resolve(offerRef);
    const specifications = [offer?.priceSpecification || []].flat().map(resolve);
    const amount = [offer?.price, ...specifications.map(item => item?.price), offer?.lowPrice]
      .map(priceInCents).find(value => value !== null);
    if (amount !== undefined) {
      price = amount;
      currency = offer.priceCurrency || specifications.find(item => item?.priceCurrency)?.priceCurrency || '';
      break;
    }
  }
  const productElement = $('[itemscope]').filter((i, el) => /\bProduct\b/.test($(el).attr('itemtype') || '')).first();
  const itemValue = property => {
    const element = productElement.find(`[itemprop="${property}"]`).first();
    return element.attr('content') || element.attr('href') || element.attr('src') || element.text();
  };
  if (price === null) price = priceInCents(firstMeta('product:price:amount', 'og:price:amount', 'price', 'twitter:data1') || itemValue('price'));
  currency = text(currency || firstMeta('product:price:currency', 'og:price:currency', 'pricecurrency') || itemValue('priceCurrency')).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) currency = '';
  let base = pageUrl;
  try { base = publicUrl($('base[href]').first().attr('href'), pageUrl).href; } catch { /* Use the fetched URL. */ }
  const productImage = Array.isArray(product?.image) ? product.image.map(resolve) : resolve(product?.image);
  const result = {
    title: text(product?.name) || text(firstMeta('og:title', 'twitter:title')) || text(itemValue('name')) || title || null,
    image_url: imageUrl(productImage, base) || imageUrl(firstMeta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src') || itemValue('image') || $('link[rel="image_src"]').attr('href'), base),
    price_cents: price,
    currency: currency || null,
  };
  if (!result.title && !result.image_url && result.price_cents === null) throw new PreviewError('No product details were found. You can enter the item details below.');
  return result;
}

function createProductPreview({ fetchPage = fetchPublicPage, now = Date.now, maxConcurrent = 4 } = {}) {
  const cache = new Map(), pending = new Map();
  return async value => {
    const url = publicUrl(value).href;
    const saved = cache.get(url);
    if (saved?.expires > now()) return saved.product;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= maxConcurrent) throw new PreviewError('Product lookup is busy. Please try again in a moment.', 503);
    const promise = (async () => {
      const page = await fetchPage(url);
      const product = extractProduct(page.buffer, page.url, page.contentType);
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(url, { product, expires: now() + 15 * 60 * 1000 });
      return product;
    })();
    pending.set(url, promise);
    try { return await promise; }
    finally { pending.delete(url); }
  };
}

module.exports = { extractProduct, priceInCents, createProductPreview };
