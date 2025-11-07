// app.js — dynamic Fieldhouse (2×2 turf vs 2×3 court) + robust per-room rotor + debug

// ---------- small utils ----------
const CLOCK_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE_FMT  = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
function pad(n){ return n<10 ? '0'+n : ''+n; }
function minutesToLabel(min){
  let h = Math.floor(min/60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${pad(m)} ${ampm}`;
}

function setHeaderClock(){
  const now = new Date();
  const d = document.getElementById('headerDate');
  const c = document.getElementById('headerClock');
  if (d) d.textContent = DATE_FMT.format(now);
  if (c) c.textContent = CLOCK_FMT.format(now);
}
setHeaderClock();
setInterval(setHeaderClock, 1000);

async function loadData(){
  const res = await fetch(`./events.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch events.json: ${res.status}`);
  return res.json();
}

// ---------- build Fieldhouse grid (2×2 turf, 2×3 court) ----------
function buildFieldhouse(rooms){
  const container = document.getElementById('fieldhousePager');
  if (!container) return;

  // reset
  container.innerHTML = '';

  const fh = rooms.filter(r => r.group === 'fieldhouse');
  const count = fh.length;

  // grid: 4 => 2×2 ; 6 => 2×3
  let cols = 3, rows = 2;
  if (count === 4) { cols = 2; rows = 2; }

  // apply layout inline (keeps your CSS simple)
  container.style.display = 'grid';
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;
  container.style.gap = '12px';
  container.style.minHeight = '0';

  fh.forEach(room => {
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
  });
}

// ---------- per-room helpers ----------
function ensureRotorBox(roomId){
  const rotor = document.querySelector(`#room-${CSS.escape(roomId)} .single-rotor`);
  if (!rotor) return null;

  // Make absolutely sure this box has paintable height so cards don’t collapse
  const ev = rotor.parentElement; // .events
  if (ev) {
    ev.style.position = 'relative';
    ev.style.flex = '1 1 auto';
    ev.style.minHeight = '0';
    ev.style.height = '100%';
    ev.style.overflow = 'hidden';
  }
  rotor.style.position = 'relative';
  rotor.style.height   = '100%';
  rotor.style.minHeight = '0';
  return rotor;
}

function setCount(roomId, n){
  const el = document.querySelector(`#room-${CSS.escape(roomId)} .roomHeader .count em`);
  if (el) el.textContent = String(n);
}

function mountEventCard(roomId, slot){
  const rotor = ensureRotorBox(roomId);
  if (!rotor) return null;
  const div = document.createElement('div');
  div.className = 'event';
  div.style.position = 'absolute';
  div.style.inset = '0';
  div.style.opacity = '0';
  div.style.transform = 'translateX(0)';
  div.innerHTML = `
    <div class="who">${slot.title ?? ''}</div>
    ${slot.subtitle ? `<div class="what">${slot.subtitle}</div>` : ''}
    <div class="when">${minutesToLabel(slot.startMin)} – ${minutesToLabel(slot.endMin)}</div>
  `;
  rotor.appendChild(div);
  return div;
}

function animateSwap(prev, next, shift=60, dur=700){
  if (next) {
    next.style.transition = `opacity ${dur}ms cubic-bezier(.22,.61,.36,1), transform ${dur}ms cubic-bezier(.22,.61,.36,1)`;
    next.style.opacity = '0';
    next.style.transform = `translateX(${shift}px)`;
    void next.offsetWidth; // reflow
  }
  if (prev) {
    prev.style.transition = `opacity ${dur}ms cubic-bezier(.22,.61,.36,1), transform ${dur}ms cubic-bezier(.22,.61,.36,1)`;
    prev.style.opacity = '1';
    prev.style.transform = 'translateX(0)';
    void prev.offsetWidth;
    requestAnimationFrame(() => {
      prev.style.opacity = '0';
      prev.style.transform = `translateX(${-shift}px)`;
    });
  }
  if (next) {
    requestAnimationFrame(() => {
      next.style.opacity = '1';
      next.style.transform = `translateX(0)`;
    });
  }
}

function startRoomRotor(roomId, slots, periodMs=6000){
  // Always set the count (even if 0)
  setCount(roomId, slots.length);

  if (!slots.length) {
    // no cards; leave the room visually empty (as requested)
    return;
  }

  // Mount the first card right away
  let idx = 0;
  let current = mountEventCard(roomId, slots[idx]);
  if (!current) return;
  // Make the first card visible immediately (no flicker)
  current.style.opacity = '1';
  current.style.transform = 'translateX(0)';

  const tick = () => {
    const prev = current;
    idx = (idx + 1) % slots.length;
    const next = mountEventCard(roomId, slots[idx]);
    if (!next) return;
    animateSwap(prev, next, 60, 700);
    setTimeout(() => {
      if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
      current = next;
    }, 720);
  };

  // cycle
  setInterval(tick, periodMs);
}

// ---------- orchestrate ----------
function distributeAndRender(data){
  // Build Fieldhouse grid fresh (handles turf 2×2 vs court 2×3)
  buildFieldhouse(data.rooms);

  // Bucket slots by room
  const byRoom = new Map();
  for (const s of (data.slots || [])) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }
  for (const [rid, arr] of byRoom) arr.sort((a,b) => a.startMin - b.startMin);

  // List of rooms we have in the DOM
  const ids = [
    // south
    '1A','1B','2A','2B',
    // fieldhouse (whatever the backend decided: 3–8 OR QSA/QNA/QSB/QNB)
    ...data.rooms.filter(r => r.group === 'fieldhouse').map(r => r.id),
    // north
    '9A','9B','10A','10B'
  ];

  // Debug summary so we know what the frontend received
  let totalSlots = 0;
  ids.forEach(id => totalSlots += (byRoom.get(id)?.length || 0));
  console.log(`Loaded rooms=${data.rooms.length} • slots=${(data.slots||[]).length} • visibleRoomSlots=${totalSlots}`);
  ids.forEach(id => console.log(`room ${id}: ${byRoom.get(id)?.length || 0} slots`));

  // Start rotors
  ids.forEach(id => startRoomRotor(id, byRoom.get(id) || []));
}

// ---------- boot ----------
(async function init(){
  try {
    const data = await loadData();
    distributeAndRender(data);
  } catch (e) {
    console.error('init failed:', e);
  }
})();

// ---------- scale-to-fit (unchanged) ----------
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
