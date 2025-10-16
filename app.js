// app.js — Board-only renderer (no timeline), 1920×1080, dark theme

const WIFI_SSID = 'RAEC_Public';     // set to your real SSID
const WIFI_PASS = 'Publ!c00';  // set to your real password text

// Room groupings that match the physical board you described:
//  - Left:  South Gym (2×2) : 1A, 1B, 2A, 2B
//  - Middle: Fieldhouse (3×2): 3A..8B (six boxes: 3,4,5,6,7,8 => each A/B pairs shown as single cells A/B stacked)
//  - Right: North Gym (2×2) : 9A, 9B, 10A, 10B
//
// Implementation: each "cell" represents either a single half-court (A or B)
// for gyms, and for fieldhouse we’ll present individual half-courts as their own cells, too.
// (If you prefer each Fieldhouse number to combine A/B into one cell, let me know and I’ll collapse A/B.)

const SOUTH  = ['1A','1B','2A','2B'];
const NORTH  = ['9A','9B','10A','10B'];
const FIELDH = [
  '3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B'
];

// Utility: time helpers
const nowLocal = () => new Date();
const toMin = d => d.getHours()*60 + d.getMinutes();

// Fetch events.json (no caching)
async function loadData() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  return resp.json();
}

// Given events.json, returns map roomId -> array of future slots (sorted by start)
function buildFutureByRoom(data) {
  const out = new Map();
  const now = nowLocal();
  const nowMin = toMin(now);

  (data.slots || []).forEach(s => {
    // Expect: s.roomId, s.startMin, s.endMin, s.title, s.subtitle (varies by your transform)
    if (!s || !s.roomId) return;

    // Hide fully in the past
    if (typeof s.endMin === 'number' && s.endMin <= nowMin) return;

    if (!out.has(s.roomId)) out.set(s.roomId, []);
    out.get(s.roomId).push(s);
  });

  // sort each room by start time
  for (const list of out.values()) {
    list.sort((a,b) => (a.startMin??0) - (b.startMin??0));
  }
  return out;
}

// Render helpers
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt) e.textContent = txt;
  return e;
}

function formatRange(startMin, endMin) {
  const fmt = m => {
    let h = Math.floor(m/60), mm = m%60;
    const ampm = h >= 12 ? 'pm' : 'am';
    h = (h%12) || 12;
    return `${h}:${mm.toString().padStart(2,'0')}${ampm}`;
  };
  if (typeof startMin !== 'number' || typeof endMin !== 'number') return '';
  return `${fmt(startMin)}–${fmt(endMin)}`;
}

function renderRoomCell(container, id, events=[]) {
  const card = el('div','room');
  const title = el('div','title');
  title.append(el('div','', id));
  const badge = el('span','badge','Today');
  title.append(badge);
  card.append(title);

  if (!events.length) {
    card.append(el('div','empty','— No upcoming reservations —'));
  } else {
    // show up to 4
    events.slice(0,4).forEach(s => {
      const line = el('div','event');
      line.append(el('span','time', formatRange(s.startMin, s.endMin)));
      line.append(el('span','who', s.title || s.subtitle || s.reservee || 'Reserved'));
      if (s.subtitle) line.append(el('span','note', s.subtitle));
      card.append(line);
    });
  }

  container.append(card);
}

function fillSection(containerId, roomIds, roomMap) {
  const root = document.getElementById(containerId);
  root.innerHTML = '';
  roomIds.forEach(id => {
    const events = roomMap.get(id) || [];
    renderRoomCell(root, id, events);
  });
}

function updateWifi() {
  const ssid = document.getElementById('wifiSsid');
  const pass = document.getElementById('wifiPass');
  if (ssid) ssid.textContent = WIFI_SSID;
  if (pass) pass.textContent = WIFI_PASS;
}

async function init() {
  try {
    updateWifi();
    const data = await loadData();
    const roomMap = buildFutureByRoom(data);

    // Sections
    fillSection('southCells', SOUTH, roomMap);
    // Choose which six of fieldhouse to show most relevantly.
    // If you truly only want 6 cells, pick the first 6 unique half-courts with any activity, else show the canonical 6 numbers (3..8) merging A/B.
    // For now we display all 12 (A/B) to keep granularity; if you want 6 cells total (3..8), say the word and I’ll collapse A/B into one box.
    fillSection('fieldCells', FIELDH, roomMap);

    fillSection('northCells', NORTH, roomMap);

    // Refresh every minute so past items roll off
    setInterval(() => {
      const fresh = buildFutureByRoom(data); // use same data; endMin comparison will hide past
      fillSection('southCells', SOUTH, fresh);
      fillSection('fieldCells', FIELDH, fresh);
      fillSection('northCells', NORTH, fresh);
    }, 60_000);

  } catch (err) {
    console.error('Board init failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
