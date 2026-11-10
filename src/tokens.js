// Signed tokens and the bridge capability of the web proxy. Keys come from the
// current secret (see settings.js), so regenerating the secret invalidates both.
'use strict';

const crypto = require('crypto');
const { getSettings } = require('./settings');

const TAG_PADDED = 0xdd; // clients use the padded-intermediate mode ("dd" prefix)
const TOKEN_SCOPE = { ws: 'ws' };
const MAC_LENGTH = 43; // base64url length of a SHA-256 HMAC
const TOKEN_RE = new RegExp('^(\\d{1,12})\\.([A-Za-z0-9_-]{' + MAC_LENGTH + '})$');

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const hmac = (key, message) => crypto.createHmac('sha256', key).update(message).digest();
const nowSeconds = () => Math.floor(Date.now() / 1000);

const secretBytes = () => Buffer.from(getSettings().secret, 'hex');
// Secret that Telegram clients put in the link: "dd" + 32 hex characters.
const linkSecret = () => TAG_PADDED.toString(16) + getSettings().secret;
const linkBytes = () => Buffer.from(linkSecret(), 'hex');

// Constant-time string comparison; strings of different byte length are unequal.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Bridge capability: HMAC-SHA256 keyed with the client-facing secret bytes (WEB proxy protocol v1).
const bridgeCap = (host) => b64url(hmac(linkBytes(), 'tdesktop-web-proxy-bridge-v1\n' + host));

// Signed tokens are "<unix expiry>.<mac>"; the scope is part of the signed message.
const mac = (scope, exp) => b64url(hmac(secretBytes(), scope + '|' + exp));

function issueToken(scope, seconds) {
  const exp = nowSeconds() + seconds;
  return exp + '.' + mac(scope, exp);
}

function validToken(scope, token) {
  const match = TOKEN_RE.exec(String(token));
  if (!match || Number(match[1]) < nowSeconds()) return false;
  return safeEqual(match[2], mac(scope, match[1]));
}

module.exports = { TOKEN_SCOPE, MAC_LENGTH, b64url, safeEqual, linkSecret, bridgeCap, issueToken, validToken };
