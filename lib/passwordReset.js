'use strict';

// Email password reset: token generation + SMTP delivery (nodemailer).
// The token sent in the link is a random 32-byte hex string; only its
// SHA-256 hash is stored in password_resets, so a database read alone
// cannot mint a reset link. Tokens are valid for 60 minutes from the
// created_at recorded in the table.
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const TOKEN_TTL_MS = 60 * 60 * 1000; // 60 minutes

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isExpired(row) {
  if (!row || !row.created_at) return true;
  return Date.now() - new Date(row.created_at).getTime() > TOKEN_TTL_MS;
}

// Build a transporter from the stored SMTP settings. Throws on bad config
// — callers catch it and show a flash message, never a 500.
function buildTransporter(smtp) {
  if (!smtp.smtpHost) throw new Error('Host SMTP belum diatur');
  return nodemailer.createTransport({
    host: smtp.smtpHost,
    port: smtp.smtpPort,
    // Port 465 = implicit TLS; other ports use STARTTLS when offered.
    secure: smtp.smtpPort === 465,
    auth: smtp.smtpUser ? { user: smtp.smtpUser, pass: smtp.smtpPass } : undefined,
    // Don't hang the request forever on a dead SMTP host.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

async function sendResetEmail(smtp, toEmail, resetLink) {
  const transporter = buildTransporter(smtp);
  await transporter.sendMail({
    from: smtp.smtpUser || 'no-reply@roombooking',
    to: toEmail,
    subject: 'Reset password RoomBooking',
    text:
      'Anda meminta reset password untuk akun RoomBooking Anda.\n\n' +
      'Klik tautan berikut untuk mengatur password baru (berlaku 60 menit):\n' +
      resetLink + '\n\n' +
      'Jika Anda tidak meminta ini, abaikan email ini — password Anda tidak berubah.',
    html:
      '<p>Anda meminta reset password untuk akun RoomBooking Anda.</p>' +
      '<p><a href="' + resetLink + '">Klik di sini untuk mengatur password baru</a> (berlaku 60 menit).</p>' +
      '<p>Jika Anda tidak meminta ini, abaikan email ini &mdash; password Anda tidak berubah.</p>'
  });
}

module.exports = { generateToken, hashToken, isExpired, sendResetEmail, TOKEN_TTL_MS };
