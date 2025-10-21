// app.js

// ---------- helpers: time & formatting ----------
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const to12h = (mins) => {
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const mm = m.toString().padStart(2, '0');
  return `${h}:${mm}${ampm}`;
};

const range12h = (s, e) => `${to12h(s)} - ${to12h(e)}`;

// ---------- DOM refs ----------
const $ = (q) => document.querySelector(q);

// These containers must exist in index.html
const elDate  = $('#headerDate');
const elClock = $('#headerClock');
const southWrap = $('#southRooms');
const fieldWrap = $('#fieldhouseRooms');
const northWrap = $('#northRooms');

// ---------- fetch events.json fresh ----------
async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to load events.json: ${resp.status}`);
  console.log('Loaded events.json', { 'last-modified': resp.headers.get('last-modified') });
  return resp.json();
}

// ---------- cleaning & mapping ----------
function cleanPickleballText(text) {
  if (!text) return '';
  let t = text;

  // If this looks like pickleball, normalize label
  if (/pickle\s*ball|pickleball/i.test(t)) {
    t = 'Open Pickleball';
  }

  // Strip internal/admin notes
  t = t.replace(/RAEC\s*Front\s*Desk.*?- On Hold/gi, '')
       .replace(/Internal Hold per NM/gi, '')
       .replace(/\s*\|\s*\|\s*/g, ' ')
       .replace(/\s+\|\s+/g, ' ')
       .replace(/\s{2,}/g, ' ')
       .trim();

  return t;
}

function cleanOrgDupes(text) {
  if (!text) return '';
  // Remove ", Foo, Foo" style trailing duplication
  // e.g., "Chicago Sport and Social Club, Chicago Sport and Social Club"
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }
  return deduped.join(', ');
}

function displayWho(slot) {
  // Prefer reservee/title, then subtitle/purpose
  const whoRaw = cleanOrgDupes(slot.title || '');
  const whatRaw = cleanPickleballText(slot.subtitle || '');

  // If pickleball detected anywhere, force a nice label
  if (/pickle\s*ball|pickleball/i.test(`${slot.title} ${slot.subtitle}` || '')) {
    return 'Open Pickleball';
  }

  // If title exists and looks meaningful, use it; else fall back to subtitle
  const cleaned = (whoRaw || whatRaw || '').trim();
  return cleaned || 'Reserved';
}

function displayWhat(slot) {
  // Secondary line: purpose (clean), only if it adds info beyond who
  let what = cleanPickleballText(slot.subtitle || '');
  const who = displayWho(slot);
  if (!what || what.toLowerCase() === who.toLowerCase()) return '';
  return what;
}

// Expand a slot room target to an array of base numbers: "1A" -> ["1"], "9-AB" -> ["9"],
// "Full Gym 1AB & 2AB" -> ["1","2"], "9 & 10" -> ["9","10"], "1-2" -> ["1","2"]
function expandTargets(roomId) {
  if (!roomId) return [];
  let s = String(roomId).trim();

  // Normalize separators
  s = s.replace(/full\s*gym|court|courts/gi, '')
       .replace(/AB/gi, '')
       .replace(/-AB/gi, '')
       .replace(/&/g, ' ')
       .replace(/,/g, ' ')
       .replace(/\s{2,}/g, ' ')
       .trim();

  // Split on spaces or hyphens
  // Examples that resolve well:
  // "1", "1A", "10B" => ["1"] / ["10"]
  // "1 2" => ["1","2"]
  // "9-10" => ["9","10"]
  // "1AB 2AB" => ["1","2"]
  const tokens = s.split(/[\s-]+/).filter(Boolean);
  const out = [];

  for (let t of tokens) {
    // Strip trailing letters (A/B)
    t = t.replace(/[A-Za-z]+$/, '');
    if (/^\d+$/.test(t)) out.push(String(parseInt(t, 10)));
  }

  // Common special-cases from CSV mapping:
  // If nothing parsed but roomId had “1-AB” or similar, map it now
  if (!out.length) {
    const m = roomId.match(/(\d+)/g);
    if (m && m.length) return [...new Set(m.map(n => String(parseInt(n,10))))];
  }

  return [...new Set(out)];
}

// Return true if two slots are the “same” for dedupe purposes in the same room
function sameKey(a, b) {
  return a.room === b.room &&
         a.startMin === b.startMin &&
         a.endMin === b.endMin &&
         displayWho(a) === displayWho(b) &&
         displayWhat(a) === displayWhat(b);
}

// ---------- render ----------
function renderHeader() {
  const d = new Date();
  const dateStr = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  let hh = d.getHours();
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  const timeStr = `${hh}:${mm} ${ampm}`;

  if (elDate)  elDate.textContent  = dateStr;
  if (elClock) elClock.textContent = timeStr;
}

function buildRoomCard(roomId) {
  const wrap = document.createElement('div');
  wrap.className = 'room';

  const header = document.createElement('div');
  header.className = 'roomHeader';

  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = roomId;

  const count = document.createElement('div');
  count.className = 'count';
  count.textContent = ''; // we'll fill later

  header.appendChild(id);
  header.appendChild(count);

  const list = document.createElement('div');
  list.className = 'events';

  wrap.appendChild(header);
  wrap.appendChild(list);

  return { wrap, list, count };
}

function renderBoard(data) {
  // Clear containers
  southWrap.innerHTML = '';
  fieldWrap.innerHTML = '';
  northWrap.innerHTML = '';

  // Build static room cards in fixed order
  const southIds = ['1', '2'];
  const fieldIds = ['3', '4', '5', '6', '7', '8'];
  const northIds = ['9', '10'];

  const cardRefs = new Map(); // roomId -> {list,count}
  const addCards = (ids, parent) => {
    ids.forEach(rid => {
      const { wrap, list, count } = buildRoomCard(rid);
      parent.appendChild(wrap);
      cardRefs.set(rid, { list, count });
    });
  };
  addCards(southIds, southWrap);
  addCards(fieldIds, fieldWrap);
  addCards(northIds, northWrap);

  const now = nowMinutes();

  // Expand slots to room-scoped entries & filter out past events
  const expanded = [];
  for (const s of (data.slots || [])) {
    const targets = expandTargets(s.roomId || s.room || s.room_id || '');
    for (const room of targets) {
      if (s.endMin <= now) continue; // past -> hide
      expanded.push({ ...s, room });
    }
  }

  // Per-room dedupe & sort
  const perRoom = new Map();
  for (const e of expanded) {
    if (!perRoom.has(e.room)) perRoom.set(e.room, []);
    const arr = perRoom.get(e.room);
    // dedupe
    if (!arr.some(x => sameKey(x, e))) arr.push(e);
  }
  for (const [room, arr] of perRoom) {
    arr.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);
  }

  // Render events into each room
  for (const [room, arr] of perRoom) {
    const ref = cardRefs.get(room);
    if (!ref) continue;
    const { list, count } = ref;
    list.innerHTML = '';

    for (const ev of arr) {
      const who = displayWho(ev);
      const what = displayWhat(ev);
      const when = range12h(ev.startMin, ev.endMin);

      const item = document.createElement('div');
      item.className = 'event';

      const whoEl = document.createElement('div');
      whoEl.className = 'who';
      whoEl.textContent = who;

      const whenEl = document.createElement('div');
      whenEl.className = 'when';
      whenEl.textContent = when;

      item.appendChild(whoEl);
      if (what) {
        const whatEl = document.createElement('div');
        whatEl.className = 'what';
        whatEl.textContent = what;
        item.appendChild(whatEl);
      }
      item.appendChild(whenEl);

      list.appendChild(item);
    }

    count.textContent = arr.length ? `${arr.length} event${arr.length>1?'s':''}` : 'No events';
  }
}

// ---------- boot ----------
let lastData = null;

async function boot() {
  try {
    lastData = await loadEvents();
    renderHeader();
    renderBoard(lastData);
  } catch (e) {
    console.error('Init failed:', e);
  }
}

// Update clock + drop finished events each minute
setInterval(() => {
  renderHeader();
  if (lastData) renderBoard(lastData);
}, 60_000);

// Initial kick
document.addEventListener('DOMContentLoaded', boot);
