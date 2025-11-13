// app.js — drop-in

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

// ---------- Utilities ----------
function pad(n) { return (n < 10 ? '0' : '') + n; }

function minutesNowLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function parseTimeToMinutes(hhmm) {
  // "h:mmam" OR "h:mmpm" already parsed in transform; here we get startMin/endMin as numbers
  return hhmm;
}

function formatRange(startMin, endMin) {
  const fmt = (m) => {
    const h24 = Math.floor(m / 60);
    const h12 = ((h24 + 11) % 12) + 1;
    const mm = m % 60;
    const ampm = h24 >= 12 ? 'pm' : 'am';
    return `${h12}:${pad(mm)}${ampm}`;
  };
  return `${fmt(startMin)}–${fmt(endMin)}`;
}

function isTodaySlot(slot) {
  // transform.mjs gives minutes; assume all are for "today"
  return true;
}

function isPickleball(slot) {
  const title = (slot.title || '').toLowerCase();
  const sub = (slot.subtitle || '').toLowerCase();
  return title.includes('pickleball') || sub.includes('pickleball');
}

// ---------- DOM helpers ----------
function qs(sel, root=document) { return root.querySelector(sel); }
function qsa(sel, root=document) { return Array.from(root.querySelectorAll(sel)); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// Scale the fixed 1920×1080 canvas to available viewport
(function fitStageSetup(){
  function fit() {
    const vp = qs('.viewport');
    const stage = qs('.stage');
    if (!vp || !stage) return;
    const sx = vp.clientWidth / STAGE_WIDTH;
    const sy = vp.clientHeight / STAGE_HEIGHT;
    const s  = Math.min(sx, sy);
    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = 'top left';
    vp.style.minHeight = (STAGE_HEIGHT * s) + 'px';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  document.addEventListener('DOMContentLoaded', fit);
})();

// Header clock/date
function startHeaderClock() {
  const dEl = qs('#headerDate');
  const cEl = qs('#headerClock');
  function tick() {
    const d = new Date();
    const dateFmt = d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
    const timeFmt = d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
    if (dEl) dEl.textContent = dateFmt;
    if (cEl) cEl.textContent = timeFmt;
  }
  tick();
  setInterval(tick, 1000 * 30);
}

// ---------- Rotor (per-room event slider) ----------
function mountEventChip(slot) {
  const chip = el('div', 'event');
  const who = el('div', 'who', slot.title || '');
  const whatParts = [];
  if (slot.subtitle) whatParts.push(slot.subtitle);
  const when = formatRange(slot.startMin, slot.endMin);
  const whenEl = el('div', 'when', when);
  const what = el('div', 'what', whatParts.join(' • '));
  chip.appendChild(who);
  if (what.textContent.trim().length > 0) chip.appendChild(what);
  chip.appendChild(whenEl);
  return chip;
}

/**
 * Creates a rotor in container for a list of slots:
 * - 0 slots: leaves empty
 * - 1 slot: renders static, no interval
 * - >=2: rotates with smooth slide left
 */
function startRotor(container, slots, periodMs=8000) {
  container.innerHTML = '';
  if (!slots || slots.length === 0) return;

  let idx = 0;
  let current = mountEventChip(slots[idx]);
  container.appendChild(current);

  if (slots.length === 1) return; // static, no timer

  let timer = null;
  function step() {
    const nextIdx = (idx + 1) % slots.length;
    const next = mountEventChip(slots[nextIdx]);

    // enter state for next
    next.classList.add('is-enter');
    container.appendChild(next);

    // trigger reflow then animate both
    requestAnimationFrame(() => {
      // current exits -> slide left
      current.classList.add('is-exit');
      requestAnimationFrame(() => {
        current.classList.add('is-exit-active');
        // next enters -> move from right to 0
        next.classList.remove('is-enter');
      });
    });

    // when current finishes, remove it
    const onEnd = () => {
      current.removeEventListener('transitionend', onEnd);
      if (current.parentNode === container) container.removeChild(current);
      current = next;
      idx = nextIdx;
      // schedule next tick
      timer = setTimeout(step, periodMs);
    };
    current.addEventListener('transitionend', onEnd, { once:true });
  }

  timer = setTimeout(step, periodMs);

  // return an unmount function in case we ever need to clear
  return () => { if (timer) clearTimeout(timer); };
}

// ---------- Build UI ----------
const FIXED_ROOMS = ['1A','1B','2A','2B','9A','9B','10A','10B'];

// Decide Turf vs Courts (basketball) for fieldhouse
function getFieldhouseMode(data, slots) {
  // 1) Trust the backend: events.json has season from CSV
  if (data && data.season === 'turf') return 'turf';
  if (data && (data.season === 'courts' || data.season === 'basketball')) return 'courts';

  // 2) Fallback heuristic (in case season is missing):
  const ids = new Set(slots.map(s => s.roomId));
  // Turf quarters as emitted by transform.mjs
  const hasQuarterTurf = [
    'Quarter Turf NA', 'Quarter Turf NB',
    'Quarter Turf SA', 'Quarter Turf SB'
  ].some(id => ids.has(id));

  if (hasQuarterTurf) return 'turf';

  const hasCourts = ['3','4','5','6','7','8'].some(id => ids.has(id));
  if (hasCourts) return 'courts';

  // Default: assume courts
  return 'courts';
}

function buildFieldhouseContainer(isTurf) {
  const holder = qs('#fieldhousePager');
  if (!holder) return;

  // set grid mode class on the container so CSS lays it out correctly
  holder.classList.remove('turf-2x2', 'courts-3x2');
  holder.classList.add(isTurf ? 'turf-2x2' : 'courts-3x2');

  // clear previous children
  holder.innerHTML = '';

  if (isTurf) {
    // NA | NB / SA | SB (2x2)
    const order = ['NA','NB','SA','SB'];
    for (const id of order) {
      const room = el('div', 'room');
      room.id = `room-${id}`;
      room.innerHTML = `
        <div class="roomHeader">
          <div class="id">${id}</div><div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"></div>`;
      holder.appendChild(room);
    }
  } else {
    // Courts 3..8 (3×2)
    const order = ['3','4','5','6','7','8'];
    for (const id of order) {
      const room = el('div', 'room');
      room.id = `room-${id}`;
      room.innerHTML = `
        <div class="roomHeader">
          <div class="id">${id}</div><div class="count">reservations: <em>—</em></div>
        </div>
        <div class="events"></div>`;
      holder.appendChild(room);
    }
  }
}

function fillFixedRoom(roomId, roomSlots) {
  const card = qs(`#room-${roomId}`);
  if (!card) return;
  const countEl = qs('.roomHeader .count em', card);
  const eventsEl = qs('.events', card);
  if (countEl) countEl.textContent = roomSlots.length;
  if (!eventsEl) return;

  // Rotor mounts into this events area
  startRotor(eventsEl, roomSlots);
}

// ---------- Data prep ----------
function groupByRoom(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  // sort each room by start time then title
  for (const [k, arr] of map) {
    arr.sort((a,b) => (a.startMin - b.startMin) || a.title.localeCompare(b.title));
  }
  return map;
}

function filterForDisplay(slots) {
  // 1) keep only today (transform already does)
  // 2) hide past events (endMin <= now)
  const nowMin = minutesNowLocal();
  let filtered = slots.filter(s => s.endMin > nowMin);

  // 3) hide Open Pickleball after 12:30pm
  const cutoff = 12*60 + 30;
  if (nowMin > cutoff) {
    filtered = filtered.filter(s => !isPickleball(s));
  }
  return filtered;
}

// ---------- Boot ----------
async function boot() {
  startHeaderClock();

  // cache-buster (stop GitHub Pages caching)
  const res = await fetch(`./events.json?cb=${Date.now()}`, { cache: 'no-store' });
  const data = await res.json();

  const allSlots = Array.isArray(data?.slots) ? data.slots : [];
  // console diagnostic
  const byRoomPreview = allSlots.reduce((acc, s) => {
    acc[s.roomId] = (acc[s.roomId] || 0) + 1;
    return acc;
  }, {});
  console.log('events.json loaded:', {totalSlots: allSlots.length, byRoom: byRoomPreview});

  const displaySlots = filterForDisplay(allSlots);

  // Build middle grid per season
  const isTurf = detectTurfMode(displaySlots);
  buildFieldhouseContainer(isTurf);

  // Make sure fixed south/north rooms exist in DOM (they do in your HTML)
  // Fill south/north
  const grouped = groupByRoom(displaySlots);

  // South/North fixed rooms
  for (const id of FIXED_ROOMS) {
    fillFixedRoom(id, grouped.get(id) || []);
  }

  // Fieldhouse rooms depending on season
  const fhIds = isTurf ? ['NA','NB','SA','SB'] : ['3','4','5','6','7','8'];
  for (const id of fhIds) {
    fillFixedRoom(id, grouped.get(id) || []);
  }
}

boot().catch(err => {
  console.error('app init failed:', err);
});
