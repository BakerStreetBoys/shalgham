// MTProto proxy (tg://proxy). Accepts a raw TCP connection, reads the
// obfuscated2 header, and relays to the requested Telegram DC.
'use strict';

const net = require('net');
const { DC_PORT } = require('../config');
const { INIT_SIZE, openObfs2 } = require('../obfs2');
const { IDLE_TIMEOUT_MS } = require('./guard');

const HANDSHAKE_TIMEOUT_MS = 15 * 1000; // drops scanners that never send a header

// secret: Buffer (16 bytes); meter: stats connection tracker.
function handle(socket, secret, meter) {
  let head = Buffer.alloc(0);
  let link = null;
  let upstream = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    socket.destroy();
    if (upstream) upstream.destroy();
    meter.close();
  };

  // Client -> DC, with backpressure on the client socket.
  const forward = (chunk) => {
    if (!upstream.write(link.toDc(chunk))) {
      socket.pause();
      upstream.once('drain', () => socket.resume());
    }
  };

  const handshakeTimer = setTimeout(close, HANDSHAKE_TIMEOUT_MS);
  socket.setNoDelay(true);
  socket.setTimeout(IDLE_TIMEOUT_MS, close);
  socket.on('error', close);
  socket.on('close', close);

  socket.on('data', (chunk) => {
    meter.up(chunk.length);
    if (link) return forward(chunk);

    head = Buffer.concat([head, chunk]);
    if (head.length < INIT_SIZE) return;
    try {
      link = openObfs2(head.subarray(0, INIT_SIZE), secret);
    } catch {
      return close(); // wrong secret, unknown transport or DC
    }
    clearTimeout(handshakeTimer);
    const rest = head.subarray(INIT_SIZE);
    head = null;

    upstream = net.connect({ host: link.host, port: DC_PORT });
    upstream.setNoDelay(true);
    upstream.on('error', close);
    upstream.on('close', close);
    // DC -> client: already encrypted for the client (see obfs2.js), copied as is.
    upstream.on('data', (data) => {
      meter.down(data.length);
      if (!socket.write(data)) {
        upstream.pause();
        socket.once('drain', () => upstream.resume());
      }
    });
    upstream.write(link.first); // queued by Node until the connection is open
    if (rest.length) forward(rest);
  });
}

module.exports = { handle };
