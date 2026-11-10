// HTTP proxy: CONNECT only, with Basic proxy authentication.
// Only IP addresses inside Telegram's ranges are reachable.
'use strict';

const { openTarget, relay, safeEqual } = require('./guard');

const MAX_HEADER_BYTES = 8 * 1024;
const HEADER_TIMEOUT_MS = 15 * 1000;
const CONNECT_RE = /^CONNECT (\S+) HTTP\/1\.[01]$/i;
const TARGET_RE = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):(\d{1,5})$/; // [v6]:port or v4:port

const respond = (status, text, extra = '') =>
  `HTTP/1.1 ${status} ${text}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`;

// True when the Proxy-Authorization header carries the configured credentials.
function authorized(headerLines, settings) {
  const line = headerLines.find((l) => /^proxy-authorization:/i.test(l));
  const match = line && /^proxy-authorization:\s*Basic\s+(\S+)/i.exec(line);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString();
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const userOk = safeEqual(decoded.slice(0, colon), settings.proxyUser);
  const passOk = safeEqual(decoded.slice(colon + 1), settings.proxyPass);
  return userOk && passOk;
}

// settings: { proxyUser, proxyPass }; meter: stats connection tracker.
function handle(socket, settings, meter) {
  let buffered = Buffer.alloc(0);
  const abort = () => {
    socket.destroy();
    meter.close();
  };
  const refuse = (status, text, extra) => {
    socket.end(respond(status, text, extra));
    meter.close();
  };

  const onData = async (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\r\n\r\n');
    if (end === -1) {
      if (buffered.length > MAX_HEADER_BYTES) abort();
      return;
    }
    socket.removeListener('data', onData);
    socket.pause();
    socket.setTimeout(0);
    const lines = buffered.subarray(0, end).toString('latin1').split('\r\n');
    const rest = buffered.subarray(end + 4);

    const request = CONNECT_RE.exec(lines[0]);
    if (!request) return refuse(405, 'Method Not Allowed');
    if (!authorized(lines, settings)) {
      return refuse(407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="proxy"\r\n');
    }
    const destination = TARGET_RE.exec(request[1]);
    if (!destination) return refuse(400, 'Bad Request');

    let target;
    try {
      target = await openTarget(destination[1] || destination[2], Number(destination[3]));
    } catch (err) {
      return err.reason === 'denied' ? refuse(403, 'Forbidden') : refuse(502, 'Bad Gateway');
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) {
      meter.up(rest.length);
      target.write(rest);
    }
    relay(socket, target, meter);
  };

  socket.on('error', abort);
  socket.setTimeout(HEADER_TIMEOUT_MS, abort);
  socket.on('data', onData);
}

module.exports = { handle };
