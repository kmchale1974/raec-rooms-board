// app.js

// ---------- config ----------
const WIFI_SSID = 'RAEC-Public';
const WIFI_PASS = 'Publ!c00';

// Groups by room id (must match index.html containers)
const GROUPS = {
  south:    ['1', '2'],
  fieldhouse:['3','4','5','6','7','8'],
  north:    ['9', '10'],
};

// ---------- time helpers ----------
function fmt12(min) {
  let h = Math.floor(min/60), m = min%60;
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2,'0')}${ap}`;
}
function fmtRange(startMin, endMin) {
  return `${fmt12(startMin)} - ${fmt12(endMin)}`;
}
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatHeaderDate(d=new Date()) {
  const opts = { weekday:'long', month:'long', day:'numeric' };
  return d.toLocaleDateString(undefined, opts);
}
function formatHeaderClock(d=new Date()) {
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2,'0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${ap}`;
}

// ---------- DOM helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---------- rendering ----------
function renderHeader() {
  const dateEl  = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const ssidEl  = document.getElementById('wifiSsid');
  const passEl  = document.getElementById('wifiPass');
  if (ssidEl) ssidEl.textContent = WIFI_SSID;
  if (passEl) passEl.textContent = WIFI_PASS;

  function tick() {
    if (dateEl)  dateEl.textContent  = formatHeaderDate();
    if (clockEl) clockEl.textContent = formatHeaderClock();
  }
  tick();
  // Update clock once per second (smooth)
  setInterval(tick, 1000);
}

function buildRoomCard(roomId, roomEvents) {
  // Card
  const card = el('div', 'room');

  // Header: room id at left; count at right (optional)
  const header = el('div', 'roomHeader');
  header.appendChild(el('div', 'id', roomId));
  if (roomEvents.length > 0) {
    header.appendChild(el('div', 'count', `${roomEvents.length} event${roomEvents.length>1?'s':''}`));
  } else {
    header.appendChild(el('div', 'count', ''));
  }
  card.appendChild(header);

  // Events list
  const list = el('div', 'events');
  if (roomEvents.length === 0) {
    // Keep cell empty per your request (no "No reservations")
  } else {
    for (const evt of roomEvents) {
      const chip = el('div', 'event');
      const who  = el('div', 'who', evt.title || 'Reserved');
      const what = evt.subtitle ? el('div', 'what', evt.subtitle) : null;
      const when = el('div', 'when', fmtRange(evt.startMin, evt.endMin));

      chip.appendChild(who);
      if (what) chip.appendChild(what);
      chip.appendChild(when);
      list.appendChild(chip);
    }
  }
  card.appendChild(list);
  return card;
}

function renderGrid(data) {
  // Containers
  const southEl      = document.getElementById('southRooms');
  const fieldhouseEl = document.getElementById('fieldhouseRooms');
  const northEl      = document.getElementById('northRooms');

  if (!southEl || !fieldhouseEl || !northEl) {
    console.error('Grid containers missing in index.html');
    return;
  }

  // Clear existing
  southEl.innerHTML = '';
  fieldhouseEl.innerHTML = '';
  northEl.innerHTML = '';

  const nowMin = nowMinutes();
  const dayStart = data.dayStartMin ?? 360;
  const dayEnd   = data.dayEndMin   ?? 1380;

  // Filter to current/future events (hide fully past)
  const visibleSlots = Array.isArray(data.slots) ? data.slots.filter(s => s && s.endMin > nowMin && s.startMin < dayEnd) : [];

  // Group events by room id
  const byRoom = new Map();
  for (const id of [...GROUPS.south, ...GROUPS.fieldhouse, ...GROUPS.north]) {
    byRoom.set(id, []);
  }
  for (const s of visibleSlots) {
    if (!s.roomId) continue;
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // Sort events inside each room by start time
  for (const [rid, list] of byRoom) {
    list.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  // Build South (1,2)
  GROUPS.south.forEach(rid => {
    const card = buildRoomCard(rid, byRoom.get(rid) || []);
    southEl.appendChild(card);
  });

  // Build Fieldhouse (3..8) in a 2x3 grid; index.html CSS already arranges it
  GROUPS.fieldhouse.forEach(rid => {
    const card = buildRoomCard(rid, byRoom.get(rid) || []);
    fieldhouseEl.appendChild(card);
  });

  // Build North (9,10)
  GROUPS.north.forEach(rid => {
    const card = buildRoomCard(rid, byRoom.get(rid) || []);
    northEl.appendChild(card);
  });
}

// ---------- data load ----------
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// Re-render frequently so events fall off after they end without reloading the page.
let latestData = null;
async function renderLoop() {
  if (!latestData) return;
  renderGrid(latestData);
}
setInterval(renderLoop, 30 * 1000); // refresh view every 30s

// ---------- init ----------
async function init() {
  renderHeader();
  try {
    latestData = await loadData();
    renderGrid(latestData);
  } catch (err) {
    console.error(err);
  }
}
document.addEventListener('DOMContentLoaded', init);
