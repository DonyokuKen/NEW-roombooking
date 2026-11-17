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

module.exports = {
  expireStaleNotifications,
  getUserNotifications,
  countRecentNotifications,
  PAGE_SIZE,
  DEFAULT_WINDOW_DAYS
};
