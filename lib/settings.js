'use strict';

// Admin settings, stored in settings.json (a gitignored runtime file —
// never in the public repo, same as .env). A missing, unreadable or invalid
// file means the built-in defaults below. No database change is involved:
// the old app kept this kind of rule hardcoded, the setting lives on disk.
// The file is read on every access (it is tiny) so a change — through the
// admin page or by hand — takes effect immediately, with no restart and no
// stale in-memory copy.
//
// bookingWindowDays: how many whole days ahead a regular user must book.
// Day-based, not exactly N*24 hours: a booking N days later is fine even
// if it is less than N*24 hours away. 0 = same-day booking allowed.
// Admins are never limited by this setting.
//
// Email password reset: when emailResetEnabled is on, the login page shows
// a "Lupa password?" link and the reset flow sends a link by SMTP. The SMTP
// password lives here too (settings.json is gitignored). It is NEVER handed
// to a view — the settings page renders that field empty, and a blank
// submitted value means "keep the stored one".
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'settings.json');
const DEFAULTS = {
  bookingWindowDays: 2,
  emailResetEnabled: false,
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: ''
};
const MIN_DAYS = 0;
const MAX_DAYS = 30;

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    stored = {};
  }
  const days = Number(stored.bookingWindowDays);
  const port = Number(stored.smtpPort);
  return {
    bookingWindowDays: Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS
      ? days
      : DEFAULTS.bookingWindowDays,
    emailResetEnabled: stored.emailResetEnabled === true,
    smtpHost: typeof stored.smtpHost === 'string' ? stored.smtpHost.trim() : '',
    smtpPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.smtpPort,
    smtpUser: typeof stored.smtpUser === 'string' ? stored.smtpUser.trim() : '',
    // The stored SMTP password. Server-side only — never pass this to a
    // view; the settings page shows the field empty with a "keep" hint.
    smtpPass: typeof stored.smtpPass === 'string' ? stored.smtpPass : ''
  };
}

function saveAll(next) {
  // Atomic write: temp file + rename, so a crash mid-save never leaves a
  // half-written settings file behind.
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
  return next;
}

function getBookingWindowDays() {
  return load().bookingWindowDays;
}

function saveBookingWindowDays(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) {
    throw new Error(`bookingWindowDays must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}`);
  }
  saveAll(Object.assign({}, load(), { bookingWindowDays: n }));
  return n;
}

// Email reset settings. smtpPass === undefined means "keep the stored
// password" (the settings form submits it blank in that case); an empty
// string clears it. Throws on invalid input.
function getEmailSettings() {
  const s = load();
  return {
    emailResetEnabled: s.emailResetEnabled,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpUser: s.smtpUser,
    smtpPassSet: s.smtpPass.length > 0
  };
}

function saveEmailSettings(input) {
  const current = load();
  const enabled = input.emailResetEnabled === true;
  const host = typeof input.smtpHost === 'string' ? input.smtpHost.trim() : '';
  const port = Number(input.smtpPort);
  const user = typeof input.smtpUser === 'string' ? input.smtpUser.trim() : '';
  const pass = input.smtpPass === undefined
    ? current.smtpPass
    : (typeof input.smtpPass === 'string' ? input.smtpPass : '');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port SMTP harus angka 1-65535');
  }
  if (enabled) {
    if (!host) throw new Error('Host SMTP wajib diisi saat reset lewat email diaktifkan');
    if (!user) throw new Error('Username SMTP wajib diisi saat reset lewat email diaktifkan');
    if (!pass) throw new Error('Password SMTP wajib diisi saat reset lewat email diaktifkan');
  }
  const next = Object.assign({}, current, {
    emailResetEnabled: enabled,
    smtpHost: host,
    smtpPort: port,
    smtpUser: user,
    smtpPass: pass
  });
  saveAll(next);
  return getEmailSettings();
}

module.exports = {
  getBookingWindowDays,
  saveBookingWindowDays,
  getEmailSettings,
  saveEmailSettings,
  // Full settings object (includes smtpPass) — server-side only, for the
  // mailer. Never render this into a page.
  getAll: load,
  MIN_DAYS,
  MAX_DAYS
};
