// -------- config you asked for --------
const WIFI_NAME = 'RAEC_Guest';
const WIFI_PASS = 'Publ!c00'; // per your note

// how many items to show per room before "+n more"
const MAX_ITEMS_PER_ROOM = 3;

// -------------------------------------

function minutesNowLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function fmtHeaderDate(now = new Date()) {
  return now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });
}

function fmtHeaderClock(now = new Date()) {
  return now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Remove exact “X, X” repetitions (e.g., "Extreme Volleyball, Extreme Volleyball")
function squashCommaRepeat(s) {
  if (!s) return '';
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    return parts[0];
  }
  return s;
}

// Try to read events.json
async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// If events.json is empty or malformed, build a safe scaffold so the grid renders
function saneData(raw) {
  const okSlots = Array.isArray(raw?.slots);
  const okRooms = Array.isArray(raw?.rooms);
  if (okRooms || okSlots) return raw;

  console.warn('events.json empty; using safe scaffold for layout only');
  return {
    dayStartMin: 360,
    dayEndMin: 1380,
    // no rooms array required (we derive it from slots anyway)
    slots: []
  };
}

// Determine if A/B is explicitly used for a given base number (1,2,9,10)
function hasExplicitAB(slots, base) {
  const a = slots.some(s => `${base}A` === s.roomId);
  const b = slots.some(s => `${base}B` === s.roomId);
  return a || b;
}

// Build the ordered room list for the three columns
function deriveRooms(slots) {
  // South: 1 & 2
  const south = [];
  [1,2].forEach(n => {
    if (hasExplicitAB(slots, n)) {
      south.push({ id: `${n}A`, label: `${n}A`, group: 'south' });
      south.push({ id: `${n}B`, label: `${n}B`, group: 'south' });
    } else {
      south.push({ id: `${n}`, label: `${n}`, group: 'south' });
    }
  });

  // Fieldhouse: always 3–8 as single numbers (we ignore turf variants here; transformer handles season)
  const fieldhouse = [];
  for (let n = 3; n <= 8; n++) {
    fieldhouse.push({ id: `${n}`, label: `${n}`, group: 'fieldhouse' });
  }

  // North: 9 & 10
  const north = [];
  [9,10].forEach(n => {
    if (hasExplicitAB(slots, n)) {
      north.push({ id: `${n}A`, label: `${n}A`, group: 'north' });
      north.push({ id: `${n}B`, label: `${n}B`, group: 'north' });
    } else {
      north.push({ id: `${n}`, label: `${n}`, group: 'north' });
    }
  });

  return { south, fieldhouse, north };
}

// Normalize roomId for grouping: if cell is a single-number room, fold A/B into the number.
// If cell is explicitly A or B, keep it as-is.
function normalizeRoomKey(cellId, slotRoomId) {
  // If the cellId itself is A/B, match by exact id
  if (/^\d{1,2}[AB]$/.test(cellId)) return slotRoomId; // strict match later

  // Otherwise cellId is just the number; fold slot A/B into the base number
  const m = /^(\d{1,2})([AB])$/.exec(slotRoomId);
  return m ? m[1] : slotRoomId;
}

// Render header (clock + date + wifi)
function renderHeader() {
  const now = new Date();
  document.getElementById('headerDate').textContent = fmtHeaderDate(now);
  document.getElementById('headerClock').textContent = fmtHeaderClock(now);
  document.getElementById('wifiName').textContent = WIFI_NAME;
  document.getElementById('wifiPass').textContent = WIFI_PASS;
}

// Render the three columns of cells, then populate events
function renderGridLayout(rooms) {
  const southCol = document.querySelector('.col.south');
  const fhCol = document.querySelector('.col.fieldhouse');
  const northCol = document.querySelector('.col.north');

  // purge existing cells but keep the sticky header (first child)
  ;[southCol, fhCol, northCol].forEach(col => {
    while (col.children.length > 1) col.removeChild(col.lastElementChild);
  });

  const addCell = (colEl, room) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.roomId = room.id;

    const label = document.createElement('div');
    label.className = 'label';
    const where = document.createElement('div');
    where.className = 'where';
    where.textContent = room.label;
    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = ''; // will fill after events added

    const list = document.createElement('div');
    list.className = 'list';

    label.appendChild(where);
    label.appendChild(count);
    cell.appendChild(label);
    cell.appendChild(list);
    colEl.appendChild(cell);
  };

  rooms.south.forEach(r => addCell(southCol, r));
  rooms.fieldhouse.forEach(r => addCell(fhCol, r));
  rooms.north.forEach(r => addCell(northCol, r));
}

// Fill events into the cells (past items filtered out)
function populateEvents(rooms, slots) {
  const nowMin = minutesNowLocal();
  const active = slots.filter(s => s.endMin > nowMin);

  // index cells
  const cellMap = {};
  document.querySelectorAll('.cell').forEach(cell => {
    const id = cell.dataset.roomId;
    cellMap[id] = cell;
    // reset
    cell.querySelector('.list').innerHTML = '';
    cell.querySelector('.count').textContent = '';
  });

  // Partition by destination cell
  const perCell = {};
  active.forEach(s => {
    // find the cell(s) that should contain this slot
    // exact match first (for A/B cells)
    if (cellMap[s.roomId]) {
      perCell[s.roomId] ??= [];
      perCell[s.roomId].push(s);
      return;
    }
    // otherwise, if we have a single-number cell, fold A/B into base
    const m = /^(\d{1,2})([AB])$/.exec(s.roomId);
    if (m && cellMap[m[1]]) {
      perCell[m[1]] ??= [];
      perCell[m[1]].push(s);
      return;
    }
    // also handle plain numbers (e.g., "9")
    if (cellMap[s.roomId]) {
      perCell[s.roomId] ??= [];
      perCell[s.roomId].push(s);
    }
  });

  // Render per cell
  Object.entries(perCell).forEach(([cellId, items]) => {
    // sort by start time
    items.sort((a,b) => (a.startMin - b.startMin) || (a.endMin - b.endMin));

    // compress exact duplicate (title+subtitle+times) to avoid visual spam
    const deduped = [];
    let prevKey = '';
    for (const it of items) {
      const title = squashCommaRepeat(it.title || '');
      const sub = squashCommaRepeat(it.subtitle || '');
      const key = `${title}|${sub}|${it.startMin}|${it.endMin}`;
      if (key !== prevKey) deduped.push({ ...it, title, subtitle: sub });
      prevKey = key;
    }

    const cell = cellMap[cellId];
    const list = cell.querySelector('.list');

    const head = cell.querySelector('.count');
    head.textContent = deduped.length > MAX_ITEMS_PER_ROOM
      ? `${deduped.length} items`
      : deduped.length ? `${deduped.length} item${deduped.length>1?'s':''}` : '';

    deduped.slice(0, MAX_ITEMS_PER_ROOM).forEach(it => {
      const chip = document.createElement('div');
      chip.className = 'chip';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = it.title || 'Reserved';

      const sub = document.createElement('div');
      sub.className = 'sub';
      // show time window too, helpful without a timeline
      const startH = Math.floor(it.startMin / 60);
      const startM = it.startMin % 60;
      const endH = Math.floor(it.endMin / 60);
      const endM = it.endMin % 60;
      const startStr = new Date(0,0,0,startH,startM).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
      const endStr = new Date(0,0,0,endH,endM).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
      const detail = it.subtitle ? ` • ${it.subtitle}` : '';
      sub.textContent = `${startStr}–${endStr}${detail}`;

      chip.appendChild(title);
      chip.appendChild(sub);
      list.appendChild(chip);
    });

    if (deduped.length > MAX_ITEMS_PER_ROOM) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = `+${deduped.length - MAX_ITEMS_PER_ROOM} more`;
      list.appendChild(more);
    }
  });
}

// Kickoff
async function init() {
  try {
    const raw = await loadData();
    const data = saneData(raw);

    // update header immediately and every :15 seconds
    renderHeader();
    setInterval(renderHeader, 15000);

    // derive rooms from slots (A/B rule), then render layout and populate
    const rooms = deriveRooms(Array.isArray(data.slots) ? data.slots : []);
    renderGridLayout(rooms);
    populateEvents(rooms, Array.isArray(data.slots) ? data.slots : []);

    // refresh events every 60s so past items fall off automatically
    setInterval(async () => {
      try {
        const fresh = await loadData();
        const safe = saneData(fresh);
        const newRooms = deriveRooms(Array.isArray(safe.slots) ? safe.slots : []);
        // if room structure changed (e.g., A/B added/removed), rebuild
        const currentCellIds = Array.from(document.querySelectorAll('.cell')).map(c => c.dataset.roomId).join(',');
        const nextCellIds = [...newRooms.south, ...newRooms.fieldhouse, ...newRooms.north].map(r => r.id).join(',');
        if (currentCellIds !== nextCellIds) {
          renderGridLayout(newRooms);
        }
        populateEvents(newRooms, Array.isArray(safe.slots) ? safe.slots : []);
      } catch (e) {
        console.error('Periodic refresh failed:', e);
      }
    }, 60000);
  } catch (err) {
    console.error('Init failed:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
