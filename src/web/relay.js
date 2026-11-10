// WebSocket relay of the web proxy. One WebSocket carries many logical streams;
// each stream is one MTProxy-style connection to a Telegram DC.
// Shared frame: type:u8 | stream_id:u24 | payload_length:u32 | payload (big-endian).
'use strict';

const net = require('net');
const { WebSocketServer } = require('ws');
const { PATH, WS_SUBPROTOCOL, DC_PORT } = require('../config');
const { isWebActive, getSettings } = require('../settings');
const { INIT_SIZE, openObfs2 } = require('../obfs2');
const { TOKEN_SCOPE, validToken } = require('../tokens');
const stats = require('../stats');
const { NOT_FOUND_HTML, HTML_TYPE } = require('./pages');

// Frame types.
const OPEN = 1;
const DATA = 2;
const CLOSE = 3;
const WINDOW = 4;
const PONG = 6;
const FRAME_HEADER = 8;

// Limits and sizes.
const MAX_STREAMS = 64;
const MAX_CLOSED_IDS = 4096; // closed stream ids remembered per session
const STREAM_WINDOW = 4 * 1024 * 1024; // initial credit per stream (DC -> client)
const CHUNK = 64 * 1024; // max DATA payload sent to the client
const WS_HIGH_WATER = 8 * 1024 * 1024; // pause sending while this much is queued on the WebSocket
const MAX_MESSAGE = 8 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

const log = (ev, info) => console.log(JSON.stringify({ ev, ...info }));

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE,
  // Echo back the token subprotocol the bridge page offered.
  handleProtocols: (protocols) => Array.from(protocols).find((p) => p.startsWith(WS_SUBPROTOCOL)) || false,
});

function frame(type, id, payload) {
  const f = Buffer.alloc(FRAME_HEADER + payload.length);
  f.writeUInt32BE(((type << 24) | id) >>> 0, 0);
  f.writeUInt32BE(payload.length, 4);
  payload.copy(f, FRAME_HEADER);
  return f;
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

// Calls handle(type, id, payload) for every frame in buf; throws on a truncated frame.
function parseFrames(buf, handle) {
  for (let o = 0; o < buf.length; ) {
    if (o + FRAME_HEADER > buf.length) throw new Error('short frame');
    const start = buf.readUInt32BE(o);
    const end = o + FRAME_HEADER + buf.readUInt32BE(o + 4);
    if (end > buf.length) throw new Error('short frame');
    handle(start >>> 24, start & 0xffffff, buf.subarray(o + FRAME_HEADER, end));
    o = end;
  }
}

function session(ws) {
  const streams = new Map();
  const closed = new Set(); // recently closed ids, so late frames can be ignored
  log('session_start', {});

  const send = (type, id, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(frame(type, id, payload));
    } catch {
      /* socket closed */
    }
  };
  const markClosed = (id) => {
    closed.add(id);
    if (closed.size > MAX_CLOSED_IDS) closed.delete(closed.values().next().value);
  };
  const drop = (st, notify) => {
    if (st.closed) return;
    st.closed = true;
    streams.delete(st.id);
    markClosed(st.id);
    st.out = [];
    if (st.upstream) st.upstream.destroy();
    st.meter.close();
    if (notify) send(CLOSE, st.id, EMPTY);
  };

  // DC -> client, never sending more than the credit the client granted.
  const flush = (st) => {
    while (st.out.length && !st.closed) {
      const part = st.out[0];
      if (st.credit < part.length) break;
      if (ws.bufferedAmount > WS_HIGH_WATER) {
        setTimeout(() => flush(st), 20);
        break;
      }
      st.out.shift();
      st.credit -= part.length;
      st.meter.down(part.length);
      send(DATA, st.id, part);
    }
    if (st.upstream && !st.closed) {
      if (st.out.length) st.upstream.pause();
      else st.upstream.resume();
    }
  };

  // Returns credit to the client for bytes already written to the DC.
  const sendWindow = (st) => {
    if (st.closed || !st.pending) return;
    send(WINDOW, st.id, u32(st.pending));
    st.pending = 0;
  };

  const connect = (st) => {
    const upstream = net.connect({ host: st.link.host, port: DC_PORT });
    st.upstream = upstream;
    upstream.setNoDelay(true);
    upstream.on('error', (e) => {
      if (!st.closed) log('pump_error', { id: st.id, msg: String(e && e.message) });
    });
    upstream.on('close', () => drop(st, true));
    // Data from the DC is already encrypted for the client (see obfs2.js).
    upstream.on('data', (chunk) => {
      for (let o = 0; o < chunk.length; o += CHUNK) st.out.push(chunk.subarray(o, o + CHUNK));
      flush(st);
    });
    upstream.write(st.link.first); // queued by Node until the connection is open
  };

  // Client -> DC. Returns false while the DC socket is applying backpressure.
  const forward = (st, data) => st.upstream.write(st.link.toDc(data));

  const uplink = (st, data) => {
    if (st.closed) return;
    let drained = true;
    if (st.link) {
      drained = forward(st, data);
    } else {
      st.head = Buffer.concat([st.head, data]);
      if (st.head.length >= INIT_SIZE) {
        const head = st.head.subarray(0, INIT_SIZE);
        const rest = st.head.subarray(INIT_SIZE);
        st.head = null;
        st.link = openObfs2(head, Buffer.from(getSettings().secret, 'hex'));
        connect(st);
        if (rest.length) drained = forward(st, rest);
      }
    }
    st.pending += data.length;
    if (drained) sendWindow(st);
    else st.upstream.once('drain', () => sendWindow(st));
  };

  const onFrame = (type, id, payload) => {
    if (type === PONG) return;
    if (!id) throw new Error('bad stream id');
    const st = streams.get(id);
    if (type === OPEN) {
      if (st || closed.has(id) || payload.length) return;
      if (streams.size >= MAX_STREAMS) {
        log('stream_refused', { live: streams.size });
        markClosed(id);
        send(CLOSE, id, EMPTY);
        return;
      }
      streams.set(id, {
        id,
        credit: STREAM_WINDOW,
        pending: 0, // bytes consumed from the client but not yet returned as credit
        head: EMPTY,
        out: [],
        link: null,
        upstream: null,
        meter: stats.open('web'),
        closed: false,
      });
    } else if (!st) {
      if (!closed.has(id)) throw new Error('unknown stream');
    } else if (type === DATA && payload.length) {
      st.meter.up(payload.length);
      try {
        uplink(st, payload);
      } catch (e) {
        log('stream_error', { id: st.id, msg: String(e && e.message) });
        drop(st, true);
      }
    } else if (type === WINDOW && payload.length === 4) {
      st.credit += payload.readUInt32BE(0);
      flush(st);
    } else if (type === CLOSE) {
      drop(st, false);
    } else {
      throw new Error('bad frame');
    }
  };

  ws.on('message', (data, isBinary) => {
    try {
      if (!isBinary) throw new Error('text message');
      parseFrames(Buffer.isBuffer(data) ? data : Buffer.concat(data), onFrame);
    } catch (e) {
      log('protocol_error', { msg: String(e && e.message) });
      ws.close(1002);
    }
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    log('session_end', { live: streams.size });
    for (const st of Array.from(streams.values())) drop(st, false);
  });
}

// Rejects an upgrade with the same 404 page every unknown request gets.
function reject(socket) {
  const body = Buffer.from(NOT_FOUND_HTML);
  socket.end(
    'HTTP/1.1 404 Not Found\r\nContent-Type: ' + HTML_TYPE + '\r\nContent-Length: ' + body.length +
      '\r\nConnection: close\r\n\r\n' + NOT_FOUND_HTML
  );
}

// Handles the HTTP "upgrade" event: only the relay path, in web mode, with a valid token.
function upgrade(req, socket, head) {
  socket.on('error', () => {});
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
  if (pathname !== PATH.ws || !isWebActive()) return reject(socket);

  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  const proto = offered.find((s) => s.startsWith(WS_SUBPROTOCOL));
  if (!proto || !validToken(TOKEN_SCOPE.ws, proto.slice(WS_SUBPROTOCOL.length))) return reject(socket);

  wss.handleUpgrade(req, socket, head, (ws) => session(ws));
}

// Closes every relay session (used when the mode changes or the proxy is disabled).
function closeAll() {
  for (const ws of wss.clients) ws.terminate();
}

module.exports = { upgrade, closeAll };
