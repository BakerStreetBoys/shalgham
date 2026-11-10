// Applies the current settings: runs the raw TCP listener of the MTProto,
// SOCKS5 and HTTP modes, and closes web relay sessions when the web mode is off.
// Exactly one protocol is active at a time (the radio button in the panel).
'use strict';

const net = require('net');
const { PROXY_PORT, HTTP_PORT, isTcpMode } = require('./config');
const { getSettings } = require('./settings');
const stats = require('./stats');
const relay = require('./web/relay');
const mtproto = require('./proxies/mtproto');
const socks5 = require('./proxies/socks5');
const httpProxy = require('./proxies/http');

let server = null;
let serverMode = null;
const sockets = new Set(); // open client sockets of the TCP listener

// Called for every accepted TCP connection; settings are read per connection so edits apply at once.
function onConnection(mode, socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  const settings = getSettings();
  const meter = stats.open(mode);
  if (mode === 'mtproto') mtproto.handle(socket, Buffer.from(settings.secret, 'hex'), meter);
  else if (mode === 'socks5') socks5.handle(socket, settings, meter);
  else httpProxy.handle(socket, settings, meter);
}

function stopTcp() {
  if (!server) return;
  server.close();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  server = null;
  serverMode = null;
  console.log('TCP proxy listener stopped');
}

function startTcp(mode) {
  if (PROXY_PORT === HTTP_PORT) {
    console.error(`PROXY_PORT (${PROXY_PORT}) must differ from PORT (${HTTP_PORT}); ${mode} proxy not started`);
    return;
  }
  const listener = net.createServer((socket) => onConnection(mode, socket));
  listener.on('error', (err) => {
    console.error('TCP proxy listener error:', err.message);
    if (server === listener) {
      server = null;
      serverMode = null;
    }
  });
  listener.listen(PROXY_PORT, '0.0.0.0', () => console.log(`${mode} proxy listening on port ${PROXY_PORT}`));
  server = listener;
  serverMode = mode;
}

// Brings the running state in line with the settings. Safe to call at any time.
function apply() {
  const { mode, enabled } = getSettings();
  const wantedTcpMode = enabled && isTcpMode(mode) ? mode : null;
  if (server && serverMode !== wantedTcpMode) stopTcp();
  if (wantedTcpMode && !server) startTcp(wantedTcpMode);
  if (!(enabled && mode === 'web')) relay.closeAll();
}

function stop() {
  stopTcp();
  relay.closeAll();
}

// Drops every live connection and re-applies the settings. Used when the secret or
// credentials change, so connections made with the old values do not linger.
function restart() {
  stop();
  apply();
}

module.exports = { apply, stop, restart };
