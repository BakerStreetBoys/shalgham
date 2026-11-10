// Decoy page for "/": fetches a real public page and serves it, rotating to the
// next URL every DECOY_SECONDS. The page is cached for its time slot.
'use strict';

const { DECOY_SECONDS, DECOY_URLS } = require('../config');
const { HTML_TYPE, BASE_HEADERS, sendNotFound } = require('./pages');

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let cache = { slot: -1, page: null };

// Fetches one decoy URL. Returns { type, body } or null on any failure.
// A <base> tag is injected into HTML so relative links keep working.
async function buildDecoy(target) {
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,fa;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) return null;
    const type = upstream.headers.get('content-type') || HTML_TYPE;
    let body = Buffer.from(await upstream.arrayBuffer());
    if (/text\/html/i.test(type)) {
      const base = `<base href="${new URL(upstream.url).origin}/">`;
      body = Buffer.from(body.toString('utf8').replace(/<head([^>]*)>/i, (match) => match + base), 'utf8');
    }
    return { type, body };
  } catch {
    return null;
  }
}

async function sendDecoy(req, res) {
  res.set(BASE_HEADERS);
  if (req.method === 'HEAD') return res.set('Content-Type', HTML_TYPE).end();

  const slot = Math.floor(Date.now() / 1000 / DECOY_SECONDS);
  if (cache.slot !== slot) {
    cache = { slot, page: await buildDecoy(DECOY_URLS[slot % DECOY_URLS.length]) };
  }
  if (!cache.page) return sendNotFound(res);
  res.set('Content-Type', cache.page.type).send(cache.page.body);
}

module.exports = { sendDecoy };
