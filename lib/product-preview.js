const cheerio = require('cheerio');
const { fetchPublicPage, publicUrl, PreviewError } = require('./public-page');

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

function priceInCents(value) {
  if (typeof value === 'number') return value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  let price = value.trim().replace(/^(?:AU|US|NZ|CA|HK|SG|A)(?=\s*\$)/i, '').replace(/\b[A-Z]{3}\b/g, '').replace(/[$£€¥\s\u00a0]/g, '');
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

// Only use explicitly labelled product prices. A page-wide money search can
// mistake shipping, instalments or a recommendation for the item's price.
function displayedPrice($) {
  const candidates = new Map();
  const selectors = '[data-testid="ProductPrice"], [data-testid="product-price"], [data-test="product-price"], [data-product-price], .product-price, .product__price, .price-item--sale, .price-item--regular, .price__current, .current-price';
  $(selectors).each((i, el) => {
    const element = $(el);
    if (element.closest('aside, nav, header, footer, del, s, strike, [hidden], [aria-hidden="true"]').length) return;
    if (element.parents().toArray().some(parent => /(?:recommend|related|upsell|cross-sell)/i.test(`${$(parent).attr('class') || ''} ${$(parent).attr('id') || ''}`))) return;
    const copy = element.clone();
    copy.find('del, s, strike, [hidden], [aria-hidden="true"], .visually-hidden, .sr-only').remove();
    const value = text(element.attr('data-product-price') || copy.text());
    // Ignore ranges and any string containing several amounts (was/now, etc.).
    const match = value.match(/^(?:(AUD|USD|NZD|CAD|HKD|SGD|GBP|EUR)\s*|((?:AU|US|NZ|CA|HK|SG|A)?\$|£|€)\s*)?([\d.,\s]+)(?:\s*(AUD|USD|NZD|CAD|HKD|SGD|GBP|EUR))?$/i);
    if (!match) return;
    const amount = priceInCents(match[3]);
    if (amount === null) return;
    const symbols = { 'A$': 'AUD', 'AU$': 'AUD', 'US$': 'USD', 'NZ$': 'NZD', 'CA$': 'CAD', 'HK$': 'HKD', 'SG$': 'SGD', '£': 'GBP', '€': 'EUR' };
    const currency = (match[1] || match[4] || symbols[match[2]?.toUpperCase()] || '').toUpperCase();
    candidates.set(`${amount}:${currency}`, { amount, currency });
  });
  // Ambiguous prices are left for the participant to enter.
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

// Amazon frequently omits Open Graph/JSON-LD. Read its main product widgets,
// never the many unrelated prices and images in recommendation carousels.
function amazonDetails($, pageUrl) {
  const host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
  const currencies = { 'amazon.com':'USD', 'amazon.com.au':'AUD', 'amazon.co.uk':'GBP',
    'amazon.ca':'CAD', 'amazon.de':'EUR', 'amazon.fr':'EUR', 'amazon.it':'EUR',
    'amazon.es':'EUR', 'amazon.co.jp':'JPY', 'amazon.sg':'SGD' };
  if (!currencies[host] || !/\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(new URL(pageUrl).pathname)) return {};
  const name = $('#productTitle').first();
  const image = $('#landingImage, #imgBlkFront').first();
  let dynamic = [];
  try {
    dynamic = Object.entries(JSON.parse(image.attr('data-a-dynamic-image') || '{}'))
      .filter(([,dimensions]) => Array.isArray(dimensions) && dimensions.length===2 && dimensions.every(Number.isFinite))
      .sort((a,b) => b[1][0]*b[1][1]-a[1][0]*a[1][1]).map(([url]) => url);
  } catch { /* Ordinary src/hires attributes can still work. */ }
  const prices = new Map();
  $('#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price), #corePrice_feature_div .a-price:not(.a-text-price), #apex_desktop .a-price:not(.a-text-price), #apex_mobile .a-price:not(.a-text-price), #priceblock_ourprice, #priceblock_dealprice').each((i,el) => {
    const element=$(el);
    if (element.closest('aside, .a-carousel, .a-carousel-card, [hidden], [aria-hidden="true"], del, s, strike').length) return;
    const value=text(element.find('.a-offscreen').first().text() || element.text());
    const match=value.match(/^(?:([A-Z]{3})\s*|((?:AU|US|NZ|CA|HK|SG|A)?\$|£|€|¥)\s*)([\d.,\s]+)(?:\s*([A-Z]{3}))?$/);
    if (!match) return;
    const amount=priceInCents(match[3]);
    const currency=match[1] || match[4] || ({'A$':'AUD','AU$':'AUD','US$':'USD','CA$':'CAD','SG$':'SGD','£':'GBP','€':'EUR','¥':'JPY'}[match[2]]) || currencies[host];
    if (amount!==null) prices.set(`${amount}:${currency}`,{amount,currency});
  });
  const price=prices.size===1?[...prices.values()][0]:null;
  return { title:text(name.text() || name.attr('value')) || null,
    image_url:imageUrl([image.attr('data-old-hires'),...dynamic,image.attr('src')],pageUrl),
    price_cents:price?.amount ?? null, currency:price?.currency || null };
}

function extractProduct(buffer, pageUrl, contentType = '') {
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  const $ = Buffer.isBuffer(buffer) ? cheerio.loadBuffer(buffer, {
    encoding: { transportLayerEncodingLabel: charset || undefined },
  }) : cheerio.load(buffer);
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
    const page = new URL(pageUrl);
    const sku = String(product.sku || product.productID || '').toLowerCase();
    // Some ProductGroups put the price only on variants. Match the actual SKU
    // even when the parent and offer URLs use different slugs or locale paths.
    if (sku && page.pathname.toLowerCase().split('/').some(part => part.replace(/\.html?$/, '') === sku)) {
      score += 80 + (product.offers ? 40 : 0);
    }
    const offerUrls = [product.offers || []].flat().map(resolve).map(offer => offer?.url);
    const candidates = [product.url, product['@id'], ...offerUrls].filter(value => typeof value === 'string');
    let linkScore = 0;
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate, pageUrl);
        url.hash = ''; page.hash = '';
        if (url.origin === page.origin && url.pathname === page.pathname) linkScore = Math.max(linkScore, 10);
        if (url.href === page.href) linkScore = 30;
      } catch { /* Ignore invalid product IDs. */ }
    }
    return score + linkScore;
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
  if (price === null) {
    for (const value of [firstMeta('product:price:amount', 'og:price:amount', 'price', 'twitter:data1'), itemValue('price')]) {
      price = priceInCents(value);
      if (price !== null) break;
    }
  }
  if (price === null) {
    const visible = displayedPrice($);
    if (visible) { price = visible.amount; currency = visible.currency; }
  }
  currency = text(currency || firstMeta('product:price:currency', 'og:price:currency', 'pricecurrency') || itemValue('priceCurrency')).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) currency = '';
  let base = pageUrl;
  try { base = publicUrl($('base[href]').first().attr('href'), pageUrl).href; } catch { /* Use the fetched URL. */ }
  const productImage = Array.isArray(product?.image) ? product.image.map(resolve) : resolve(product?.image);
  const retailer = amazonDetails($, pageUrl);
  const result = {
    title: text(product?.name) || text(firstMeta('og:title', 'twitter:title')) || text(itemValue('name')) || retailer.title || title || null,
    image_url: imageUrl(productImage, base) || imageUrl(firstMeta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src') || itemValue('image') || $('link[rel="image_src"]').attr('href'), base) || retailer.image_url || null,
    price_cents: price ?? retailer.price_cents ?? null,
    currency: (price !== null ? currency : retailer.currency) || null,
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
