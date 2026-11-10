// SOCKS5 proxy (RFC 1928) with username/password auth (RFC 1929).
// Only CONNECT to IP addresses inside Telegram's ranges is allowed.
'use strict';

const { createReader, openTarget, relay, safeEqual } = require('./guard');

const VERSION = 5;
const METHOD_USER_PASS = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP = { ipv4: 0x01, domain: 0x03, ipv6: 0x04 };
const REPLY = { ok: 0x00, notAllowed: 0x02, refused: 0x05, badCommand: 0x07, badAddress: 0x08 };
const HANDSHAKE_TIMEOUT_MS = 15 * 1000;

const reply = (code) => Buffer.from([VERSION, code, 0, ATYP.ipv4, 0, 0, 0, 0, 0, 0]);

// Formats 16 raw bytes as an IPv6 address.
function ipv6FromBytes(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

// settings: { proxyUser, proxyPass }; meter: stats connection tracker.
async function handle(socket, settings, meter) {
  const reader = createReader(socket);
  const abort = () => {
    socket.destroy();
    meter.close();
  };
  socket.on('error', abort);
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, abort);
  try {
    // Method negotiation: only username/password is accepted.
    const [version, count] = await reader.read(2);
    const methods = await reader.read(count);
    if (version !== VERSION || !methods.includes(METHOD_USER_PASS)) {
      socket.end(Buffer.from([VERSION, METHOD_NONE_ACCEPTABLE]));
      return meter.close();
    }
    socket.write(Buffer.from([VERSION, METHOD_USER_PASS]));

    // Username/password sub-negotiation.
    const [, userLen] = await reader.read(2);
    const user = (await reader.read(userLen)).toString();
    const [passLen] = await reader.read(1);
    const pass = (await reader.read(passLen)).toString();
    const userOk = safeEqual(user, settings.proxyUser);
    const passOk = safeEqual(pass, settings.proxyPass);
    if (!(userOk && passOk)) {
      socket.end(Buffer.from([0x01, 0x01]));
      return meter.close();
    }
    socket.write(Buffer.from([0x01, 0x00]));

    // Request.
    const [reqVersion, command, , addressType] = await reader.read(4);
    if (reqVersion !== VERSION) return abort();
    if (command !== CMD_CONNECT) {
      socket.end(reply(REPLY.badCommand));
      return meter.close();
    }
    let host;
    if (addressType === ATYP.ipv4) host = (await reader.read(4)).join('.');
    else if (addressType === ATYP.ipv6) host = ipv6FromBytes(await reader.read(16));
    else {
      socket.end(reply(REPLY.badAddress)); // domain names are not resolved: Telegram sends IPs
      return meter.close();
    }
    const port = (await reader.read(2)).readUInt16BE(0);

    let target;
    try {
      target = await openTarget(host, port);
    } catch (err) {
      socket.end(reply(err.reason === 'denied' ? REPLY.notAllowed : REPLY.refused));
      return meter.close();
    }
    socket.write(reply(REPLY.ok));
    socket.setTimeout(0);
    const leftover = reader.release();
    if (leftover.length) {
      meter.up(leftover.length);
      target.write(leftover);
    }
    relay(socket, target, meter);
  } catch {
    abort();
  }
}

module.exports = { handle };
