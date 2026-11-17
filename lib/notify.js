'use strict';
/**
 * Notification helpers for push_notification_logs.
 *
 * The old Laravel scheduler is gone, but its log table still holds
 * 594 "pending" rows for events from Apr–Jun 2026 that will never be
 * delivered. Any future sender that picks up pending rows would blast
 * those ancient reminders out as spam, so stale pendings are expired
 * instead of ever being sent.
 */
const db = require('./db');

// Pending reminders older than this can never be delivered meaningfully:
// their events already happened.
const STALE_PENDING_DAYS = 7;

// Notifications page: only this window is shown by default so a pile of
// old entries can never bury the newest ones.
const DEFAULT_WINDOW_DAYS = 30;
const PAGE_SIZE = 20;

/** Mark stale pending rows expired. Returns the number expired. */
async function expireStaleNotifications() {
  const result = await db.query(
    `UPDATE push_notification_logs
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL ? DAY`,
    [STALE_PENDING_DAYS]
  );
  return result.affectedRows || 0;
}

/**
 * One user's notifications, newest first.
 * page is 1-based. Unless showAll is true, only the recent window is
 * returned. Returns { rows, total, page, totalPages }.
 */
async function getUserNotifications(userId, page = 1, showAll = false) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * PAGE_SIZE;
  const where = ['user_id = ?'];
  const params = [userId];
  if (!showAll) {
    where.push('created_at >= NOW() - INTERVAL ? DAY');
    params.push(DEFAULT_WINDOW_DAYS);
  }
  // Expired rows are dead letters — never shown as notifications.
  where.push("status <> 'expired'");
  const whereSql = 'WHERE ' + where.join(' AND ');

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS n FROM push_notification_logs ${whereSql}`,
    params
  );
  const total = countRows.n;
  const rows = await db.query(
    `SELECT id, booking_id, notification_type, title, body, status,
            sent_at, delivered_at, created_at
       FROM push_notification_logs ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );
  return { rows, total, page: safePage, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Badge count: notifications from the last 7 days for this user. */
async function countRecentNotifications(userId) {
  const [row] = await db.query(
    `SELECT COUNT(*) AS n FROM push_notification_logs
      WHERE user_id = ?
        AND status <> 'expired'
        AND created_at >= NOW() - INTERVAL 7 DAY`,
    [userId]
  );
  return row.n;
}

/** Today (YYYY-MM-DD) in Asia/Jakarta, the app's timezone. */
function todayWib() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

/** One reminder row, unless an identical one was already created that day. */
async function ensureReminder({ booking, userId, type, title, body, date, dryRun }) {
  const [existing] = await db.query(
    `SELECT id FROM push_notification_logs
      WHERE booking_id = ? AND user_id = ? AND notification_type = ?
        AND DATE(created_at) = ? LIMIT 1`,
    [booking.id, userId, type, date]
  );
  if (existing) return 'skipped';
  if (dryRun) return 'would-create';
  // Created 'pending' — the client's polling loop shows it as a browser
  // notification and then marks it delivered (the old Laravel flow).
  // No push token is involved anywhere: delivery is local polling.
  await db.query(
    `INSERT INTO push_notification_logs
       (user_id, booking_id, notification_type, title, body, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
    [userId, booking.id, type, title, body]
  );
  return 'created';
}

/**
 * Day-of reminders for one date (default: today).
 *
 * Admins (roles M/SU) get one reminder per approved booking that day.
 * The user who booked gets one reminder for their own booking only —
 * never anyone else's. Rows are created once per day per recipient
 * (dedupe), so re-runs and restarts can never spam duplicates.
 * With dryRun, nothing is inserted — returns what would be created.
 * Returns { date, bookings, created, skipped, wouldCreate, items }.
 */
async function createDayReminders({ date = todayWib(), dryRun = false } = {}) {
  const bookings = await db.getAllBookings({ status: 'A', date });
  const allUsers = await db.getAllUsers({ status: 'A' });
  const admins = allUsers.filter((u) => db.isAdminUser(u));

  let created = 0;
  let skipped = 0;
  let wouldCreate = 0;
  const items = [];

  for (const booking of bookings) {
    const room = booking.namaruangan || '-';
    const when = `${booking.timestart} - ${booking.timeend}`;
    const dayLabel = new Date(booking.date + 'T00:00:00+07:00')
      .toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });

    // Admins: every approved booking today.
    for (const admin of admins) {
      const res = await ensureReminder({
        booking,
        userId: admin.id,
        type: 'admin_booking_today',
        title: `Hari ini: ${booking.eventname} pukul ${booking.timestart}`,
        body: `${dayLabel}, ${when} di ${room}. Dibuat oleh ${booking.namalengkap || '-'}.`,
        date,
        dryRun
      });
      if (res === 'created') created++;
      else if (res === 'skipped') skipped++;
      else { wouldCreate++; items.push({ to: `admin:${admin.id}`, booking: booking.id, type: 'admin_booking_today' }); }
    }

    // The booker only: their own booking, nothing else. If the booker
    // is also an admin they already get the admin reminder above, so
    // no second row for the same event. (trevents.userid is a varchar,
    // users.id an int — compare numerically.)
    if (booking.userid && !admins.some((a) => Number(a.id) === Number(booking.userid))) {
      const res = await ensureReminder({
        booking,
        userId: booking.userid,
        type: 'user_booking_today',
        title: `Hari ini: ${booking.eventname} pukul ${booking.timestart}`,
        body: `${dayLabel}, ${when} di ${room}.`,
        date,
        dryRun
      });
      if (res === 'created') created++;
      else if (res === 'skipped') skipped++;
      else { wouldCreate++; items.push({ to: `user:${booking.userid}`, booking: booking.id, type: 'user_booking_today' }); }
    }
  }

  return { date, bookings: bookings.length, created, skipped, wouldCreate, items };
}

/**
 * Pending notifications for the polling loop — newest first. The old
 * Laravel endpoint ordered oldest first (created_at ASC), which is why
 * old entries buried the newest ones. Fixed here: DESC.
 */
async function getPendingNotifications(userId, limit = 10) {
  return await db.query(
    `SELECT id, booking_id, notification_type, title, body, created_at
       FROM push_notification_logs
      WHERE user_id = ? AND status = 'pending'
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [userId, limit]
  );
}

/** Mark one of the user's own pending rows delivered. Returns true if it was. */
async function markNotificationDelivered(id, userId) {
  const result = await db.query(
    `UPDATE push_notification_logs
        SET status = 'delivered', sent_at = NOW(), delivered_at = NOW(),
            updated_at = NOW()
      WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [id, userId]
  );
  return (result.affectedRows || 0) > 0;
}

module.exports = {
  expireStaleNotifications,
  getUserNotifications,
  countRecentNotifications,
  createDayReminders,
  getPendingNotifications,
  markNotificationDelivered,
  todayWib,
  PAGE_SIZE,
  DEFAULT_WINDOW_DAYS
};
