// app.js (module)

// --- CONFIG -------------------------------------------------------
const WIFI_SSID = 'Romeoville_Public';
const WIFI_PASS = 'Publ!c00'; // you said you updated this
const REFRESH_MS = 60_000;    // refresh clock + hide-past every minute

// If true: past events are hidden, but if it's before opening (now < dayStartMin),
// we show all events so the board isn't blank in the morning.
const HIDE_PAST = true;

// --- UTILS --------------------------------------------------------
const fmtTime = (min) => {
  // min since 00:00 -> "h:mm AM/PM"
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
};

const nowMinutesLocal = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const groupMap = {
  south: ['1A','1B','2A','2B'],
  field: ['3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B'],
  north: ['9A','9B','10A','10B']
};

// --- DATA ---------------------------------------------------------
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();

  const roomsCount = data?.rooms ? Object.keys(data.rooms).length : 0;
  const slotsCount = Array.isArray(data?.slots) ? data.slots.length : 0;
  console.log('Loaded events.json', { roomsCount, slotsCount });

  return data;
}

// --- HEADER / WIFI / CLOCK ---------------------------------------
function renderHeaderBits() {
  // Date centered, live clock
  const dateEl  = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const now = new Date();

  // Example: Wednesday, Oct 15, 2025
  dateEl.textContent = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
  });

  clockEl.textContent = now.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit'
  });

  // WiFi badge
  const ssidEl = document.getElementById('wifiSsid');
  const passEl = document.getElementById('wifiPass');
  if (ssidEl) ssidEl.textContent = WIFI_SSID;
  if (passEl) passEl.textContent = WIFI_PASS;
}

// --- GRID LAYOUT --------------------------------------------------
// Expects containers with these IDs to exist in index.html:
// #southGrid, #fieldGrid, #northGrid — each is a grid of boxes
function ensureRoomBoxes(data) {
  const make = (id, list) => {
    const wrap = document.getElementById(id);
    if (!wrap) return;

    // Build cells if missing (id="cell-<ROOM>")
    if (!wrap.dataset.filled) {
      wrap.innerHTML = '';
      list.forEach(roomId => {
        const cell = document.createElement('div');
        cell.className = 'roomcell';
        cell.id = `cell-${roomId}`;

        const header = document.createElement('div');
        header.className = 'roomcell-h';
        header.textContent = roomId;

        const body = document.createElement('div');
        body.className = 'roomcell-b'; // events go here

        cell.appendChild(header);
        cell.appendChild(body);
        wrap.appendChild(cell);
      });
      wrap.dataset.filled = '1';
    }
  };

  make('southGrid', groupMap.south);
  make('fieldGrid', groupMap.field);
  make('northGrid', groupMap.north);
}

function visibleSlotsForToday(data) {
  const slots = Array.isArray(data.slots) ? data.slots : [];
  if (!HIDE_PAST) return slots;

  const now = nowMinutesLocal();
  const start = data.dayStartMin ?? 360;  // default 6:00
  const end   = data.dayEndMin   ?? 1380; // default 23:00

  // If it's before opening, show everything (board shouldn't be blank at 7am)
  if (now < start) {
    console.log('Before opening — showing all slots');
    return slots;
  }
  // During the day: only show events that haven't ended yet
  if (now <= end) {
    const filtered = slots.filter(s => s.endMin > now);
    console.log(`Filtered slots (now=${now}):`, { before: slots.length, after: filtered.length });
    return filtered;
  }
  // After closing
  console.log('After closing — no slots visible');
  return [];
}

function renderGrid(data) {
  ensureRoomBoxes(data);

  // clear all bodies
  const clearRoom = (roomId) => {
    const body = document.querySelector(`#cell-${roomId} .roomcell-b`);
    if (body) body.innerHTML = '';
  };
  [...groupMap.south, ...groupMap.field, ...groupMap.north].forEach(clearRoom);

  // pick visible
  const vis = visibleSlotsForToday(data);

  // bucket by room
  const byRoom = {};
  vis.forEach(s => {
    if (!byRoom[s.roomId]) byRoom[s.roomId] = [];
    byRoom[s.roomId].push(s);
  });

  // For each room, render stacked event rows (title • time)
  Object.entries(byRoom).forEach(([roomId, items]) => {
    const body = document.querySelector(`#cell-${roomId} .roomcell-b`);
    if (!body) return;

    // sort by start
    items.sort((a,b) => a.startMin - b.startMin);

    items.forEach(ev => {
      const row = document.createElement('div');
      row.className = 'evt';

      const line1 = document.createElement('div');
      line1.className = 'evt-line1';
      line1.textContent = ev.title || '';

      const line2 = document.createElement('div');
      line2.className = 'evt-line2';
      const timeStr = `${fmtTime(ev.startMin)}–${fmtTime(ev.endMin)}`;
      line2.textContent = ev.subtitle ? `${ev.subtitle} • ${timeStr}` : timeStr;

      row.appendChild(line1);
      row.appendChild(line2);
      body.appendChild(row);
    });
  });
}

// --- INIT / TICK --------------------------------------------------
let _data = null;

async function init() {
  try {
    _data = await loadData();
    renderHeaderBits();
    renderGrid(_data);

    // tick once per minute for clock + hide-past
    setInterval(() => {
      renderHeaderBits();
      if (_data) renderGrid(_data);
    }, REFRESH_MS);
  } catch (e) {
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', init);
