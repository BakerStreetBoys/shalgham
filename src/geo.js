// Country lookup for client IP addresses, using the free country.is service (no API key).
// Only public addresses are looked up; the caller stores the result so each IP is asked once.
'use strict';

const net = require('net');
const https = require('https');

const LOOKUP_URL = 'https://api.country.is/';
const TIMEOUT_MS = 5 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000; // wait this long before asking again about an IP that failed

const failedAt = new Map(); // ip -> time of the last failed lookup
const inFlight = new Map(); // ip -> pending lookup, so one IP is never asked twice at once

// True for addresses that can have a country: not private, loopback, link-local or shared (CGNAT).
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return a < 224; // multicast and reserved ranges
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    return !/^(fc|fd|fe[89ab])/.test(lower); // unique-local and link-local
  }
  return false;
}

function request(ip) {
  return new Promise((resolve, reject) => {
    const req = https.get(LOOKUP_URL + encodeURIComponent(ip), { timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
        try {
          resolve(JSON.parse(body).country);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Resolves to an upper-case ISO 3166-1 alpha-2 code, or null when unknown or the lookup failed.
async function lookupCountry(ip) {
  if (!isPublicIp(ip)) return null;
  if (Date.now() - (failedAt.get(ip) || 0) < RETRY_AFTER_MS) return null;
  if (inFlight.has(ip)) return inFlight.get(ip);

  const pending = request(ip)
    .then((code) => (/^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null))
    .catch(() => {
      failedAt.set(ip, Date.now());
      return null;
    })
    .finally(() => inFlight.delete(ip));
  inFlight.set(ip, pending);
  return pending;
}

module.exports = { isPublicIp, lookupCountry };
