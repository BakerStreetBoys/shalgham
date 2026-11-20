// SOLO Proxy entry point: public side (decoy, bridge page, WebSocket relay) and
// the password-protected panel under /panel. The TCP proxies are started by runtime.js.
'use strict';

// Keep a copy of the log for the panel before any other module can write to it.
require('./logs').capture();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');

const SqliteSessionStore = require('./sessionStore');
const { getOrCreateSessionSecret } = require('./db');
const {
  APP_NAME,
  HTTP_PORT,
  PROXY_PORT,
  MODES,
  MODE_LABELS,
  MODE_HINTS,
  PATH,
} = require('./config');
const {
  seedAdminFromEnv,
  verifyLogin,
  updatePassword,
  requireAuth,
  getOrCreateCsrfToken,
  requireCsrf,
} = require('./auth');
const settings = require('./settings');
const stats = require('./stats');
const runtime = require('./runtime');
const { describeActive } = require('./links');
const { sendNotFound } = require('./web/pages');
const { sendDecoy } = require('./web/decoy');
const { isBridge, sendBridge } = require('./web/bridge');
const relay = require('./web/relay');
const { getFlag } = require('./flags');
const { getLines } = require('./logs');
const { version } = require('../package.json');

const MIN_PASSWORD_LENGTH = 6;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Warn on Railway when no Volume is attached: the database would be lost on redeploy.
const dataDirWarning =
  Boolean(process.env.RAILWAY_PROJECT_ID) && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR;

seedAdminFromEnv();
settings.getSettings();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway terminates TLS in front of the app
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.panelPath = PATH.panel; // used by every view to build links
app.locals.appName = APP_NAME;
app.locals.version = version;

// ----- Panel -----

const panel = express.Router();
panel.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
panel.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  next();
});
panel.use(express.urlencoded({ extended: false }));
panel.use(express.json());
panel.use(
  session({
    name: 'solo.sid',
    secret: process.env.SESSION_SECRET || getOrCreateSessionSecret(),
    resave: false,
    saveUninitialized: false,
    store: new SqliteSessionStore(),
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', path: PATH.panel, maxAge: SESSION_MAX_AGE_MS },
  })
);

// Stores a one-time message shown on the next dashboard render.
const flash = (req, type, message) => {
  req.session.flash = { type, message };
};
const backToPanel = (res) => res.redirect(PATH.panel);

panel.get('/login', (req, res) => {
  if (req.session.adminId) return backToPanel(res);
  res.render('login', { appName: APP_NAME, csrfToken: getOrCreateCsrfToken(req), error: null });
});

panel.post('/login', requireCsrf, (req, res) => {
  const user = verifyLogin(req.body.password);
  if (!user) {
    return res.status(401).render('login', {
      appName: APP_NAME,
      csrfToken: getOrCreateCsrfToken(req),
      error: 'Wrong password.',
    });
  }
  // New session id after login prevents session fixation.
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Login failed.');
    req.session.adminId = user.id;
    backToPanel(res);
  });
});

panel.post('/logout', requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect(`${PATH.panel}/login`));
});

panel.get('/', requireAuth, (req, res) => {
  const message = req.session.flash || null;
  delete req.session.flash;
  res.render('dashboard', {
    appName: APP_NAME,
    version,
    csrfToken: getOrCreateCsrfToken(req),
    flash: message,
    settings: settings.getSettings(),
    modes: MODES,
    labels: MODE_LABELS,
    hints: MODE_HINTS,
    active: describeActive(req.hostname),
    proxyPort: PROXY_PORT,
    usage: stats.snapshot(),
    dataDirWarning,
  });
});

panel.get('/api/stats', requireAuth, (req, res) => res.json(stats.snapshot()));

// Recent server log lines (see logs.js) as plain text, oldest first.
panel.get('/api/logs', requireAuth, (req, res) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.type('text/plain').send(getLines().join('\n'));
});

// Country flag images: downloaded once, then served from the Volume cache (see flags.js).
panel.get('/flags/:code.svg', requireAuth, async (req, res) => {
  const image = await getFlag(req.params.code);
  if (!image) return res.sendStatus(404);
  res.set({
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", // no scripts even if opened directly
  });
  res.send(image);
});

// Radio buttons (active protocol). Applying a protocol always turns the proxy on.
panel.post('/settings/mode', requireAuth, requireCsrf, (req, res) => {
  if (!MODES.includes(req.body.mode)) {
    flash(req, 'error', 'Unknown protocol.');
    return backToPanel(res);
  }
  settings.setMode(req.body.mode);
  settings.setEnabled(true);
  runtime.restart();
  flash(req, 'success', 'Proxy settings applied.');
  backToPanel(res);
});

panel.post('/settings/secret', requireAuth, requireCsrf, (req, res) => {
  try {
    if (req.body.action === 'regenerate') settings.regenerateSecret();
    else settings.setSecret(req.body.secret);
    runtime.restart();
    flash(req, 'success', 'Secret updated. Old links no longer work.');
  } catch {
    flash(req, 'error', 'The secret must be exactly 32 hexadecimal characters (0-9, a-f).');
  }
  backToPanel(res);
});

panel.post('/settings/credentials', requireAuth, requireCsrf, (req, res) => {
  try {
    if (req.body.action === 'regenerate') settings.regenerateCredentials();
    else settings.setCredentials(String(req.body.user || ''), String(req.body.pass || ''));
    runtime.restart();
    flash(req, 'success', 'Username and password updated.');
  } catch {
    flash(req, 'error', 'Username and password: 1-64 characters from A-Z a-z 0-9 . _ ~ -');
  }
  backToPanel(res);
});

// Password change is called with fetch() from the dashboard and answers JSON.
panel.post('/settings/password', requireAuth, requireCsrf, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!verifyLogin(currentPassword)) return res.status(400).json({ error: 'Current password is wrong.' });
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  updatePassword(newPassword);
  res.json({ ok: true });
});

app.use(PATH.panel, panel);

// ----- Public side -----

// "/" is the bridge page for Telegram (web mode, valid capability) and a decoy page for everyone else.
app.get('/', async (req, res) => {
  try {
    if (settings.isWebActive() && isBridge(req)) return sendBridge(req, res);
    await sendDecoy(req, res);
  } catch (err) {
    console.error('request error:', err.message);
    sendNotFound(res); // never leak error details
  }
});

app.use((req, res) => sendNotFound(res));

// Panel errors (for example a failing database) must not leak details either.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('unhandled error:', err.message);
  if (res.headersSent) return res.destroy();
  sendNotFound(res);
});

// ----- Startup and shutdown -----

const server = http.createServer(app);
server.on('upgrade', relay.upgrade);
server.listen(HTTP_PORT, '0.0.0.0', () => console.log(`${APP_NAME} panel listening on port ${HTTP_PORT}`));

// Startup diagnostic: shows whether Railway gave this deployment a TCP Proxy address.
console.log(
  `TCP Proxy variables: RAILWAY_TCP_PROXY_DOMAIN=${process.env.RAILWAY_TCP_PROXY_DOMAIN || '(unset)'} ` +
    `RAILWAY_TCP_PROXY_PORT=${process.env.RAILWAY_TCP_PROXY_PORT || '(unset)'} ` +
    `RAILWAY_TCP_APPLICATION_PORT=${process.env.RAILWAY_TCP_APPLICATION_PORT || '(unset)'} ` +
    `PROXY_PORT=${PROXY_PORT}`
);

stats.start();
runtime.apply();

function shutdown() {
  stats.stop();
  runtime.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // do not hang on open connections
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err && err.message));
