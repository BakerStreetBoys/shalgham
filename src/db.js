// Database setup for SOLO Proxy. Uses SQLite (better-sqlite3), stored on a
// Railway Volume so data survives redeploys. Storage dir order:
// DATA_DIR env -> RAILWAY_VOLUME_MOUNT_PATH -> ./data (local dev).
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'panel.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Single admin account, password-only login (see auth.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Small key/value table for everything the panel generates or the admin
// edits: session secret, proxy secret, mode, enabled flag, credentials.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Backing table of sessionStore.js. Expired rows are deleted lazily and by a sweep.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Usage counters, one row per proxy mode (see stats.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    mode TEXT PRIMARY KEY,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    connections INTEGER NOT NULL DEFAULT 0
  );
`);

// Read a value from `app_config`, or null if never set.
function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

// Insert-or-update a value in `app_config`.
function setConfigValue(key, value) {
  db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Persisted fallback secret for signing session cookies, used only if the
// SESSION_SECRET env var isn't set. Generated once.
function getOrCreateSessionSecret() {
  const existing = getConfigValue('session_secret');
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  setConfigValue('session_secret', secret);
  return secret;
}

module.exports = { db, DATA_DIR, getConfigValue, setConfigValue, getOrCreateSessionSecret };
