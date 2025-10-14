// app.js — dark theme, grid is blank if no events, uses startMin/endMin directly.

const BUILDING = { openMin: 6*60, closeMin: 22*60 }; // 06:00–22:00

const ROOMS_ORDER = [
  '1A','1B','2A','2B','3A','3B','4A','4B','5A','5B',
  '6A','6B','7A','7B','8A','8B','9A','9B','10A','10B',
];

// layout constants tuned for 1920x1080
const TIMELINE_LEFT_PX = 210;        // left gutter for room labels
const TIMELINE_RIGHT_PX = 40;        // right padding
const ROW_HEIGHT_PX = 48;            // per room
const GRID_TOP_PX = 190;             // below the header/date
const COLORS = {
  bg: '#0E1116',
  grid: '#1B222C',
  tick: '#2A3342',
  block: '#3B82F6',
  blockText: '#FFFFFF',
  label: '#C7D2FE',
  header: '#E5E7EB'
};

function minutesToX(min) {
  const total = BUILDING.closeMin - BUILDING.openMin; // 960
  const usable = window.innerWidth - TIMELINE_LEFT_PX - TIMELINE_RIGHT_PX;
  return TIMELINE_LEFT_PX + ((min - BUILDING.openMin) / total) * usable;
}

function rowTop(room) {
  const idx = ROOMS_ORDER.indexOf(room);
  return GRID_TOP_PX + idx * ROW_HEIGHT_PX;
}

function fmtClock() {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}`;
}

function renderHeader() {
  const header = document.getElementById('header');
  const d = new Date();
  const dateStr = d.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  header.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; gap:14px; color:${COLORS.header};">
      <div style="font-size:34px; font-weight:700;">${dateStr}</div>
      <div id="clock" style="font-size:30px; opacity:0.9;">${fmtClock()}</div>
    </div>
    <div style="margin-top:8px; text-align:center; color:${COLORS.label}; font-size:16px;">
      Building Hours: 6:00–22:00
    </div>
  `;
}

function tickClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  el.textContent = fmtClock();
}

function renderGridBackdrop() {
  const root = document.getElementById('grid');
  root.innerHTML = '';

  // Room labels
  for (const room of ROOMS_ORDER) {
    const y = rowTop(room);
    const label = document.createElement('div');
    label.textContent = room;
    Object.assign(label.style, {
      position: 'absolute',
      left: '20px',
      top: `${y + 10}px`,
      width: `${TIMELINE_LEFT_PX - 30}px`,
      color: COLORS.label,
      fontSize: '22px',
      fontWeight: '600',
      textAlign: 'right',
      letterSpacing: '0.5px'
    });
    root.appendChild(label);

    const rowLine = document.createElement('div');
    Object.assign(rowLine.style, {
      position: 'absolute',
      left: `${TIMELINE_LEFT_PX}px`,
      right: `${TIMELINE_RIGHT_PX}px`,
      top: `${y + ROW_HEIGHT_PX - 1}px`,
      height: '1px',
      background: COLORS.grid
    });
    root.appendChild(rowLine);
  }

  // Hour ticks every 60 min
  for (let m = BUILDING.openMin; m <= BUILDING.closeMin; m += 60) {
    const x = minutesToX(m);
    const tick = document.createElement('div');
    Object.assign(tick.style, {
      position: 'absolute',
      top: `${GRID_TOP_PX - 14}px`,
      left: `${x}px`,
      width: '1px',
      bottom: '30px',
      background: COLORS.tick
    });
    root.appendChild(tick);

    const label = document.createElement('div');
    const hr = ((m/60)|0);
    const hh = (hr % 12) || 12;
    const suffix = hr < 12 ? 'am' : 'pm';
    label.textContent = `${hh}${m%60===0?'':':30'}${m%60===0? '': ''}${suffix}`;
    Object.assign(label.style, {
      position: 'absolute',
      left: `${x+6}px`,
      top: `${GRID_TOP_PX - 34}px`,
      color: COLORS.label,
      fontSize: '14px'
    });
    root.appendChild(label);
  }
}

function placeBlock(root, ev) {
  // ev: { room, title, who, startMin, endMin }
  const y = rowTop(ev.room) + 6;
  const x1 = minutesToX(ev.startMin);
  const x2 = minutesToX(ev.endMin);
  const w = Math.max(4, x2 - x1);

  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'absolute',
    top: `${y}px`,
    left: `${x1}px`,
    width: `${w}px`,
    height: `${ROW_HEIGHT_PX - 12}px`,
    background: COLORS.block,
    color: COLORS.blockText,
    borderRadius: '10px',
    padding: '8px 10px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontSize: '18px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
  });
  el.textContent = ev.who ? `${ev.title} — ${ev.who}` : ev.title;
  root.appendChild(el);
}

async function loadEvents() {
  // cache-bust on GH Pages
  const res = await fetch(`events.json?v=${Date.now()}`);
  if (!res.ok) return [];
  return res.json();
}

function blankBoard() {
  // Do nothing: per your request, no placeholders when empty.
}

async function init() {
  document.body.style.background = '#0E1116';
  renderHeader();
  renderGridBackdrop();

  const grid = document.getElementById('grid');
  const events = await loadEvents();

  // Draw blocks (if any). If none → leave grid blank.
  for (const ev of events) {
    // sanity clamp to building hours
    if (ev.endMin <= ev.startMin) continue;
    if (ev.endMin <= BUILDING.openMin) continue;
    if (ev.startMin >= BUILDING.closeMin) continue;
    placeBlock(grid, ev);
  }

  setInterval(tickClock, 1000);
}

window.addEventListener('load', init);
window.addEventListener('resize', () => {
  // Re-render grid on resize to keep positions correct
  renderGridBackdrop();
  loadEvents().then(evts => {
    const grid = document.getElementById('grid');
    for (const e of evts) placeBlock(grid, e);
  });
});
