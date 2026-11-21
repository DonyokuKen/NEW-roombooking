'use strict';
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./lib/db');
const notify = require('./lib/notify');
const settings = require('./lib/settings');
const merge = require('./lib/merge');
const passwordReset = require('./lib/passwordReset');
const whatsapp = require('./lib/whatsapp');

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
        // One-time popup for long-dormant users (flagged at login).
        res.locals.showDeptNotice = !!req.session.showDeptNotice;
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

// Super admin only (roles SU): user editing with password reset.
function requireSuperAdmin(req, res, next) {
  if (!res.locals.currentUser) {
    setFlash(req, 'error', 'Silakan login terlebih dahulu');
    return res.redirect('/login');
  }
  if (!res.locals.currentUser.isSuperAdmin) {
    setFlash(req, 'error', 'Hanya Super Admin yang dapat mengakses halaman ini');
    return res.redirect('/admin/users');
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
    // Regular users can only book windowDays out, so their calendar opens on
    // the first bookable day; admins open on today. minDate is the earliest
    // date a regular user may pick a slot on (the popup enforces it).
    // The window is an admin setting (lib/settings.js), not hardcoded.
    const windowDays = settings.getBookingWindowDays();
    const minDate = isAdmin ? todayStr : shiftDate(todayStr, windowDays);
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
      label, calRooms, calBookings, roomFilter, windowDays,
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
  res.render('auth/login', {
    title: 'Login',
    emailResetEnabled: settings.getEmailSettings().emailResetEnabled
  });
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

    // Long-dormant users get a one-time popup pointing them to the
    // profile page, where they can update their department. "Dormant"
    // = previous login over a year ago, or no tracked login at all on
    // an account older than a year (login tracking only started
    // 2026-11-17, so a NULL last_login_at on an old account means we
    // have never seen them come back).
    const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const prevLogin = user.last_login_at ? new Date(user.last_login_at).getTime() : null;
    const accountOld = user.created_at && new Date(user.created_at).getTime() < yearAgo;
    if ((prevLogin && prevLogin < yearAgo) || (!prevLogin && accountOld)) {
      req.session.showDeptNotice = true;
    }

    // Record the login time for the admin "Login Terakhir" column. A
    // failure here must never block the login itself.
    try {
      await db.updateLastLogin(user.id);
    } catch (e) {
      console.error('updateLastLogin failed (login continues):', e.message);
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

// ============================================================
// PASSWORD RESET BY EMAIL (only when enabled in settings)
// ============================================================
// The reset link is built from the request host: http for a local host,
// https otherwise (the app sits behind a TLS-terminating tunnel in
// production, so req.protocol would wrongly say http there).
function resetLinkFor(req, token, email) {
  const host = req.get('host') || 'roombooking.ahaide.dpdns.org';
  const proto = /^(127\.0\.0\.1|localhost)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}/reset-password/${token}?email=${encodeURIComponent(email)}`;
}

// Request reset page.
app.get('/forgot-password', (req, res) => {
  if (!settings.getEmailSettings().emailResetEnabled) {
    setFlash(req, 'error', 'Reset password lewat email sedang tidak aktif. Contact administrator to reset password.');
    return res.redirect('/login');
  }
  res.render('auth/forgot-password', { title: 'Lupa Password' });
});

// Request reset: same generic reply whether the email exists or not, so
// the page never reveals which emails are registered. A send failure is
// flashed clearly and the token is removed again — no crash, no 500, and
// the password is left unchanged.
app.post('/forgot-password', async (req, res) => {
  try {
    if (!settings.getEmailSettings().emailResetEnabled) {
      setFlash(req, 'error', 'Reset password lewat email sedang tidak aktif. Contact administrator to reset password.');
      return res.redirect('/login');
    }
    const email = (req.body.email || '').trim().toLowerCase();
    const generic = 'Jika email terdaftar, tautan reset password sudah dikirim. Periksa kotak masuk Anda (berlaku 60 menit).';
    if (!email) {
      setFlash(req, 'error', 'Email wajib diisi');
      return res.redirect('/forgot-password');
    }
    const user = await db.findUserByEmail(email);
    if (!user) {
      setFlash(req, 'success', generic);
      return res.redirect('/login');
    }
    const token = passwordReset.generateToken();
    const tokenHash = passwordReset.hashToken(token);
    await db.createPasswordReset(email, tokenHash);
    try {
      await passwordReset.sendResetEmail(
        settings.getAll(),
        email,
        resetLinkFor(req, token, email)
      );
    } catch (err) {
      console.error('Send reset email error:', err);
      await db.deletePasswordReset(email);
      setFlash(req, 'error', 'Gagal mengirim email reset password (' + (err.message || 'periksa pengaturan SMTP') + '). Password Anda tidak berubah.');
      return res.redirect('/forgot-password');
    }
    setFlash(req, 'success', generic);
    res.redirect('/login');
  } catch (err) {
    console.error('Forgot password error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/forgot-password');
  }
});

// Reset form: token + email from the link. Invalid or expired tokens go
// back to the request page with a plain message.
app.get('/reset-password/:token', async (req, res) => {
  try {
    if (!settings.getEmailSettings().emailResetEnabled) {
      setFlash(req, 'error', 'Reset password lewat email sedang tidak aktif. Contact administrator to reset password.');
      return res.redirect('/login');
    }
    const email = (req.query.email || '').trim().toLowerCase();
    const row = email ? await db.findPasswordReset(email, passwordReset.hashToken(req.params.token)) : null;
    if (!row || passwordReset.isExpired(row)) {
      setFlash(req, 'error', 'Tautan reset tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.');
      return res.redirect('/forgot-password');
    }
    res.render('auth/reset-password', { title: 'Reset Password', token: req.params.token, email });
  } catch (err) {
    console.error('Reset password page error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/forgot-password');
  }
});

// Apply the new password: bcrypt-hash, save, invalidate the token so the
// link cannot be reused.
app.post('/reset-password/:token', async (req, res) => {
  try {
    if (!settings.getEmailSettings().emailResetEnabled) {
      setFlash(req, 'error', 'Reset password lewat email sedang tidak aktif. Contact administrator to reset password.');
      return res.redirect('/login');
    }
    const email = (req.body.email || '').trim().toLowerCase();
    const { password, password_confirmation } = req.body;
    const row = email ? await db.findPasswordReset(email, passwordReset.hashToken(req.params.token)) : null;
    if (!row || passwordReset.isExpired(row)) {
      setFlash(req, 'error', 'Tautan reset tidak valid atau sudah kedaluwarsa. Silakan minta tautan baru.');
      return res.redirect('/forgot-password');
    }
    if (!password || password.length < 6) {
      setFlash(req, 'error', 'Password baru minimal 6 karakter');
      return res.redirect('/reset-password/' + req.params.token + '?email=' + encodeURIComponent(email));
    }
    if (password !== password_confirmation) {
      setFlash(req, 'error', 'Password dan konfirmasi password tidak cocok');
      return res.redirect('/reset-password/' + req.params.token + '?email=' + encodeURIComponent(email));
    }
    const user = await db.findUserByEmail(email);
    if (!user) {
      setFlash(req, 'error', 'Tautan reset tidak valid. Silakan minta tautan baru.');
      return res.redirect('/forgot-password');
    }
    await db.updateUser(user.id, { password: await bcrypt.hash(password, 10) });
    await db.deletePasswordReset(email);
    setFlash(req, 'success', 'Password berhasil direset. Silakan login dengan password baru Anda.');
    res.redirect('/login');
  } catch (err) {
    console.error('Apply reset password error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/forgot-password');
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
// PROFILE ROUTES
// ============================================================

// My profile — users may edit their department, email and phone
// number. The name is read-only: it is displayed but never accepted
// from the form, so a crafted request cannot change it.
app.get('/profile', requireAuth, async (req, res) => {
  // Visiting the profile page counts as having seen the notice.
  req.session.showDeptNotice = false;
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan');
      return res.redirect('/login');
    }
    const departments = await db.getAllDepartments({ status: 'A' });
    res.render('profile', { title: 'Profil Saya', user, departments });
  } catch (err) {
    console.error('Profile page error:', err);
    res.status(500).send('Server error');
  }
});

app.post('/profile', requireAuth, async (req, res) => {
  try {
    const user = await db.findUserById(req.session.userId);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan');
      return res.redirect('/login');
    }

    const email = (req.body.email || '').trim();
    const notelp = (req.body.notelp || '').trim();
    const dept = req.body.department;

    // Validation. namalengkap is deliberately never read from the body.
    if (!email || !notelp || !dept) {
      setFlash(req, 'error', 'Semua field wajib diisi');
      return res.redirect('/profile');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFlash(req, 'error', 'Format email tidak valid');
      return res.redirect('/profile');
    }
    const departments = await db.getAllDepartments({ status: 'A' });
    if (!departments.some(d => String(d.id) === String(dept))) {
      setFlash(req, 'error', 'Pilih departemen yang valid');
      return res.redirect('/profile');
    }
    // Email is the login identifier, so it must stay unique.
    const existing = await db.findUserByEmail(email);
    if (existing && String(existing.id) !== String(user.id)) {
      setFlash(req, 'error', 'Email sudah dipakai pengguna lain');
      return res.redirect('/profile');
    }

    await db.updateUser(user.id, { email, notelp, dept });
    setFlash(req, 'success', 'Profil berhasil diperbarui');
    res.redirect('/profile');
  } catch (err) {
    console.error('Update profile error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/profile');
  }
});

// Dismiss the dormant-user profile notice for this session.
app.post('/profile-notice/dismiss', requireAuth, (req, res) => {
  req.session.showDeptNotice = false;
  res.json({ success: true });
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
    // The participant picker is admin-only. The department list is for
    // everyone: regular users pick the booking's department themselves
    // (mandatory), admins derive it from Peserta Terkait instead.
    const isAdmin = res.locals.currentUser.isAdmin;
    const departments = await db.getAllDepartments({ status: 'A' });
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
      equipment,
      windowDays: settings.getBookingWindowDays()
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

    // Participant picker is admin-only (same as the old Laravel app):
    // regular users cannot attach participants, even via a crafted
    // request. Admins no longer pick a department on the form at all:
    // the booking's department follows the first chosen Peserta Terkait,
    // and falls back to the admin's own department when none is chosen.
    // Regular users pick the department themselves on the form — it is
    // mandatory and must be one of the active departments.
    const isAdmin = res.locals.currentUser.isAdmin;

    // Validation
    if (!room_id || !date || !timestart || !timeend || !eventname || !eventpeoplequantity || (!isAdmin && !department)) {
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
    
    // Booking window for non-admins: the date must be at least windowDays
    // out. Day-based, not exactly N*24 hours: a booking N days later is
    // fine even if it is less than N*24 hours away. The window is an admin
    // setting (lib/settings.js), not hardcoded; 0 means same-day is fine.
    const windowDays = settings.getBookingWindowDays();
    if (!res.locals.currentUser.isAdmin) {
      const todayWib = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
      const t = new Date(todayWib + 'T12:00:00');
      t.setDate(t.getDate() + windowDays);
      const pad2 = n => String(n).padStart(2, '0');
      const earliest = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
      if (date < earliest) {
        setFlash(req, 'error', `Booking harus dibuat minimal ${windowDays} hari sebelum acara`);
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
    
    // Resolve the booking's department. For admins it follows the first
    // chosen Peserta Terkait, falling back to the admin's own department.
    // Regular users choose it on the form; the value must be an active
    // department, never silently their account's department.
    let bookingDept = null;
    if (isAdmin) {
      const assocIds = Array.isArray(associated_users)
        ? associated_users
        : (associated_users ? [associated_users] : []);
      for (const uid of assocIds) {
        const assocUser = await db.findUserById(uid);
        if (assocUser && assocUser.dept) { bookingDept = assocUser.dept; break; }
      }
      bookingDept = bookingDept || res.locals.currentUser.dept || null;
    } else {
      const activeDepts = await db.getAllDepartments({ status: 'A' });
      if (activeDepts.some(d => String(d.id) === String(department))) {
        bookingDept = department;
      }
    }
    if (!bookingDept) {
      setFlash(req, 'error', isAdmin
        ? 'Departemen tidak ditemukan — pilih Peserta Terkait atau lengkapi departemen Anda'
        : 'Pilih departemen untuk booking ini');
      return res.redirect('/bookings/create');
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
      department: bookingDept
    });

    // Add associated users (admins only)
    if (isAdmin && associated_users && Array.isArray(associated_users)) {
      for (const userId of associated_users) {
        await db.addBookingUser(bookingId, userId);
      }
    }

    // WhatsApp notification — the old Telegram "New Booking Request"
    // (admins get the admin title, as the old ManagerController did).
    // Fire-and-forget: a gateway failure must never block the booking.
    whatsapp.notifyBookingEvent(isAdmin ? 'created-admin' : 'created', bookingId)
      .catch(err => console.error('WhatsApp notify failed:', err.message));

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
    
    // Who can edit: Super Admin any booking; any admin a pending booking;
    // the owner their own pending booking.
    const isSU = res.locals.currentUser.isSuperAdmin;
    const isAdmin = res.locals.currentUser.isAdmin;
    if (!isSU && booking.status !== 'P') {
      setFlash(req, 'error', 'Hanya booking yang tertunda yang dapat diedit');
      return res.redirect('/bookings/' + req.params.id);
    }

    if (!isSU && !isAdmin && booking.userid != res.locals.currentUser.id) {
      setFlash(req, 'error', 'Anda tidak dapat mengedit booking ini');
      return res.redirect('/bookings/' + req.params.id);
    }

    const rooms = await db.getAllRooms({ status: 'A' });
    // Everyone gets the department picker on the edit form: the booking
    // owner chooses the department, same as on the create form.
    const departments = await db.getAllDepartments({ status: 'A' });
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
    
    // Same rule as the edit page: Super Admin any booking; any admin a
    // pending booking; the owner their own pending booking.
    const isSU = res.locals.currentUser.isSuperAdmin;
    const isAdmin = res.locals.currentUser.isAdmin;
    if (!isSU && booking.status !== 'P') {
      setFlash(req, 'error', 'Hanya booking yang tertunda yang dapat diedit');
      return res.redirect('/bookings/' + req.params.id);
    }

    if (!isSU && !isAdmin && booking.userid != res.locals.currentUser.id) {
      setFlash(req, 'error', 'Anda tidak dapat mengedit booking ini');
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
    // Everyone picks the department on the edit form; it is mandatory.
    // A submitted value that is not an active department is rejected,
    // unless it is the booking's current (possibly legacy) value.
    if (!room_id || !date || !timestart || !timeend || !eventname || !eventpeoplequantity || !department) {
      setFlash(req, 'error', 'Semua field wajib diisi');
      return res.redirect('/bookings/' + req.params.id + '/edit');
    }
    const activeDepts = await db.getAllDepartments({ status: 'A' });
    if (!activeDepts.some(d => String(d.id) === String(department)) && String(department) !== String(booking.department)) {
      setFlash(req, 'error', 'Pilih departemen untuk booking ini');
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
      department
    });

    // "Simpan & Setujui": an admin saving a pending booking can approve it
    // in the same click — same status flip + WhatsApp notice as the
    // approve button on the detail page.
    const saveApprove = req.body.action === 'save_approve' && isAdmin && booking.status === 'P';
    if (saveApprove) {
      await db.updateBooking(req.params.id, { status: 'A' });
      whatsapp.notifyBookingEvent('approved', req.params.id)
        .catch(err => console.error('WhatsApp notify failed:', err.message));
      setFlash(req, 'success', 'Booking berhasil diupdate dan disetujui');
    } else {
      setFlash(req, 'success', 'Booking berhasil diupdate');
    }
    res.redirect(isAdmin ? '/admin/bookings/' + req.params.id : '/bookings/' + req.params.id);
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
    // WhatsApp notification — the old Telegram "Booking Deleted" (the new
    // app has no hard delete; cancelling is the equivalent).
    whatsapp.notifyBookingEvent('cancelled', req.params.id)
      .catch(err => console.error('WhatsApp notify failed:', err.message));
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
  res.locals.active = { '': 'overview', calendar: 'calendar', bookings: 'bookings', rooms: 'rooms', users: 'users', departments: 'departments', equipment: 'equipment', settings: 'settings', profile: 'profile' }[seg] || '';
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
    // WhatsApp notification — the old Telegram "New Approved Booking
    // Request". Fire-and-forget, never blocks the response.
    whatsapp.notifyBookingEvent('approved', req.params.id)
      .catch(err => console.error('WhatsApp notify failed:', err.message));
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
    // WhatsApp notification. The old Telegram code sent the same
    // "approved" text for a rejection; WhatsApp says rejected plainly.
    whatsapp.notifyBookingEvent('rejected', req.params.id)
      .catch(err => console.error('WhatsApp notify failed:', err.message));
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

// Cancel a booking (admin only). Unlike the user's own cancel, there is
// no 48-hour rule and no past-booking block: an admin cancelling a
// confirmed booking is an override (room out of service, double booking,
// event called off). Works on pending bookings too.
app.post('/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const booking = await db.getBookingById(req.params.id);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan');
      return res.redirect('/admin/bookings');
    }

    if (booking.status !== 'P' && booking.status !== 'A') {
      setFlash(req, 'error', 'Booking ini sudah tidak aktif');
      return res.redirect('/admin/bookings/' + req.params.id);
    }

    await db.updateBooking(req.params.id, { status: 'C' });
    // WhatsApp notification — same "Booking Cancelled" as the user's cancel.
    whatsapp.notifyBookingEvent('cancelled', req.params.id)
      .catch(err => console.error('WhatsApp notify failed:', err.message));
    setFlash(req, 'success', 'Booking berhasil dibatalkan');
    const next = req.body.next;
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
      return res.redirect(next);
    }
    res.redirect('/admin/bookings/' + req.params.id);
  } catch (err) {
    console.error('Admin cancel booking error:', err);
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
    const equipment = await db.getAllKelengkapan({ roomId: req.params.id });
    // Unassigned equipment (idruangan NULL, "Tanpa Ruangan") offered for
    // attaching to this room. The fetch itself was never broken — most
    // rooms genuinely have no assigned rows (only 12 of 26 active rooms
    // have any; 15 active items are unassigned) — but the page offered no
    // way to pull those items in, only to create new rows.
    const unassigned = await db.getAllKelengkapan({ unassigned: true });

    res.render('admin/rooms/edit', {
      title: 'Edit Ruangan',
      room,
      equipment,
      unassigned
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

// Add equipment to a room (from the Edit Ruangan page)
app.post('/admin/rooms/:id/equipment', requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) {
      setFlash(req, 'error', 'Ruangan tidak ditemukan');
      return res.redirect('/admin/rooms');
    }
    const name = (req.body.NamaKelengkapan || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Nama kelengkapan wajib diisi');
      return res.redirect('/admin/rooms/' + req.params.id + '/edit');
    }
    await db.createKelengkapan({ idruangan: req.params.id, NamaKelengkapan: name, status: 'A' });
    setFlash(req, 'success', `Kelengkapan "${name}" ditambahkan ke ${room.namaruangan}`);
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  } catch (err) {
    console.error('Add room equipment error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  }
});

// Remove equipment from a room (soft-delete, status='D')
app.post('/admin/rooms/:id/equipment/:eqId/delete', requireAdmin, async (req, res) => {
  try {
    const item = await db.getKelengkapanById(req.params.eqId);
    if (!item || String(item.idruangan) !== String(req.params.id)) {
      setFlash(req, 'error', 'Kelengkapan tidak ditemukan di ruangan ini');
      return res.redirect('/admin/rooms/' + req.params.id + '/edit');
    }
    await db.deleteKelengkapan(req.params.eqId);
    setFlash(req, 'success', `Kelengkapan "${item.NamaKelengkapan}" dihapus dari ruangan`);
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  } catch (err) {
    console.error('Delete room equipment error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  }
});

// Attach EXISTING unassigned equipment to a room (from the Edit Ruangan
// page). Only items with no room yet (idruangan NULL) can be attached —
// taking an item from another room would strip that room, so it is
// refused. The item keeps its id, so booking references still resolve.
app.post('/admin/rooms/:id/equipment/attach', requireAdmin, async (req, res) => {
  try {
    const room = await db.getRoomById(req.params.id);
    if (!room) {
      setFlash(req, 'error', 'Ruangan tidak ditemukan');
      return res.redirect('/admin/rooms');
    }
    const item = await db.getKelengkapanById(req.body.eqId);
    if (!item || item.status === 'D' || item.idruangan !== null) {
      setFlash(req, 'error', 'Kelengkapan tidak tersedia untuk dipasang (sudah ada ruangan atau sudah dihapus)');
      return res.redirect('/admin/rooms/' + req.params.id + '/edit');
    }
    await db.updateKelengkapan(item.id, { idruangan: req.params.id });
    setFlash(req, 'success', `Kelengkapan "${item.NamaKelengkapan}" dipasang ke ${room.namaruangan}`);
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  } catch (err) {
    console.error('Attach room equipment error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/rooms/' + req.params.id + '/edit');
  }
});

// Admin departments (similar structure to rooms)
app.get('/admin/departments', requireAdmin, async (req, res) => {
  try {
    const departments = await db.getAllDepartments({});
    // Duplicate groups (same normalized name) with a preview: keeper =
    // lowest id, losers, and how many members each row has. Members are
    // users whose dept is the department id OR its name.
    const duplicateGroups = merge.groupDepartmentDuplicates(departments);
    const allUsers = await db.getAllUsers({});
    const memberCount = {};
    for (const d of departments) {
      memberCount[d.id] = allUsers.filter(u =>
        String(u.dept) === String(d.id) ||
        merge.normalizeName(u.dept) === merge.normalizeName(d.namadepartment)
      ).length;
    }
    // Booking counts per department, same id-OR-name match as the detail
    // page (trevents.department is an id on most rows, a name on 221).
    const allBookings = await db.getAllBookings({ limit: 10000, offset: 0 });
    const bookingCount = {};
    for (const d of departments) {
      bookingCount[d.id] = allBookings.filter(b =>
        String(b.department) === String(d.id) ||
        merge.normalizeName(b.department) === merge.normalizeName(d.namadepartment)
      ).length;
    }
    res.render('admin/departments/index', {
      title: 'Kelola Departemen',
      departments,
      duplicateGroups,
      memberCount,
      bookingCount
    });
  } catch (err) {
    console.error('Admin departments error:', err);
    res.status(500).send('Server error');
  }
});

// Merge one department duplicate group. Re-computed from live data first.
app.post('/admin/departments/merge', requireAdmin, async (req, res) => {
  try {
    const keeperId = parseInt(req.body.keeperId, 10);
    const loserIds = [...new Set(
      (Array.isArray(req.body.loserIds) ? req.body.loserIds : [req.body.loserIds])
        .map(v => parseInt(v, 10)).filter(n => !Number.isNaN(n))
    )];
    const departments = await db.getAllDepartments({});
    const group = merge.groupDepartmentDuplicates(departments)
      .find(g => g.keeper.id === keeperId);
    const posted = [...loserIds].sort((a, b) => a - b);
    const actual = group ? group.losers.map(l => l.id).sort((a, b) => a - b) : [];
    if (!group || posted.length === 0 || JSON.stringify(posted) !== JSON.stringify(actual)) {
      setFlash(req, 'error', 'Grup duplikat tidak ditemukan atau sudah berubah — muat ulang halaman dan coba lagi');
      return res.redirect('/admin/departments');
    }
    const stats = await db.withTransaction(q => merge.mergeDepartmentGroup(q, group.keeper, group.losers));
    setFlash(req, 'success',
      `Digabung: "${group.keeper.namadepartment}" (id ${keeperId}) dipertahankan, ${stats.losersDeleted} duplikat dihapus. ` +
      `${stats.usersById} pengguna (dept id) dan ${stats.usersByName} pengguna (dept nama) dialihkan, ${stats.treventsByName} booking dialihkan. Semua pengguna tetap ada.`);
    res.redirect('/admin/departments');
  } catch (err) {
    console.error('Merge department error:', err);
    setFlash(req, 'error', 'Gagal menggabung: ' + err.message);
    res.redirect('/admin/departments');
  }
});

// Delete department (soft-delete, status='D'). Members and bookings are
// NOT deleted — their department reference is left as-is (the app already
// tolerates users pointing at soft-deleted departments). Deliberately uses
// updateDepartment, not db.deleteDepartment: that helper refuses when any
// booking carries the department id, which contradicts this behaviour.
app.post('/admin/departments/:id/delete', requireAdmin, async (req, res) => {
  try {
    const department = await db.getDepartmentById(req.params.id);
    if (!department) {
      setFlash(req, 'error', 'Departemen tidak ditemukan');
      return res.redirect('/admin/departments');
    }
    if (department.status === 'D') {
      setFlash(req, 'error', 'Departemen sudah dihapus');
      return res.redirect('/admin/departments');
    }
    await db.updateDepartment(req.params.id, { status: 'D' });
    setFlash(req, 'success', `Departemen "${department.namadepartment}" dihapus. Anggota dan booking tidak dihapus — referensi departemen mereka dibiarkan apa adanya.`);
    res.redirect('/admin/departments');
  } catch (err) {
    console.error('Delete department error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/departments');
  }
});

// Delete department PERMANENTLY (hard delete of the row). Super Admin
// only. Allowed only when no user and no booking references the
// department — the counts are recomputed from live data with the same
// id-OR-normalized-name match as the departments list page, so a
// department that still has members or bookings is refused instead of
// orphaning those references.
app.post('/admin/departments/:id/delete-permanent', requireSuperAdmin, async (req, res) => {
  try {
    const department = await db.getDepartmentById(req.params.id);
    if (!department) {
      setFlash(req, 'error', 'Departemen tidak ditemukan');
      return res.redirect('/admin/departments');
    }
    const allUsers = await db.getAllUsers({});
    const members = allUsers.filter(u =>
      String(u.dept) === String(department.id) ||
      merge.normalizeName(u.dept) === merge.normalizeName(department.namadepartment)
    ).length;
    const allBookings = await db.getAllBookings({ limit: 10000, offset: 0 });
    const bookings = allBookings.filter(b =>
      String(b.department) === String(department.id) ||
      merge.normalizeName(b.department) === merge.normalizeName(department.namadepartment)
    ).length;
    if (members > 0 || bookings > 0) {
      setFlash(req, 'error', `Departemen "${department.namadepartment}" tidak bisa dihapus permanen: masih ada ${members} anggota dan ${bookings} booking yang merujuk ke departemen ini.`);
      return res.redirect('/admin/departments');
    }
    await db.hardDeleteDepartment(req.params.id);
    setFlash(req, 'success', `Departemen "${department.namadepartment}" dihapus permanen.`);
    res.redirect('/admin/departments');
  } catch (err) {
    console.error('Delete department permanent error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/departments');
  }
});

// Create department — form. Must sit before GET /admin/departments/:id:
// 'new' would otherwise match :id.
app.get('/admin/departments/new', requireAdmin, (req, res) => {
  res.render('admin/departments/form', {
    title: 'Tambah Departemen',
    department: null,
    formAction: '/admin/departments/new'
  });
});

// Create department — save. An active department with the same normalized
// name is refused, so a duplicate the merge UI would flag right away
// cannot be created by accident.
app.post('/admin/departments/new', requireAdmin, async (req, res) => {
  try {
    const name = (req.body.namadepartment || '').trim();
    const deskripsi = (req.body.deskripsi || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Nama departemen wajib diisi');
      return res.redirect('/admin/departments/new');
    }
    const departments = await db.getAllDepartments({});
    if (departments.some(d => merge.normalizeName(d.namadepartment) === merge.normalizeName(name))) {
      setFlash(req, 'error', `Departemen "${name}" sudah ada`);
      return res.redirect('/admin/departments/new');
    }
    const id = await db.createDepartment({ namadepartment: name, deskripsi: deskripsi || null, status: 'A' });
    setFlash(req, 'success', `Departemen "${name}" dibuat (id ${id})`);
    res.redirect('/admin/departments');
  } catch (err) {
    console.error('Create department error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/departments/new');
  }
});

// Edit department — form (rename + description).
app.get('/admin/departments/:id/edit', requireAdmin, async (req, res) => {
  try {
    const department = await db.getDepartmentById(req.params.id);
    if (!department || department.status === 'D') {
      setFlash(req, 'error', 'Departemen tidak ditemukan');
      return res.redirect('/admin/departments');
    }
    res.render('admin/departments/form', {
      title: 'Edit Departemen',
      department,
      formAction: '/admin/departments/' + department.id + '/edit'
    });
  } catch (err) {
    console.error('Edit department page error:', err);
    res.status(500).send('Server error');
  }
});

// Update department. A rename rewrites every name-form reference
// (users.dept, trevents.department) to the new name in the same
// transaction, so members and bookings follow the rename instead of
// being orphaned under the old name.
app.post('/admin/departments/:id/edit', requireAdmin, async (req, res) => {
  try {
    const department = await db.getDepartmentById(req.params.id);
    if (!department || department.status === 'D') {
      setFlash(req, 'error', 'Departemen tidak ditemukan');
      return res.redirect('/admin/departments');
    }
    const name = (req.body.namadepartment || '').trim();
    const deskripsi = (req.body.deskripsi || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Nama departemen wajib diisi');
      return res.redirect('/admin/departments/' + req.params.id + '/edit');
    }
    const departments = await db.getAllDepartments({});
    if (departments.some(d => String(d.id) !== String(department.id) &&
        merge.normalizeName(d.namadepartment) === merge.normalizeName(name))) {
      setFlash(req, 'error', `Departemen "${name}" sudah ada`);
      return res.redirect('/admin/departments/' + req.params.id + '/edit');
    }
    let renamed = { usersRenamed: 0, bookingsRenamed: 0 };
    if (merge.normalizeName(name) !== merge.normalizeName(department.namadepartment)) {
      renamed = await db.withTransaction(q =>
        merge.renameDepartment(q, department.id, department.namadepartment, name));
    } else if (name !== department.namadepartment) {
      // Only casing/spacing changed: the row still gets the exact new text.
      await db.updateDepartment(department.id, { namadepartment: name });
    }
    if (deskripsi !== (department.deskripsi || '')) {
      await db.updateDepartment(department.id, { deskripsi: deskripsi || null });
    }
    setFlash(req, 'success', `Departemen "${name}" berhasil diupdate` +
      ((renamed.usersRenamed || renamed.bookingsRenamed)
        ? ` (${renamed.usersRenamed} pengguna dan ${renamed.bookingsRenamed} booking mengikuti nama baru)`
        : ''));
    res.redirect('/admin/departments');
  } catch (err) {
    console.error('Update department error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/departments/' + req.params.id + '/edit');
  }
});

// Department detail: members (dept = id OR name) + booking count.
app.get('/admin/departments/:id', requireAdmin, async (req, res) => {
  try {
    const department = await db.getDepartmentById(req.params.id);
    if (!department) {
      setFlash(req, 'error', 'Departemen tidak ditemukan');
      return res.redirect('/admin/departments');
    }
    const allUsers = await db.getAllUsers({});
    const members = allUsers.filter(u =>
      String(u.dept) === String(department.id) ||
      merge.normalizeName(u.dept) === merge.normalizeName(department.namadepartment)
    );
    const bookings = await db.getAllBookings({ limit: 10000, offset: 0 });
    // trevents.department holds a department ID on most rows and a plain
    // name on 221 rows, so match BOTH forms. (Before this fix only the
    // name form was compared, so departments whose bookings carry the id
    // — e.g. KTM id 43, 5 bookings — wrongly showed 0.)
    const bookingCount = bookings.filter(b =>
      String(b.department) === String(department.id) ||
      merge.normalizeName(b.department) === merge.normalizeName(department.namadepartment)
    ).length;
    res.render('admin/departments/show', {
      title: department.namadepartment,
      department,
      members,
      bookingCount
    });
  } catch (err) {
    console.error('Admin department detail error:', err);
    res.status(500).send('Server error');
  }
});

// Admin equipment
app.get('/admin/equipment', requireAdmin, async (req, res) => {
  try {
    const equipment = await db.getAllKelengkapan({});
    const rooms = await db.getAllRooms({ status: 'A' });
    // Duplicate groups (same normalized name within the same room) with a
    // preview: keeper = lowest id, losers, and how many bookings reference
    // each row. Same names in different rooms are NOT duplicates.
    const duplicateGroups = merge.groupEquipmentDuplicates(equipment);
    const refCounts = merge.countEquipmentReferences(await db.getBookingEquipmentRefs());
    res.render('admin/equipment/index', {
      title: 'Kelola Kelengkapan',
      equipment,
      rooms,
      duplicateGroups,
      refCounts
    });
  } catch (err) {
    console.error('Admin equipment error:', err);
    res.status(500).send('Server error');
  }
});

// Merge one equipment duplicate group. The group is re-computed from the
// live data — the posted ids are verified against it, never trusted blindly.
app.post('/admin/equipment/merge', requireAdmin, async (req, res) => {
  try {
    const keeperId = parseInt(req.body.keeperId, 10);
    const loserIds = [...new Set(
      (Array.isArray(req.body.loserIds) ? req.body.loserIds : [req.body.loserIds])
        .map(v => parseInt(v, 10)).filter(n => !Number.isNaN(n))
    )];
    const equipment = await db.getAllKelengkapan({});
    const group = merge.groupEquipmentDuplicates(equipment)
      .find(g => g.keeper.id === keeperId);
    const posted = [...loserIds].sort((a, b) => a - b);
    const actual = group ? group.losers.map(l => l.id).sort((a, b) => a - b) : [];
    if (!group || posted.length === 0 || JSON.stringify(posted) !== JSON.stringify(actual)) {
      setFlash(req, 'error', 'Grup duplikat tidak ditemukan atau sudah berubah — muat ulang halaman dan coba lagi');
      return res.redirect('/admin/equipment');
    }
    const stats = await db.withTransaction(q => merge.mergeEquipmentGroup(q, keeperId, loserIds));
    setFlash(req, 'success',
      `Digabung: "${group.keeper.NamaKelengkapan}" (id ${keeperId}) dipertahankan, ${stats.losersDeleted} duplikat dihapus. ` +
      `${stats.rewrittenRefs} referensi booking dari ${stats.rewrittenBookings} booking dialihkan ke id ${keeperId}.`);
    res.redirect('/admin/equipment');
  } catch (err) {
    console.error('Merge equipment error:', err);
    setFlash(req, 'error', 'Gagal menggabung: ' + err.message);
    res.redirect('/admin/equipment');
  }
});

// Add equipment from /admin/equipment: room selector + name. An empty
// room means unassigned ("Tanpa Ruangan"); it can be attached to a room
// later from the Edit Ruangan page.
app.post('/admin/equipment', requireAdmin, async (req, res) => {
  try {
    const name = (req.body.NamaKelengkapan || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Nama kelengkapan wajib diisi');
      return res.redirect('/admin/equipment');
    }
    let roomId = null;
    if (req.body.idruangan) {
      roomId = parseInt(req.body.idruangan, 10);
      if (Number.isNaN(roomId) || !(await db.getRoomById(roomId))) {
        setFlash(req, 'error', 'Ruangan tidak ditemukan');
        return res.redirect('/admin/equipment');
      }
    }
    const id = await db.createKelengkapan({ idruangan: roomId, NamaKelengkapan: name, status: 'A' });
    setFlash(req, 'success', `Kelengkapan "${name}" ditambahkan (id ${id})`);
    res.redirect('/admin/equipment');
  } catch (err) {
    console.error('Add equipment error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/equipment');
  }
});

// Edit equipment page — rename + change status (A = Tersedia, N = Tidak
// Tersedia). Room is not changed here; attaching to a room happens from
// the Edit Ruangan page.
app.get('/admin/equipment/:id/edit', requireAdmin, async (req, res) => {
  try {
    const item = await db.getKelengkapanById(req.params.id);
    if (!item || item.status === 'D') {
      setFlash(req, 'error', 'Kelengkapan tidak ditemukan');
      return res.redirect('/admin/equipment');
    }
    const rooms = await db.getAllRooms({ status: 'A' });
    res.render('admin/equipment/edit', {
      title: 'Edit Kelengkapan',
      item,
      rooms
    });
  } catch (err) {
    console.error('Edit equipment page error:', err);
    res.status(500).send('Server error');
  }
});

// Update equipment — rename / status.
app.post('/admin/equipment/:id/edit', requireAdmin, async (req, res) => {
  try {
    const item = await db.getKelengkapanById(req.params.id);
    if (!item || item.status === 'D') {
      setFlash(req, 'error', 'Kelengkapan tidak ditemukan');
      return res.redirect('/admin/equipment');
    }
    const name = (req.body.NamaKelengkapan || '').trim();
    const status = req.body.status;
    if (!name) {
      setFlash(req, 'error', 'Nama kelengkapan wajib diisi');
      return res.redirect('/admin/equipment/' + req.params.id + '/edit');
    }
    if (!['A', 'N'].includes(status)) {
      setFlash(req, 'error', 'Status tidak valid');
      return res.redirect('/admin/equipment/' + req.params.id + '/edit');
    }
    await db.updateKelengkapan(req.params.id, { NamaKelengkapan: name, status });
    setFlash(req, 'success', `Kelengkapan "${name}" berhasil diupdate`);
    res.redirect('/admin/equipment');
  } catch (err) {
    console.error('Update equipment error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/equipment/' + req.params.id + '/edit');
  }
});

// Delete equipment (soft-delete, status='D'). Booking references that name
// the id are left untouched — same behaviour as the room-edit remove.
app.post('/admin/equipment/:id/delete', requireAdmin, async (req, res) => {
  try {
    const item = await db.getKelengkapanById(req.params.id);
    if (!item || item.status === 'D') {
      setFlash(req, 'error', 'Kelengkapan tidak ditemukan');
      return res.redirect('/admin/equipment');
    }
    await db.deleteKelengkapan(req.params.id);
    setFlash(req, 'success', `Kelengkapan "${item.NamaKelengkapan}" dihapus. Referensi booking dibiarkan apa adanya.`);
    res.redirect('/admin/equipment');
  } catch (err) {
    console.error('Delete equipment error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/equipment');
  }
});

// Admin users
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const search = req.query.search || '';
    const dept = req.query.dept || '';
    const departments = await db.getAllDepartments({ status: 'A' });

    const filters = {
      search,
      limit: perPage,
      offset: (page - 1) * perPage
    };
    // Department filter: match users.dept = department id OR department
    // name (users.dept is varchar: usually an id, sometimes a plain name).
    if (dept) {
      const deptRow = departments.find(d => String(d.id) === String(dept));
      if (deptRow) {
        filters.dept = deptRow.id;
        filters.deptName = deptRow.namadepartment;
      } else {
        filters.dept = dept;
      }
    }

    const [users, total] = await Promise.all([
      db.getAllUsers(filters),
      db.countUsers(filters)
    ]);

    // Bookings per booker (userid -> count), for the delete confirm dialog.
    const bookingCounts = await db.countBookingsByUser();

    const totalPages = Math.ceil(total / perPage);

    res.render('admin/users/index', {
      title: 'Kelola Pengguna',
      users,
      page,
      totalPages,
      total,
      search,
      dept,
      departments,
      bookingCounts
    });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).send('Server error');
  }
});

// Edit user page — Super Admin only.
app.get('/admin/users/:id/edit', requireAdmin, async (req, res) => {
  try {
    const user = await db.findUserByIdAny(req.params.id);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan');
      return res.redirect('/admin/users');
    }
    const departments = await db.getAllDepartments({ status: 'A' });
    // Label for the user's current dept in the dropdown: the active
    // department name when it matches, otherwise the raw stored value
    // (an id of a deleted department, or a plain name).
    const currentDept = String(user.dept || '');
    const activeMatch = departments.find(d => String(d.id) === currentDept);
    const currentDeptLabel = activeMatch
      ? activeMatch.namadepartment
      : (currentDept ? (/^[0-9]+$/.test(currentDept) ? `Departemen #${currentDept} (tidak aktif)` : currentDept) : '-');
    res.render('admin/users/edit', {
      title: 'Edit Pengguna',
      editUser: user,
      departments,
      currentDeptLabel,
      isSuperAdmin: !!res.locals.currentUser.isSuperAdmin
    });
  } catch (err) {
    console.error('Edit user page error:', err);
    res.status(500).send('Server error');
  }
});

// Update user — Manager and Super Admin. Empty password field keeps the
// current password; a filled one is bcrypt-hashed before saving.
// Managers may edit profile fields and reset passwords, but they cannot
// change roles or status (that would let them promote someone to Super
// Admin or deactivate users, which is the same as deleting them) —
// those two fields are forced to the target user's current values and
// are not rendered as inputs for non-SU editors. Delete stays SU-only.
app.post('/admin/users/:id/edit', requireAdmin, async (req, res) => {
  try {
    const user = await db.findUserByIdAny(req.params.id);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan');
      return res.redirect('/admin/users');
    }
    const isSU = !!res.locals.currentUser.isSuperAdmin;
    const { namalengkap, email, notelp, gender, dept, password } = req.body;
    // Roles/status come from the form only for Super Admins; managers
    // keep the target user's current values no matter what is posted.
    const roles = isSU ? req.body.roles : user.roles;
    const userstatus = isSU ? req.body.userstatus : user.userstatus;
    if (!namalengkap || !email) {
      setFlash(req, 'error', 'Nama lengkap dan email wajib diisi');
      return res.redirect('/admin/users/' + req.params.id + '/edit');
    }
    if (!['U', 'M', 'SU'].includes(roles)) {
      setFlash(req, 'error', 'Peran tidak valid');
      return res.redirect('/admin/users/' + req.params.id + '/edit');
    }
    if (!['A', 'N'].includes(userstatus)) {
      setFlash(req, 'error', 'Status tidak valid');
      return res.redirect('/admin/users/' + req.params.id + '/edit');
    }
    // A super admin cannot demote or deactivate their own account.
    // (Managers cannot change roles/status at all, so nothing to guard.)
    if (isSU && String(user.id) === String(res.locals.currentUser.id) && (roles !== 'SU' || userstatus !== 'A')) {
      setFlash(req, 'error', 'Tidak dapat mengubah peran atau status akun sendiri');
      return res.redirect('/admin/users/' + req.params.id + '/edit');
    }
    // Email must stay unique.
    if (email !== user.email) {
      const existing = await db.findUserByEmail(email);
      if (existing && String(existing.id) !== String(user.id)) {
        setFlash(req, 'error', 'Email sudah dipakai pengguna lain');
        return res.redirect('/admin/users/' + req.params.id + '/edit');
      }
    }
    const data = { namalengkap, email, notelp: notelp || '', gender: gender || 'L', dept: dept || '', roles, userstatus };
    if (password) {
      if (password.length < 6) {
        setFlash(req, 'error', 'Password baru minimal 6 karakter');
        return res.redirect('/admin/users/' + req.params.id + '/edit');
      }
      data.password = await bcrypt.hash(password, 10);
    }
    await db.updateUser(req.params.id, data);
    setFlash(req, 'success', `Pengguna "${namalengkap}" berhasil diupdate` + (password ? ' (password direset)' : ''));
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Update user error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/users/' + req.params.id + '/edit');
  }
});

// Delete user — Super Admin only. Soft-delete: userstatus='N', the app's
// existing non-active value (there is no 'D' for users anywhere in the
// code; the edit form only offers A/N, and findUserById/findUserByEmail
// require 'A', so an 'N' user cannot log in but still shows in the list
// as Nonaktif and can be reactivated from the edit page). The user's
// bookings are NOT deleted — they still resolve by userid.
app.post('/admin/users/:id/delete', requireSuperAdmin, async (req, res) => {
  try {
    const user = await db.findUserByIdAny(req.params.id);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan');
      return res.redirect('/admin/users');
    }
    if (String(user.id) === String(res.locals.currentUser.id)) {
      setFlash(req, 'error', 'Tidak dapat menghapus akun sendiri');
      return res.redirect('/admin/users');
    }
    if (user.userstatus !== 'A') {
      setFlash(req, 'error', 'Pengguna sudah nonaktif');
      return res.redirect('/admin/users');
    }
    await db.updateUser(req.params.id, { userstatus: 'N' });
    setFlash(req, 'success', `Pengguna "${user.namalengkap}" dihapus (nonaktif). Booking miliknya tidak dihapus.`);
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Delete user error:', err);
    setFlash(req, 'error', 'Terjadi kesalahan sistem');
    res.redirect('/admin/users');
  }
});

// User detail — profile + booking history. Names in the admin users list
// and on department detail pages link here.
app.get('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.findUserByIdAny(req.params.id);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan');
      return res.redirect('/admin/users');
    }
    const departments = await db.getAllDepartments({ status: 'A' });
    const currentDept = String(user.dept || '');
    const activeMatch = departments.find(d => String(d.id) === currentDept);
    const deptLabel = activeMatch
      ? activeMatch.namadepartment
      : (currentDept ? (/^[0-9]+$/.test(currentDept) ? `Departemen #${currentDept} (tidak aktif)` : currentDept) : '-');
    const bookings = await db.getUserBookings(user.id);
    res.render('admin/users/show', {
      title: user.namalengkap,
      showUser: user,
      deptLabel,
      bookings
    });
  } catch (err) {
    console.error('User detail error:', err);
    res.status(500).send('Server error');
  }
});

// Admin settings — the booking window (how many days ahead a regular user
// must book) lives in settings.json on disk, not hardcoded and not in the
// database. Admins only.
app.get('/admin/settings', requireAdmin, (req, res) => {
  const email = settings.getEmailSettings();
  const wa = settings.getWhatsAppSettings();
  res.render('admin/settings', {
    title: 'Pengaturan',
    windowDays: settings.getBookingWindowDays(),
    minDays: settings.MIN_DAYS,
    maxDays: settings.MAX_DAYS,
    emailResetEnabled: email.emailResetEnabled,
    smtpHost: email.smtpHost,
    smtpPort: email.smtpPort,
    smtpUser: email.smtpUser,
    smtpPassSet: email.smtpPassSet,
    waEnabled: wa.waEnabled,
    waBaseUrl: wa.waBaseUrl,
    waSession: wa.waSession,
    waNumber: wa.waNumber,
    waApiKeySet: wa.waApiKeySet
  });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  try {
    const days = settings.saveBookingWindowDays(req.body.bookingWindowDays);
    // The two settings cards are separate forms: the booking-window form
    // posts only bookingWindowDays, while the email form posts the SMTP
    // fields too. Only touch the email settings when the email form was
    // submitted — otherwise a window-only save would fail validation on
    // the missing SMTP port and flash a false error (the window itself
    // was already saved by then).
    let emailNote = '';
    if (req.body.smtpPort !== undefined) {
      // Email reset: the checkbox is only present in the body when ticked.
      // A blank SMTP password keeps the stored one (never rendered to the
      // page, never overwritten by an empty field).
      const email = settings.saveEmailSettings({
        emailResetEnabled: req.body.emailResetEnabled === 'on',
        smtpHost: req.body.smtpHost,
        smtpPort: req.body.smtpPort,
        smtpUser: req.body.smtpUser,
        smtpPass: req.body.smtpPass ? req.body.smtpPass : undefined
      });
      emailNote = ` Reset password lewat email: ${email.emailResetEnabled ? 'aktif' : 'tidak aktif'}.`;
    }
    // Same rule for the WhatsApp card: only touch it when the WhatsApp
    // form was submitted (it always posts waNumber, even blank).
    let waNote = '';
    if (req.body.waNumber !== undefined) {
      const wa = settings.saveWhatsAppSettings({
        waEnabled: req.body.waEnabled === 'on',
        waBaseUrl: req.body.waBaseUrl,
        waApiKey: req.body.waApiKey ? req.body.waApiKey : undefined,
        waSession: req.body.waSession,
        waNumber: req.body.waNumber
      });
      waNote = ` Notifikasi WhatsApp: ${wa.waEnabled ? 'aktif' : 'tidak aktif'}.`;
    }
    setFlash(req, 'success',
      `Pengaturan disimpan. Pengguna biasa sekarang harus booking minimal ${days} hari sebelum acara.` + emailNote + waNote);
  } catch (err) {
    setFlash(req, 'error', err.message);
  }
  res.redirect('/admin/settings');
});

// Test the WhatsApp settings: one short message to the configured number,
// so the gateway URL / key / session can be verified without creating a
// fake booking. The send itself reports ok/error; nothing is saved here.
app.post('/admin/settings/whatsapp/test', requireAdmin, async (req, res) => {
  const result = await whatsapp.sendTest();
  if (result.ok) {
    setFlash(req, 'success', 'Pesan test WhatsApp terkirim — cek nomor tujuan.');
  } else {
    setFlash(req, 'error', 'Pesan test gagal: ' + (result.error || 'gateway tidak menjawab'));
  }
  res.redirect('/admin/settings');
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

// API: Booked times for a room on a date (to grey out taken slots)
app.get('/api/booked-times', async (req, res) => {
  try {
    const { room, date, exclude } = req.query;
    if (!room || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ success: false, error: 'Room and date required' });
    }
    const booked = await db.getBookedRanges(room, date, exclude || null);
    res.json({ success: true, booked });
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
