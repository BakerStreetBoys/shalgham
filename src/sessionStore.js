// Custom express-session store backed by SQLite. Replaces the default
// MemoryStore, which loses every session on redeploy/restart.
'use strict';

const session = require('express-session');
const { db } = require('./db');

// Default session lifetime when a session has no explicit cookie.expires.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Sweep for expired rows that were never read again (abandoned tabs).
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Guards against starting more than one sweep if the store is constructed twice.
let cleanupTimer = null;

function startCleanupSweep() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try {
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    } catch (err) {
      console.error('[session-store] cleanup sweep failed:', err.message);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref(); // do not keep the process alive for this timer
}

class SqliteSessionStore extends session.Store {
  constructor(...args) {
    super(...args);
    startCleanupSweep();
  }

  get(sid, callback) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const expiresAt = sessionData.cookie && sessionData.cookie.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + DEFAULT_MAX_AGE_MS;
      db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ).run(sid, JSON.stringify(sessionData), expiresAt);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Refresh a session's expiry on activity (used when resave is false).
  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }
}

module.exports = SqliteSessionStore;
