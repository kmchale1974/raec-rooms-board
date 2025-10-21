// app.js (ES module)

// ---------- Config ----------
const DATA_URL = `./events.json?ts=${Date.now()}`;
const HIDE_PAST = true;          // remove events that already ended
const ROOM_PAGE_SIZE = 5;        // events per page in a room card
const ROOM_PAGE_MS   = 8000;     // ms between page flips
const CLOCK_TICK_MS  = 1000;     // live clock refresh

// Pager state per room
const roomPager = Object.create(null);

// ---------- Utilities ----------
function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function pad2(n) { return String(n).padStart(2,'0'); }
function minsTo12h(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  return `${h12}:${pad2(m)}${ampm}`;
}
function escapeHTML(s='') {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}
function isLikelyPerson(name) {
  // crude heuristic: “Last, First” or two words with a comma
  return /,/.test(name) || /^[A-Za-z]+(?:\s+[A-Za-z'.-]+){1,2}$/.test(name);
}
function invertLastFirst(name) {
  // "Doe, John A." -> "John A. Doe"
  const parts = String(name).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`.replace(/\s+/g,' ').trim();
  return name;
}
function normalizeOrgAndContact(title = '', subtitle = '') {
  // Split "Org, Contact" if looks like that; otherwise treat whole title as org
  let org = title.trim();
  let contact = '';
  if (/,/.test(org)) {
    const [left, right] = org.split(',', 2).map(s => s.trim());
    if (right && isLikelyPerson(right)) {
      org = left;
      contact = invertLastFirst(right);
    }
  }
  // If title is “Brown, Shawnton” (or similar) with no org, display contact only
  if (!/,/.test(title) && isLikelyPerson(title)) {
    org = '';
    contact = invertLastFirst(title);
  }

  // Special rename for Pickleball: drop internal verbiage
  const combined = `${title} ${subtitle}`.toLowerCase();
  if (combined.includes('pickleball')) {
    org = 'Open Pickleball';
    contact = ''; // hide internal-hold names
  }

  return { org, contact };
}

function dedupeWithinRoom(slots) {
  // Remove exact duplicates (same [start,end,org,contact,what])
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const k = [
      s.startMin, s.endMin,
      (s.org || '').toLowerCase(),
      (s.contact || '').toLowerCase(),
      (s.what || '').toLowerCase()
    ].join('||');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// ---------- Rendering ----------
function updateHeaderClock() {
  const d = new Date();
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (dateEl) {
    const opts = { weekday:'long', month:'long', day:'numeric' };
    dateEl.textContent = d.toLocaleDateString(undefined, opts);
  }
  if (clockEl) {
    const hh = d.getHours();
    const mm = pad2(d.getMinutes());
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    clockEl.textContent = `${h12}:${mm} ${ampm}`;
  }
}

function buildRoomCard(roomId, targetContainer) {
  const card = document.createElement('div');
  card.className = 'room';
  const header = document.createElement('div');
  header.className = 'roomHeader';
  header.innerHTML = `
    <div class="id">${escapeHTML(roomId)}</div>
    <div class="count"></div>
  `;
  const list = document.createElement('div');
  list.className = 'events';
  card.appendChild(header);
  card.appendChild(list);
  targetContainer.appendChild(card);
  return card;
}

function renderEventHTML(evt) {
  const when = `${minsTo12h(evt.startMin)} – ${minsTo12h(evt.endMin)}`;
  const whoLine = evt.org ? `<div class="who"><strong>${escapeHTML(evt.org)}</strong></div>` : '';
  const contactLine = evt.contact ? `<div class="what">${escapeHTML(evt.contact)}</div>` : '';
  const whatLine = (!evt.contact && evt.what) ? `<div class="what">${escapeHTML(evt.what)}</div>` : '';
  return `
    <div class="event">
      ${whoLine}${contactLine || whatLine || ''}
      <div class="when">${when}</div>
    </div>
  `;
}

function renderRoomPaged(roomEl, roomId, eventsForRoom) {
  // split into pages
  const pages = [];
  for (let i = 0; i < eventsForRoom.length; i += ROOM_PAGE_SIZE) {
    pages.push(eventsForRoom.slice(i, i + ROOM_PAGE_SIZE));
  }

  const header = roomEl.querySelector('.roomHeader');
  const list = roomEl.querySelector('.events');
  const countEl = header?.querySelector('.count');

  // clear existing interval if any
  const prev = roomPager[roomId];
  if (prev?.timer) clearInterval(prev.timer);

  if (pages.length <= 1) {
    list.innerHTML = eventsForRoom.map(renderEventHTML).join('');
    if (countEl) countEl.textContent = '';
    roomPager[roomId] = { page: 0, pages: 1, timer: null };
    return;
  }

  const state = { page: 0, pages: pages.length, timer: null };
  roomPager[roomId] = state;

  const renderPage = () => {
    const cur = pages[state.page];
    list.innerHTML = cur.map(renderEventHTML).join('');
    if (countEl) countEl.textContent = `Page ${state.page + 1} / ${state.pages}`;
  };

  renderPage();
  state.timer = setInterval(() => {
    state.page = (state.page + 1) % state.pages;
    renderPage();
  }, ROOM_PAGE_MS);
}

// ---------- Main ----------
async function loadData() {
  const resp = await fetch(DATA_URL, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const json = await resp.json();
  console.log('Loaded events.json', json);
  return json;
}

function prepareRoomsDOM(rooms) {
  const southWrap = document.getElementById('southRooms');
  const fieldWrap = document.getElementById('fieldhouseRooms');
  const northWrap = document.getElementById('northRooms');
  southWrap.innerHTML = '';
  fieldWrap.innerHTML = '';
  northWrap.innerHTML = '';

  const cardByRoom = Object.create(null);

  // Keep order: south(1..2), fieldhouse(3..8), north(9..10)
  const south = rooms.filter(r => r.group === 'south').sort((a,b)=>Number(a.id)-Number(b.id));
  const field = rooms.filter(r => r.group === 'fieldhouse').sort((a,b)=>Number(a.id)-Number(b.id));
  const north = rooms.filter(r => r.group === 'north').sort((a,b)=>Number(a.id)-Number(b.id));

  for (const r of south) cardByRoom[r.id] = buildRoomCard(r.label || r.id, southWrap);
  for (const r of field) cardByRoom[r.id] = buildRoomCard(r.label || r.id, fieldWrap);
  for (const r of north) cardByRoom[r.id] = buildRoomCard(r.label || r.id, northWrap);

  return cardByRoom;
}

function normalizeSlots(rawSlots) {
  // Map slots -> enriched objects with {roomId,startMin,endMin,org,contact,what}
  const out = [];
  for (const s of (rawSlots || [])) {
    if (s == null) continue;
    const { roomId, startMin, endMin } = s;
    if (roomId == null || startMin == null || endMin == null) continue;

    // Title/Subtitles to org/contact/what
    const { org, contact } = normalizeOrgAndContact(s.title || '', s.subtitle || '');
    const what = s.subtitle || '';

    out.push({ roomId: String(roomId), startMin, endMin, org, contact, what });
  }
  return out;
}

function filterPast(slots, nowMin) {
  if (!HIDE_PAST) return slots;
  return slots.filter(s => s.endMin > nowMin);
}

function groupSlotsByRoom(slots) {
  const byRoom = new Map();
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  // sort each room by start time
  for (const arr of byRoom.values()) arr.sort((a,b)=>a.startMin - b.startMin || a.endMin - b.endMin);
  return byRoom;
}

async function init() {
  // clock header
  updateHeaderClock();
  setInterval(updateHeaderClock, CLOCK_TICK_MS);

  let data = { rooms: [], slots: [], dayStartMin: 360, dayEndMin: 1380 };
  try {
    data = await loadData();
  } catch (e) {
    console.error('Failed to load events.json:', e);
  }

  const cardByRoom = prepareRoomsDOM(data.rooms || []);
  const nowMin = nowMinutesLocal();

  // normalize + filter
  let slots = normalizeSlots(data.slots || []);
  slots = filterPast(slots, nowMin);

  // per-room dedupe
  const grouped = groupSlotsByRoom(slots);
  for (const [roomId, list] of grouped.entries()) {
    const deduped = dedupeWithinRoom(list);
    const card = cardByRoom[roomId];
    if (!card) continue;
    renderRoomPaged(card, roomId, deduped);
  }

  // rooms with no entries still render their empty cards (already built)
}

document.addEventListener('DOMContentLoaded', init);
