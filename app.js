// app.js (module)

// --- CONFIG -------------------------------------------------------
const WIFI_SSID = 'Romeoville_Public';
const WIFI_PASS = 'Publ!c00';     // per your update
const REFRESH_MS = 60_000;        // update clock + fall-off once/min
const HIDE_PAST = true;           // hide events that have ended

// --- HELPERS ------------------------------------------------------
const fmtTime = (min) => {
  let h = Math.floor(min / 60);
  const m = min % 60, ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
};
const nowMinutesLocal = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const groups = {
  south: ['1A','1B','2A','2B'],
  field: ['3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B'],
  north: ['9A','9B','10A','10B']
};

// --- DATA ---------------------------------------------------------
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data ? { rooms: Object.keys(data.rooms||{}).length, slots: (data.slots||[]).length } : 'no data');
  return data;
}

// --- HEADER -------------------------------------------------------
function renderHeader() {
  const dEl = document.getElementById('headerDate');
  const cEl = document.getElementById('headerClock');
  const now = new Date();
  dEl.textContent = now.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric', year:'numeric' });
  cEl.textContent = now.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });

  const ssidEl = document.getElementById('wifiSsid');
  const passEl = document.getElementById('wifiPass');
  if (ssidEl) ssidEl.textContent = WIFI_SSID;
  if (passEl) passEl.textContent = WIFI_PASS;
}

// --- GRID ---------------------------------------------------------
function ensureGridCells() {
  const build = (containerId, roomIds) => {
    const mount = document.getElementById(containerId);
    if (!mount || mount.dataset.ready) return;
    mount.innerHTML = '';
    roomIds.forEach(r => {
      const cell = document.createElement('div');
      cell.className = 'roomcell'; cell.id = `cell-${r}`;

      const h = document.createElement('div');
      h.className = 'roomcell-h'; h.textContent = r;

      const b = document.createElement('div');
      b.className = 'roomcell-b'; // event rows go here

      cell.appendChild(h); cell.appendChild(b);
      mount.appendChild(cell);
    });
    mount.dataset.ready = '1';
  };
  build('southGrid', groups.south);
  build('fieldGrid', groups.field);
  build('northGrid', groups.north);
}

function visibleSlots(data) {
  const all = Array.isArray(data.slots) ? data.slots : [];
  if (!HIDE_PAST) return all;

  const start = data.dayStartMin ?? 360;
  const end   = data.dayEndMin   ?? 1380;
  const now   = nowMinutesLocal();

  if (now < start) return all;           // before opening, show full day
  if (now > end)   return [];            // after closing, show nothing

  const filtered = all.filter(s => s.endMin > now);
  console.log(`Slots filtered by time: ${all.length} -> ${filtered.length} (now=${now})`);
  return filtered;
}

function renderGrid(data) {
  ensureGridCells();

  const allRoomIds = [...groups.south, ...groups.field, ...groups.north];
  allRoomIds.forEach(id => {
    const body = document.querySelector(`#cell-${id} .roomcell-b`);
    if (body) body.innerHTML = '';
  });

  const vis = visibleSlots(data);

  // group by room
  const byRoom = {};
  vis.forEach(s => {
    if (!byRoom[s.roomId]) byRoom[s.roomId] = [];
    byRoom[s.roomId].push(s);
  });

  Object.entries(byRoom).forEach(([roomId, list]) => {
    const body = document.querySelector(`#cell-${roomId} .roomcell-b`);
    if (!body) return;

    list.sort((a,b) => a.startMin - b.startMin);
    list.forEach(ev => {
      const row = document.createElement('div'); row.className = 'evt';
      const l1  = document.createElement('div'); l1.className = 'evt-line1';
      const l2  = document.createElement('div'); l2.className = 'evt-line2';

      l1.textContent = ev.title || '';
      const times = `${fmtTime(ev.startMin)}–${fmtTime(ev.endMin)}`;
      l2.textContent = ev.subtitle ? `${ev.subtitle} • ${times}` : times;

      row.appendChild(l1); row.appendChild(l2);
      body.appendChild(row);
    });
  });
}

// --- INIT ---------------------------------------------------------
let CACHE = null;

async function init() {
  try {
    CACHE = await loadData();
    renderHeader();
    renderGrid(CACHE);
    setInterval(() => { renderHeader(); renderGrid(CACHE); }, REFRESH_MS);
  } catch (err) {
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
