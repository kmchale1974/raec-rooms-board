// app.js (grid-only board, fixed rows per section)
// - Chips wrap to avoid right-edge cutoffs
// - Section bodies use fixed grid rows (South=2, Fieldhouse=6, North=2)
// - Past events auto-hide; header clock & date shown
// - De-duplicate repeated labels like "Extreme Volleyball, Extreme Volleyball"

const WIFI_SSID = 'RAEC_Public';
const WIFI_PASS = 'Publ!c00';

// Map raw room ids to section buckets
const ROOM_GROUP = {
  '1': 'south', '2': 'south',
  '3': 'fieldhouse', '4': 'fieldhouse', '5': 'fieldhouse',
  '6': 'fieldhouse', '7': 'fieldhouse', '8': 'fieldhouse',
  '9': 'north', '10': 'north'
};

function fmtDateTime(now = new Date()) {
  const d = now.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  const t = now.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
  return { d, t };
}

function startClock() {
  const tick = () => {
    const { d, t } = fmtDateTime();
    const hd = document.getElementById('headerDate');
    const hc = document.getElementById('headerClock');
    if (hd) hd.textContent = d;
    if (hc) hc.textContent = t;
  };
  tick();
  setInterval(tick, 1000 * 15);
}

async function loadData() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const data = await resp.json();
  console.log('Loaded events.json', data);
  return data;
}

// Remove duplicated "X, X" reservee patterns
function cleanLabel(s) {
  if (!s) return '';
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const uniq = [];
  for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
  return uniq.join(', ');
}

function timeToWindow(startMin, endMin) {
  const hhmm = (m) => {
    const h24 = Math.floor(m / 60), m2 = m % 60;
    const ampm = h24 >= 12 ? 'pm' : 'am';
    const h12 = ((h24 + 11) % 12) + 1;
    return `${h12}:${m2.toString().padStart(2,'0')}${ampm}`;
  };
  return `${hhmm(startMin)} - ${hhmm(endMin)}`;
}

function isPast(endMin, nowMin) { return endMin <= nowMin; }

function buildSections(container) {
  container.innerHTML = `
    <div class="section section--south" data-group="south">
      <div class="title">South Gym</div>
      <div class="section-body" id="sec-south"></div>
    </div>
    <div class="section section--fieldhouse" data-group="fieldhouse">
      <div class="title">Fieldhouse</div>
      <div class="section-body" id="sec-fieldhouse"></div>
    </div>
    <div class="section section--north" data-group="north">
      <div class="title">North Gym</div>
      <div class="section-body" id="sec-north"></div>
    </div>
  `;
}

function renderRoomsShell(sections, rooms) {
  // rooms is an array of {id,label,group}
  const byGroup = { south:[], fieldhouse:[], north:[] };
  for (const r of rooms) {
    const g = ROOM_GROUP[r.id] || r.group || 'fieldhouse';
    byGroup[g]?.push(r);
  }
  // Enforce strict ordering inside each group
  const sortAsc = (a,b)=> Number(a.id)-Number(b.id);
  byGroup.south.sort(sortAsc);
  byGroup.fieldhouse.sort(sortAsc);
  byGroup.north.sort(sortAsc);

  const fill = (groupId, list) => {
    const el = document.getElementById(`sec-${groupId}`);
    if (!el) return;
    el.innerHTML = list.map(r => `
      <div class="room-cell" data-room="${r.id}">
        <div class="room-head">
          <div class="room-num">${r.label || r.id}</div>
          <div class="room-window" id="win-${r.id}"></div>
        </div>
        <div class="chips" id="chips-${r.id}"></div>
      </div>
    `).join('');
  };

  fill('south', byGroup.south);
  fill('fieldhouse', byGroup.fieldhouse);
  fill('north', byGroup.north);
}

function renderSlotsIntoRooms(slots, dayStartMin, dayEndMin) {
  // Aggregate by room
  const byRoom = new Map();
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  for (const [roomId, items] of byRoom.entries()) {
    // Sort by start time
    items.sort((a,b)=> a.startMin - b.startMin);

    // Compute visible window (min start to max end among visible)
    const minStart = Math.min(...items.map(i => i.startMin));
    const maxEnd = Math.max(...items.map(i => i.endMin));
    const win = document.getElementById(`win-${roomId}`);
    if (win) win.textContent = timeToWindow(minStart, maxEnd);

    // Render chips
    const holder = document.getElementById(`chips-${roomId}`);
    if (!holder) continue;
    holder.innerHTML = items.map(i => {
      const title = cleanLabel(i.title);
      const sub = cleanLabel(i.subtitle || '');
      const time = timeToWindow(i.startMin, i.endMin);
      const subHtml = sub ? `<small>${sub}</small>` : '';
      return `<div class="chip"><strong class="truncate">${title}</strong> ${subHtml} <small class="faint">• ${time}</small></div>`;
    }).join('');
  }
}

function currentMinutes() {
  const now = new Date();
  return now.getHours()*60 + now.getMinutes();
}

async function init() {
  startClock();

  const root = document.getElementById('grid');
  if (!root) return;

  const data = await loadData();

  // Build fixed sections
  buildSections(root);

  // Ensure we have rooms; if file lists none, synthesize 1..10
  let rooms = Array.isArray(data.rooms) && data.rooms.length
    ? data.rooms
    : [
        {id:'1', label:'1'}, {id:'2', label:'2'},
        {id:'3', label:'3'}, {id:'4', label:'4'}, {id:'5', label:'5'},
        {id:'6', label:'6'}, {id:'7', label:'7'}, {id:'8', label:'8'},
        {id:'9', label:'9'}, {id:'10', label:'10'}
      ];

  // Normalize group field if missing
  rooms = rooms.map(r => ({ ...r, group: ROOM_GROUP[r.id] || r.group || 'fieldhouse' }));

  // Draw empty room shells
  renderRoomsShell(root, rooms);

  // Filter out past events
  const nowMin = currentMinutes();
  const allSlots = Array.isArray(data.slots) ? data.slots : [];
  const futureSlots = allSlots.filter(s => !isPast(s.endMin, nowMin));

  console.log(`Slots filtered by time: ${allSlots.length} -> ${futureSlots.length} (now=${nowMin})`);

  // Render chips into rooms
  renderSlotsIntoRooms(futureSlots, data.dayStartMin ?? 360, data.dayEndMin ?? 1380);
}

document.addEventListener('DOMContentLoaded', init);
