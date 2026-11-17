'use strict';

// Booking notifications over WhatsApp, through Grady's own OpenWA gateway.
//
// This is the old Laravel app's Telegram notifications, ported to WhatsApp:
// the old code fired raw curl GETs at api.telegram.org from the booking
// controllers (new request, admin-created, approved/rejected, deleted) to
// two hardcoded group chats. The new app sends the same events as WhatsApp
// messages to the one target number configured on the admin settings page
// (same shape as the Eden dashboard's WhatsApp card: gateway URL, API key,
// session name, target number — all blank/off until Grady fills them in).
//
// Proven send pattern, taken from the invoice app's OpenWA helper
// (verified live there): the send endpoints only accept a session UUID,
// so the configured session NAME is resolved via GET /api/sessions first;
// the API key goes in the X-API-Key header; the idempotency key goes in
// the Idempotency-Key header (NOT the body — the gateway 400s unknown
// body properties); one retry on HTTP 400 after 10 s (the Baileys
// reconnect window) and one retry on a dropped connection.
//
// A notification must NEVER break or slow down the booking itself: every
// call site fires notifyBookingEvent() without awaiting it, and any
// failure is only logged. When notifications are off or unconfigured the
// call is a silent no-op.
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TITLES = {
  created: 'New Booking Request',
  'created-admin': 'New Booking Created From Admin',
  approved: 'Booking Approved',
  rejected: 'Booking Rejected',
  cancelled: 'Booking Cancelled'
};

// '0812…' -> '62812…'; '62812…' stays; '+62812…' loses the '+'. Anything
// else returns null.
function normalizeNumber(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (/^08\d{8,12}$/.test(digits)) return '62' + digits.slice(1);
  if (/^62\d{8,13}$/.test(digits)) return digits;
  return null;
}

function isConfigured(cfg) {
  return Boolean(cfg && cfg.waEnabled && cfg.waBaseUrl && cfg.waApiKey && cfg.waSession && cfg.waNumber);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options, timeoutMs) {
  const res = await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(timeoutMs) }));
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (err) { body = {}; }
  if (!res.ok) {
    const err = new Error(`Gateway answered HTTP ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  return body;
}

async function fetchSessions(cfg) {
  const data = await fetchJson(cfg.waBaseUrl + '/api/sessions', {
    headers: { 'X-API-Key': cfg.waApiKey, 'User-Agent': BROWSER_UA }
  }, 10000);
  return Array.isArray(data) ? data : [];
}

// Session name -> UUID (the send endpoints only accept the UUID). Falls
// back to the configured value when the lookup fails or it already is one.
async function resolveSessionId(cfg) {
  const sid = cfg.waSession;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return sid;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sessions = await fetchSessions(cfg);
      const match = sessions.find(s => s.name === sid && s.id);
      if (match) return match.id;
    } catch (err) {
      // Fall through to the retry / fallback below.
    }
    if (attempt < 2) await sleep(2000);
  }
  return sid;
}

function idemKey(kind, bookingId) {
  return 'roombooking-' + crypto.createHash('sha1').update(kind + '|' + bookingId).digest('hex').slice(0, 16);
}

// Low-level send. Returns { ok, status, error }. Retries once on HTTP 400
// after 10 s and once on a dropped connection, with the same idempotency
// key, so the gateway will not send it twice.
async function sendText(cfg, toNumber, text, key) {
  const to = normalizeNumber(toNumber);
  if (!to) return { ok: false, status: null, error: 'Nomor WhatsApp tujuan tidak valid' };
  if (!isConfigured(cfg)) return { ok: false, status: null, error: 'Notifikasi WhatsApp belum diatur' };
  const sid = await resolveSessionId(cfg);
  const payload = { chatId: to + '@c.us', text };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = await fetchJson(cfg.waBaseUrl + '/api/sessions/' + sid + '/messages/send-text', {
        method: 'POST',
        headers: {
          'X-API-Key': cfg.waApiKey,
          'User-Agent': BROWSER_UA,
          'Content-Type': 'application/json',
          'Idempotency-Key': key
        },
        body: JSON.stringify(payload)
      }, 15000);
      return { ok: true, status: 200, error: null, body };
    } catch (err) {
      const isHttp = typeof err.status === 'number';
      const retryable = (isHttp && err.status === 400) || !isHttp;
      if (retryable && attempt === 0) {
        await sleep(10000);
        continue;
      }
      return { ok: false, status: err.status || null, error: err.message };
    }
  }
  return { ok: false, status: null, error: 'Send failed' };
}

function formatDate(iso) {
  if (!iso) return '-';
  const parts = String(iso).slice(0, 10).split('-');
  if (parts.length !== 3) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return parseInt(parts[2], 10) + ' ' + (months[parseInt(parts[1], 10) - 1] || parts[1]) + ' ' + parts[0];
}

function formatTime(t) {
  return String(t || '').slice(0, 5) || '-';
}

// Message text for one booking event. Same fields as the old Telegram
// messages (room, event, date, time, people, equipment), plus the booker
// — WhatsApp goes to one person, so knowing who booked matters.
function formatMessage(kind, b) {
  const lines = ['*' + (TITLES[kind] || 'Booking') + '*'];
  lines.push('Ruangan: ' + (b.roomName || '-'));
  lines.push('Acara: ' + (b.eventName || '-'));
  lines.push('Tanggal: ' + formatDate(b.date));
  lines.push('Waktu: ' + formatTime(b.timestart) + '-' + formatTime(b.timeend));
  lines.push('Jumlah Orang: ' + (b.people || '-'));
  if (b.equipmentNames && b.equipmentNames.length > 0) {
    lines.push('Kelengkapan: ' + b.equipmentNames.join(', '));
  }
  if (b.bookerName) lines.push('Pemesan: ' + b.bookerName);
  return lines.join('\n');
}

// Load everything one message needs from a booking row: room name, booker
// name, equipment names resolved from the ';'-separated id list.
async function loadContext(booking) {
  const room = booking.ruanganid ? await db.getRoomById(booking.ruanganid) : null;
  const booker = booking.userid ? await db.findUserByIdAny(booking.userid) : null;
  let equipmentNames = [];
  if (booking.kelengkapanruangan) {
    const ids = String(booking.kelengkapanruangan).split(';').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
    if (ids.length > 0) {
      const all = await db.getAllKelengkapan({});
      const byId = {};
      for (const item of all) byId[item.id] = item.NamaKelengkapan;
      equipmentNames = ids.map(id => byId[id]).filter(Boolean);
    }
  }
  return {
    roomName: room ? room.namaruangan : null,
    eventName: booking.eventname,
    date: booking.date,
    timestart: booking.timestart,
    timeend: booking.timeend,
    people: booking.eventpeoplequantity,
    equipmentNames,
    bookerName: booker ? booker.namalengkap : null
  };
}

// Send one booking event. Reads the settings fresh on every call, so a
// save on the settings page takes effect immediately. Silent no-op when
// notifications are off or unconfigured. Never throws — callers fire it
// without awaiting, and a gateway failure must not break the booking.
async function notifyBookingEvent(kind, bookingId) {
  try {
    const all = settings.getAll();
    const cfg = {
      waEnabled: all.waEnabled,
      waBaseUrl: all.waBaseUrl,
      waApiKey: all.waApiKey,
      waSession: all.waSession,
      waNumber: all.waNumber
    };
    if (!isConfigured(cfg)) return { ok: false, status: null, error: 'not-configured' };
    const booking = await db.getBookingById(bookingId);
    if (!booking) return { ok: false, status: null, error: 'booking-not-found' };
    const context = await loadContext(booking);
    const text = formatMessage(kind, context);
    const result = await sendText(cfg, cfg.waNumber, text, idemKey(kind, bookingId));
    if (!result.ok) console.error('WhatsApp notify failed (' + kind + ' #' + bookingId + '):', result.error);
    return result;
  } catch (err) {
    console.error('WhatsApp notify failed (' + kind + ' #' + bookingId + '):', err.message);
    return { ok: false, status: null, error: err.message };
  }
}

// Test send from the settings page: one short message to the configured
// number, so Grady can verify his gateway URL / key / session without
// creating a fake booking.
async function sendTest() {
  const all = settings.getAll();
  const cfg = {
    waEnabled: all.waEnabled,
    waBaseUrl: all.waBaseUrl,
    waApiKey: all.waApiKey,
    waSession: all.waSession,
    waNumber: all.waNumber
  };
  if (!cfg.waBaseUrl || !cfg.waApiKey || !cfg.waSession || !cfg.waNumber) {
    return { ok: false, status: null, error: 'Lengkapi dulu URL gateway, API key, session, dan nomor tujuan, lalu simpan.' };
  }
  return sendText(cfg, cfg.waNumber, 'Test notifikasi WhatsApp RoomBooking — pengaturan tersimpan dan gateway menjawab.', 'roombooking-test-' + Date.now());
}

module.exports = {
  normalizeNumber,
  isConfigured,
  formatMessage,
  sendText,
  notifyBookingEvent,
  sendTest
};
