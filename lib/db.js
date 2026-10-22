'use strict';
const mysql = require('mysql2/promise');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'roombooking',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'roombooking',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00'
});

// Generic query function
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ============================================================
// USER FUNCTIONS
// ============================================================

async function findUserById(id) {
  const rows = await query('SELECT * FROM users WHERE id = ? AND userstatus = ?', [id, 'A']);
  return rows[0] || null;
}

async function findUserByEmail(email) {
  const rows = await query('SELECT * FROM users WHERE email = ? AND userstatus = ?', [email, 'A']);
  return rows[0] || null;
}

async function createUser(data) {
  const result = await query(
    'INSERT INTO users (namalengkap, notelp, alamat, gender, dept, roles, userstatus, email, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
    [data.namalengkap, data.notelp, data.alamat, data.gender, data.dept, data.roles || 'U', 'A', data.email, data.password]
  );
  return result.insertId;
}

async function updateUser(id, data) {
  const fields = [];
  const values = [];
  
  if (data.namalengkap !== undefined) { fields.push('namalengkap = ?'); values.push(data.namalengkap); }
  if (data.notelp !== undefined) { fields.push('notelp = ?'); values.push(data.notelp); }
  if (data.alamat !== undefined) { fields.push('alamat = ?'); values.push(data.alamat); }
  if (data.gender !== undefined) { fields.push('gender = ?'); values.push(data.gender); }
  if (data.dept !== undefined) { fields.push('dept = ?'); values.push(data.dept); }
  if (data.roles !== undefined) { fields.push('roles = ?'); values.push(data.roles); }
  if (data.userstatus !== undefined) { fields.push('userstatus = ?'); values.push(data.userstatus); }
  if (data.password !== undefined) { fields.push('password = ?'); values.push(data.password); }
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  await query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteUser(id) {
  await query('DELETE FROM users WHERE id = ?', [id]);
}

async function getAllUsers(filters = {}) {
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND userstatus = ?';
    params.push(filters.status);
  }
  
  if (filters.roles) {
    sql += ' AND roles = ?';
    params.push(filters.roles);
  }
  
  if (filters.search) {
    sql += ' AND (namalengkap LIKE ? OR email LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  
  sql += ' ORDER BY namalengkap ASC';
  
  if (filters.limit) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(filters.limit), parseInt(filters.offset || 0));
  }
  
  return await query(sql, params);
}

async function countUsers(filters = {}) {
  let sql = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND userstatus = ?';
    params.push(filters.status);
  }
  
  if (filters.roles) {
    sql += ' AND roles = ?';
    params.push(filters.roles);
  }
  
  if (filters.search) {
    sql += ' AND (namalengkap LIKE ? OR email LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  
  const rows = await query(sql, params);
  return rows[0].count;
}

function isAdminUser(user) {
  return user && (user.roles === 'M' || user.roles === 'SU');
}

function isSuperAdmin(user) {
  return user && user.roles === 'SU';
}

// ============================================================
// ROOM FUNCTIONS
// ============================================================

async function getAllRooms(filters = {}) {
  let sql = 'SELECT * FROM rooms WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  } else {
    sql += " AND status != 'D'";
  }
  
  if (filters.search) {
    sql += ' AND namaruangan LIKE ?';
    params.push(`%${filters.search}%`);
  }
  
  sql += ' ORDER BY namaruangan ASC';
  
  if (filters.limit) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(filters.limit), parseInt(filters.offset || 0));
  }
  
  return await query(sql, params);
}

async function countRooms(filters = {}) {
  let sql = 'SELECT COUNT(*) as count FROM rooms WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  } else {
    sql += " AND status != 'D'";
  }
  
  if (filters.search) {
    sql += ' AND namaruangan LIKE ?';
    params.push(`%${filters.search}%`);
  }
  
  const rows = await query(sql, params);
  return rows[0].count;
}

async function getRoomById(id) {
  const rows = await query('SELECT * FROM rooms WHERE id = ?', [id]);
  return rows[0] || null;
}

async function createRoom(data) {
  const result = await query(
    'INSERT INTO rooms (namaruangan, description, status, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
    [data.namaruangan, data.description || '', data.status || 'A']
  );
  return result.insertId;
}

async function updateRoom(id, data) {
  const fields = [];
  const values = [];
  
  if (data.namaruangan !== undefined) { fields.push('namaruangan = ?'); values.push(data.namaruangan); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  await query(`UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteRoom(id) {
  await query("UPDATE rooms SET status = 'D', updated_at = NOW() WHERE id = ?", [id]);
}

// ============================================================
// DEPARTMENT FUNCTIONS
// ============================================================

async function getAllDepartments(filters = {}) {
  let sql = 'SELECT * FROM departments WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  } else {
    sql += " AND status != 'D'";
  }
  
  if (filters.search) {
    sql += ' AND namadepartment LIKE ?';
    params.push(`%${filters.search}%`);
  }
  
  sql += ' ORDER BY namadepartment ASC';
  
  if (filters.limit) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(filters.limit), parseInt(filters.offset || 0));
  }
  
  return await query(sql, params);
}

async function countDepartments(filters = {}) {
  let sql = 'SELECT COUNT(*) as count FROM departments WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  } else {
    sql += " AND status != 'D'";
  }
  
  if (filters.search) {
    sql += ' AND namadepartment LIKE ?';
    params.push(`%${filters.search}%`);
  }
  
  const rows = await query(sql, params);
  return rows[0].count;
}

async function getDepartmentById(id) {
  const rows = await query('SELECT * FROM departments WHERE id = ?', [id]);
  return rows[0] || null;
}

async function createDepartment(data) {
  const result = await query(
    'INSERT INTO departments (namadepartment, deskripsi, status, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
    [data.namadepartment, data.deskripsi || null, data.status || 'A']
  );
  return result.insertId;
}

async function updateDepartment(id, data) {
  const fields = [];
  const values = [];
  
  if (data.namadepartment !== undefined) { fields.push('namadepartment = ?'); values.push(data.namadepartment); }
  if (data.deskripsi !== undefined) { fields.push('deskripsi = ?'); values.push(data.deskripsi); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  await query(`UPDATE departments SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteDepartment(id) {
  // Check if department has any bookings
  const bookings = await query('SELECT COUNT(*) as count FROM trevents WHERE department = ?', [id.toString()]);
  if (bookings[0].count > 0) {
    throw new Error('Cannot delete department with existing bookings');
  }
  await query("UPDATE departments SET status = 'D', updated_at = NOW() WHERE id = ?", [id]);
}

// ============================================================
// KELENGKAPAN (EQUIPMENT) FUNCTIONS
// ============================================================

async function getAllKelengkapan(filters = {}) {
  let sql = 'SELECT k.*, r.namaruangan FROM kelengkapans k LEFT JOIN rooms r ON k.idruangan = r.id WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND k.status = ?';
    params.push(filters.status);
  } else {
    sql += " AND k.status != 'D'";
  }
  
  if (filters.roomId) {
    sql += ' AND k.idruangan = ?';
    params.push(filters.roomId);
  }
  
  if (filters.search) {
    sql += ' AND k.NamaKelengkapan LIKE ?';
    params.push(`%${filters.search}%`);
  }
  
  sql += ' ORDER BY k.NamaKelengkapan ASC';
  
  if (filters.limit) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(filters.limit), parseInt(filters.offset || 0));
  }
  
  return await query(sql, params);
}

async function countKelengkapan(filters = {}) {
  let sql = 'SELECT COUNT(*) as count FROM kelengkapans WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  } else {
    sql += " AND status != 'D'";
  }
  
  if (filters.roomId) {
    sql += ' AND idruangan = ?';
    params.push(filters.roomId);
  }
  
  if (filters.search) {
    sql += ' AND NamaKelengkapan LIKE ?';
    params.push(`%${filters.search}%`);
  }
  
  const rows = await query(sql, params);
  return rows[0].count;
}

async function getKelengkapanById(id) {
  const rows = await query('SELECT * FROM kelengkapans WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getKelengkapanByRoom(roomId) {
  return await query("SELECT * FROM kelengkapans WHERE idruangan = ? AND status = 'A' ORDER BY NamaKelengkapan ASC", [roomId]);
}

async function createKelengkapan(data) {
  const result = await query(
    'INSERT INTO kelengkapans (idruangan, NamaKelengkapan, status, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
    [data.idruangan || null, data.NamaKelengkapan, data.status || 'A']
  );
  return result.insertId;
}

async function updateKelengkapan(id, data) {
  const fields = [];
  const values = [];
  
  if (data.idruangan !== undefined) { fields.push('idruangan = ?'); values.push(data.idruangan); }
  if (data.NamaKelengkapan !== undefined) { fields.push('NamaKelengkapan = ?'); values.push(data.NamaKelengkapan); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  await query(`UPDATE kelengkapans SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteKelengkapan(id) {
  await query("UPDATE kelengkapans SET status = 'D', updated_at = NOW() WHERE id = ?", [id]);
}

// ============================================================
// BOOKING (TREVENTS) FUNCTIONS
// ============================================================

async function getAllBookings(filters = {}) {
  let sql = `
    SELECT t.*, r.namaruangan, u.namalengkap, u.email, d.namadepartment
    FROM trevents t
    LEFT JOIN rooms r ON t.ruanganid = r.id
    LEFT JOIN users u ON t.userid = u.id
    LEFT JOIN departments d ON t.department = d.id
    WHERE 1=1
  `;
  const params = [];
  
  if (filters.status) {
    sql += ' AND t.status = ?';
    params.push(filters.status);
  }
  
  if (filters.roomId) {
    sql += ' AND t.ruanganid = ?';
    params.push(filters.roomId);
  }
  
  if (filters.userId) {
    sql += ' AND t.userid = ?';
    params.push(filters.userId);
  }
  
  if (filters.date) {
    sql += ' AND t.date = ?';
    params.push(filters.date);
  }
  
  if (filters.dateFrom) {
    sql += ' AND t.date >= ?';
    params.push(filters.dateFrom);
  }
  
  if (filters.dateTo) {
    sql += ' AND t.date <= ?';
    params.push(filters.dateTo);
  }
  
  if (filters.search) {
    sql += ' AND (t.eventname LIKE ? OR r.namaruangan LIKE ? OR u.namalengkap LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  
  sql += ' ORDER BY t.date DESC, t.timestart DESC';
  
  if (filters.limit) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(filters.limit), parseInt(filters.offset || 0));
  }
  
  return await query(sql, params);
}

async function countBookings(filters = {}) {
  let sql = 'SELECT COUNT(*) as count FROM trevents t WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    sql += ' AND t.status = ?';
    params.push(filters.status);
  }
  
  if (filters.roomId) {
    sql += ' AND t.ruanganid = ?';
    params.push(filters.roomId);
  }
  
  if (filters.userId) {
    sql += ' AND t.userid = ?';
    params.push(filters.userId);
  }
  
  if (filters.date) {
    sql += ' AND t.date = ?';
    params.push(filters.date);
  }
  
  if (filters.dateFrom) {
    sql += ' AND t.date >= ?';
    params.push(filters.dateFrom);
  }
  
  if (filters.dateTo) {
    sql += ' AND t.date <= ?';
    params.push(filters.dateTo);
  }
  
  if (filters.search) {
    sql += ` AND (t.eventname LIKE ? OR EXISTS (
      SELECT 1 FROM rooms r WHERE r.id = t.ruanganid AND r.namaruangan LIKE ?
    ) OR EXISTS (
      SELECT 1 FROM users u WHERE u.id = t.userid AND u.namalengkap LIKE ?
    ))`;
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  
  const rows = await query(sql, params);
  return rows[0].count;
}

async function getBookingById(id) {
  const rows = await query(`
    SELECT t.*, r.namaruangan, r.description as room_description, 
           u.namalengkap, u.email, u.notelp,
           d.namadepartment
    FROM trevents t
    LEFT JOIN rooms r ON t.ruanganid = r.id
    LEFT JOIN users u ON t.userid = u.id
    LEFT JOIN departments d ON t.department = d.id
    WHERE t.id = ?
  `, [id]);
  return rows[0] || null;
}

async function createBooking(data) {
  const result = await query(
    `INSERT INTO trevents 
    (ruanganid, userid, timestart, timeend, date, status, eventname, eventdescription, 
     eventpeoplequantity, kelengkapanruangan, department, created_at, updated_at) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      data.ruanganid,
      data.userid,
      data.timestart,
      data.timeend,
      data.date,
      data.status || 'P',
      data.eventname,
      data.eventdescription || '-',
      data.eventpeoplequantity,
      data.kelengkapanruangan || null,
      data.department || null
    ]
  );
  return result.insertId;
}

async function updateBooking(id, data) {
  const fields = [];
  const values = [];
  
  if (data.ruanganid !== undefined) { fields.push('ruanganid = ?'); values.push(data.ruanganid); }
  if (data.timestart !== undefined) { fields.push('timestart = ?'); values.push(data.timestart); }
  if (data.timeend !== undefined) { fields.push('timeend = ?'); values.push(data.timeend); }
  if (data.date !== undefined) { fields.push('date = ?'); values.push(data.date); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if (data.eventname !== undefined) { fields.push('eventname = ?'); values.push(data.eventname); }
  if (data.eventdescription !== undefined) { fields.push('eventdescription = ?'); values.push(data.eventdescription); }
  if (data.eventpeoplequantity !== undefined) { fields.push('eventpeoplequantity = ?'); values.push(data.eventpeoplequantity); }
  if (data.kelengkapanruangan !== undefined) { fields.push('kelengkapanruangan = ?'); values.push(data.kelengkapanruangan); }
  if (data.department !== undefined) { fields.push('department = ?'); values.push(data.department); }
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  await query(`UPDATE trevents SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteBooking(id) {
  // Soft delete by setting status to 'R' (rejected)
  await query("UPDATE trevents SET status = 'R', updated_at = NOW() WHERE id = ?", [id]);
}

// Check for booking conflicts
async function checkBookingConflict(roomId, date, timestart, timeend, excludeBookingId = null) {
  let sql = `
    SELECT * FROM trevents 
    WHERE ruanganid = ? AND date = ? 
    AND status IN ('P', 'A', 'confirmed') 
    AND timestart < ? AND timeend > ?
  `;
  const params = [roomId, date, timeend, timestart];
  
  if (excludeBookingId) {
    sql += ' AND id != ?';
    params.push(excludeBookingId);
  }
  
  const conflicts = await query(sql, params);
  return conflicts.length > 0 ? conflicts : null;
}

// Get available time slots for a room on a date
async function getAvailableTimeSlots(roomId, date) {
  // Get all accepted bookings for this room on this date
  const bookings = await query(
    "SELECT timestart, timeend FROM trevents WHERE ruanganid = ? AND date = ? AND status = 'A' ORDER BY timestart",
    [roomId, date]
  );
  
  // Get all time slots from mstime
  const startSlots = await query("SELECT time FROM mstime WHERE timevalue = 'alpha' ORDER BY time");
  const endSlots = await query("SELECT time FROM mstime WHERE timevalue = 'alphaend' ORDER BY time");
  
  return {
    startSlots: startSlots.map(s => s.time),
    endSlots: endSlots.map(s => s.time),
    bookedSlots: bookings
  };
}

// Get booking stats
async function getBookingStats() {
  const today = new Date().toISOString().split('T')[0];
  
  const [total, pending, accepted, todayBookings] = await Promise.all([
    query('SELECT COUNT(*) as count FROM trevents'),
    query("SELECT COUNT(*) as count FROM trevents WHERE status = 'P'"),
    query("SELECT COUNT(*) as count FROM trevents WHERE status IN ('A', 'confirmed')"),
    query("SELECT COUNT(*) as count FROM trevents WHERE date = ? AND status IN ('A', 'confirmed')", [today])
  ]);
  
  return {
    total: total[0].count,
    pending: pending[0].count,
    accepted: accepted[0].count,
    today: todayBookings[0].count
  };
}

// Get today's events
async function getTodayEvents() {
  const today = new Date().toISOString().split('T')[0];
  return await query(`
    SELECT t.*, r.namaruangan, u.namalengkap, d.namadepartment
    FROM trevents t
    LEFT JOIN rooms r ON t.ruanganid = r.id
    LEFT JOIN users u ON t.userid = u.id
    LEFT JOIN departments d ON t.department = d.id
    WHERE t.date = ? AND t.status = 'A'
    ORDER BY t.timestart ASC
  `, [today]);
}

// ============================================================
// BOOKING_USERS (ASSOCIATED USERS) FUNCTIONS
// ============================================================

async function addBookingUser(bookingId, userId) {
  try {
    await query(
      'INSERT INTO booking_users (booking_id, user_id, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
      [bookingId, userId]
    );
  } catch (err) {
    // Ignore duplicate key errors
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
}

async function removeBookingUser(bookingId, userId) {
  await query('DELETE FROM booking_users WHERE booking_id = ? AND user_id = ?', [bookingId, userId]);
}

async function getBookingUsers(bookingId) {
  return await query(`
    SELECT u.id, u.namalengkap, u.email
    FROM booking_users bu
    JOIN users u ON bu.user_id = u.id
    WHERE bu.booking_id = ?
    ORDER BY u.namalengkap
  `, [bookingId]);
}

async function getUserBookings(userId, includeAssociated = true) {
  if (!includeAssociated) {
    return await getAllBookings({ userId });
  }
  
  // Get bookings owned by user OR associated with user
  const sql = `
    SELECT DISTINCT t.*, r.namaruangan, u.namalengkap, d.namadepartment
    FROM trevents t
    LEFT JOIN rooms r ON t.ruanganid = r.id
    LEFT JOIN users u ON t.userid = u.id
    LEFT JOIN departments d ON t.department = d.id
    WHERE t.userid = ? OR EXISTS (
      SELECT 1 FROM booking_users bu WHERE bu.booking_id = t.id AND bu.user_id = ?
    )
    ORDER BY t.date DESC, t.timestart DESC
  `;
  return await query(sql, [userId, userId]);
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('id-ID', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
}

function formatTime(time) {
  if (!time) return '';
  return time.substring(0, 5); // HH:MM
}

function getBookingStatusLabel(status) {
  const labels = {
    'P': 'Tertunda',
    'pending': 'Tertunda',
    'A': 'Dikonfirmasi',
    'accepted': 'Dikonfirmasi',
    'confirmed': 'Dikonfirmasi',
    'R': 'Ditolak',
    'rejected': 'Ditolak',
    'C': 'Dibatalkan',
    'cancelled': 'Dibatalkan'
  };
  return labels[status] || status;
}

function getBookingStatusColor(status) {
  const colors = {
    'P': '#f59e0b',
    'pending': '#f59e0b',
    'A': '#10b981',
    'accepted': '#10b981',
    'confirmed': '#10b981',
    'R': '#ef4444',
    'rejected': '#ef4444',
    'C': '#6b7280',
    'cancelled': '#6b7280'
  };
  return colors[status] || '#6b7280';
}

// Export all functions
module.exports = {
  query,
  
  // Users
  findUserById,
  findUserByEmail,
  createUser,
  updateUser,
  deleteUser,
  getAllUsers,
  countUsers,
  isAdminUser,
  isSuperAdmin,
  
  // Rooms
  getAllRooms,
  countRooms,
  getRoomById,
  createRoom,
  updateRoom,
  deleteRoom,
  
  // Departments
  getAllDepartments,
  countDepartments,
  getDepartmentById,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  
  // Kelengkapan
  getAllKelengkapan,
  countKelengkapan,
  getKelengkapanById,
  getKelengkapanByRoom,
  createKelengkapan,
  updateKelengkapan,
  deleteKelengkapan,
  
  // Bookings
  getAllBookings,
  countBookings,
  getBookingById,
  createBooking,
  updateBooking,
  deleteBooking,
  checkBookingConflict,
  getAvailableTimeSlots,
  getBookingStats,
  getTodayEvents,
  
  // Booking Users
  addBookingUser,
  removeBookingUser,
  getBookingUsers,
  getUserBookings,
  
  // Utilities
  formatDate,
  formatTime,
  getBookingStatusLabel,
  getBookingStatusColor
};
