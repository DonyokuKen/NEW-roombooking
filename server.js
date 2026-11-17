'use strict';
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./lib/db');
const notify = require('./lib/notify');

const app = express();
const PORT = process.env.PORT || 3100;

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    httpOnly: true
  }
}));

// Flash messages middleware
app.use((req, res, next) => {
  res.locals.messages = req.session.messages || {};
  delete req.session.messages;
  next();
});

// Current user middleware
app.use(async (req, res, next) => {
  res.locals.currentUser = null;
  if (req.session.userId) {
    try {
      const user = await db.findUserById(req.session.userId);
      if (user) {
        res.locals.currentUser = {
          id: user.id,
          name: user.namalengkap,
          email: user.email,
          roles: user.roles,
          dept: user.dept,
          isAdmin: db.isAdminUser(user),
          isSuperAdmin: db.isSuperAdmin(user)
        };
        // Badge count for the navbar bell: recent notifications only,
        // so old entries can never inflate it.
        try {
          res.locals.notifCount = await notify.countRecentNotifications(user.id);
        } catch (err) {
          res.locals.notifCount = 0;
        }
      }
    } catch (err) {
      console.error('Error loading current user:', err);
    }
  }
  next();
});

// Layout wrapper — render every view inside views/layouts/main.ejs
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function (view, locals, callback) {
    if (typeof locals === 'function') {
      callback = locals;
      locals = {};
    }
    locals = locals || {};
    if (view === 'layouts/main' || view === 'layouts/admin') {
      return originalRender(view, locals, callback);
    }
    originalRender(view, locals, (err, html) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      const layoutLocals = Object.assign({}, locals, { body: html });
      const layoutView = locals.layout || res.locals.layout || 'layouts/main';
      originalRender(layoutView, layoutLocals, (layoutErr, fullHtml) => {
        if (layoutErr) {
          if (callback) return callback(layoutErr);
          return next(layoutErr);
        }
        if (callback) return callback(null, fullHtml);
        return res.send(fullHtml);
      });
    });
  };
  next();
});

// Helper functions
function setFlash(req, type, message) {
  if (!req.session.messages) req.session.messages = {};
  req.session.messages[type] = message;
}

function requireAuth(req, res, next) {
  if (!res.locals.currentUser) {
    setFlash(req, 'error', 'Silakan login terlebih dahulu');
    // Remember where they were headed, so login can send them back there
    // (e.g. the calendar booking form, or My Bookings). GET only: a POST
    // target can't be replayed after login.
    if (req.method === 'GET') {
      req.session.returnTo = req.originalUrl;
    }
    return res.redirect('/login');
  }
  next();
}

// Where to send the user after login/register: the page they were headed
// to, when it is a safe same-site path. Consumed once.
function consumeReturnTo(req) {
  const dest = req.session.returnTo;
  delete req.session.returnTo;
  return (typeof dest === 'string' && dest.startsWith('/') && !dest.startsWith('//')) ? dest : null;
}

function requireAdmin(req, res, next) {
  if (!res.locals.currentUser) {
    setFlash(req, 'error', 'Silakan login terlebih dahulu');
    return res.redirect('/login');
  }
  if (!res.locals.currentUser.isAdmin) {
    setFlash(req, 'error', 'Anda tidak memiliki akses admin');
    return res.redirect('/');
  }
  next();
}

// ============================================================
// PUBLIC ROUTES
// ============================================================

// Home/Dashboard
app.get('/', async (req, res) => {
  try {
    // User calendar: availability for the selected day (default today).
    // Only confirmed/pending bookings block a slot; rejected/cancelled do not.
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const shiftDate = (dateStr, days) => {
      const d = new Date(dateStr + 'T12:00:00');
      d.setDate(d.getDate() + days);
      return fmtDate(d);
    };
    const todayStr = fmtDate(now);
    const isAdmin = !!(res.locals.currentUser && res.locals.currentUser.isAdmin);
    // Regular users can only book 2 days out, so their calendar opens on
    // the first bookable day; admins open on today. minDate is the earliest
    // date a regular user may pick a slot on (the popup enforces it).
    const minDate = isAdmin ? todayStr : shiftDate(todayStr, 2);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : minDate;
    const shift = days => shiftDate(date, days);
    const roomFilter = req.query.room || '';
    const calRooms = await db.getAllRooms({ status: 'A' });
    const allBookings = await db.getAllBookings({ date, limit: 1000, offset: 0 });
    const calBookings = allBookings.filter(b => b.status === 'P' || b.status === 'A');
    const label = new Date(date + 'T12:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const minLabel = new Date(minDate + 'T12:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    res.render('index', {
      title: 'Dashboard - RoomBooking',
      date, prevDate: shift(-1), nextDate: shift(1), todayStr,
      label, calRooms, calBookings, roomFilter,
      startHour: 7, endHour: 23, minDate, minLabel, isAdmin
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Server error');
  }
});

// Rooms list
app.get('/rooms', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 12;
    const search = req.query.search || '';
    const status = req.query.status || 'A';
    
    const filters = {
      search,
      status,
      limit: perPage,
      offset: (page - 1) * perPage
    };
    
    const [rooms, total] = await Promise.all([
      db.getAllRooms(filters),
      db.countRooms(filters)
    ]);
    
    const totalPages = Math.ceil(total / perPage);
    
    res.render('rooms/index', {
      title: 'Daftar Ruangan',
      rooms,
      page,
      totalPages,
      total,
      search,
      status
    });
  } catch (err) {
    console.error('Rooms list error:', err);
    res.status(500).send('Server error');
  }
});

// Room detail
app.get('/rooms/:id', async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) {
      setFlash(req, 'error', 'Ruangan tidak ditemukan');
      return res.redirect('/rooms');
    }
    
    const equipment = await db.getKelengkapanByRoom(req.params.id);
    const today = new Date().toISOString().split('T')[0];
    const todayBookings = await db.getAllBookings({
      roomId: req.params.id,
      date: today,
      status: 'A'
    });
    
    res.render('rooms/show', {
      title: room.namaruangan,
      room,
      equipment,
      todayBookings
    });
  } catch (err) {
    console.error('Room detail error:', err);
    res.status(500).send('Server error');
  }
});

// ============================================================
// AUTHENTICATION ROUTES
// ============================================================

// Login page
app.get('/login', (req, res) => {
  if (res.locals.currentUser) {
    return res.redirect('/');
  }
  res.render('auth/login', { title: 'Login' });
});

// Login POST
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      setFlash(req, 'error', 'Email dan password harus diisi');
      return res.redirect('/login');
    }
    
    const user = await db.findUserByEmail(email);
    if (!user) {
      setFlash(req, 'error', 'Email atau password salah');
      return res.redirect('/login');
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      setFlash(req, 'error', 'Email atau password salah');
      return res.redirect('/login');
    }
    
    req.session.userId = user.id;
    setFlash(req, 'success', `Selamat datang, ${user.namalengkap}!`);

    const dest = consumeReturnTo(req);
    if (dest) {
      return res.redirect(dest);
    }
    if (db.isAdminUser(user)) {
      return res.redirect('/admin');
    }
    return res.redirect('/bookings');
  } catch (err) {
    console.error('Login error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/login');
  }
});

// Register page
app.get('/register', (req, res) => {
  if (res.locals.currentUser) {
    return res.redirect('/');
  }
  res.render('auth/register', { title: 'Daftar' });
});

// Register POST
app.post('/register', async (req, res) => {
  try {
    const { namalengkap, email, password, password_confirmation, notelp, alamat, gender } = req.body;
    
    // Validation
    if (!namalengkap || !email || !password || !notelp) {
      setFlash(req, 'error', 'Semua field wajib diisi');
      return res.redirect('/register');
    }
    
    if (password !== password_confirmation) {
      setFlash(req, 'error', 'Password dan konfirmasi password tidak cocok');
      return res.redirect('/register');
    }
    
    if (password.length < 6) {
      setFlash(req, 'error', 'Password minimal 6 karakter');
      return res.redirect('/register');
    }
    
    // Check if email exists
    const existingUser = await db.findUserByEmail(email);
    if (existingUser) {
      setFlash(req, 'error', 'Email sudah terdaftar');
      return res.redirect('/register');
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Default department: first ACTIVE one. The old hardcoded '1'
    // (Building Management) is status 'D' in the live DB, so new
    // signups were all filed under a deleted department.
    const activeDepts = await db.getAllDepartments({ status: 'A' });
    const defaultDept = activeDepts.length ? String(activeDepts[0].id) : '1';

    // Create user
    const userId = await db.createUser({
      namalengkap,
      email,
      password: hashedPassword,
      notelp,
      alamat: alamat || '-',
      gender: gender || 'L',
      dept: defaultDept, // First active department
      roles: 'U'
    });
    
    req.session.userId = userId;
    setFlash(req, 'success', 'Registrasi berhasil! Selamat datang!');
    const dest = consumeReturnTo(req);
    res.redirect(dest || '/bookings');
  } catch (err) {
    console.error('Register error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/register');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============================================================
// USER BOOKING ROUTES
// ============================================================

// My bookings
app.get('/bookings', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    
    const bookings = await db.getUserBookings(res.locals.currentUser.id);
    const total = bookings.length;
    const paginatedBookings = bookings.slice((page - 1) * perPage, page * perPage);
    const totalPages = Math.ceil(total / perPage);
    
    res.render('bookings/index', {
      title: 'Booking Saya',
      bookings: paginatedBookings,
      page,
      totalPages,
      total
    });
  } catch (err) {
    console.error('Bookings error:', err);
    res.status(500).send('Server error');
  }
});

// My notifications — newest first, recent window only by default so old
// entries can never bury the newest ones. ?all=1 shows older entries.
app.get('/notifications', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const showAll = req.query.all === '1';
    const { rows, total, totalPages } = await notify.getUserNotifications(
      res.locals.currentUser.id, page, showAll
    );
    res.render('notifications/index', {
      title: 'Notifikasi',
      notifications: rows,
      page,
      totalPages,
      total,
      showAll,
      windowDays: notify.DEFAULT_WINDOW_DAYS
    });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).send('Server error');
  }
});

// Polling API for browser notifications (the old Laravel loop, same
// shape): the installed app fetches its pending rows, shows each one
// as a browser notification, then marks it delivered. Newest first.
app.get('/api/notifications/pending', requireAuth, async (req, res) => {
  try {
    const notifications = await notify.getPendingNotifications(res.locals.currentUser.id);
    res.json({ notifications });
  } catch (err) {
    console.error('Pending notifications error:', err);
    res.status(500).json({ notifications: [] });
  }
});

app.put('/api/notifications/:id/deliver', requireAuth, async (req, res) => {
  try {
    const ok = await notify.markNotificationDelivered(req.params.id, res.locals.currentUser.id);
    if (!ok) return res.status(404).json({ success: false });
    res.json({ success: true });
  } catch (err) {
    console.error('Mark delivered error:', err);
    res.status(500).json({ success: false });
  }
});

// Create booking page
app.get('/bookings/create', requireAuth, async (req, res) => {
  try {
    const rooms = await db.getAllRooms({ status: 'A' });
    // Department picker + participant picker are admin-only: don't even
    // fetch those lists for regular users. They book under their own dept.
    const isAdmin = res.locals.currentUser.isAdmin;
    const departments = isAdmin ? await db.getAllDepartments({ status: 'A' }) : [];
    const users = isAdmin ? await db.getAllUsers({ status: 'A' }) : [];
    const selectedRoomId = req.query.room_id || null;

    // Prefill from calendar click-to-book (validated, else ignored)
    const prefill = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : '',
      timestart: /^([01]\d|2[0-3]):[0-5]\d$/.test(req.query.timestart || '') ? req.query.timestart : '',
      timeend: /^([01]\d|2[0-3]):[0-5]\d$/.test(req.query.timeend || '') ? req.query.timeend : ''
    };

    let equipment = [];
    if (selectedRoomId) {
      equipment = await db.getKelengkapanByRoom(selectedRoomId);
    }

    res.render('bookings/create', {
      title: 'Buat Booking Baru',
      rooms,
      departments,
      users,
      selectedRoomId,
      prefill,
      equipment
    });
  } catch (err) {
    console.error('Create booking page error:', err);
    res.status(500).send('Server error');
  }
});

// Store booking
app.post('/bookings', requireAuth, async (req, res) => {
  try {
    const {
      room_id,
      date,
      timestart,
      timeend,
      eventname,
      eventdescription,
      eventpeoplequantity,
      department,
      kelengkapan,
      associated_users
    } = req.body;
    
    // Department picker + participant picker are admin-only (same as the
    // old Laravel app): regular users book under their own department and
    // cannot attach participants, even via a crafted request.
    const isAdmin = res.locals.currentUser.isAdmin;

    // Validation (department is only required when the admin picks one)
    if (!room_id || !date || !timestart || !timeend || !eventname || !eventpeoplequantity || (isAdmin && !department)) {
      setFlash(req, 'error', 'Semua field wajib diisi');
      return res.redirect('/bookings/create');
    }
    
    // Check date is in future
    const bookingDate = new Date(date + ' ' + timestart);
    const now = new Date();
    
    if (bookingDate <= now) {
      setFlash(req, 'error', 'Tanggal dan waktu harus di masa depan');
      return res.redirect('/bookings/create');
    }
    
    // Booking window for non-admins: the date must be at least 2 days out.
    // Day-based, not exactly 48 hours: a booking 2 days later is fine even
    // if it is less than 48 hours away.
    if (!res.locals.currentUser.isAdmin) {
      const todayWib = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
      const t = new Date(todayWib + 'T12:00:00');
      t.setDate(t.getDate() + 2);
      const pad2 = n => String(n).padStart(2, '0');
      const earliest = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
      if (date < earliest) {
        setFlash(req, 'error', 'Booking harus dibuat minimal 2 hari sebelum acara');
        return res.redirect('/bookings/create');
      }
    }
    
    // Check for conflicts
    const conflicts = await db.checkBookingConflict(room_id, date, timestart, timeend);
    if (conflicts) {
      setFlash(req, 'error', 'Ruangan sudah dibooking pada waktu tersebut');
      return res.redirect('/bookings/create?room_id=' + room_id);
    }
    
    // Process kelengkapan
    let kelengkapanStr = null;
    if (kelengkapan && Array.isArray(kelengkapan)) {
      kelengkapanStr = kelengkapan.join(';');
    } else if (kelengkapan) {
      kelengkapanStr = kelengkapan.toString();
    }
    
    // Create booking
    const bookingId = await db.createBooking({
      ruanganid: room_id,
      userid: res.locals.currentUser.id,
      timestart,
      timeend,
      date,
      status: 'P', // Pending
      eventname,
      eventdescription: eventdescription || '-',
      eventpeoplequantity,
      kelengkapanruangan: kelengkapanStr,
      department: isAdmin ? (department || null) : (res.locals.currentUser.dept || null)
    });

    // Add associated users (admins only)
    if (isAdmin && associated_users && Array.isArray(associated_users)) {
      for (const userId of associated_users) {
        await db.addBookingUser(bookingId, userId);
      }
    }
    
    setFlash(req, 'success', 'Booking berhasil dibuat dan menunggu persetujuan admin');
    res.redirect('/bookings/' + bookingId);
  } catch (err) {
    console.error('Store booking error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/bookings/create');
  }
});

// Show booking
app.get('/bookings/:id', requireAuth, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/bookings');
    }
    
    // Check if user has access (owner or associated user or admin)
    const bookingUsers = await db.getBookingUsers(req.params.id);
    const hasAccess = booking.userid == res.locals.currentUser.id ||
                     bookingUsers.some(u => u.id == res.locals.currentUser.id) ||
                     res.locals.currentUser.isAdmin;
    
    if (!hasAccess) {
      setFlash(req, 'error', 'Anda tidak memiliki akses ke booking ini');
      return res.redirect('/bookings');
    }
    
    const equipment = booking.kelengkapanruangan ? 
      await db.getAllKelengkapan({ status: 'A' }) : [];
    
    res.render('bookings/show', {
      title: 'Detail Booking',
      booking,
      bookingUsers,
      equipment
    });
  } catch (err) {
    console.error('Show booking error:', err);
    res.status(500).send('Server error');
  }
});

// Edit booking page
app.get('/bookings/:id/edit', requireAuth, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/bookings');
    }
    
    // Only owner can edit and only pending bookings
    if (booking.userid != res.locals.currentUser.id) {
      setFlash(req, 'error', 'Anda tidak dapat mengedit booking ini');
      return res.redirect('/bookings/' + req.params.id);
    }
    
    if (booking.status !== 'P') {
      setFlash(req, 'error', 'Hanya booking yang tertunda yang dapat diedit');
      return res.redirect('/bookings/' + req.params.id);
    }
    
    const rooms = await db.getAllRooms({ status: 'A' });
    // Department picker is admin-only on the edit form too.
    const departments = res.locals.currentUser.isAdmin ? await db.getAllDepartments({ status: 'A' }) : [];
    const equipment = await db.getKelengkapanByRoom(booking.ruanganid);
    const users = await db.getAllUsers({ status: 'A' });
    const bookingUsers = await db.getBookingUsers(req.params.id);
    
    res.render('bookings/edit', {
      title: 'Edit Booking',
      booking,
      rooms,
      departments,
      equipment,
      users,
      bookingUsers
    });
  } catch (err) {
    console.error('Edit booking page error:', err);
    res.status(500).send('Server error');
  }
});

// Update booking
app.post('/bookings/:id', requireAuth, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/bookings');
    }
    
    if (booking.userid != res.locals.currentUser.id) {
      setFlash(req, 'error', 'Anda tidak dapat mengedit booking ini');
      return res.redirect('/bookings/' + req.params.id);
    }
    
    if (booking.status !== 'P') {
      setFlash(req, 'error', 'Hanya booking yang tertunda yang dapat diedit');
      return res.redirect('/bookings/' + req.params.id);
    }
    
    const {
      room_id,
      date,
      timestart,
      timeend,
      eventname,
      eventdescription,
      eventpeoplequantity,
      department,
      kelengkapan
    } = req.body;
    
    // Validation (department is NOT NULL in trevents — fail cleanly, not on the DB).
    // Regular users can't change the department: the booking keeps its own.
    const isAdmin = res.locals.currentUser.isAdmin;
    if (!room_id || !date || !timestart || !timeend || !eventname || !eventpeoplequantity || (isAdmin && !department)) {
      setFlash(req, 'error', 'Semua field wajib diisi');
      return res.redirect('/bookings/' + req.params.id + '/edit');
    }
    
    // Check for conflicts (exclude current booking)
    const conflicts = await db.checkBookingConflict(room_id, date, timestart, timeend, req.params.id);
    if (conflicts) {
      setFlash(req, 'error', 'Ruangan sudah dibooking pada waktu tersebut');
      return res.redirect('/bookings/' + req.params.id + '/edit');
    }
    
    let kelengkapanStr = null;
    if (kelengkapan && Array.isArray(kelengkapan)) {
      kelengkapanStr = kelengkapan.join(';');
    } else if (kelengkapan) {
      kelengkapanStr = kelengkapan.toString();
    }
    
    await db.updateBooking(req.params.id, {
      ruanganid: room_id,
      timestart,
      timeend,
      date,
      eventname,
      eventdescription: eventdescription || '-',
      eventpeoplequantity,
      kelengkapanruangan: kelengkapanStr,
      department: isAdmin ? (department || null) : booking.department
    });
    
    setFlash(req, 'success', 'Booking berhasil diupdate');
    res.redirect('/bookings/' + req.params.id);
  } catch (err) {
    console.error('Update booking error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/bookings/' + req.params.id + '/edit');
  }
});

// Cancel booking
app.post('/bookings/:id/cancel', requireAuth, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/bookings');
    }
    
    if (booking.userid != res.locals.currentUser.id) {
      setFlash(req, 'error', 'Anda tidak dapat membatalkan booking ini');
      return res.redirect('/bookings/' + req.params.id);
    }
    
    // Cannot cancel past bookings
    const bookingDate = new Date(booking.date + ' ' + booking.timestart);
    if (bookingDate < new Date()) {
      setFlash(req, 'error', 'Tidak dapat membatalkan booking yang sudah lewat');
      return res.redirect('/bookings/' + req.params.id);
    }
    
    // Cannot cancel confirmed booking within 48 hours
    if (booking.status === 'A') {
      const hoursDiff = (bookingDate - new Date()) / (1000 * 60 * 60);
      if (hoursDiff < 48) {
        setFlash(req, 'error', 'Booking yang sudah dikonfirmasi tidak dapat dibatalkan kurang dari 48 jam sebelum acara');
        return res.redirect('/bookings/' + req.params.id);
      }
    }
    
    await db.updateBooking(req.params.id, { status: 'C' });
    setFlash(req, 'success', 'Booking berhasil dibatalkan');
    res.redirect('/bookings/' + req.params.id);
  } catch (err) {
    console.error('Cancel booking error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/bookings/' + req.params.id);
  }
});

// ============================================================
// ADMIN ROUTES
// ============================================================

// Admin shell — every /admin page renders inside layouts/admin.ejs
app.use('/admin', (req, res, next) => {
  res.locals.layout = 'layouts/admin';
  const seg = (req.path || '/').split('/').filter(Boolean)[0] || '';
  res.locals.active = { '': 'overview', calendar: 'calendar', bookings: 'bookings', rooms: 'rooms', users: 'users', departments: 'departments', equipment: 'equipment' }[seg] || '';
  next();
});

// Admin dashboard
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const stats = await db.getBookingStats();
    const [totalRooms, totalUsers, totalDepartments] = await Promise.all([
      db.countRooms({ status: 'A' }),
      db.countUsers({ status: 'A' }),
      db.countDepartments({ status: 'A' })
    ]);

    const pendingBookings = await db.getAllBookings({ status: 'P', limit: 10 });
    const todayEvents = await db.getTodayEvents();
    // Equipment names for the pending list (kelengkapan shows inline, no
    // need to open the detail page). Same lookup as the detail page.
    const equipment = pendingBookings.some(b => b.kelengkapanruangan)
      ? await db.getAllKelengkapan({ status: 'A' })
      : [];

    res.render('admin/dashboard', {
      title: 'Ringkasan',
      stats: {
        ...stats,
        rooms: totalRooms,
        users: totalUsers,
        departments: totalDepartments
      },
      pendingBookings,
      todayEvents,
      equipment
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).send('Server error');
  }
});

// Admin calendar — day timeline, rooms as rows, bookings as blocks
app.get('/admin/calendar', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr;
    const shift = days => {
      const d = new Date(date + 'T12:00:00');
      d.setDate(d.getDate() + days);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const roomFilter = req.query.room || '';
    const rooms = await db.getAllRooms({ status: 'A' });
    const allBookings = await db.getAllBookings({ date, limit: 1000, offset: 0 });
    const bookings = roomFilter ? allBookings.filter(b => String(b.ruanganid) === String(roomFilter)) : allBookings;
    const label = new Date(date + 'T12:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    res.render('admin/calendar', {
      title: 'Kalender',
      date, prevDate: shift(-1), nextDate: shift(1), todayStr,
      label, rooms, bookings, roomFilter,
      startHour: 7, endHour: 23
    });
  } catch (err) {
    console.error('Admin calendar error:', err);
    res.status(500).send('Server error');
  }
});

// Admin bookings
app.get('/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const date = req.query.date || '';
    
    const filters = {
      search,
      status,
      date,
      limit: perPage,
      offset: (page - 1) * perPage
    };
    
    const [bookings, total] = await Promise.all([
      db.getAllBookings(filters),
      db.countBookings(filters)
    ]);
    
    const totalPages = Math.ceil(total / perPage);
    
    res.render('admin/bookings/index', {
      title: 'Kelola Booking',
      bookings,
      page,
      totalPages,
      total,
      search,
      status,
      date
    });
  } catch (err) {
    console.error('Admin bookings error:', err);
    res.status(500).send('Server error');
  }
});

// Admin approve booking
app.post('/admin/bookings/:id/approve', requireAdmin, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/admin/bookings');
    }
    
    if (booking.status !== 'P') {
      setFlash(req, 'error', 'Hanya booking tertunda yang dapat disetujui');
      return res.redirect('/admin/bookings/' + req.params.id);
    }
    
    await db.updateBooking(req.params.id, { status: 'A' });
    setFlash(req, 'success', 'Booking berhasil disetujui');
    // Acting from the dashboard list sends the admin back there (forms on
    // that page post next=/admin); otherwise fall through to the detail page.
    const next = req.body.next;
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
      return res.redirect(next);
    }
    res.redirect('/admin/bookings/' + req.params.id);
  } catch (err) {
    console.error('Approve booking error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/bookings');
  }
});

// Admin reject booking
app.post('/admin/bookings/:id/reject', requireAdmin, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/admin/bookings');
    }
    
    if (booking.status !== 'P') {
      setFlash(req, 'error', 'Hanya booking tertunda yang dapat ditolak');
      return res.redirect('/admin/bookings/' + req.params.id);
    }
    
    await db.updateBooking(req.params.id, { status: 'R' });
    setFlash(req, 'success', 'Booking berhasil ditolak');
    const next = req.body.next;
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
      return res.redirect(next);
    }
    res.redirect('/admin/bookings/' + req.params.id);
  } catch (err) {
    console.error('Reject booking error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/bookings');
  }
});

// Show booking (admin)
app.get('/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/admin/bookings');
    }
    
    const bookingUsers = await db.getBookingUsers(req.params.id);
    const equipment = booking.kelengkapanruangan ? 
      await db.getAllKelengkapan({ status: 'A' }) : [];
    
    res.render('admin/bookings/show', {
      title: 'Detail Booking',
      booking,
      bookingUsers,
      equipment
    });
  } catch (err) {
    console.error('Admin show booking error:', err);
    res.status(500).send('Server error');
  }
});

// Admin rooms
app.get('/admin/rooms', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const search = req.query.search || '';
    
    const filters = {
      search,
      limit: perPage,
      offset: (page - 1) * perPage
    };
    
    const [rooms, total] = await Promise.all([
      db.getAllRooms(filters),
      db.countRooms(filters)
    ]);
    
    const totalPages = Math.ceil(total / perPage);
    
    res.render('admin/rooms/index', {
      title: 'Kelola Ruangan',
      rooms,
      page,
      totalPages,
      total,
      search
    });
  } catch (err) {
    console.error('Admin rooms error:', err);
    res.status(500).send('Server error');
  }
});

// Create room page
app.get('/admin/rooms/create', requireAdmin, (req, res) => {
  res.render('admin/rooms/create', { title: 'Tambah Ruangan' });
});

// Store room
app.post('/admin/rooms', requireAdmin, async (req, res) => {
  try {
    const { namaruangan, description, status } = req.body;
    
    if (!namaruangan) {
      setFlash(req, 'error', 'Nama ruangan wajib diisi');
      return res.redirect('/admin/rooms/create');
    }
    
    await db.createRoom({
      namaruangan,
      description: description || '',
      status: status || 'A'
    });
    
    setFlash(req, 'success', 'Ruangan berhasil ditambahkan');
    res.redirect('/admin/rooms');
  } catch (err) {
    console.error('Store room error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/rooms/create');
  }
});

// Edit room page
app.get('/admin/rooms/:id/edit', requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) {
      setFlash(req, 'error', 'Ruangan tidak ditemukan');
      return res.redirect('/admin/rooms');
    }
    
    res.render('admin/rooms/edit', {
      title: 'Edit Ruangan',
      room
    });
  } catch (err) {
    console.error('Edit room page error:', err);
    res.status(500).send('Server error');
  }
});

// Update room
app.post('/admin/rooms/:id', requireAdmin, async (req, res) => {
  try {
    const { namaruangan, description, status } = req.body;
    
    if (!namaruangan) {
      setFlash(req, 'error', 'Nama ruangan wajib diisi');
      return res.redirect('/admin/rooms/' + req.params.id + '/edit');
    }
    
    await db.updateRoom(req.params.id, {
      namaruangan,
      description: description || '',
      status: status || 'A'
    });
    
    setFlash(req, 'success', 'Ruangan berhasil diupdate');
    res.redirect('/admin/rooms');
  } catch (err) {
    console.error('Update room error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  }
});

// Delete room
app.post('/admin/rooms/:id/delete', requireAdmin, async (req, res) => {
  try {
    await db.deleteRoom(req.params.id);
    setFlash(req, 'success', 'Ruangan berhasil dihapus');
    res.redirect('/admin/rooms');
  } catch (err) {
    console.error('Delete room error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/rooms');
  }
});

// Admin departments (similar structure to rooms)
app.get('/admin/departments', requireAdmin, async (req, res) => {
  try {
    const departments = await db.getAllDepartments({});
    res.render('admin/departments/index', {
      title: 'Kelola Departemen',
      departments
    });
  } catch (err) {
    console.error('Admin departments error:', err);
    res.status(500).send('Server error');
  }
});

// Admin equipment
app.get('/admin/equipment', requireAdmin, async (req, res) => {
  try {
    const equipment = await db.getAllKelengkapan({});
    const rooms = await db.getAllRooms({ status: 'A' });
    res.render('admin/equipment/index', {
      title: 'Kelola Kelengkapan',
      equipment,
      rooms
    });
  } catch (err) {
    console.error('Admin equipment error:', err);
    res.status(500).send('Server error');
  }
});

// Admin users
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const search = req.query.search || '';
    
    const filters = {
      search,
      limit: perPage,
      offset: (page - 1) * perPage
    };
    
    const [users, total] = await Promise.all([
      db.getAllUsers(filters),
      db.countUsers(filters)
    ]);
    
    const totalPages = Math.ceil(total / perPage);
    
    res.render('admin/users/index', {
      title: 'Kelola Pengguna',
      users,
      page,
      totalPages,
      total,
      search
    });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).send('Server error');
  }
});

// ============================================================
// API ROUTES
// ============================================================

// API: Get rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await db.getAllRooms({ status: 'A' });
    res.json({ success: true, data: rooms });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// API: Get departments
app.get('/api/departments', async (req, res) => {
  try {
    const departments = await db.getAllDepartments({ status: 'A' });
    res.json({ success: true, data: departments });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// API: Get equipment by room
app.get('/api/kelengkapan', async (req, res) => {
  try {
    const roomId = req.query.room;
    if (!roomId) {
      return res.json({ success: true, data: [] });
    }
    const equipment = await db.getKelengkapanByRoom(roomId);
    res.json({ success: true, data: equipment });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// API: Check booking conflict
app.post('/api/check-conflict', async (req, res) => {
  try {
    const { room_id, date, timestart, timeend, booking_id } = req.body;
    const conflicts = await db.checkBookingConflict(room_id, date, timestart, timeend, booking_id);
    res.json({ success: true, hasConflict: !!conflicts, conflicts: conflicts || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// API: Get available time slots
app.get('/api/available-times', async (req, res) => {
  try {
    const { room, date } = req.query;
    if (!room || !date) {
      return res.status(400).json({ success: false, error: 'Room and date required' });
    }
    const slots = await db.getAvailableTimeSlots(room, date);
    res.json({ success: true, data: slots });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================
// ERROR HANDLERS
// ============================================================

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 - Halaman Tidak Ditemukan',
    message: 'Halaman yang Anda cari tidak ditemukan'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).render('error', {
    title: '500 - Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Terjadi kesalahan server'
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, async () => {
  console.log(`🚀 RoomBooking server running on http://localhost:${PORT}`);
  console.log(`📅 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🕐 Timezone: ${process.env.TZ || 'UTC'}`);
  // Never send ancient reminders as spam: expire pending notifications
  // whose events already happened (the old scheduler left 594 behind).
  try {
    const expired = await notify.expireStaleNotifications();
    if (expired > 0) console.log(`🔔 Expired ${expired} stale pending notification(s)`);
  } catch (err) {
    console.error('Failed to expire stale notifications:', err.message);
  }
  // Day-of reminders: admins get today's bookings, each user only
  // their own. Dedupe makes restarts safe — no duplicate spam.
  try {
    const r = await notify.createDayReminders();
    if (r.created > 0) console.log(`🔔 Created ${r.created} day-of reminder(s) for ${r.date}`);
  } catch (err) {
    console.error('Failed to create day-of reminders:', err.message);
  }
});
