const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { extractProduct, priceInCents, createProductPreview } = require('../lib/product-preview');
const { fetchPublicPage, publicUrl } = require('../lib/public-page');
const { startServer } = require('./support/server');

const page = json => `<html><head><meta charset="utf-8"><title>Shop</title><script type="application/ld+json">${JSON.stringify(json)}</script></head></html>`;
const product = { '@type': 'Product', name: 'Test grinder', image: '/grinder.jpg', offers: { '@type': 'Offer', price: '99.50', priceCurrency: 'AUD' } };

test('product metadata follows JSON-LD references and prioritizes the linked product over recommendations', () => {
  const html = page({ '@graph': [
    { '@type': 'Offer', '@id': '#offer', price: '49.95', priceCurrency: 'AUD' },
    { '@type': 'ImageObject', '@id': '#image', contentUrl: '/images/lipstick.jpg' },
    { ...product, name: 'Unrelated recommendation', url: 'https://shop.example.test/other' },
    { '@type': ['Thing', 'Product'], name: 'Café lipstick', url: 'https://shop.example.test/lipstick', image: { '@id': '#image' }, offers: { '@id': '#offer' } },
  ] });
  assert.deepEqual(extractProduct(html, 'https://shop.example.test/lipstick'), {
    title: 'Café lipstick', image_url: 'https://shop.example.test/images/lipstick.jpg', price_cents: 4995, currency: 'AUD',
  });
});

test('Open Graph and microdata fill missing details without guessing a price', () => {
  const og = `<meta charset="utf-8"><meta property="og:title" content="Tee &amp; tank"><meta name="twitter:image" content="//cdn.example.test/tee.jpg"><meta property="product:price:amount" content="$1,299.95"><meta property="product:price:currency" content="AUD"><script type="application/ld+json">invalid</script>`;
  assert.deepEqual(extractProduct(og, 'https://shop.example.test/tee'), {
    title: 'Tee & tank', image_url: 'https://cdn.example.test/tee.jpg', price_cents: 129995, currency: 'AUD',
  });
  const microdata = '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Tape measure</span><img itemprop="image" src="/tape.jpg"><span itemprop="price" content="16.49"></span><meta itemprop="priceCurrency" content="AUD"></div>';
  assert.equal(extractProduct(microdata, 'https://shop.example.test/tape').price_cents, 1649);
  assert.equal(extractProduct('<title>Item with no price</title>', 'https://shop.example.test/item').price_cents, null);
  assert.equal(priceInCents('EUR 1.234,56'), 123456);
  assert.equal(priceInCents('19,95'), 1995);
  assert.equal(priceInCents(0), 0);
  for (const invalid of ['Was $100 now $50', 'free shipping', '', '-12', NaN, Infinity]) assert.equal(priceInCents(invalid), null);
});

test('price specifications, encoding, image safety and bot challenges are handled', () => {
  const specification = page({ ...product, image: 'javascript:alert(1)', offers: { priceSpecification: { price: 24.9, priceCurrency: 'AUD' } } });
  const details = extractProduct(specification, 'https://shop.example.test/item');
  assert.equal(details.price_cents, 2490);
  assert.equal(details.image_url, null);
  const latin = Buffer.from('<title>Caf\xe9 cream</title>', 'latin1');
  assert.equal(extractProduct(latin, 'https://shop.example.test/cream', 'text/html; charset=iso-8859-1').title, 'Café cream');
  assert.throws(() => extractProduct('<title>Just a moment...</title>', 'https://shop.example.test/item'), /blocks automatic lookups/);
  assert.throws(() => extractProduct('<html></html>', 'https://shop.example.test/item'), /No product details/);
});

test('unsafe addresses and URL schemes are rejected, including alternate loopback forms', () => {
  for (const url of ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://192.168.0.1/',
    'http://localhost./', 'http://service.local/', 'https://example.com:3000/', 'https://user:pass@example.com/',
    'file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)']) {
    assert.throws(() => publicUrl(url), { status: 400 }, url);
  }
  assert.equal(publicUrl('https://shop.example.test/item#details').href, 'https://shop.example.test/item');
});

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  let dnsCalls = 0;
  return { requests, get dnsCalls() { return dnsCalls; },
    options: {
      lookup: async () => { dnsCalls++; return [{ address: '8.8.8.8', family: 4 }]; },
      request(url, settings, callback) {
        settings.lookup(url.hostname, { all: true }, (error, addresses) => {
          assert.equal(error, null);
          assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
        });
        // Test transport connects only to this fixture; production uses the pinned address.
        return http.request(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, {
          ...settings, lookup: undefined, family: 4,
        }, callback);
      },
    },
  };
}

test('public fetch follows checked redirects, pins DNS and reads compressed HTML without credentials', async t => {
  const local = await fixture(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/product' }); res.end(); }
    else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
      res.end(gzipSync(page(product)));
    }
  });
  const result = await fetchPublicPage('https://shop.example.test/start', local.options);
  assert.equal(result.url, 'https://shop.example.test/product');
  assert.equal(extractProduct(result.buffer, result.url).title, product.name);
  assert.equal(local.dnsCalls, 2);
  assert.equal(local.requests.length, 2);
  for (const request of local.requests) {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.referer, undefined);
  }
});

test('private DNS results and redirects are blocked before making an internal request', async t => {
  const local = await fixture(t, (req, res) => { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); });
  await assert.rejects(fetchPublicPage('https://shop.example.test/product', { ...local.options,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }), { status: 400 });
  assert.equal(local.requests.length, 0);
  await assert.rejects(fetchPublicPage('https://shop.example.test/product', local.options), { status: 400 });
  assert.equal(local.requests.length, 1);
});

test('fetch has limits for blocked shops, files, oversized pages, redirect loops and timeouts', async t => {
  const local = await fixture(t, (req, res) => {
    if (req.url === '/blocked') { res.writeHead(403); res.end(); }
    if (req.url === '/file') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('not HTML'); }
    if (req.url === '/large') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); res.end(gzipSync('a'.repeat(4 * 1024 * 1024 + 1))); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    // /slow deliberately leaves the request unanswered.
  });
  for (const route of ['blocked', 'file', 'large', 'loop']) {
    await assert.rejects(fetchPublicPage(`https://shop.example.test/${route}`, local.options), { status: 422 });
  }
  await assert.rejects(fetchPublicPage('https://shop.example.test/slow', { ...local.options, timeoutMs: 100 }), { status: 504 });
  await assert.rejects(fetchPublicPage('https://shop.example.test/slow-dns', { ...local.options, timeoutMs: 100, lookup: () => new Promise(() => {}) }), { status: 504 });
});

test('preview cache coalesces requests, expires and bounds concurrent shop requests', async () => {
  let clock = 0, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const preview = createProductPreview({ now: () => clock, maxConcurrent: 1, fetchPage: async url => {
    calls++;
    await gate;
    return { url, buffer: Buffer.from(page(product)), contentType: 'text/html' };
  } });
  const first = preview('https://shop.example.test/item');
  const same = preview('https://shop.example.test/item');
  await assert.rejects(preview('https://shop.example.test/other'), { status: 503 });
  release();
  assert.deepEqual(await first, await same);
  assert.equal(calls, 1);
  await preview('https://shop.example.test/item');
  assert.equal(calls, 1);
  clock += 15 * 60 * 1000 + 1;
  await preview('https://shop.example.test/item');
  assert.equal(calls, 2);
});

test('preview API requires a completed draw and rejects private targets without adding wishlist items', async t => {
  const server = await startServer();
  t.after(async () => { await server.stop(); server.remove(); });
  const seeded = await server.seed();
  const person = seeded.people[0];
  const body = { token: person.token, url: 'http://127.0.0.1/' };
  assert.equal((await server.request('POST', '/api/wishlist/preview', { ...body, token: 'invalid' })).status, 401);
  assert.equal((await server.request('POST', '/api/wishlist/preview', body)).status, 403);
  await server.request('POST', '/api/draw', { token: person.token });
  assert.equal((await server.request('POST', `/api/wishlist/preview?token=${person.token}`, { ...body, token: 'invalid' })).status, 400);
  for (let i = 0; i < 19; i++) assert.equal((await server.request('POST', '/api/wishlist/preview', body)).status, 400);
  assert.equal((await server.request('POST', '/api/wishlist/preview', body)).status, 429);
  assert.equal((await server.request('GET', `/api/wishlist/me?token=${person.token}`)).data.items.length, 0);
});
