// Usage statistics: bytes up/down and connection counts per proxy mode.
// Counters live in memory and are written to SQLite periodically and on shutdown.
'use strict';

const { db } = require('./db');
const { MODES } = require('./config');

const FLUSH_INTERVAL_MS = 30 * 1000;

// Totals per mode, seeded from the database so they survive restarts.
const totals = {};
for (const mode of MODES) totals[mode] = { up: 0, down: 0, connections: 0 };
for (const row of db.prepare('SELECT * FROM usage').all()) {
  if (totals[row.mode]) {
    totals[row.mode] = { up: row.up_bytes, down: row.down_bytes, connections: row.connections };
  }
}

let live = 0; // connections open right now
let dirty = false;

// Starts tracking one proxied connection. up/down add bytes; close is idempotent.
function open(mode) {
  const entry = totals[mode];
  entry.connections++;
  live++;
  dirty = true;
  let closed = false;
  return {
    up(bytes) {
      entry.up += bytes;
      dirty = true;
    },
    down(bytes) {
      entry.down += bytes;
      dirty = true;
    },
    close() {
      if (closed) return;
      closed = true;
      live--;
    },
  };
}

function snapshot() {
  const modes = {};
  let up = 0;
  let down = 0;
  let connections = 0;
  for (const mode of MODES) {
    modes[mode] = { ...totals[mode] };
    up += totals[mode].up;
    down += totals[mode].down;
    connections += totals[mode].connections;
  }
  return { live, modes, total: { up, down, connections } };
}

// Writes the counters to the database if anything changed since the last write.
function flush() {
  if (!dirty) return;
  dirty = false;
  const upsert = db.prepare(
    `INSERT INTO usage (mode, up_bytes, down_bytes, connections) VALUES (?, ?, ?, ?)
     ON CONFLICT(mode) DO UPDATE SET up_bytes = excluded.up_bytes,
       down_bytes = excluded.down_bytes, connections = excluded.connections`
  );
  db.transaction(() => {
    for (const mode of MODES) {
      const t = totals[mode];
      upsert.run(mode, t.up, t.down, t.connections);
    }
  })();
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      console.error('[stats] flush failed:', err.message);
    }
  }, FLUSH_INTERVAL_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  flush();
}

module.exports = { open, snapshot, flush, start, stop };
