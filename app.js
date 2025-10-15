// app.js  (ES module)

// ---------- helpers ----------
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const minsSinceMidnight = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

function hmLabelFromMinutes(min) {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${pad(m)}${ampm}`;
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- fetch & boot ----------
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();

  // sanity
  const roomCount = data?.rooms ? Object.keys(data.rooms).length : 0;
  const slotCount = Array.isArray(data?.slots) ? data.slots.length : 0;
  console.log('Loaded events:', { rooms: roomCount, slots: slotCount });
  return data;
}

// ---------- layout constants from data (with fallbacks) ----------
function getDayBounds(data) {
  const start = safeNumber(data?.dayStartMin, 6 * 60);   // default 06:00
  const end   = safeNumber(data?.dayEndMin, 23 * 60);    // default 23:00
  return { start, end, span: Math.max(1, end - start) };
}

// Fixed room order: 1A..10B (ten rows, two columns)
function getRoomOrder() {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push([`${i}A`, `${i}B`]);
  }
  return rows;
}

// ---------- DOM renders ----------
function renderHeader() {
  const elDate = document.getElementById('headerDate');
  const elClock = document.getElementById('headerClock');

  function tick() {
    const now = new Date();
    // Center date is already centered by CSS; just update text
    const dateStr = now.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    if (elDate) elDate.textContent = dateStr;
    if (elClock) elClock.textContent = timeStr;
    requestAnimationFrame(() => setTimeout(tick, 250)); // smooth-ish updates
  }
  tick();
}

function renderRoomLabels() {
  const container = document.querySelector('.rooms');
  if (!container) return;

  // Clear old rows (keep header)
  container.querySelectorAll('.room').forEach(n => n.remove());

  const order = getRoomOrder();
  order.forEach(([a, b]) => {
    const row = document.createElement('div');
    row.className = 'room';
    const cellA = document.createElement('div'); cellA.textContent = a;
    const cellB = document.createElement('div'); cellB.textContent = b;
    row.appendChild(cellA);
    row.appendChild(cellB);
    container.appendChild(row);
  });
}

function renderHoursHeader(bounds, stepMinutes = 60) {
  const rowEl = document.getElementById('hoursRow');
  if (!rowEl) return;

  // Build hour stops
  const cols = [];
  for (let t = bounds.start; t <= bounds.end; t += stepMinutes) cols.push(t);

  // CSS grid columns for the header row: one per hour label cell
  rowEl.style.display = 'grid';
  rowEl.style.gridTemplateColumns = `repeat(${cols.length - 1}, 1fr)`;

  // Fill labels centered at each hour boundary (except the final end tick)
  rowEl.innerHTML = '';
  for (let i = 0; i < cols.length - 1; i++) {
    const c = document.createElement('div');
    c.textContent = hmLabelFromMinutes(cols[i]);
    rowEl.appendChild(c);
  }

  // Also expose a CSS var for body columns (~ 1 column per 15 minutes for smooth chips)
  const grid = document.getElementById('gridBackdrop');
  if (grid) {
    const colsPerHour = 4; // 15-minute resolution
    const totalCols = (cols.length - 1) * colsPerHour;
    grid.style.setProperty('--cols', `repeat(${totalCols}, 1fr)`);
  }
}

function renderGridBackdrop() {
  const backdrop = document.getElementById('gridBackdrop');
  if (!backdrop) return;

  // Build empty cells to draw the lines with CSS borders
  // 10 rows × N time columns (set via --cols)
  backdrop.innerHTML = '';
  // We can approximate with 10 rows * 80 cells (4 cols/hour * ~20 hours max).
  // The exact column count comes from CSS var, so we only need enough elements to cover flow.
  const totalCells = 10 * 80;
  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    backdrop.appendChild(cell);
  }
}

function renderNowLine(bounds) {
  const el = document.getElementById('nowLine');
  if (!el) return;

  function positionNow() {
    const nowMin = minsSinceMidnight();
    if (nowMin < bounds.start || nowMin > bounds.end) {
      el.hidden = true;
      requestAnimationFrame(() => setTimeout(positionNow, 30000)); // check less often when out of range
      return;
    }
    el.hidden = false;
    const pct = ((nowMin - bounds.start) / bounds.span) * 100;
    el.style.left = `${pct}%`;
    requestAnimationFrame(() => setTimeout(positionNow, 1000));
  }
  positionNow();
}

function renderSlots(data, bounds) {
  const lanes = document.getElementById('lanes');
  if (!lanes) return;

  // Ensure 10 rows for room lanes
  lanes.style.gridTemplateRows = `repeat(10, 1fr)`;
  lanes.innerHTML = '';

  const nowMin = minsSinceMidnight();
  const order = getRoomOrder(); // [[1A,1B], [2A,2B], ...]
  const rowIndexByRoom = new Map();
  order.forEach(([a, b], rowIdx) => {
    rowIndexByRoom.set(a, rowIdx);
    rowIndexByRoom.set(b, rowIdx);
  });

  const slots = Array.isArray(data?.slots) ? data.slots : [];

  // Hide events fully in the past
  const upcoming = slots.filter(s => safeNumber(s.endMin, 0) > nowMin);

  for (const s of upcoming) {
    const roomId = s.roomId;
    const rowIdx = rowIndexByRoom.get(roomId);
    if (rowIdx === undefined) continue;

    const start = Math.max(bounds.start, safeNumber(s.startMin, bounds.start));
    const end   = Math.min(bounds.end,   safeNumber(s.endMin, bounds.end));
    if (end <= start) continue;

    const leftPct  = ((start - bounds.start) / bounds.span) * 100;
    const widthPct = ((end - start) / bounds.span) * 100;

    // Place chip
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.top = `calc(${rowIdx} * (100% / 10))`;
    chip.style.height = `calc(100% / 10)`;
    chip.style.left = `${leftPct}%`;
    chip.style.width = `${widthPct}%`;

    const title = s.title || s.reservee || '';
    const sub   = s.sub || s.reservationpurpose || '';
    const time  = `${hmLabelFromMinutes(start)}–${hmLabelFromMinutes(end)}`;

    chip.innerHTML = `<strong>${title}</strong><small>${time}${sub ? ' • ' + sub : ''}</small>`;
    lanes.appendChild(chip);
  }
}

// ---------- init ----------
async function init() {
  try {
    const data = await loadData();
    const bounds = getDayBounds(data);

    // header (date + clock)
    renderHeader();

    // left labels
    renderRoomLabels();

    // timeline header hours + backdrop grid
    renderHoursHeader(bounds, 60);
    renderGridBackdrop();

    // "now" line
    renderNowLine(bounds);

    // events
    renderSlots(data, bounds);
  } catch (err) {
    console.error('Init failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
