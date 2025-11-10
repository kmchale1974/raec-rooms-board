/* app.js — stable grid fill (no pager wrapper), robust & defensive */

const ROTATE_MS = 8000;

const SOUTH = ['1A', '1B', '2A', '2B'];
const NORTH = ['9A', '9B', '10A', '10B'];
const FH_COURTS = ['3', '4', '5', '6', '7', '8'];
const FH_TURF   = ['QUARTER TURF NA', 'QUARTER TURF NB', 'QUARTER TURF SA', 'QUARTER TURF SB'];

const $ = (s, r=document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ---------- time formatting ----------
function fmtRange(startMin, endMin) {
  if (typeof startMin !== 'number' || typeof endMin !== 'number') return '';
  const f = m => {
    let h = Math.floor(m / 60);
    const min = m % 60;
    const am = h < 12;
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(min).padStart(2, '0')}${am ? 'am' : 'pm'}`;
  };
  return `${f(startMin)} – ${f(endMin)}`;
}

// ---------- rotors (1-at-a-time) ----------
function makeChip(slot) {
  const div = document.createElement('div');
  div.className = 'event';
  div.style.position = 'absolute';
  div.style.inset = '0';
  div.style.opacity = '0';
  div.style.transform = 'translateX(40px)';
  div.style.transition = 'transform 400ms ease, opacity 400ms ease';
  div.innerHTML = `
    <div class="who">${esc(slot.title || '')}</div>
    ${slot.subtitle ? `<div class="what">${esc(slot.subtitle)}` : ''}</div>
    <div class="when">${fmtRange(slot.startMin, slot.endMin)}</div>
  `;
  return div;
}
function raf2() { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

async function startRotor(rotorEl, slots) {
  if (!rotorEl) return;
  rotorEl.innerHTML = '';

  const roomEl = rotorEl.closest('.room');
  const countEl = roomEl?.querySelector('.roomHeader .count em');
  if (countEl) countEl.textContent = String(slots.length);

  if (!slots.length) return;

  const items = [...slots].sort((a,b) => (a.startMin??0) - (b.startMin??0));

  // Single item: show it (no interval)
  if (items.length === 1) {
    const chip = makeChip(items[0]);
    rotorEl.appendChild(chip);
    await raf2();
    chip.style.opacity = '1';
    chip.style.transform = 'translateX(0)';
    return;
  }

  let idx = 0;
  let cur = makeChip(items[idx]);
  rotorEl.appendChild(cur);
  await raf2();
  cur.style.opacity = '1';
  cur.style.transform = 'translateX(0)';

  setInterval(async () => {
    const nextIdx = (idx + 1) % items.length;
    const next = makeChip(items[nextIdx]);
    rotorEl.appendChild(next);
    await raf2();
    cur.style.opacity = '0';
    cur.style.transform = 'translateX(-40px)';
    next.style.opacity = '1';
    next.style.transform = 'translateX(0)';
    setTimeout(() => { try { cur.remove(); } catch {} }, 420);
    idx = nextIdx;
    cur = next;
  }, ROTATE_MS);
}

// ---------- helpers ----------
function normRoomId(x) { return String(x ?? '').trim().toUpperCase(); }
function labelFor(id) {
  const u = normRoomId(id);
  if (u.startsWith('QUARTER TURF ')) return u.replace('QUARTER TURF ', '');
  return u;
}
function ensureRotorIn(host) {
  if (!host) return null;
  let rotor = host.querySelector('.events .single-rotor') || host.querySelector('.single-rotor');
  if (rotor) return rotor;
  const eventsHost = host.querySelector('.events') || host;
  const wrap = document.createElement('div');
  wrap.className = 'single-rotor';
  wrap.style.position = 'relative';
  wrap.style.height = '100%';
  wrap.style.width  = '100%';
  eventsHost.appendChild(wrap);
  return wrap;
}

// ---------- fixed South/North (use existing cards in HTML) ----------
function fillFixedRoom(roomId, slots) {
  const host = document.getElementById(`room-${roomId}`);
  if (!host) {
    console.warn(`DOM missing #room-${roomId}`);
    return;
  }
  const badge = host.querySelector('.roomHeader .count em');
  if (badge) badge.textContent = String(slots.length || 0);
  const rotor = ensureRotorIn(host);
  if (!rotor) return;
  startRotor(rotor, slots);
}

// ---------- Fieldhouse grid (no pager wrapper) ----------
function detectFHMode(keys) {
  const hasTurf = keys.some(k => normRoomId(k).startsWith('QUARTER TURF '));
  if (hasTurf) return 'turf';
  const hasCourts = keys.some(k => FH_COURTS.includes(normRoomId(k)));
  return hasCourts ? 'courts' : 'courts';
}

function renderFieldhouse(byRoom) {
  const mount = document.getElementById('fieldhousePager'); // your HTML uses this id
  if (!mount) return;

  // Build cards directly inside the existing .rooms-fieldhouse grid
  mount.innerHTML = '';

  // Decide layout based on what's actually in events.json
  const keysWithData = [...byRoom.entries()].filter(([k, v]) => v.length > 0).map(([k]) => k);
  const mode = detectFHMode(keysWithData);
  const order = mode === 'turf' ? FH_TURF : FH_COURTS;

  // Always render all Fieldhouse boxes so the grid appears, even if count=0
  order.forEach(id => {
    const card = document.createElement('div');
    card.className = 'room';
    card.innerHTML = `
      <div class="roomHeader">
        <div class="id">${esc(labelFor(id))}</div>
        <div class="count">reservations: <em>0</em></div>
      </div>
      <div class="events"><div class="single-rotor"></div></div>
    `;
    mount.appendChild(card);

    const slots = byRoom.get(normRoomId(id)) || [];
    const badge = card.querySelector('.roomHeader .count em');
    if (badge) badge.textContent = String(slots.length || 0);

    const rotor = ensureRotorIn(card);
    if (slots.length) startRotor(rotor, slots);
  });
}

// ---------- main ----------
async function boot() {
  // Header date/clock
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const tick = () => {
    const now = new Date();
    try {
      dateEl.textContent = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
      clockEl.textContent = now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    } catch {}
  };
  tick();
  setInterval(tick, 1000);

  // Load events.json (cache-busted)
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const rawSlots = Array.isArray(data?.slots) ? data.slots : [];
  const slots = rawSlots.map(s => ({
    ...s,
    roomId: normRoomId(s.roomId),
    title: s.title ?? '',
    subtitle: s.subtitle ?? '',
  }));

  // Bucket by all possible rooms so counts are stable
  const allRooms = new Set([
    ...SOUTH.map(normRoomId),
    ...NORTH.map(normRoomId),
    ...FH_COURTS.map(normRoomId),
    ...FH_TURF.map(normRoomId),
  ]);
  const byRoom = new Map([...allRooms].map(k => [k, []]));
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // Debug
  const dbg = {};
  for (const [k, v] of byRoom.entries()) if (v.length) dbg[k] = v.length;
  console.log('events.json loaded:', { totalSlots: slots.length, nonEmptyRooms: dbg });

  // South & North (use existing DOM cards)
  SOUTH.forEach(id => fillFixedRoom(id, byRoom.get(normRoomId(id)) || []));
  NORTH.forEach(id => fillFixedRoom(id, byRoom.get(normRoomId(id)) || []));

  // Fieldhouse (fill grid directly)
  renderFieldhouse(byRoom);
}

boot().catch(err => console.error('app init failed:', err));
