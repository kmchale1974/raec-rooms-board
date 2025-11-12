/* app.js — RAEC Rooms Board (fixed rooms + fieldhouse/turf pager)
   - Fetches ./events.json with cache-busting
   - Uses data.fieldhouseMode ('turf' | 'courts') to build the middle grid
   - Filters past reservations (endMin <= now)
   - Per room: shows one card at a time; animates only if >1
*/

const ROOM_IDS_FIXED = ['1A','1B','2A','2B','9A','9B','10A','10B'];
const TURF_IDS       = ['QT-NA','QT-NB','QT-SA','QT-SB'];
const COURT_IDS      = ['3','4','5','6','7','8'];

/* ---------- tiny DOM helpers ---------- */
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function qs(sel, root = document) { return root.querySelector(sel); }

/* ---------- clock + header ---------- */
function formatHeaderDate(d=new Date()) {
  // e.g., Wednesday • Nov 12, 2025
  const wd = d.toLocaleDateString(undefined, { weekday:'long' });
  const mo = d.toLocaleDateString(undefined, { month:'short' });
  const day= d.getDate();
  const yr = d.getFullYear();
  return `${wd} • ${mo} ${day}, ${yr}`;
}
function formatHeaderClock(d=new Date()) {
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}
function tickHeader() {
  const d = new Date();
  const hdrDate = qs('#headerDate');
  const hdrClock= qs('#headerClock');
  if (hdrDate)  hdrDate.textContent  = formatHeaderDate(d);
  if (hdrClock) hdrClock.textContent = formatHeaderClock(d);
}
setInterval(tickHeader, 1000);
tickHeader();

/* ---------- time helpers ---------- */
function nowMinutes() {
  const d = new Date();
  return d.getHours()*60 + d.getMinutes();
}
function fmtRange(startMin, endMin) {
  return `${minToHHMM(startMin)} – ${minToHHMM(endMin)}`;
}
function minToHHMM(mins) {
  let h = Math.floor(mins/60);
  const m = mins%60;
  const mer = h >= 12 ? 'pm' : 'am';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2,'0')}${mer}`;
}

/* ---------- render one event chip ---------- */
function renderEventCard(slot) {
  const card = el('div', 'event');
  const who = el('div', 'who');
  who.textContent = slot.title || '';
  const what = el('div', 'what');
  what.textContent = slot.subtitle || '';
  const when = el('div', 'when');
  when.textContent = fmtRange(slot.startMin, slot.endMin);

  card.append(who);
  if (slot.subtitle) card.append(what);
  card.append(when);
  return card;
}

/* ---------- single-card rotor (slides only if >1) ---------- */
function startRotor(roomId, slots) {
  const roomSel = `#room-${roomId} .events`;
  const host = qs(roomSel);
  if (!host) return;

  host.innerHTML = '';
  const rotor = el('div', 'single-rotor');
  host.append(rotor);

  if (!slots || slots.length === 0) {
    // nothing to show; leave empty (per your preference)
    const countEl = qs(`#room-${roomId} .roomHeader .count em`);
    if (countEl) countEl.textContent = '0';
    return;
  }

  // show count
  const countEl = qs(`#room-${roomId} .roomHeader .count em`);
  if (countEl) countEl.textContent = String(slots.length);

  // If only one, render it and stop (no animation)
  if (slots.length === 1) {
    const card = renderEventCard(slots[0]);
    rotor.append(card);
    return;
  }

  // Otherwise, animate through them
  let idx = 0;
  let current = renderEventCard(slots[idx]);
  rotor.append(current);

  const SHIFT = 60;           // must match your CSS --shift-ish feel
  const DUR   = 600;          // ms
  const HOLD  = 6000;         // ms on-screen time

  function animateNext() {
    const nextIdx = (idx + 1) % slots.length;
    const next = renderEventCard(slots[nextIdx]);

    // enter from right
    next.style.transition = 'none';
    next.style.transform  = `translateX(${SHIFT}px)`;
    next.style.opacity    = '0';
    rotor.append(next);

    // kick off transitions
    requestAnimationFrame(() => {
      // current slides left out
      current.style.transition = `transform ${DUR}ms cubic-bezier(.22,.61,.36,1), opacity ${DUR}ms cubic-bezier(.22,.61,.36,1)`;
      current.style.transform  = `translateX(${-SHIFT}px)`;
      current.style.opacity    = '0';

      // next slides in
      next.style.transition = `transform ${DUR}ms cubic-bezier(.22,.61,.36,1), opacity ${DUR}ms cubic-bezier(.22,.61,.36,1)`;
      next.style.transform  = 'translateX(0)';
      next.style.opacity    = '1';

      setTimeout(() => {
        // cleanup old
        if (current && current.parentNode === rotor) rotor.removeChild(current);
        current = next;
        idx = nextIdx;
        setTimeout(animateNext, HOLD);
      }, DUR);
    });
  }

  setTimeout(animateNext, HOLD);
}

/* ---------- build fieldhouse container from mode ---------- */
function buildFieldhouse(mode) {
  const container = qs('#fieldhousePager');
  if (!container) return;
  container.innerHTML = '';

  // Middle column grid wrapper (.rooms-fieldhouse)
  const grid = el('div', 'rooms-fieldhouse');

  if (mode === 'turf') {
    // 2×2 quarters: NA, NB, SA, SB (labels are short; IDs are QT-*)
    const defs = [
      { id:'QT-NA', label:'NA' },
      { id:'QT-NB', label:'NB' },
      { id:'QT-SA', label:'SA' },
      { id:'QT-SB', label:'SB' },
    ];
    defs.forEach(({id,label}) => {
      const room = el('div','room');
      room.id = `room-${id}`;
      room.innerHTML = `
        <div class="roomHeader">
          <div class="id">${label}</div>
          <div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"></div>
      `;
      grid.append(room);
    });
  } else {
    // 3×2 courts: 3..8
    COURT_IDS.forEach(id => {
      const room = el('div','room');
      room.id = `room-${id}`;
      room.innerHTML = `
        <div class="roomHeader">
          <div class="id">${id}</div>
          <div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"></div>
      `;
      grid.append(room);
    });
  }

  container.append(grid);
}

/* ---------- fill any fixed room ---------- */
function fillFixedRoom(roomId, allSlots) {
  // Filter to slots for this room, drop past
  const nowMin = nowMinutes();
  const list = (allSlots || [])
    .filter(s => s.roomId === roomId && s.endMin > nowMin)
    .sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);

  startRotor(roomId, list);
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();

    const slots = Array.isArray(data?.slots) ? data.slots : [];
    const mode  = data?.fieldhouseMode || (slots.some(s => /^QT-/.test(s.roomId)) ? 'turf' : 'courts');

    // Build middle column per mode
    buildFieldhouse(mode);

    // Fill fixed rooms
    ROOM_IDS_FIXED.forEach(id => fillFixedRoom(id, slots));

    // Fill fieldhouse (ids depend on mode)
    const midIds = mode === 'turf' ? TURF_IDS : COURT_IDS;
    midIds.forEach(id => fillFixedRoom(id, slots));

    // scale canvas to viewport
    fitStageSetup();
  } catch (err) {
    console.error('app init failed:', err);
  }
}

/* ---------- scale 1920×1080 stage to viewport ---------- */
function fitStageSetup() {
  const W = 1920, H = 1080;
  const vp = qs('.viewport');
  const stage = qs('.stage');
  if (!vp || !stage) return;

  function fit() {
    const sx = vp.clientWidth / W;
    const sy = vp.clientHeight / H;
    const s  = Math.min(sx, sy);
    stage.style.transformOrigin = 'top left';
    stage.style.transform = `scale(${s})`;
    vp.style.minHeight = (H * s) + 'px';
  }
  window.addEventListener('resize', fit, { passive:true });
  window.addEventListener('orientationchange', fit, { passive:true });
  fit();
}

// kick it off
boot();
