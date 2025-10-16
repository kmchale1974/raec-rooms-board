// app.js (module)

const WIFI_SSID = 'RAEC_Public';
const WIFI_PW   = 'Publ!c00'; // your updated password

function fmtDateClock() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday:'long', month:'long', day:'numeric'
  });
  const time = now.toLocaleTimeString(undefined, {
    hour:'numeric', minute:'2-digit'
  });
  return { date, time };
}

function updateHeaderClock() {
  const { date, time } = fmtDateClock();
  const d = document.getElementById('headerDate');
  const c = document.getElementById('headerClock');
  if (d) d.textContent = date;
  if (c) c.textContent = time;
}

async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

/** Render one section with a title and its rooms */
function renderSection(title, rooms) {
  const sec = document.createElement('div');
  sec.className = 'section';

  const h = document.createElement('div');
  h.className = 'title';
  h.textContent = title;
  sec.appendChild(h);

  rooms.forEach(r => {
    const cell = document.createElement('div');
    cell.className = 'room-cell';

    const head = document.createElement('div');
    head.className = 'room-head';

    const num = document.createElement('div');
    num.className = 'room-num';
    num.textContent = r.label || r.id;

    const win = document.createElement('div');
    win.className = 'room-window';
    // Optional: show next active time window if you compute it
    win.textContent = '';

    head.appendChild(num);
    head.appendChild(win);
    cell.appendChild(head);

    // Events
    (r.events || []).forEach(ev => {
      const chip = document.createElement('div');
      chip.className = 'chip truncate';
      const who = (ev.title || '').replace(/\s*,\s*([^,]+)\s*$/, (m, g1) => {
        // remove immediate repeated word pattern e.g. "Extreme Volleyball, Extreme Volleyball"
        return (g1 && ev.title && g1.trim().length > 0 &&
                ev.title.trim().toLowerCase() === g1.trim().toLowerCase()) ? '' : m;
      }).replace(/\s*,\s*$/, ''); // clean trailing comma if removed

      const sub = ev.subtitle ? ` <small>${ev.subtitle}</small>` : '';
      chip.innerHTML = `<strong>${who}</strong>${sub}`;
      cell.appendChild(chip);
    });

    sec.appendChild(cell);
  });

  return sec;
}

/** Build three columns: South / Fieldhouse / North */
function renderGrid(data) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.innerHTML = '';

  const south = data.rooms.filter(r => r.group === 'south');
  const field = data.rooms.filter(r => r.group === 'fieldhouse');
  const north = data.rooms.filter(r => r.group === 'north');

  grid.appendChild(renderSection('South Gym', south));
  grid.appendChild(renderSection('Fieldhouse', field));
  grid.appendChild(renderSection('North Gym', north));
}

function filterPastSlots(data) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const slots = Array.isArray(data.slots) ? data.slots : [];
  const kept = slots.filter(s => s.endMin > mins);
  console.log(`Slots filtered by time: ${slots.length} -> ${kept.length} (now=${mins})`);
  return { ...data, slots: kept };
}

function attachEventsToRooms(data) {
  const byId = Object.fromEntries(data.rooms.map(r => [r.id, { ...r, events: [] }]));
  for (const s of data.slots) {
    const r = byId[s.roomId];
    if (!r) continue;
    r.events.push({
      title: s.title || '',
      subtitle: s.subtitle || ''
    });
  }
  return { ...data, rooms: Object.values(byId) };
}

async function init() {
  updateHeaderClock();
  setInterval(updateHeaderClock, 1000);

  const data = await loadEvents().catch(err => {
    console.error(err);
    return { rooms: [], slots: [], dayStartMin: 360, dayEndMin: 1380 };
  });

  // Only show future/ongoing events
  const filtered = filterPastSlots(data);

  // Attach events to room objects
  const hydrated = attachEventsToRooms(filtered);

  // Render
  renderGrid(hydrated);
}

document.addEventListener('DOMContentLoaded', init);
