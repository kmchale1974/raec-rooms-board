/* app.js — robust fill that creates missing .single-rotor if needed */

const ROTATE_MS = 8000;

const SOUTH = ['1A', '1B', '2A', '2B'];
const NORTH = ['9A', '9B', '10A', '10B'];
const FH_COURTS = ['3', '4', '5', '6', '7', '8'];
const FH_TURF   = ['QUARTER TURF NA', 'QUARTER TURF NB', 'QUARTER TURF SA', 'QUARTER TURF SB'];

const $ = (s, r=document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ---------- time formatting ----------
function m2range(s, e) {
  if (typeof s !== 'number' || typeof e !== 'number') return '';
  const fmt = m => {
    let h = Math.floor(m / 60);
    const min = m % 60;
    const am = h < 12;
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(min).padStart(2, '0')}${am ? 'am' : 'pm'}`;
  };
  return `${fmt(s)} – ${fmt(e)}`;
}

// ---------- rotors ----------
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
    ${slot.subtitle ? `<div class="what">${esc(slot.subtitle)}</div>` : ''}
    <div class="when">${m2range(slot.startMin, slot.endMin)}</div>
  `;
  return div;
}

function raf2() { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

async function startRotor(rotorEl, slots) {
  if (!rotorEl) return; // hard guard
  rotorEl.innerHTML = '';

  const roomEl = rotorEl.closest('.room');
  const countEl = roomEl?.querySelector('.roomHeader .count em');
  if (countEl) countEl.textContent = String(slots.length);

  if (!slots.length) return;

  const items = [...slots].sort((a,b) => (a.startMin??0) - (b.startMin??0));

  // single -> show only, no interval
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

// ---------- rendering helpers ----------
function roomIdNorm(x) {
  return String(x ?? '').trim().toUpperCase();
}
function labelFor(id) {
  if (id.startsWith('QUARTER TURF ')) return id.replace('QUARTER TURF ', '');
  return id;
}

function ensureRotor(roomHost) {
  if (!roomHost) return null;
  // prefer existing
  let rotor = roomHost.querySelector('.events .single-rotor') ||
              roomHost.querySelector('.single-rotor');
  if (rotor) return rotor;

  // create into .events if present, else into room
  const eventsHost = roomHost.querySelector('.events') || roomHost;
  const wrap = document.createElement('div');
  wrap.className = 'single-rotor';
  wrap.style.position = 'relative';
  wrap.style.height = '100%';
  wrap.style.width = '100%';
  eventsHost.appendChild(wrap);
  return wrap;
}

function fillFixedRoom(roomId, slots) {
  const host = document.getElementById(`room-${roomId}`);
  if (!host) {
    console.warn(`room #room-${roomId} not found in DOM`);
    return;
  }
  const badge = host.querySelector('.roomHeader .count em');
  if (badge) badge.textContent = String(slots.length || 0);

  const rotor = ensureRotor(host);
  if (!rotor) return;
  startRotor(rotor, slots);
}

function detectFHMode(keys) {
  const anyTurf = keys.some(k => k.startsWith('QUARTER TURF '));
  if (anyTurf) return 'turf';
  const anyCourts = keys.some(k => FH_COURTS.includes(k));
  return anyCourts ? 'courts' : 'courts';
}

function renderFieldhouse(byRoom) {
  const mount = document.getElementById('fieldhousePager');
  if (!mount) return;

  mount.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'page is-active';

  const keys = Array.from(byRoom.keys());
  const mode = detectFHMode(keys);
  const order = mode === 'turf' ? FH_TURF : FH_COURTS;

  order.forEach(id => {
    const card = document.createElement('div');
    card.className = 'room';
    card.innerHTML = `
      <div class="roomHeader">
        <div class="id">${esc(labelFor(id))}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events"><div class="single-rotor"></div></div>
    `;
    wrapper.appendChild(card);

    const rSlots = byRoom.get(id) || [];
    const badge = card.querySelector('.roomHeader .count em');
    if (badge) badge.textContent = String(rSlots.length || 0);
    const rotor = ensureRotor(card);
    if (rSlots.length) startRotor(rotor, rSlots);
  });

  mount.appendChild(wrapper);
}

// ---------- main ----------
async function boot() {
  // header clock/date
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

  // load data (cache-busted)
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const slotsRaw = Array.isArray(data?.slots) ? data.slots : [];

  // normalize slots (upper-case room IDs)
  const slots = slotsRaw.map(s => ({
    ...s,
    roomId: roomIdNorm(s.roomId),
    title: s.title ?? '',
    subtitle: s.subtitle ?? '',
  }));

  // bucket by room (create all buckets up-front so counts render)
  const byRoom = new Map();
  [...SOUTH, ...NORTH, ...FH_COURTS, ...FH_TURF].forEach(id => byRoom.set(roomIdNorm(id), []));
  for (const s of slots) {
    const key = roomIdNorm(s.roomId);
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key).push(s);
  }

  // Debug
  const dbg = {};
  for (const [k, v] of byRoom.entries()) if (v.length) dbg[k] = v.length;
  console.log('events.json loaded:', { totalSlots: slots.length, nonEmptyRooms: dbg });

  // South/North: fill existing cards only
  SOUTH.forEach(id => fillFixedRoom(id, byRoom.get(roomIdNorm(id)) || []));
  NORTH.forEach(id => fillFixedRoom(id, byRoom.get(roomIdNorm(id)) || []));

  // Fieldhouse: one page matching your CSS
  renderFieldhouse(byRoom);
}

boot().catch(err => console.error('app init failed:', err));
