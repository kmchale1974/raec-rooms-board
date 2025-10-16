// app.js  (ESM)

// --- Header clock/date ---
function fmtDate(d) {
  const wd = d.toLocaleDateString(undefined, { weekday: 'long' });
  const md = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  return `${wd}, ${md}`;
}
function fmtClock(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function startClock() {
  const dEl = document.getElementById('headerDate');
  const cEl = document.getElementById('headerClock');
  const tick = () => {
    const now = new Date();
    if (dEl) dEl.textContent = fmtDate(now);
    if (cEl) cEl.textContent = fmtClock(now);
  };
  tick();
  setInterval(tick, 1000);
}

// --- Fetch events.json (no cache) ---
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  console.log('Loaded events.json', data ? {} : { error: 'no data' });
  return data;
}

// --- Utility ---
function minToStr(m) {
  let h = Math.floor(m / 60), n = m % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${String(n).padStart(2, '0')}${ap}`;
}

// Render one tile (one “room” or “slice”)
function renderTile(container, label, items) {
  const tile = document.createElement('div');
  tile.className = 'tile';

  const h = document.createElement('h3');
  h.textContent = label;
  tile.appendChild(h);

  const list = document.createElement('div');
  list.className = 'list';
  if (!items || items.length === 0) {
    const em = document.createElement('div');
    em.className = 'empty';
    em.textContent = '—';
    list.appendChild(em);
  } else {
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'item';

      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = it.title + (it.subtitle ? ` — ${it.subtitle}` : '');

      const until = document.createElement('div');
      until.className = 'until';
      until.textContent = `${minToStr(it.startMin)}–${minToStr(it.endMin)}`;

      row.appendChild(who);
      row.appendChild(until);
      list.appendChild(row);
    }
  }
  tile.appendChild(list);
  container.appendChild(tile);
}

// Group slots by roomId, sorted by time within each
function groupByRoom(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.roomId)) map.set(s.roomId, []);
    map.get(s.roomId).push(s);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.title.localeCompare(b.title));
  }
  return map;
}

function initColumns(rooms) {
  const south = rooms.filter(r => r.group === 'south');
  const fh    = rooms.filter(r => r.group === 'fieldhouse');
  const north = rooms.filter(r => r.group === 'north');

  const colSouth = document.getElementById('colSouth');
  const colFH    = document.getElementById('colFieldhouse');
  const colNorth = document.getElementById('colNorth');

  // Clear
  colSouth.innerHTML = ''; colFH.innerHTML = ''; colNorth.innerHTML = '';

  // Build empty tiles first; slot fill happens after
  for (const r of south) renderTile(colSouth, r.label, []);
  for (const r of fh)    renderTile(colFH,    r.label, []);
  for (const r of north) renderTile(colNorth, r.label, []);
}

// Fill with actual events
function fillColumns(rooms, slots) {
  const byRoom = groupByRoom(slots);

  const fill = (colId, groupName) => {
    const col = document.getElementById(colId);
    if (!col) return;
    // tiles are in same order as rooms filter used in initColumns
    const groupRooms = rooms.filter(r => r.group === groupName);
    // For each tile, replace its list content
    const tiles = Array.from(col.querySelectorAll('.tile'));
    tiles.forEach((tile, i) => {
      const r = groupRooms[i];
      const list = tile.querySelector('.list');
      list.innerHTML = ''; // clear
      const items = byRoom.get(r.id) || [];
      if (items.length === 0) {
        const em = document.createElement('div');
        em.className = 'empty';
        em.textContent = '—';
        list.appendChild(em);
      } else {
        for (const it of items) {
          const row = document.createElement('div');
          row.className = 'item';

          const who = document.createElement('div');
          who.className = 'who';
          who.textContent = it.title + (it.subtitle ? ` — ${it.subtitle}` : '');

          const until = document.createElement('div');
          until.className = 'until';
          until.textContent = `${minToStr(it.startMin)}–${minToStr(it.endMin)}`;

          row.appendChild(who);
          row.appendChild(until);
          list.appendChild(row);
        }
      }
    });
  };

  fill('colSouth', 'south');
  fill('colFieldhouse', 'fieldhouse');
  fill('colNorth', 'north');
}

async function init() {
  startClock();
  const data = await loadData();

  // Build columns based on the *rooms array* from transformer (this encodes season + grouping)
  initColumns(data.rooms);

  // Hide past events; fallback to all if that empties the board
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const filtered = (data.slots || []).filter(s => s.endMin > nowMin);
  console.log(`Slots filtered by time: ${data.slots.length} -> ${filtered.length} (now=${nowMin})`);

  const visible = (filtered.length > 0) ? filtered : data.slots;
  if (filtered.length === 0 && data.slots.length > 0) {
    console.warn('No future events left; showing all of today for late arrivals.');
  }

  fillColumns(data.rooms, visible);

  // Optional: refresh every minute to let chips fall off naturally
  setTimeout(init, 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
