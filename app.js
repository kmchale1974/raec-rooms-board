// app.js — dynamic Fieldhouse layout (2×2 turf vs 2×3 court) + per-room rotor

const CLOCK_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit'
});
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'long', day: 'numeric'
});

function pad(n){ return n < 10 ? '0'+n : ''+n; }
function minutesToLabel(min) {
  let h = Math.floor(min/60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${pad(m)} ${ampm}`;
}

function setHeaderClock() {
  const now = new Date();
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (dateEl) dateEl.textContent = DATE_FMT.format(now);
  if (clockEl) clockEl.textContent = CLOCK_FMT.format(now);
}
setHeaderClock();
setInterval(setHeaderClock, 1000);

// ---- Fetch data (cache-busted) ----
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch events.json: ${res.status}`);
  return res.json();
}

// ---- Fieldhouse grid builder ----
function buildFieldhouse(rooms) {
  const container = document.getElementById('fieldhousePager');
  if (!container) return;

  // Clear any old children (including old fixed layout)
  container.innerHTML = '';

  const fhRooms = rooms.filter(r => r.group === 'fieldhouse');

  // Decide grid: 4 → 2×2, 6 → 2×3
  const count = fhRooms.length;
  let cols = 3, rows = 2;
  if (count === 4) { cols = 2; rows = 2; }

  container.style.display = 'grid';
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  container.style.gap = '12px';
  container.style.minHeight = '0';

  // Create a room card for each FH room
  for (const room of fhRooms) {
    const card = document.createElement('div');
    card.className = 'room';
    card.id = `room-${room.id}`;

    card.innerHTML = `
      <div class="roomHeader">
        <div class="id">${room.label}</div>
        <div class="count">reservations: <em>—</em></div>
      </div>
      <div class="events">
        <div class="single-rotor"></div>
      </div>
    `;
    container.appendChild(card);
  }
}

// ---- Room helpers ----
function setCount(roomId, n) {
  const el = document.querySelector(`#room-${CSS.escape(roomId)} .roomHeader .count em`);
  if (el) el.textContent = String(n);
}

function mountEventCard(roomId, slot) {
  const rotor = document.querySelector(`#room-${CSS.escape(roomId)} .single-rotor`);
  if (!rotor) return null;
  const div = document.createElement('div');
  div.className = 'event';
  div.innerHTML = `
    <div class="who">${slot.title ?? ''}</div>
    ${slot.subtitle ? `<div class="what">${slot.subtitle}</div>` : ''}
    <div class="when">${minutesToLabel(slot.startMin)} – ${minutesToLabel(slot.endMin)}</div>
  `;
  rotor.appendChild(div);
  return div;
}

// Slide/fade one card out, next in
function animateSwap(currentEl, nextEl, shift = 60, dur = 700) {
  if (nextEl) {
    nextEl.style.transition = `opacity ${dur}ms cubic-bezier(.22,.61,.36,1), transform ${dur}ms cubic-bezier(.22,.61,.36,1)`;
    nextEl.style.opacity = '0';
    nextEl.style.transform = `translateX(${shift}px)`;
    // force reflow
    void nextEl.offsetWidth;
  }
  if (currentEl) {
    currentEl.style.transition = `opacity ${dur}ms cubic-bezier(.22,.61,.36,1), transform ${dur}ms cubic-bezier(.22,.61,.36,1)`;
    currentEl.style.opacity = '1';
    currentEl.style.transform = 'translateX(0)';
    // force reflow
    void currentEl.offsetWidth;
    // animate out
    requestAnimationFrame(() => {
      currentEl.style.opacity = '0';
      currentEl.style.transform = `translateX(${-shift}px)`;
    });
  }
  if (nextEl) {
    requestAnimationFrame(() => {
      nextEl.style.opacity = '1';
      nextEl.style.transform = 'translateX(0)';
    });
  }
}

// Setup per-room rotor (one event visible at a time)
function startRoomRotor(roomId, slots, periodMs = 6000) {
  if (!slots || slots.length === 0) {
    setCount(roomId, 0);
    return;
  }
  setCount(roomId, slots.length);

  // Mount the first
  let idx = 0;
  let current = mountEventCard(roomId, slots[idx]);

  const rotor = document.querySelector(`#room-${CSS.escape(roomId)} .single-rotor`);
  rotor.style.position = 'relative';
  rotor.style.height = '100%';

  current.style.position = 'absolute';
  current.style.inset = '0';

  const tick = () => {
    const prev = current;
    idx = (idx + 1) % slots.length;

    const next = mountEventCard(roomId, slots[idx]);
    next.style.position = 'absolute';
    next.style.inset = '0';

    animateSwap(prev, next, 60, 700);

    // cleanup old after animation
    setTimeout(() => {
      if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
      current = next;
    }, 720);
  };

  // start cycling
  setInterval(tick, periodMs);
}

// Push slots into appropriate room buckets and start rotors
function distributeAndRender(data) {
  // 1) Fieldhouse: rebuild grid every time (handles turf vs court)
  buildFieldhouse(data.rooms);

  // 2) Collect slots per room
  const byRoom = new Map();
  for (const s of data.slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  for (const [rid, arr] of byRoom) {
    arr.sort((a,b)=> a.startMin - b.startMin);
  }

  // 3) Known room IDs we have in the DOM:
  const allIds = [
    '1A','1B','2A','2B',
    ...data.rooms.filter(r => r.group === 'fieldhouse').map(r => r.id),
    '9A','9B','10A','10B'
  ];

  // 4) Start a rotor for each room that has slots
  for (const id of allIds) {
    const slots = byRoom.get(id) || [];
    startRoomRotor(id, slots);
  }
}

// Boot
(async function init(){
  try {
    const data = await loadData();
    distributeAndRender(data);
  } catch (err) {
    console.error('Failed to init app:', err);
  }
})();

// --- Scale-to-fit (unchanged) ---
(function fitStageSetup(){
  const W = 1920, H = 1080;
  function fit() {
    const vp = document.querySelector('.viewport');
    const stage = document.querySelector('.stage');
    if (!vp || !stage) return;
    const sx = vp.clientWidth / W;
    const sy = vp.clientHeight / H;
    const s  = Math.min(sx, sy);
    stage.style.transform = `scale(${s})`;
    stage.style.transformOrigin = 'top left';
    vp.style.minHeight = (H * s) + 'px';
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  document.addEventListener('DOMContentLoaded', fit);
})();
