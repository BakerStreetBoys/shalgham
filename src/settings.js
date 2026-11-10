// Proxy settings stored in app_config: active mode, enabled flag, the secret
// and the SOCKS5/HTTP credentials. Values are cached in memory; every setter
// writes through to the database.
'use strict';

const crypto = require('crypto');
const { getConfigValue, setConfigValue } = require('./db');
const { MODES } = require('./config');

const SECRET_RE = /^[0-9a-f]{32}$/; // 16 bytes as hex
const CREDENTIAL_RE = /^[A-Za-z0-9._~-]{1,64}$/; // safe inside tg:// links and HTTP basic auth

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

let cache = null;

// Loads settings once; missing values are generated and persisted.
function load() {
  let secret = getConfigValue('secret');
  if (!secret) {
    const fromEnv = String(process.env.SECRET || '').toLowerCase();
    secret = SECRET_RE.test(fromEnv) ? fromEnv : randomHex(16);
    setConfigValue('secret', secret);
  }
  let mode = getConfigValue('mode');
  if (!MODES.includes(mode)) {
    mode = 'web';
    setConfigValue('mode', mode);
  }
  let enabled = getConfigValue('enabled');
  if (enabled === null) {
    enabled = '1';
    setConfigValue('enabled', enabled);
  }
  let proxyUser = getConfigValue('proxy_user');
  let proxyPass = getConfigValue('proxy_pass');
  if (!proxyUser || !proxyPass) {
    proxyUser = 'user' + randomHex(3);
    proxyPass = randomHex(8);
    setConfigValue('proxy_user', proxyUser);
    setConfigValue('proxy_pass', proxyPass);
  }
  cache = { secret, mode, enabled: enabled === '1', proxyUser, proxyPass };
}

function getSettings() {
  if (!cache) load();
  return cache;
}

// True when the web proxy (HTTPS + WebSocket) should be serving.
function isWebActive() {
  const { enabled, mode } = getSettings();
  return enabled && mode === 'web';
}

function setMode(mode) {
  if (!MODES.includes(mode)) throw new Error('invalid mode');
  getSettings().mode = mode;
  setConfigValue('mode', mode);
}

function setEnabled(enabled) {
  getSettings().enabled = Boolean(enabled);
  setConfigValue('enabled', enabled ? '1' : '0');
}

// Stores a new secret (32 lowercase hex characters). Existing links stop working.
function setSecret(secret) {
  const value = String(secret).trim().toLowerCase();
  if (!SECRET_RE.test(value)) throw new Error('invalid secret');
  getSettings().secret = value;
  setConfigValue('secret', value);
}

function regenerateSecret() {
  setSecret(randomHex(16));
}

function setCredentials(user, pass) {
  if (!CREDENTIAL_RE.test(user) || !CREDENTIAL_RE.test(pass)) throw new Error('invalid credentials');
  const settings = getSettings();
  settings.proxyUser = user;
  settings.proxyPass = pass;
  setConfigValue('proxy_user', user);
  setConfigValue('proxy_pass', pass);
}

function regenerateCredentials() {
  setCredentials('user' + randomHex(3), randomHex(8));
}

module.exports = {
  SECRET_RE,
  CREDENTIAL_RE,
  getSettings,
  isWebActive,
  setMode,
  setEnabled,
  setSecret,
  regenerateSecret,
  setCredentials,
  regenerateCredentials,
};
