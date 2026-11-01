const { test, expect } = require('@playwright/test');
const { startServer } = require('../support/server');

const product = { title: 'Cotton tee', image_url: 'https://cdn.example.test/product-image.png', price_cents: 2495, currency: 'AUD' };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9kAAAAASUVORK5CYII=', 'base64');
async function openForm(page) {
  const server = await startServer();
  try {
    const seeded = await server.seed();
    const person = seeded.people[0];
    await server.request('POST', '/api/draw', { token: person.token });
    await page.route('https://cdn.example.test/**', route => route.fulfill({ contentType: 'image/png', body: image }));
    await page.goto(`${server.baseUrl}/wishlists?token=${person.token}`);
    await expect(page.locator('#greeting')).toContainText(person.name);
    await page.locator('#btn_toggle_add').click();
    await expect(page.locator('#f_url')).toBeFocused();
    return { server, person };
  } catch (error) { await server.stop(); server.remove(); throw error; }
}

test('pasting a product URL fills editable name, price and image, then saves the wishlist item', async ({ page }) => {
  const { server, person } = await openForm(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    let lookups = 0;
    await page.route('**/api/wishlist/preview', async route => {
      const body = route.request().postDataJSON();
      expect(body.token).toBe(person.token);
      expect(body.url).toBe('https://shop.example.test/tee');
      lookups++;
      await route.fulfill({ json: { product } });
    });
    await page.locator('#f_url').fill('https://shop.example.test/tee');
    await expect(page.locator('#f_title')).toHaveValue(product.title);
    await expect(page.locator('#f_price')).toHaveValue('24.95');
    await expect(page.locator('#f_image')).toHaveValue(product.image_url);
    await expect(page.locator('#product_image_preview')).toBeVisible();
    await page.locator('#f_title').fill('Cotton tee — blue, size M');
    await page.locator('#f_notes').fill('Blue please');
    await page.locator('#btn_add').click();
    await expect(page.locator('#msg_add')).toHaveText('Added!');
    const own = await server.request('GET', `/api/wishlist/me?token=${person.token}`);
    expect(own.data.items).toHaveLength(1);
    expect(own.data.items[0]).toMatchObject({ title: 'Cotton tee — blue, size M', price_cents: 2495,
      image_url: product.image_url, url: 'https://shop.example.test/tee', notes: 'Blue please' });
    expect(lookups).toBe(1);
    await expect(page.locator('#f_title')).toHaveValue('');
    await expect(page.locator('#product_image_preview')).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await server.stop(); server.remove(); }
});

test('slow lookups preserve typed edits and cannot replace details after the URL changes', async ({ page }) => {
  const { server } = await openForm(page);
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    await page.route('**/api/wishlist/preview', async route => {
      if (route.request().postDataJSON().url.endsWith('/old')) {
        markStarted();
        await gate;
        await route.fulfill({ json: { product } }).catch(() => {});
      } else await route.fulfill({ json: { product: { ...product, title: 'New item', price_cents: 4995 } } });
    });
    await page.locator('#f_url').fill('https://shop.example.test/old');
    await started;
    await page.locator('#f_title').fill('My custom item name');
    await page.locator('#f_image').fill('https://cdn.example.test/my-image.png');
    release();
    await expect(page.locator('#product_lookup_status')).toContainText('Details filled');
    await expect(page.locator('#f_title')).toHaveValue('My custom item name');
    await expect(page.locator('#f_image')).toHaveValue('https://cdn.example.test/my-image.png');
    await expect(page.locator('#f_price')).toHaveValue('24.95');

    await page.locator('#f_url').fill('https://shop.example.test/new');
    await expect(page.locator('#f_price')).toHaveValue('');
    await expect(page.locator('#f_price')).toHaveValue('49.95');
    await expect(page.locator('#f_title')).toHaveValue('My custom item name');
    await expect(page.locator('#f_image')).toHaveValue('https://cdn.example.test/my-image.png');
    await page.locator('#f_title').fill('');

    // A second slow result must not overwrite a newer product's completed lookup.
    let releaseStale, staleStarted;
    const staleGate = new Promise(resolve => { releaseStale = resolve; });
    const pending = new Promise(resolve => { staleStarted = resolve; });
    await page.unroute('**/api/wishlist/preview');
    await page.route('**/api/wishlist/preview', async route => {
      if (route.request().postDataJSON().url.endsWith('/stale')) {
        staleStarted();
        await staleGate;
        await route.fulfill({ json: { product: { ...product, title: 'Stale item' } } }).catch(() => {});
      } else await route.fulfill({ json: { product: { ...product, title: 'Latest item', price_cents: 7950 } } });
    });
    await page.locator('#f_url').fill('https://shop.example.test/stale');
    await pending;
    await page.locator('#f_url').fill('https://shop.example.test/latest');
    await expect(page.locator('#f_title')).toHaveValue('Latest item');
    releaseStale();
    await expect(page.locator('#f_price')).toHaveValue('79.50');
    await expect(page.locator('#f_title')).toHaveValue('Latest item');
  } finally { await server.stop(); server.remove(); }
});

test('blocked shops leave manual entry available and foreign prices are clearly identified', async ({ page }) => {
  const { server, person } = await openForm(page);
  try {
    await page.route('**/api/wishlist/preview', route => {
      const url = route.request().postDataJSON().url;
      if (url.endsWith('/blocked')) return route.fulfill({ status: 422, json: { error: 'This shop blocks automatic lookups. You can enter the item details below.' } });
      if (url.endsWith('/broken')) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
      if (url.endsWith('/no-price')) return route.fulfill({ json: { product: { ...product, price_cents: null } } });
      return route.fulfill({ json: { product: { ...product, currency: 'USD' } } });
    });
    await page.locator('#f_url').fill('https://shop.example.test/blocked');
    await expect(page.locator('#product_lookup_status')).toContainText('blocks automatic lookups');
    await expect(page.locator('#btn_product_lookup')).toBeEnabled();
    await page.locator('#f_title').fill('Manually added gift');
    await page.locator('#f_price').fill('$49.95 ');
    await page.locator('#btn_add').click();
    await expect(page.locator('#msg_add')).toHaveText('Added!');
    const own = await server.request('GET', `/api/wishlist/me?token=${person.token}`);
    expect(own.data.items[0]).toMatchObject({ title: 'Manually added gift', price_cents: 4995 });
    await page.locator('#btn_toggle_add').click();
    await page.locator('#f_url').fill('https://shop.example.test/us-product');
    await expect(page.locator('#f_title')).toHaveValue(product.title);
    await expect(page.locator('#product_lookup_status')).toContainText('USD 24.95');
    await expect(page.locator('#product_lookup_status')).toContainText('AUD');
    await expect(page.locator('#f_price')).toHaveValue('');
    await page.locator('#f_url').fill('https://shop.example.test/broken');
    await expect(page.locator('#product_lookup_status')).toContainText('Could not read this product page');
    await expect(page.locator('#btn_product_lookup')).toBeEnabled();
    await page.locator('#f_url').fill('https://shop.example.test/no-price');
    await expect(page.locator('#f_title')).toHaveValue(product.title);
    await expect(page.locator('#product_lookup_status')).toContainText('A clear price wasn’t available');
    await expect(page.locator('#f_price')).toHaveValue('');
  } finally { await server.stop(); server.remove(); }
});
