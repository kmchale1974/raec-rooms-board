// app.js — robust rotors (no loop on single), room-id normalization, AB splitting, 2×2 Turf vs 2×3 Court layout

// ----- time formatters -----
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

// ----- fetch data -----
async function loadData(){
  const res = await fetch(`./events.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch events.json: ${res.status}`);
  return res.json();
}

// ----- Fieldhouse grid builder (2×2 turf when 4 rooms, 2×3 court when 6 rooms) -----
function buildFieldhouse(rooms){
  const container = document.getElementById('fieldhousePager');
  if (!container) return;

  container.innerHTML = '';

  const fh = rooms.filter(r => r.group === 'fieldhouse');
  const count = fh.length;

  let cols = 3, rows = 2;      // default 2×3 (courts 3..8)
  if (count === 4) { cols = 2; rows = 2; } // 2×2 (turf quarters)

  // inline layout so we don’t rely on stale CSS
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
      <div class="events"><div class="single-rotor"></div></div>
    `;
    container.appendChild(card);
  });
}

// ----- room utilities -----
function normalizeId(id){
  return String(id || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');   // strip spaces/dashes like "10-AB" -> "10AB"
}

function expandAB(id){
  // If transform ever emits AB, show on both halves.
  switch (id) {
    case '1AB':  return ['1A','1B'];
    case '2AB':  return ['2A','2B'];
    case '9AB':  return ['9A','9B'];
    case '10AB': return ['10A','10B'];
    default: return [id];
  }
}

function ensureRotorBox(roomId){
  const rotor = document.querySelector(`#room-${CSS.escape(roomId)} .single-rotor`);
  if (!rotor) return null;
  const ev = rotor.parentElement; // .events shell
  if (ev) {
    ev.style.position  = 'relative';
    ev.style.flex      = '1 1 auto';
    ev.style.minHeight = '0';
    ev.style.height    = '100%';
    ev.style.overflow  = 'hidden';
  }
  rotor.style.position  = 'relative';
  rotor.style.height    = '100%';
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
    void next.offsetWidth;
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
  // always show count for visibility
  setCount(roomId, slots.length);

  if (!slots.length) return;      // empty room = no box text (your preference)

  // If only ONE slot: mount and **do not** start interval (fixes your “slide forever”)
  if (slots.length === 1) {
    const card = mountEventCard(roomId, slots[0]);
    if (card) {
      card.style.opacity = '1';
      card.style.transform = 'translateX(0)';
    }
    return;
  }

  // 2+ slots: normal rotor
  let idx = 0;
  let current = mountEventCard(roomId, slots[idx]);
  if (!current) return;
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
  setInterval(tick, periodMs);
}

// ----- orchestrate -----
function distributeAndRender(data){
  // Build dynamic fieldhouse (2×2 for turf quarters, 2×3 for courts 3..8)
  buildFieldhouse(data.rooms);

  // Bucket slots by room with normalization + AB expansion
  const byRoom = new Map();
  for (const s of (data.slots || [])) {
    const raw = normalizeId(s.roomId);
    const targets = expandAB(raw);
    targets.forEach(t => {
      if (!byRoom.has(t)) byRoom.set(t, []);
      byRoom.get(t).push(s);
    });
  }
  // sort each room’s slots by time
  for (const [rid, arr] of byRoom) arr.sort((a,b) => a.startMin - b.startMin);

  // Render list (DOM rooms we expect to exist)
  const fieldhouseIds = data.rooms.filter(r => r.group === 'fieldhouse').map(r => r.id).map(normalizeId);
  const roomIds = [
    '1A','1B','2A','2B',
    ...fieldhouseIds,
    '9A','9B','10A','10B'
  ].map(normalizeId);

  // Debug: counts
  let visible = 0;
  roomIds.forEach(id => visible += (byRoom.get(id)?.length || 0));
  console.log(`Loaded rooms=${data.rooms.length} • slots=${(data.slots||[]).length} • visibleRoomSlots=${visible}`);
  roomIds.forEach(id => console.log(`room ${id}: ${byRoom.get(id)?.length || 0} slots`));

  // Spin rotors
  roomIds.forEach(id => startRoomRotor(id, byRoom.get(id) || []));
}

// ----- boot -----
(async function init(){
  try {
    const data = await loadData();
    distributeAndRender(data);
  } catch (e) {
    console.error('init failed:', e);
  }
})();

// ----- scale-to-fit (unchanged) -----
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
