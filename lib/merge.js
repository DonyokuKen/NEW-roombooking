'use strict';

// Duplicate detection + merge execution for equipment (kelengkapan) and
// departments. Merges are the admin's explicit call: identical normalized
// names only. Near-matches are never merged here.
//
// normalizeName: trim, lowercase, collapse inner whitespace, strip trailing
// commas/periods. So "Keyboard," and "Keyboard" are the same name, while
// "Keyboard" and "Keyboard, Sound System" are different names.
// A duplicate group is same normalized name WITHIN the same room (equipment)
// or the same normalized name, period (departments). Rows whose room is
// NULL ("Tanpa Ruangan") form one bucket: they are all unassigned equipment.
// The same name in different rooms is NOT a duplicate and is never touched.
//
// Merge rules:
// - Keeper = lowest id in the group. The keeper row itself is never changed.
// - Equipment: every trevents.kelengkapanruangan ';'-separated id list that
//   mentions a loser id gets the loser id replaced by the keeper id, and the
//   list is de-duplicated (a booking that already names the keeper keeps one
//   copy). Losers are then soft-deleted (status='D').
// - Departments: users.dept in id form (="loser id") becomes the keeper id;
//   users.dept in name form becomes the keeper name; trevents.department in
//   name form becomes the keeper name. Losers are then soft-deleted.
// - Everything runs inside one transaction: any failure rolls the whole
//   group merge back.
function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[,.]+$/g, '')
    .trim();
}

function roomKey(idruangan) {
  return idruangan === null || idruangan === undefined ? '' : String(idruangan);
}

// items: kelengkapan rows (status != 'D'). Returns groups with >1 item:
// [{ roomId, roomKey, normName, keeper, losers }]
function groupEquipmentDuplicates(items) {
  const groups = {};
  for (const item of items || []) {
    const key = roomKey(item.idruangan) + '|' + normalizeName(item.NamaKelengkapan);
    (groups[key] = groups[key] || []).push(item);
  }
  return Object.values(groups)
    .filter(g => g.length > 1)
    .map(g => {
      const sorted = [...g].sort((a, b) => a.id - b.id);
      return {
        roomId: sorted[0].idruangan,
        roomKey: roomKey(sorted[0].idruangan),
        normName: normalizeName(sorted[0].NamaKelengkapan),
        keeper: sorted[0],
        losers: sorted.slice(1)
      };
    })
    .sort((a, b) => a.keeper.id - b.keeper.id);
}

// items: department rows (status != 'D'). Returns groups with >1 item:
// [{ normName, keeper, losers }]
function groupDepartmentDuplicates(items) {
  const groups = {};
  for (const item of items || []) {
    const key = normalizeName(item.namadepartment);
    (groups[key] = groups[key] || []).push(item);
  }
  return Object.values(groups)
    .filter(g => g.length > 1)
    .map(g => {
      const sorted = [...g].sort((a, b) => a.id - b.id);
      return {
        normName: normalizeName(sorted[0].namadepartment),
        keeper: sorted[0],
        losers: sorted.slice(1)
      };
    })
    .sort((a, b) => a.keeper.id - b.keeper.id);
}

// rows: [{ kelengkapanruangan }] — count how many bookings mention each id.
function countEquipmentReferences(rows) {
  const counts = {};
  for (const row of rows || []) {
    if (!row.kelengkapanruangan) continue;
    for (const part of String(row.kelengkapanruangan).split(';')) {
      const id = parseInt(part.trim(), 10);
      if (!Number.isNaN(id)) counts[id] = (counts[id] || 0) + 1;
    }
  }
  return counts;
}

// Rewrite one ';'-separated id list: loser ids -> keeper id, de-duplicated,
// first-occurrence order kept. Returns the new string, or null when nothing
// in the list mentions a loser.
function rewriteEquipmentList(list, keeperId, loserSet) {
  const ids = String(list || '').split(';').map(s => s.trim()).filter(Boolean);
  let changed = false;
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const n = parseInt(raw, 10);
    const mapped = !Number.isNaN(n) && loserSet.has(n) ? keeperId : raw;
    if (mapped !== raw) changed = true;
    const key = String(mapped);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    } else if (mapped !== raw) {
      changed = true; // a duplicate copy dropped
    }
  }
  return changed ? out.join(';') : null;
}

// q: query fn inside a transaction. Merges one equipment group.
// Returns { rewrittenBookings, rewrittenRefs, losersDeleted }.
async function mergeEquipmentGroup(q, keeperId, loserIds) {
  const loserSet = new Set(loserIds.map(Number));
  const allIds = [keeperId, ...loserIds].map(Number);
  const inList = allIds.map(() => '?').join(',');
  // Guard: keeper + losers must still exist and be non-deleted.
  const stillThere = await q(
    `SELECT id, status FROM kelengkapans WHERE id IN (${inList}) AND status != ?`,
    [...allIds, 'D']
  );
  if (stillThere.length !== loserIds.length + 1) {
    throw new Error('Merge dibatalkan: salah satu peralatan sudah berubah atau dihapus');
  }
  const rows = await q(
    "SELECT id, kelengkapanruangan FROM trevents WHERE kelengkapanruangan IS NOT NULL AND kelengkapanruangan != ''"
  );
  let rewrittenBookings = 0;
  let rewrittenRefs = 0;
  for (const row of rows) {
    const ids = String(row.kelengkapanruangan).split(';').map(s => s.trim()).filter(Boolean);
    const hits = ids.filter(raw => {
      const n = parseInt(raw, 10);
      return !Number.isNaN(n) && loserSet.has(n);
    }).length;
    if (!hits) continue;
    const next = rewriteEquipmentList(row.kelengkapanruangan, keeperId, loserSet);
    if (next === null) continue;
    await q('UPDATE trevents SET kelengkapanruangan = ?, updated_at = NOW() WHERE id = ?', [next, row.id]);
    rewrittenBookings += 1;
    rewrittenRefs += hits;
  }
  const del = await q(
    `UPDATE kelengkapans SET status = 'D', updated_at = NOW() WHERE id IN (${loserIds.map(() => '?').join(',')})`,
    loserIds.map(Number)
  );
  return { rewrittenBookings, rewrittenRefs, losersDeleted: del.affectedRows || loserIds.length };
}

// q: query fn inside a transaction. Merges one department group.
// keeper: { id, namadepartment }; losers: [{ id, namadepartment }].
// Returns { usersById, usersByName, treventsByName, losersDeleted }.
async function mergeDepartmentGroup(q, keeper, losers) {
  const loserIds = losers.map(l => Number(l.id));
  const allIds = [Number(keeper.id), ...loserIds];
  const inList = allIds.map(() => '?').join(',');
  const stillThere = await q(
    `SELECT id, status FROM departments WHERE id IN (${inList}) AND status != ?`,
    [...allIds, 'D']
  );
  if (stillThere.length !== loserIds.length + 1) {
    throw new Error('Merge dibatalkan: salah satu departemen sudah berubah atau dihapus');
  }
  let usersById = 0;
  let usersByName = 0;
  let treventsByName = 0;
  for (const loser of losers) {
    // users.dept in id form: "73" -> keeper id
    const byId = await q('UPDATE users SET dept = ?, updated_at = NOW() WHERE dept = ?', [String(keeper.id), String(loser.id)]);
    usersById += byId.affectedRows || 0;
    // users.dept in name form: matches the loser name (case/space-insensitive)
    const users = await q('SELECT id, dept FROM users WHERE dept IS NOT NULL AND dept != ? AND dept NOT REGEXP ?',
      ['', '^[0-9]+$']);
    for (const u of users) {
      if (normalizeName(u.dept) === normalizeName(loser.namadepartment) &&
          normalizeName(u.dept) !== normalizeName(keeper.namadepartment)) {
        await q('UPDATE users SET dept = ?, updated_at = NOW() WHERE id = ?', [keeper.namadepartment, u.id]);
        usersByName += 1;
      }
    }
    // trevents.department in name form -> keeper name
    const events = await q('SELECT id, department FROM trevents WHERE department IS NOT NULL AND department != ?', ['']);
    for (const t of events) {
      if (normalizeName(t.department) === normalizeName(loser.namadepartment) &&
          normalizeName(t.department) !== normalizeName(keeper.namadepartment)) {
        await q('UPDATE trevents SET department = ?, updated_at = NOW() WHERE id = ?', [keeper.namadepartment, t.id]);
        treventsByName += 1;
      }
    }
  }
  const del = await q(
    `UPDATE departments SET status = 'D', updated_at = NOW() WHERE id IN (${loserIds.map(() => '?').join(',')})`,
    loserIds
  );
  return { usersById, usersByName, treventsByName, losersDeleted: del.affectedRows || loserIds.length };
}

// q: query fn inside a transaction. Renames a department and rewrites every
// name-form reference (users.dept, trevents.department) from the old name
// to the new one, so members and bookings follow the rename. Id-form
// references ("20") need no change — they point at the row, not the name.
// Returns { usersRenamed, bookingsRenamed }.
async function renameDepartment(q, deptId, oldName, newName) {
  const stillThere = await q('SELECT id, status FROM departments WHERE id = ? AND status != ?', [deptId, 'D']);
  if (stillThere.length !== 1) {
    throw new Error('Rename dibatalkan: departemen sudah berubah atau dihapus');
  }
  await q('UPDATE departments SET namadepartment = ?, updated_at = NOW() WHERE id = ?', [newName, deptId]);
  let usersRenamed = 0;
  const users = await q('SELECT id, dept FROM users WHERE dept IS NOT NULL AND dept != ? AND dept NOT REGEXP ?',
    ['', '^[0-9]+$']);
  for (const u of users) {
    if (normalizeName(u.dept) === normalizeName(oldName)) {
      await q('UPDATE users SET dept = ?, updated_at = NOW() WHERE id = ?', [newName, u.id]);
      usersRenamed += 1;
    }
  }
  let bookingsRenamed = 0;
  const events = await q('SELECT id, department FROM trevents WHERE department IS NOT NULL AND department != ?', ['']);
  for (const t of events) {
    if (normalizeName(t.department) === normalizeName(oldName)) {
      await q('UPDATE trevents SET department = ?, updated_at = NOW() WHERE id = ?', [newName, t.id]);
      bookingsRenamed += 1;
    }
  }
  return { usersRenamed, bookingsRenamed };
}

module.exports = {
  normalizeName,
  groupEquipmentDuplicates,
  groupDepartmentDuplicates,
  countEquipmentReferences,
  rewriteEquipmentList,
  mergeEquipmentGroup,
  mergeDepartmentGroup,
  renameDepartment
};
