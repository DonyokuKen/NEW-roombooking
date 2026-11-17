// RoomBooking Client-Side JavaScript

// Booking form functionality
if (document.getElementById('booking-form')) {
  const form = document.getElementById('booking-form');
  const roomSelect = document.getElementById('room_id');
  const dateInput = document.getElementById('date');
  const timestartSelect = document.getElementById('timestart');
  const timeendSelect = document.getElementById('timeend');
  const kelengkapanContainer = document.getElementById('kelengkapan-container');
  const conflictWarning = document.getElementById('conflict-warning');
  const submitBtn = form.querySelector('button[type="submit"]');
  // Last known conflict state, and a sequence number so a slow reply to an
  // old check can never overwrite the result of a newer one.
  let hasConflict = false;
  let checkSeq = 0;
  
  // Load equipment when room changes
  if (roomSelect && kelengkapanContainer) {
    roomSelect.addEventListener('change', async function() {
      const roomId = this.value;
      kelengkapanContainer.innerHTML = '<p class="text-muted">Loading equipment...</p>';
      
      if (!roomId) {
        kelengkapanContainer.innerHTML = '<p class="text-muted">Pilih ruangan terlebih dahulu</p>';
        return;
      }
      
      try {
        const response = await fetch(`/api/kelengkapan?room=${roomId}`);
        const data = await response.json();
        
        if (data.success && data.data.length > 0) {
          let html = '<div class="form-group"><label class="form-label">Kelengkapan yang Dibutuhkan</label>';
          data.data.forEach(item => {
            html += `
              <div class="mb-2">
                <label class="d-flex align-items-center">
                  <input type="checkbox" name="kelengkapan[]" value="${item.id}" class="mr-2">
                  <span>${item.NamaKelengkapan}</span>
                </label>
              </div>
            `;
          });
          html += '</div>';
          kelengkapanContainer.innerHTML = html;
        } else {
          kelengkapanContainer.innerHTML = '<p class="text-muted">Tidak ada kelengkapan tersedia untuk ruangan ini</p>';
        }
      } catch (err) {
        console.error('Error loading equipment:', err);
        kelengkapanContainer.innerHTML = '<p class="text-danger">Error loading equipment</p>';
      }
    });
    
    // Trigger on page load if room is pre-selected
    if (roomSelect.value) {
      roomSelect.dispatchEvent(new Event('change'));
    }
  }
  
  // Check for conflicts when room, date, or time changes
  async function checkConflict() {
    if (!conflictWarning) return;
    const seq = ++checkSeq;

    const roomId = roomSelect?.value;
    const date = dateInput?.value;
    const timestart = timestartSelect?.value;
    const timeend = timeendSelect?.value;
    const bookingId = document.getElementById('booking_id')?.value;

    if (!roomId || !date || !timestart || !timeend) {
      hasConflict = false;
      conflictWarning.style.display = 'none';
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    try {
      const response = await fetch('/api/check-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId, date, timestart, timeend, booking_id: bookingId })
      });

      const data = await response.json();
      // A newer check has already started: this reply is stale, ignore it.
      if (seq !== checkSeq) return;

      if (data.success && data.hasConflict) {
        hasConflict = true;
        conflictWarning.style.display = 'block';
        conflictWarning.innerHTML = `
          <strong>⚠️ Perhatian:</strong> Ruangan sudah dibooking pada waktu ini.
          ${data.conflicts.map(c => `<br>• ${c.eventname} (${c.timestart} - ${c.timeend})`).join('')}
          <br>Ubah waktu mulai/selesai dulu sebelum menyimpan.
        `;
        if (submitBtn) submitBtn.disabled = true;
      } else {
        hasConflict = false;
        conflictWarning.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      console.error('Error checking conflict:', err);
      // Check failed (offline?): leave the button alone — the server still
      // rejects a conflicting booking, so nothing bad gets through.
    }
  }

  if (roomSelect) roomSelect.addEventListener('change', checkConflict);
  if (dateInput) dateInput.addEventListener('change', checkConflict);
  if (timestartSelect) timestartSelect.addEventListener('change', checkConflict);
  if (timeendSelect) timeendSelect.addEventListener('change', checkConflict);

  // The calendar prefills room/date/time, so check right away: a prefilled
  // range that already overlaps must warn before the user touches anything.
  checkConflict();

  // Final guard: never submit while a conflict is known, even if the button
  // was somehow left enabled.
  form.addEventListener('submit', function (e) {
    if (hasConflict) {
      e.preventDefault();
      conflictWarning.style.display = 'block';
      conflictWarning.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

// Confirmation dialogs
function confirmAction(message) {
  return confirm(message);
}

const deleteButtons = document.querySelectorAll('[data-confirm]');
deleteButtons.forEach(button => {
  button.addEventListener('click', function(e) {
    if (!confirmAction(this.dataset.confirm)) {
      e.preventDefault();
    }
  });
});

// Auto-hide flash messages (server-rendered notices only — never the
// conflict warning, which the booking form manages itself and must stay
// until the user picks a free time).
setTimeout(() => {
  const alerts = document.querySelectorAll('.alert:not(#conflict-warning)');
  alerts.forEach(alert => {
    alert.style.transition = 'opacity 0.5s';
    alert.style.opacity = '0';
    setTimeout(() => alert.remove(), 500);
  });
}, 5000);

// Mobile menu toggle
const menuToggle = document.getElementById('menu-toggle');
const navbarMenu = document.getElementById('navbar-menu');

if (menuToggle && navbarMenu) {
  menuToggle.addEventListener('click', () => {
    navbarMenu.classList.toggle('show');
  });
}

// Date input: set min date to today
const dateInputs = document.querySelectorAll('input[type="date"]');
dateInputs.forEach(input => {
  if (!input.hasAttribute('data-no-min')) {
    const today = new Date().toISOString().split('T')[0];
    input.setAttribute('min', today);
  }
});

// Form validation
const forms = document.querySelectorAll('.needs-validation');
forms.forEach(form => {
  form.addEventListener('submit', function(e) {
    if (!form.checkValidity()) {
      e.preventDefault();
      e.stopPropagation();
    }
    form.classList.add('was-validated');
  }, false);
});

// Search form: prevent empty submissions
const searchForms = document.querySelectorAll('.search-form');
searchForms.forEach(form => {
  form.addEventListener('submit', function(e) {
    const searchInput = form.querySelector('input[name="search"]');
    if (searchInput && !searchInput.value.trim()) {
      e.preventDefault();
      searchInput.focus();
    }
  });
});

// Tooltip initialization (if using tooltips)
const tooltips = document.querySelectorAll('[data-tooltip]');
tooltips.forEach(el => {
  el.title = el.dataset.tooltip;
});

// Print functionality
const printButtons = document.querySelectorAll('[data-print]');
printButtons.forEach(button => {
  button.addEventListener('click', () => {
    window.print();
  });
});

// Back button
const backButtons = document.querySelectorAll('[data-back]');
backButtons.forEach(button => {
  button.addEventListener('click', () => {
    window.history.back();
  });
});

console.log('🎨 RoomBooking UI loaded');

// PWA: register the service worker so the app can be installed.
// Kept tiny on purpose — only the static shell is precached, so the
// install finishes in seconds instead of hanging.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// Browser notifications: the old Laravel loop, restored. While logged
// in, poll for pending reminders every 60s and show each one as a
// browser notification, then mark it delivered. No push token or
// server is involved — the app itself fetches and shows them.
// Polling only runs when permission is already granted; the button on
// the Notifikasi page asks for it (needs a tap).
const POLLING_INTERVAL_MS = 60000;
let notificationPollingStarted = false;

async function showBrowserNotification(notification) {
  const title = notification.title || 'Notifikasi';
  const options = {
    body: notification.body || '',
    icon: '/icons/icon-192.png',
    tag: `push-notification-${notification.id}`,
    renotify: true,
    data: { id: notification.id }
  };

  let shown = false;
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration && registration.showNotification) {
        await registration.showNotification(title, options);
        shown = true;
      }
    }
    if (!shown && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(title, options);
      shown = true;
    }
  } catch (err) {
    console.error('Notification display failed:', err);
  }

  if (shown) {
    try {
      await fetch(`/api/notifications/${notification.id}/deliver`, { method: 'PUT' });
    } catch (err) {
      console.error('Failed to mark notification delivered:', err);
    }
  }
}

async function fetchPendingNotifications() {
  try {
    const response = await fetch('/api/notifications/pending');
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.notifications) && payload.notifications.length > 0) {
      for (const n of payload.notifications) {
        await showBrowserNotification(n);
      }
    }
  } catch (err) {
    console.error('Failed to fetch pending notifications:', err);
  }
}

function startNotificationPolling() {
  if (notificationPollingStarted) return;
  // Only for logged-in users — the bell button exists only then.
  if (!document.querySelector('#notif-bell')) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  notificationPollingStarted = true;
  fetchPendingNotifications();
  setInterval(fetchPendingNotifications, POLLING_INTERVAL_MS);
}

// Called by the "Aktifkan notifikasi browser" button on /notifications.
window.enableBrowserNotifications = async function () {
  if (!('Notification' in window)) {
    alert('Browser ini tidak mendukung notifikasi.');
    return;
  }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    startNotificationPolling();
    const btn = document.getElementById('enable-notifications-btn');
    if (btn) btn.style.display = 'none';
    const hint = document.getElementById('enable-notifications-hint');
    if (hint) hint.textContent = 'Notifikasi browser aktif. Pengingat akan muncul di HP kamu.';
  } else {
    alert('Izin notifikasi belum diberikan. Aktifkan lewat pengaturan browser kalau mau pengingat muncul.');
  }
};

window.addEventListener('load', () => {
  startNotificationPolling();
  // Hide the enable button when it is not needed.
  const btn = document.getElementById('enable-notifications-btn');
  if (btn && (!('Notification' in window) || Notification.permission === 'granted')) {
    btn.style.display = 'none';
  }
  // Bell popup: ask to allow notifications without leaving the page.
  const bell = document.getElementById('notif-bell');
  if (bell) bell.addEventListener('click', openNotifPopup);
  const closeBtn = document.getElementById('notif-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeNotifPopup);
  const laterBtn = document.getElementById('notif-modal-later');
  if (laterBtn) laterBtn.addEventListener('click', closeNotifPopup);
  const modal = document.getElementById('notif-modal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeNotifPopup(); });
  const allowBtn = document.getElementById('notif-modal-allow');
  if (allowBtn) allowBtn.addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const result = await Notification.requestPermission();
    if (result === 'granted') startNotificationPolling();
    openNotifPopup(); // refresh the popup to the new state
  });
});

// Bell popup content depends on the current permission state.
function openNotifPopup() {
  const modal = document.getElementById('notif-modal');
  if (!modal) return;
  const title = document.getElementById('notif-modal-title');
  const text = document.getElementById('notif-modal-text');
  const allowBtn = document.getElementById('notif-modal-allow');
  const laterBtn = document.getElementById('notif-modal-later');
  if (!('Notification' in window)) {
    title.textContent = 'Notifikasi browser';
    text.textContent = 'Browser ini tidak mendukung notifikasi.';
    allowBtn.style.display = 'none';
    laterBtn.textContent = 'Tutup';
  } else if (Notification.permission === 'granted') {
    title.textContent = 'Notifikasi aktif';
    text.textContent = 'Notifikasi browser sudah aktif di perangkat ini. Pengingat booking akan muncul otomatis.';
    allowBtn.style.display = 'none';
    laterBtn.textContent = 'Tutup';
  } else if (Notification.permission === 'denied') {
    title.textContent = 'Notifikasi diblokir';
    text.textContent = 'Notifikasi diblokir di pengaturan browser. Aktifkan lewat pengaturan browser kalau mau pengingat muncul.';
    allowBtn.style.display = 'none';
    laterBtn.textContent = 'Tutup';
  } else {
    title.textContent = 'Izinkan notifikasi?';
    text.textContent = 'Izinkan notifikasi supaya pengingat booking muncul di perangkat ini.';
    allowBtn.style.display = '';
    laterBtn.textContent = 'Nanti saja';
  }
  modal.classList.add('open');
}

function closeNotifPopup() {
  const modal = document.getElementById('notif-modal');
  if (modal) modal.classList.remove('open');
}
