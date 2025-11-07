/* app.js — RAEC Rooms Board */

const TICK_MS = 1000;
const ROTATE_MS = 8000; // cycle each room every 8s when >1 event

// ——— Utilities ———
function fmtClock(date = new Date()) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtHeaderDate(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function byStart(a, b) {
  return (a.startMin ?? 0) - (b.startMin ?? 0);
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Map of room groups we will render in the fixed HTML skeleton
const SOUTH = ['1A', '1B', '2A', '2B'];
const NORTH = ['9A', '9B', '10A', '10B'];

// Fieldhouse can be classic courts (3..8) or turf quarters (NA/NB/SA/SB)
const FH_COURTS = ['3', '4', '5', '6', '7', '8'];
const FH_TURF = ['Quarter Turf NA', 'Quarter Turf NB', 'Quarter Turf SA', 'Quarter Turf SB'];

function isTurfLayout(roomsList) {
  // We consider turf mode if any turf quarter ID is present among rooms
  const set = new Set(roomsList.map(r => r.id));
  return FH_TURF.some(id => set.has(id));
}

function labelFor(roomId) {
  // Labels: for turf quarters keep short labels (NA/NB/SA/SB)
  if (roomId.startsWith('Quarter Turf ')) return roomId.replace('Quarter Turf ', '');
  return roomId;
}

// Build a standard room card (same structure as South/North)
function buildRoomCard(roomId) {
  return el(`
    <div class="room" data-room="${roomId}">
      <div class="roomHeader">
        <div class="id">${labelFor(roomId)}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events">
        <div class="single-rotor"></div>
      </div>
    </div>
  `);
}

// Render a single event chip
function eventChip(slot) {
  // Title = who; Subtitle = what; When range from startMin/endMin
  const when = minutesToRange(slot.startMin, slot.endMin);
  const who = esc(slot.title || '');
  const what = esc(slot.subtitle || '');
  return el(`
    <div class="event" style="position:absolute; inset:0; opacity:0; transform:translateX(40px); transition:transform 400ms ease, opacity 400ms ease;">
      <div class="who">${who}</div>
      ${what ? `<div class="what">${what}</div>` : ''}
      <div class="when">${when}</div>
    </div>
  `);
}

function minutesToRange(s, e) {
  const fmt = m => {
    let h = Math.floor(m / 60);
    let min = m % 60;
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(min).padStart(2, '0')}${ampm}`;
  };
  if (typeof s !== 'number' || typeof e !== 'number') return '';
  return `${fmt(s)} – ${fmt(e)}`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

// Animate swap inside a rotor: if only 1, just show it; if >1, cross-slide
async function startRotor(rotorEl, slots) {
  // Clean
  rotorEl.innerHTML = '';
  // Sort by start time
  const sorted = [...slots].sort(byStart);

  // If there are no slots, leave room empty (no “no data” chip)
  if (sorted.length === 0) return;

  // Helper to place chip visible
  const showChip = async (chip) => {
    rotorEl.appendChild(chip);
    // enter
    await frame();
    chip.style.opacity = '1';
    chip.style.transform = 'translateX(0)';
  };

  // If exactly one slot, render it and stop (no interval; no animation churn)
  if (sorted.length === 1) {
    const only = eventChip(sorted[0]);
    await showChip(only);
    // update count
    const roomCard = rotorEl.closest('.room');
    if (roomCard) {
      const em = roomCard.querySelector('.roomHeader .count em');
      if (em) em.textContent = '1';
    }
    return;
  }

  // Multi: cycle with slide
  let idx = 0;

  // initial
  const first = eventChip(sorted[idx]);
  await showChip(first);
  updateCount(rotorEl, sorted.length);

  setInterval(async () => {
    const current = rotorEl.querySelector('.event');
    idx = (idx + 1) % sorted.length;
    const next = eventChip(sorted[idx]);

    rotorEl.appendChild(next);
    await frame(); // allow layout
    // kick in simultaneous transitions
    current && (current.style.opacity = '0', current.style.transform = 'translateX(-40px)');
    next.style.opacity = '1';
    next.style.transform = 'translateX(0)';

    // cleanup the old after transition
    setTimeout(() => current && current.remove(), 420);
  }, ROTATE_MS);
}

function frame() {
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function updateCount(rotorEl, n) {
  const roomCard = rotorEl.closest('.room');
  if (!roomCard) return;
  const em = roomCard.querySelector('.roomHeader .count em');
  if (em) em.textContent = String(n);
}

// ——— Main render ———
async function main() {
  // Header clock/date
  const $date = document.getElementById('headerDate');
  const $clock = document.getElementById('headerClock');
  const updateTime = () => {
    const now = new Date();
    if ($date) $date.textContent = fmtHeaderDate(now);
    if ($clock) $clock.textContent = fmtClock(now);
  };
  updateTime();
  setInterval(updateTime, TICK_MS);

  // Fetch JSON (cache-busted and no-store)
  // before:
  // const res = await fetch('./events.json');
  // after (cache-busted + no-store):
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();
  console.log('events.json loaded:', data?.slots?.length, 'slots');

  const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
  const slots = Array.isArray(data?.slots) ? data.slots : [];

  // Bucket slots by room
  const byRoom = new Map();
  for (const r of rooms) byRoom.set(r.id, []);
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // SOUTH (prebuilt containers in HTML)
  for (const id of SOUTH) renderIntoPrebuilt(id, byRoom.get(id) || []);

  // NORTH (prebuilt containers in HTML)
  for (const id of NORTH) renderIntoPrebuilt(id, byRoom.get(id) || []);

  // FIELDHOUSE
  renderFieldhouse(rooms, byRoom);
}

function renderIntoPrebuilt(roomId, roomSlots) {
  const host = document.getElementById(`room-${roomId}`);
  if (!host) return; // container not present in template
  const rotor = host.querySelector('.single-rotor');
  const count = host.querySelector('.roomHeader .count em');

  // If no events, clear and hide count
  if (!roomSlots || roomSlots.length === 0) {
    if (rotor) rotor.innerHTML = '';
    if (count) count.textContent = '0';
    return;
  }

  if (count) count.textContent = String(roomSlots.length);
  startRotor(rotor, roomSlots);
}

function renderFieldhouse(rooms, byRoom) {
  const mount = document.getElementById('fieldhousePager');
  if (!mount) return;

  mount.innerHTML = ''; // rebuild from scratch each time

  const ids = rooms.map(r => r.id);
  const turfMode = isTurfLayout(rooms);

  let fhOrder = [];
  if (turfMode) {
    // 2×2 quarters: NA | NB
    //               SA | SB
    fhOrder = FH_TURF;
  } else {
    // 2×3 courts 3..8
    fhOrder = FH_COURTS;
  }

  // Build the grid container that matches CSS (.rooms-fieldhouse)
  const grid = el(`<div class="rooms-fieldhouse"></div>`);

  // For turf, we’ll render 4 cards; for classic, 6 cards
  fhOrder.forEach(id => {
    // Only render if this room exists in events.json.rooms (so layout reflects current season properly),
    // but still show card even if there are 0 events (then it stays empty).
    if (!ids.includes(id)) {
      // If the transformer did not include the room in rooms list, skip
      return;
    }
    const card = buildRoomCard(id);
    const rotor = card.querySelector('.single-rotor');
    const slots = byRoom.get(id) || [];
    const count = card.querySelector('.roomHeader .count em');
    if (count) count.textContent = String(slots.length || 0);

    if (slots.length > 0) startRotor(rotor, slots); // only start if something to show
    grid.appendChild(card);
  });

  mount.appendChild(grid);
}

// Kick off
main().catch(err => {
  console.error('app init failed:', err);
});
