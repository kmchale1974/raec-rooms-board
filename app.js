// app.js (drop-in)
// -------------------------------------------------------------

const ROOMS_FIXED = ['1A','1B','2A','2B','9A','9B','10A','10B'];
const FIELD_COURTS = ['3','4','5','6','7','8'];
const TURF_QUADS   = ['NA','NB','SA','SB']; // Quarter Turf NA/NB/SA/SB

const PAGE_DURATION_MS = 8000; // per-event display time
const SLIDE_MS = 420;          // slide animation
const TICK_MS = 250;           // small guard for class flips

// Cache-busted fetch
async function loadData() {
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();
  console.log('events.json loaded:', data?.slots?.length, 'slots');
  return data;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Split slots by room id
function groupByRoom(slots) {
  const m = new Map();
  for (const s of slots) {
    if (!m.has(s.roomId)) m.set(s.roomId, []);
    m.get(s.roomId).push(s);
  }
  for (const [k, arr] of m) {
    arr.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin || a.title.localeCompare(b.title));
  }
  return m;
}

// Formatters
function fmtRange(startMin, endMin) {
  function hhmm(mins) {
    let h = Math.floor(mins/60), m = mins%60;
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h%12 || 12;
    return `${h}:${String(m).padStart(2,'0')}${ampm}`;
  }
  return `${hhmm(startMin)} – ${hhmm(endMin)}`;
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Render a single event chip
function renderChip(slot) {
  const who  = esc(slot.title || '');
  const what = esc(slot.subtitle || '');
  const when = esc(fmtRange(slot.startMin, slot.endMin));
  return `
    <div class="event">
      <div class="who">${who}</div>
      ${what ? `<div class="what">${what}</div>` : ''}
      <div class="when">${when}</div>
    </div>`;
}

// --- Rotor (1 visible at a time, slide only if >1) ---
const rotors = new Map(); // roomId -> state

function startRotor(roomEl, roomId, items) {
  // Guard: no DOM container? bail
  const eventsEl = roomEl.querySelector('.events');
  if (!eventsEl) return;

  // If 0 items: clear and stop
  if (!items.length) {
    stopRotor(roomId);
    eventsEl.innerHTML = '';
    const cnt = roomEl.querySelector('.roomHeader .count em');
    if (cnt) cnt.textContent = '0';
    return;
  }

  // If 1 item: render static (no animation)
  if (items.length === 1) {
    stopRotor(roomId);
    const html = renderChip(items[0]);
    eventsEl.innerHTML = html;
    const cnt = roomEl.querySelector('.roomHeader .count em');
    if (cnt) cnt.textContent = '1';
    return;
  }

  // Multiple items → animate
  let state = rotors.get(roomId);
  if (!state) {
    state = { idx: 0, timer: null, busy: false };
    rotors.set(roomId, state);
  }

  const cnt = roomEl.querySelector('.roomHeader .count em');
  if (cnt) cnt.textContent = String(items.length);

  // First paint if container empty
  if (!eventsEl.firstElementChild) {
    eventsEl.innerHTML = renderChip(items[state.idx]);
  }

  // (Re)start interval
  stopRotor(roomId);
  state.timer = setInterval(() => {
    if (state.busy) return;
    state.busy = true;

    const cur = eventsEl.firstElementChild;
    const nextIdx = (state.idx + 1) % items.length;
    const nextHTML = renderChip(items[nextIdx]);
    const tmp = document.createElement('div');
    tmp.innerHTML = nextHTML;
    const nextNode = tmp.firstElementChild;
    nextNode.classList.add('is-enter'); // start offstage right

    // insert next on top
    eventsEl.appendChild(nextNode);

    // kick in transitions
    setTimeout(() => {
      if (cur) cur.classList.add('is-exit');
      nextNode.classList.add('is-enter-active');
      setTimeout(() => {
        nextNode.classList.remove('is-enter','is-enter-active');
        if (cur) cur.classList.add('is-exit-active');
        setTimeout(() => {
          if (cur && cur.parentNode === eventsEl) cur.remove();
          state.idx = nextIdx;
          state.busy = false;
        }, SLIDE_MS + TICK_MS);
      }, TICK_MS);
    }, TICK_MS);

  }, PAGE_DURATION_MS);
}

function stopRotor(roomId) {
  const s = rotors.get(roomId);
  if (s?.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

// --- Build Fieldhouse area ---
function buildFieldhouseContainer(isTurf) {
  const pager = document.getElementById('fieldhousePager');
  if (!pager) return;
  pager.innerHTML = '';

  if (isTurf) {
    // 2x2: NA | NB
    //      SA | SB
    pager.className = 'rooms-fieldhouse turf-2x2';
    pager.innerHTML = `
      <div class="room" id="room-NA">
        <div class="roomHeader"><div class="id">Quarter Turf NA</div><div class="count">reservations: <em>—</em></div></div>
        <div class="events"></div>
      </div>
      <div class="room" id="room-NB">
        <div class="roomHeader"><div class="id">Quarter Turf NB</div><div class="count">reservations: <em>—</em></div></div>
        <div class="events"></div>
      </div>
      <div class="room" id="room-SA">
        <div class="roomHeader"><div class="id">Quarter Turf SA</div><div class="count">reservations: <em>—</em></div></div>
        <div class="events"></div>
      </div>
      <div class="room" id="room-SB">
        <div class="roomHeader"><div class="id">Quarter Turf SB</div><div class="count">reservations: <em>—</em></div></div>
        <div class="events"></div>
      </div>
    `;
  } else {
    // 3x2: courts 3..8
    pager.className = 'rooms-fieldhouse courts-3x2';
    pager.innerHTML = `
      <div class="room" id="room-3"><div class="roomHeader"><div class="id">3</div><div class="count">reservations: <em>—</em></div></div><div class="events"></div></div>
      <div class="room" id="room-4"><div class="roomHeader"><div class="id">4</div><div class="count">reservations: <em>—</em></div></div><div class="events"></div></div>
      <div class="room" id="room-5"><div class="roomHeader"><div class="id">5</div><div class="count">reservations: <em>—</em></div></div><div class="events"></div></div>
      <div class="room" id="room-6"><div class="roomHeader"><div class="id">6</div><div class="count">reservations: <em>—</em></div></div><div class="events"></div></div>
      <div class="room" id="room-7"><div class="roomHeader"><div class="id">7</div><div class="count">reservations: <em>—</em></div></div><div class="events"></div></div>
      <div class="room" id="room-8"><div class="roomHeader"><div class="id">8</div><div class="count">reservations: <em>—</em></div></div><div class="events"></div></div>
    `;
  }
}

// Fill one room (fixed or fieldhouse)
function fillRoom(roomId, byRoom) {
  const el = document.getElementById(`room-${roomId}`);
  if (!el) return;
  const nowMin = nowMinutes();
  const all = byRoom.get(roomId) || [];
  const future = all.filter(s => s.endMin > nowMin);
  startRotor(el, roomId, future);
}

// Header clock/date
function startHeader() {
  const dateEl  = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  function tick() {
    const d = new Date();
    const long = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    if (dateEl) dateEl.textContent = long;
    if (clockEl) clockEl.textContent = time;
  }
  tick();
  setInterval(tick, 1000);
}

// Decide season from room IDs present in events.json
function inferTurf(slots) {
  if (!Array.isArray(slots) || !slots.length) return false;
  const ids = new Set(slots.map(s => s.roomId));
  return TURF_QUADS.some(q => ids.has(q));
}

// ---- Boot ----
async function boot() {
  const data = await loadData();
  const slots = Array.isArray(data?.slots) ? data.slots : [];
  const byRoom = groupByRoom(slots);

  // Season
  const isTurf = inferTurf(slots);
  buildFieldhouseContainer(isTurf);

  // Fixed rooms
  ROOMS_FIXED.forEach(id => fillRoom(id, byRoom));

  // Fieldhouse set
  if (isTurf) {
    TURF_QUADS.forEach(id => fillRoom(id, byRoom));
  } else {
    FIELD_COURTS.forEach(id => fillRoom(id, byRoom));
  }

  startHeader();
}

boot().catch(err => console.error('app init failed:', err));
