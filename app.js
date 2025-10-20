// app.js

const WIFI_SSID = 'RAEC Public';
const WIFI_PASS = 'Publ!c00';

// cache-busted fetch so Yodeck / browsers don’t reuse stale JSON
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatTime(min) {
  let h = Math.floor(min / 60);
  let m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

function groupClass(id) {
  const n = parseInt(id, 10);
  if (n <= 2) return 'south';
  if (n >= 3 && n <= 8) return 'fieldhouse';
  return 'north';
}

// Render header (logo + centered date/clock + wifi)
function renderHeader() {
  const dateEl = document.getElementById('headerDate');
  const clockEl = document.getElementById('headerClock');
  const wifiEl = document.getElementById('wifi');

  function update() {
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    dateEl.textContent = dateStr;
    clockEl.textContent = timeStr;
    wifiEl.innerHTML = `<strong>Wi-Fi:</strong> ${WIFI_SSID} &nbsp;•&nbsp; <strong>Pass:</strong> ${WIFI_PASS}`;
  }
  update();
  setInterval(update, 1000);
}

function buildRoomCell(room, events) {
  const cell = document.createElement('div');
  cell.className = `cell ${groupClass(room.id)}`;

  // Header row: large room number
  const head = document.createElement('div');
  head.className = 'roomtag';
  head.innerHTML = `<span>${room.label}</span>`;
  cell.appendChild(head);

  const wrap = document.createElement('div');
  wrap.className = 'events';

  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '';
    wrap.appendChild(empty);
  } else {
    for (const ev of events) {
      const evt = document.createElement('div');
      evt.className = 'evt';

      // Title with optional [A]/[B] lane badge
      const t = document.createElement('div');
      t.className = 'title';
      t.textContent = ev.lane ? `[${ev.lane}] ${ev.title}` : ev.title;

      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = ev.subtitle
        ? `${formatTime(ev.startMin)}–${formatTime(ev.endMin)} • ${ev.subtitle}`
        : `${formatTime(ev.startMin)}–${formatTime(ev.endMin)}`;

      evt.appendChild(t);
      evt.appendChild(s);
      wrap.appendChild(evt);
    }
  }

  cell.appendChild(wrap);
  return cell;
}

function renderGrid(data) {
  const stage = document.getElementById('gridRoot');
  stage.innerHTML = '';

  // Build fixed groups: south(1,2), fieldhouse(3..8), north(9,10)
  const groups = [
    { id: 'south', label: 'South Gym', rooms: data.rooms.filter(r => r.group === 'south') },
    { id: 'fieldhouse', label: 'Fieldhouse', rooms: data.rooms.filter(r => r.group === 'fieldhouse') },
    { id: 'north', label: 'North Gym', rooms: data.rooms.filter(r => r.group === 'north') }
  ];

  for (const g of groups) {
    const col = document.createElement('div');
    col.className = 'col';

    const ghead = document.createElement('div');
    ghead.className = 'grouphead';
    ghead.textContent = g.label;
    col.appendChild(ghead);

    const grid = document.createElement('div');
    grid.className = 'gridcol';

    // room order already correct (1..10)
    for (const room of g.rooms) {
      const events = data.slots.filter(s => s.roomId === room.id);
      grid.appendChild(buildRoomCell(room, events));
    }

    col.appendChild(grid);
    stage.appendChild(col);
  }
}

async function init() {
  renderHeader();

  const data = await loadData();

  // Filter out past events (endMin <= now)
  const now = nowMinutes();
  const filtered = {
    ...data,
    slots: (data.slots || []).filter(s => s.endMin > now)
  };
  console.log(`Slots filtered by time: ${(data.slots || []).length} -> ${filtered.slots.length} (now=${now})`);

  renderGrid(filtered);
}

document.addEventListener('DOMContentLoaded', init);
