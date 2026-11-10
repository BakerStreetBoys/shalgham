// Builds what the dashboard shows for the active mode: the Telegram link (when
// the protocol has one) and the plain connection fields.
'use strict';

const { PROXY_PORT } = require('./config');
const { getSettings } = require('./settings');
const { linkSecret } = require('./tokens');

const onRailway = Boolean(process.env.RAILWAY_PROJECT_ID);

// Public address of the raw TCP listener: the Railway TCP Proxy when present,
// otherwise this host and the local listener port (local development).
function tcpEndpoint(hostname) {
  const railwayHost = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const railwayPort = process.env.RAILWAY_TCP_PROXY_PORT;
  if (railwayHost && railwayPort) return { host: railwayHost, port: railwayPort, ready: true };
  return { host: hostname, port: String(PROXY_PORT), ready: !onRailway };
}

const query = (params) => new URLSearchParams(params).toString();

// hostname: the host the panel was opened on (the public HTTPS domain).
// Returns { mode, enabled, link, fields, tcpMissing }.
function describeActive(hostname) {
  const { mode, enabled, secret, proxyUser, proxyPass } = getSettings();
  const tcp = tcpEndpoint(hostname);
  const base = { mode, enabled, link: null, fields: [], tcpMissing: mode !== 'web' && !tcp.ready };

  if (mode === 'web') {
    base.link = 'tg://webproxy?' + query({ server: hostname, secret: linkSecret() });
    base.fields = [{ label: 'Server', value: hostname }, { label: 'Secret', value: linkSecret() }];
  } else if (mode === 'mtproto') {
    base.link = 'tg://proxy?' + query({ server: tcp.host, port: tcp.port, secret: linkSecret() });
    base.fields = [
      { label: 'Server', value: tcp.host },
      { label: 'Port', value: tcp.port },
      { label: 'Secret', value: linkSecret() },
    ];
  } else if (mode === 'socks5') {
    base.link = 'tg://socks?' + query({ server: tcp.host, port: tcp.port, user: proxyUser, pass: proxyPass });
    base.fields = [
      { label: 'Server', value: tcp.host },
      { label: 'Port', value: tcp.port },
      { label: 'Username', value: proxyUser },
      { label: 'Password', value: proxyPass },
    ];
  } else {
    // HTTP proxies have no tg:// link; the fields are entered by hand in Telegram Desktop.
    base.fields = [
      { label: 'Server', value: tcp.host },
      { label: 'Port', value: tcp.port },
      { label: 'Username', value: proxyUser },
      { label: 'Password', value: proxyPass },
    ];
  }
  return base;
}

module.exports = { describeActive };
