'use strict';
/**
 * send-reminders.js — day-of notification reminders for RoomBooking.
 *
 * Run hourly from cron (and once at server startup): creates one
 * reminder per approved booking for that day — one per admin, one for
 * the user who booked — and never duplicates (dedupe by booking +
 * recipient + type + day), so re-runs can never spam.
 *
 * Usage:
 *   node scripts/send-reminders.js [--date=YYYY-MM-DD] [--dry-run]
 * Defaults to today (Asia/Jakarta). --dry-run prints what would be
 * created without inserting anything.
 */
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const notify = require('../lib/notify');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dateArg = args.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.slice('--date='.length) : notify.todayWib();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Invalid --date, expected YYYY-MM-DD, got: ${date}`);
    process.exitCode = 2;
    return;
  }

  const result = await notify.createDayReminders({ date, dryRun });
  console.log(
    `[reminders] date=${result.date} bookings=${result.bookings} ` +
    (dryRun
      ? `would-create=${result.wouldCreate}`
      : `created=${result.created} skipped=${result.skipped}`)
  );
  if (dryRun && result.items.length > 0) {
    for (const item of result.items) {
      console.log(`  would-create ${item.type} -> ${item.to} (booking ${item.booking})`);
    }
  }
}

main()
  .catch((err) => {
    console.error('[reminders] failed:', err.message);
    process.exitCode = 1;
  })
  .then(() => {
    // The DB pool keeps the event loop alive; this is a one-shot cron job.
    process.exit(process.exitCode || 0);
  });
