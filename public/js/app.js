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
    
    const roomId = roomSelect?.value;
    const date = dateInput?.value;
    const timestart = timestartSelect?.value;
    const timeend = timeendSelect?.value;
    const bookingId = document.getElementById('booking_id')?.value;
    
    if (!roomId || !date || !timestart || !timeend) {
      conflictWarning.style.display = 'none';
      return;
    }
    
    try {
      const response = await fetch('/api/check-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId, date, timestart, timeend, booking_id: bookingId })
      });
      
      const data = await response.json();
      
      if (data.success && data.hasConflict) {
        conflictWarning.style.display = 'block';
        conflictWarning.innerHTML = `
          <strong>⚠️ Perhatian:</strong> Ruangan sudah dibooking pada waktu ini.
          ${data.conflicts.map(c => `<br>• ${c.eventname} (${c.timestart} - ${c.timeend})`).join('')}
        `;
      } else {
        conflictWarning.style.display = 'none';
      }
    } catch (err) {
      console.error('Error checking conflict:', err);
    }
  }
  
  if (roomSelect) roomSelect.addEventListener('change', checkConflict);
  if (dateInput) dateInput.addEventListener('change', checkConflict);
  if (timestartSelect) timestartSelect.addEventListener('change', checkConflict);
  if (timeendSelect) timeendSelect.addEventListener('change', checkConflict);
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

// Auto-hide flash messages
setTimeout(() => {
  const alerts = document.querySelectorAll('.alert');
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
