'use strict';
// One-off maintenance: renumber users.id to a contiguous 1..N sequence
// (ordered by current id, so relative order is preserved).
//
// Why this is safe to run: user ids are referenced in exactly three
// places — trevents.userid (varchar), booking_users.user_id and
// push_notification_logs.user_id. password_resets is keyed by email.
// Everything is remapped inside ONE transaction, and the script verifies
// the result (no gaps, no orphan references, booking counts unchanged)
// before committing; any failure rolls the whole thing back.
//
// One pre-existing loose end is fixed on the way: trevents rows whose
// userid points at a user that no longer exists (today: 1 row, a 2019
// booking by deleted user 98) are set to userid '0' first — '0' resolves
// to no user, exactly as the deleted id does today, so the booking's
// displayed booker does not change. After the renumber, leaving the old
// id in place would be WRONG: that id would belong to a different user.
//
// IMPORTANT: restart the app right after running this against live.
// Sessions live in server memory and store the user id — a session made
// before the renumber would otherwise resolve to the wrong user.
//
// Usage (from the repo root on sisfor1d, DB from .env unless overridden):
//   DB_NAME=roombooking_test node scripts/renumber-user-ids.js --dry-run
//   DB_NAME=roombooking_test node scripts/renumber-user-ids.js
//   DB_NAME=roombooking      node scripts/renumber-user-ids.js
require('dotenv').config();
const db = require('../lib/db');

const DRY_RUN = process.argv.includes('--dry-run');

function fail(msg) {
  console.error('ABORT: ' + msg);
  process.exit(1);
}

async function main() {
  const users = await db.query('SELECT id, namalengkap FROM users ORDER BY id ASC');
  if (users.length === 0) fail('no users found');
  const oldIds = users.map(u => u.id);
  const mapping = new Map(users.map((u, i) => [u.id, i + 1]));
  const n = users.length;
  console.log(`users: ${n}, id range ${oldIds[0]}..${oldIds[oldIds.length - 1]}, gaps: ${oldIds[oldIds.length - 1] - n}`);

  // Pre-check: every trevents.userid must be a numeric string, so the
  // mapping covers it (non-numeric values would be left pointing at a
  // stale id). Orphans are handled separately below.
  const userids = await db.query('SELECT DISTINCT userid FROM trevents');
  const bad = userids.map(r => r.userid).filter(v => !/^\d+$/.test(String(v)));
  if (bad.length > 0) fail('non-numeric trevents.userid values: ' + JSON.stringify(bad));

  // Pre-check: booking counts per user, to prove nothing moves.
  const beforeCounts = await db.query(
    'SELECT userid, COUNT(*) AS c FROM trevents GROUP BY userid ORDER BY userid'
  );

  if (DRY_RUN) {
    const orphans = await db.query(
      'SELECT id, userid, eventname FROM trevents WHERE userid NOT IN (SELECT id FROM users)'
    );
    console.log(`DRY RUN — no writes. Mapping (first 5): ${JSON.stringify(users.slice(0, 5).map(u => [u.id, mapping.get(u.id)]))}`);
    console.log(`DRY RUN — orphan trevents rows to set to '0': ${orphans.length} ${JSON.stringify(orphans)}`);
    console.log('DRY RUN — checks passed, nothing written.');
    process.exit(0);
  }

  await db.withTransaction(async q => {
    // push_notification_logs.user_id is a real FOREIGN KEY to users.id
    // (ON DELETE CASCADE, ON UPDATE NO ACTION). Remapping the children
    // first would fail the FK check — the new user ids do not exist yet —
    // and remapping users first would fail it the other way. So FK
    // checks are off for this session only, for the duration of the
    // transaction; the verification step below runs with checks back on
    // and proves no reference was left dangling.
    await q('SET FOREIGN_KEY_CHECKS = 0');
    // 0. Orphan fix: userid values with no matching user become '0'.
    const orphanRes = await q(
      "UPDATE trevents SET userid = '0' WHERE userid NOT IN (SELECT id FROM users)"
    );
    console.log(`orphan trevents rows set to '0': ${orphanRes.affectedRows}`);

    // 1-3. Remap the three referencing tables with one CASE update each.
    const caseSql = (col, quote) => {
      const whens = oldIds.map(oldId => {
        const o = quote ? `'${oldId}'` : oldId;
        return `WHEN ${o} THEN ${mapping.get(oldId)}`;
      }).join(' ');
      const ins = oldIds.map(oldId => (quote ? `'${oldId}'` : oldId)).join(',');
      return `UPDATE %TABLE% SET ${col} = CASE ${col} ${whens} ELSE ${col} END WHERE ${col} IN (${ins})`;
    };
    const r1 = await q(caseSql('userid', true).replace('%TABLE%', 'trevents'));
    const r2 = await q(caseSql('user_id', false).replace('%TABLE%', 'booking_users'));
    const r3 = await q(caseSql('user_id', false).replace('%TABLE%', 'push_notification_logs'));
    console.log(`remapped rows: trevents ${r1.affectedRows}, booking_users ${r2.affectedRows}, push_notification_logs ${r3.affectedRows}`);

    // 4. Renumber users.id itself. Offset first so no new id can collide
    // with an old id that has not been rewritten yet.
    await q('UPDATE users SET id = id + 1000000');
    const userCase = oldIds.map(oldId => `WHEN ${oldId + 1000000} THEN ${mapping.get(oldId)}`).join(' ');
    await q(`UPDATE users SET id = CASE id ${userCase} ELSE id END WHERE id > 1000000`);

    // 5. Verify inside the transaction — before commit. FK checks back
    // on first, so these queries see the same constraints the app does.
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const [stats] = await q('SELECT COUNT(*) AS c, MIN(id) AS mn, MAX(id) AS mx, COUNT(DISTINCT id) AS d FROM users');
    if (stats.c !== n || stats.mn !== 1 || stats.mx !== n || stats.d !== n) {
      fail(`user id check failed after renumber: ${JSON.stringify(stats)} (expected count ${n}, 1..${n})`);
    }
    const [o1] = await q("SELECT COUNT(*) AS c FROM trevents WHERE userid != '0' AND userid NOT IN (SELECT id FROM users)");
    const [o2] = await q('SELECT COUNT(*) AS c FROM booking_users WHERE user_id NOT IN (SELECT id FROM users)');
    const [o3] = await q('SELECT COUNT(*) AS c FROM push_notification_logs WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)');
    if (o1.c !== 0 || o2.c !== 0 || o3.c !== 0) {
      fail(`orphan references after renumber: trevents ${o1.c}, booking_users ${o2.c}, push_notification_logs ${o3.c}`);
    }
    const afterCounts = await q('SELECT userid, COUNT(*) AS c FROM trevents GROUP BY userid ORDER BY userid');
    // Booking counts per (new) user must equal the old counts per (old)
    // user. Orphan rows (no mapping — they were set to '0' above) are
    // keyed under '0' on both sides.
    const beforeByNew = new Map();
    for (const r of beforeCounts) {
      const key = mapping.has(Number(r.userid)) ? mapping.get(Number(r.userid)) : '0';
      beforeByNew.set(key, (beforeByNew.get(key) || 0) + r.c);
    }
    for (const r of afterCounts) {
      const key = r.userid === '0' ? '0' : Number(r.userid);
      const want = beforeByNew.get(key);
      if (want !== r.c) fail(`booking count moved for userid ${r.userid}: ${r.c} vs ${want}`);
    }
    console.log('verify OK: ids 1..' + n + ', no gaps, no orphans, booking counts unchanged');
  });

  // ALTER is DDL and implicit-commits in MySQL, so it runs after the
  // transaction, not inside it. If it fails the ids are already correct;
  // only the next auto id would be higher than N+1.
  await db.query(`ALTER TABLE users AUTO_INCREMENT = ${n + 1}`);
  const [ai] = await db.query(
    "SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  );
  console.log(`done: users.id is now 1..${n}, AUTO_INCREMENT=${ai.ai}`);
  process.exit(0);
}

main().catch(err => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
