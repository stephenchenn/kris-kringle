const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');
const ipaddr = require('ipaddr.js');

const MAX_BYTES = 4 * 1024 * 1024;
class PreviewError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

function publicUrl(value, base) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error();
    url = new URL(value.trim(), base);
  } catch { throw new PreviewError('Enter a valid product link starting with https://.', 400); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
      host === 'localhost' || /\.(localhost|local|internal)$/.test(host) ||
      (net.isIP(host) ? !isPublicAddress(host) : !host.includes('.'))) {
    throw new PreviewError('Use a public product webpage with an http:// or https:// link.', 400);
  }
  url.hash = '';
  return url;
}

async function publicAddress(url, signal, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return { address: host, family: net.isIP(host) };
  signal.throwIfAborted();
  let onAbort;
  try {
    const answers = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
      throw new PreviewError('This link does not point to a public product webpage.', 400);
    }
    return answers.find(answer => answer.family === 4) || answers[0];
  } finally { signal.removeEventListener('abort', onAbort); }
}

function readPage(url, address, signal, request) {
  return new Promise((resolve, reject) => {
    // Pin the checked address for the actual connection, including every redirect.
    const req = request(url, {
      agent: false, signal, maxHeaderSize: 65536,
      family: address.family,
      lookup(host, options, callback) {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FamilyKringle/1.0; product link preview)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
    }, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        resolve({ redirect: response.headers.location });
        response.destroy();
        return;
      }
      const fail = error => { reject(error); response.destroy(); req.destroy(); };
      if (status < 200 || status >= 300) {
        fail(new PreviewError(status === 403 || status === 429
          ? 'This shop blocks automatic lookups. You can enter the item details below.'
          : 'Could not open this product page. You can enter the item details below.'));
        return;
      }
      const contentType = response.headers['content-type'] || '';
      if (contentType && !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
        fail(new PreviewError('Use a product webpage rather than an image or downloadable file.'));
        return;
      }
      if (Number(response.headers['content-length']) > MAX_BYTES) {
        fail(new PreviewError('This page is too large to read automatically. Enter the details below.'));
        return;
      }
      const encoding = (response.headers['content-encoding'] || 'identity').toLowerCase();
      const decompress = { gzip: zlib.createGunzip, br: zlib.createBrotliDecompress, deflate: zlib.createInflate }[encoding];
      if (encoding !== 'identity' && !decompress) {
        fail(new PreviewError('Could not read this page. You can enter the item details below.'));
        return;
      }
      const stream = decompress ? response.pipe(decompress()) : response;
      let rawBytes = 0, decodedBytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        rawBytes += chunk.length;
        if (rawBytes > MAX_BYTES) fail(new PreviewError('This page is too large to read automatically. Enter the details below.'));
      });
      response.once('aborted', () => fail(new PreviewError('The shop closed the connection. Please try again.')));
      response.once('error', fail);
      stream.once('error', fail);
      stream.on('data', chunk => {
        decodedBytes += chunk.length;
        if (decodedBytes > MAX_BYTES) {
          stream.destroy();
          fail(new PreviewError('This page is too large to read automatically. Enter the details below.'));
        } else chunks.push(chunk);
      });
      stream.once('end', () => resolve({ buffer: Buffer.concat(chunks), contentType, url: url.href }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function fetchPublicPage(value, options = {}) {
  const signal = AbortSignal.timeout(options.timeoutMs || 10000);
  const lookup = options.lookup || dns.lookup.bind(dns);
  const request = options.request || ((url, settings, callback) =>
    (url.protocol === 'https:' ? https : http).request(url, settings, callback));
  let url = publicUrl(value);
  const visited = new Set();
  try {
    for (let hop = 0; hop < 5; hop++) {
      signal.throwIfAborted();
      if (visited.has(url.href)) break;
      visited.add(url.href);
      const address = await publicAddress(url, signal, lookup);
      const result = await readPage(url, address, signal, request);
      if (!result.redirect) return result;
      url = publicUrl(result.redirect, url);
    }
    throw new PreviewError('This link redirects too many times. Try the final product page link.');
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    if (signal.aborted) throw new PreviewError('The shop took too long to respond. Try again or enter the details below.', 504);
    throw new PreviewError('Could not reach this shop. You can enter the item details below.');
  }
}

module.exports = { fetchPublicPage, publicUrl, isPublicAddress, PreviewError };
