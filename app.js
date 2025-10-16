// ====== CONFIG ======
const SSID = 'RAEC_Public';
const WIFI_PASS = 'Publ!c00'; // as requested
const EVENTS_URL = './events.json';
const REFRESH_MS = 5 * 60 * 1000;  // re-fetch events.json every 5 minutes
const TICK_MS    = 60 * 1000;      // re-render every minute so past events fall off
const MAX_LINES_PER_CELL = 4;      // safety cap per room cell

// Building hours (min since midnight). transform.mjs also clamps, but we guard too.
const DAY_START_MIN = 360;  // 6:00 AM
const DAY_END_MIN   = 1380; // 11:00 PM

// Physical layout groups like your whiteboard
const SOUTH = ['1A','1B','2A','2B'];
const FIELDH = ['3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B'];
const NORTH = ['9A','9B','10A','10B'];

// ====== CLOCK / WIFI ======
function formatDate(d){
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
}
function formatTime(d){
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function startClock(){
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const tick = () => {
    const now = new Date();
    if (dateEl)  dateEl.textContent  = formatDate(now);
    if (clockEl) clockEl.textContent = formatTime(now);
  };
  tick();
  setInterval(tick, 10_000);
}
function updateWifi(){
  const ssidEl = document.getElementById('wifiSsid');
  const passEl = document.getElementById('wifiPass');
  if (ssidEl) ssidEl.textContent = SSID;
  if (passEl) passEl.textContent = WIFI_PASS;
}

// ====== DATA FETCH ======
let eventsData = null;

async function fetchEvents() {
  const url = `${EVENTS_URL}?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  // basic sanity
  if (!data || !data.rooms || !Array.isArray(data.slots)) {
    throw new Error('events.json missing required fields (rooms, slots)');
  }
  eventsData = data;
  console.log('Loaded events.json', {
    rooms: Object.keys(data.rooms).length,
    slots: data.slots.length
  });
  return data;
}

// ====== HELPERS ======
function to12h(min) {
  // clamp to day window for safety (visual only)
  const m = Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, min));
  let h = Math.floor(m / 60);
  const minutes = (m % 60).toString().padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = (h % 12) || 12;
  return `${h}:${minutes}${ampm}`;
}

function groupFutureByRoom(data) {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const byRoom = {};
  // init all rooms so cells render even with no events
  for (const id of Object.keys(data.rooms)) byRoom[id] = [];

  for (const s of data.slots) {
    // show only events that have not ended yet
    if (s.endMin <= nowMin) continue;

    // clamp to building hours (visual)
    const start = Math.max(s.startMin, DAY_START_MIN);
    const end = Math.min(s.endMin, DAY_END_MIN);
    if (end <= start) continue;

    const slot = {
      room: s.room,
      startMin: start,
      endMin: end,
      start: to12h(start),
      end: to12h(end),
      who: s.who || s.reservee || '',
      title: s.title || s.reservationPurpose || '',
    };
    if (!byRoom[slot.room]) byRoom[slot.room] = [];
    byRoom[slot.room].push(slot);
  }

  // sort each room’s list by start time
  for (const r of Object.keys(byRoom)) {
    byRoom[r].sort((a,b) => a.startMin - b.startMin);
  }
  return byRoom;
}

function sectionRows(list) {
  // convert flat [A,B,C,D] => rows [[A,B],[C,D]] for 2 columns across
  const rows = [];
  for (let i=0; i<list.length; i+=2) {
    rows.push(list.slice(i,i+2));
  }
  return rows;
}

// ====== RENDER ======
function lineHTML(slot) {
  const time = `${slot.start} – ${slot.end}`;
  const who = slot.who || slot.title || 'Reserved';
  const note = slot.title && slot.who ? slot.title : '';
  return `
    <div class="line">
      <div class="time">${time}</div>
      <div class="who">${escapeHtml(who)}</div>
      ${note ? `<div class="note">• ${escapeHtml(note)}</div>` : ''}
    </div>
  `;
}

function cellHTML(roomId, slots) {
  const nowMin = new Date().getHours()*60 + new Date().getMinutes();
  const isBusy = slots.some(s => s.startMin <= nowMin && s.endMin > nowMin);
  const statusClass = isBusy ? 'status--busy' : 'status--free';
  const statusText  = isBusy ? 'In Use' : 'Open';

  const lines = slots.slice(0, MAX_LINES_PER_CELL).map(lineHTML).join('');
  return `
    <div class="cell">
      <div class="room-head">
        <div class="room-id">${roomId}</div>
        <div class="status ${statusClass}">${statusText}</div>
      </div>
      <div class="list">
        ${lines || ''}
      </div>
    </div>
  `;
}

function fillSection(containerId, roomIds, byRoom) {
  const el = document.getElementById(containerId);
  if (!el) return;

  // Decide number of rows: South(2), Fieldhouse(6), North(2)
  const rowsNeeded = containerId === 'fieldCells' ? 6 : 2;
  el.style.gridTemplateRows = `repeat(${rowsNeeded}, 1fr)`;

  const html = sectionRows(roomIds).map(row => {
    const [left, right] = row;
    const leftHTML  = cellHTML(left,  byRoom[left]  || []);
    const rightHTML = cellHTML(right, byRoom[right] || []);
    return `<div class="row">${leftHTML}${rightHTML}</div>`;
  }).join('');

  el.innerHTML = html;
}

// tiny safer text
function escapeHtml(s){
  return String(s || '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#39;');
}

// ====== BOOT ======
async function renderOnce() {
  if (!eventsData) return;
  const byRoom = groupFutureByRoom(eventsData);
  fillSection('southCells', SOUTH, byRoom);
  fillSection('fieldCells', FIELDH, byRoom);
  fillSection('northCells', NORTH, byRoom);
}

async function init(){
  try {
    updateWifi();
    startClock();

    await fetchEvents();   // initial load
    await renderOnce();    // initial render

    // Re-render every minute so past events drop off automatically
    setInterval(renderOnce, TICK_MS);

    // Re-fetch file occasionally to pick up new reports
    setInterval(async () => {
      try {
        await fetchEvents();
        await renderOnce();
      } catch (e) {
        console.error('Background refresh failed:', e);
      }
    }, REFRESH_MS);
  } catch (err) {
    console.error('Board init failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
