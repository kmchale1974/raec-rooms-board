// app.js — display-only grid with paging + rules

// -----------------------------
// Utilities
// -----------------------------
function fmtTime(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Person / org detection (robust, trims trailing commas)
function isStandalonePerson(s = '') {
  s = s.replace(/[,\s]+$/, '').trim();
  const parts = s.split(',');
  if (parts.length !== 2) return false;

  const last = parts[0].trim();
  const rest = parts[1].trim();
  if (!last || !rest) return false;

  const NAME_TOKEN_RE = /^[a-zA-Z'\-]+$/;
  const lastToks = last.split(/\s+/).filter(Boolean);
  const restToks = rest.split(/\s+/).filter(Boolean);
  if (!lastToks.length || !restToks.length) return false;
  if (lastToks.some(t => !NAME_TOKEN_RE.test(t))) return false;
  if (restToks.some(t => !NAME_TOKEN_RE.test(t))) return false;

  if (lastToks.length > 2) return false;
  if (restToks.length > 3) return false;

  const low = s.toLowerCase();
  if (/\d/.test(low)) return false;
  if (/(llc|inc|corp|co|foundation|association|academy|club|basketball|volleyball|training|gym|league|program|rec)\b/i.test(low)) {
    return false;
  }
  return true;
}
function normalizeContactName(s = '') {
  s = s.replace(/[,\s]+$/, '').trim();
  if (isStandalonePerson(s)) {
    const [last, rest] = s.split(',', 2).map(x => x.trim());
    return `${rest} ${last}`.replace(/\s{2,}/g, ' ').trim();
  }
  if (s.includes(',')) {
    // ambiguous “X, Y” that isn’t a clear person → show first part (often org name)
    return s.split(',', 1)[0].trim();
  }
  return s;
}

// Catch Corner cleanup
function cleanCatchCornerDetail(s = '') {
  // collapse “CatchCorner (Something …)” → “Something …”
  let out = s.replace(/^Catch\s*Corner\s*\(?/i, '')
             .replace(/^CatchCorner\s*\(?/i, '');
  out = out.replace(/\)$/, '').trim();
  // remove “Internal Holds” if sneaks in
  out = out.replace(/internal holds?/i, '').trim();
  return out;
}

// Pickleball detection + text cleanup
function isPickleball(slot) {
  const t = (slot.title || '').toLowerCase();
  const sub = (slot.subtitle || '').toLowerCase();
  return /pickleball/.test(t) || /pickleball/.test(sub);
}
function cleanPickleball(slot) {
  return {
    ...slot,
    title: 'Open Pickleball',
    subtitle: '', // hide internal notes (“Internal Hold per NM”, etc.)
  };
}

// Safeguard against nullish strings
const S = v => (typeof v === 'string' ? v : '');

// -----------------------------
// DOM helpers (assumes your index structure)
// -----------------------------
const els = {
  headerDate: document.getElementById('headerDate'),
  headerClock: document.getElementById('headerClock'),
  south: document.getElementById('southRooms'),
  fieldhouse: document.getElementById('fieldhouseRooms'),
  north: document.getElementById('northRooms'),
};

// Paging state
const ROOM_PAGE_INDEX = new Map(); // roomId → page idx
let PAGE_TICK = null;
const PAGE_INTERVAL_MS = 7000; // 7s per slide
const PER_PAGE = 2; // avoid clipping; consistent across all groups

// -----------------------------
// Rendering
// -----------------------------
function renderClock() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  let hh = now.getHours(), mm = now.getMinutes(), ss = now.getSeconds();
  const ampm = hh >= 12 ? 'pm' : 'am';
  let h12 = hh % 12; if (h12 === 0) h12 = 12;

  if (els.headerDate) els.headerDate.textContent = date;
  if (els.headerClock) els.headerClock.textContent =
    `${h12}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${ampm}`;
}

function eventNode(slot) {
  // normalize title early (trims trailing commas)
  const rawTitle = S(slot.title);
  const title = rawTitle.replace(/[,\s]+$/, '').trim();
  const subtitle = S(slot.subtitle).trim();

  const node = document.createElement('div');
  node.className = 'event';

  // Pickleball rule
  if (isPickleball(slot)) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'Open Pickleball';

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

    node.appendChild(who);
    node.appendChild(when);
    return node;
  }

  // Catch Corner rule (org + cleaned detail)
  if (/^catch\s*corner|^catchcorner/i.test(title)) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'Catch Corner';

    const what = document.createElement('div');
    what.className = 'what';
    // prefer subtitle text; fallback to title’s paren content
    const detail = subtitle || cleanCatchCornerDetail(title);
    what.textContent = cleanCatchCornerDetail(detail);

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

    node.appendChild(who);
    if (what.textContent) node.appendChild(what);
    node.appendChild(when);
    return node;
  }

  // Pure person? → bold First Last, then optional subtitle
  if (isStandalonePerson(title)) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = normalizeContactName(title); // First Last

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

    node.appendChild(who);
    if (subtitle) {
      const what = document.createElement('div');
      what.className = 'what';
      what.textContent = subtitle;
      node.appendChild(what);
    }
    node.appendChild(when);
    return node;
  }

  // Generic “Org, Contact?” → bold org (first part), contact in normal text
  let orgBold = title, contact = '';
  if (title.includes(',')) {
    orgBold = title.split(',', 1)[0].trim();
    contact = title.split(',').slice(1).join(',').trim();
    // If contact itself looks like “Last, First” normalize it
    if (isStandalonePerson(contact)) contact = normalizeContactName(contact);
  }
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = orgBold;

  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = subtitle || contact;

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = `${fmtTime(slot.startMin)} – ${fmtTime(slot.endMin)}`;

  node.appendChild(who);
  if (what.textContent) node.appendChild(what);
  node.appendChild(when);
  return node;
}

// Build a single room card (header + paged events with slide-left animation)
function buildRoomCard(room, pages) {
  const card = document.createElement('div');
  card.className = 'room';
  card.dataset.roomId = room.id;

  const header = document.createElement('div');
  header.className = 'roomHeader';

  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = room.label;

  const count = document.createElement('div');
  count.className = 'count';
  const total = pages.reduce((a, b) => a + b.length, 0);
  count.textContent = total > 0 ? `${total} event${total > 1 ? 's' : ''}` : '';

  header.appendChild(id);
  header.appendChild(count);
  card.appendChild(header);

  // viewport (clipped area for pages)
  const viewport = document.createElement('div');
  viewport.className = 'events';
  viewport.style.position = 'relative';
  viewport.style.overflow = 'hidden';
  viewport.style.minHeight = '0';

  // page strip
  const strip = document.createElement('div');
  strip.style.display = 'flex';
  strip.style.gap = '0';
  strip.style.willChange = 'transform';
  strip.style.transition = 'transform 600ms ease';
  strip.style.width = `${pages.length * 100}%`;
  strip.style.transform = 'translateX(0)';

  // build each page
  pages.forEach((page, idx) => {
    const pageCol = document.createElement('div');
    pageCol.style.flex = '0 0 100%';
    pageCol.style.display = 'flex';
    pageCol.style.flexDirection = 'column';
    pageCol.style.gap = '10px';

    page.forEach(slot => pageCol.appendChild(eventNode(slot)));
    strip.appendChild(pageCol);
  });

  viewport.appendChild(strip);
  card.appendChild(viewport);

  // Store a pointer for animation
  card._strip = strip;
  card._pages = pages.length;
  card._roomId = room.id;

  return card;
}

// Rotate a single room (always slide left)
function advanceRoomCard(card) {
  const pages = card._pages || 1;
  if (pages <= 1) return;

  const roomId = card._roomId;
  const current = ROOM_PAGE_INDEX.get(roomId) || 0;
  const next = (current + 1) % pages;
  ROOM_PAGE_INDEX.set(roomId, next);
  // translateX as percentage
  card._strip.style.transform = `translateX(-${next * (100 / 1)}%)`;
}

// -----------------------------
// Data prep
// -----------------------------
function dedupeSlots(slots) {
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const title = S(s.title).replace(/[,\s]+$/, '').trim();
    const subtitle = S(s.subtitle).trim();
    const key = [
      s.roomId,
      s.startMin,
      s.endMin,
      title.toLowerCase(),
      subtitle.toLowerCase()
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function pageify(list, perPage = PER_PAGE) {
  const pages = [];
  for (let i = 0; i < list.length; i += perPage) {
    pages.push(list.slice(i, i + perPage));
  }
  return pages.length ? pages : [[]];
}

// Build room->slots map and render columns
function renderGrid(data) {
  const now = nowMinutesLocal();

  // 1) Keep only upcoming/ongoing
  let slots = Array.isArray(data.slots) ? data.slots.slice() : [];
  slots = slots.filter(s => s.endMin > now);

  // 2) Clean special cases (pickleball text)
  slots = slots.map(s => (isPickleball(s) ? cleanPickleball(s) : s));

  // 3) Dedupe
  slots = dedupeSlots(slots);

  // 4) Partition by roomId
  const byRoom = new Map();
  for (const s of slots) {
    if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
    byRoom.get(s.roomId).push(s);
  }

  // 5) Sort each room’s slots by start time, then title
  for (const list of byRoom.values()) {
    list.sort((a, b) => (a.startMin - b.startMin) || S(a.title).localeCompare(S(b.title)));
  }

  // 6) Prepare pages per room (2 items per page to avoid clipping)
  const roomCards = new Map(); // roomId -> card element
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];

  // Clear columns
  if (els.south) els.south.innerHTML = '';
  if (els.fieldhouse) els.fieldhouse.innerHTML = '';
  if (els.north) els.north.innerHTML = '';

  rooms.forEach(room => {
    const list = byRoom.get(room.id) || [];
    const pages = pageify(list, PER_PAGE);
    const card = buildRoomCard(room, pages);
    roomCards.set(room.id, card);
    if (room.group === 'south' && els.south) els.south.appendChild(card);
    if (room.group === 'fieldhouse' && els.fieldhouse) els.fieldhouse.appendChild(card);
    if (room.group === 'north' && els.north) els.north.appendChild(card);
    // reset page index if pages shrink
    if ((ROOM_PAGE_INDEX.get(room.id) || 0) >= pages.length) {
      ROOM_PAGE_INDEX.set(room.id, 0);
      card._strip.style.transform = 'translateX(0)';
    }
  });

  // 7) Start/refresh pager tick (slide left)
  if (PAGE_TICK) clearInterval(PAGE_TICK);
  PAGE_TICK = setInterval(() => {
    for (const card of roomCards.values()) {
      advanceRoomCard(card);
    }
  }, PAGE_INTERVAL_MS);
}

// -----------------------------
// Boot
// -----------------------------
async function loadEvents() {
  const url = `./events.json?ts=${Date.now()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to fetch events.json: ${resp.status}`);
  const json = await resp.json();
  console.log('Loaded events.json', json);
  return json;
}

async function init() {
  try {
    const data = await loadEvents();
    renderGrid(data);
  } catch (e) {
    console.error(e);
  }

  renderClock();
  setInterval(renderClock, 1000);

  // Optional: refresh data every 2 minutes to pick up new emails/runs
  setInterval(async () => {
    try {
      const data = await loadEvents();
      renderGrid(data);
    } catch (e) {
      console.error('refresh failed', e);
    }
  }, 120000);
}

document.addEventListener('DOMContentLoaded', init);
