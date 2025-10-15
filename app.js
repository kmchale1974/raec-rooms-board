// ===== Utils =====
const ORDER = [
  "1A","1B","2A","2B","3A","3B","4A","4B","5A","5B","6A","6B","7A","7B","8A","8B","9A","9B","10A","10B"
];
const ROWS = [["1A","1B"],["2A","2B"],["3A","3B"],["4A","4B"],["5A","5B"],
              ["6A","6B"],["7A","7B"],["8A","8B"],["9A","9B"],["10A","10B"]];

const DAY_START = 360;  // 6:00
const DAY_END   = 1380; // 23:00

const fmtTime = m => {
  const h24 = Math.floor(m/60), m2 = m%60;
  const h = (h24 % 12) || 12;
  const ampm = h24 < 12 ? 'am' : 'pm';
  return `${h}:${m2.toString().padStart(2,'0')}${ampm}`;
};

// ===== Data loader =====
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events:', { rooms: Object.keys(data.rooms||{}).length, slots: (data.slots||[]).length });
  return data;
}

// ===== Header (date + clock) =====
function renderHeader() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const upd = () => {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    clockEl.textContent = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  };
  upd(); setInterval(upd, 1000);
}

// ===== Timeline view =====
function renderRoomsColumn() {
  const box = document.querySelector('.rooms');
  // clear old .room rows
  box.querySelectorAll('.room').forEach(n => n.remove());
  ROWS.forEach(([a,b]) => {
    const row = document.createElement('div'); row.className = 'room';
    const ca = document.createElement('div'); ca.textContent = a;
    const cb = document.createElement('div'); cb.textContent = b;
    row.append(ca, cb); box.appendChild(row);
  });
}

function renderGridBackdrop(dayStart=DAY_START, dayEnd=DAY_END) {
  const hoursRow = document.getElementById('hoursRow');
  const gridBackdrop = document.getElementById('gridBackdrop');
  if (!hoursRow || !gridBackdrop) return;

  const cols = (dayEnd - dayStart) / 60; // one column per hour
  hoursRow.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  document.documentElement.style.setProperty('--cols', `repeat(${cols*4}, 1fr)`); // quarter-hour grid

  hoursRow.innerHTML = '';
  for (let i = 0; i < cols; i++) {
    const t = dayStart + i*60;
    const d = document.createElement('div');
    d.textContent = fmtTime(t);
    hoursRow.appendChild(d);
  }

  gridBackdrop.innerHTML = '';
  // 4 slices per hour (15 min)
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < cols*4; c++) {
      const cell = document.createElement('div'); cell.className = 'cell';
      gridBackdrop.appendChild(cell);
    }
  }
}

function renderSlots(data) {
  const lanes = document.getElementById('lanes');
  const nowLine = document.getElementById('nowLine');
  if (!lanes) return;

  lanes.innerHTML = '';
  // one lane row per ROWS, but we position absolute chips inside each lane
  for (let i=0;i<10;i++) lanes.appendChild(document.createElement('div'));

  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();

  const usable = (data.slots||[])
    .filter(s => ORDER.includes(s.room))
    .filter(s => s.endMin > nowMin); // hide past

  // Place chips
  const totalSpan = DAY_END - DAY_START; // minutes
  usable.forEach(s => {
    const rowIndex = ROWS.findIndex(pair => pair.includes(s.room));
    const laneTop = rowIndex / 10 * 100;

    const start = Math.max(s.startMin, DAY_START);
    const end   = Math.min(s.endMin, DAY_END);
    const leftPct = ((start - DAY_START) / totalSpan) * 100;
    const widthPct = ((end - start) / totalSpan) * 100;

    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.top = `calc(${rowIndex} * (100%/10))`;
    chip.style.height = `calc(100%/10 - 2px)`;
    chip.style.left = `${leftPct}%`;
    chip.style.width = `${widthPct}%`;
    chip.innerHTML = `<strong>${s.title || s.reservee || 'Reserved'}</strong><small>${fmtTime(s.startMin)}–${fmtTime(s.endMin)} • ${s.room}</small>`;
    document.getElementById('grid').appendChild(chip);
  });

  // Now line (only if within the day)
  if (nowMin >= DAY_START && nowMin <= DAY_END) {
    const leftPct = ((nowMin - DAY_START) / (DAY_END - DAY_START)) * 100;
    nowLine.style.left = `${leftPct}%`;
    nowLine.hidden = false;
  } else {
    nowLine.hidden = true;
  }
}

// ===== GRID BOARD view (whiteboard-style) =====
function renderGridBoard(data) {
  const wrap = document.getElementById('gridWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  // Build 10 rows × 2 columns (A column then B column) to mirror the physical board feel
  const eventsByRoom = {};
  for (const r of ORDER) eventsByRoom[r] = [];
  (data.slots||[]).forEach(s => eventsByRoom[s.room]?.push(s));

  // Sort each room’s events by start time and keep today’s only
  for (const r of ORDER) {
    eventsByRoom[r] = eventsByRoom[r]
      .slice()
      .sort((a,b)=>a.startMin-b.startMin);
  }

  // Left column = A courts; Right column = B courts
  const leftRooms  = ["1A","2A","3A","4A","5A","6A","7A","8A","9A","10A"];
  const rightRooms = ["1B","2B","3B","4B","5B","6B","7B","8B","9B","10B"];

  const makeCol = rooms => {
    rooms.forEach(roomId => {
      const cell = document.createElement('div'); cell.className = 'gb-cell';
      const header = document.createElement('div'); header.className = 'gb-room';
      header.textContent = roomId;
      cell.appendChild(header);

      const list = eventsByRoom[roomId];
      if (!list || list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'gb-empty'; empty.textContent = '';
        cell.appendChild(empty);
      } else {
        list.forEach(ev => {
          const line = document.createElement('div'); line.className = 'gb-event';
          const time = document.createElement('span'); time.className = 'gb-time';
          time.textContent = `${fmtTime(ev.startMin)}–${fmtTime(ev.endMin)}`;
          const label = document.createElement('span');
          label.textContent = ev.title || ev.reservee || 'Reserved';
          line.append(time, label);
          cell.appendChild(line);
        });
      }
      wrap.appendChild(cell);
    });
  };

  makeCol(leftRooms);
  makeCol(rightRooms);
}

// ===== View switching (with optional auto-rotate for signage) =====
function setActive(view){ // 'timeline' | 'grid'
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===view));
  document.getElementById('timelineView').style.display = (view==='timeline') ? 'grid' : 'none';
  document.getElementById('gridView').classList.toggle('is-active', view==='grid');
}

async function init(){
  renderHeader();

  const data = await loadData();

  // TIMELINE
  renderRoomsColumn();
  renderGridBackdrop(data.dayStartMin || DAY_START, data.dayEndMin || DAY_END);
  renderSlots(data);

  // GRID BOARD
  renderGridBoard(data);

  // Non-interactive players: auto-rotate every 20s (toggle to false to disable)
  const AUTO_ROTATE = true;
  let view = 'timeline';
  setActive(view);

  if (AUTO_ROTATE){
    setInterval(()=> {
      view = (view === 'timeline') ? 'grid' : 'timeline';
      setActive(view);
    }, 20000);
  }

  // If someone is testing in a browser with a mouse, allow clicking the tabs
  document.getElementById('tabBar').addEventListener('click', (e)=>{
    const t = e.target.closest('.tab');
    if (!t) return;
    setActive(t.dataset.view);
  });
}

document.addEventListener('DOMContentLoaded', init);
