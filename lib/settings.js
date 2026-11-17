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
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'settings.json');
const DEFAULTS = { bookingWindowDays: 2 };
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
  return {
    bookingWindowDays: Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS
      ? days
      : DEFAULTS.bookingWindowDays
  };
}

function getBookingWindowDays() {
  return load().bookingWindowDays;
}

function saveBookingWindowDays(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) {
    throw new Error(`bookingWindowDays must be a whole number from ${MIN_DAYS} to ${MAX_DAYS}`);
  }
  const next = Object.assign({}, load(), { bookingWindowDays: n });
  // Atomic write: temp file + rename, so a crash mid-save never leaves a
  // half-written settings file behind.
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
  return n;
}

module.exports = { getBookingWindowDays, saveBookingWindowDays, MIN_DAYS, MAX_DAYS };
