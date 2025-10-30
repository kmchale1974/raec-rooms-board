// app.js
// Renders RAEC board (A/B courts + fieldhouse) with synced, smooth slide-left carousel (8s)

const TICK_MS = 1000;
const SLIDE_MS = 600;          // CSS-like transition timing (ms)
const ROTATE_MS = 8000;        // time per slide
const NOW_PAD = 0;             // no pad; events fall off exactly at end

const STATE = {
  data: null,
  perRoom: new Map(),   // roomId -> { list:[], idx:0, nextAt:ts }
  timer: null
};

// 12h display
function fmtMinTo12h(m) {
  let h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${mm}${ap}`;
}

function fmtRange(a, b) {
  return `${fmtMinTo12h(a)} - ${fmtMinTo12h(b)}`;
}

// Fetch JSON (no cache)
async function loadEvents() {
  const resp = await fetch(`./events.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// Grouping helpers for layout
function buildLayout(data) {
  const south = ['1A','1B','2A','2B'];
  const north = ['9A','9B','10A','10B'];
  const field = ['3','4','5','6','7','8'];
  return { south, north, field };
}

// Build DOM cards (uses containers from index.html)
function renderSkeleton(layout) {
  const southEl = document.getElementById('southRooms');
  const northEl = document.getElementById('northRooms');
  const fieldEl = document.getElementById('fieldhouseRooms');

  southEl.innerHTML = '';
  northEl.innerHTML = '';
  fieldEl.innerHTML = '';

  // helpers
  const mkRoom = (id) => {
    const wrap = document.createElement('div');
    wrap.className = 'room';
    wrap.dataset.room = id;

    const header = document.createElement('div');
    header.className = 'roomHeader';
    const idEl = document.createElement('div');
    idEl.className = 'id';
    idEl.textContent = id;
    const countEl = document.createElement('div');
    countEl.className = 'count';
    countEl.textContent = 'reservations';
    header.appendChild(idEl);
    header.appendChild(countEl);

    const viewport = document.createElement('div');
    viewport.className = 'viewport'; // sliding container
    const slide = document.createElement('div');
    slide.className = 'slide';
    viewport.appendChild(slide);

    wrap.appendChild(header);
    wrap.appendChild(viewport);
    return wrap;
  };

  // south (stacked 1A 1B / 2A 2B)
  const sRows = [
    ['1A','1B'],
    ['2A','2B']
  ];
  sRows.forEach(row => {
    const rowWrap = document.createElement('div');
    rowWrap.className = 'row2';
    row.forEach(r => rowWrap.appendChild(mkRoom(r)));
    southEl.appendChild(rowWrap);
  });

  // fieldhouse 3x2 grid (3..8)
  layout.field.forEach(r => fieldEl.appendChild(mkRoom(r)));

  // north (stacked 9A 9B / 10A 10B)
  const nRows = [
    ['9A','9B'],
    ['10A','10B']
  ];
  nRows.forEach(row => {
    const rowWrap = document.createElement('div');
    rowWrap.className = 'row2';
    row.forEach(r => rowWrap.appendChild(mkRoom(r)));
    northEl.appendChild(rowWrap);
  });
}

// Build room lists & counters
function populateRooms(data) {
  // index slots per room, filter by time (now < end)
  const now = timeNowMin();
  const active = data.slots.filter(s => (s.endMin - NOW_PAD) > now);

  // Sort by start time then title
  active.sort((a,b) => (a.startMin - b.startMin) || a.title.localeCompare(b.title));

  const map = new Map();
  for (const s of active) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }

  // write counts and initialize per-room state
  document.querySelectorAll('.room').forEach(roomEl => {
    const id = roomEl.dataset.room;
    const list = map.get(id) || [];
    const cntEl = roomEl.querySelector('.count');
    cntEl.textContent = `${list.length} reservation${list.length===1?'':'s'}`;

    STATE.perRoom.set(id, { list, idx: 0, nextAt: performance.now() + ROTATE_MS });
    // Immediate first render
    renderRoomSlide(roomEl, list[0] || null, /*instant*/ true);
  });
}

function renderRoomSlide(roomEl, slot, instant=false) {
  const slide = roomEl.querySelector('.slide');
  if (!slide) return;
  // Build content
  const html = slot ? buildCardHtml(slot) : `<div class="event empty"><div class="when">—</div></div>`;
  // For slide-left animation, create a temp element and animate with transform
  if (instant) {
    slide.innerHTML = html;
    slide.style.transition = 'none';
    slide.style.transform = 'translateX(0)';
    // force reflow
    void slide.offsetWidth;
    return;
  }

  // animate: current -> left, new -> from right to center
  const old = slide.cloneNode(true);
  old.classList.add('leaving');
  slide.parentNode.appendChild(old);

  slide.innerHTML = html;
  slide.style.transition = 'none';
  slide.style.transform = 'translateX(100%)';
  void slide.offsetWidth;

  // start transitions
  old.style.transition = `transform ${SLIDE_MS}ms ease, opacity ${SLIDE_MS}ms ease`;
  old.style.transform  = 'translateX(-100%)';
  old.style.opacity    = '0';

  slide.style.transition = `transform ${SLIDE_MS}ms ease`;
  slide.style.transform  = 'translateX(0)';

  // cleanup
  setTimeout(() => {
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }, SLIDE_MS + 50);
}

function buildCardHtml(slot) {
  // Title / subtitle already normalized by transform
  const title = escapeHtml(slot.title || 'Reservation');
  let subtitle = escapeHtml(slot.subtitle || '');
  // small clean for possible trailing ')'
  subtitle = subtitle.replace(/\)+$/, '');

  const when = fmtRange(slot.startMin, slot.endMin);
  return `
    <div class="event">
      <div class="who">${title}</div>
      ${subtitle ? `<div class="what">${subtitle}</div>` : ``}
      <div class="when">${when}</div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function timeNowMin() {
  const d = new Date();
  return d.getHours()*60 + d.getMinutes();
}

// Clock/date + wifi (already on page)
function updateClock() {
  const d = new Date();
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  if (dateEl) dateEl.textContent = d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});
  if (clockEl) {
    let h = d.getHours(), m = String(d.getMinutes()).padStart(2,'0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h===0) h = 12;
    clockEl.textContent = `${h}:${m} ${ap}`;
  }
}

// Main tick: rotate each room in sync every ROTATE_MS
function startTicker() {
  if (STATE.timer) clearInterval(STATE.timer);
  const step = () => {
    const now = performance.now();
    document.querySelectorAll('.room').forEach(roomEl => {
      const id = roomEl.dataset.room;
      const st = STATE.perRoom.get(id);
      if (!st) return;

      // If list shrank (events fell off), keep idx in range
      if (st.list.length === 0) {
        renderRoomSlide(roomEl, null, true);
        return;
      }
      st.idx = st.idx % st.list.length;

      if (now >= st.nextAt) {
        st.idx = (st.idx + 1) % st.list.length;
        st.nextAt = now + ROTATE_MS;
        renderRoomSlide(roomEl, st.list[st.idx], /*instant*/ false);
      }
    });
    updateClock();
  };
  STATE.timer = setInterval(step, TICK_MS);
  step();
}

// Init
async function init() {
  try {
    const data = await loadEvents();
    STATE.data = data;

    // Build layout & skeleton
    const layout = buildLayout(data);
    renderSkeleton(layout);
    populateRooms(data);

    // Kick ticker
    startTicker();
  } catch (e) {
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', init);
