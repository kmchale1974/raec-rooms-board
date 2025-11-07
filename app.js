/* app.js — resilient renderer for RAEC Rooms Board */

const ROTATE_MS = 8000;

// ----------------- helpers -----------------
const SOUTH = ['1A', '1B', '2A', '2B'];
const NORTH = ['9A', '9B', '10A', '10B'];
const FH_COURTS = ['3', '4', '5', '6', '7', '8'];
const FH_TURF = ['Quarter Turf NA', 'Quarter Turf NB', 'Quarter Turf SA', 'Quarter Turf SB'];

const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// time formatting
function m2range(s, e) {
  if (typeof s !== 'number' || typeof e !== 'number') return '';
  const fmt = m => {
    let h = Math.floor(m / 60);
    const min = m % 60;
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(min).padStart(2, '0')}${ampm}`;
  };
  return `${fmt(s)} – ${fmt(e)}`;
}
const byStart = (a, b) => (a.startMin ?? 0) - (b.startMin ?? 0);

function rLabel(id) {
  return String(id).startsWith('Quarter Turf ')
    ? String(id).replace('Quarter Turf ', '')
    : String(id);
}

function frame() {
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ----------------- rotors -----------------
async function startRotor(rotorEl, slots) {
  rotorEl.innerHTML = '';
  if (!slots || slots.length === 0) return;

  const sorted = [...slots].sort(byStart);

  const makeChip = (slot) => el(`
    <div class="event" style="position:absolute; inset:0; opacity:0; transform:translateX(40px); transition:transform 400ms ease, opacity 400ms ease;">
      <div class="who">${esc(slot.title || '')}</div>
      ${slot.subtitle ? `<div class="what">${esc(slot.subtitle)}</div>` : ''}
      <div class="when">${m2range(slot.startMin, slot.endMin)}</div>
    </div>
  `);

  const showChip = async (chip) => {
    rotorEl.appendChild(chip);
    await frame();
    chip.style.opacity = '1';
    chip.style.transform = 'translateX(0)';
  };

  // count badge
  const roomCard = rotorEl.closest('.room');
  const badge = roomCard && roomCard.querySelector('.roomHeader .count em');
  if (badge) badge.textContent = String(sorted.length);

  // single = no rotation
  if (sorted.length === 1) {
    await showChip(makeChip(sorted[0]));
    return;
  }

  // multi = slide left cycles
  let idx = 0;
  await showChip(makeChip(sorted[idx]));

  setInterval(async () => {
    const current = rotorEl.querySelector('.event');
    idx = (idx + 1) % sorted.length;
    const next = makeChip(sorted[idx]);
    rotorEl.appendChild(next);
    await frame();
    if (current) {
      current.style.opacity = '0';
      current.style.transform = 'translateX(-40px)';
      setTimeout(() => current && current.remove(), 420);
    }
    next.style.opacity = '1';
    next.style.transform = 'translateX(0)';
  }, ROTATE_MS);
}

// ----------------- fieldhouse -----------------
function detectFieldhouseMode(keys) {
  // Prefer turf if any turf quarter appears
  const hasTurf = keys.some(k => String(k).startsWith('Quarter Turf '));
  if (hasTurf) return 'turf';
  // Else courts if we see any 3..8
  const hasCourt = keys.some(k => FH_COURTS.includes(String(k)));
  if (hasCourt) return 'courts';
  // fallback to courts so layout isn't empty
  return 'courts';
}

function buildRoomCard(roomId) {
  return el(`
    <div class="room" data-room="${esc(roomId)}">
      <div class="roomHeader">
        <div class="id">${esc(rLabel(roomId))}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events"><div class="single-rotor"></div></div>
    </div>
  `);
}

// ----------------- renderers -----------------
function renderIntoFixed(roomId, slots) {
  const host = document.getElementById(`room-${roomId}`);
  if (!host) return;
  const rotor = host.querySelector('.single-rotor');
  const badge = host.querySelector('.roomHeader .count em');
  if (!slots || slots.length === 0) {
    if (rotor) rotor.innerHTML = '';
    if (badge) badge.textContent = '0';
    return;
  }
  if (badge) badge.textContent = String(slots.length);
  startRotor(rotor, slots);
}

function renderFieldhouse(byRoom) {
  const mount = document.getElementById('fieldhousePager');
  if (!mount) return;
  mount.innerHTML = '';

  const keys = Array.from(byRoom.keys());
  const fhMode = detectFieldhouseMode(keys);

  const order = fhMode === 'turf' ? FH_TURF : FH_COURTS;
  const grid = el(`<div class="rooms-fieldhouse"></div>`);

  order.forEach(id => {
    // We still render the card even if empty (you can change to skip empties by checking byRoom.get(id)?.length)
    const card = buildRoomCard(id);
    const rotor = card.querySelector('.single-rotor');
    const slots = byRoom.get(id) || [];
    const badge = card.querySelector('.roomHeader .count em');
    if (badge) badge.textContent = String(slots.length || 0);
    if (slots.length > 0) startRotor(rotor, slots);
    grid.appendChild(card);
  });

  mount.appendChild(grid);
}

// ----------------- boot -----------------
async function boot() {
  // clock/date
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const tick = () => {
    const now = new Date();
    try {
      dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      clockEl.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {}
  };
  tick();
  setInterval(tick, 1000);

  // load data with cache-bust
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  // normalize & bucket
  const rawRooms = Array.isArray(data.rooms) ? data.rooms : [];
  const rawSlots = Array.isArray(data.slots) ? data.slots : [];

  // force all ids to strings (prevents 1 vs "1A" mismatches)
  const rooms = rawRooms.map(r => ({ ...r, id: String(r.id) }));
  const slots = rawSlots.map(s => ({ ...s, roomId: String(s.roomId) }));

  // bucket by room
  const byRoom = new Map();
  // include all IDs we care about so fixed cards show up
  [...SOUTH, ...NORTH, ...FH_COURTS, ...FH_TURF, ...rooms.map(r => r.id)].forEach(id => {
    byRoom.set(String(id), []);
  });
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // debug
  const dbg = {};
  for (const [k, v] of byRoom.entries()) if (v.length) dbg[k] = v.length;
  console.log('events.json loaded:', { slots: slots.length, nonEmptyRooms: dbg });

  // render South/North
  SOUTH.forEach(id => renderIntoFixed(id, byRoom.get(id) || []));
  NORTH.forEach(id => renderIntoFixed(id, byRoom.get(id) || []));

  // render Fieldhouse from actual keys present
  renderFieldhouse(byRoom);
}

boot().catch(err => console.error('app init failed:', err));
