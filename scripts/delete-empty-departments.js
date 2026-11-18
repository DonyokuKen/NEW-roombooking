'use strict';
// One-off maintenance: permanently delete every department that has no
// users AND no bookings referencing it (id or name form). Departments
// that still have members or bookings are left alone and reported, so
// nothing they point at is orphaned.
//
// Usage (from the repo root on sisfor1d, DB from .env unless overridden):
//   DB_NAME=roombooking_test node scripts/delete-empty-departments.js --dry-run
//   DB_NAME=roombooking      node scripts/delete-empty-departments.js
require('dotenv').config();
const db = require('../lib/db');
const merge = require('../lib/merge');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const departments = await db.query('SELECT * FROM departments ORDER BY id ASC');
  const allUsers = await db.getAllUsers({});
  const allBookings = await db.getAllBookings({ limit: 10000, offset: 0 });
  const refs = d => {
    const members = allUsers.filter(u =>
      String(u.dept) === String(d.id) ||
      merge.normalizeName(u.dept) === merge.normalizeName(d.namadepartment)
    ).length;
    const bookings = allBookings.filter(b =>
      String(b.department) === String(d.id) ||
      merge.normalizeName(b.department) === merge.normalizeName(d.namadepartment)
    ).length;
    return { members, bookings };
  };

  const deletable = [];
  const kept = [];
  for (const d of departments) {
    const { members, bookings } = refs(d);
    if (members === 0 && bookings === 0) deletable.push(d);
    else kept.push({ ...d, members, bookings });
  }

  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}deletable (no users, no bookings): ${deletable.length}`);
  for (const d of deletable) console.log(`  DELETE id ${d.id} "${d.namadepartment}" [${d.status}]`);
  console.log(`kept (has users or bookings): ${kept.length}`);
  for (const d of kept.filter(k => k.members === 0)) {
    console.log(`  KEEP id ${d.id} "${d.namadepartment}" [${d.status}] — 0 users, ${d.bookings} bookings`);
  }

  if (DRY_RUN) {
    console.log('DRY RUN — nothing written.');
    process.exit(0);
  }

  let deleted = 0;
  for (const d of deletable) {
    // Re-check right before deleting, inside the same run.
    const { members, bookings } = refs(d);
    if (members !== 0 || bookings !== 0) {
      console.log(`  SKIP id ${d.id} (changed under us: ${members} users, ${bookings} bookings)`);
      continue;
    }
    await db.hardDeleteDepartment(d.id);
    deleted++;
  }
  const remaining = await db.query('SELECT COUNT(*) AS c FROM departments');
  console.log(`done: deleted ${deleted} departments, ${remaining[0].c} rows left`);
  process.exit(0);
}

main().catch(err => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
