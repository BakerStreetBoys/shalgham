// Authentication helpers: single admin account, bcrypt password hash,
// session-based login and CSRF checks.
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('./db');
const { PATH } = require('./config');

const SALT_ROUNDS = 10;

// Create the single admin account on first startup (no-op if one exists).
function seedAdminFromEnv() {
  const existing = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
  if (existing) return;

  const password = process.env.ADMIN_PASSWORD || 'admin';
  db.prepare('INSERT INTO admin_users (password_hash) VALUES (?)').run(bcrypt.hashSync(password, SALT_ROUNDS));
  console.log('Seeded initial admin account. Change the password after first login.');
}

// Check a password against the stored admin user.
function verifyLogin(password) {
  const user = db.prepare('SELECT * FROM admin_users LIMIT 1').get();
  if (!user || typeof password !== 'string') return null;
  return bcrypt.compareSync(password, user.password_hash) ? { id: user.id } : null;
}

// Overwrite the single admin account's password hash.
function updatePassword(newPassword) {
  db.prepare('UPDATE admin_users SET password_hash = ?').run(bcrypt.hashSync(newPassword, SALT_ROUNDS));
}

// Middleware: require a logged-in session, else redirect to the login page.
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect(`${PATH.panel}/login`);
}

// Get (or create) this session's CSRF token.
function getOrCreateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

// Constant-time string comparison; false for non-strings or different lengths.
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Middleware: reject POSTs whose _csrf field doesn't match the session token.
function requireCsrf(req, res, next) {
  const submitted = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;
  if (!expected || !timingSafeEqualStrings(submitted, expected)) {
    return res.status(403).send('Invalid or missing CSRF token. Go back and try again.');
  }
  next();
}

module.exports = {
  seedAdminFromEnv,
  verifyLogin,
  updatePassword,
  requireAuth,
  getOrCreateCsrfToken,
  requireCsrf,
  timingSafeEqualStrings,
};
