// Usage statistics: bytes up/down and connection counts per proxy mode and per client IP.
// Counters live in memory and are written to SQLite periodically and on shutdown.
'use strict';

const { db } = require('./db');
const { MODES } = require('./config');
const { lookupCountry } = require('./geo');

const FLUSH_INTERVAL_MS = 30 * 1000;
const MAX_CLIENTS = 500; // client IPs kept; the least recently seen one is dropped beyond this

// Totals per mode, seeded from the database so they survive restarts.
const totals = {};
for (const mode of MODES) totals[mode] = { up: 0, down: 0, connections: 0 };
for (const row of db.prepare('SELECT * FROM usage').all()) {
  if (totals[row.mode]) {
    totals[row.mode] = { up: row.up_bytes, down: row.down_bytes, connections: row.connections };
  }
}

// Totals per client IP, seeded from the database too.
const clients = new Map();
for (const row of db.prepare('SELECT * FROM usage_ip').all()) {
  clients.set(row.ip, {
    up: row.up_bytes,
    down: row.down_bytes,
    connections: row.connections,
    lastSeen: row.last_seen,
    country: row.country || null,
  });
}
const dirtyIps = new Set(); // client IPs changed since the last flush
const removedIps = new Set(); // client IPs dropped since the last flush

let live = 0; // connections open right now
let dirty = false;

// Plain text form of an address: IPv4-mapped IPv6 becomes IPv4, a missing address becomes 'unknown'.
function normalizeIp(ip) {
  const text = String(ip || '').trim().replace(/^::ffff:/i, '');
  return text || 'unknown';
}

// Returns the counters of one client IP, creating them (and dropping the least recently seen IP
// when there are too many) if needed.
function clientFor(ip) {
  let client = clients.get(ip);
  if (!client) {
    client = { up: 0, down: 0, connections: 0, lastSeen: Date.now(), country: null };
    clients.set(ip, client);
    removedIps.delete(ip);
    if (clients.size > MAX_CLIENTS) {
      let oldestIp = null;
      for (const [candidate, value] of clients) {
        if (candidate !== ip && (oldestIp === null || value.lastSeen < clients.get(oldestIp).lastSeen)) {
          oldestIp = candidate;
        }
      }
      clients.delete(oldestIp);
      dirtyIps.delete(oldestIp);
      removedIps.add(oldestIp);
    }
  }
  return client;
}

// Looks up the country of a client IP in the background and stores it. geo.js skips private
// addresses and does not repeat failed lookups, so this is cheap to call for every connection.
function resolveCountry(ip, client) {
  lookupCountry(ip).then((code) => {
    if (!code || clients.get(ip) !== client) return;
    client.country = code;
    dirtyIps.add(ip);
    dirty = true;
  });
}

// Starts tracking one proxied connection from client address `ip`.
// up/down add bytes; close is idempotent.
function open(mode, ip) {
  const entry = totals[mode];
  const clientIp = normalizeIp(ip);
  const client = clientFor(clientIp);
  if (!client.country) resolveCountry(clientIp, client);
  entry.connections++;
  client.connections++;
  client.lastSeen = Date.now();
  dirtyIps.add(clientIp);
  live++;
  dirty = true;
  let closed = false;
  return {
    up(bytes) {
      entry.up += bytes;
      client.up += bytes;
      client.lastSeen = Date.now();
      dirtyIps.add(clientIp);
      dirty = true;
    },
    down(bytes) {
      entry.down += bytes;
      client.down += bytes;
      client.lastSeen = Date.now();
      dirtyIps.add(clientIp);
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
  // Client IPs, the heaviest users first.
  const byClient = Array.from(clients, ([ip, c]) => ({
    ip,
    up: c.up,
    down: c.down,
    connections: c.connections,
    lastSeen: c.lastSeen,
    country: c.country,
  })).sort((a, b) => b.up + b.down - (a.up + a.down));
  return { live, modes, total: { up, down, connections }, clients: byClient };
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
  const upsertIp = db.prepare(
    `INSERT INTO usage_ip (ip, up_bytes, down_bytes, connections, last_seen, country) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET up_bytes = excluded.up_bytes, down_bytes = excluded.down_bytes,
       connections = excluded.connections, last_seen = excluded.last_seen, country = excluded.country`
  );
  const deleteIp = db.prepare('DELETE FROM usage_ip WHERE ip = ?');
  db.transaction(() => {
    for (const mode of MODES) {
      const t = totals[mode];
      upsert.run(mode, t.up, t.down, t.connections);
    }
    for (const ip of dirtyIps) {
      const c = clients.get(ip);
      if (c) upsertIp.run(ip, c.up, c.down, c.connections, c.lastSeen, c.country);
    }
    for (const ip of removedIps) deleteIp.run(ip);
  })();
  dirtyIps.clear();
  removedIps.clear();
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
