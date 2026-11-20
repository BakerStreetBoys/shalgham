// Shared constants for SOLO Proxy. Every route, limit and table is defined only here.
'use strict';

const APP_NAME = 'SOLO Proxy';

// Port of the raw TCP listener used by the MTProto and SOCKS5 modes.
// On Railway, the service's TCP Proxy must point at this application port.
const PROXY_PORT = Number(process.env.PROXY_PORT) || 8443;

// Port of the public HTTP server (panel, web proxy). Railway may provide a PORT equal to the
// TCP Proxy application port; the two listeners cannot share a port, so that value is ignored
// and the default is used. Set the domain's target port in Railway to this default.
const DEFAULT_HTTP_PORT = 8080;
const envHttpPort = Number(process.env.PORT);
const HTTP_PORT = envHttpPort && envHttpPort !== PROXY_PORT ? envHttpPort : DEFAULT_HTTP_PORT;

// Proxy modes. Exactly one is active at a time (chosen with radio buttons).
const MODES = ['web', 'mtproto', 'socks5'];
const MODE_LABELS = {
  web: 'Web proxy',
  mtproto: 'MTProto',
  socks5: 'SOCKS5',
};
const MODE_HINTS = {
  web: 'HTTPS + WebSocket on the public domain. No TCP Proxy needed.',
  mtproto: 'Raw TCP through the Railway TCP Proxy. Uses the secret.',
  socks5: 'Raw TCP through the Railway TCP Proxy. Uses username and password.',
};
const isTcpMode = (mode) => mode !== 'web';

// Public routes.
const PATH = {
  ws: '/api/v1/ws',
  panel: '/panel',
};
const WS_SUBPROTOCOL = 'tproxy-v1.'; // prefix of the relay token in Sec-WebSocket-Protocol

// Decoy pages shown on /, in this order, DECOY_SECONDS each, then back to the first.
const DECOY_SECONDS = 20;
const DECOY_URLS = [
  'https://fa.wikipedia.org/wiki/Special:Random',
  'https://apps.apple.com/',
  'https://bale.ai/',
];

// Telegram production DCs (https://core.telegram.org/mtproto/DC), used by the web and MTProto modes.
const DC_PORT = 443;
const TG_DC = {
  1: '149.154.175.53',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '91.108.56.130',
};

// Official Telegram address ranges (https://core.telegram.org/resources/cidr.txt).
// SOCKS5 proxy refuses every other destination.
const TELEGRAM_CIDRS = [
  '91.105.192.0/23',
  '91.108.4.0/22',
  '91.108.8.0/22',
  '91.108.12.0/22',
  '91.108.16.0/22',
  '91.108.20.0/22',
  '91.108.56.0/22',
  '149.154.160.0/20',
  '185.76.151.0/24',
  '2001:67c:4e8::/48',
  '2001:b28:f23c::/48',
  '2001:b28:f23d::/48',
  '2001:b28:f23f::/48',
  '2a0a:f280::/32',
];
const TELEGRAM_PORTS = [80, 443, 5222];

module.exports = {
  APP_NAME,
  HTTP_PORT,
  PROXY_PORT,
  MODES,
  MODE_LABELS,
  MODE_HINTS,
  isTcpMode,
  PATH,
  WS_SUBPROTOCOL,
  DECOY_SECONDS,
  DECOY_URLS,
  DC_PORT,
  TG_DC,
  TELEGRAM_CIDRS,
  TELEGRAM_PORTS,
};
