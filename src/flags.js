// Flag image cache. Each flag is downloaded from flagcdn.com only the first time it is needed,
// saved in the Volume (DATA_DIR/flags) and read from disk every time after that.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./db');

const FLAG_DIR = path.join(DATA_DIR, 'flags');
const ASSET_DIR = path.join(__dirname, 'assets', 'flags'); // flags bundled with the app; never downloaded
const FLAG_URL = 'https://flagcdn.com/'; // SVG flags: sharp at any size, so one file serves every screen
const TIMEOUT_MS = 8 * 1000;
const MAX_BYTES = 500 * 1024;
const RETRY_AFTER_MS = 10 * 60 * 1000; // wait this long before downloading a flag that failed
const CODE_RE = /^[a-z]{2}$/;

const failedAt = new Map(); // code -> time of the last failed download
const inFlight = new Map(); // code -> pending download, so one flag is never downloaded twice at once

function download(code) {
  return new Promise((resolve, reject) => {
    const req = https.get(`${FLAG_URL}${code}.svg`, { timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`status ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) return req.destroy(new Error('flag too large'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        const image = Buffer.concat(chunks);
        // Must be an SVG image and must not carry scripts.
        const text = image.toString('utf8');
        if (!text.includes('<svg') || /<script|\son\w+\s*=/i.test(text)) return reject(new Error('not a plain SVG'));
        resolve(image);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Downloads a flag and saves it. The file is written under a temporary name and renamed, so a
// half-written file is never served from the cache.
async function fetchAndStore(code, file) {
  const image = await download(code);
  await fs.promises.mkdir(FLAG_DIR, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, image);
  await fs.promises.rename(temp, file);
  return image;
}

// Deletes any downloaded copy of a bundled flag from the Volume cache, so the bundled file is
// the only version ever served.
function purgeCachedBundledFlags() {
  try {
    for (const name of fs.readdirSync(ASSET_DIR)) {
      if (!name.endsWith('.svg')) continue;
      fs.rmSync(path.join(FLAG_DIR, name), { force: true });
    }
  } catch {
    /* no bundled flags or no cache folder: nothing to delete */
  }
}

purgeCachedBundledFlags();

// Returns the SVG of a country flag (two-letter code, any case), or null when it is unavailable.
async function getFlag(rawCode) {
  const code = String(rawCode || '').toLowerCase();
  if (!CODE_RE.test(code)) return null;
  try {
    return await fs.promises.readFile(path.join(ASSET_DIR, `${code}.svg`));
  } catch {
    /* not a bundled flag */
  }
  const file = path.join(FLAG_DIR, `${code}.svg`);
  try {
    return await fs.promises.readFile(file);
  } catch {
    /* not cached yet */
  }
  if (Date.now() - (failedAt.get(code) || 0) < RETRY_AFTER_MS) return null;
  if (!inFlight.has(code)) {
    const pending = fetchAndStore(code, file)
      .catch(() => {
        failedAt.set(code, Date.now());
        return null;
      })
      .finally(() => inFlight.delete(code));
    inFlight.set(code, pending);
  }
  return inFlight.get(code);
}

module.exports = { getFlag };
